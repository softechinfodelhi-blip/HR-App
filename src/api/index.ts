// The app talks to the backend only through `api`. Today every function runs against the mock
// database in this folder. To connect the real backend, keep the signatures and replace each body
// with a fetch call. The matching REST endpoint is noted above each function and in docs/openapi.yaml.
import type {
  AnyRequest, AuditEntry, CalendarDay, DayDetail, Employee, EmployeeDetail, EmployeeRow, Holiday, LeavePreview, LeaveRequest,
  LeaveType, ManualDay, Month, MyHome, MyMonth, NewEmployeeInput, Notification, OfficePayroll, OfficeSummary, PayrollData,
  Payslip, PayslipListItem, RegisterData, RequestRow, RequestStatus, SearchHit, SessionUser, Settings, TerminalStatus, TodayBoard, Ymd,
} from '../types';
import { addDays, addMonths, dateOf, fmtDate, fmtDays, fmtMonth, fmtRange, fmtTime, monthDays, monthOf, timeOf } from '../lib/format';
import { dayKind, leaveDays } from '../lib/rules';
import { clockBase, CLOCK_PRESETS, db, nextId, now, resetDb, save, setClock } from './db';
import {
  balancesOf, countDays, ctx, dayOf, emp, invalidatePunches, isEscalated, isLocked, lockOf, monthOfEmp, nameOf, officeName,
  officeStaff, onTimeRate, payrollRows, payrollStaff, punchesOn, requestDates, salaryFor, staff, streakFor, totalsOf, type Ctx,
} from './calc';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function fail(status: number, message: string): never { throw new ApiError(status, message); }

const TEST = import.meta.env?.MODE === 'test';
const wait = () => (TEST ? Promise.resolve() : new Promise<void>(r => setTimeout(r, 160 + Math.random() * 200)));

// ---------- session (the backend uses an httpOnly cookie) ----------
const SKEY = 'sbm-hr-session';
const ss = (): Storage | null => { try { return typeof sessionStorage !== 'undefined' ? sessionStorage : null; } catch { return null; } };
let sessionId: string | null = ss()?.getItem(SKEY) ?? null;
function setSession(id: string | null) { sessionId = id; if (id) ss()?.setItem(SKEY, id); else ss()?.removeItem(SKEY); }
function toUser(e: Employee): SessionUser {
  return { id: e.id, name: e.name, email: e.email, role: e.role, officeId: e.officeId || null, officeName: e.officeId ? officeName(e.officeId) : null };
}
function current(): SessionUser | null { const e = sessionId ? emp(sessionId) : null; return e && e.status !== 'inactive' ? toUser(e) : null; }
function me(): SessionUser { return current() ?? fail(401, 'Please sign in again.'); }
function manager(): SessionUser { const u = me(); return u.role === 'employee' ? fail(403, 'You do not have access to this.') : u; }
function adminOnly(): SessionUser { const u = me(); return u.role !== 'admin' ? fail(403, 'Only the admin can do this.') : u; }
/** Offices a manager may see. 'all' is only meaningful for the admin. A head is always pinned to their office. */
function scopeOf(scope: string, u = manager()): string[] {
  if (u.role === 'head') return [u.officeId!];
  return scope === 'all' ? db.offices.map(o => o.id) : [scope];
}
function oneOffice(officeId: string, u = manager()): string {
  if (u.role === 'head' && officeId !== u.officeId) fail(403, 'You can only see your own office.');
  return db.offices.some(o => o.id === officeId) ? officeId : fail(404, 'Office not found.');
}
/** A head manages people in their office, never their own record. */
function canManage(e: Employee, u: SessionUser): boolean {
  if (u.role === 'admin') return e.role !== 'admin';
  return u.role === 'head' && e.officeId === u.officeId && e.id !== u.id;
}
function canView(e: Employee, u: SessionUser): boolean {
  return u.role === 'admin' || e.id === u.id || (u.role === 'head' && e.officeId === u.officeId);
}
function need(id: string): Employee { return emp(id) ?? fail(404, 'Employee not found.'); }
function assertOpen(officeId: string, dates: Ymd[]) {
  for (const m of new Set(dates.map(monthOf))) {
    if (isLocked(officeId, m)) fail(409, `${fmtMonth(m)} is locked for ${officeName(officeId)}. Ask the admin to unlock it first.`);
  }
}

// ---------- side effects: audit log, in-app notification, email ----------
function log(u: SessionUser, officeId: string | null, action: string, detail: string) {
  db.audit.unshift({ id: nextId('AU'), at: now(), actorId: u.id, actorName: u.name, officeId, action, detail });
}
function notify(userId: string | null | undefined, text: string, link: string) {
  if (!userId) return;
  db.notifications.unshift({ id: nextId('N'), userId, text, at: now(), read: false, link });
  const to = emp(userId); if (to) db.outbox.push({ to: to.email, subject: text, at: now() }); // the backend sends a real email here
}
const adminId = () => db.employees.find(e => e.role === 'admin')!.id;
/** Who decides a request: the office head, or the admin when the requester is a head. */
function approverOf(e: Employee): string {
  const head = db.offices.find(o => o.id === e.officeId)?.headId;
  return e.role === 'head' || !head ? adminId() : head;
}

// ---------- rows ----------
function empRow(e: Employee, u: SessionUser, c: Ctx): EmployeeRow {
  const seeSalary = u.role === 'admin' || e.id === u.id || (u.role === 'head' && e.officeId === u.officeId);
  return { ...e, officeName: officeName(e.officeId), isHead: e.role === 'head', salary: seeSalary ? salaryFor(e.id, monthOf(c.today)) : null };
}
const typeName = (t: LeaveType) => (t === 'UNPAID' ? 'Unpaid leave' : t);
function reqRow(r: AnyRequest, u: SessionUser, c: Ctx): RequestRow {
  const e = need(r.employeeId);
  let title: string, detail: string;
  if (r.kind === 'leave') {
    title = `${typeName(r.type)} · ${fmtRange(r.from, r.to)}`;
    detail = r.half ? 'Half day' : fmtDays(r.days);
  } else {
    title = `Correction · ${fmtDate(r.date)}`;
    detail = [r.inTime && `In ${fmtTime(r.inTime)}`, r.outTime && `Out ${fmtTime(r.outTime)}`].filter(Boolean).join(', ');
  }
  return {
    id: r.id, kind: r.kind, employeeId: e.id, employeeName: e.name, officeId: e.officeId, officeName: officeName(e.officeId),
    title, detail, reason: r.reason, status: r.status, createdAt: r.createdAt, escalated: isEscalated(r, c), fromHead: e.role === 'head',
    canAct: r.status === 'pending' && canManage(e, u), decidedByName: nameOf(r.decidedBy) || undefined, decidedAt: r.decidedAt,
    comment: r.comment, dates: requestDates(r),
  };
}
const allRequests = (): AnyRequest[] => [...db.leaves, ...db.corrections];
function findRequest(id: string): AnyRequest { return allRequests().find(r => r.id === id) ?? fail(404, 'Request not found.'); }

function terminalStatus(officeId: string, c: Ctx): TerminalStatus | null {
  const t = db.terminals.find(x => x.officeId === officeId); if (!t) return null;
  const offline = !!(t.offlineFrom && t.offlineTo && c.now >= t.offlineFrom && c.now < t.offlineTo);
  const punchesToday = db.punches.filter(p => p.terminalId === t.id && dateOf(p.at) === c.today && p.receivedAt <= c.now).length;
  return { ...t, officeName: officeName(officeId), online: !offline, lastSeen: offline ? t.offlineFrom! : c.now, punchesToday };
}

/** October is locked in the sample data. Build its frozen payslips once. */
function ensureSnapshots() {
  const c = ctx();
  for (const l of db.locks) {
    if (!l.lockedAt || db.payslips.some(p => p.officeId === l.officeId && p.month === l.month)) continue;
    for (const row of payrollRows(l.officeId, l.month, c)) db.payslips.push({ officeId: l.officeId, month: l.month, row });
  }
}
ensureSnapshots();

// Undo is allowed for a short time after a decision, by the person who made it.
const undoable = new Map<string, { at: number; prevManual: ManualDay | null | undefined }>();
const UNDO_MS = 30000;

function validateLeave(e: Employee, input: { type: LeaveType; from: Ymd; to: Ymd; half: boolean }, c: Ctx, ignoreId?: string): LeavePreview {
  const none = { days: 0, ok: false, balance: null, balanceAfter: null };
  if (!input.from || !input.to) return { ...none, message: 'Pick the dates.' };
  if (input.to < input.from) return { ...none, message: 'The last day is before the first day.' };
  if (input.half && input.from !== input.to) return { ...none, message: 'A half day can only be taken on a single date.' };
  const days = leaveDays(input.from, input.to, input.half, e.officeId, db.holidays);
  const bal = balancesOf(e, c);
  const b = input.type === 'CL' ? bal.cl : input.type === 'PL' ? bal.pl : null;
  const res: LeavePreview = { days, ok: true, message: null, balance: b ? b.available : null, balanceAfter: b ? b.available - days : null };
  if (days === 0) return { ...res, ok: false, message: 'There are no working days in these dates.' };
  const clash = db.leaves.find(l => l.employeeId === e.id && l.id !== ignoreId && (l.status === 'pending' || l.status === 'approved') && l.from <= input.to && input.from <= l.to);
  if (clash) return { ...res, ok: false, message: `You already have leave on ${fmtRange(clash.from, clash.to)}.` };
  for (const m of new Set([monthOf(input.from), monthOf(input.to)])) {
    if (isLocked(e.officeId, m)) return { ...res, ok: false, message: `${fmtMonth(m)} is already locked.` };
  }
  if (b && days > b.available) {
    return { ...res, ok: false, message: `You have ${fmtDays(b.available)} of ${input.type} available. Shorten the dates or choose unpaid leave.` };
  }
  return res;
}

export const api = {
  // =====================================================================
  // Auth
  // =====================================================================
  /** POST /auth/login */
  async login(email: string, password: string): Promise<SessionUser> {
    await wait();
    const e = db.employees.find(x => x.email.toLowerCase() === email.trim().toLowerCase());
    if (!e || db.passwords[e.id] !== password) fail(401, 'Email or password is not right.');
    if (e!.status === 'invited') fail(403, 'Set your password from the invite email first.');
    if (e!.status === 'inactive') fail(403, 'This account is switched off. Ask your office head.');
    setSession(e!.id);
    return toUser(e!);
  },
  /** POST /auth/logout */
  async logout(): Promise<void> { await wait(); setSession(null); },
  /** GET /auth/me */
  async me(): Promise<SessionUser | null> { return current(); },
  /** GET /auth/invites/{token} */
  async invite(token: string): Promise<{ name: string; email: string; officeName: string; companyName: string }> {
    await wait();
    const inv = db.invites.find(i => i.token === token);
    if (!inv || inv.usedAt) fail(410, 'This invite link has been used or has expired. Ask your office head to send a new one.');
    const e = need(inv!.employeeId);
    return { name: e.name, email: e.email, officeName: officeName(e.officeId), companyName: db.settings.companyName };
  },
  /** POST /auth/invites/{token} */
  async setPassword(token: string, password: string): Promise<SessionUser> {
    await wait();
    const inv = db.invites.find(i => i.token === token);
    if (!inv || inv.usedAt) fail(410, 'This invite link has been used or has expired.');
    if (password.length < 8) fail(422, 'Use at least 8 characters.');
    const e = need(inv!.employeeId);
    inv!.usedAt = now(); db.passwords[e.id] = password; e.status = 'active';
    setSession(e.id); save();
    return toUser(e);
  },
  /** POST /auth/password */
  async changePassword(currentPw: string, next: string): Promise<void> {
    await wait(); const u = me();
    if (db.passwords[u.id] !== currentPw) fail(422, 'Current password is not right.');
    if (next.length < 8) fail(422, 'Use at least 8 characters.');
    db.passwords[u.id] = next; save();
  },

  // =====================================================================
  // Organisation
  // =====================================================================
  /** GET /offices */
  async offices(): Promise<OfficeSummary[]> {
    await wait(); const u = me(); const c = ctx();
    return db.offices.filter(o => u.role === 'admin' || o.id === u.officeId).map(o => ({
      ...o, headName: nameOf(o.headId) || null, headcount: officeStaff([o.id]).length, terminal: terminalStatus(o.id, c),
    }));
  },
  /** PATCH /offices/{id} */
  async updateOffice(id: string, patch: { name?: string; address?: string }): Promise<void> {
    await wait(); const u = adminOnly();
    const o = db.offices.find(x => x.id === id) ?? fail(404, 'Office not found.');
    if (patch.name !== undefined && !patch.name.trim()) fail(422, 'Give the office a name.');
    Object.assign(o, patch); log(u, id, 'Office updated', `${o.name}, ${o.address}`); save();
  },
  /** PUT /offices/{id}/head */
  async setOfficeHead(officeId: string, employeeId: string): Promise<void> {
    await wait(); const u = adminOnly();
    const o = db.offices.find(x => x.id === officeId) ?? fail(404, 'Office not found.');
    const e = need(employeeId);
    if (e.officeId !== officeId) fail(422, 'The head must belong to this office.');
    const old = o.headId ? emp(o.headId) : null;
    if (old) old.role = 'employee';
    e.role = 'head'; o.headId = e.id;
    log(u, officeId, 'Office head changed', `${e.name} is now head of ${o.name}${old ? `, replacing ${old.name}` : ''}`);
    notify(e.id, `You are now the head of ${o.name}`, '/'); save();
  },
  /** GET /settings */
  async settings(): Promise<Settings> { await wait(); me(); return { ...db.settings }; },
  /** PATCH /settings */
  async updateSettings(patch: Partial<Pick<Settings, 'companyName' | 'defaultClQuota' | 'defaultPlQuota'>>): Promise<Settings> {
    await wait(); const u = adminOnly();
    if (patch.companyName !== undefined && !patch.companyName.trim()) fail(422, 'Company name cannot be empty.');
    Object.assign(db.settings, patch); log(u, null, 'Settings changed', Object.entries(patch).map(([k, v]) => `${k}: ${v}`).join(', ')); save();
    return { ...db.settings };
  },

  // =====================================================================
  // People
  // =====================================================================
  /** GET /employees?office=&q=&status= */
  async employees(q: { scope: string; search?: string; status?: string }): Promise<EmployeeRow[]> {
    await wait(); const u = manager(); const c = ctx(); const ids = scopeOf(q.scope, u);
    const s = (q.search ?? '').trim().toLowerCase();
    return staff()
      .filter(e => ids.includes(e.officeId))
      .filter(e => (q.status && q.status !== 'all' ? e.status === q.status : true))
      .filter(e => !s || e.name.toLowerCase().includes(s) || e.id.toLowerCase().includes(s) || e.designation.toLowerCase().includes(s))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => empRow(e, u, c));
  },
  /** GET /employees/{id} */
  async employee(id: string): Promise<EmployeeDetail> {
    await wait(); const u = me(); const c = ctx(); const e = need(id);
    if (!canView(e, u) || e.role === 'admin') fail(403, 'You cannot open this profile.');
    const month = monthOf(c.today);
    const t = countDays(monthOfEmp(e, month, c), c.today);
    const row = empRow(e, u, c);
    return {
      employee: row, canEdit: canManage(e, u), canSeeSalary: row.salary !== null,
      salaryHistory: row.salary === null ? [] : db.salaries.filter(s => s.employeeId === id)
        .sort((a, b) => b.effectiveMonth.localeCompare(a.effectiveMonth)).map(s => ({ ...s, setByName: nameOf(s.setBy) })),
      balances: balancesOf(e, c), month: { month, ...t }, streak: streakFor(e, c),
      recent: allRequests().filter(r => r.employeeId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 6).map(r => reqRow(r, u, c)),
      inviteToken: canManage(e, u) ? db.invites.find(i => i.employeeId === id && !i.usedAt)?.token ?? null : null,
    };
  },
  /** POST /employees */
  async createEmployee(input: NewEmployeeInput): Promise<{ employee: EmployeeRow; inviteToken: string }> {
    await wait(); const u = manager(); const c = ctx();
    const officeId = u.role === 'head' ? u.officeId! : input.officeId;
    if (!db.offices.some(o => o.id === officeId)) fail(422, 'Choose an office.');
    if (!input.name.trim()) fail(422, 'Enter the full name.');
    if (!/^\S+@\S+\.\S+$/.test(input.email)) fail(422, 'Enter a valid email address.');
    if (db.employees.some(e => e.email.toLowerCase() === input.email.trim().toLowerCase())) fail(409, 'This email is already used by another employee.');
    if (!(input.salary > 0)) fail(422, 'Enter the monthly salary.');
    const seq = db.empSeq[officeId]++;
    const e: Employee = {
      id: `EMP-${String(seq).padStart(4, '0')}`, name: input.name.trim(), email: input.email.trim().toLowerCase(), phone: input.phone.trim(),
      officeId, role: 'employee', designation: input.designation.trim() || 'Executive', joinDate: input.joinDate, status: 'invited',
      terminalUserId: String(seq), clQuota: input.clQuota, plQuota: input.plQuota, bestStreak: 0,
    };
    db.employees.push(e);
    db.salaries.push({ id: nextId('S'), employeeId: e.id, amount: input.salary, effectiveMonth: input.effectiveMonth, setBy: u.id, setAt: now() });
    const joinMonth = monthOf(e.joinDate);
    db.leaveOpening[e.id] = { cl: 0, pl: 0, creditFrom: e.joinDate.endsWith('-01') ? joinMonth : addMonths(joinMonth, 1) };
    const token = `inv-${e.id.toLowerCase()}-${Math.random().toString(36).slice(2, 10)}`;
    db.invites.push({ token, employeeId: e.id, usedAt: null });
    db.outbox.push({ to: e.email, subject: `Welcome to ${db.settings.companyName}. Set your password.`, at: now() });
    log(u, officeId, 'Employee added', `${e.name} (${e.id}), ${e.designation}, joins ${fmtDate(e.joinDate)}`);
    save();
    return { employee: empRow(e, u, c), inviteToken: token };
  },
  /** DELETE /employees/{id} (only while the invite is unused) */
  async undoCreateEmployee(id: string): Promise<void> {
    await wait(); const u = manager(); const e = need(id);
    if (!canManage(e, u)) fail(403, 'You cannot remove this employee.');
    if (e.status !== 'invited') fail(409, 'This person has already signed in. Switch the account off instead.');
    db.employees = db.employees.filter(x => x.id !== id);
    db.salaries = db.salaries.filter(s => s.employeeId !== id);
    db.invites = db.invites.filter(i => i.employeeId !== id);
    delete db.leaveOpening[id];
    log(u, e.officeId, 'Employee removed', `${e.name} (${e.id}) removed before first sign in`); save();
  },
  /** PATCH /employees/{id} */
  async updateEmployee(id: string, patch: Partial<Pick<Employee, 'name' | 'email' | 'phone' | 'designation' | 'joinDate' | 'clQuota' | 'plQuota' | 'terminalUserId'>>): Promise<void> {
    await wait(); const u = manager(); const e = need(id);
    if (!canManage(e, u)) fail(403, e.id === u.id ? 'You cannot change your own record. Ask the admin.' : 'You cannot change this record.');
    if (patch.name !== undefined && !patch.name.trim()) fail(422, 'Enter the full name.');
    if (patch.email !== undefined && !/^\S+@\S+\.\S+$/.test(patch.email)) fail(422, 'Enter a valid email address.');
    if (patch.email && db.employees.some(x => x.id !== id && x.email.toLowerCase() === patch.email!.toLowerCase())) fail(409, 'This email is already used.');
    Object.assign(e, patch);
    log(u, e.officeId, 'Employee updated', `${e.name} (${e.id}): ${Object.keys(patch).join(', ')}`); save();
  },
  /** POST /employees/{id}/salary */
  async setSalary(id: string, amount: number, effectiveMonth: Month): Promise<void> {
    await wait(); const u = manager(); const e = need(id);
    if (!canManage(e, u)) fail(403, e.id === u.id ? 'You cannot change your own salary. Ask the admin.' : 'You cannot change this salary.');
    if (!(amount > 0)) fail(422, 'Enter the monthly salary.');
    if (isLocked(e.officeId, effectiveMonth)) fail(409, `${fmtMonth(effectiveMonth)} is locked. Choose a later month.`);
    const same = db.salaries.find(s => s.employeeId === id && s.effectiveMonth === effectiveMonth);
    if (same) Object.assign(same, { amount, setBy: u.id, setAt: now() });
    else db.salaries.push({ id: nextId('S'), employeeId: id, amount, effectiveMonth, setBy: u.id, setAt: now() });
    log(u, e.officeId, 'Salary changed', `${e.name} (${e.id}) from ${fmtMonth(effectiveMonth)}`); // the amount is not written to the log
    notify(e.id, `Your salary was updated from ${fmtMonth(effectiveMonth)}`, '/me/profile'); save();
  },
  /** POST /employees/{id}/invite */
  async resendInvite(id: string): Promise<{ inviteToken: string }> {
    await wait(); const u = manager(); const e = need(id);
    if (!canManage(e, u)) fail(403, 'You cannot do this.');
    if (e.status !== 'invited') fail(409, 'This person has already set a password.');
    db.invites = db.invites.filter(i => i.employeeId !== id);
    const token = `inv-${e.id.toLowerCase()}-${Math.random().toString(36).slice(2, 10)}`;
    db.invites.push({ token, employeeId: id, usedAt: null });
    db.outbox.push({ to: e.email, subject: 'Your invite link', at: now() }); save();
    return { inviteToken: token };
  },
  /** POST /employees/{id}/status */
  async setEmployeeStatus(id: string, status: 'active' | 'inactive'): Promise<void> {
    await wait(); const u = manager(); const e = need(id);
    if (!canManage(e, u)) fail(403, 'You cannot do this.');
    if (e.role === 'head' && status === 'inactive') fail(409, 'Choose another office head before switching this account off.');
    e.status = status;
    log(u, e.officeId, status === 'inactive' ? 'Account switched off' : 'Account switched on', `${e.name} (${e.id})`); save();
  },

  // =====================================================================
  // Attendance
  // =====================================================================
  /** GET /attendance/today?office= */
  async today(scope: string): Promise<TodayBoard> {
    await wait(); const u = manager(); const c = ctx(); const ids = scopeOf(scope, u);
    const people = officeStaff(ids).filter(e => e.joinDate <= c.today).map(e => ({
      employeeId: e.id, name: e.name, officeId: e.officeId, officeName: officeName(e.officeId), day: dayOf(e, c.today, c),
    }));
    const expected = people.filter(p => !['off', 'holiday'].includes(p.day.status));
    const month = monthOf(c.today); const last = addMonths(month, -1);
    const offices = db.offices.filter(o => ids.includes(o.id)).map(o => ({
      officeId: o.id, name: o.name, headcount: officeStaff([o.id]).length, onTime: onTimeRate(o.id, month, c), lastMonth: onTimeRate(o.id, last, c),
      best: false, terminal: terminalStatus(o.id, c),
    }));
    if (u.role === 'admin') {
      const all = db.offices.map(o => ({ id: o.id, r: onTimeRate(o.id, last, c) ?? 0 })).sort((a, b) => b.r - a.r);
      const top = offices.find(o => o.officeId === all[0]?.id); if (top) top.best = true;
    }
    const kinds = new Set(ids.map(id => dayKind(c.today, id, db.holidays).kind));
    const k = ids.length === 1 ? dayKind(c.today, ids[0], db.holidays) : null;
    return {
      date: c.today, time: timeOf(c.now), working: kinds.has('working'),
      dayLabel: k && k.kind !== 'working' ? (k.kind === 'holiday' ? k.name ?? 'Holiday' : 'Weekly off') : '',
      counts: {
        total: expected.length,
        in: expected.filter(p => ['working', 'present'].includes(p.day.status)).length,
        notIn: expected.filter(p => p.day.status === 'not_in').length,
        onLeave: expected.filter(p => p.day.status === 'leave').length,
        waiting: queueFor(u, ids, c).length,
      },
      people, offices,
    };
  },
  /** GET /attendance/register?office=&month= */
  async register(scope: string, month: Month): Promise<RegisterData> {
    await wait(); const u = manager(); const c = ctx(); const ids = scopeOf(scope, u);
    const last = monthDays(month).at(-1)!;
    const rows = officeStaff(ids).filter(e => e.joinDate <= last).sort((a, b) => a.officeId.localeCompare(b.officeId) || a.name.localeCompare(b.name)).map(e => {
      const days = monthOfEmp(e, month, c);
      return { employeeId: e.id, name: e.name, officeId: e.officeId, days, totals: countDays(days, c.today) };
    });
    const totals = { present: 0, half: 0, absent: 0, leave: 0, missing: 0 };
    for (const r of rows) { totals.present += r.totals.present; totals.half += r.totals.half; totals.absent += r.totals.absent; totals.leave += r.totals.leave; totals.missing += r.totals.missing; }
    const locks = ids.map(id => lockOf(id, month)).filter(l => l?.lockedAt).map(l => ({
      officeId: l!.officeId, officeName: officeName(l!.officeId), lockedAt: l!.lockedAt!, lockedByName: nameOf(l!.lockedBy),
    }));
    return { month, dates: monthDays(month), rows, totals, locks };
  },
  /** GET /attendance/days/{employeeId}/{date} */
  async day(employeeId: string, date: Ymd): Promise<DayDetail> {
    await wait(); const u = me(); const c = ctx(); const e = need(employeeId);
    if (!canView(e, u)) fail(403, 'You cannot see this day.');
    const manual = db.manualDays.find(m => m.employeeId === e.id && m.date === date) ?? null;
    const locked = isLocked(e.officeId, monthOf(date));
    return {
      employee: { id: e.id, name: e.name, officeId: e.officeId, officeName: officeName(e.officeId) },
      day: dayOf(e, date, c),
      punches: punchesOn(e.id, date, c).sort((a, b) => a.at.localeCompare(b.at)).map(p => ({
        time: timeOf(p.at), terminalName: db.terminals.find(t => t.id === p.terminalId)?.name ?? '', officeName: officeName(p.officeId), other: p.officeId !== e.officeId,
      })),
      manual: manual ? { ...manual, byName: nameOf(manual.byId) } : null,
      requests: allRequests().filter(r => r.employeeId === e.id && requestDates(r).includes(date)).map(r => reqRow(r, u, c)),
      canCorrect: canManage(e, u) && !locked && date <= c.today,
      lockedNote: locked ? `${fmtMonth(monthOf(date))} is locked. Figures cannot change.` : null,
    };
  },
  /** PUT /attendance/days/{employeeId}/{date}/manual */
  async correctDay(employeeId: string, date: Ymd, input: { inTime: string | null; outTime: string | null; reason: string }): Promise<void> {
    await wait(); const u = manager(); const e = need(employeeId);
    if (!canManage(e, u)) fail(403, e.id === u.id ? 'You cannot correct your own attendance. Send a correction request to the admin.' : 'You cannot correct this day.');
    if (!input.reason.trim()) fail(422, 'Write the reason. It is kept in the audit log.');
    if (!input.inTime && !input.outTime) fail(422, 'Enter an in time or an out time.');
    if (input.inTime && input.outTime && input.outTime <= input.inTime) fail(422, 'The out time must be after the in time.');
    assertOpen(e.officeId, [date]);
    db.manualDays = db.manualDays.filter(m => !(m.employeeId === e.id && m.date === date));
    db.manualDays.push({ employeeId: e.id, date, inTime: input.inTime, outTime: input.outTime, reason: input.reason.trim(), byId: u.id, at: now() });
    log(u, e.officeId, 'Attendance corrected', `${e.name}, ${fmtDate(date)}. ${[input.inTime && `in ${fmtTime(input.inTime)}`, input.outTime && `out ${fmtTime(input.outTime)}`].filter(Boolean).join(', ')}. Reason: ${input.reason.trim()}`);
    notify(e.id, `Your attendance for ${fmtDate(date)} was corrected by ${u.name}`, '/me/attendance'); save();
  },
  /** GET /terminals */
  async terminals(): Promise<TerminalStatus[]> {
    await wait(); const u = manager(); const c = ctx();
    return scopeOf('all', u).map(id => terminalStatus(id, c)).filter((t): t is TerminalStatus => !!t);
  },
  /** GET /terminals/punches?office= */
  async recentPunches(scope: string): Promise<{ at: string; employeeId: string; name: string; terminalName: string; other: boolean }[]> {
    await wait(); const u = manager(); const c = ctx(); const ids = scopeOf(scope, u);
    return db.punches.filter(p => p.receivedAt <= c.now && (ids.includes(p.officeId) || ids.includes(emp(p.employeeId)?.officeId ?? '')))
      .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40).map(p => ({
        at: p.at, employeeId: p.employeeId, name: nameOf(p.employeeId), terminalName: db.terminals.find(t => t.id === p.terminalId)?.name ?? '',
        other: emp(p.employeeId)?.officeId !== p.officeId,
      }));
  },
  /** Demo only. Stands in for the terminal pushing one punch to POST /iclock/cdata. */
  async simulatePunch(terminalId: string): Promise<{ name: string; time: string; kind: 'in' | 'out' }> {
    await wait(); const u = manager(); const c = ctx();
    const t = db.terminals.find(x => x.id === terminalId) ?? fail(404, 'Terminal not found.');
    oneOffice(t.officeId, u);
    if (!terminalStatus(t.officeId, c)!.online) fail(409, 'This terminal is offline. Punches are kept on the device and arrive when it reconnects.');
    const list = officeStaff([t.officeId]).map(e => ({ e, d: dayOf(e, c.today, c) }));
    const pick = list.find(x => x.d.status === 'not_in') ?? list.find(x => x.d.status === 'working' && !x.d.outTime) ?? fail(409, 'Everyone in this office has already punched in and out today.');
    db.punches.push({ id: nextId('P'), employeeId: pick.e.id, terminalId: t.id, officeId: t.officeId, at: c.now, receivedAt: c.now });
    invalidatePunches(); save();
    return { name: pick.e.name, time: timeOf(c.now), kind: pick.d.status === 'not_in' ? 'in' : 'out' };
  },

  // =====================================================================
  // Requests: leave and attendance corrections
  // =====================================================================
  /** GET /requests?office=&kind=&status= */
  async requests(q: { scope: string; kind?: 'leave' | 'correction'; status?: RequestStatus | 'decided' }): Promise<RequestRow[]> {
    await wait(); const u = manager(); const c = ctx(); const ids = scopeOf(q.scope, u);
    return allRequests()
      .filter(r => ids.includes(emp(r.employeeId)?.officeId ?? ''))
      .filter(r => !q.kind || r.kind === q.kind)
      .filter(r => !q.status || (q.status === 'decided' ? r.status === 'approved' || r.status === 'rejected' : r.status === q.status))
      .map(r => reqRow(r, u, c))
      .sort((a, b) => (a.status === 'pending' && b.status === 'pending'
        ? Number(b.escalated) - Number(a.escalated) || a.createdAt.localeCompare(b.createdAt)
        : (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt)));
  },
  /** GET /requests/queue?office=  The "Waiting for you" list on Home. */
  async queue(scope: string): Promise<RequestRow[]> {
    await wait(); const u = manager(); return queueFor(u, scopeOf(scope, u), ctx());
  },
  /** GET /me/requests */
  async myRequests(): Promise<RequestRow[]> {
    await wait(); const u = me(); const c = ctx();
    return allRequests().filter(r => r.employeeId === u.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(r => reqRow(r, u, c));
  },
  /** POST /leave/preview  Counts working days and checks the balance while the form is being filled. */
  async leavePreview(input: { type: LeaveType; from: Ymd; to: Ymd; half: boolean }): Promise<LeavePreview> {
    const u = me(); return validateLeave(need(u.id), input, ctx());
  },
  /** POST /leave */
  async applyLeave(input: { type: LeaveType; from: Ymd; to: Ymd; half: boolean; reason: string }): Promise<RequestRow> {
    await wait(); const u = me(); const c = ctx(); const e = need(u.id);
    if (u.role === 'admin') fail(403, 'The admin account has no leave.');
    const v = validateLeave(e, input, c);
    if (!v.ok) fail(422, v.message ?? 'This leave cannot be requested.');
    if (!input.reason.trim()) fail(422, 'Add a short reason.');
    const r: LeaveRequest = { id: nextId('LV'), kind: 'leave', employeeId: e.id, type: input.type, from: input.from, to: input.to, half: input.half, days: v.days, reason: input.reason.trim(), status: 'pending', createdAt: c.now };
    db.leaves.push(r);
    notify(approverOf(e), `${e.name} asked for ${typeName(r.type)}, ${fmtRange(r.from, r.to)}`, '/leave'); save();
    return reqRow(r, u, c);
  },
  /** POST /corrections */
  async requestCorrection(input: { date: Ymd; inTime: string | null; outTime: string | null; reason: string }): Promise<RequestRow> {
    await wait(); const u = me(); const c = ctx(); const e = need(u.id);
    if (input.date > c.today) fail(422, 'You can only correct today or a past day.');
    if (!input.inTime && !input.outTime) fail(422, 'Enter the time you came in or the time you left.');
    if (input.inTime && input.outTime && input.outTime <= input.inTime) fail(422, 'The out time must be after the in time.');
    if (!input.reason.trim()) fail(422, 'Add a short reason.');
    assertOpen(e.officeId, [input.date]);
    if (db.corrections.some(r => r.employeeId === e.id && r.date === input.date && r.status === 'pending')) fail(409, 'You already have a request waiting for this day.');
    const r = { id: nextId('CR'), kind: 'correction' as const, employeeId: e.id, date: input.date, inTime: input.inTime, outTime: input.outTime, reason: input.reason.trim(), status: 'pending' as const, createdAt: c.now };
    db.corrections.push(r);
    notify(approverOf(e), `${e.name} asked to correct ${fmtDate(r.date)}`, '/attendance/corrections'); save();
    return reqRow(r, u, c);
  },
  /** POST /requests/{id}/decision */
  async decide(id: string, decision: 'approved' | 'rejected', comment = ''): Promise<void> {
    await wait(); const u = manager(); const c = ctx(); const r = findRequest(id); const e = need(r.employeeId);
    if (!canManage(e, u)) fail(403, e.id === u.id ? 'The admin decides your own requests.' : 'You cannot decide this request.');
    if (r.status !== 'pending') fail(409, 'This request has already been decided.');
    if (decision === 'rejected' && !comment.trim()) fail(422, 'Write a reason. The employee will see it.');
    assertOpen(e.officeId, requestDates(r));
    let prevManual: ManualDay | null | undefined;
    if (decision === 'approved' && r.kind === 'leave' && r.type !== 'UNPAID') {
      const b = balancesOf(e, c)[r.type === 'CL' ? 'cl' : 'pl'];
      if (r.days > b.balance) fail(409, `${e.name} has only ${fmtDays(b.balance)} of ${r.type} left.`);
    }
    if (decision === 'approved' && r.kind === 'correction') {
      prevManual = db.manualDays.find(m => m.employeeId === e.id && m.date === r.date) ?? null;
      db.manualDays = db.manualDays.filter(m => !(m.employeeId === e.id && m.date === r.date));
      db.manualDays.push({ employeeId: e.id, date: r.date, inTime: r.inTime, outTime: r.outTime, reason: r.reason, byId: u.id, at: c.now });
    }
    r.status = decision; r.decidedBy = u.id; r.decidedAt = c.now; r.comment = comment.trim() || undefined;
    undoable.set(id, { at: Date.now(), prevManual });
    const what = r.kind === 'leave' ? `${typeName(r.type)} for ${fmtRange(r.from, r.to)}` : `correction for ${fmtDate(r.date)}`;
    log(u, e.officeId, `${r.kind === 'leave' ? 'Leave' : 'Correction'} ${decision}`, `${e.name}, ${what}${r.comment ? `. Reason: ${r.comment}` : ''}`);
    notify(e.id, `Your ${what} was ${decision}${r.comment ? `: ${r.comment}` : ''}`, r.kind === 'leave' ? '/me/leave' : '/me/attendance'); save();
  },
  /** POST /requests/{id}/undo  Allowed for 30 seconds, only for the person who decided. */
  async undoDecision(id: string): Promise<void> {
    await wait(); const u = manager(); const r = findRequest(id); const e = need(r.employeeId); const x = undoable.get(id);
    if (!x || r.decidedBy !== u.id || Date.now() - x.at > UNDO_MS) fail(409, 'It is too late to undo this. Open the request to change it.');
    if (r.kind === 'correction' && r.status === 'approved') {
      db.manualDays = db.manualDays.filter(m => !(m.employeeId === e.id && m.date === r.date));
      if (x!.prevManual) db.manualDays.push(x!.prevManual);
    }
    r.status = 'pending'; r.decidedBy = undefined; r.decidedAt = undefined; r.comment = undefined; undoable.delete(id);
    log(u, e.officeId, 'Decision undone', `${e.name}, request ${r.id} is pending again`);
    notify(e.id, 'A decision on your request was taken back. It is pending again.', r.kind === 'leave' ? '/me/leave' : '/me/attendance'); save();
  },
  /** POST /requests/{id}/cancel */
  async cancelRequest(id: string): Promise<void> {
    await wait(); const u = me(); const r = findRequest(id);
    if (r.employeeId !== u.id) fail(403, 'This is not your request.');
    if (r.status !== 'pending') fail(409, 'Only a pending request can be cancelled.');
    r.status = 'cancelled'; save();
  },
  /** POST /requests/{id}/restore */
  async undoCancel(id: string): Promise<void> {
    await wait(); const u = me(); const r = findRequest(id);
    if (r.employeeId !== u.id || r.status !== 'cancelled') fail(409, 'This request cannot be restored.');
    r.status = 'pending'; save();
  },
  /** GET /leave/calendar?office=&month= */
  async leaveCalendar(scope: string, month: Month): Promise<CalendarDay[]> {
    await wait(); const u = manager(); const ids = scopeOf(scope, u);
    const people = officeStaff(ids);
    return monthDays(month).map(date => {
      const kinds = ids.map(id => dayKind(date, id, db.holidays));
      const hol = kinds.find(k => k.kind === 'holiday');
      const out: CalendarDay = { date, holiday: hol?.name ?? null, off: kinds.every(k => k.kind !== 'working') && !hol, people: [] };
      for (const l of db.leaves) {
        if ((l.status !== 'approved' && l.status !== 'pending') || l.from > date || date > l.to) continue;
        const e = people.find(p => p.id === l.employeeId);
        if (!e || dayKind(date, e.officeId, db.holidays).kind !== 'working') continue;
        out.people.push({ employeeId: e.id, name: e.name, type: l.type, half: l.half, pending: l.status === 'pending' });
      }
      return out;
    });
  },
  /** GET /holidays?office=&year= */
  async holidays(scope: string, year: number): Promise<(Holiday & { offices: string; canEdit: boolean })[]> {
    await wait(); const u = me(); const ids = u.role === 'employee' ? [u.officeId!] : scopeOf(scope, u);
    return db.holidays.filter(h => h.date.startsWith(String(year)) && h.officeIds.some(id => ids.includes(id)))
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(h => ({
        ...h, offices: h.officeIds.length === db.offices.length ? 'All offices' : h.officeIds.map(officeName).join(', '),
        canEdit: u.role === 'admin' || (u.role === 'head' && h.officeIds.includes(u.officeId!)),
      }));
  },
  /** POST /holidays */
  async addHoliday(input: { date: Ymd; name: string; officeIds: string[]; kind: 'holiday' | 'working' }): Promise<Holiday> {
    await wait(); const u = manager();
    const officeIds = u.role === 'head' ? [u.officeId!] : input.officeIds;
    if (!input.date) fail(422, 'Pick the date.');
    if (!input.name.trim()) fail(422, 'Give it a name.');
    if (!officeIds.length) fail(422, 'Choose at least one office.');
    for (const id of officeIds) assertOpen(id, [input.date]);
    if (input.kind === 'working' && officeIds.every(id => dayKind(input.date, id, db.holidays).kind === 'working')) fail(422, 'This is already a working day.');
    const h: Holiday = { id: nextId('H'), date: input.date, name: input.name.trim(), officeIds, kind: input.kind };
    db.holidays.push(h);
    log(u, officeIds.length === 1 ? officeIds[0] : null, input.kind === 'holiday' ? 'Holiday added' : 'Working day added', `${h.name}, ${fmtDate(h.date)}, ${officeIds.map(officeName).join(', ')}`);
    save(); return h;
  },
  /** DELETE /holidays/{id}?office=  A head removes it for their office only. */
  async removeHoliday(id: string): Promise<Holiday> {
    await wait(); const u = manager();
    const h = db.holidays.find(x => x.id === id) ?? fail(404, 'Holiday not found.');
    const before: Holiday = { ...h, officeIds: [...h.officeIds] };
    const mine = u.role === 'head' ? [u.officeId!] : h.officeIds;
    for (const o of mine) assertOpen(o, [h.date]);
    h.officeIds = h.officeIds.filter(o => !mine.includes(o));
    if (!h.officeIds.length) db.holidays = db.holidays.filter(x => x.id !== id);
    log(u, mine.length === 1 ? mine[0] : null, 'Holiday removed', `${before.name}, ${fmtDate(before.date)}, ${mine.map(officeName).join(', ')}`);
    save(); return before;
  },
  /** PUT /holidays/{id}  Used by Undo. */
  async restoreHoliday(h: Holiday): Promise<void> {
    await wait(); manager();
    db.holidays = db.holidays.filter(x => x.id !== h.id); db.holidays.push(h); save();
  },

  // =====================================================================
  // Payroll
  // =====================================================================
  /** GET /payroll?month=  One line per office. */
  async payrollOverview(month: Month): Promise<OfficePayroll[]> {
    await wait(); const u = manager(); const c = ctx();
    return scopeOf('all', u).map(id => {
      const l = lockOf(id, month); const locked = !!l?.lockedAt;
      const rows = locked ? db.payslips.filter(p => p.officeId === id && p.month === month).map(p => p.row) : payrollRows(id, month, c);
      return {
        officeId: id, officeName: officeName(id), headName: nameOf(db.offices.find(o => o.id === id)?.headId) || null,
        totals: totalsOf(rows), locked, lockedAt: l?.lockedAt ?? null, missing: rows.reduce((n, r) => n + r.missing, 0),
      };
    });
  },
  /** GET /payroll/{officeId}/{month} */
  async payroll(officeId: string, month: Month): Promise<PayrollData> {
    await wait(); const u = manager(); const c = ctx(); oneOffice(officeId, u);
    const l = lockOf(officeId, month); const locked = !!l?.lockedAt;
    const rows = (locked ? db.payslips.filter(p => p.officeId === officeId && p.month === month).map(p => p.row) : payrollRows(officeId, month, c))
      .sort((a, b) => a.name.localeCompare(b.name));
    const people = payrollStaff(officeId, month);
    const missing: PayrollData['missing'] = [];
    if (!locked) {
      for (const e of people) for (const d of monthOfEmp(e, month, c)) {
        if (d.status !== 'missing') continue;
        const r = db.corrections.find(x => x.employeeId === e.id && x.date === d.date && x.status === 'pending');
        missing.push({ employeeId: e.id, name: e.name, date: d.date, inTime: d.inTime, request: r ? reqRow(r, u, c) : null });
      }
    }
    const shown = new Set(missing.map(m => m.request?.id));
    const pending = locked ? [] : allRequests()
      .filter(r => r.status === 'pending' && people.some(p => p.id === r.employeeId) && requestDates(r).some(d => monthOf(d) === month) && !shown.has(r.id))
      .map(r => reqRow(r, u, c));
    const monthClosed = c.today > monthDays(month).at(-1)!;
    const mine = u.role === 'admin' || u.officeId === officeId;
    return {
      officeId, officeName: officeName(officeId), month, rows, totals: totalsOf(rows), monthClosed,
      reviewed: !!l?.reviewedAt, reviewedByName: nameOf(l?.reviewedBy) || null,
      locked, lockedByName: nameOf(l?.lockedBy) || null, lockedAt: l?.lockedAt ?? null, missing, pending,
      canLock: mine && monthClosed && !locked && !!l?.reviewedAt && missing.length === 0 && pending.length === 0,
      canUnlock: u.role === 'admin' && locked,
    };
  },
  /** POST /payroll/{officeId}/{month}/review */
  async markReviewed(officeId: string, month: Month, reviewed = true): Promise<void> {
    await wait(); const u = manager(); oneOffice(officeId, u);
    if (isLocked(officeId, month)) fail(409, 'This month is already locked.');
    let l = lockOf(officeId, month);
    if (!l) { l = { officeId, month }; db.locks.push(l); }
    l.reviewedBy = reviewed ? u.id : undefined; l.reviewedAt = reviewed ? now() : undefined; save();
  },
  /** POST /payroll/{officeId}/{month}/lock */
  async lockMonth(officeId: string, month: Month): Promise<void> {
    await wait(); const u = manager(); const c = ctx(); oneOffice(officeId, u);
    const d = await api.payroll(officeId, month);
    if (d.locked) fail(409, 'This month is already locked.');
    if (!d.monthClosed) fail(409, `${fmtMonth(month)} can be locked after its last day.`);
    if (d.missing.length) fail(409, `Resolve ${d.missing.length} missing ${d.missing.length === 1 ? 'punch' : 'punches'} first.`);
    if (d.pending.length) fail(409, `Decide ${d.pending.length} pending ${d.pending.length === 1 ? 'request' : 'requests'} first.`);
    if (!d.reviewed) fail(409, 'Mark the salaries as reviewed first.');
    const l = lockOf(officeId, month)!;
    l.lockedBy = u.id; l.lockedAt = c.now;
    db.payslips = db.payslips.filter(p => !(p.officeId === officeId && p.month === month));
    for (const row of d.rows) { db.payslips.push({ officeId, month, row }); notify(row.employeeId, `Your ${fmtMonth(month)} payslip is ready`, '/me/payslips'); }
    log(u, officeId, 'Month locked', `${fmtMonth(month)} locked for ${officeName(officeId)}. Payslips released.`); save();
  },
  /** POST /payroll/{officeId}/{month}/unlock  Admin only. */
  async unlockMonth(officeId: string, month: Month, reason: string): Promise<void> {
    await wait(); const u = adminOnly();
    const l = lockOf(officeId, month);
    if (!l?.lockedAt) fail(409, 'This month is not locked.');
    if (!reason.trim()) fail(422, 'Write why the month is being unlocked.');
    l!.lockedAt = undefined; l!.lockedBy = undefined; l!.reviewedAt = undefined; l!.reviewedBy = undefined;
    db.payslips = db.payslips.filter(p => !(p.officeId === officeId && p.month === month));
    log(u, officeId, 'Month unlocked', `${fmtMonth(month)} unlocked for ${officeName(officeId)}. Payslips withdrawn. Reason: ${reason.trim()}`);
    notify(db.offices.find(o => o.id === officeId)?.headId, `${fmtMonth(month)} was unlocked by the admin: ${reason.trim()}`, '/payroll'); save();
  },
  /** GET /payslips?office=&month= */
  async payslips(scope: string, month: Month): Promise<PayslipListItem[]> {
    await wait(); const u = manager(); const ids = scopeOf(scope, u);
    return db.payslips.filter(p => ids.includes(p.officeId) && p.month === month).map(slipItem).sort((a, b) => a.name.localeCompare(b.name));
  },
  /** GET /me/payslips */
  async myPayslips(): Promise<PayslipListItem[]> {
    await wait(); const u = me();
    return db.payslips.filter(p => p.row.employeeId === u.id).map(slipItem).sort((a, b) => b.month.localeCompare(a.month));
  },
  /** GET /payslips/{employeeId}/{month}  The backend also serves the same data as a PDF at .../pdf */
  async payslip(employeeId: string, month: Month): Promise<Payslip> {
    await wait(); const u = me(); const e = need(employeeId);
    if (!canView(e, u)) fail(403, 'You cannot open this payslip.');
    const p = db.payslips.find(x => x.row.employeeId === employeeId && x.month === month) ?? fail(404, `The ${fmtMonth(month)} payslip is not released yet. It appears once the month is locked.`);
    const l = lockOf(p.officeId, month)!;
    return {
      company: db.settings.companyName, month, row: p.row, lockedAt: l.lockedAt!, lockedByName: nameOf(l.lockedBy),
      employee: { id: e.id, name: e.name, designation: e.designation, officeName: officeName(e.officeId), joinDate: e.joinDate },
    };
  },
  /** URL of the PDF the backend renders. The mock has no PDF, so the app prints the A4 preview instead. */
  payslipPdfUrl(employeeId: string, month: Month): string | null { void employeeId; void month; return null; },

  // =====================================================================
  // Employee self service
  // =====================================================================
  /** GET /me/home */
  async myHome(): Promise<MyHome> {
    await wait(); const u = me(); const c = ctx(); const e = need(u.id);
    const month = monthOf(c.today);
    const days = monthOfEmp(e, month, c);
    const prev = monthOfEmp(e, addMonths(month, -1), c);
    const t = countDays(days, c.today);
    const streak = streakFor(e, c);
    const hasPending = (d: Ymd) => db.corrections.some(r => r.employeeId === e.id && r.date === d && r.status === 'pending');
    const cleanLast = e.joinDate <= prev[0].date && !prev.some(d => ['half_late', 'half_short', 'absent', 'missing'].includes(d.status));
    const badge = (key: string, n: number) => ({
      key, label: `${n} days on time`, earned: streak.best >= n,
      hint: streak.best >= n ? 'Earned' : `${n - streak.current} more ${n - streak.current === 1 ? 'day' : 'days'}`,
    });
    const k = dayKind(c.today, e.officeId, db.holidays);
    const mine = db.payslips.filter(p => p.row.employeeId === e.id).sort((a, b) => b.month.localeCompare(a.month))[0];
    return {
      employee: empRow(e, u, c), today: dayOf(e, c.today, c), time: timeOf(c.now),
      dayKindLabel: k.kind === 'working' ? '' : k.kind === 'holiday' ? k.name ?? 'Holiday' : 'Weekly off',
      missing: [...prev, ...days].filter(d => d.status === 'missing' && !hasPending(d.date) && !isLocked(e.officeId, monthOf(d.date))),
      streak, badges: [badge('d7', 7), badge('d14', 14), badge('d30', 30),
        { key: 'full', label: 'Full month on time', earned: cleanLast, hint: cleanLast ? 'Earned last month' : 'No half days or absences in a month' }],
      balances: balancesOf(e, c),
      pending: allRequests().filter(r => r.employeeId === e.id && r.status === 'pending').map(r => reqRow(r, u, c)),
      nextHoliday: db.holidays.filter(h => h.kind === 'holiday' && h.officeIds.includes(e.officeId) && h.date >= c.today).sort((a, b) => a.date.localeCompare(b.date))[0] ?? null,
      latestPayslip: mine ? slipItem(mine) : null,
      month: { present: t.present, half: t.half, absent: t.absent, leave: t.leave },
      firstDays: e.joinDate >= addDays(c.today, -6),
    };
  },
  /** GET /me/attendance?month= */
  async myMonth(month: Month): Promise<MyMonth> {
    await wait(); const u = me(); const c = ctx(); const e = need(u.id);
    const days = monthOfEmp(e, month, c);
    return {
      month, days, totals: countDays(days, c.today), locked: isLocked(e.officeId, month),
      pendingDates: db.corrections.filter(r => r.employeeId === e.id && r.status === 'pending').map(r => r.date),
    };
  },
  /** GET /me/balances */
  async myBalances() { await wait(); const u = me(); return balancesOf(need(u.id), ctx()); },

  // =====================================================================
  // Notifications, audit, search
  // =====================================================================
  /** GET /notifications */
  async notifications(): Promise<Notification[]> { const u = me(); return db.notifications.filter(n => n.userId === u.id).slice(0, 30); },
  /** POST /notifications/read */
  async markNotificationsRead(): Promise<void> { const u = me(); for (const n of db.notifications) if (n.userId === u.id) n.read = true; save(); },
  /** GET /audit?office=&q= */
  async audit(q: { scope: string; search?: string }): Promise<AuditEntry[]> {
    await wait(); const u = manager(); const ids = scopeOf(q.scope, u); const s = (q.search ?? '').trim().toLowerCase();
    return db.audit
      .filter(a => (a.officeId ? ids.includes(a.officeId) : u.role === 'admin' && q.scope === 'all'))
      .filter(a => !s || `${a.action} ${a.detail} ${a.actorName}`.toLowerCase().includes(s))
      .slice(0, 200);
  },
  /** GET /search?q=  People and screens for Ctrl+K. */
  async search(q: string, scope: string): Promise<SearchHit[]> {
    const u = manager(); const s = q.trim().toLowerCase(); if (!s) return [];
    const ids = scopeOf(u.role === 'admin' ? 'all' : scope, u);
    const people: SearchHit[] = staff().filter(e => ids.includes(e.officeId) && (e.name.toLowerCase().includes(s) || e.id.toLowerCase().includes(s)))
      .slice(0, 6).map(e => ({ type: 'person', label: e.name, sub: `${e.id} · ${officeName(e.officeId)} · ${e.designation}`, to: `/people/${e.id}` }));
    const screens: SearchHit[] = SCREENS.filter(x => (!x.admin || u.role === 'admin') && x.label.toLowerCase().includes(s))
      .map(x => ({ type: 'screen', label: x.label, sub: 'Go to screen', to: x.to }));
    return [...people, ...screens];
  },

  // =====================================================================
  // Demo controls (not part of the backend)
  // =====================================================================
  demo: {
    presets: CLOCK_PRESETS,
    clockBase,
    now,
    setClock(at: string) { setClock(at); },
    reset() { resetDb(); invalidatePunches(); ensureSnapshots(); setSession(null); },
    outbox: () => db.outbox,
  },
};

function slipItem(p: { month: Month; row: { employeeId: string; name: string; net: number; salary: number; unpaidDays: number } }): PayslipListItem {
  return { employeeId: p.row.employeeId, name: p.row.name, month: p.month, net: p.row.net, salary: p.row.salary, unpaidDays: p.row.unpaidDays };
}
/** Pending requests this person should act on. Head: their office. Admin: requests from heads, plus anything escalated. */
function queueFor(u: SessionUser, ids: string[], c: Ctx): RequestRow[] {
  return allRequests()
    .filter(r => r.status === 'pending' && ids.includes(emp(r.employeeId)?.officeId ?? ''))
    .map(r => reqRow(r, u, c))
    .filter(r => r.canAct && (u.role === 'head' || r.fromHead || r.escalated))
    .sort((a, b) => Number(b.escalated) - Number(a.escalated) || a.createdAt.localeCompare(b.createdAt));
}
const SCREENS = [
  { label: 'Home', to: '/' }, { label: 'Employees', to: '/people' }, { label: 'Offices and office heads', to: '/people/offices', admin: true },
  { label: 'Attendance register', to: '/attendance' }, { label: 'Correction requests', to: '/attendance/corrections' }, { label: 'Terminals', to: '/attendance/terminals' },
  { label: 'Leave requests', to: '/leave' }, { label: 'Leave calendar', to: '/leave/calendar' }, { label: 'Holidays', to: '/leave/holidays' },
  { label: 'Payroll', to: '/payroll' }, { label: 'Payslips', to: '/payroll/payslips' },
  { label: 'Organisation settings', to: '/settings', admin: true }, { label: 'Audit log', to: '/settings/audit' },
];
