// Monthly pay for one employee, as a pure function over the month's attendance days.
//
//   day_rate    = monthly_salary / calendar days in the month
//   unpaid_days = sum over working days of (1 - paid_fraction)
//                 + calendar days before joining or after the last working date
//   net_salary  = monthly_salary - day_rate x unpaid_days, rounded to the nearest rupee
//
// No PF, ESI, TDS or overtime.
import { daysInMonth, round2, type Month, type Ymd } from '../lib/time';
import type { DayResult } from './day-rules';

export interface PayrollRow {
  employeeId: string; name: string; code: string; designation: string;
  salary: number; calendarDays: number; dayRate: number;
  present: number; half: number; absent: number; paidLeave: number; unpaidLeave: number; missing: number; notEmployed: number;
  unpaidDays: number; deduction: number; net: number;
  /** Every day that cost something, for the payslip and the "why" on the payroll screen. */
  trace: { date: Ymd; label: string; unpaid: number }[];
}
export interface PayrollTotals { salary: number; unpaidDays: number; deduction: number; net: number; people: number; }

export function payrollRow(e: { id: string; name: string; code: string; designation: string }, salary: number, month: Month, days: DayResult[]): PayrollRow {
  const calendarDays = daysInMonth(month);
  const r: PayrollRow = {
    employeeId: e.id, name: e.name, code: e.code, designation: e.designation, salary, calendarDays, dayRate: round2(salary / calendarDays),
    present: 0, half: 0, absent: 0, paidLeave: 0, unpaidLeave: 0, missing: 0, notEmployed: 0, unpaidDays: 0, deduction: 0, net: 0, trace: [],
  };
  let before = 0; let after = 0;
  for (const d of days) {
    switch (d.status) {
      case 'present': r.present += 1; break;
      case 'half_late': case 'half_short': r.half += 1; break;
      case 'absent': r.absent += 1; break;
      case 'missing': r.missing += 1; break;
      case 'not_joined': r.notEmployed += 1; if (d.label.startsWith('After')) after++; else before++; break;
      case 'leave': {
        const n = d.halfLeave ? 0.5 : 1;
        if (d.leaveType === 'UNPAID') r.unpaidLeave += n; else r.paidLeave += n;
        break;
      }
    }
    r.unpaidDays += d.unpaid;
    if (d.unpaid > 0 && d.status !== 'not_joined') r.trace.push({ date: d.date, label: d.label, unpaid: d.unpaid });
  }
  // Joined or left mid-month: only the calendar days of employment are paid, at this month's day rate.
  if (after > 0) r.trace.push({ date: days[days.length - after].date, label: `After the last working date (${after} calendar ${after === 1 ? 'day' : 'days'})`, unpaid: after });
  if (before > 0) r.trace.unshift({ date: days[0].date, label: `Before joining (${before} calendar ${before === 1 ? 'day' : 'days'})`, unpaid: before });
  // The exact day rate is used for the sum. Only the result is rounded, to the nearest rupee.
  r.net = Math.max(0, Math.round(salary - (salary / calendarDays) * r.unpaidDays));
  r.deduction = round2(salary - r.net);
  return r;
}

export function totalsOf(rows: PayrollRow[]): PayrollTotals {
  const t = { salary: 0, unpaidDays: 0, deduction: 0, net: 0, people: rows.length };
  for (const r of rows) { t.salary += r.salary; t.unpaidDays += r.unpaidDays; t.deduction += r.deduction; t.net += r.net; }
  return { ...t, salary: round2(t.salary), deduction: round2(t.deduction), net: round2(t.net) };
}
