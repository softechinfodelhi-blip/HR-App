// Payroll: the figures, the lock and what it freezes, unlock, the lock summary and payslips.
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { dbDate, istToUtc, monthDays, setNow } from '../src/lib/time';
import { emptyCalendar, dayKind } from '../src/services/calendar';
import { classifyDay, type DayInput } from '../src/services/day-rules';
import { payrollRow, totalsOf } from '../src/services/payroll-rules';
import { payslipContent } from '../src/services/payslip-pdf';
import { makeEmployee, resetDb, signIn, world, type Agent } from './helpers';

const RULES = { startSec: 9 * 3600, fullDayMin: 540, halfDayMin: 270 };
const sec = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 3600 + m * 60; };
const WHO = { id: 'e1', name: 'Test Person', code: 'EMP-0101', designation: 'Executive' };

/** A whole month of days: present 09:00 to 18:00 on every working day, except what `special` says. */
function monthOf(month: string, special: Record<string, Partial<DayInput> | 'absent' | 'late'> = {}, base: Partial<DayInput> = {}) {
  return monthDays(month).map(date => {
    const s = special[date];
    const punches = s === 'absent' ? [] : s === 'late' ? [sec('09:20'), sec('18:30')] : [sec('09:00'), sec('18:00')];
    return classifyDay({
      date, today: '2027-06-01', nowSec: 0, kind: dayKind(date, emptyCalendar()), rules: RULES, joinDate: '2020-01-01', homeOfficeId: 'o1',
      punches: punches.map(x => ({ sec: x, officeId: 'o1' })), ...base, ...(typeof s === 'object' ? s : {}),
    });
  });
}

describe('payroll figures', () => {
  it('REQUIRED: salary 30,000, November 2026 (30 days), 1 absent day, 2 late half days, 1 approved CL gives unpaid_days 2 and net 28,000', () => {
    const days = monthOf('2026-11', {
      '2026-11-05': 'absent',
      '2026-11-03': 'late', '2026-11-10': 'late',
      '2026-11-12': { punches: [], leave: { type: 'CL', half: 'none' } },
    });
    const r = payrollRow(WHO, 30000, '2026-11', days);
    expect(r.calendarDays).toBe(30);
    expect(r.dayRate).toBe(1000);
    expect(r.unpaidDays).toBe(2);       // 1 absent + 2 x 0.5. The CL day is paid.
    expect(r.deduction).toBe(2000);
    expect(r.net).toBe(28000);
    expect(r).toMatchObject({ present: 19, half: 2, absent: 1, paidLeave: 1, unpaidLeave: 0, missing: 0, notEmployed: 0 });
    expect(r.trace).toEqual([
      { date: '2026-11-03', label: 'Half day (late)', unpaid: 0.5 }, { date: '2026-11-05', label: 'Absent', unpaid: 1 }, { date: '2026-11-10', label: 'Half day (late)', unpaid: 0.5 },
    ]);
  });

  it('a full month with nothing unpaid pays the whole salary: weekly offs and holidays cost nothing', () => {
    expect(payrollRow(WHO, 30000, '2026-11', monthOf('2026-11'))).toMatchObject({ present: 23, unpaidDays: 0, deduction: 0, net: 30000 });
  });

  it('the day rate uses the calendar days of that month', () => {
    expect(payrollRow(WHO, 31000, '2026-10', monthOf('2026-10', { '2026-10-05': 'absent' }))).toMatchObject({ calendarDays: 31, dayRate: 1000, net: 30000 });
    expect(payrollRow(WHO, 28000, '2027-02', monthOf('2027-02', { '2027-02-03': 'absent' }))).toMatchObject({ calendarDays: 28, dayRate: 1000, net: 27000 });
  });

  it('net salary is rounded to the nearest rupee', () => {
    // 52,000 / 30 = 1,733.33 a day. Half a day is 866.67, so net is 51,133.33, paid as 51,133.
    const r = payrollRow(WHO, 52000, '2026-11', monthOf('2026-11', { '2026-11-03': 'late' }));
    expect(r).toMatchObject({ dayRate: 1733.33, unpaidDays: 0.5, net: 51133, deduction: 867 });
    // 26,000 / 30 x 1 = 866.67 off: 25,133.33, paid as 25,133. Two days: 24,266.67, paid as 24,267.
    expect(payrollRow(WHO, 26000, '2026-11', monthOf('2026-11', { '2026-11-03': 'absent', '2026-11-04': 'absent' })).net).toBe(24267);
    expect(r.salary - r.deduction).toBe(r.net); // the payslip always adds up
  });

  it('unpaid leave is unpaid, half-day CL is not', () => {
    const r = payrollRow(WHO, 30000, '2026-11', monthOf('2026-11', {
      '2026-11-04': { punches: [], leave: { type: 'UNPAID', half: 'none' } },
      '2026-11-06': { punches: [{ sec: sec('09:00'), officeId: 'o1' }, { sec: sec('13:30'), officeId: 'o1' }], leave: { type: 'CL', half: 'second' } },
    }));
    expect(r).toMatchObject({ unpaidLeave: 1, paidLeave: 0.5, unpaidDays: 1, net: 29000 });
  });

  it('joined mid-month: only the calendar days from the joining date are paid, at that month\'s day rate', () => {
    // Joined Mon 16 Nov: 15 calendar days before joining are unpaid, 15 are paid.
    const r = payrollRow(WHO, 30000, '2026-11', monthOf('2026-11', {}, { joinDate: '2026-11-16' }));
    expect(r).toMatchObject({ notEmployed: 15, unpaidDays: 15, net: 15000, present: 12 });
    expect(r.trace[0]).toEqual({ date: '2026-11-01', label: 'Before joining (15 calendar days)', unpaid: 15 });
  });

  it('left mid-month: paid up to the last working date, with absences still deducted', () => {
    const r = payrollRow(WHO, 30000, '2026-11', monthOf('2026-11', { '2026-11-05': 'absent' }, { lastWorkingDate: '2026-11-20' }));
    expect(r).toMatchObject({ notEmployed: 10, unpaidDays: 11, net: 19000 });
    expect(r.trace.at(-1)).toEqual({ date: '2026-11-21', label: 'After the last working date (10 calendar days)', unpaid: 10 });
  });

  it('totals add up the rows', () => {
    const a = payrollRow(WHO, 30000, '2026-11', monthOf('2026-11', { '2026-11-05': 'absent' }));
    const b = payrollRow({ ...WHO, id: 'e2' }, 52000, '2026-11', monthOf('2026-11', { '2026-11-03': 'late' }));
    expect(totalsOf([a, b])).toEqual({ people: 2, salary: 82000, unpaidDays: 1.5, deduction: 1867, net: 80133 });
  });
});

// ---------------------------------------------------------------------
type World = Awaited<ReturnType<typeof world>>;
let w: World;
let deviceId: string;
const NOV_WORKING = monthDays('2026-11').filter(d => dayKind(d, emptyCalendar()).kind === 'working');

async function punches(e: { terminalUserId: string | null }, date: string, times: string[]) {
  await prisma.rawPunch.createMany({ data: times.map(t => ({ deviceId, terminalUserId: e.terminalUserId!, punchTime: istToUtc(date, t), rawLine: `${e.terminalUserId}\t${date} ${t}:00` })) });
}
/** Priya, salary 30,000: November with 1 absent day (5th), 2 late half days (3rd, 10th) and nothing on the 12th (to be CL). */
async function novemberForPriya() {
  await prisma.salaryHistory.updateMany({ where: { employeeId: w.priya.id }, data: { monthlyAmount: 30000 } });
  await prisma.leaveLedger.create({ data: { employeeId: w.priya.id, leaveType: 'CL', deltaDays: 5, reason: 'opening', entryDate: dbDate('2026-01-01') } });
  for (const d of NOV_WORKING) {
    if (d === '2026-11-05' || d === '2026-11-12') continue;
    await punches(w.priya, d, d === '2026-11-03' || d === '2026-11-10' ? ['09:20', '18:30'] : ['09:00', '18:00']);
  }
}
const approveCl = async (head: Agent) => {
  const priya = await signIn(w.priya.email);
  const l = await priya.post('/api/leave').send({ type: 'CL', from: '2026-11-12', to: '2026-11-12', halfDay: 'none', reason: 'Personal work' });
  expect((await head.post(`/api/requests/${l.body.id}/decision`).send({ decision: 'approved' })).status).toBe(204);
};
const url = (o: { id: string }, tail = '') => `/api/payroll/${o.id}/2026-11${tail}`;
const rowOf = (res: { body: { rows: { employeeId: string }[] } }, id: string) => res.body.rows.find(r => r.employeeId === id);

beforeEach(async () => {
  await resetDb();
  w = await world();
  deviceId = (await prisma.device.create({ data: { serialNumber: 'SN001', officeId: w.o1.id, name: 'Office 1 door' } })).id;
  setNow('2026-12-01T04:30:00Z'); // Tue 1 Dec 2026, 10:00 office time: November is over
});

describe('the payroll run', () => {
  it('REQUIRED, end to end: punches, an approved CL and a lock give Priya unpaid_days 2 and net 28,000', async () => {
    await novemberForPriya();
    const head = await signIn(w.head1.email);
    await approveCl(head);
    const open = await head.get(url(w.o1));
    expect(rowOf(open, w.priya.id)).toMatchObject({ salary: 30000, calendarDays: 30, dayRate: 1000, present: 19, half: 2, absent: 1, paidLeave: 1, unpaidDays: 2, deduction: 2000, net: 28000 });

    await head.post(url(w.o1, '/review')).send({ reviewed: true });
    const locked = await head.post(url(w.o1, '/lock'));
    expect(locked.status).toBe(200);
    expect(locked.body).toMatchObject({ locked: true, lockedByName: 'Vikram Singh', canLock: false });
    const item = await prisma.payrollItem.findFirstOrThrow({ where: { employeeId: w.priya.id } });
    expect([Number(item.monthlySalary), item.daysInMonth, Number(item.dayRate), Number(item.unpaidDays), Number(item.deduction), Number(item.netSalary)]).toEqual([30000, 30, 1000, 2, 2000, 28000]);
    expect([Number(item.present), Number(item.halfDays), Number(item.paidLeave)]).toEqual([19, 2, 1]);
  });

  it('shows one line per office, and a head sees only their own', async () => {
    const admin = await signIn(w.admin.email);
    const all = (await admin.get('/api/payroll?month=2026-11')).body;
    expect(all.map((o: { officeName: string; locked: boolean }) => [o.officeName, o.locked])).toEqual([['Office 1', false], ['Office 2', false]]);
    expect(all[0].totals).toMatchObject({ people: 3, salary: 85000 + 52000 + 48000 });
    const head = await signIn(w.head1.email);
    expect((await head.get('/api/payroll?month=2026-11')).body).toHaveLength(1);
    expect((await head.get(url(w.o2))).status).toBe(403);
    expect((await head.post(url(w.o2, '/lock'))).status).toBe(403);
    expect((await head.get(url(w.o2, '/summary'))).status).toBe(403);
    expect((await (await signIn(w.priya.email)).get(url(w.o1))).status).toBe(403);
  });

  it('uses the salary in force for that month', async () => {
    await novemberForPriya();
    const head = await signIn(w.head1.email);
    await head.post(`/api/employees/${w.priya.id}/salary`).send({ amount: 36000, effectiveMonth: '2026-12' });
    expect(rowOf(await head.get(url(w.o1)), w.priya.id)).toMatchObject({ salary: 30000 });
    expect(rowOf(await head.get(`/api/payroll/${w.o1.id}/2026-12`), w.priya.id)).toMatchObject({ salary: 36000, calendarDays: 31 });
  });

  it('includes someone who left during the month and leaves out someone who left before it', async () => {
    await prisma.employee.update({ where: { id: w.aarav.id }, data: { lastWorkingDate: dbDate('2026-11-20'), status: 'inactive' } });
    const head = await signIn(w.head1.email);
    expect(rowOf(await head.get(url(w.o1)), w.aarav.id)).toMatchObject({ notEmployed: 10 });
    expect(rowOf(await head.get(`/api/payroll/${w.o1.id}/2026-12`), w.aarav.id)).toBeUndefined();
  });
});

describe('the lock checklist', () => {
  it('a month cannot be locked with a missing punch, a pending request, or before it is reviewed', async () => {
    await novemberForPriya();
    await punches(w.aarav, '2026-11-06', ['08:55']); // one punch: MISSING_PUNCH
    const head = await signIn(w.head1.email);
    const priya = await signIn(w.priya.email);
    const leave = await priya.post('/api/leave').send({ type: 'CL', from: '2026-11-12', to: '2026-11-12', halfDay: 'none', reason: 'Personal work' });

    const d1 = (await head.get(url(w.o1))).body;
    expect(d1).toMatchObject({ monthClosed: true, reviewed: false, locked: false, canLock: false });
    expect(d1.missing).toMatchObject([{ employeeId: w.aarav.id, name: 'Aarav Mehta', date: '2026-11-06', inTime: '08:55', request: null }]);
    expect(d1.pending).toMatchObject([{ id: leave.body.id, kind: 'leave' }]);

    await head.post(url(w.o1, '/review')).send({ reviewed: true });
    let res = await head.post(url(w.o1, '/lock'));
    expect([res.status, res.body.message]).toEqual([409, 'Resolve 1 missing punch first.']);

    // Step 1: resolve the missing punch.
    await head.put(`/api/attendance/days/${w.aarav.id}/2026-11-06/manual`).send({ outTime: '18:00', reason: 'Confirmed with the guard register' });
    res = await head.post(url(w.o1, '/lock'));
    expect([res.status, res.body.message]).toEqual([409, 'Decide 1 pending request first.']);

    // Step 2: decide the pending request.
    await head.post(`/api/requests/${leave.body.id}/decision`).send({ decision: 'approved' });
    await head.post(url(w.o1, '/review')).send({ reviewed: false });
    res = await head.post(url(w.o1, '/lock'));
    expect([res.status, res.body.message]).toEqual([409, 'Mark the salaries as reviewed first.']);

    // Step 3: review. Step 4: lock.
    await head.post(url(w.o1, '/review')).send({ reviewed: true });
    expect((await head.get(url(w.o1))).body).toMatchObject({ canLock: true, reviewed: true, reviewedByName: 'Vikram Singh', missing: [], pending: [] });
    expect((await head.post(url(w.o1, '/lock'))).status).toBe(200);
    expect((await head.post(url(w.o1, '/lock'))).status).toBe(409); // already locked
  });

  it('a missing punch with a correction waiting is listed once, with its request', async () => {
    await punches(w.priya, '2026-11-06', ['08:55']);
    const req = await (await signIn(w.priya.email)).post('/api/corrections').send({ date: '2026-11-06', outTime: '18:05', reason: 'Forgot' });
    const d = (await (await signIn(w.head1.email)).get(url(w.o1))).body;
    expect(d.missing).toMatchObject([{ date: '2026-11-06', request: { id: req.body.id, canAct: true } }]);
    expect(d.pending).toEqual([]);
  });

  it('a month cannot be locked before its last day is over, or without a salary', async () => {
    setNow('2026-11-30T12:30:00Z'); // 30 Nov, 6 PM
    const head = await signIn(w.head1.email);
    await head.post(url(w.o1, '/review')).send({ reviewed: true });
    const early = await head.post(url(w.o1, '/lock'));
    expect([early.status, early.body.message]).toEqual([409, 'November 2026 can be locked after its last day.']);

    setNow('2026-12-01T04:30:00Z');
    const head2 = await signIn(w.head1.email);
    await prisma.salaryHistory.deleteMany({ where: { employeeId: w.aarav.id } });
    const res = await head2.post(url(w.o1, '/lock'));
    expect([res.status, res.body.message]).toEqual([409, 'Aarav Mehta has no salary set for November 2026.']);
  });
});

describe('a locked month', () => {
  async function lockNovember() {
    await novemberForPriya();
    const head = await signIn(w.head1.email);
    await approveCl(head);
    await head.put(`/api/attendance/days/${w.priya.id}/2026-11-10/manual`).send({ inTime: '09:00', reason: 'Terminal clock was wrong that morning' });
    await head.post(`/api/employees/${w.priya.id}/leave-adjustments`).send({ type: 'PL', days: 2, note: 'Carried from the old register' });
    await head.put(`/api/employees/${w.aarav.id}/quota`).send({ year: 2026, clQuota: 10, plQuota: 18 });
    await head.post(`/api/employees/${w.aarav.id}/salary`).send({ amount: 50000, effectiveMonth: '2026-12' });
    await head.post(url(w.o1, '/review')).send({ reviewed: true });
    expect((await head.post(url(w.o1, '/lock'))).status).toBe(200);
    return head;
  }

  it('snapshots the figures, freezes attendance, releases payslips and tells everyone', async () => {
    const head = await lockNovember();
    // The corrected late day now counts as present: 1.5 unpaid days.
    expect(rowOf(await head.get(url(w.o1)), w.priya.id)).toMatchObject({ unpaidDays: 1.5, net: 28500 });
    expect(await prisma.payrollItem.count()).toBe(3);
    // Attendance is frozen: every employed day of the month is stored and final.
    expect(await prisma.attendanceDay.count({ where: { employeeId: w.priya.id, finalized: true, date: { gte: dbDate('2026-11-01'), lte: dbDate('2026-11-30') } } })).toBe(30);

    // Payslips are released, and each person is told in the app and by email.
    const priya = await signIn(w.priya.email);
    expect((await priya.get('/api/me/payslips')).body).toEqual([{ employeeId: w.priya.id, name: 'Priya Nair', code: w.priya.code, month: '2026-11', net: 28500, salary: 30000, unpaidDays: 1.5 }]);
    expect((await priya.get('/api/notifications')).body.items[0]).toMatchObject({ text: 'Your November 2026 payslip is ready', link: '/me/payslips' });
    expect(await prisma.emailOutbox.count({ where: { subject: 'Your November 2026 payslip is ready' } })).toBe(3);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'Month locked' } })).detail).toBe('November 2026 locked for Office 1. 3 payslips released.');

    // Nothing in the month can change any more.
    expect((await head.put(`/api/attendance/days/${w.priya.id}/2026-11-05/manual`).send({ inTime: '09:00', outTime: '18:00', reason: 'x' })).status).toBe(409);
    expect((await priya.post('/api/leave').send({ type: 'UNPAID', from: '2026-11-25', to: '2026-11-25', halfDay: 'none', reason: 'x' })).status).toBe(422);
    expect((await priya.post('/api/corrections').send({ date: '2026-11-05', inTime: '09:00', outTime: '18:00', reason: 'x' })).status).toBe(409);
    expect((await head.post('/api/holidays').send({ date: '2026-11-05', name: 'Late holiday' })).status).toBe(409);
    expect((await head.post(`/api/employees/${w.priya.id}/salary`).send({ amount: 99999, effectiveMonth: '2026-11' })).status).toBe(409);
    expect((await head.patch(`/api/employees/${w.priya.id}`).send({ joinDate: '2026-11-15' })).status).toBe(409);
    expect((await head.post(url(w.o1, '/review')).send({ reviewed: false })).status).toBe(409);
    // A salary change for a later month, or a late punch, does not move the locked figures.
    await punches(w.priya, '2026-11-05', ['09:00', '18:00']);
    await (await signIn(w.admin.email)).post(`/api/employees/${w.priya.id}/salary`).send({ amount: 40000, effectiveMonth: '2026-10' });
    expect(rowOf(await head.get(url(w.o1)), w.priya.id)).toMatchObject({ salary: 30000, absent: 1, unpaidDays: 1.5, net: 28500 });
    expect((await head.get('/api/attendance/register?month=2026-11')).body.rows.find((r: { employeeId: string }) => r.employeeId === w.priya.id).days[4]).toMatchObject({ date: '2026-11-05', status: 'absent' });
    // The other office and the next month are untouched.
    expect((await (await signIn(w.head2.email)).get(url(w.o2))).body.locked).toBe(false);
  });

  it('emails the admin a summary with the totals and every manual change of the month', async () => {
    const head = await lockNovember();
    const mail = await prisma.emailOutbox.findFirstOrThrow({ where: { toEmail: w.admin.email, subject: { startsWith: 'November 2026 locked for Office 1' } } });
    expect(mail.subject).toMatch(/^November 2026 locked for Office 1: net Rs\. /);
    for (const text of [
      'November 2026 was locked for Office 1 by Vikram Singh.', 'People: 3', 'Monthly salaries: Rs. 1,63,000', 'Net payable: Rs. ',
      'Attendance corrections (1)', 'Priya Nair, Tue 10 Nov: In 9:00 AM. Entered by Vikram Singh. Reason: Terminal clock was wrong that morning',
      'Leave balance adjustments (1)', 'PL +2. Carried from the old register',
      'Leave quota changes (1)', 'Aarav Mehta', 'Salary changes (1)', 'from December 2026',
    ]) expect(mail.body).toContain(text);
    expect(mail.body).not.toMatch(/50,?000/); // salary amounts are not put in email
    expect((await (await signIn(w.admin.email)).get('/api/notifications')).body.items.map((n: { text: string }) => n.text)).toContain('November 2026 was locked for Office 1 by Vikram Singh');

    // The same summary in the app. Salary amounts are shown to the admin only.
    const forHead = (await head.get(url(w.o1, '/summary'))).body;
    expect(forHead).toMatchObject({ locked: true, lockedByName: 'Vikram Singh', totals: { people: 3, salary: 163000 } });
    expect(forHead.corrections).toMatchObject([{ employeeName: 'Priya Nair', date: '2026-11-10', detail: 'In 9:00 AM', direct: true, byName: 'Vikram Singh' }]);
    expect(forHead.balanceAdjustments).toHaveLength(1); expect(forHead.quotaChanges).toHaveLength(1);
    expect(forHead.salaryChanges).toHaveLength(1); expect(forHead.salaryChanges[0].new).toBeUndefined();
    const forAdmin = (await (await signIn(w.admin.email)).get(url(w.o1, '/summary'))).body;
    expect(forAdmin.salaryChanges[0].new).toMatchObject({ amount: 50000, effectiveMonth: '2026-12' });
  });

  it('only the admin can unlock, with a reason, and it is logged', async () => {
    const head = await lockNovember();
    const admin = await signIn(w.admin.email);
    expect((await head.get(url(w.o1))).body.canUnlock).toBe(false);
    expect((await admin.get(url(w.o1))).body.canUnlock).toBe(true);
    expect((await head.post(url(w.o1, '/unlock')).send({ reason: 'I need to fix something' })).status).toBe(403);
    expect((await admin.post(url(w.o1, '/unlock')).send({})).status).toBe(422);
    expect((await admin.post(url(w.o1, '/unlock')).send({ reason: 'Aarav\'s absence on the 5th was a mistake' })).status).toBe(204);

    expect(await prisma.payrollItem.count()).toBe(0); // payslips are withdrawn
    expect((await (await signIn(w.priya.email)).get('/api/me/payslips')).body).toEqual([]);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'Month unlocked' } });
    expect(log).toMatchObject({ actorName: 'Admin', officeId: w.o1.id });
    expect(log.detail).toBe("November 2026 unlocked for Office 1. 3 payslips withdrawn. Reason: Aarav's absence on the 5th was a mistake");
    expect((await head.get('/api/notifications')).body.items[0].text).toBe("November 2026 was unlocked by the admin: Aarav's absence on the 5th was a mistake");
    expect((await admin.post(url(w.o1, '/unlock')).send({ reason: 'again' })).status).toBe(409);

    // The month is open again: it can change, must be reviewed again, and can be locked again.
    expect((await head.get(url(w.o1))).body).toMatchObject({ locked: false, reviewed: false, canLock: false });
    expect((await head.put(`/api/attendance/days/${w.priya.id}/2026-11-05/manual`).send({ inTime: '09:00', outTime: '18:00', reason: 'Was at the client site' })).status).toBe(204);
    await head.post(url(w.o1, '/review')).send({ reviewed: true });
    expect((await head.post(url(w.o1, '/lock'))).status).toBe(200);
    expect(rowOf(await head.get(url(w.o1)), w.priya.id)).toMatchObject({ unpaidDays: 0.5, net: 29500 });
  });
});

describe('payslips', () => {
  async function locked() {
    await novemberForPriya();
    const head = await signIn(w.head1.email);
    await approveCl(head);
    await head.post(url(w.o1, '/review')).send({ reviewed: true });
    await head.post(url(w.o1, '/lock'));
    return head;
  }

  it('is not there until the month is locked', async () => {
    const res = await (await signIn(w.priya.email)).get(`/api/payslips/${w.priya.id}/2026-11`);
    expect([res.status, res.body.message]).toEqual([404, 'The November 2026 payslip is not released yet. It appears once the month is locked.']);
  });

  it('has everything the payslip needs', async () => {
    const head = await locked();
    const slip = (await head.get(`/api/payslips/${w.priya.id}/2026-11`)).body;
    expect(slip).toMatchObject({
      company: 'SBM Management', month: '2026-11', lockedByName: 'Vikram Singh', lockedAt: '2026-12-01T10:00',
      employee: { name: 'Priya Nair', code: w.priya.code, officeName: 'Office 1', designation: 'Executive' },
      row: { salary: 30000, calendarDays: 30, present: 19, half: 2, absent: 1, paidLeave: 1, unpaidDays: 2, deduction: 2000, net: 28000 },
    });
    const c = payslipContent(slip);
    expect(c.title).toBe('Payslip for November 2026');
    expect(c.company).toBe('SBM Management'); expect(c.office).toBe('Office 1');
    expect(c.employee).toContainEqual(['Employee', 'Priya Nair']); expect(c.employee).toContainEqual(['Employee code', w.priya.code]);
    expect(c.attendance).toEqual([['Calendar days in the month', '30'], ['Present', '19'], ['Half days', '2'], ['Absent', '1'], ['Paid leave (CL / PL)', '1'], ['Unpaid leave', '0'], ['Unpaid days', '2']]);
    expect(c.pay).toEqual([['Monthly salary', 'Rs. 30,000.00'], ['Day rate (salary / 30 days)', 'Rs. 1,000.00'], ['Deduction for 2 unpaid days', '- Rs. 2,000.00']]);
    expect(c.net).toEqual(['Net salary', 'Rs. 28,000.00']);
    expect((await head.get('/api/payslips?month=2026-11')).body.items.map((p: { name: string }) => p.name)).toEqual(['Aarav Mehta', 'Priya Nair', 'Vikram Singh']);
  });

  it('serves a one-page PDF', async () => {
    await locked();
    const priya = await signIn(w.priya.email);
    const res = await priya.get(`/api/payslips/${w.priya.id}/2026-11/pdf`).buffer(true).parse((r, cb) => { const b: Buffer[] = []; r.on('data', (c: Buffer) => b.push(c)); r.on('end', () => cb(null, Buffer.concat(b))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(`inline; filename="payslip-${w.priya.code}-2026-11.pdf"`);
    const pdf = res.body as Buffer;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1500);
    expect(pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)).toHaveLength(1);
  });

  it('goes only to the admin, the employee\'s office head and the employee', async () => {
    await locked();
    const get = async (email: string, tail = '') => (await (await signIn(email)).get(`/api/payslips/${w.priya.id}/2026-11${tail}`)).status;
    expect(await get(w.priya.email)).toBe(200);
    expect(await get(w.head1.email)).toBe(200);
    expect(await get(w.admin.email)).toBe(200);
    expect(await get(w.aarav.email)).toBe(404);      // a colleague
    expect(await get(w.aarav.email, '/pdf')).toBe(404);
    expect(await get(w.head2.email)).toBe(403);      // another office's head
    expect(await get(w.head2.email, '/pdf')).toBe(403);
    expect((await (await signIn(w.priya.email)).get('/api/payslips?month=2026-11')).status).toBe(403);
    expect((await (await signIn(w.head2.email)).get('/api/payslips?month=2026-11')).body.total).toBe(0);
    // A new joiner has no payslip for a month before they joined.
    const late = await makeEmployee(w.o1.id, 'New Joiner', { joinDate: '2026-12-01' });
    expect((await (await signIn(late.email)).get('/api/me/payslips')).body).toEqual([]);
  });
});
