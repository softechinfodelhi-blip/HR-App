// Streaks and badges, office stats, search, the audit log, the overview and the employee home screen.
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { dbDate, istToUtc, monthDays, setNow } from '../src/lib/time';
import { parseDate, parseMonth } from '../src/routes/insights';
import { dayKind, emptyCalendar } from '../src/services/calendar';
import { classifyDay, type DayInput } from '../src/services/day-rules';
import { perfectMonths, refreshGamification, streakOf } from '../src/services/gamification';
import { resetDb, signIn, world } from './helpers';

const RULES = { startSec: 9 * 3600, fullDayMin: 540, halfDayMin: 270 };
const sec = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 3600 + m * 60; };
type Kind = 'present' | 'late' | 'absent' | 'missing' | 'leave' | 'short';
/** Consecutive dates from `from`, each judged as a finished day unless the date is `today`. */
function run(from: string, kinds: (Kind | Partial<DayInput>)[], today = '2027-01-01') {
  let date = from;
  return kinds.map(k => {
    const punches = k === 'present' ? ['09:00', '18:00'] : k === 'late' ? ['09:20', '18:30'] : k === 'short' ? ['09:00', '15:00'] : k === 'missing' ? ['09:00'] : [];
    const d = classifyDay({
      date, today, nowSec: sec('12:00'), kind: dayKind(date, emptyCalendar()), rules: RULES, joinDate: '2020-01-01', homeOfficeId: 'o1',
      punches: punches.map(t => ({ sec: sec(t), officeId: 'o1' })), ...(k === 'leave' ? { leave: { type: 'CL' as const, half: 'none' as const } } : {}), ...(typeof k === 'object' ? k : {}),
    });
    date = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    return d;
  });
}
const P: Kind = 'present';

describe('on-time streak', () => {
  it('counts consecutive working days with status PRESENT', () => {
    // Mon 2 Nov to Sat 7 Nov 2026 are all working days.
    expect(streakOf(run('2026-11-02', [P, P, P, P, P, P]))).toMatchObject({ current: 6, best: 6 });
  });
  it('weekly offs, holidays and leave are skipped and do not break it', () => {
    // Mon 2 to Tue 10 Nov: Sun 8 is off, Wed 4 is leave, Thu 5 is a holiday.
    const days = run('2026-11-02', [P, P, 'leave', { kind: { kind: 'holiday', name: 'Diwali' }, punches: [] }, P, P, P /* Sun: off whatever the punches */, P, P]);
    expect(days[6].engine).toBe('OFF');
    expect(streakOf(days)).toMatchObject({ current: 6, best: 6 });
  });
  it('a half day, an absence or a missing punch breaks it', () => {
    for (const bad of ['late', 'short', 'absent', 'missing'] as Kind[]) {
      expect(streakOf(run('2026-11-02', [P, P, P, bad, P, P]))).toMatchObject({ current: 2, best: 3 });
    }
  });
  it('today does not break it while it is open, and counts once the full day is done', () => {
    const notIn = run('2026-11-02', [P, P, P, 'absent'], '2026-11-05'); // Thu 5 Nov is today, nobody is judged yet
    expect(notIn[3]).toMatchObject({ engine: null, status: 'not_in' });
    expect(streakOf(notIn)).toMatchObject({ current: 3, best: 3 });
    expect(streakOf(run('2026-11-02', [P, P, P, P], '2026-11-05'))).toMatchObject({ current: 4, best: 4 });
  });
  it('remembers the best streak and the date each badge length was reached', () => {
    // 14 calendar days from Mon 2 Nov hold 11 working days (the 8th and 15th are Sundays, the 14th a 2nd Saturday), then a late day, then 2 more.
    const days = run('2026-11-02', [P, P, P, P, P, P, P, P, P, P, P, P, P, P, 'late', P, P]);
    const s = streakOf(days);
    expect(s).toMatchObject({ current: 2, best: 11 });
    expect(s.reached.get(10)).toBe('2026-11-12');
    expect(s.reached.has(25)).toBe(false);
  });
  it('a perfect month has every working day PRESENT, with leave allowed, and only counts once the month is over', () => {
    const all = (month: string, bad: Record<string, Kind> = {}) => monthDays(month).map(d => run(d, [bad[d] ?? P])[0]);
    expect(perfectMonths(all('2026-10'), '2026-11')).toEqual(['2026-10']);
    expect(perfectMonths(all('2026-10', { '2026-10-06': 'leave' }), '2026-11')).toEqual(['2026-10']);
    expect(perfectMonths(all('2026-10', { '2026-10-06': 'late' }), '2026-11')).toEqual([]);
    expect(perfectMonths(all('2026-10'), '2026-10')).toEqual([]);                 // the month is not over
    expect(perfectMonths(all('2026-10').slice(5), '2026-11')).toEqual([]);         // not there for the whole month
  });
});

describe('search helpers', () => {
  it('reads dates and months the way people type them', () => {
    for (const q of ['2026-11-23', '23/11/2026', '23/11', '23 nov', '23rd November', 'nov 23', 'November 23 2026']) expect(parseDate(q, 2026)).toBe('2026-11-23');
    expect(parseDate('31/02', 2026)).toBeNull(); expect(parseDate('priya', 2026)).toBeNull(); expect(parseDate('nov', 2026)).toBeNull();
    expect(parseMonth('november', 2026)).toBe('2026-11'); expect(parseMonth('Nov 2025', 2026)).toBe('2025-11'); expect(parseMonth('2026-11', 2026)).toBe('2026-11');
    expect(parseMonth('priya', 2026)).toBeNull(); expect(parseMonth('no', 2026)).toBeNull();
  });
});

// ---------------------------------------------------------------------
type World = Awaited<ReturnType<typeof world>>;
let w: World;
let deviceId: string;
const working = (from: string, to: string) => { const out: string[] = []; for (let d = from; d <= to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) if (dayKind(d, emptyCalendar()).kind === 'working') out.push(d); return out; };
async function punch(e: { terminalUserId: string | null }, date: string, times = ['09:00', '18:00']) {
  await prisma.rawPunch.createMany({ data: times.map(t => ({ deviceId, terminalUserId: e.terminalUserId!, punchTime: istToUtc(date, t), rawLine: 'x' })) });
}

beforeEach(async () => {
  await resetDb();
  w = await world();
  deviceId = (await prisma.device.create({ data: { serialNumber: 'SN001', officeId: w.o1.id, name: 'Office 1 door' } })).id;
  setNow('2026-11-10T06:30:00Z'); // Tue 10 Nov 2026, 12:00
  // Priya: on time every working day from 1 Oct to 9 Nov (25 in October, 7 in November).
  for (const d of working('2026-10-01', '2026-11-09')) await punch(w.priya, d);
  // Aarav: November only, with one late day on the 5th.
  for (const d of working('2026-11-02', '2026-11-09')) await punch(w.aarav, d, d === '2026-11-05' ? ['09:20', '18:30'] : ['09:00', '18:00']);
});

describe('streaks and badges', () => {
  it('the nightly job stores the best streak and awards badges once, with a note in the app', async () => {
    expect(await refreshGamification(prisma)).toBe(3); // Priya: 10 days, 25 days, perfect October
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: w.priya.id } })).bestStreak).toBe(32);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: w.aarav.id } })).bestStreak).toBe(3);
    const badges = await prisma.badge.findMany({ where: { employeeId: w.priya.id }, orderBy: { kind: 'asc' } });
    expect(badges.map(b => [b.kind, b.ref, b.earnedOn.toISOString().slice(0, 10)])).toEqual([['perfect_month', '2026-10', '2026-10-31'], ['streak_10', '', '2026-10-13'], ['streak_25', '', '2026-10-31']]);
    expect(await prisma.badge.count({ where: { employeeId: { not: w.priya.id } } })).toBe(0);
    expect((await prisma.notification.findMany({ where: { userId: w.priya.userId, type: 'badge_earned' } })).map(n => (n.payload as { text: string }).text).sort()).toEqual([
      '10 days on time in a row. You earned a badge.', '25 days on time in a row. You earned a badge.', 'A perfect October 2026: on time every working day.',
    ]);
    expect(await prisma.emailOutbox.count()).toBe(0); // badges are announced in the app only
    expect(await refreshGamification(prisma)).toBe(0);
  });

  it('the best streak is kept after the streak breaks', async () => {
    await refreshGamification(prisma);
    setNow('2026-11-12T06:30:00Z'); // Priya did not come in on the 10th or the 11th
    await refreshGamification(prisma);
    const game = (await (await signIn(w.priya.email)).get(`/api/employees/${w.priya.id}/badges`)).body;
    expect(game.streak).toEqual({ current: 0, best: 32 });
    expect(game.badges.map((b: { key: string; earned: boolean }) => [b.key, b.earned])).toEqual([['streak_10', true], ['streak_25', true], ['streak_50', false], ['streak_100', false], ['perfect_month', true]]);
    expect(game.badges[2]).toMatchObject({ label: '50 days on time', hint: '50 more days' });
    expect(game.badges[4]).toMatchObject({ label: 'Perfect month', hint: 'Earned for October 2026', count: 1 });
  });

  it('are visible only to the employee, their office head and the admin', async () => {
    const get = async (email: string) => (await (await signIn(email)).get(`/api/employees/${w.priya.id}/badges`));
    expect((await get(w.priya.email)).body.streak).toEqual({ current: 32, best: 32 });
    expect((await get(w.head1.email)).status).toBe(200);
    expect((await get(w.admin.email)).status).toBe(200);
    expect((await get(w.aarav.email)).status).toBe(404); // a colleague
    expect((await get(w.head2.email)).status).toBe(403); // another office's head
  });

  it('never returns a ranking of individuals: office stats carry office figures only', async () => {
    const admin = await signIn(w.admin.email);
    const stats = (await admin.get('/api/stats/offices?month=2026-11')).body;
    expect(Object.keys(stats[0]).sort()).toEqual(['best', 'expected', 'lastMonth', 'month', 'name', 'officeId', 'onTime', 'onTimeCount']);
    expect(JSON.stringify(stats)).not.toMatch(/Priya|Aarav|employeeId|streak/);
    for (const path of ['/api/stats/employees', '/api/stats/leaderboard', '/api/leaderboard', '/api/streaks']) expect((await admin.get(path)).status).toBe(404);
    // The people list shows nobody else's streak to a colleague, and the board carries no streaks at all.
    expect(JSON.stringify((await (await signIn(w.head1.email)).get('/api/attendance/today')).body)).not.toMatch(/streak/i);
  });
});

describe('office on-time rate and office of the month', () => {
  it('is the share of expected check-ins that were on time, and the best office of last month is marked', async () => {
    const admin = await signIn(w.admin.email);
    const stats = (await admin.get('/api/stats/offices?month=2026-11')).body;
    // Office 1, 2 to 9 Nov: 7 working days x 3 people = 21 expected. Priya 7 on time, Aarav 6, Vikram 0. Today is not counted yet.
    expect(stats[0]).toMatchObject({ name: 'Office 1', onTime: 62, expected: 21, onTimeCount: 13, lastMonth: 33, best: true });
    expect(stats[1]).toMatchObject({ name: 'Office 2', onTime: 0, expected: 14, lastMonth: 0, best: false });
    // A head gets their own office only.
    const mine = (await (await signIn(w.head2.email)).get('/api/stats/offices')).body;
    expect(mine).toHaveLength(1); expect(mine[0]).toMatchObject({ name: 'Office 2', best: false });
    expect((await (await signIn(w.head2.email)).get(`/api/stats/offices?office=${w.o1.id}`)).status).toBe(403);
    // The same figures feed the board.
    expect((await admin.get('/api/attendance/today')).body.offices.map((o: { onTime: number; lastMonth: number; best: boolean }) => [o.onTime, o.lastMonth, o.best])).toEqual([[62, 33, true], [0, 0, false]]);
  });

  it('full-day leave is not an expected check-in', async () => {
    await prisma.leaveRequest.create({ data: { employeeId: w.head1.id, type: 'UNPAID', fromDate: dbDate('2026-11-02'), toDate: dbDate('2026-11-09'), days: 7, reason: 'x', status: 'approved' } });
    const stats = (await (await signIn(w.admin.email)).get('/api/stats/offices?month=2026-11')).body;
    expect(stats[0]).toMatchObject({ expected: 14, onTimeCount: 13, onTime: 93 });
  });
});

describe('organisation overview', () => {
  it('gives the admin every office on one page, and nobody else', async () => {
    await punch(w.priya, '2026-11-10', ['08:58']);
    await (await signIn(w.aarav.email)).post('/api/corrections').send({ date: '2026-11-05', inTime: '09:00', reason: 'Terminal was slow' });
    const res = await (await signIn(w.admin.email)).get('/api/overview');
    expect(res.body).toMatchObject({ date: '2026-11-10', time: '12:00', month: '2026-11' });
    expect(res.body.offices[0]).toMatchObject({
      name: 'Office 1', headName: 'Vikram Singh', headcount: 3, today: { expected: 3, in: 1, notIn: 2, onLeave: 0 },
      pendingRequests: 1, escalated: 0, onTime: 64, best: true, payroll: { month: '2026-10', locked: false },
      terminal: { serial: 'SN001', online: false },
    });
    expect(res.body.offices[1]).toMatchObject({ name: 'Office 2', headcount: 2, terminal: null, pendingRequests: 0 });
    expect(res.body.totals).toMatchObject({ offices: 2, people: 5, in: 1, pendingRequests: 1, waitingForYou: 0, monthsToLock: 2 });
    expect((await (await signIn(w.head1.email)).get('/api/overview')).status).toBe(403);
    expect((await (await signIn(w.priya.email)).get('/api/overview')).status).toBe(403);
  });
});

describe('global search', () => {
  type Hit = { type: string; label: string; sub: string; to: string };
  const find = async (email: string, q: string, office?: string) => (await (await signIn(email)).get('/api/search').query({ q, ...(office ? { office } : {}) })).body as Hit[];

  it('finds people, by name or code, inside the caller\'s offices', async () => {
    expect(await find(w.admin.email, 'sunita')).toMatchObject([{ type: 'person', label: 'Sunita Agarwal', to: `/people/${w.sunita.id}` }]);
    expect((await find(w.head1.email, w.priya.code))[0]).toMatchObject({ type: 'person', label: 'Priya Nair', sub: `${w.priya.code} · Office 1 · Executive` });
    expect(await find(w.head1.email, 'sunita')).toEqual([]);                    // another office: not found
    expect(await find(w.admin.email, 'a', w.o2.id)).toSatisfy((hits: Hit[]) => hits.filter(h => h.type === 'person').every(h => h.sub.includes('Office 2')));
    expect((await (await signIn(w.head1.email)).get('/api/search').query({ q: 'a', office: w.o2.id })).status).toBe(403);
    expect(await find(w.admin.email, '')).toEqual([]);
  });

  it('finds a date, requests on it, requests by name, payslips and screens', async () => {
    const leave = await (await signIn(w.priya.email)).post('/api/leave').send({ type: 'UNPAID', from: '2026-11-23', to: '2026-11-24', halfDay: 'none', reason: 'Wedding' });
    expect(leave.status).toBe(201);
    const byDate = await find(w.head1.email, '23 nov');
    expect(byDate[0]).toEqual({ type: 'date', label: 'Mon 23 Nov 2026', sub: 'Attendance register', to: '/attendance?month=2026-11&date=2026-11-23' });
    expect(byDate[1]).toMatchObject({ type: 'request', label: 'Priya Nair · Unpaid leave · 23 to 24 Nov', sub: 'Leave request · pending', to: '/leave' });
    expect((await find(w.head1.email, 'priya')).map(h => h.type)).toEqual(['person', 'request']);
    expect(await find(w.head2.email, '23 nov')).toHaveLength(1); // the date, but not Office 1's request

    // Payslips appear once October is locked.
    const run = await prisma.payrollRun.create({ data: { officeId: w.o1.id, month: '2026-10', status: 'locked', lockedAt: new Date() } });
    await prisma.payrollItem.create({ data: { runId: run.id, employeeId: w.priya.id, employeeName: 'Priya Nair', employeeCode: w.priya.code, monthlySalary: 52000, daysInMonth: 31, present: 25, halfDays: 0, absent: 0, paidLeave: 0, unpaidLeave: 0, notEmployed: 0, unpaidDays: 0, dayRate: 1677.42, deduction: 0, netSalary: 52000 } });
    expect((await find(w.head1.email, 'priya')).find(h => h.type === 'payslip')).toEqual({ type: 'payslip', label: 'Priya Nair · October 2026', sub: `Payslip · ${w.priya.code}`, to: `/payroll/payslips/${w.priya.id}/2026-10` });
    expect((await find(w.head1.email, 'october')).map(h => h.type)).toEqual(['date', 'payslip']);
    expect((await find(w.head2.email, 'october')).map(h => h.type)).toEqual(['date']);

    expect(await find(w.head1.email, 'audit')).toEqual([{ type: 'screen', label: 'Audit log', sub: 'Go to screen', to: '/settings/audit' }]);
    expect((await find(w.head1.email, 'offices')).filter(h => h.type === 'screen')).toEqual([]); // admin-only screen
    expect((await find(w.admin.email, 'offices')).filter(h => h.type === 'screen')).toHaveLength(1);
  });

  it('an employee searches only their own record', async () => {
    await (await signIn(w.priya.email)).post('/api/leave').send({ type: 'UNPAID', from: '2026-11-23', to: '2026-11-24', halfDay: 'none', reason: 'Wedding' });
    expect(await find(w.aarav.email, 'priya')).toEqual([]);
    expect(await find(w.aarav.email, 'wedding')).toEqual([]);
    expect(await find(w.priya.email, 'wedding')).toMatchObject([{ type: 'request', label: 'Unpaid leave · 23 to 24 Nov', to: '/me/leave' }]);
    expect(await find(w.priya.email, '23/11')).toMatchObject([{ type: 'date', to: '/me/attendance?month=2026-11' }]);
    expect((await find(w.priya.email, 'leave')).filter(h => h.type === 'screen').map(h => h.to)).toEqual(['/me/leave', '/me/leave/apply']);
  });
});

describe('audit log', () => {
  it('lists every change, newest first, scoped by office, with filters', async () => {
    const admin = await signIn(w.admin.email);
    const head = await signIn(w.head1.email);
    await head.patch(`/api/employees/${w.priya.id}`).send({ designation: 'Team Lead' });
    await head.post(`/api/employees/${w.priya.id}/salary`).send({ amount: 60000, effectiveMonth: '2026-12' });
    await (await signIn(w.head2.email)).patch(`/api/employees/${w.sunita.id}`).send({ phone: '9999999999' });
    await admin.patch('/api/settings').send({ companyName: 'SBM Test' });

    const all = (await admin.get('/api/audit')).body;
    expect(all).toMatchObject({ total: 4, page: 1, pageSize: 50 });
    expect(all.items.map((l: { action: string }) => l.action)).toEqual(['Settings changed', 'Employee updated', 'Salary changed', 'Employee updated']);
    expect(all.items[0]).toMatchObject({ actorName: 'Admin', officeId: null, entity: 'settings', old: { companyName: 'SBM Management' }, new: { companyName: 'SBM Test' } });
    expect(all.items[0].at).toBe('2026-11-10T12:00');

    // A head sees their own office only. Entries with no office are the admin's.
    const mine = (await head.get('/api/audit')).body;
    expect(mine.items.map((l: { action: string; actorName: string }) => [l.action, l.actorName])).toEqual([['Salary changed', 'Vikram Singh'], ['Employee updated', 'Vikram Singh']]);
    expect((await head.get(`/api/audit?office=${w.o2.id}`)).status).toBe(403);
    expect((await (await signIn(w.priya.email)).get('/api/audit')).status).toBe(403);
    expect((await admin.get(`/api/audit?office=${w.o2.id}`)).body.total).toBe(1);

    // Salary amounts in old and new values go to the admin only.
    expect(mine.items[0].new).toBeUndefined(); expect(mine.items[0].detail).not.toMatch(/60/);
    expect(mine.items[1]).toMatchObject({ old: { designation: 'Executive' }, new: { designation: 'Team Lead' } });
    expect(all.items[2]).toMatchObject({ old: { amount: 52000 }, new: { amount: 60000, effectiveMonth: '2026-12' } });

    expect((await admin.get('/api/audit?search=salary')).body.total).toBe(1);
    expect((await admin.get('/api/audit?search=vikram')).body.total).toBe(2);
    expect((await admin.get('/api/audit?month=2026-11')).body.total).toBe(4);
    expect((await admin.get('/api/audit?month=2026-10')).body.total).toBe(0);
    const page = (await admin.get('/api/audit?pageSize=3&page=2')).body;
    expect(page.items).toHaveLength(1); expect(page).toMatchObject({ total: 4, page: 2, pageSize: 3 });
  });
});

describe('employee home and profile', () => {
  it('puts the whole home screen in one call', async () => {
    await prisma.leaveLedger.create({ data: { employeeId: w.aarav.id, leaveType: 'CL', deltaDays: 4, reason: 'opening', entryDate: dbDate('2026-01-01') } });
    await prisma.holiday.create({ data: { officeId: w.o1.id, date: dbDate('2026-11-24'), name: 'Guru Nanak Jayanti' } });
    await prisma.rawPunch.create({ data: { deviceId, terminalUserId: w.aarav.terminalUserId!, punchTime: istToUtc('2026-10-29', '09:00'), rawLine: 'x' } }); // one punch in October
    await punch(w.aarav, '2026-11-10', ['08:57']);
    const aarav = await signIn(w.aarav.email);
    const req = await aarav.post('/api/leave').send({ type: 'CL', from: '2026-11-18', to: '2026-11-18', halfDay: 'none', reason: 'Bank work' });
    const home = (await aarav.get('/api/me/home')).body;
    expect(home).toMatchObject({
      employee: { name: 'Aarav Mehta', salary: 48000, officeName: 'Office 1' }, time: '12:00', dayKindLabel: '',
      today: { date: '2026-11-10', status: 'working', label: 'In since 8:57 AM', late: false },
      streak: { current: 3, best: 3 }, month: { present: 6, half: 1, absent: 0, leave: 0 },
      balances: { cl: { balance: 4, pending: 1, available: 3 } }, nextHoliday: { date: '2026-11-24', name: 'Guru Nanak Jayanti' },
      latestPayslip: null, firstDays: false,
    });
    expect(home.pending).toMatchObject([{ id: req.body.id, kind: 'leave' }]);
    expect(home.missing).toMatchObject([{ date: '2026-10-29', status: 'missing' }]);
    expect(home.badges).toHaveLength(5);
    expect(home.badges[0]).toMatchObject({ key: 'streak_10', earned: false, hint: '7 more days' });
    // Once a correction is waiting for that day, it is no longer listed as something to do.
    await aarav.post('/api/corrections').send({ date: '2026-10-29', outTime: '18:00', reason: 'Forgot' });
    expect((await aarav.get('/api/me/home')).body.missing).toEqual([]);
    expect((await (await signIn(w.admin.email)).get('/api/me/home')).status).toBe(403);
  });

  it('the profile carries this month, the streak, badges and recent requests', async () => {
    await (await signIn(w.priya.email)).post('/api/leave').send({ type: 'UNPAID', from: '2026-11-23', to: '2026-11-23', halfDay: 'none', reason: 'Wedding' });
    const p = (await (await signIn(w.head1.email)).get(`/api/employees/${w.priya.id}`)).body;
    expect(p).toMatchObject({ month: { month: '2026-11', present: 7, half: 0, absent: 0, missing: 0 }, streak: { current: 32, best: 32 }, canEdit: true });
    expect(p.recent).toMatchObject([{ kind: 'leave', title: 'Unpaid leave · Mon 23 Nov', status: 'pending', canAct: true }]);
    expect(p.badges.filter((b: { earned: boolean }) => b.earned).map((b: { key: string }) => b.key)).toEqual(['streak_10', 'streak_25']);
  });
});
