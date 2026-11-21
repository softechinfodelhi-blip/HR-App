// The attendance rules for one employee on one date, as a pure function. No database, no clock.
// Everything the register, the payroll and the payslip show comes from classifyDay().
import type { Ymd } from '../lib/time';
import type { DayKind } from './calendar';

/** What is stored in attendance_days.status. */
export type EngineStatus = 'PRESENT' | 'HALF_DAY_LATE' | 'HALF_DAY_SHORT' | 'MISSING_PUNCH' | 'ABSENT' | 'ON_LEAVE' | 'OFF' | 'HOLIDAY';
/** What the screens show. Adds the states of a day that is not over yet, and dates outside employment. */
export type ViewStatus = 'present' | 'half_late' | 'half_short' | 'missing' | 'absent' | 'leave' | 'off' | 'holiday' | 'not_in' | 'working' | 'future' | 'not_joined';
export type LeaveType = 'CL' | 'PL' | 'UNPAID';
export type HalfDay = 'none' | 'first' | 'second';

export interface OfficeRules {
  /** Office start, seconds after midnight. A first punch up to 59 seconds later is still on time. */
  startSec: number;
  fullDayMin: number; // 9 h = 540
  halfDayMin: number; // 4.5 h = 270
}
/** Punches closer together than this are one punch (a double tap on the terminal). */
export const DOUBLE_TAP_SEC = 120;

export interface DayInput {
  date: Ymd;
  today: Ymd;
  /** Seconds after midnight right now. Only used when date = today. */
  nowSec: number;
  /** True once today has been finalized by the 23:55 job. Past dates are always closed. */
  todayClosed?: boolean;
  kind: DayKind;
  rules: OfficeRules;
  joinDate: Ymd;
  lastWorkingDate?: Ymd | null;
  homeOfficeId: string;
  /** Raw punches of the date: seconds after midnight, and the office of the terminal. Any order. */
  punches: { sec: number; officeId: string }[];
  /** The approved correction for the date, if any. It supplies the in time, the out time, or both. Minutes after midnight. */
  correction?: { id: string; inMin: number | null; outMin: number | null } | null;
  /** The approved leave covering the date, if any. */
  leave?: { type: LeaveType; half: HalfDay } | null;
}

export interface DayResult {
  date: Ymd;
  /** Null when there is nothing to store: a date in the future or outside employment. */
  engine: EngineStatus | null;
  /** 0, 0.5 or 1. Null together with `engine`. */
  paidFraction: number | null;
  /** False while the result may still change today. */
  closed: boolean;
  status: ViewStatus;
  label: string;
  inTime: string | null; // HH:mm
  outTime: string | null;
  workedMin: number;
  /** 1 - paidFraction on a working day. 1 for a calendar day outside employment. */
  unpaid: number;
  late: boolean;
  manual: boolean;
  correctionId: string | null;
  /** Office id of another office's terminal used that day. */
  otherOfficeId: string | null;
  leaveType?: LeaveType;
  halfLeave?: boolean;
  holidayName?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const clock = (min: number) => { const h = Math.floor(min / 60), m = min % 60; return `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`; };
const leaveName = (t: LeaveType) => (t === 'UNPAID' ? 'Unpaid leave' : t);
const hoursText = (min: number) => { const h = min / 60; return Number.isInteger(h) ? String(h) : h.toFixed(1); };

const ENGINE_VIEW: Record<EngineStatus, ViewStatus> = {
  PRESENT: 'present', HALF_DAY_LATE: 'half_late', HALF_DAY_SHORT: 'half_short', MISSING_PUNCH: 'missing',
  ABSENT: 'absent', ON_LEAVE: 'leave', OFF: 'off', HOLIDAY: 'holiday',
};
export const STATUS_LABEL: Record<ViewStatus, string> = {
  present: 'Present', half_late: 'Half day (late)', half_short: 'Half day (short hours)', missing: 'Missing punch',
  absent: 'Absent', leave: 'On leave', off: 'Weekly off', holiday: 'Holiday', not_in: 'Not yet in',
  working: 'In office', future: '', not_joined: 'Before joining',
};

/** Raw punches to the first and last punch of the day, with double taps merged. */
export function firstAndLast(punchSecs: number[]): { inSec: number | null; outSec: number | null } {
  const kept: number[] = [];
  for (const s of [...punchSecs].sort((a, b) => a - b)) if (!kept.length || s - kept[kept.length - 1] >= DOUBLE_TAP_SEC) kept.push(s);
  return { inSec: kept.length ? kept[0] : null, outSec: kept.length > 1 ? kept[kept.length - 1] : null };
}

export function classifyDay(a: DayInput): DayResult {
  const past = a.date < a.today;
  const isToday = a.date === a.today;
  const closed = past || (isToday && !!a.todayClosed);
  const base: DayResult = {
    date: a.date, engine: null, paidFraction: null, closed, status: 'future', label: '', inTime: null, outTime: null, workedMin: 0,
    unpaid: 0, late: false, manual: false, correctionId: null, otherOfficeId: null,
  };
  const done = (engine: EngineStatus, paid: number, extra: Partial<DayResult> = {}): DayResult => {
    const status = extra.status ?? ENGINE_VIEW[engine];
    return { ...base, engine, paidFraction: paid, unpaid: 1 - paid, status, label: STATUS_LABEL[status], ...extra };
  };

  // Outside employment: not a working day for this person. Payroll counts these as unpaid calendar days.
  if (a.date < a.joinDate) return { ...base, status: 'not_joined', label: 'Before joining', unpaid: 1 };
  if (a.lastWorkingDate && a.date > a.lastWorkingDate) return { ...base, status: 'not_joined', label: 'After last working day', unpaid: 1 };

  // First and last punch. Raw punches are never changed: an approved correction sits on top of them.
  const { inSec, outSec } = firstAndLast(a.punches.map(p => p.sec));
  let inMin = inSec === null ? null : Math.floor(inSec / 60);
  let outMin = outSec === null ? null : Math.floor(outSec / 60);
  let lateSec = inSec;
  if (a.correction) {
    base.manual = true; base.correctionId = a.correction.id;
    if (a.correction.inMin !== null) { inMin = a.correction.inMin; lateSec = inMin * 60; }
    if (a.correction.outMin !== null) outMin = a.correction.outMin;
  }
  base.inTime = inMin === null ? null : hhmm(inMin);
  base.outTime = outMin === null ? null : hhmm(outMin);
  // Hours = last minus first, to the minute. Breaks are not subtracted.
  base.workedMin = inMin !== null && outMin !== null ? Math.max(0, outMin - inMin) : 0;
  // 09:00:59 is on time, 09:01:00 is late.
  base.late = lateSec !== null && lateSec > a.rules.startSec + 59;
  base.otherOfficeId = a.punches.find(p => p.officeId !== a.homeOfficeId)?.officeId ?? null;

  // Weekly off or holiday: paid in full. Punches are still stored and shown.
  if (a.kind.kind === 'holiday') return done('HOLIDAY', 1, { label: a.kind.name || 'Holiday', holidayName: a.kind.name, late: false });
  if (a.kind.kind === 'off') return done('OFF', 1, { label: a.kind.name || 'Weekly off', late: false });

  // ---- a working day ----
  // 1. Approved full-day leave.
  if (a.leave && a.leave.half === 'none') {
    return done('ON_LEAVE', a.leave.type === 'UNPAID' ? 0 : 1, { label: `On leave (${leaveName(a.leave.type)})`, leaveType: a.leave.type, late: false });
  }
  const half = a.leave && a.leave.half !== 'none' ? a.leave : null;
  const halfExtra: Partial<DayResult> = half ? { leaveType: half.type, halfLeave: true } : {};

  if (!closed && !isToday) return { ...base, ...halfExtra, status: half ? 'leave' : 'future', label: half ? `Half day leave (${leaveName(half.type)})` : '' };

  if (!closed) {
    // Today, still open. Nobody is judged before the day is over.
    const open = (status: ViewStatus, label: string, extra: Partial<DayResult> = {}): DayResult => ({ ...base, ...halfExtra, status, label, ...extra });
    if (half) return open('leave', `Half day leave (${leaveName(half.type)})`, { late: false });
    if (inMin === null) return open('not_in', STATUS_LABEL.not_in, { late: a.nowSec > a.rules.startSec + 59 });
    if (outMin === null) return open('working', `In since ${clock(inMin)}`);
    if (!base.late && base.workedMin >= a.rules.fullDayMin) return open('present', STATUS_LABEL.present);
    return open('working', `Last punch ${clock(outMin)}`);
  }

  // The day is over. Rules 2 to 7, in this order.
  let engine: EngineStatus; let paid: number; let label: string | undefined;
  if (inMin === null && outMin === null) { engine = 'ABSENT'; paid = 0; }                                        // 2. no punches
  else if (inMin === null || outMin === null) { engine = 'MISSING_PUNCH'; paid = 1; }                             // 3. one punch: decided before the lock
  else if (base.workedMin < a.rules.halfDayMin) { engine = 'ABSENT'; paid = 0; label = `Absent (under ${hoursText(a.rules.halfDayMin)} h)`; } // 4.
  else if (base.late) { engine = 'HALF_DAY_LATE'; paid = 0.5; }                                                   // 5. in after 09:00:59
  else if (base.workedMin < a.rules.fullDayMin) { engine = 'HALF_DAY_SHORT'; paid = 0.5; }                        // 6.
  else { engine = 'PRESENT'; paid = 1; }                                                                          // 7.

  if (!half || engine === 'MISSING_PUNCH' || engine === 'PRESENT') return done(engine, paid, { ...halfExtra, ...(label ? { label } : {}) });

  // An approved half-day leave next to a half day or an absence.
  // CL or PL pays its half: a half-day status goes up to 1, an absent day (under the half-day hours) goes up to 0.5.
  if (half.type !== 'UNPAID') paid = Math.min(1, paid + 0.5);
  const text = `Half day leave (${leaveName(half.type)})`;
  if (paid === 0) return done(engine, 0, { ...halfExtra, label: `Absent, with half day ${leaveName(half.type).toLowerCase()}` });
  return done(engine, paid, { ...halfExtra, status: 'leave', label: engine === 'ABSENT' ? `${text}, other half absent` : text, late: false });
}

/** Monthly counts for the register and the profile, the way the screens total them. */
export function countDays(days: DayResult[], today: Ymd) {
  const t = { present: 0, half: 0, absent: 0, leave: 0, missing: 0, unpaid: 0 };
  for (const d of days) {
    if (d.status === 'present') t.present++;
    else if (d.status === 'half_late' || d.status === 'half_short') t.half++;
    else if (d.status === 'absent') t.absent++;
    else if (d.status === 'missing') t.missing++;
    else if (d.status === 'leave' && d.date <= today) t.leave += d.halfLeave ? 0.5 : 1;
    if (d.status !== 'not_joined') t.unpaid += d.unpaid;
  }
  return t;
}
