// Attendance, leave and payroll rules as pure functions.
// The backend must produce the same results. docs/system-design.md section 5 explains each rule.
import type { DayStatus, DayView, Holiday, LeaveType, Month, PayrollRow, Ymd } from '../types';
import { addDays, daysInMonth, dow, fmtDate, fromMin, monthsBetween, parts, round2 } from './format';

export const RULES = {
  startMin: 9 * 60, // office starts 9:00 AM, a first punch at 9:01 or later is late
  fullDayMin: 9 * 60, // 9 h between first and last punch
  halfDayMin: 270, // under 4.5 h counts as absent
  dedupeMin: 2, // punches closer than this are one punch
  escalateAfterWorkingDays: 2,
  plCarryMax: 30,
};

export const STATUS_LABEL: Record<DayStatus, string> = {
  present: 'Present', half_late: 'Half day (late)', half_short: 'Half day (short hours)', missing: 'Missing punch',
  absent: 'Absent', leave: 'On leave', off: 'Weekly off', holiday: 'Holiday', not_in: 'Not yet in',
  working: 'In office', future: '', not_joined: 'Before joining',
};

/** Sundays plus the 2nd and 4th Saturday of the month. */
export function isWeeklyOff(d: Ymd): boolean {
  const w = dow(d);
  if (w === 0) return true;
  if (w === 6) { const nth = Math.ceil(parts(d).d / 7); return nth === 2 || nth === 4; }
  return false;
}

export interface DayKind { kind: 'working' | 'off' | 'holiday'; name?: string; }
/** Per office calendar. A forced working date wins over a holiday and over a weekly off. */
export function dayKind(d: Ymd, officeId: string, holidays: Holiday[]): DayKind {
  let hol: Holiday | undefined;
  for (const h of holidays) {
    if (h.date !== d || !h.officeIds.includes(officeId)) continue;
    if (h.kind === 'working') return { kind: 'working', name: h.name };
    hol = h;
  }
  if (hol) return { kind: 'holiday', name: hol.name };
  return isWeeklyOff(d) ? { kind: 'off' } : { kind: 'working' };
}

export function workingDates(from: Ymd, to: Ymd, officeId: string, holidays: Holiday[]): Ymd[] {
  const out: Ymd[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (dayKind(d, officeId, holidays).kind === 'working') out.push(d);
  return out;
}
/** Leave is charged for working days only. A half day is allowed on a single date. */
export function leaveDays(from: Ymd, to: Ymd, half: boolean, officeId: string, holidays: Holiday[]): number {
  const n = workingDates(from, to, officeId, holidays).length;
  return half && from === to ? n * 0.5 : n;
}
/** Working days that have passed after `from`, up to and including `to`. Used for escalation. */
export function workingDaysElapsed(from: Ymd, to: Ymd, officeId: string, holidays: Holiday[]): number {
  return from >= to ? 0 : workingDates(addDays(from, 1), to, officeId, holidays).length;
}

export interface DayInput {
  date: Ymd; today: Ymd; nowMin: number; kind: DayKind; joinDate: Ymd; homeOfficeId: string;
  punches: { min: number; officeId: string }[];
  manual?: { inMin: number | null; outMin: number | null } | null;
  leave?: { type: LeaveType; half: boolean } | null;
}

const leaveName = (t: LeaveType) => (t === 'UNPAID' ? 'Unpaid leave' : t);

/** One employee, one date: status, hours and the unpaid fraction of the day. */
export function classifyDay(a: DayInput): DayView {
  const v: DayView = {
    date: a.date, status: 'future', label: '', inTime: null, outTime: null, workedMin: 0,
    unpaid: 0, late: false, manual: false, otherOffice: null,
  };
  const set = (status: DayStatus, unpaid = 0, label = STATUS_LABEL[status]): DayView => ({ ...v, status, unpaid, label });

  if (a.date < a.joinDate) return set('not_joined', 1);
  if (a.kind.kind === 'holiday') return { ...set('holiday', 0, a.kind.name || 'Holiday'), holidayName: a.kind.name };
  if (a.kind.kind === 'off') return set('off');

  // First and last punch of the day. Raw punches are never edited, a manual entry sits on top.
  const mins = a.punches.map(p => p.min).sort((x, y) => x - y).filter((m, i, all) => i === 0 || m - all[i - 1] >= RULES.dedupeMin);
  let inMin: number | null = mins.length ? mins[0] : null;
  let outMin: number | null = mins.length > 1 ? mins[mins.length - 1] : null;
  if (a.manual) {
    v.manual = true;
    if (a.manual.inMin != null) inMin = a.manual.inMin;
    if (a.manual.outMin != null) outMin = a.manual.outMin;
  }
  v.inTime = inMin != null ? fromMin(inMin) : null;
  v.outTime = outMin != null ? fromMin(outMin) : null;
  v.workedMin = inMin != null && outMin != null ? Math.max(0, outMin - inMin) : 0;
  v.late = inMin != null && inMin > RULES.startMin;
  v.otherOffice = a.punches.find(p => p.officeId !== a.homeOfficeId)?.officeId ?? null;

  const closed = a.date < a.today;
  const isToday = a.date === a.today;

  if (a.leave && !a.leave.half) {
    return { ...set('leave', a.leave.type === 'UNPAID' ? 1 : 0, `On leave (${leaveName(a.leave.type)})`), leaveType: a.leave.type, late: false };
  }
  if (a.leave && a.leave.half) {
    // Half day leave: the other half needs 4.5 h at the office. The 9:00 rule does not apply.
    if (closed && inMin != null && outMin == null) return { ...set('missing'), leaveType: a.leave.type, halfLeave: true };
    const worked = !closed || v.workedMin >= RULES.halfDayMin;
    const unpaid = (a.leave.type === 'UNPAID' ? 0.5 : 0) + (worked ? 0 : 0.5);
    return { ...set('leave', unpaid, `Half day leave (${leaveName(a.leave.type)})`), leaveType: a.leave.type, halfLeave: true, late: false };
  }
  if (!closed && !isToday) return set('future');

  if (inMin == null) {
    if (isToday) return { ...set('not_in'), late: a.nowMin > RULES.startMin };
    return set('absent', 1);
  }
  if (outMin == null) {
    if (isToday) return set('working', 0, `In since ${fmtClock(inMin)}`);
    return set('missing');
  }
  if (isToday) {
    // The day is still open. Only call it once the hours are done.
    if (!v.late && v.workedMin >= RULES.fullDayMin) return set('present');
    return set('working', 0, `Last punch ${fmtClock(outMin)}`);
  }
  if (v.workedMin < RULES.halfDayMin) return set('absent', 1, 'Absent (under 4.5 h)');
  if (v.late) return set('half_late', 0.5);
  if (v.workedMin < RULES.fullDayMin) return set('half_short', 0.5);
  return set('present');
}
function fmtClock(min: number) { const h = Math.floor(min / 60), m = min % 60; return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; }

/** Monthly figures for one employee. net = salary − (salary / calendar days) × unpaid days. */
export function payrollRow(e: { id: string; name: string; designation: string }, salary: number, month: Month, days: DayView[]): PayrollRow {
  const calendarDays = daysInMonth(month);
  const r: PayrollRow = {
    employeeId: e.id, name: e.name, designation: e.designation, salary, calendarDays, dayRate: round2(salary / calendarDays),
    present: 0, half: 0, absent: 0, paidLeave: 0, unpaidLeave: 0, missing: 0, notEmployed: 0, unpaidDays: 0, deduction: 0, net: 0, trace: [],
  };
  for (const d of days) {
    switch (d.status) {
      case 'present': r.present += 1; break;
      case 'half_late': case 'half_short': r.half += 1; break;
      case 'absent': r.absent += 1; break;
      case 'missing': r.missing += 1; break;
      case 'not_joined': r.notEmployed += 1; break;
      case 'leave': {
        const n = d.halfLeave ? 0.5 : 1;
        if (d.leaveType === 'UNPAID') r.unpaidLeave += n; else r.paidLeave += n;
        break;
      }
    }
    r.unpaidDays += d.unpaid;
    if (d.unpaid > 0 && d.status !== 'not_joined') r.trace.push({ date: d.date, label: d.label, unpaid: d.unpaid });
  }
  if (r.notEmployed > 0) r.trace.unshift({ date: days[0].date, label: `Before joining (${r.notEmployed} calendar days)`, unpaid: r.notEmployed });
  r.deduction = round2((salary / calendarDays) * r.unpaidDays);
  r.net = round2(salary - r.deduction);
  return r;
}

/** Quota is credited 1/12 on the 1st of each month from `creditFrom`. */
export function leaveBalance(q: { quota: number; opening: number; creditFrom: Month; month: Month; used: number; pending: number }) {
  const credits = Math.max(0, monthsBetween(q.creditFrom, q.month) + 1);
  const balance = round2(q.opening + (credits * q.quota) / 12 - q.used);
  return { quota: q.quota, balance, pending: q.pending, available: round2(balance - q.pending) };
}

/** Year end: CL lapses, PL carries over up to 30 days. */
export function yearEndCarry(cl: number, pl: number) { return { cl: 0, pl: Math.min(Math.max(pl, 0), RULES.plCarryMax), lapsedCl: Math.max(cl, 0) }; }

/** Full on-time days in a row, counted back from the latest day. Offs, holidays and leave do not break it. */
export function streakOf(days: DayView[]): number {
  let n = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    if (d.status === 'present') { n++; continue; }
    if (d.status === 'off' || d.status === 'holiday' || d.status === 'future') continue;
    if (d.status === 'leave' && !d.halfLeave) continue;
    if ((d.status === 'not_in' || d.status === 'working') && !d.late) continue; // today, still open
    break;
  }
  return n;
}

export function describeTrace(t: { date: Ymd; label: string; unpaid: number }) { return `${fmtDate(t.date)} · ${t.label}`; }
