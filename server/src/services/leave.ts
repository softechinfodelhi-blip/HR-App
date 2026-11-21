// Leave: CL, PL and UNPAID. A balance is only ever the sum of leave_ledger. Nothing else stores one.
import { Prisma, type Db } from '../db';
import { audit } from '../lib/audit';
import { fail } from '../lib/errors';
import { adminUserIds, notify } from '../lib/notify';
import { addMonths, dateRange, dbDate, fmtDate, fmtDays, fmtMonth, fmtRange, localDateTime, monthOf, now, round2, today, ymdFromDb, type Month, type Ymd } from '../lib/time';
import { recomputeDay } from './attendance';
import { loadCalendar, loadCalendars, workingDates, workingDaysElapsed } from './calendar';
import type { HalfDay, LeaveType } from './day-rules';
import { assertOpen, isLocked } from './locks';
import { type Actor, canManage } from './permissions';
import { approverUserIds, type RequestRow, UNDO_MS } from './requests';
import { getSettings } from './settings';

export type PaidType = 'CL' | 'PL';
export const typeName = (t: LeaveType) => (t === 'UNPAID' ? 'Unpaid leave' : t);
/** The longest single request. Longer absences are entered as several requests. */
export const MAX_RANGE_DAYS = 92;

export const leaveInclude = { employee: { select: { id: true, name: true, code: true, officeId: true, joiningDate: true, lastWorkingDate: true, office: { select: { name: true, headEmployeeId: true } }, user: { select: { id: true } } } } } satisfies Prisma.LeaveRequestInclude;
export type LeaveFull = Prisma.LeaveRequestGetPayload<{ include: typeof leaveInclude }>;

// ---------- balances ----------
export interface LeaveBalance { quota: number; balance: number; pending: number; available: number; }
export interface Balances { cl: LeaveBalance; pl: LeaveBalance; }

/** Sum of the ledger, per type. `upTo` limits it to entries dated on or before that day. */
export async function ledgerSums(db: Db, employeeId: string, upTo?: Ymd): Promise<Record<PaidType, number>> {
  const rows = await db.leaveLedger.groupBy({ by: ['leaveType'], where: { employeeId, ...(upTo ? { entryDate: { lte: dbDate(upTo) } } : {}) }, _sum: { deltaDays: true } });
  const of = (t: PaidType) => round2(Number(rows.find(r => r.leaveType === t)?._sum.deltaDays ?? 0));
  return { CL: of('CL'), PL: of('PL') };
}

export async function balancesOf(db: Db, employeeId: string, ignoreRequestId?: string): Promise<Balances> {
  const year = Number(today().slice(0, 4));
  const [sums, quota, pending] = await Promise.all([
    ledgerSums(db, employeeId),
    db.leaveQuota.findUnique({ where: { employeeId_year: { employeeId, year } } }),
    db.leaveRequest.groupBy({ by: ['type'], where: { employeeId, status: 'pending', type: { in: ['CL', 'PL'] }, ...(ignoreRequestId ? { id: { not: ignoreRequestId } } : {}) }, _sum: { days: true } }),
  ]);
  const one = (t: PaidType, q: number): LeaveBalance => {
    const p = Number(pending.find(x => x.type === t)?._sum.days ?? 0);
    return { quota: q, balance: sums[t], pending: p, available: round2(sums[t] - p) };
  };
  return { cl: one('CL', Number(quota?.clPerYear ?? 0)), pl: one('PL', Number(quota?.plPerYear ?? 0)) };
}

async function addLedger(db: Db, employeeId: string, type: PaidType, delta: number, reason: string, ref: string | null, entryDate: Ymd, createdById: string | null, uniqueKey?: string) {
  await db.leaveLedger.create({ data: { employeeId, leaveType: type, deltaDays: delta, reason, ref, entryDate: dbDate(entryDate), createdById, uniqueKey: uniqueKey ?? null } });
}

// ---------- asking for leave ----------
export interface LeaveInput { type: LeaveType; from: Ymd; to: Ymd; halfDay: HalfDay; }
export interface LeavePreview { days: number; ok: boolean; message: string | null; balance: number | null; balanceAfter: number | null; }
type EmpForLeave = { id: string; officeId: string; joiningDate: Date; lastWorkingDate: Date | null };

/** Counts the working days of a request and checks it. Used while the form is filled in, and again on submit. */
export async function previewLeave(db: Db, e: EmpForLeave, input: LeaveInput): Promise<LeavePreview> {
  const none: LeavePreview = { days: 0, ok: false, message: null, balance: null, balanceAfter: null };
  if (input.to < input.from) return { ...none, message: 'The last day is before the first day.' };
  if (input.halfDay !== 'none' && input.from !== input.to) return { ...none, message: 'A half day can only be taken on a single date.' };
  if (dateRange(input.from, input.to).length > MAX_RANGE_DAYS) return { ...none, message: `One request can cover at most ${MAX_RANGE_DAYS} days.` };
  if (input.from < ymdFromDb(e.joiningDate) || (e.lastWorkingDate && input.to > ymdFromDb(e.lastWorkingDate))) return { ...none, message: 'These dates are outside the time you work here.' };

  // Only working days are charged. Weekly offs and holidays inside the range are free.
  const cal = await loadCalendar(db, e.officeId, input.from, input.to);
  const working = workingDates(input.from, input.to, cal).length;
  const days = input.halfDay !== 'none' ? working * 0.5 : working;
  const bal = await balancesOf(db, e.id);
  const b = input.type === 'CL' ? bal.cl : input.type === 'PL' ? bal.pl : null;
  const res: LeavePreview = { days, ok: true, message: null, balance: b ? b.available : null, balanceAfter: b ? round2(b.available - days) : null };
  if (days === 0) return { ...res, ok: false, message: 'There are no working days in these dates.' };

  const clash = await db.leaveRequest.findFirst({ where: { employeeId: e.id, status: { in: ['pending', 'approved'] }, fromDate: { lte: dbDate(input.to) }, toDate: { gte: dbDate(input.from) } } });
  if (clash) return { ...res, ok: false, message: `You already have leave on ${fmtRange(ymdFromDb(clash.fromDate), ymdFromDb(clash.toDate))}.` };
  // Past-dated leave is allowed until that office's month is locked.
  for (const m of new Set(dateRange(input.from, input.to).map(monthOf))) {
    if (await isLocked(db, e.officeId, m)) return { ...res, ok: false, message: `${fmtMonth(m)} is already locked.` };
  }
  // Paid leave cannot go past the balance. The rest has to be asked for as unpaid leave.
  if (b && days > b.available) {
    return { ...res, ok: false, message: `You have ${fmtDays(Math.max(0, b.available))} of ${input.type} available. Shorten the dates, or ask for the rest as unpaid leave.` };
  }
  return res;
}

const what = (l: { type: LeaveType; fromDate: Date; toDate: Date }) => `${typeName(l.type)} for ${fmtRange(ymdFromDb(l.fromDate), ymdFromDb(l.toDate))}`;
const datesOf = (l: { fromDate: Date; toDate: Date }) => dateRange(ymdFromDb(l.fromDate), ymdFromDb(l.toDate));

export async function applyLeave(db: Db, actor: Actor, input: LeaveInput & { reason: string }): Promise<LeaveFull> {
  if (!actor.employeeId) fail(403, 'The admin account has no leave.');
  const e = await db.employee.findUniqueOrThrow({ where: { id: actor.employeeId }, include: { office: { select: { headEmployeeId: true } } } });
  const v = await previewLeave(db, e, input);
  if (!v.ok) fail(422, v.message ?? 'This leave cannot be requested.');
  const l = await db.leaveRequest.create({
    data: { employeeId: e.id, type: input.type, fromDate: dbDate(input.from), toDate: dbDate(input.to), halfDay: input.halfDay, days: v.days, reason: input.reason, createdAt: now() },
    include: leaveInclude,
  });
  await audit(db, actor, { action: 'Leave requested', entity: 'leave_request', entityId: l.id, officeId: e.officeId, detail: `${e.name}, ${what(l)}, ${fmtDays(v.days)}`, new: { ...input, days: v.days } });
  for (const to of await approverUserIds(db, e)) await notify(db, to, { type: 'leave_requested', text: `${e.name} asked for ${typeName(l.type)}, ${fmtRange(input.from, input.to)}`, link: '/leave' });
  return l;
}

export function leaveRow(l: LeaveFull, actor: Actor, names: Map<string, string>): RequestRow {
  const e = l.employee; const from = ymdFromDb(l.fromDate); const to = ymdFromDb(l.toDate); const days = Number(l.days);
  return {
    id: l.id, kind: 'leave', employeeId: e.id, employeeName: e.name, employeeCode: e.code, officeId: e.officeId, officeName: e.office.name,
    title: `${typeName(l.type)} · ${fmtRange(from, to)}`, detail: l.halfDay === 'none' ? fmtDays(days) : `Half day (${l.halfDay} half)`,
    reason: l.reason, status: l.status, createdAt: localDateTime(l.createdAt),
    escalated: l.status === 'pending' && !!l.escalatedAt, fromHead: e.office.headEmployeeId === e.id,
    canAct: l.status === 'pending' && canManage(actor, e),
    decidedByName: (l.decidedById && names.get(l.decidedById)) || undefined, decidedAt: l.decidedAt ? localDateTime(l.decidedAt) : undefined,
    comment: l.comment ?? undefined, dates: dateRange(from, to),
    leaveType: l.type, from, to, halfDay: l.halfDay, half: l.halfDay !== 'none', days,
    // Approved leave can be cancelled by the office head (or the admin) until the month is locked.
    canCancelApproved: l.status === 'approved' && canManage(actor, e),
  };
}

// ---------- deciding ----------
type Changed = { officeId: string; employeeId: string; date: Ymd } | null;
async function recomputeLeaveDays(db: Db, l: LeaveFull): Promise<Changed> {
  let last: Changed = null;
  for (const d of datesOf(l)) last = (await recomputeDay(db, l.employeeId, d)) ?? last;
  return last;
}
/** Approval takes the days out of the balance. The balance can never go below zero. */
async function charge(db: Db, l: LeaveFull, byUserId: string) {
  if (l.type === 'UNPAID') return;
  const sums = await ledgerSums(db, l.employeeId);
  const days = Number(l.days);
  if (days > sums[l.type]) fail(409, `${l.employee.name} has only ${fmtDays(Math.max(0, sums[l.type]))} of ${l.type} left. The rest has to be unpaid leave.`);
  await addLedger(db, l.employeeId, l.type, -days, 'leave', l.id, ymdFromDb(l.fromDate), byUserId);
}
/** Gives the days back. */
async function refund(db: Db, l: LeaveFull, byUserId: string) {
  if (l.type === 'UNPAID') return;
  await addLedger(db, l.employeeId, l.type, Number(l.days), 'reversal', l.id, ymdFromDb(l.fromDate), byUserId);
}

export async function decideLeave(db: Db, actor: Actor, l: LeaveFull, decision: 'approved' | 'rejected', comment: string): Promise<Changed> {
  const e = l.employee;
  if (!canManage(actor, e)) fail(403, actor.employeeId === e.id ? 'The admin decides your own requests.' : 'You cannot decide this request.');
  if (l.status !== 'pending') fail(409, 'This request has already been decided.');
  if (decision === 'rejected' && !comment) fail(422, 'Write a reason. The employee will see it.');
  await assertOpen(db, e.officeId, datesOf(l));
  const done = await db.leaveRequest.updateMany({ where: { id: l.id, status: 'pending' }, data: { status: decision, decidedById: actor.userId, decidedAt: now(), comment: comment || null } });
  if (done.count !== 1) fail(409, 'This request has already been decided.');
  if (decision === 'approved') await charge(db, l, actor.userId);
  await audit(db, actor, { action: `Leave ${decision}`, entity: 'leave_request', entityId: l.id, officeId: e.officeId, detail: `${e.name}, ${what(l)}${comment ? `. Reason: ${comment}` : ''}`, old: { status: 'pending' }, new: { status: decision, comment: comment || null } });
  await notify(db, e.user?.id, { type: 'request_decided', text: `Your ${what(l)} was ${decision}${comment ? `: ${comment}` : ''}`, link: '/me/leave' });
  return decision === 'approved' ? recomputeLeaveDays(db, { ...l, status: 'approved' }) : null;
}

export async function undoLeave(db: Db, actor: Actor, l: LeaveFull): Promise<Changed> {
  const e = l.employee;
  if ((l.status !== 'approved' && l.status !== 'rejected') || l.decidedById !== actor.userId || !l.decidedAt || now().getTime() - l.decidedAt.getTime() > UNDO_MS) fail(409, 'It is too late to undo this.');
  await assertOpen(db, e.officeId, datesOf(l));
  await db.leaveRequest.update({ where: { id: l.id }, data: { status: 'pending', decidedById: null, decidedAt: null, comment: null } });
  if (l.status === 'approved') await refund(db, l, actor.userId);
  await audit(db, actor, { action: 'Decision undone', entity: 'leave_request', entityId: l.id, officeId: e.officeId, detail: `${e.name}, ${what(l)} is pending again`, old: { status: l.status, comment: l.comment }, new: { status: 'pending' } });
  await notify(db, e.user?.id, { type: 'decision_undone', text: `The decision on your ${what(l)} was taken back. It is pending again.`, link: '/me/leave' });
  return recomputeLeaveDays(db, l);
}

export async function reverseLeave(db: Db, actor: Actor, l: LeaveFull, comment: string): Promise<Changed> {
  const e = l.employee;
  if (actor.role !== 'admin') fail(403, 'Only the admin can reverse a decision.');
  if (l.status !== 'approved' && l.status !== 'rejected') fail(409, 'Only a decided request can be reversed.');
  if (!comment) fail(422, 'Write why the decision is being reversed.');
  await assertOpen(db, e.officeId, datesOf(l));
  const next = l.status === 'approved' ? 'rejected' : 'approved';
  if (next === 'approved') {
    // Another leave may have been approved on these dates in the meantime.
    const clash = await db.leaveRequest.findFirst({ where: { employeeId: e.id, id: { not: l.id }, status: { in: ['pending', 'approved'] }, fromDate: { lte: l.toDate }, toDate: { gte: l.fromDate } } });
    if (clash) fail(409, `${e.name} already has other leave on these dates.`);
    await charge(db, l, actor.userId);
  } else await refund(db, l, actor.userId);
  await db.leaveRequest.update({ where: { id: l.id }, data: { status: next, decidedById: actor.userId, decidedAt: now(), comment } });
  await audit(db, actor, { action: 'Decision reversed', entity: 'leave_request', entityId: l.id, officeId: e.officeId, detail: `${e.name}, ${what(l)}: ${l.status} changed to ${next}. Reason: ${comment}`, old: { status: l.status, decidedById: l.decidedById, comment: l.comment }, new: { status: next, comment } });
  await notify(db, e.user?.id, { type: 'request_decided', text: `Your ${what(l)} is now ${next}: ${comment}`, link: '/me/leave' });
  if (l.decidedById && l.decidedById !== actor.userId) await notify(db, l.decidedById, { type: 'decision_reversed', text: `The admin changed your decision on ${e.name}'s ${what(l)} to ${next}: ${comment}`, link: '/leave' });
  return recomputeLeaveDays(db, l);
}

/** The employee withdraws a pending request, or brings back one they just withdrew. */
export async function cancelLeave(db: Db, actor: Actor, l: LeaveFull, restore: boolean): Promise<void> {
  if (l.employeeId !== actor.employeeId) fail(403, 'This is not your request.');
  const from = restore ? 'cancelled' : 'pending'; const to = restore ? 'pending' : 'cancelled';
  if (l.status === 'approved') fail(409, 'This leave is approved. Ask your office head to cancel it.');
  if (l.status !== from || (restore && l.decidedById)) fail(409, restore ? 'This request cannot be restored.' : 'Only a pending request can be cancelled.');
  if (restore) {
    const v = await previewLeave(db, l.employee, { type: l.type, from: ymdFromDb(l.fromDate), to: ymdFromDb(l.toDate), halfDay: l.halfDay });
    if (!v.ok) fail(409, v.message ?? 'This request cannot be restored.');
  }
  await db.leaveRequest.update({ where: { id: l.id }, data: { status: to } });
  await audit(db, actor, { action: restore ? 'Request restored' : 'Request cancelled', entity: 'leave_request', entityId: l.id, officeId: l.employee.officeId, detail: `${l.employee.name}, ${what(l)}`, old: { status: from }, new: { status: to } });
}

/** Cancelling leave that is already approved needs the office head (or the admin). The days go back to the balance. */
export async function cancelApprovedLeave(db: Db, actor: Actor, l: LeaveFull, comment: string): Promise<Changed> {
  const e = l.employee;
  if (!canManage(actor, e)) fail(403, actor.employeeId === e.id ? 'Ask the admin to cancel your approved leave.' : 'You cannot cancel this leave.');
  if (l.status !== 'approved') fail(409, 'Only approved leave can be cancelled this way.');
  await assertOpen(db, e.officeId, datesOf(l));
  await db.leaveRequest.update({ where: { id: l.id }, data: { status: 'cancelled', decidedById: actor.userId, decidedAt: now(), comment: comment || l.comment } });
  await refund(db, l, actor.userId);
  await audit(db, actor, { action: 'Approved leave cancelled', entity: 'leave_request', entityId: l.id, officeId: e.officeId, detail: `${e.name}, ${what(l)}${comment ? `. Reason: ${comment}` : ''}`, old: { status: 'approved' }, new: { status: 'cancelled', comment: comment || null } });
  await notify(db, e.user?.id, { type: 'leave_cancelled', text: `Your approved ${what(l)} was cancelled${l.type === 'UNPAID' ? '' : `. ${fmtDays(Number(l.days))} went back to your ${l.type} balance`}`, link: '/me/leave' });
  return recomputeLeaveDays(db, l);
}

/** A manual change to a balance (an opening balance, a correction). It is a ledger row like any other. */
export async function adjustBalance(db: Db, actor: Actor, e: { id: string; name: string; code: string; officeId: string; user?: { id: string } | null }, type: PaidType, days: number, note: string): Promise<void> {
  const sums = await ledgerSums(db, e.id);
  if (round2(sums[type] + days) < 0) fail(422, `${e.name} has ${fmtDays(sums[type])} of ${type}. The balance cannot go below zero.`);
  await addLedger(db, e.id, type, days, 'adjustment', note, today(), actor.userId);
  await audit(db, actor, { action: 'Leave balance adjusted', entity: 'leave_ledger', entityId: e.id, officeId: e.officeId, detail: `${e.name} (${e.code}): ${type} ${days > 0 ? '+' : ''}${days}. ${note}`, old: { [type]: sums[type] }, new: { [type]: round2(sums[type] + days) } });
  await notify(db, e.user?.id, { type: 'balance_adjusted', text: `Your ${type} balance was changed by ${days > 0 ? '+' : ''}${days}: ${note}`, link: '/me/leave' });
}

// ---------- scheduled work ----------
/** Leave is credited from the first full month after joining. Joining on the 1st makes that month a full month. */
export function creditFromMonth(joinDate: Ymd): Month {
  return joinDate.endsWith('-01') ? monthOf(joinDate) : addMonths(monthOf(joinDate), 1);
}
/** The share of a yearly quota credited in month number n (1 to 12). The twelve shares add up to the quota exactly. */
export function monthlyShare(quota: number, n: number): number {
  return round2(round2((quota * n) / 12) - round2((quota * (n - 1)) / 12));
}

/** The quota row for a year. A new year starts with last year's quota, or the defaults. */
export async function ensureQuota(db: Db, employeeId: string, year: number) {
  const found = await db.leaveQuota.findUnique({ where: { employeeId_year: { employeeId, year } } });
  if (found) return found;
  const prev = await db.leaveQuota.findFirst({ where: { employeeId, year: { lt: year } }, orderBy: { year: 'desc' } });
  const s = await getSettings(db);
  return db.leaveQuota.create({ data: { employeeId, year, clPerYear: prev?.clPerYear ?? s.defaultClQuota, plPerYear: prev?.plPerYear ?? s.defaultPlQuota } });
}

/**
 * Monthly credit: quota / 12 for CL and PL, dated the 1st of the month.
 * Run every night. Each credit has a unique key, so it is written once, and months missed
 * while the server was down (or for someone added late) are caught up, within the leave year.
 */
export async function creditLeave(db: Db, upToMonth: Month): Promise<number> {
  const year = Number(upToMonth.slice(0, 4));
  const first = `${upToMonth}-01`;
  const emps = await db.employee.findMany({ where: { status: { not: 'inactive' }, joiningDate: { lte: dbDate(first) } }, select: { id: true, joiningDate: true, lastWorkingDate: true } });
  let written = 0;
  for (const e of emps) {
    const from = creditFromMonth(ymdFromDb(e.joiningDate));
    const start = from > `${year}-01` ? from : `${year}-01`;
    if (start > upToMonth) continue;
    const quota = await ensureQuota(db, e.id, year);
    const have = new Set((await db.leaveLedger.findMany({ where: { employeeId: e.id, uniqueKey: { startsWith: `credit:${e.id}:` } }, select: { uniqueKey: true } })).map(r => r.uniqueKey));
    for (let m = start; m <= upToMonth; m = addMonths(m, 1)) {
      if (e.lastWorkingDate && ymdFromDb(e.lastWorkingDate) < `${m}-01`) break; // no credit after leaving
      const n = Number(m.slice(5, 7));
      for (const [type, perYear] of [['CL', Number(quota.clPerYear)], ['PL', Number(quota.plPerYear)]] as const) {
        const key = `credit:${e.id}:${type}:${m}`;
        const share = monthlyShare(perYear, n);
        if (have.has(key) || share === 0) continue;
        await addLedger(db, e.id, type, share, 'credit', m, `${m}-01`, null, key);
        written++;
      }
    }
  }
  return written;
}

/**
 * Year end, dated 31 December: CL goes back to 0, PL above the carry cap is written off.
 * Uses the balance as it stood on 31 December, so it gives the same result whenever it runs.
 */
export async function closeLeaveYear(db: Db, year: number): Promise<number> {
  const { plCarryMax } = await getSettings(db);
  const end = `${year}-12-31`;
  const emps = await db.employee.findMany({ where: { joiningDate: { lte: dbDate(end) } }, select: { id: true } });
  let written = 0;
  for (const e of emps) {
    const done = new Set((await db.leaveLedger.findMany({ where: { employeeId: e.id, uniqueKey: { startsWith: `yearend:${e.id}:` } }, select: { uniqueKey: true } })).map(r => r.uniqueKey));
    const sums = await ledgerSums(db, e.id, end);
    const clKey = `yearend:${e.id}:CL:${year}`; const plKey = `yearend:${e.id}:PL:${year}`;
    if (!done.has(clKey) && sums.CL > 0) { await addLedger(db, e.id, 'CL', -sums.CL, 'lapse', String(year), end, null, clKey); written++; }
    if (!done.has(plKey) && sums.PL > plCarryMax) { await addLedger(db, e.id, 'PL', -round2(sums.PL - plCarryMax), 'carry_cap', String(year), end, null, plKey); written++; }
  }
  return written;
}

/**
 * A request that the office head has not decided within N working days of that office is marked
 * escalated and also shown to the admin. Either of them can still decide it.
 */
export async function escalateRequests(db: Db): Promise<number> {
  const { escalateAfterWorkingDays } = await getSettings(db);
  const t = today();
  const [leaves, corrections] = await Promise.all([
    db.leaveRequest.findMany({ where: { status: 'pending', escalatedAt: null }, include: leaveInclude }),
    db.correctionRequest.findMany({ where: { status: 'pending', escalatedAt: null }, include: { employee: { select: { id: true, name: true, officeId: true, office: { select: { headEmployeeId: true } } } } } }),
  ]);
  const items = [
    ...leaves.map(l => ({ kind: 'leave' as const, id: l.id, createdAt: l.createdAt, e: l.employee, text: what(l), link: '/leave' })),
    ...corrections.map(c => ({ kind: 'correction' as const, id: c.id, createdAt: c.createdAt, e: c.employee, text: `correction for ${fmtDate(ymdFromDb(c.date))}`, link: '/attendance/corrections' })),
  ].filter(x => x.e.office.headEmployeeId && x.e.office.headEmployeeId !== x.e.id); // a head's own request is with the admin already
  if (!items.length) return 0;
  const from = items.reduce((min, x) => (ymd(x.createdAt) < min ? ymd(x.createdAt) : min), t);
  const calendars = await loadCalendars(db, [...new Set(items.map(x => x.e.officeId))], from, t);
  const admins = await adminUserIds(db);
  let n = 0;
  for (const x of items) {
    if (workingDaysElapsed(ymd(x.createdAt), t, calendars.get(x.e.officeId)!) < escalateAfterWorkingDays) continue;
    if (x.kind === 'leave') await db.leaveRequest.update({ where: { id: x.id }, data: { escalatedAt: now() } });
    else await db.correctionRequest.update({ where: { id: x.id }, data: { escalatedAt: now() } });
    await audit(db, null, { action: 'Request escalated', entity: `${x.kind}_request`, entityId: x.id, officeId: x.e.officeId, detail: `${x.e.name}, ${x.text}: no decision after ${escalateAfterWorkingDays} working days` });
    for (const a of admins) await notify(db, a, { type: 'request_escalated', text: `${x.e.name}'s ${x.text} has waited ${escalateAfterWorkingDays} working days for a decision`, link: x.link });
    n++;
  }
  return n;
}
function ymd(d: Date): Ymd { return localDateTime(d).slice(0, 10); }
