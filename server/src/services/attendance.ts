// Loads what the rules need, runs them, and keeps attendance_days up to date.
//
// Open months are always computed from their inputs (punches, corrections, leave, calendar), so a
// figure on screen can never be stale. attendance_days holds the stored result: it is rewritten when
// an input changes, finalized every night at 23:55, and frozen for good when the month is locked.
// A locked month is read from attendance_days only and is never recomputed.
import { Prisma, type Db } from '../db';
import { publish } from '../lib/live';
import { notify, adminUserIds, headUserId } from '../lib/notify';
import { addDays, dateRange, dbDate, hhmmOf, istToUtc, monthDays, monthOf, now, secondsOfDay, today, ymdFromDb, ymdOf, type Month, type Ymd } from '../lib/time';
import { dayKind, loadCalendars } from './calendar';
import { classifyDay, countDays, type DayResult, type OfficeRules } from './day-rules';

/** The 23:55 job closes the day. After that, today is judged like a past day. */
export const FINALIZE_SEC = 23 * 3600 + 55 * 60;

export interface Emp { id: string; name: string; code: string; officeId: string; joiningDate: Date; lastWorkingDate: Date | null; terminalUserId: string | null; }
export const empSelect = { id: true, name: true, code: true, officeId: true, joiningDate: true, lastWorkingDate: true, terminalUserId: true } satisfies Prisma.EmployeeSelect;

const toSec = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 3600 + m * 60; };
const toMin = (hhmm: string | null) => (hhmm === null ? null : toSec(hhmm) / 60);
export const rulesOf = (o: { startTime: string; fullDayHours: Prisma.Decimal | number; minHalfDayHours: Prisma.Decimal | number }): OfficeRules =>
  ({ startSec: toSec(o.startTime), fullDayMin: Math.round(Number(o.fullDayHours) * 60), halfDayMin: Math.round(Number(o.minHalfDayHours) * 60) });

/** Employees who were employed on at least one day of the span and are not switched off without an end date. */
export function employedWhere(from: Ymd, to: Ymd): Prisma.EmployeeWhereInput {
  return {
    joiningDate: { lte: dbDate(to) },
    OR: [{ lastWorkingDate: { gte: dbDate(from) } }, { lastWorkingDate: null, status: { not: 'inactive' } }],
  };
}

export interface ComputeOptions {
  /** Judge today as if it were over. Used when storing a row and by the 23:55 job. */
  closeToday?: boolean;
  /** Compute even a locked month from its inputs (used when the lock itself takes its snapshot). */
  ignoreLock?: boolean;
}

/** Every date from `from` to `to` for each employee. Locked months come from attendance_days. */
export async function computeDays(db: Db, emps: Emp[], from: Ymd, to: Ymd, opts: ComputeOptions = {}): Promise<Map<string, DayResult[]>> {
  const out = new Map<string, DayResult[]>(emps.map(e => [e.id, []]));
  if (!emps.length || from > to) return out;
  const officeIds = [...new Set(emps.map(e => e.officeId))];
  const empIds = emps.map(e => e.id);
  const tuids = emps.map(e => e.terminalUserId).filter((x): x is string => !!x);
  const months = [...new Set(dateRange(from, to).map(monthOf))];

  const [offices, calendars, locks, punches, corrections, leaves] = await Promise.all([
    db.office.findMany({ where: { id: { in: officeIds } } }),
    loadCalendars(db, officeIds, from, to),
    opts.ignoreLock ? [] : db.payrollRun.findMany({ where: { officeId: { in: officeIds }, month: { in: months }, status: 'locked' }, select: { officeId: true, month: true } }),
    db.rawPunch.findMany({
      where: { terminalUserId: { in: tuids }, punchTime: { gte: istToUtc(from), lt: istToUtc(addDays(to, 1)) } },
      select: { terminalUserId: true, punchTime: true, device: { select: { officeId: true } } },
    }),
    // Several corrections may have been approved for one day. The one decided last is the one that counts.
    db.correctionRequest.findMany({ where: { employeeId: { in: empIds }, status: 'approved', date: { gte: dbDate(from), lte: dbDate(to) } }, orderBy: { decidedAt: 'asc' } }),
    db.leaveRequest.findMany({ where: { employeeId: { in: empIds }, status: 'approved', fromDate: { lte: dbDate(to) }, toDate: { gte: dbDate(from) } } }),
  ]);
  const rules = new Map(offices.map(o => [o.id, rulesOf(o)]));
  const locked = new Set(locks.map(l => `${l.officeId}|${l.month}`));
  const punchMap = new Map<string, { sec: number; officeId: string }[]>();
  for (const p of punches) {
    const k = `${p.terminalUserId}|${ymdOf(p.punchTime)}`;
    const item = { sec: secondsOfDay(p.punchTime), officeId: p.device.officeId };
    const list = punchMap.get(k); if (list) list.push(item); else punchMap.set(k, [item]);
  }
  const corrMap = new Map(corrections.map(c => [`${c.employeeId}|${ymdFromDb(c.date)}`, c]));

  // Stored rows of locked months.
  const stored = new Map<string, DayResult>();
  if (locked.size) {
    const rows = await db.attendanceDay.findMany({ where: { employeeId: { in: empIds }, date: { gte: dbDate(from), lte: dbDate(to) } } });
    for (const r of rows) stored.set(`${r.employeeId}|${ymdFromDb(r.date)}`, fromRow(r));
  }

  const t = now(); const todayYmd = ymdOf(t); const nowSec = secondsOfDay(t);
  for (const e of emps) {
    const days = out.get(e.id)!;
    const joinDate = ymdFromDb(e.joiningDate); const lastWorkingDate = e.lastWorkingDate ? ymdFromDb(e.lastWorkingDate) : null;
    const myLeaves = leaves.filter(l => l.employeeId === e.id);
    for (const date of dateRange(from, to)) {
      if (locked.has(`${e.officeId}|${monthOf(date)}`)) {
        const kept = stored.get(`${e.id}|${date}`);
        // A locked month has a row for every employed date. Dates outside employment are not stored.
        days.push(kept ?? classifyDay({ date, today: todayYmd, nowSec, kind: { kind: 'off' }, rules: rules.get(e.officeId)!, joinDate, lastWorkingDate, homeOfficeId: e.officeId, punches: [] }));
        continue;
      }
      const c = corrMap.get(`${e.id}|${date}`);
      const l = myLeaves.find(x => ymdFromDb(x.fromDate) <= date && date <= ymdFromDb(x.toDate));
      days.push(classifyDay({
        date, today: todayYmd, nowSec, todayClosed: opts.closeToday || nowSec >= FINALIZE_SEC,
        kind: dayKind(date, calendars.get(e.officeId)!), rules: rules.get(e.officeId)!, joinDate, lastWorkingDate, homeOfficeId: e.officeId,
        punches: e.terminalUserId ? punchMap.get(`${e.terminalUserId}|${date}`) ?? [] : [],
        correction: c ? { id: c.id, inMin: toMin(c.claimedIn), outMin: toMin(c.claimedOut) } : null,
        leave: l ? { type: l.type, half: l.halfDay } : null,
      }));
    }
  }
  return out;
}

export async function computeMonth(db: Db, emps: Emp[], month: Month, opts?: ComputeOptions) {
  const days = monthDays(month);
  return computeDays(db, emps, days[0], days[days.length - 1], opts);
}

// ---------- attendance_days ----------
type Row = Prisma.AttendanceDayGetPayload<object>;
function fromRow(r: Row): DayResult {
  const f = r.flags as Partial<DayResult>;
  const paid = Number(r.paidFraction);
  return {
    date: ymdFromDb(r.date), engine: r.status, paidFraction: paid, closed: true, status: f.status ?? 'present', label: f.label ?? '',
    inTime: r.checkIn ? hhmmOf(r.checkIn) : null, outTime: r.checkOut ? hhmmOf(r.checkOut) : null, workedMin: f.workedMin ?? 0,
    unpaid: 1 - paid, late: !!f.late, manual: r.isManual, correctionId: f.correctionId ?? null, otherOfficeId: f.otherOfficeId ?? null,
    leaveType: f.leaveType, halfLeave: f.halfLeave, holidayName: f.holidayName,
  };
}

function rowData(d: DayResult, finalized: boolean) {
  return {
      checkIn: d.inTime ? istToUtc(d.date, d.inTime) : null, checkOut: d.outTime ? istToUtc(d.date, d.outTime) : null,
      hours: Math.round((d.workedMin / 60) * 100) / 100, status: d.engine!, paidFraction: d.paidFraction!, isManual: d.manual, finalized, computedAt: now(),
      flags: {
        status: d.status, label: d.label, workedMin: d.workedMin, late: d.late, correctionId: d.correctionId, otherOfficeId: d.otherOfficeId,
        otherOffice: !!d.otherOfficeId, leaveType: d.leaveType ?? null, halfLeave: d.halfLeave ?? false, holidayName: d.holidayName ?? null,
      },
  };
}

/** Writes results to attendance_days. Dates with nothing to store (future, outside employment) are removed. */
export async function storeDays(db: Db, employeeId: string, days: DayResult[], finalized: boolean): Promise<void> {
  for (const d of days) {
    const key = { employeeId_date: { employeeId, date: dbDate(d.date) } };
    if (d.engine === null || d.paidFraction === null) { await db.attendanceDay.deleteMany({ where: { employeeId, date: dbDate(d.date) } }); continue; }
    const data = rowData(d, finalized);
    await db.attendanceDay.upsert({ where: key, create: { employeeId, date: dbDate(d.date), ...data }, update: data });
  }
}

/** Replaces every stored day of a span for several people at once. Used when a month is locked. */
export async function freezeDays(db: Db, days: Map<string, DayResult[]>, from: Ymd, to: Ymd): Promise<void> {
  const ids = [...days.keys()];
  await db.attendanceDay.deleteMany({ where: { employeeId: { in: ids }, date: { gte: dbDate(from), lte: dbDate(to) } } });
  const data = ids.flatMap(employeeId => days.get(employeeId)!
    .filter(d => d.engine !== null && d.paidFraction !== null)
    .map(d => ({ employeeId, date: dbDate(d.date), ...rowData(d, true), status: d.engine!, paidFraction: d.paidFraction! })));
  if (data.length) await db.attendanceDay.createMany({ data });
}

/**
 * Recomputes and stores one employee's day. Called after a new punch, an approved correction,
 * a leave decision and a holiday or override change. Does nothing in a locked month.
 * Returns the office to tell, or null when nothing was done. Call `announceDay` after the transaction commits.
 */
export async function recomputeDay(db: Db, employeeId: string, date: Ymd): Promise<{ officeId: string; employeeId: string; date: Ymd } | null> {
  const e = await db.employee.findUnique({ where: { id: employeeId }, select: empSelect });
  if (!e) return null;
  const run = await db.payrollRun.findUnique({ where: { officeId_month: { officeId: e.officeId, month: monthOf(date) } }, select: { status: true } });
  if (run?.status === 'locked') return null; // never recompute a locked month
  const days = (await computeDays(db, [e], date, date, { closeToday: true })).get(e.id)!;
  const finalized = date < today() || secondsOfDay(now()) >= FINALIZE_SEC;
  await storeDays(db, e.id, days, finalized);
  return { officeId: e.officeId, employeeId, date };
}
export function announceDay(d: { officeId: string; employeeId: string; date: Ymd } | null) {
  if (d) publish({ type: 'day', officeIds: [d.officeId], data: { employeeId: d.employeeId, date: d.date } });
}

/** A holiday or override changed: recompute that date for everyone in the office. */
export async function recomputeOfficeDate(db: Db, officeId: string, date: Ymd): Promise<void> {
  const emps = await db.employee.findMany({ where: { officeId, ...employedWhere(date, date) }, select: { id: true } });
  for (const e of emps) await recomputeDay(db, e.id, date);
}

/** The 23:55 job: store the final result of the day for everyone. */
export async function finalizeDay(db: Db, date: Ymd): Promise<number> {
  const emps = await db.employee.findMany({ where: employedWhere(date, date), select: empSelect });
  const locked = await db.payrollRun.findMany({ where: { month: monthOf(date), status: 'locked' }, select: { officeId: true } });
  const open = emps.filter(e => !locked.some(l => l.officeId === e.officeId));
  const days = await computeDays(db, open, date, date, { closeToday: true });
  for (const e of open) await storeDays(db, e.id, days.get(e.id)!, true);
  return open.length;
}

/** Nightly: a terminal that has been silent for over 12 hours on a working day. Tells the office head and the admin, once a day. */
export async function alertSilentTerminals(db: Db): Promise<number> {
  const t = now(); const date = ymdOf(t);
  const devices = await db.device.findMany({ include: { office: { select: { name: true } } } });
  const calendars = await loadCalendars(db, [...new Set(devices.map(d => d.officeId))], date, date);
  let alerts = 0;
  for (const d of devices) {
    if (dayKind(date, calendars.get(d.officeId)!).kind !== 'working') continue;
    if (d.lastSeenAt && t.getTime() - d.lastSeenAt.getTime() <= 12 * 3600 * 1000) continue;
    if (d.silentAlertAt && ymdOf(d.silentAlertAt) === date) continue;
    const text = `${d.name} at ${d.office.name} has not been heard from for over 12 hours. Check its power and network.`;
    const to = new Set([await headUserId(db, d.officeId), ...(await adminUserIds(db))]);
    for (const userId of to) await notify(db, userId, { type: 'terminal_silent', text, link: '/attendance/terminals' });
    await db.device.update({ where: { id: d.id }, data: { silentAlertAt: t } });
    alerts++;
  }
  return alerts;
}

// ---------- shapes for the app ----------
export interface DayView {
  date: Ymd; status: DayResult['status']; label: string; inTime: string | null; outTime: string | null; workedMin: number;
  unpaid: number; late: boolean; manual: boolean; otherOffice: string | null; leaveType?: string; halfLeave?: boolean; holidayName?: string;
}
export function toView(d: DayResult, officeNames: Map<string, string>): DayView {
  return {
    date: d.date, status: d.status, label: d.label, inTime: d.inTime, outTime: d.outTime, workedMin: d.workedMin, unpaid: d.unpaid, late: d.late,
    manual: d.manual, otherOffice: d.otherOfficeId ? officeNames.get(d.otherOfficeId) ?? 'Another office' : null,
    leaveType: d.leaveType, halfLeave: d.halfLeave, holidayName: d.holidayName,
  };
}
export async function officeNameMap(db: Db): Promise<Map<string, string>> {
  return new Map((await db.office.findMany({ select: { id: true, name: true } })).map(o => [o.id, o.name]));
}
export { countDays };
