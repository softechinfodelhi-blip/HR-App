// Payroll runs: one per office per month. Open months are computed live. A locked month is a snapshot.
import { Prisma, type Db } from '../db';
import { audit } from '../lib/audit';
import { fail } from '../lib/errors';
import { queueEmail, appLink } from '../lib/mail';
import { adminUserIds, headUserId, notify } from '../lib/notify';
import { dbDate, fmtDate, fmtDays, fmtMonth, istToUtc, localDateTime, monthDays, now, today, ymdFromDb, type Month } from '../lib/time';
import { computeMonth, employedWhere, empSelect, freezeDays } from './attendance';
import { salaryFor } from './employees';
import { leaveInclude, leaveRow } from './leave';
import { payrollRow, totalsOf, type PayrollRow, type PayrollTotals } from './payroll-rules';
import type { Actor } from './permissions';
import { correctionInclude, correctionRow, timesText, userNames, type RequestRow } from './requests';
import { getSettings } from './settings';

const staffSelect = { ...empSelect, designation: true, salaryHistory: true, user: { select: { id: true, email: true } } } satisfies Prisma.EmployeeSelect;

/** Everyone on an office's payroll for a month: employed on at least one of its days. */
async function staffOf(db: Db, officeId: string, month: Month) {
  const d = monthDays(month);
  return db.employee.findMany({ where: { officeId, ...employedWhere(d[0], d[d.length - 1]) }, select: staffSelect, orderBy: { name: 'asc' } });
}

/** Live figures of an open month. `closeToday` judges today as finished (used by the lock). */
export async function liveRows(db: Db, officeId: string, month: Month, opts: { closeToday?: boolean } = {}) {
  const staff = await staffOf(db, officeId, month);
  const days = await computeMonth(db, staff, month, { closeToday: opts.closeToday, ignoreLock: true });
  const rows = staff.map(e => payrollRow(e, salaryFor(e.salaryHistory, month), month, days.get(e.id)!));
  return { staff, days, rows };
}

function itemToRow(i: Prisma.PayrollItemGetPayload<object>): PayrollRow {
  return {
    employeeId: i.employeeId, name: i.employeeName, code: i.employeeCode, designation: i.designation, salary: Number(i.monthlySalary), calendarDays: i.daysInMonth,
    dayRate: Number(i.dayRate), present: Number(i.present), half: Number(i.halfDays), absent: Number(i.absent), paidLeave: Number(i.paidLeave),
    unpaidLeave: Number(i.unpaidLeave), missing: 0, notEmployed: Number(i.notEmployed), unpaidDays: Number(i.unpaidDays), deduction: Number(i.deduction),
    net: Number(i.netSalary), trace: i.trace as PayrollRow['trace'],
  };
}
export async function lockedRows(db: Db, runId: string): Promise<PayrollRow[]> {
  return (await db.payrollItem.findMany({ where: { runId }, orderBy: { employeeName: 'asc' } })).map(itemToRow);
}

export interface PayrollData {
  officeId: string; officeName: string; month: Month; rows: PayrollRow[]; totals: PayrollTotals;
  monthClosed: boolean; reviewed: boolean; reviewedByName: string | null; locked: boolean; lockedByName: string | null; lockedAt: string | null;
  /** MISSING_PUNCH days. Each must be resolved before the lock. */
  missing: { employeeId: string; name: string; date: string; inTime: string | null; outTime: string | null; request: RequestRow | null }[];
  /** Pending requests that touch the month, other than the ones listed under `missing`. */
  pending: RequestRow[];
  /** Anything else that stops the lock, in words. */
  blockers: string[];
  canLock: boolean; canUnlock: boolean;
}

/** The payroll screen for one office and month: figures, the lock checklist and who may do what. */
export async function getPayroll(db: Db, actor: Actor, officeId: string, month: Month, opts: { closeToday?: boolean } = {}): Promise<PayrollData> {
  const office = (await db.office.findUnique({ where: { id: officeId } })) ?? fail(404, 'Office was not found.');
  const run = await db.payrollRun.findUnique({ where: { officeId_month: { officeId, month } } });
  const locked = run?.status === 'locked';
  const names = await userNames(db, [run?.reviewedById, run?.lockedById]);
  const d = monthDays(month); const last = d[d.length - 1];
  const monthClosed = today() > last;
  const head = { officeId, officeName: office.name, month, monthClosed, reviewed: !!run?.reviewedAt, reviewedByName: (run?.reviewedById && names.get(run.reviewedById)) || null, locked, lockedByName: (run?.lockedById && names.get(run.lockedById)) || null, lockedAt: run?.lockedAt ? localDateTime(run.lockedAt) : null };
  if (locked) {
    const rows = await lockedRows(db, run.id);
    return { ...head, rows, totals: totalsOf(rows), missing: [], pending: [], blockers: [], canLock: false, canUnlock: actor.role === 'admin' };
  }

  const { staff, days, rows } = await liveRows(db, officeId, month, opts);
  const ids = staff.map(e => e.id);
  const [corrections, leaves] = await Promise.all([
    db.correctionRequest.findMany({ where: { employeeId: { in: ids }, status: 'pending', date: { gte: dbDate(d[0]), lte: dbDate(last) } }, include: correctionInclude }),
    db.leaveRequest.findMany({ where: { employeeId: { in: ids }, status: 'pending', fromDate: { lte: dbDate(last) }, toDate: { gte: dbDate(d[0]) } }, include: leaveInclude }),
  ]);
  const none = new Map<string, string>();
  const missing: PayrollData['missing'] = [];
  const shown = new Set<string>();
  for (const e of staff) for (const day of days.get(e.id)!) {
    if (day.status !== 'missing') continue;
    const c = corrections.find(x => x.employeeId === e.id && ymdFromDb(x.date) === day.date);
    if (c) shown.add(c.id);
    missing.push({ employeeId: e.id, name: e.name, date: day.date, inTime: day.inTime, outTime: day.outTime, request: c ? correctionRow(c, actor, none) : null });
  }
  const pending = [...corrections.filter(c => !shown.has(c.id)).map(c => correctionRow(c, actor, none)), ...leaves.map(l => leaveRow(l, actor, none))];
  const blockers = rows.filter(r => !(r.salary > 0)).map(r => `${r.name} has no salary set for ${fmtMonth(month)}.`);
  return {
    ...head, rows, totals: totalsOf(rows), missing, pending, blockers,
    canLock: monthClosed && !!run?.reviewedAt && missing.length === 0 && pending.length === 0 && blockers.length === 0,
    canUnlock: false,
  };
}

export async function markReviewed(db: Db, actor: Actor, officeId: string, month: Month, reviewed: boolean): Promise<void> {
  const run = await db.payrollRun.upsert({ where: { officeId_month: { officeId, month } }, create: { officeId, month }, update: {} });
  if (run.status === 'locked') fail(409, 'This month is already locked.');
  await db.payrollRun.update({ where: { id: run.id }, data: { reviewedById: reviewed ? actor.userId : null, reviewedAt: reviewed ? now() : null } });
  await audit(db, actor, { action: reviewed ? 'Salaries marked reviewed' : 'Review mark removed', entity: 'payroll_run', entityId: run.id, officeId, detail: fmtMonth(month), old: { reviewed: !!run.reviewedAt }, new: { reviewed } });
}

/**
 * Locks a month for an office. In one transaction: checks the checklist again, freezes every attendance day
 * of the month, snapshots one payroll item per person (the payslips), and writes the audit entry.
 * After this, attendance, leave and corrections of that month can no longer change.
 */
export async function lockMonth(db: Db, actor: Actor, officeId: string, month: Month): Promise<PayrollData> {
  await db.payrollRun.upsert({ where: { officeId_month: { officeId, month } }, create: { officeId, month }, update: {} });
  // Take the row lock first, so two people pressing Lock at the same moment cannot both pass the checks.
  await db.$queryRaw`select id from payroll_runs where office_id = ${officeId}::uuid and month = ${month} for update`;
  const d = await getPayroll(db, actor, officeId, month, { closeToday: true });
  if (d.locked) fail(409, 'This month is already locked.');
  if (!d.monthClosed) fail(409, `${fmtMonth(month)} can be locked after its last day.`);
  if (d.missing.length) fail(409, `Resolve ${d.missing.length} missing ${d.missing.length === 1 ? 'punch' : 'punches'} first.`);
  if (d.pending.length) fail(409, `Decide ${d.pending.length} pending ${d.pending.length === 1 ? 'request' : 'requests'} first.`);
  if (d.blockers.length) fail(409, d.blockers[0]);
  if (!d.reviewed) fail(409, 'Mark the salaries as reviewed first.');

  const { staff, days, rows } = await liveRows(db, officeId, month, { closeToday: true });
  // Freeze attendance: the stored days become the record. Nothing recomputes them while the month is locked.
  const span = monthDays(month);
  await freezeDays(db, days, span[0], span[span.length - 1]);
  const t = now();
  const run = await db.payrollRun.update({ where: { officeId_month: { officeId, month } }, data: { status: 'locked', lockedById: actor.userId, lockedAt: t } });
  await db.payrollItem.deleteMany({ where: { runId: run.id } });
  await db.payrollItem.createMany({
    data: rows.map(r => ({
      runId: run.id, employeeId: r.employeeId, employeeName: r.name, employeeCode: r.code, designation: r.designation, monthlySalary: r.salary, daysInMonth: r.calendarDays,
      present: r.present, halfDays: r.half, absent: r.absent, paidLeave: r.paidLeave, unpaidLeave: r.unpaidLeave, notEmployed: r.notEmployed, unpaidDays: r.unpaidDays,
      dayRate: r.dayRate, deduction: r.deduction, netSalary: r.net, trace: r.trace,
    })),
  });
  const totals = totalsOf(rows);
  await audit(db, actor, { action: 'Month locked', entity: 'payroll_run', entityId: run.id, officeId, detail: `${fmtMonth(month)} locked for ${d.officeName}. ${rows.length} payslips released.`, old: { status: 'open' }, new: { status: 'locked', people: totals.people, unpaidDays: totals.unpaidDays } });
  // Payslips are released: tell each person.
  for (const e of staff) await notify(db, e.user?.id, { type: 'payslip_ready', text: `Your ${fmtMonth(month)} payslip is ready`, link: '/me/payslips' });

  // The admin gets the totals and every manual change of the month.
  const summary = await lockSummary(db, { ...actor, role: 'admin' }, officeId, month);
  const body = summaryText(summary);
  for (const adminId of await adminUserIds(db)) {
    const u = await db.user.findUnique({ where: { id: adminId }, select: { email: true } });
    await db.notification.create({ data: { userId: adminId, type: 'month_locked', payload: { text: `${fmtMonth(month)} was locked for ${d.officeName} by ${actor.name}`, link: '/payroll' } } });
    if (u) await queueEmail(db, u.email, `${fmtMonth(month)} locked for ${d.officeName}: net ${rupees(totals.net)}`, body);
  }
  return getPayroll(db, actor, officeId, month);
}

/** Admin only. The payslips are withdrawn and the month can change again. */
export async function unlockMonth(db: Db, actor: Actor, officeId: string, month: Month, reason: string): Promise<void> {
  if (actor.role !== 'admin') fail(403, 'Only the admin can unlock a month.');
  const run = await db.payrollRun.findUnique({ where: { officeId_month: { officeId, month } }, include: { office: { select: { name: true } }, _count: { select: { items: true } } } });
  if (!run || run.status !== 'locked') fail(409, 'This month is not locked.');
  await db.payrollItem.deleteMany({ where: { runId: run.id } });
  await db.payrollRun.update({ where: { id: run.id }, data: { status: 'open', lockedById: null, lockedAt: null, reviewedById: null, reviewedAt: null } });
  await audit(db, actor, { action: 'Month unlocked', entity: 'payroll_run', entityId: run.id, officeId, detail: `${fmtMonth(month)} unlocked for ${run.office.name}. ${run._count.items} payslips withdrawn. Reason: ${reason}`, old: { status: 'locked', lockedById: run.lockedById, lockedAt: run.lockedAt }, new: { status: 'open', reason } });
  await notify(db, await headUserId(db, officeId), { type: 'month_unlocked', text: `${fmtMonth(month)} was unlocked by the admin: ${reason}`, link: '/payroll' });
}

// ---------- lock summary ----------
export interface LockSummary {
  officeId: string; officeName: string; month: Month; locked: boolean; lockedAt: string | null; lockedByName: string | null; totals: PayrollTotals;
  corrections: { employeeName: string; date: string; detail: string; reason: string; byName: string; direct: boolean }[];
  balanceAdjustments: ChangeLine[]; quotaChanges: ChangeLine[]; salaryChanges: ChangeLine[];
}
interface ChangeLine { at: string; byName: string; detail: string; old?: unknown; new?: unknown; }

/** Totals of the month and every manual change made in it: corrections, balance adjustments, quota changes, salary changes. */
export async function lockSummary(db: Db, actor: Actor, officeId: string, month: Month): Promise<LockSummary> {
  const office = (await db.office.findUnique({ where: { id: officeId } })) ?? fail(404, 'Office was not found.');
  const run = await db.payrollRun.findUnique({ where: { officeId_month: { officeId, month } } });
  const locked = run?.status === 'locked';
  const rows = locked ? await lockedRows(db, run.id) : (await liveRows(db, officeId, month)).rows;
  const d = monthDays(month);
  const corrections = await db.correctionRequest.findMany({ where: { status: 'approved', date: { gte: dbDate(d[0]), lte: dbDate(d[d.length - 1]) }, employee: { officeId } }, include: correctionInclude, orderBy: [{ date: 'asc' }, { decidedAt: 'asc' }] });
  // Changes made from the 1st of the month until the lock (or until now, for an open month).
  const logs = await db.auditLog.findMany({
    where: { officeId, action: { in: ['Leave balance adjusted', 'Leave quota changed', 'Salary changed', 'Salary set'] }, createdAt: { gte: istToUtc(d[0]), lte: run?.lockedAt ?? now() } },
    orderBy: { id: 'asc' },
  });
  const names = await userNames(db, [run?.lockedById, ...corrections.map(c => c.decidedById)]);
  // Salary amounts go to the admin only.
  const line = (l: (typeof logs)[number]): ChangeLine => ({ at: localDateTime(l.createdAt), byName: l.actorName, detail: l.detail, ...(l.sensitive && actor.role !== 'admin' ? {} : { old: l.oldValue ?? undefined, new: l.newValue ?? undefined }) });
  return {
    officeId, officeName: office.name, month, locked, lockedAt: run?.lockedAt ? localDateTime(run.lockedAt) : null, lockedByName: (run?.lockedById && names.get(run.lockedById)) || null,
    totals: totalsOf(rows),
    corrections: corrections.map(c => ({
      employeeName: c.employee.name, date: ymdFromDb(c.date), detail: timesText(c.claimedIn, c.claimedOut), reason: c.reason, byName: (c.decidedById && names.get(c.decidedById)) || '',
      direct: !!c.createdById && c.createdById === c.decidedById && c.createdById !== c.employee.user?.id,
    })),
    balanceAdjustments: logs.filter(l => l.action === 'Leave balance adjusted').map(line),
    quotaChanges: logs.filter(l => l.action === 'Leave quota changed').map(line),
    salaryChanges: logs.filter(l => l.action === 'Salary changed' || l.action === 'Salary set').map(line),
  };
}

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
export const rupees = (n: number) => `Rs. ${inr.format(n)}`;

function summaryText(s: LockSummary): string {
  const list = (title: string, lines: string[]) => [`${title} (${lines.length})`, ...(lines.length ? lines.map(l => `  - ${l}`) : ['  None'])].join('\n');
  return [
    `${fmtMonth(s.month)} was locked for ${s.officeName}${s.lockedByName ? ` by ${s.lockedByName}` : ''}.`,
    [`People: ${s.totals.people}`, `Monthly salaries: ${rupees(s.totals.salary)}`, `Unpaid days: ${fmtDays(s.totals.unpaidDays)}`, `Deductions: ${rupees(s.totals.deduction)}`, `Net payable: ${rupees(s.totals.net)}`].join('\n'),
    list('Attendance corrections', s.corrections.map(c => `${c.employeeName}, ${fmtDate(c.date)}: ${c.detail}. ${c.direct ? 'Entered' : 'Approved'} by ${c.byName}. Reason: ${c.reason}`)),
    list('Leave balance adjustments', s.balanceAdjustments.map(c => `${c.detail} (by ${c.byName})`)),
    list('Leave quota changes', s.quotaChanges.map(c => `${c.detail} (by ${c.byName})`)),
    // Amounts are left out of email on purpose. They are on the lock summary in the app.
    list('Salary changes', s.salaryChanges.map(c => `${c.detail} (by ${c.byName})`)),
    `Open: ${appLink('/payroll')}`,
  ].join('\n\n');
}

// ---------- payslips ----------
export interface Payslip {
  company: string; month: Month; employee: { id: string; name: string; code: string; designation: string; officeName: string; joinDate: string };
  row: PayrollRow; lockedAt: string; lockedByName: string;
}
export async function loadPayslip(db: Db, employeeId: string, month: Month): Promise<Payslip | null> {
  const item = await db.payrollItem.findFirst({
    where: { employeeId, run: { month, status: 'locked' } },
    include: { run: { include: { office: { select: { name: true } } } }, employee: { select: { joiningDate: true } } },
  });
  if (!item) return null;
  const names = await userNames(db, [item.run.lockedById]);
  return {
    company: (await getSettings(db)).companyName, month,
    employee: { id: employeeId, name: item.employeeName, code: item.employeeCode, designation: item.designation, officeName: item.run.office.name, joinDate: ymdFromDb(item.employee.joiningDate) },
    row: itemToRow(item), lockedAt: item.run.lockedAt ? localDateTime(item.run.lockedAt) : '', lockedByName: (item.run.lockedById && names.get(item.run.lockedById)) || '',
  };
}
