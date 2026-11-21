// Employees: the rows the app shows, and the writes behind People and Profile.
import { Prisma, type Db } from '../db';
import { audit, diff } from '../lib/audit';
import { fail } from '../lib/errors';
import { notify } from '../lib/notify';
import { dbDate, fmtDate, fmtMonth, now, thisMonth, today, ymdFromDb, type Month, type Ymd } from '../lib/time';
import { sendInvite } from './invites';
import { isLocked } from './locks';
import { type Actor, type ApiRole, canSeeSalary } from './permissions';
import { getSettings } from './settings';

export const employeeInclude = {
  office: { select: { id: true, name: true, number: true, headEmployeeId: true } },
  user: { select: { id: true, email: true, role: true } },
  salaryHistory: true,
  leaveQuotas: true,
} satisfies Prisma.EmployeeInclude;
export type EmployeeFull = Prisma.EmployeeGetPayload<{ include: typeof employeeInclude }>;

export interface EmployeeRow {
  id: string; code: string; name: string; email: string; phone: string; officeId: string; officeName: string;
  role: ApiRole; isHead: boolean; designation: string; joinDate: Ymd; lastWorkingDate: Ymd | null;
  status: 'invited' | 'active' | 'inactive'; terminalUserId: string; clQuota: number; plQuota: number;
  bestStreak: number; salary: number | null;
}

/** The salary that applies to a month: the latest revision effective on or before it. */
export function salaryFor(history: { monthlyAmount: Prisma.Decimal; effectiveMonth: Month }[], month: Month): number {
  let best: { m: Month; amount: number } | null = null;
  for (const s of history) {
    if (s.effectiveMonth > month) continue;
    if (!best || s.effectiveMonth > best.m) best = { m: s.effectiveMonth, amount: Number(s.monthlyAmount) };
  }
  return best?.amount ?? 0;
}

export function employeeRow(e: EmployeeFull, actor: Actor): EmployeeRow {
  const year = Number(today().slice(0, 4));
  const quota = e.leaveQuotas.find(q => q.year === year);
  return {
    id: e.id, code: e.code, name: e.name, email: e.user?.email ?? '', phone: e.phone, officeId: e.officeId, officeName: e.office.name,
    role: e.user?.role === 'office_head' ? 'head' : 'employee', isHead: e.office.headEmployeeId === e.id,
    designation: e.designation, joinDate: ymdFromDb(e.joiningDate), lastWorkingDate: e.lastWorkingDate ? ymdFromDb(e.lastWorkingDate) : null,
    status: e.status, terminalUserId: e.terminalUserId ?? '', clQuota: Number(quota?.clPerYear ?? 0), plQuota: Number(quota?.plPerYear ?? 0),
    bestStreak: e.bestStreak,
    // Salary goes only to the admin, the employee's office head and the employee.
    salary: canSeeSalary(actor, e) ? salaryFor(e.salaryHistory, thisMonth()) : null,
  };
}

export async function loadEmployee(db: Db, id: string): Promise<EmployeeFull> {
  return (await db.employee.findUnique({ where: { id }, include: employeeInclude })) ?? fail(404, 'Employee was not found.');
}

// ---------------------------------------------------------------------
export interface NewEmployee {
  name: string; email: string; phone: string; officeId: string; designation: string; joinDate: Ymd;
  salary: number; effectiveMonth: Month; clQuota?: number; plQuota?: number; terminalUserId?: string; role?: 'employee' | 'head';
}

/** Adds the person, their login (invited, no password yet), first salary and leave quota, and emails the invite. */
export async function createEmployee(db: Db, actor: Actor, input: NewEmployee): Promise<{ employee: EmployeeFull; inviteToken: string }> {
  // A head always adds to their own office, whatever the form says.
  const officeId = actor.role === 'head' ? actor.officeId! : input.officeId;
  const office = (await db.office.findUnique({ where: { id: officeId } })) ?? fail(422, 'Choose an office.');
  const asHead = input.role === 'head';
  if (asHead && actor.role !== 'admin') fail(403, 'Only the admin can add an office head.');
  if (asHead && office.headEmployeeId) fail(409, `${office.name} already has a head. Change the head on the Offices screen.`);
  if (await db.user.findUnique({ where: { email: input.email } })) fail(409, 'This email is already used by another person.');

  // The running number per office gives the code (EMP-0117) and the default terminal user id (117).
  const { nextEmployeeSeq } = await db.office.update({ where: { id: officeId }, data: { nextEmployeeSeq: { increment: 1 } }, select: { nextEmployeeSeq: true } });
  const seq = nextEmployeeSeq - 1;
  const code = `EMP-${String(office.number).padStart(2, '0')}${String(seq).padStart(2, '0')}`;
  const terminalUserId = input.terminalUserId?.trim() || String(office.number * 100 + seq);
  if (await db.employee.findUnique({ where: { terminalUserId } })) fail(409, `Terminal user ID ${terminalUserId} is already used. Enter a different one.`);

  const settings = await getSettings(db);
  const clQuota = input.clQuota ?? settings.defaultClQuota;
  const plQuota = input.plQuota ?? settings.defaultPlQuota;
  // The quota row for the year the person starts earning leave in.
  const years = [Math.max(Number(today().slice(0, 4)), Number(input.joinDate.slice(0, 4)))];

  const created = await db.employee.create({
    data: {
      code, name: input.name, phone: input.phone, designation: input.designation || 'Executive', officeId,
      joiningDate: dbDate(input.joinDate), terminalUserId, status: 'invited',
      user: { create: { email: input.email, role: asHead ? 'office_head' : 'employee' } },
      salaryHistory: { create: { monthlyAmount: input.salary, effectiveMonth: input.effectiveMonth, setById: actor.userId } },
      leaveQuotas: { create: years.map(year => ({ year, clPerYear: clQuota, plPerYear: plQuota })) },
    },
    include: { user: true },
  });
  if (asHead) await db.office.update({ where: { id: officeId }, data: { headEmployeeId: created.id } });

  const inviteToken = await sendInvite(db, created.user!, created.name);
  await audit(db, actor, {
    action: asHead ? 'Office head added' : 'Employee added', entity: 'employee', entityId: created.id, officeId,
    detail: `${created.name} (${code}), ${created.designation}, joins ${fmtDate(input.joinDate)}`,
    new: { code, name: created.name, email: input.email, designation: created.designation, joinDate: input.joinDate, terminalUserId, clQuota, plQuota, role: asHead ? 'head' : 'employee' },
  });
  await audit(db, actor, {
    action: 'Salary set', entity: 'salary', entityId: created.id, officeId, sensitive: true,
    detail: `${created.name} (${code}) from ${fmtMonth(input.effectiveMonth)}`, new: { amount: input.salary, effectiveMonth: input.effectiveMonth },
  });
  return { employee: await loadEmployee(db, created.id), inviteToken };
}

// ---------------------------------------------------------------------
export interface EmployeePatch {
  name?: string; email?: string; phone?: string; designation?: string; joinDate?: Ymd; lastWorkingDate?: Ymd | null;
  terminalUserId?: string; clQuota?: number; plQuota?: number;
}

export async function updateEmployee(db: Db, actor: Actor, e: EmployeeFull, patch: EmployeePatch): Promise<void> {
  const year = Number(today().slice(0, 4));
  const quota = e.leaveQuotas.find(q => q.year === year);
  const before = {
    name: e.name, email: e.user?.email ?? '', phone: e.phone, designation: e.designation, joinDate: ymdFromDb(e.joiningDate),
    lastWorkingDate: e.lastWorkingDate ? ymdFromDb(e.lastWorkingDate) : null, terminalUserId: e.terminalUserId ?? '',
    clQuota: Number(quota?.clPerYear ?? 0), plQuota: Number(quota?.plPerYear ?? 0),
  };
  const d = diff(before, patch);
  if (!d.changed.length) return;

  if (d.new.email) {
    const other = await db.user.findUnique({ where: { email: d.new.email } });
    if (other && other.employeeId !== e.id) fail(409, 'This email is already used.');
  }
  if (d.new.terminalUserId) {
    const other = await db.employee.findUnique({ where: { terminalUserId: d.new.terminalUserId } });
    if (other && other.id !== e.id) fail(409, `Terminal user ID ${d.new.terminalUserId} belongs to ${other.name}.`);
  }
  for (const key of ['joinDate', 'lastWorkingDate'] as const) {
    if (!(key in d.new)) continue;
    const dates = [before[key], d.new[key]].filter((x): x is string => !!x).sort();
    const lockedRun = await db.payrollRun.findFirst({ where: { officeId: e.officeId, status: 'locked', month: { gte: dates[0].slice(0, 7) } }, orderBy: { month: 'asc' } });
    if (lockedRun) fail(409, `${fmtMonth(lockedRun.month)} is locked, so this date cannot change. Ask the admin to unlock it first.`);
  }
  const join = patch.joinDate ?? before.joinDate;
  const last = patch.lastWorkingDate === undefined ? before.lastWorkingDate : patch.lastWorkingDate;
  if (last && last < join) fail(422, 'The last working date is before the joining date.');

  await db.employee.update({
    where: { id: e.id },
    data: {
      name: d.new.name, phone: d.new.phone, designation: d.new.designation,
      joiningDate: d.new.joinDate ? dbDate(d.new.joinDate) : undefined,
      lastWorkingDate: 'lastWorkingDate' in d.new ? (d.new.lastWorkingDate ? dbDate(d.new.lastWorkingDate) : null) : undefined,
      terminalUserId: 'terminalUserId' in d.new ? d.new.terminalUserId || null : undefined,
    },
  });
  if (d.new.email && e.user) await db.user.update({ where: { id: e.user.id }, data: { email: d.new.email } });
  if (d.new.clQuota !== undefined || d.new.plQuota !== undefined) {
    await setQuota(db, e.id, year, d.new.clQuota ?? before.clQuota, d.new.plQuota ?? before.plQuota);
  }
  const quotaChanged = d.changed.some(k => k === 'clQuota' || k === 'plQuota');
  await audit(db, actor, {
    action: quotaChanged && d.changed.length <= 2 ? 'Leave quota changed' : 'Employee updated', entity: 'employee', entityId: e.id, officeId: e.officeId,
    detail: `${e.name} (${e.code}): ${d.changed.join(', ')}`, old: d.old, new: d.new,
  });
}

export async function setQuota(db: Db, employeeId: string, year: number, clPerYear: number, plPerYear: number): Promise<void> {
  await db.leaveQuota.upsert({
    where: { employeeId_year: { employeeId, year } },
    create: { employeeId, year, clPerYear, plPerYear }, update: { clPerYear, plPerYear },
  });
}

/** A new salary from a month onwards. Earlier months keep the old amount. A locked month cannot change. */
export async function setSalary(db: Db, actor: Actor, e: EmployeeFull, amount: number, effectiveMonth: Month): Promise<void> {
  if (await isLocked(db, e.officeId, effectiveMonth)) fail(409, `${fmtMonth(effectiveMonth)} is locked. Choose a later month.`);
  const same = e.salaryHistory.find(s => s.effectiveMonth === effectiveMonth);
  const oldAmount = salaryFor(e.salaryHistory, effectiveMonth);
  await db.salaryHistory.upsert({
    where: { employeeId_effectiveMonth: { employeeId: e.id, effectiveMonth } },
    create: { employeeId: e.id, monthlyAmount: amount, effectiveMonth, setById: actor.userId },
    update: { monthlyAmount: amount, setById: actor.userId, setAt: now() },
  });
  // The amount is kept in old/new (admin only), never in the text.
  await audit(db, actor, {
    action: 'Salary changed', entity: 'salary', entityId: e.id, officeId: e.officeId, sensitive: true,
    detail: `${e.name} (${e.code}) from ${fmtMonth(effectiveMonth)}${same ? ' (replaced the amount set earlier for this month)' : ''}`,
    old: { amount: oldAmount, effectiveMonth }, new: { amount, effectiveMonth },
  });
  await notify(db, e.user?.id, { type: 'salary_changed', text: `Your salary was updated from ${fmtMonth(effectiveMonth)}`, link: '/me/profile' });
}

export async function setStatus(db: Db, actor: Actor, e: EmployeeFull, status: 'active' | 'inactive'): Promise<void> {
  if (e.status === status) return;
  if (e.status === 'invited') fail(409, `${e.name} has not set a password yet. Send a new invite instead.`);
  if (status === 'inactive' && e.office.headEmployeeId === e.id) fail(409, 'Choose another office head before switching this account off.');
  await db.employee.update({ where: { id: e.id }, data: { status } });
  if (status === 'inactive' && e.user) await db.session.deleteMany({ where: { userId: e.user.id } });
  await audit(db, actor, {
    action: status === 'inactive' ? 'Account switched off' : 'Account switched on', entity: 'employee', entityId: e.id, officeId: e.officeId,
    detail: `${e.name} (${e.code})`, old: { status: e.status }, new: { status },
  });
}

/** Undo of "Add employee". Only while the invite is unused, so nothing else can hang off the record yet. */
export async function removeInvited(db: Db, actor: Actor, e: EmployeeFull): Promise<void> {
  if (e.status !== 'invited') fail(409, 'This person has already signed in. Switch the account off instead.');
  if (e.office.headEmployeeId === e.id) await db.office.update({ where: { id: e.officeId }, data: { headEmployeeId: null } });
  await db.employee.delete({ where: { id: e.id } }); // login, salary and quota rows go with it
  await audit(db, actor, {
    action: 'Employee removed', entity: 'employee', entityId: e.id, officeId: e.officeId,
    detail: `${e.name} (${e.code}) removed before first sign in`, old: { code: e.code, name: e.name, email: e.user?.email },
  });
}

