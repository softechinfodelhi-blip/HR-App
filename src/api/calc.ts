// Derived figures over the mock database. Each function maps to a query or service in the backend.
import type { AnyRequest, Balances, DayView, Employee, LocalDateTime, Month, MonthLock, PayrollRow, PayrollTotals, Punch, Ymd } from '../types';
import { addMonths, dateOf, dateRange, monthDays, monthOf, round2, timeOf, toMin } from '../lib/format';
import { classifyDay, dayKind, leaveBalance, payrollRow, streakOf, workingDaysElapsed } from '../lib/rules';
import { db, now } from './db';
import { DATA_FROM } from './seed';

export interface Ctx { now: LocalDateTime; today: Ymd; nowMin: number; }
export function ctx(): Ctx { const t = now(); return { now: t, today: dateOf(t), nowMin: toMin(timeOf(t)) }; }

let index: Map<string, Punch[]> | null = null;
let indexedDb: unknown = null;
export function invalidatePunches() { index = null; }
export function punchesOn(empId: string, date: Ymd, c: Ctx): Punch[] {
  if (!index || indexedDb !== db) {
    index = new Map(); indexedDb = db;
    for (const p of db.punches) {
      const k = `${p.employeeId}|${dateOf(p.at)}`;
      const list = index.get(k); if (list) list.push(p); else index.set(k, [p]);
    }
  }
  // A punch held on an offline terminal is not visible until the terminal has delivered it.
  return (index.get(`${empId}|${date}`) ?? []).filter(p => p.receivedAt <= c.now);
}

export const staff = () => db.employees.filter(e => e.role !== 'admin');
export const officeStaff = (officeIds: string[]) => staff().filter(e => officeIds.includes(e.officeId) && e.status !== 'inactive');
export const emp = (id: string) => db.employees.find(e => e.id === id);
export const officeName = (id: string) => db.offices.find(o => o.id === id)?.name ?? '';
export const nameOf = (id?: string | null) => (id ? emp(id)?.name ?? '' : '');

export function dayOf(e: Employee, date: Ymd, c: Ctx): DayView {
  const manual = db.manualDays.find(m => m.employeeId === e.id && m.date === date);
  const leave = db.leaves.find(l => l.employeeId === e.id && l.status === 'approved' && l.from <= date && date <= l.to);
  return classifyDay({
    date, today: c.today, nowMin: c.nowMin, joinDate: e.joinDate, homeOfficeId: e.officeId,
    kind: dayKind(date, e.officeId, db.holidays),
    punches: punchesOn(e.id, date, c).map(p => ({ min: toMin(timeOf(p.at)), officeId: p.officeId })),
    manual: manual ? { inMin: manual.inTime ? toMin(manual.inTime) : null, outMin: manual.outTime ? toMin(manual.outTime) : null } : null,
    leave: leave ? { type: leave.type, half: leave.half } : null,
  });
}
export function monthOfEmp(e: Employee, month: Month, c: Ctx): DayView[] { return monthDays(month).map(d => dayOf(e, d, c)); }

export function countDays(days: DayView[], today: Ymd) {
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

export function salaryFor(empId: string, month: Month): number {
  let best: { m: Month; amount: number } | null = null;
  for (const s of db.salaries) {
    if (s.employeeId !== empId || s.effectiveMonth > month) continue;
    if (!best || s.effectiveMonth >= best.m) best = { m: s.effectiveMonth, amount: s.amount };
  }
  return best?.amount ?? 0;
}

/** People on the payroll of an office for a month: joined on or before its last day and not switched off. */
export function payrollStaff(officeId: string, month: Month) {
  const last = monthDays(month).at(-1)!;
  return staff().filter(e => e.officeId === officeId && e.status !== 'inactive' && e.joinDate <= last);
}
export function payrollRows(officeId: string, month: Month, c: Ctx): PayrollRow[] {
  return payrollStaff(officeId, month).map(e => payrollRow(e, salaryFor(e.id, month), month, monthOfEmp(e, month, c)));
}
export function totalsOf(rows: PayrollRow[]): PayrollTotals {
  const t = { salary: 0, unpaidDays: 0, deduction: 0, net: 0, people: rows.length };
  for (const r of rows) { t.salary += r.salary; t.unpaidDays += r.unpaidDays; t.deduction += r.deduction; t.net += r.net; }
  return { ...t, deduction: round2(t.deduction), net: round2(t.net) };
}

export function lockOf(officeId: string, month: Month): MonthLock | undefined { return db.locks.find(l => l.officeId === officeId && l.month === month); }
export function isLocked(officeId: string, month: Month): boolean { return !!lockOf(officeId, month)?.lockedAt; }

export function balancesOf(e: Employee, c: Ctx): Balances {
  const open = db.leaveOpening[e.id] ?? { cl: 0, pl: 0, creditFrom: addMonths(monthOf(e.joinDate), 1) };
  const sum = (type: 'CL' | 'PL', status: 'approved' | 'pending') =>
    db.leaves.filter(l => l.employeeId === e.id && l.type === type && l.status === status).reduce((n, l) => n + l.days, 0);
  const month = monthOf(c.today);
  return {
    cl: leaveBalance({ quota: e.clQuota, opening: open.cl, creditFrom: open.creditFrom, month, used: sum('CL', 'approved'), pending: sum('CL', 'pending') }),
    pl: leaveBalance({ quota: e.plQuota, opening: open.pl, creditFrom: open.creditFrom, month, used: sum('PL', 'approved'), pending: sum('PL', 'pending') }),
  };
}

export function streakFor(e: Employee, c: Ctx): { current: number; best: number } {
  const from = e.joinDate > DATA_FROM ? e.joinDate : DATA_FROM;
  const current = streakOf(dateRange(from, c.today).map(d => dayOf(e, d, c)));
  return { current, best: Math.max(current, e.bestStreak) };
}

export function requestDates(r: AnyRequest): Ymd[] { return r.kind === 'leave' ? dateRange(r.from, r.to) : [r.date]; }
export function isEscalated(r: AnyRequest, c: Ctx): boolean {
  if (r.status !== 'pending') return false;
  const e = emp(r.employeeId); if (!e || e.role === 'head') return false; // a head's own request goes to the admin anyway
  return workingDaysElapsed(dateOf(r.createdAt), c.today, e.officeId, db.holidays) >= db.settings.escalateAfterWorkingDays;
}

/** Share of expected check-ins that were at or before 9:00, for one office and month. */
export function onTimeRate(officeId: string, month: Month, c: Ctx): number | null {
  let expected = 0, onTime = 0;
  for (const e of officeStaff([officeId])) {
    for (const d of monthDays(month)) {
      if (d > c.today) break;
      const v = dayOf(e, d, c);
      if (['off', 'holiday', 'future', 'not_joined'].includes(v.status) || (v.status === 'leave' && !v.halfLeave)) continue;
      if (v.status === 'not_in' && !v.late) continue; // today, before 9:00
      expected++;
      if (v.inTime && !v.late) onTime++;
    }
  }
  return expected ? Math.round((onTime / expected) * 100) : null;
}
