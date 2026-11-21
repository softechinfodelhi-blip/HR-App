// Requests and their decisions: the shared row shape, and attendance corrections. Leave is in leave.ts.
import { Prisma, type Db } from '../db';
import { audit } from '../lib/audit';
import { fail } from '../lib/errors';
import { adminUserIds, headUserId, notify } from '../lib/notify';
import { dbDate, fmtDate, localDateTime, now, today, ymdFromDb, type Ymd } from '../lib/time';
import { recomputeDay } from './attendance';
import { assertOpen } from './locks';
import { type Actor, canManage } from './permissions';

/** The person who decided may take it back for this long. */
export const UNDO_MS = 60_000;

export interface RequestRow {
  id: string; kind: 'leave' | 'correction'; employeeId: string; employeeName: string; employeeCode: string; officeId: string; officeName: string;
  title: string; detail: string; reason: string; status: 'pending' | 'approved' | 'rejected' | 'cancelled'; createdAt: string;
  escalated: boolean; fromHead: boolean; canAct: boolean; decidedByName?: string; decidedAt?: string; comment?: string; dates: Ymd[];
  /** A correction a manager entered directly, without a request from the employee. */
  direct?: boolean;
  /** Present on corrections. */
  inTime?: string | null; outTime?: string | null;
  /** Present on leave. */
  leaveType?: 'CL' | 'PL' | 'UNPAID'; from?: Ymd; to?: Ymd; halfDay?: 'none' | 'first' | 'second'; half?: boolean; days?: number;
  /** Approved leave this person may cancel. */
  canCancelApproved?: boolean;
}

const clock = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
export const timesText = (inTime: string | null, outTime: string | null) => [inTime && `In ${clock(inTime)}`, outTime && `Out ${clock(outTime)}`].filter(Boolean).join(', ');

export const correctionInclude = { employee: { select: { id: true, name: true, code: true, officeId: true, office: { select: { name: true, headEmployeeId: true } }, user: { select: { id: true } } } } } satisfies Prisma.CorrectionRequestInclude;
export type CorrectionFull = Prisma.CorrectionRequestGetPayload<{ include: typeof correctionInclude }>;

/** Names for the "decided by" column. */
export async function userNames(db: Db, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return new Map();
  const users = await db.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true, employee: { select: { name: true } } } });
  return new Map(users.map(u => [u.id, u.employee?.name ?? u.name]));
}

export function correctionRow(c: CorrectionFull, actor: Actor, names: Map<string, string>): RequestRow {
  const e = c.employee; const date = ymdFromDb(c.date);
  return {
    id: c.id, kind: 'correction', employeeId: e.id, employeeName: e.name, employeeCode: e.code, officeId: e.officeId, officeName: e.office.name,
    title: `Correction · ${fmtDate(date)}`, detail: timesText(c.claimedIn, c.claimedOut), reason: c.reason, status: c.status, createdAt: localDateTime(c.createdAt),
    escalated: c.status === 'pending' && !!c.escalatedAt, fromHead: e.office.headEmployeeId === e.id,
    // Nobody decides their own request: a head's own request can only be decided by the admin.
    canAct: c.status === 'pending' && canManage(actor, e),
    decidedByName: (c.decidedById && names.get(c.decidedById)) || undefined, decidedAt: c.decidedAt ? localDateTime(c.decidedAt) : undefined,
    comment: c.comment ?? undefined, dates: [date], direct: !!c.createdById && c.createdById === c.decidedById && c.createdById !== e.user?.id,
    inTime: c.claimedIn, outTime: c.claimedOut,
  };
}

/** Who decides: the office head. For a head's own request, or an office without a head, the admin. */
export async function approverUserIds(db: Db, e: { id: string; officeId: string; office: { headEmployeeId: string | null } }): Promise<string[]> {
  if (e.office.headEmployeeId && e.office.headEmployeeId !== e.id) { const head = await headUserId(db, e.officeId); if (head) return [head]; }
  return adminUserIds(db);
}

export interface TimesInput { inTime: string | null; outTime: string | null; reason: string; }
function checkTimes(t: TimesInput) {
  if (!t.inTime && !t.outTime) fail(422, 'Enter an in time or an out time.');
  if (t.inTime && t.outTime && t.outTime <= t.inTime) fail(422, 'The out time must be after the in time.');
}
async function checkDate(db: Db, e: { officeId: string; joiningDate: Date; lastWorkingDate: Date | null }, date: Ymd) {
  if (date > today()) fail(422, 'Only today or a past day can be corrected.');
  if (date < ymdFromDb(e.joiningDate) || (e.lastWorkingDate && date > ymdFromDb(e.lastWorkingDate))) fail(422, 'This date is outside the time the person worked here.');
  await assertOpen(db, e.officeId, [date]);
}

/** An employee (or a head, for themselves) asks for a day to be corrected. */
export async function requestCorrection(db: Db, actor: Actor, input: TimesInput & { date: Ymd }): Promise<CorrectionFull> {
  if (!actor.employeeId) fail(403, 'The admin account has no attendance.');
  checkTimes(input);
  const e = await db.employee.findUniqueOrThrow({ where: { id: actor.employeeId }, include: { office: { select: { headEmployeeId: true } } } });
  await checkDate(db, e, input.date);
  if (await db.correctionRequest.count({ where: { employeeId: e.id, date: dbDate(input.date), status: 'pending' } })) fail(409, 'You already have a request waiting for this day.');
  const c = await db.correctionRequest.create({
    data: { employeeId: e.id, date: dbDate(input.date), claimedIn: input.inTime, claimedOut: input.outTime, reason: input.reason, createdById: actor.userId, createdAt: now() },
    include: correctionInclude,
  });
  await audit(db, actor, { action: 'Correction requested', entity: 'correction_request', entityId: c.id, officeId: e.officeId, detail: `${e.name}, ${fmtDate(input.date)}. ${timesText(input.inTime, input.outTime)}`, new: { date: input.date, inTime: input.inTime, outTime: input.outTime, reason: input.reason } });
  for (const to of await approverUserIds(db, e)) await notify(db, to, { type: 'correction_requested', text: `${e.name} asked to correct ${fmtDate(input.date)}`, link: '/attendance/corrections' });
  return c;
}

/** A manager enters the time directly. It is stored as a correction they approved, so who and when is on record. */
export async function correctDirectly(db: Db, actor: Actor, employeeId: string, date: Ymd, input: TimesInput) {
  checkTimes(input);
  const e = (await db.employee.findUnique({ where: { id: employeeId }, include: { user: { select: { id: true } } } })) ?? fail(404, 'Employee was not found.');
  if (!canManage(actor, e)) fail(403, actor.employeeId === e.id ? 'You cannot correct your own attendance. Send a correction request to the admin.' : 'You cannot correct this day.');
  await checkDate(db, e, date);
  const t = now();
  const c = await db.correctionRequest.create({
    data: { employeeId: e.id, date: dbDate(date), claimedIn: input.inTime, claimedOut: input.outTime, reason: input.reason, status: 'approved', createdById: actor.userId, decidedById: actor.userId, decidedAt: t, createdAt: t },
  });
  await audit(db, actor, { action: 'Attendance corrected', entity: 'correction_request', entityId: c.id, officeId: e.officeId, detail: `${e.name}, ${fmtDate(date)}. ${timesText(input.inTime, input.outTime)}. Reason: ${input.reason}`, new: { date, inTime: input.inTime, outTime: input.outTime, reason: input.reason } });
  await notify(db, e.user?.id, { type: 'day_corrected', text: `Your attendance for ${fmtDate(date)} was corrected by ${actor.name}`, link: '/me/attendance' });
  return recomputeDay(db, e.id, date);
}

export async function loadCorrection(db: Db, id: string): Promise<CorrectionFull | null> {
  return db.correctionRequest.findUnique({ where: { id }, include: correctionInclude });
}
const what = (c: CorrectionFull) => `correction for ${fmtDate(ymdFromDb(c.date))}`;

export async function decideCorrection(db: Db, actor: Actor, c: CorrectionFull, decision: 'approved' | 'rejected', comment: string) {
  const e = c.employee;
  if (!canManage(actor, e)) fail(403, actor.employeeId === e.id ? 'The admin decides your own requests.' : 'You cannot decide this request.');
  if (c.status !== 'pending') fail(409, 'This request has already been decided.');
  if (decision === 'rejected' && !comment) fail(422, 'Write a reason. The employee will see it.');
  const date = ymdFromDb(c.date);
  await assertOpen(db, e.officeId, [date]);
  // The status is checked again in the update itself, so two people cannot decide the same request.
  const done = await db.correctionRequest.updateMany({ where: { id: c.id, status: 'pending' }, data: { status: decision, decidedById: actor.userId, decidedAt: now(), comment: comment || null } });
  if (done.count !== 1) fail(409, 'This request has already been decided.');
  await audit(db, actor, { action: `Correction ${decision}`, entity: 'correction_request', entityId: c.id, officeId: e.officeId, detail: `${e.name}, ${what(c)}${comment ? `. Reason: ${comment}` : ''}`, old: { status: 'pending' }, new: { status: decision, comment: comment || null } });
  await notify(db, e.user?.id, { type: 'request_decided', text: `Your ${what(c)} was ${decision}${comment ? `: ${comment}` : ''}`, link: '/me/attendance' });
  return recomputeDay(db, e.id, date);
}

/** Within 60 seconds, the person who decided can put the request back to pending. */
export async function undoCorrection(db: Db, actor: Actor, c: CorrectionFull) {
  const e = c.employee;
  if ((c.status !== 'approved' && c.status !== 'rejected') || c.decidedById !== actor.userId || !c.decidedAt || now().getTime() - c.decidedAt.getTime() > UNDO_MS) {
    fail(409, 'It is too late to undo this.');
  }
  const date = ymdFromDb(c.date);
  await assertOpen(db, e.officeId, [date]);
  await db.correctionRequest.update({ where: { id: c.id }, data: { status: 'pending', decidedById: null, decidedAt: null, comment: null } });
  await audit(db, actor, { action: 'Decision undone', entity: 'correction_request', entityId: c.id, officeId: e.officeId, detail: `${e.name}, ${what(c)} is pending again`, old: { status: c.status, comment: c.comment }, new: { status: 'pending' } });
  await notify(db, e.user?.id, { type: 'decision_undone', text: `The decision on your ${what(c)} was taken back. It is pending again.`, link: '/me/attendance' });
  return recomputeDay(db, e.id, date);
}

/** The admin can turn any decision around until the month is locked. */
export async function reverseCorrection(db: Db, actor: Actor, c: CorrectionFull, comment: string) {
  const e = c.employee;
  if (actor.role !== 'admin') fail(403, 'Only the admin can reverse a decision.');
  if (c.status !== 'approved' && c.status !== 'rejected') fail(409, 'Only a decided request can be reversed.');
  if (!comment) fail(422, 'Write why the decision is being reversed.');
  const date = ymdFromDb(c.date);
  await assertOpen(db, e.officeId, [date]);
  const next = c.status === 'approved' ? 'rejected' : 'approved';
  await db.correctionRequest.update({ where: { id: c.id }, data: { status: next, decidedById: actor.userId, decidedAt: now(), comment } });
  await audit(db, actor, { action: 'Decision reversed', entity: 'correction_request', entityId: c.id, officeId: e.officeId, detail: `${e.name}, ${what(c)}: ${c.status} changed to ${next}. Reason: ${comment}`, old: { status: c.status, decidedById: c.decidedById, comment: c.comment }, new: { status: next, comment } });
  await notify(db, e.user?.id, { type: 'request_decided', text: `Your ${what(c)} is now ${next}: ${comment}`, link: '/me/attendance' });
  if (c.decidedById && c.decidedById !== actor.userId) await notify(db, c.decidedById, { type: 'decision_reversed', text: `The admin changed your decision on ${e.name}'s ${what(c)} to ${next}: ${comment}`, link: '/attendance/corrections' });
  return recomputeDay(db, e.id, date);
}

/** The employee withdraws a pending request, or brings back one they just withdrew. */
export async function cancelCorrection(db: Db, actor: Actor, c: CorrectionFull, restore: boolean): Promise<void> {
  if (c.employeeId !== actor.employeeId) fail(403, 'This is not your request.');
  const from = restore ? 'cancelled' : 'pending'; const to = restore ? 'pending' : 'cancelled';
  if (c.status !== from) fail(409, restore ? 'This request cannot be restored.' : 'Only a pending request can be cancelled.');
  if (restore) {
    await assertOpen(db, c.employee.officeId, [ymdFromDb(c.date)]);
    if (await db.correctionRequest.count({ where: { employeeId: c.employeeId, date: c.date, status: 'pending' } })) fail(409, 'You already have a request waiting for this day.');
  }
  await db.correctionRequest.update({ where: { id: c.id }, data: { status: to } });
  await audit(db, actor, { action: restore ? 'Request restored' : 'Request cancelled', entity: 'correction_request', entityId: c.id, officeId: c.employee.officeId, detail: `${c.employee.name}, ${what(c)}`, old: { status: from }, new: { status: to } });
}
