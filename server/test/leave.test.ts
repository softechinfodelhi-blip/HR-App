// Leave: ledger, credit, year end, requests, approval, escalation and notifications.
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { dbDate, setNow } from '../src/lib/time';
import { leaveBookkeeping } from '../src/jobs';
import { closeLeaveYear, creditFromMonth, creditLeave, escalateRequests, ledgerSums, monthlyShare } from '../src/services/leave';
import { makeEmployee, resetDb, signIn, world, type Agent } from './helpers';

type World = Awaited<ReturnType<typeof world>>;
let w: World;
const NOON = '2026-11-10T06:30:00Z'; // Tue 10 Nov 2026, 12:00 office time

beforeEach(async () => {
  await resetDb();
  w = await world();
  setNow(NOON);
});

/** Opening balance without the credit job: one ledger row per type. */
async function give(employeeId: string, cl: number, pl: number) {
  await prisma.leaveLedger.createMany({ data: [
    { employeeId, leaveType: 'CL', deltaDays: cl, reason: 'opening', entryDate: dbDate('2026-01-01') },
    { employeeId, leaveType: 'PL', deltaDays: pl, reason: 'opening', entryDate: dbDate('2026-01-01') },
  ] });
}
const apply = (agent: Agent, body: object) => agent.post('/api/leave').send({ type: 'CL', halfDay: 'none', reason: 'Family function', ...body });
const decide = (agent: Agent, id: string, decision = 'approved', comment?: string) => agent.post(`/api/requests/${id}/decision`).send({ decision, comment });
const balance = async (agent: Agent) => (await agent.get('/api/me/balances')).body;
const dayStatus = async (agent: Agent, employeeId: string, date: string) => (await agent.get(`/api/attendance/days/${employeeId}/${date}`)).body.day;

describe('monthly credit', () => {
  it('starts from the first full month after joining', () => {
    expect(creditFromMonth('2026-03-15')).toBe('2026-04');
    expect(creditFromMonth('2026-03-01')).toBe('2026-03'); // joined on the 1st: that month is a full month
    expect(creditFromMonth('2026-12-02')).toBe('2027-01');
  });

  it('credits quota / 12, and the twelve shares add up to the quota', () => {
    expect(monthlyShare(12, 1)).toBe(1);
    expect(monthlyShare(18, 7)).toBe(1.5);
    for (const quota of [12, 18, 10, 7, 15.5, 0]) {
      const total = Array.from({ length: 12 }, (_, i) => monthlyShare(quota, i + 1)).reduce((a, b) => a + b, 0);
      expect(Math.round(total * 100) / 100).toBe(quota);
    }
  });

  it('writes one credit per person, type and month, dated the 1st, and only once', async () => {
    setNow('2026-01-01T00:00:00Z');
    expect(await creditLeave(prisma, '2026-01')).toBe(10); // 5 people x CL and PL
    expect(await creditLeave(prisma, '2026-01')).toBe(0);
    expect(await ledgerSums(prisma, w.priya.id)).toEqual({ CL: 1, PL: 1.5 });
    const row = await prisma.leaveLedger.findFirstOrThrow({ where: { employeeId: w.priya.id, leaveType: 'CL' } });
    expect(row).toMatchObject({ reason: 'credit', ref: '2026-01', createdById: null });
    expect(row.entryDate.toISOString().slice(0, 10)).toBe('2026-01-01');
    await creditLeave(prisma, '2026-02');
    expect(await ledgerSums(prisma, w.priya.id)).toEqual({ CL: 2, PL: 3 });
  });

  it('catches up months that were missed, within the leave year', async () => {
    expect(await creditLeave(prisma, '2026-11')).toBe(5 * 2 * 11);
    expect(await ledgerSums(prisma, w.priya.id)).toEqual({ CL: 11, PL: 16.5 });
  });

  it('a mid-month joiner gets nothing for the joining month, and nobody is credited after leaving', async () => {
    const late = await makeEmployee(w.o1.id, 'Mid Joiner', { joinDate: '2026-09-15' });
    const first = await makeEmployee(w.o1.id, 'First Joiner', { joinDate: '2026-09-01' });
    await prisma.employee.update({ where: { id: w.aarav.id }, data: { lastWorkingDate: dbDate('2026-03-20') } });
    await creditLeave(prisma, '2026-11');
    expect(await ledgerSums(prisma, late.id)).toEqual({ CL: 2, PL: 3 }); // October and November
    expect(await ledgerSums(prisma, first.id)).toEqual({ CL: 3, PL: 4.5 }); // September too
    expect(await ledgerSums(prisma, w.aarav.id)).toEqual({ CL: 3, PL: 4.5 }); // January to March
  });

  it('uses each person\'s own quota', async () => {
    await prisma.leaveQuota.update({ where: { employeeId_year: { employeeId: w.priya.id, year: 2026 } }, data: { clPerYear: 6, plPerYear: 24 } });
    await creditLeave(prisma, '2026-02');
    expect(await ledgerSums(prisma, w.priya.id)).toEqual({ CL: 1, PL: 4 });
  });
});

describe('year end', () => {
  it('on 31 December CL goes to 0 and PL carries over up to the cap', async () => {
    await give(w.priya.id, 7.5, 42);  // PL over the cap of 30
    await give(w.aarav.id, 3, 12);    // PL under the cap
    expect(await closeLeaveYear(prisma, 2026)).toBe(3);
    expect(await ledgerSums(prisma, w.priya.id)).toEqual({ CL: 0, PL: 30 });
    expect(await ledgerSums(prisma, w.aarav.id)).toEqual({ CL: 0, PL: 12 });
    const rows = await prisma.leaveLedger.findMany({ where: { employeeId: w.priya.id, reason: { in: ['lapse', 'carry_cap'] } }, orderBy: { leaveType: 'asc' } });
    expect(rows.map(r => [r.leaveType, Number(r.deltaDays), r.reason, r.entryDate.toISOString().slice(0, 10)])).toEqual([['CL', -7.5, 'lapse', '2026-12-31'], ['PL', -12, 'carry_cap', '2026-12-31']]);
    expect(await closeLeaveYear(prisma, 2026)).toBe(0); // only once
  });

  it('the nightly job on 1 January closes the old year, then credits January with last year\'s quota', async () => {
    await give(w.priya.id, 5, 40);
    await prisma.leaveQuota.update({ where: { employeeId_year: { employeeId: w.priya.id, year: 2026 } }, data: { clPerYear: 6, plPerYear: 24 } });
    setNow('2026-12-31T18:35:00Z'); // 00:05 on 1 Jan 2027, office time
    const r = await leaveBookkeeping();
    expect(r.yearEnd).toBe(2);
    expect(await ledgerSums(prisma, w.priya.id)).toEqual({ CL: 0.5, PL: 32 }); // 0 + 6/12 and 30 + 24/12
    expect(await prisma.leaveQuota.findUnique({ where: { employeeId_year: { employeeId: w.priya.id, year: 2027 } } })).toMatchObject({ year: 2027 });
    expect((await leaveBookkeeping())).toEqual({ yearEnd: 0, credits: 0 });
  });

  it('respects the carry cap setting', async () => {
    await give(w.priya.id, 0, 42);
    await prisma.setting.create({ data: { key: 'plCarryMax', value: 20 } });
    await closeLeaveYear(prisma, 2026);
    expect((await ledgerSums(prisma, w.priya.id)).PL).toBe(20);
  });
});

describe('asking for leave', () => {
  it('counts working days only: weekly offs and holidays in the range are free', async () => {
    await give(w.priya.id, 10, 10);
    await prisma.holiday.create({ data: { officeId: w.o1.id, date: dbDate('2026-11-24'), name: 'Guru Nanak Jayanti' } });
    const priya = await signIn(w.priya.email);
    const preview = (body: object) => priya.post('/api/leave/preview').send({ type: 'CL', halfDay: 'none', ...body });
    // Fri 20 to Wed 25 Nov: Sun 22 is off, Tue 24 is a holiday. Sat 21 is the 3rd Saturday, so it is worked.
    expect((await preview({ from: '2026-11-20', to: '2026-11-25' })).body).toEqual({ days: 4, ok: true, message: null, balance: 10, balanceAfter: 6 });
    // Fri 13 to Mon 16: Sat 14 is the 2nd Saturday, Sun 15 is off.
    expect((await preview({ from: '2026-11-13', to: '2026-11-16' })).body).toMatchObject({ days: 2, ok: true });
    expect((await preview({ from: '2026-11-18', to: '2026-11-18', halfDay: 'first' })).body).toMatchObject({ days: 0.5, ok: true, balanceAfter: 9.5 });
    expect((await preview({ from: '2026-11-22', to: '2026-11-22' })).body).toMatchObject({ days: 0, ok: false, message: 'There are no working days in these dates.' });
    expect((await preview({ from: '2026-11-18', to: '2026-11-19', halfDay: 'second' })).body).toMatchObject({ ok: false, message: 'A half day can only be taken on a single date.' });
    expect((await preview({ from: '2026-11-19', to: '2026-11-18' })).body).toMatchObject({ ok: false });
    expect((await preview({})).body).toMatchObject({ ok: false, message: 'Pick the dates.' });
    expect((await preview({ type: 'UNPAID', from: '2026-11-18', to: '2026-11-19' })).body).toEqual({ days: 2, ok: true, message: null, balance: null, balanceAfter: null });
  });

  it('paid leave cannot go past the balance: the rest has to be unpaid', async () => {
    await give(w.priya.id, 1.5, 0);
    const priya = await signIn(w.priya.email);
    const over = await apply(priya, { from: '2026-11-18', to: '2026-11-19' });
    expect(over.status).toBe(422);
    expect(over.body.message).toBe('You have 1.5 days of CL available. Shorten the dates, or ask for the rest as unpaid leave.');
    expect((await apply(priya, { type: 'PL', from: '2026-11-18', to: '2026-11-18' })).status).toBe(422); // no PL at all
    expect((await apply(priya, { from: '2026-11-18', to: '2026-11-18' })).status).toBe(201);
    // A pending request holds its days: only 0.5 is available now.
    expect(await balance(priya)).toMatchObject({ cl: { balance: 1.5, pending: 1, available: 0.5, quota: 12 } });
    expect((await apply(priya, { from: '2026-11-19', to: '2026-11-19' })).status).toBe(422);
    expect((await apply(priya, { from: '2026-11-19', to: '2026-11-19', halfDay: 'second' })).status).toBe(201);
    expect((await apply(priya, { type: 'UNPAID', from: '2026-11-20', to: '2026-11-21' })).status).toBe(201); // unpaid has no limit
  });

  it('refuses overlapping leave, a missing reason and dates outside employment', async () => {
    await give(w.priya.id, 10, 10);
    const priya = await signIn(w.priya.email);
    expect((await apply(priya, { from: '2026-11-18', to: '2026-11-19' })).status).toBe(201);
    const clash = await apply(priya, { type: 'PL', from: '2026-11-19', to: '2026-11-20' });
    expect(clash.status).toBe(422); expect(clash.body.message).toBe('You already have leave on 18 to 19 Nov.');
    expect((await apply(priya, { from: '2026-11-25', to: '2026-11-25', reason: ' ' })).status).toBe(422);
    expect((await apply(priya, { from: '2023-12-29', to: '2023-12-29' })).status).toBe(422);
    expect((await apply(await signIn(w.admin.email), { from: '2026-11-25', to: '2026-11-25' })).status).toBe(403);
  });
});

describe('approval', () => {
  it('employee applies, head approves: a negative ledger row, the days become leave, both are told', async () => {
    await give(w.priya.id, 5, 5);
    const priya = await signIn(w.priya.email);
    const head = await signIn(w.head1.email);
    const made = await apply(priya, { from: '2026-11-18', to: '2026-11-19' });
    expect(made.body).toMatchObject({ kind: 'leave', status: 'pending', title: 'CL · 18 to 19 Nov', detail: '2 days', days: 2, leaveType: 'CL', canAct: false });
    // The head is told, in the app and by email.
    expect((await head.get('/api/notifications')).body).toMatchObject({ unread: 1, items: [{ text: 'Priya Nair asked for CL, 18 to 19 Nov', link: '/leave', read: false }] });
    expect(await prisma.emailOutbox.count({ where: { toEmail: w.head1.email, subject: 'Priya Nair asked for CL, 18 to 19 Nov' } })).toBe(1);
    expect((await head.get('/api/requests/queue')).body).toMatchObject([{ id: made.body.id, canAct: true }]);
    expect((await head.get('/api/attendance/today')).body.counts.waiting).toBe(1);

    expect((await decide(head, made.body.id)).status).toBe(204);
    const ledger = await prisma.leaveLedger.findFirstOrThrow({ where: { reason: 'leave' } });
    expect(ledger).toMatchObject({ employeeId: w.priya.id, leaveType: 'CL', ref: made.body.id, createdById: w.head1.userId });
    expect(Number(ledger.deltaDays)).toBe(-2);
    expect(await balance(priya)).toMatchObject({ cl: { balance: 3, pending: 0, available: 3 } });
    expect(await dayStatus(head, w.priya.id, '2026-11-18')).toMatchObject({ status: 'leave', label: 'On leave (CL)', unpaid: 0 });
    expect(await prisma.attendanceDay.count({ where: { employeeId: w.priya.id, status: 'ON_LEAVE' } })).toBe(2);
    // The employee is told, in the app and by email. The decision is in the audit log.
    const mine = (await priya.get('/api/notifications')).body;
    expect(mine.items[0]).toMatchObject({ text: 'Your CL for 18 to 19 Nov was approved', link: '/me/leave' });
    expect(await prisma.emailOutbox.count({ where: { toEmail: w.priya.email } })).toBe(1);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'Leave approved' } })).actorName).toBe('Vikram Singh');
    await priya.post('/api/notifications/read');
    expect((await priya.get('/api/notifications')).body).toMatchObject({ unread: 0, items: [{ read: true }] });
    expect((await head.get('/api/requests/queue')).body).toEqual([]);
  });

  it('rejecting needs a comment, writes no ledger row, and the employee sees the reason', async () => {
    await give(w.priya.id, 5, 5);
    const priya = await signIn(w.priya.email);
    const head = await signIn(w.head1.email);
    const made = await apply(priya, { from: '2026-11-18', to: '2026-11-19' });
    expect((await decide(head, made.body.id, 'rejected')).status).toBe(422);
    expect((await decide(head, made.body.id, 'rejected', 'Month end, please pick other dates')).status).toBe(204);
    expect(await prisma.leaveLedger.count({ where: { reason: 'leave' } })).toBe(0);
    expect((await priya.get('/api/me/requests')).body).toMatchObject([{ status: 'rejected', comment: 'Month end, please pick other dates', decidedByName: 'Vikram Singh' }]);
    expect(await balance(priya)).toMatchObject({ cl: { balance: 5, available: 5 } });
  });

  it('unpaid leave writes no ledger row and the day is unpaid', async () => {
    const priya = await signIn(w.priya.email);
    const head = await signIn(w.head1.email);
    const made = await apply(priya, { type: 'UNPAID', from: '2026-11-05', to: '2026-11-05' }); // past-dated: allowed until the month is locked
    expect(made.status).toBe(201);
    await decide(head, made.body.id);
    expect(await prisma.leaveLedger.count()).toBe(0);
    expect(await dayStatus(head, w.priya.id, '2026-11-05')).toMatchObject({ status: 'leave', label: 'On leave (Unpaid leave)', unpaid: 1 });
  });

  it('a half-day CL lifts a half day to full pay', async () => {
    await give(w.priya.id, 5, 5);
    const priya = await signIn(w.priya.email);
    const head = await signIn(w.head1.email);
    const device = await prisma.device.create({ data: { serialNumber: 'SN001', officeId: w.o1.id, name: 'Door' } });
    for (const t of ['2026-11-05T08:00:00Z', '2026-11-05T13:00:00Z']) await prisma.rawPunch.create({ data: { deviceId: device.id, terminalUserId: w.priya.terminalUserId!, punchTime: new Date(t), rawLine: 'x' } }); // 13:30 to 18:30
    expect(await dayStatus(head, w.priya.id, '2026-11-05')).toMatchObject({ status: 'half_late', unpaid: 0.5 });
    const made = await apply(priya, { from: '2026-11-05', to: '2026-11-05', halfDay: 'first' });
    expect(made.body).toMatchObject({ days: 0.5, detail: 'Half day (first half)', halfDay: 'first' });
    await decide(head, made.body.id);
    expect(await dayStatus(head, w.priya.id, '2026-11-05')).toMatchObject({ status: 'leave', label: 'Half day leave (CL)', unpaid: 0, halfLeave: true });
    expect((await ledgerSums(prisma, w.priya.id)).CL).toBe(4.5);
  });

  it('the balance can never go negative: approval is refused when the days are no longer there', async () => {
    await give(w.priya.id, 2, 0);
    const priya = await signIn(w.priya.email);
    const head = await signIn(w.head1.email);
    const made = await apply(priya, { from: '2026-11-18', to: '2026-11-19' });
    expect((await head.post(`/api/employees/${w.priya.id}/leave-adjustments`).send({ type: 'CL', days: -1, note: 'Opening balance was wrong' })).status).toBe(204);
    const res = await decide(head, made.body.id);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Priya Nair has only 1 day of CL left. The rest has to be unpaid leave.');
    expect((await priya.get('/api/me/requests')).body[0].status).toBe('pending'); // nothing was half done
    expect((await ledgerSums(prisma, w.priya.id)).CL).toBe(1);
  });

  it('undo within 60 seconds gives the days back', async () => {
    await give(w.priya.id, 5, 5);
    const priya = await signIn(w.priya.email);
    const head = await signIn(w.head1.email);
    const made = await apply(priya, { from: '2026-11-18', to: '2026-11-19' });
    await decide(head, made.body.id);
    setNow('2026-11-10T06:30:45Z');
    expect((await head.post(`/api/requests/${made.body.id}/undo`)).status).toBe(204);
    expect((await ledgerSums(prisma, w.priya.id)).CL).toBe(5);
    expect((await prisma.leaveLedger.findMany({ where: { ref: made.body.id }, orderBy: { createdAt: 'asc' } })).map(r => [r.reason, Number(r.deltaDays)])).toEqual([['leave', -2], ['reversal', 2]]);
    expect((await dayStatus(head, w.priya.id, '2026-11-18')).status).toBe('future');
    expect(await balance(priya)).toMatchObject({ cl: { balance: 5, pending: 2, available: 3 } });
    await decide(head, made.body.id);
    setNow('2026-11-10T06:32:00Z');
    expect((await head.post(`/api/requests/${made.body.id}/undo`)).status).toBe(409);
  });

  it('nobody approves their own request: a head\'s leave goes to the admin', async () => {
    await give(w.head1.id, 5, 5);
    const head = await signIn(w.head1.email);
    const admin = await signIn(w.admin.email);
    const made = await apply(head, { from: '2026-11-18', to: '2026-11-18' });
    expect(made.body).toMatchObject({ fromHead: true, canAct: false });
    expect((await decide(head, made.body.id)).status).toBe(403);
    expect((await decide(await signIn(w.head2.email), made.body.id)).status).toBe(403);
    expect((await head.get('/api/requests/queue')).body).toEqual([]);
    expect((await admin.get('/api/requests/queue')).body).toMatchObject([{ id: made.body.id, fromHead: true, canAct: true }]);
    expect((await admin.get('/api/notifications')).body.items[0].text).toBe('Vikram Singh asked for CL, Wed 18 Nov');
    expect((await decide(admin, made.body.id)).status).toBe(204);
    // A head cannot adjust their own balance either.
    expect((await head.post(`/api/employees/${w.head1.id}/leave-adjustments`).send({ type: 'CL', days: 5, note: 'me' })).status).toBe(403);
  });

  it('the admin can reverse a decision both ways', async () => {
    await give(w.priya.id, 5, 5);
    const priya = await signIn(w.priya.email);
    const head = await signIn(w.head1.email);
    const admin = await signIn(w.admin.email);
    const made = await apply(priya, { from: '2026-11-18', to: '2026-11-19' });
    await decide(head, made.body.id, 'rejected', 'No');
    expect((await admin.post(`/api/requests/${made.body.id}/reverse`).send({ comment: 'Approved after review' })).status).toBe(204);
    expect((await ledgerSums(prisma, w.priya.id)).CL).toBe(3);
    expect((await dayStatus(admin, w.priya.id, '2026-11-18')).status).toBe('leave');
    expect((await admin.post(`/api/requests/${made.body.id}/reverse`).send({ comment: 'Changed back' })).status).toBe(204);
    expect((await ledgerSums(prisma, w.priya.id)).CL).toBe(5);
    expect((await priya.get('/api/me/requests')).body[0]).toMatchObject({ status: 'rejected', comment: 'Changed back' });
  });
});

describe('cancelling', () => {
  it('an employee cancels a pending request, but approved leave needs the office head', async () => {
    await give(w.priya.id, 5, 5);
    const priya = await signIn(w.priya.email);
    const head = await signIn(w.head1.email);
    const made = await apply(priya, { from: '2026-11-18', to: '2026-11-19' });
    expect((await priya.post(`/api/requests/${made.body.id}/cancel`)).status).toBe(204);
    expect(await balance(priya)).toMatchObject({ cl: { pending: 0, available: 5 } });
    expect((await priya.post(`/api/requests/${made.body.id}/restore`)).status).toBe(204);
    await decide(head, made.body.id);

    const refused = await priya.post(`/api/requests/${made.body.id}/cancel`);
    expect(refused.status).toBe(409); expect(refused.body.message).toBe('This leave is approved. Ask your office head to cancel it.');
    expect((await priya.post(`/api/requests/${made.body.id}/cancel-approved`).send({})).status).toBe(403);
    expect((await (await signIn(w.head2.email)).post(`/api/requests/${made.body.id}/cancel-approved`).send({})).status).toBe(403);
    expect((await head.get('/api/requests?kind=leave&status=approved')).body.items[0].canCancelApproved).toBe(true);

    expect((await head.post(`/api/requests/${made.body.id}/cancel-approved`).send({ comment: 'Plans changed' })).status).toBe(204);
    expect((await ledgerSums(prisma, w.priya.id)).CL).toBe(5); // the days are back
    expect((await dayStatus(head, w.priya.id, '2026-11-18')).status).toBe('future');
    expect((await priya.get('/api/me/requests')).body[0].status).toBe('cancelled');
    expect((await priya.get('/api/notifications')).body.items[0].text).toBe('Your approved CL for 18 to 19 Nov was cancelled. 2 days went back to your CL balance');
    expect((await priya.post(`/api/requests/${made.body.id}/restore`)).status).toBe(409); // a head's cancellation is not undone by the employee
  });
});

describe('a locked month', () => {
  it('past-dated leave is allowed until the month is locked', async () => {
    await give(w.priya.id, 5, 5);
    setNow('2026-12-02T06:30:00Z');
    const priya = await signIn(w.priya.email);
    const head = await signIn(w.head1.email);
    const made = await apply(priya, { from: '2026-11-26', to: '2026-11-26' });
    expect(made.status).toBe(201);
    await prisma.payrollRun.create({ data: { officeId: w.o1.id, month: '2026-11', status: 'locked', lockedAt: new Date() } });
    expect((await decide(head, made.body.id)).status).toBe(409);
    const late = await apply(priya, { from: '2026-11-27', to: '2026-11-27' });
    expect(late.status).toBe(422); expect(late.body.message).toBe('November 2026 is already locked.');
    expect((await apply(priya, { from: '2026-12-03', to: '2026-12-03' })).status).toBe(201);
  });
});

describe('escalation', () => {
  it('after 2 working days without a decision the request also goes to the admin, and either can decide', async () => {
    await give(w.priya.id, 5, 5);
    setNow('2026-11-13T06:30:00Z'); // Fri 13 Nov
    const priya = await signIn(w.priya.email);
    const made = await apply(priya, { from: '2026-11-25', to: '2026-11-25' });
    const fix = await priya.post('/api/corrections').send({ date: '2026-11-12', outTime: '18:00', reason: 'Forgot' });
    const admin = await signIn(w.admin.email);
    expect((await admin.get('/api/requests/queue')).body).toEqual([]); // not the admin's yet

    setNow('2026-11-16T06:30:00Z'); // Mon 16: Sat 14 (2nd Saturday) and Sun 15 do not count, so 1 working day has passed
    expect(await escalateRequests(prisma)).toBe(0);
    setNow('2026-11-17T03:30:00Z'); // Tue 17, 9:00: 2 working days have passed
    expect(await escalateRequests(prisma)).toBe(2);
    expect(await escalateRequests(prisma)).toBe(0); // marked once

    const admin2 = await signIn(w.admin.email); // days have passed: the earlier session has timed out
    const queue = (await admin2.get('/api/requests/queue')).body;
    expect(queue.map((r: { id: string; escalated: boolean }) => [r.id, r.escalated]).sort()).toEqual([[made.body.id, true], [fix.body.id, true]].sort());
    expect((await admin2.get('/api/notifications')).body.items.map((n: { text: string }) => n.text).sort()).toEqual([
      "Priya Nair's CL for Wed 25 Nov has waited 2 working days for a decision", "Priya Nair's correction for Thu 12 Nov has waited 2 working days for a decision",
    ]);
    expect(await prisma.auditLog.count({ where: { action: 'Request escalated', actorId: null } })).toBe(2);
    // Still in the head's queue too, at the top. Either can decide.
    const head = await signIn(w.head1.email);
    expect((await head.get('/api/requests/queue')).body).toHaveLength(2);
    expect((await decide(head, made.body.id)).status).toBe(204);
    expect((await decide(admin2, fix.body.id)).status).toBe(204);
    expect((await admin2.get('/api/requests/queue')).body).toEqual([]);
  });

  it('uses the setting and that office\'s own calendar', async () => {
    await give(w.priya.id, 5, 5); await give(w.sunita.id, 5, 5);
    await prisma.setting.create({ data: { key: 'escalateAfterWorkingDays', value: 1 } });
    await prisma.holiday.create({ data: { officeId: w.o1.id, date: dbDate('2026-11-11'), name: 'Local holiday' } });
    setNow('2026-11-10T06:30:00Z');
    await apply(await signIn(w.priya.email), { from: '2026-11-25', to: '2026-11-25' });
    await apply(await signIn(w.sunita.email), { from: '2026-11-25', to: '2026-11-25' });
    setNow('2026-11-11T06:30:00Z'); // Office 1 is on holiday today, Office 2 is working
    expect(await escalateRequests(prisma)).toBe(1);
    expect((await prisma.leaveRequest.findFirstOrThrow({ where: { employeeId: w.sunita.id } })).escalatedAt).not.toBeNull();
    expect((await prisma.leaveRequest.findFirstOrThrow({ where: { employeeId: w.priya.id } })).escalatedAt).toBeNull();
  });
});

describe('ledger, adjustments and the leave calendar', () => {
  it('shows every entry behind a balance, and an adjustment is audited', async () => {
    await creditLeave(prisma, '2026-02');
    const head = await signIn(w.head1.email);
    expect((await head.post(`/api/employees/${w.priya.id}/leave-adjustments`).send({ type: 'PL', days: 4.5, note: 'Carried from the old register' })).status).toBe(204);
    expect((await head.post(`/api/employees/${w.priya.id}/leave-adjustments`).send({ type: 'CL', days: -9, note: 'too much' })).status).toBe(422); // would go below zero
    expect((await head.post(`/api/employees/${w.priya.id}/leave-adjustments`).send({ type: 'CL', days: 1 })).status).toBe(422); // a note is required
    expect((await head.post(`/api/employees/${w.sunita.id}/leave-adjustments`).send({ type: 'CL', days: 1, note: 'x' })).status).toBe(403);

    const ledger = (await head.get(`/api/employees/${w.priya.id}/ledger`)).body;
    expect(ledger.balances).toMatchObject({ cl: { balance: 2 }, pl: { balance: 7.5 } });
    expect(ledger.total).toBe(5);
    expect(ledger.items[0]).toMatchObject({ type: 'PL', days: 4.5, reason: 'adjustment', ref: 'Carried from the old register', byName: 'Vikram Singh' });
    expect(ledger.items.at(-1)).toMatchObject({ reason: 'credit', byName: 'System', date: '2026-01-01' });
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'Leave balance adjusted' } }))).toMatchObject({ oldValue: { PL: 3 }, newValue: { PL: 7.5 } });
    // The employee sees their own ledger and balances on their profile. Nobody else's.
    const priya = await signIn(w.priya.email);
    expect((await priya.get(`/api/employees/${w.priya.id}/ledger`)).body.total).toBe(5);
    expect((await priya.get(`/api/employees/${w.priya.id}`)).body.balances.pl.balance).toBe(7.5);
    expect((await priya.get(`/api/employees/${w.aarav.id}/ledger`)).status).toBe(404);
  });

  it('the leave calendar shows who is away, approved or pending, on working days only', async () => {
    await give(w.priya.id, 5, 5); await give(w.aarav.id, 5, 5); await give(w.sunita.id, 5, 5);
    const head = await signIn(w.head1.email);
    const a = await apply(await signIn(w.priya.email), { from: '2026-11-20', to: '2026-11-23' }); // Sun 22 is off
    await decide(head, a.body.id);
    await apply(await signIn(w.aarav.email), { type: 'PL', from: '2026-11-23', to: '2026-11-23', halfDay: 'second' });
    await apply(await signIn(w.sunita.email), { from: '2026-11-23', to: '2026-11-23' }); // other office
    const cal = (await head.get('/api/leave/calendar?month=2026-11')).body;
    expect(cal).toHaveLength(30);
    const on = (d: string) => cal.find((x: { date: string }) => x.date === d);
    expect(on('2026-11-20').people).toEqual([{ employeeId: w.priya.id, name: 'Priya Nair', type: 'CL', half: false, halfDay: 'none', pending: false }]);
    expect(on('2026-11-22')).toMatchObject({ off: true, people: [] });
    expect(on('2026-11-23').people.map((p: { name: string; pending: boolean; half: boolean }) => [p.name, p.pending, p.half])).toEqual([['Aarav Mehta', true, true], ['Priya Nair', false, false]]);
    expect((await head.get(`/api/leave/calendar?month=2026-11&office=${w.o2.id}`)).status).toBe(403);
    expect((await head.get('/api/attendance/today')).body.counts).toMatchObject({ onLeave: 0, waiting: 1 });
  });
});
