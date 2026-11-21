// Checks the rules and the mock API against the known sample figures.
import { beforeEach, describe, expect, it } from 'vitest';
import { api } from './index';
import { classifyDay, isWeeklyOff, leaveBalance, payrollRow, yearEndCarry } from '../lib/rules';
import type { DayInput } from '../lib/rules';

const day = (over: Partial<DayInput>) => classifyDay({
  date: '2026-11-18', today: '2026-11-23', nowMin: 552, kind: { kind: 'working' }, joinDate: '2020-01-01', homeOfficeId: 'o1', punches: [], ...over,
});
const p = (...times: string[]) => times.map(t => ({ min: Number(t.slice(0, 2)) * 60 + Number(t.slice(3)), officeId: 'o1' }));

describe('attendance rules', () => {
  it('weekly offs: Sundays and the 2nd and 4th Saturday', () => {
    expect(isWeeklyOff('2026-11-01')).toBe(true); // Sunday
    expect(isWeeklyOff('2026-11-07')).toBe(false); // 1st Saturday
    expect(isWeeklyOff('2026-11-14')).toBe(true); // 2nd Saturday
    expect(isWeeklyOff('2026-11-21')).toBe(false);
    expect(isWeeklyOff('2026-11-28')).toBe(true);
  });
  it('9:00 sharp is on time, 9:01 is a half day', () => {
    expect(day({ punches: p('09:00', '18:00') }).status).toBe('present');
    const late = day({ punches: p('09:01', '18:30') });
    expect(late.status).toBe('half_late'); expect(late.unpaid).toBe(0.5);
  });
  it('hours: 9 h full, 4.5 h to 9 h half, under 4.5 h absent', () => {
    expect(day({ punches: p('08:50', '17:49') }).status).toBe('half_short');
    expect(day({ punches: p('08:50', '13:20') }).status).toBe('half_short');
    const a = day({ punches: p('08:50', '13:19') });
    expect(a.status).toBe('absent'); expect(a.unpaid).toBe(1);
  });
  it('one punch on a past day is a missing punch, no punch is absent', () => {
    expect(day({ punches: p('08:55') }).status).toBe('missing');
    expect(day({}).status).toBe('absent');
  });
  it('a manual entry sits on top of raw punches', () => {
    const d = day({ punches: p('08:55'), manual: { inMin: null, outMin: 18 * 60 + 10 } });
    expect(d.status).toBe('present'); expect(d.manual).toBe(true);
  });
  it('leave and unpaid leave', () => {
    expect(day({ leave: { type: 'CL', half: false } }).unpaid).toBe(0);
    expect(day({ leave: { type: 'UNPAID', half: false } }).unpaid).toBe(1);
    expect(day({ leave: { type: 'CL', half: true }, punches: p('13:30', '18:05') }).unpaid).toBe(0);
    expect(day({ leave: { type: 'CL', half: true } }).unpaid).toBe(0.5);
  });
  it('payroll row and leave balance', () => {
    const r = payrollRow({ id: 'x', name: 'X', designation: '' }, 52000, '2026-11', [day({ punches: p('09:20', '18:30') })]);
    expect(r.unpaidDays).toBe(0.5); expect(r.deduction).toBe(866.67); expect(r.net).toBe(51133.33);
    expect(leaveBalance({ quota: 12, opening: 2.5, creditFrom: '2026-10', month: '2026-11', used: 1, pending: 0 }).balance).toBe(3.5);
    expect(yearEndCarry(4, 37)).toEqual({ cl: 0, pl: 30, lapsedCl: 4 });
  });
});

describe('sample office through the API', () => {
  beforeEach(() => { api.demo.reset(); });

  it('Mon 23 Nov 9:12 AM, Office 1', async () => {
    await api.login('vikram.singh@sbm.example', 'demo1234');
    const t = await api.today('o1');
    expect(t.counts).toMatchObject({ total: 22, in: 19, notIn: 2, onLeave: 1, waiting: 4 });
    const priya = await api.employee('EMP-0117');
    expect(priya.balances.cl.balance).toBe(3.5);
    expect(priya.balances.pl.balance).toBe(11.5);
    expect(priya.balances.pl.pending).toBe(2);
    expect(priya.streak).toEqual({ current: 12, best: 31 });
  });

  it('a head is pinned to their office and cannot touch their own record', async () => {
    await api.login('vikram.singh@sbm.example', 'demo1234');
    expect((await api.employees({ scope: 'all' })).every(e => e.officeId === 'o1')).toBe(true);
    await expect(api.payroll('o2', '2026-11')).rejects.toThrow(/own office/);
    await expect(api.setSalary('EMP-0102', 90000, '2026-12')).rejects.toThrow(/own salary/);
    await expect(api.decide('LV-15', 'approved')).rejects.toThrow(/admin decides/i);
  });

  it('admin queue holds head requests and escalated ones', async () => {
    await api.login('anita.verma@sbm.example', 'demo1234');
    const q = await api.queue('all');
    expect(q.map(r => r.id).sort()).toEqual(['CR-2', 'LV-13', 'LV-15']);
    expect(q.filter(r => r.escalated).map(r => r.id).sort()).toEqual(['CR-2', 'LV-13']);
  });

  it('month end: resolve, review, lock, payslips', async () => {
    await api.login('vikram.singh@sbm.example', 'demo1234');
    api.demo.setClock('2026-12-01T10:00');
    let d = await api.payroll('o1', '2026-11');
    expect(d.missing.map(m => m.name).sort()).toEqual(['Karan Malhotra', 'Sneha Iyer']);
    expect(d.canLock).toBe(false);
    await expect(api.lockMonth('o1', '2026-11')).rejects.toThrow(/missing/);
    for (const m of d.missing) await api.decide(m.request!.id, 'approved');
    for (const r of d.pending) await api.decide(r.id, 'approved');
    await api.markReviewed('o1', '2026-11');
    d = await api.payroll('o1', '2026-11');
    expect(d.totals).toMatchObject({ people: 22, salary: 852000, unpaidDays: 12, deduction: 12666.67, net: 839333.33 });
    expect(d.canLock).toBe(true);
    await api.lockMonth('o1', '2026-11');
    await expect(api.correctDay('EMP-0117', '2026-11-04', { inTime: '08:55', outTime: null, reason: 'test' })).rejects.toThrow(/locked/);
    const slip = await api.payslip('EMP-0117', '2026-11');
    expect(slip.row.net).toBe(51133.33);
    await api.logout();
    await api.login('priya.nair@sbm.example', 'demo1234');
    expect((await api.myPayslips()).map(s => s.month)).toEqual(['2026-11', '2026-10']);
  });

  it('add an employee, set the password from the invite, first home', async () => {
    await api.login('vikram.singh@sbm.example', 'demo1234');
    const { employee, inviteToken } = await api.createEmployee({
      name: 'Ishaan Bhatnagar', email: 'ishaan.bhatnagar@sbm.example', phone: '', officeId: 'o3', designation: 'Sales Executive',
      joinDate: '2026-11-23', salary: 30000, effectiveMonth: '2026-11', clQuota: 12, plQuota: 18,
    });
    expect(employee.id).toBe('EMP-0130');
    expect(employee.officeId).toBe('o1'); // a head can only add to their own office
    await api.logout();
    await expect(api.login('ishaan.bhatnagar@sbm.example', 'demo1234')).rejects.toThrow();
    const u = await api.setPassword(inviteToken, 'welcome-123');
    expect(u.role).toBe('employee');
    const home = await api.myHome();
    expect(home.firstDays).toBe(true);
    expect(home.today.status).toBe('not_in');
  });

  it('leave cannot exceed the balance', async () => {
    await api.login('priya.nair@sbm.example', 'demo1234');
    const v = await api.leavePreview({ type: 'CL', from: '2026-12-07', to: '2026-12-11', half: false });
    expect(v.days).toBe(5); expect(v.ok).toBe(false);
    const ok = await api.leavePreview({ type: 'CL', from: '2026-12-07', to: '2026-12-07', half: true });
    expect(ok).toMatchObject({ days: 0.5, ok: true, balanceAfter: 3 });
  });
});
