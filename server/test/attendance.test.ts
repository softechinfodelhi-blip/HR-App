// The engine end to end: punches in, register out, corrections, holidays, the lock and the nightly jobs.
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAdmsApp } from '../src/adms/app';
import { prisma } from '../src/db';
import { dbDate, setNow } from '../src/lib/time';
import { alertSilentTerminals, finalizeDay } from '../src/services/attendance';
import { resetDb, signIn, world } from './helpers';

const adms = createAdmsApp();
type World = Awaited<ReturnType<typeof world>>;
let w: World;

/** Sends punches for one employee through the terminal listener, as "YYYY-MM-DD HH:MM[:SS]". */
async function punch(e: { terminalUserId: string | null }, times: string[], sn = 'SN001') {
  const body = times.map(t => `${e.terminalUserId}\t${t.length === 16 ? `${t}:00` : t}\t0\t1\t0\t0\t0`).join('\n');
  const res = await request(adms).post(`/iclock/cdata?SN=${sn}&table=ATTLOG&Stamp=1`).set('Content-Type', 'text/plain').send(body);
  expect(res.text).toMatch(/^OK: /);
}
const stored = (employeeId: string, date: string) => prisma.attendanceDay.findUnique({ where: { employeeId_date: { employeeId, date: dbDate(date) } } });
type DayJson = { date: string; status: string; unpaid: number; inTime: string | null; outTime: string | null; manual: boolean; label: string; otherOffice: string | null };
const dayOf = (res: { body: { rows: { employeeId: string; days: DayJson[] }[] } }, employeeId: string, date: string) => res.body.rows.find(r => r.employeeId === employeeId)!.days.find(d => d.date === date)!;

beforeEach(async () => {
  await resetDb();
  w = await world();
  await prisma.device.create({ data: { serialNumber: 'SN001', officeId: w.o1.id, name: 'Office 1 door' } });
  await prisma.device.create({ data: { serialNumber: 'SN002', officeId: w.o2.id, name: 'Office 2 door' } });
  setNow('2026-11-10T06:30:00Z'); // Tue 10 Nov 2026, 12:00 noon office time
});

describe('punches to attendance', () => {
  it('recomputes and stores the day when a punch arrives', async () => {
    await punch(w.priya, ['2026-11-03 09:00', '2026-11-03 18:05']);
    expect(await stored(w.priya.id, '2026-11-03')).toMatchObject({ status: 'PRESENT', isManual: false, finalized: true });
    expect(Number((await stored(w.priya.id, '2026-11-03'))!.paidFraction)).toBe(1);
    expect((await stored(w.priya.id, '2026-11-03'))!.checkIn!.toISOString()).toBe('2026-11-03T03:30:00.000Z');
    expect(Number((await stored(w.priya.id, '2026-11-03'))!.hours)).toBe(9.08);
    // A later punch the same day moves the check-out.
    await punch(w.priya, ['2026-11-03 19:30']);
    expect((await stored(w.priya.id, '2026-11-03'))!.checkOut!.toISOString()).toBe('2026-11-03T14:00:00.000Z');
  });

  it('shows the month in the register with every status', async () => {
    await punch(w.priya, [
      '2026-11-02 09:00', '2026-11-02 18:00',   // present
      '2026-11-03 09:01', '2026-11-03 18:30',   // late half day
      '2026-11-04 09:00', '2026-11-04 15:00',   // short half day
      '2026-11-05 09:00', '2026-11-05 12:00',   // absent, under 4.5 h
      '2026-11-06 08:55',                       // missing punch
      '2026-11-10 08:58',                       // today, in office
    ]);
    const head = await signIn(w.head1.email);
    const reg = await head.get('/api/attendance/register?month=2026-11');
    expect(reg.body.dates).toHaveLength(30);
    expect(reg.body.rows.map((r: { name: string }) => r.name)).toEqual(['Aarav Mehta', 'Priya Nair', 'Vikram Singh']);
    const s = (d: string) => dayOf(reg, w.priya.id, d).status;
    expect([s('2026-11-01'), s('2026-11-02'), s('2026-11-03'), s('2026-11-04'), s('2026-11-05'), s('2026-11-06'), s('2026-11-07'), s('2026-11-09'), s('2026-11-10'), s('2026-11-11'), s('2026-11-14')])
      .toEqual(['off', 'present', 'half_late', 'half_short', 'absent', 'missing', 'absent', 'absent', 'working', 'future', 'off']);
    expect(reg.body.rows.find((r: { employeeId: string }) => r.employeeId === w.priya.id).totals).toEqual({ present: 1, half: 2, absent: 3, leave: 0, missing: 1, unpaid: 4 });
    // Scoping.
    expect((await head.get(`/api/attendance/register?month=2026-11&office=${w.o2.id}`)).status).toBe(403);
    expect((await (await signIn(w.priya.email)).get('/api/attendance/register')).status).toBe(403);
    expect((await (await signIn(w.admin.email)).get('/api/attendance/register?month=2026-11')).body.rows).toHaveLength(5);
  });

  it('flags a day with a punch at another office and still accepts it', async () => {
    await punch(w.priya, ['2026-11-03 09:00']);
    await punch(w.priya, ['2026-11-03 18:10'], 'SN002');
    const head = await signIn(w.head1.email);
    expect(dayOf(await head.get('/api/attendance/register?month=2026-11'), w.priya.id, '2026-11-03')).toMatchObject({ status: 'present', otherOffice: 'Office 2' });
    expect((await stored(w.priya.id, '2026-11-03'))!.flags).toMatchObject({ otherOffice: true, otherOfficeId: w.o2.id });
    const detail = await head.get(`/api/attendance/days/${w.priya.id}/2026-11-03`);
    expect(detail.body.punches).toEqual([
      expect.objectContaining({ time: '09:00', terminalName: 'Office 1 door', other: false }),
      expect.objectContaining({ time: '18:10', terminalName: 'Office 2 door', officeName: 'Office 2', other: true }),
    ]);
  });

  it('an employee sees their own month and day, and nobody else\'s', async () => {
    await punch(w.priya, ['2026-11-03 09:00', '2026-11-03 18:05']);
    const priya = await signIn(w.priya.email);
    const mine = await priya.get('/api/me/attendance?month=2026-11');
    expect(mine.body).toMatchObject({ month: '2026-11', locked: false, pendingDates: [] });
    expect(mine.body.days.find((d: DayJson) => d.date === '2026-11-03')).toMatchObject({ status: 'present', inTime: '09:00', outTime: '18:05' });
    expect((await priya.get(`/api/attendance/days/${w.priya.id}/2026-11-03`)).body).toMatchObject({ canCorrect: false, lockedNote: null });
    expect((await priya.get(`/api/attendance/days/${w.aarav.id}/2026-11-03`)).status).toBe(404);
    expect((await (await signIn(w.head2.email)).get(`/api/attendance/days/${w.priya.id}/2026-11-03`)).status).toBe(403);
  });

  it('does not count days before joining or after the last working date', async () => {
    await prisma.employee.update({ where: { id: w.aarav.id }, data: { joiningDate: dbDate('2026-11-04'), lastWorkingDate: dbDate('2026-11-06') } });
    const reg = await (await signIn(w.head1.email)).get('/api/attendance/register?month=2026-11');
    expect(['2026-11-03', '2026-11-04', '2026-11-06', '2026-11-07'].map(d => dayOf(reg, w.aarav.id, d).status)).toEqual(['not_joined', 'absent', 'absent', 'not_joined']);
    // Gone before the month began: not in the register at all.
    await prisma.employee.update({ where: { id: w.aarav.id }, data: { joiningDate: dbDate('2026-01-01'), lastWorkingDate: dbDate('2026-10-31') } });
    expect((await (await signIn(w.head1.email)).get('/api/attendance/register?month=2026-11')).body.rows).toHaveLength(2);
  });
});

describe('correction requests', () => {
  const ask = async (date = '2026-11-06', body: object = { outTime: '18:05', reason: 'Forgot to punch out' }) => {
    const priya = await signIn(w.priya.email);
    return { priya, res: await priya.post('/api/corrections').send({ date, ...body }) };
  };

  it('employee asks, head approves: the time is supplied, the day is manual, the punches are untouched', async () => {
    await punch(w.priya, ['2026-11-06 08:55']);
    const { priya, res } = await ask();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'correction', status: 'pending', title: 'Correction · Fri 6 Nov', detail: 'Out 6:05 PM', canAct: false, employeeName: 'Priya Nair' });
    expect((await priya.get('/api/me/attendance?month=2026-11')).body.pendingDates).toEqual(['2026-11-06']);
    // The head was told, in the app and by email.
    expect((await prisma.notification.findFirstOrThrow({ where: { userId: w.head1.userId } })).payload).toMatchObject({ text: 'Priya Nair asked to correct Fri 6 Nov' });
    expect(await prisma.emailOutbox.count({ where: { toEmail: w.head1.email } })).toBe(1);

    const head = await signIn(w.head1.email);
    const pending = await head.get('/api/requests?kind=correction&status=pending');
    expect(pending.body.items).toMatchObject([{ id: res.body.id, canAct: true, fromHead: false, escalated: false }]);
    expect((await head.post(`/api/requests/${res.body.id}/decision`).send({ decision: 'approved' })).status).toBe(204);

    const day = await head.get(`/api/attendance/days/${w.priya.id}/2026-11-06`);
    expect(day.body.day).toMatchObject({ status: 'present', inTime: '08:55', outTime: '18:05', manual: true });
    expect(day.body.manual).toMatchObject({ outTime: '18:05', inTime: null, byName: 'Vikram Singh', reason: 'Forgot to punch out' });
    expect(day.body.manual.at).toBe('2026-11-10T12:00'); // who approved, and when
    expect(day.body.punches).toHaveLength(1); // raw punches are never changed
    expect(await prisma.rawPunch.count()).toBe(1);
    expect(await stored(w.priya.id, '2026-11-06')).toMatchObject({ status: 'PRESENT', isManual: true });
    // The employee was told.
    expect((await prisma.notification.findFirstOrThrow({ where: { userId: w.priya.userId } })).payload).toMatchObject({ text: 'Your correction for Fri 6 Nov was approved' });
    expect(await prisma.emailOutbox.count({ where: { toEmail: w.priya.email } })).toBe(1);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'Correction approved' } }))).toMatchObject({ actorName: 'Vikram Singh', officeId: w.o1.id });
    expect((await head.post(`/api/requests/${res.body.id}/decision`).send({ decision: 'rejected', comment: 'x' })).status).toBe(409);
  });

  it('a rejection needs a comment and changes nothing', async () => {
    await punch(w.priya, ['2026-11-06 08:55']);
    const { res } = await ask();
    const head = await signIn(w.head1.email);
    expect((await head.post(`/api/requests/${res.body.id}/decision`).send({ decision: 'rejected' })).status).toBe(422);
    expect((await head.post(`/api/requests/${res.body.id}/decision`).send({ decision: 'rejected', comment: 'You left at 4' })).status).toBe(204);
    expect((await head.get(`/api/attendance/days/${w.priya.id}/2026-11-06`)).body.day).toMatchObject({ status: 'missing', manual: false });
    expect((await head.get('/api/requests?status=decided')).body.items[0]).toMatchObject({ status: 'rejected', comment: 'You left at 4', decidedByName: 'Vikram Singh' });
  });

  it('the decider can undo within 60 seconds, and not after', async () => {
    await punch(w.priya, ['2026-11-06 08:55']);
    const { res } = await ask();
    const head = await signIn(w.head1.email);
    const admin = await signIn(w.admin.email);
    await head.post(`/api/requests/${res.body.id}/decision`).send({ decision: 'approved' });
    expect((await admin.post(`/api/requests/${res.body.id}/undo`)).status).toBe(409); // only the person who decided
    setNow('2026-11-10T06:30:59Z');
    expect((await head.post(`/api/requests/${res.body.id}/undo`)).status).toBe(204);
    expect((await head.get(`/api/attendance/days/${w.priya.id}/2026-11-06`)).body.day).toMatchObject({ status: 'missing', manual: false });
    expect((await head.get('/api/requests?status=pending')).body.total).toBe(1);

    await head.post(`/api/requests/${res.body.id}/decision`).send({ decision: 'approved' });
    setNow('2026-11-10T06:32:00Z'); // 61 seconds later
    expect((await head.post(`/api/requests/${res.body.id}/undo`)).status).toBe(409);
  });

  it('nobody decides their own request: a head\'s request goes to the admin', async () => {
    await punch(w.head1, ['2026-11-06 08:55']);
    const head = await signIn(w.head1.email);
    const mine = await head.post('/api/corrections').send({ date: '2026-11-06', outTime: '18:00', reason: 'Client visit' });
    expect(mine.body).toMatchObject({ fromHead: true, canAct: false });
    expect(await prisma.notification.count({ where: { userId: w.admin.id } })).toBe(1); // the admin is asked, not the head
    expect((await head.post(`/api/requests/${mine.body.id}/decision`).send({ decision: 'approved' })).status).toBe(403);
    expect((await head.put(`/api/attendance/days/${w.head1.id}/2026-11-06/manual`).send({ outTime: '18:00', reason: 'me' })).status).toBe(403);
    // Not the other office's head either, and not an employee.
    expect((await (await signIn(w.head2.email)).post(`/api/requests/${mine.body.id}/decision`).send({ decision: 'approved' })).status).toBe(403);
    expect((await (await signIn(w.priya.email)).post(`/api/requests/${mine.body.id}/decision`).send({ decision: 'approved' })).status).toBe(403);
    expect((await (await signIn(w.admin.email)).post(`/api/requests/${mine.body.id}/decision`).send({ decision: 'approved' })).status).toBe(204);
    expect((await stored(w.head1.id, '2026-11-06'))!.status).toBe('PRESENT');
  });

  it('the admin can reverse a decision, with a reason', async () => {
    await punch(w.priya, ['2026-11-06 08:55']);
    const { res } = await ask();
    const head = await signIn(w.head1.email);
    const admin = await signIn(w.admin.email);
    await head.post(`/api/requests/${res.body.id}/decision`).send({ decision: 'approved' });
    expect((await head.post(`/api/requests/${res.body.id}/reverse`).send({ comment: 'x' })).status).toBe(403);
    expect((await admin.post(`/api/requests/${res.body.id}/reverse`).send({})).status).toBe(422);
    expect((await admin.post(`/api/requests/${res.body.id}/reverse`).send({ comment: 'CCTV shows 4 PM' })).status).toBe(204);
    expect((await admin.get(`/api/attendance/days/${w.priya.id}/2026-11-06`)).body.day).toMatchObject({ status: 'missing', manual: false });
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'Decision reversed' } })).detail).toMatch(/approved changed to rejected/);
    expect(await prisma.notification.count({ where: { userId: w.head1.userId, type: 'decision_reversed' } })).toBe(1);
  });

  it('validates the request', async () => {
    const priya = await signIn(w.priya.email);
    const send = (body: object) => priya.post('/api/corrections').send(body);
    expect((await send({ date: '2026-11-06', reason: 'x' })).status).toBe(422); // no time
    expect((await send({ date: '2026-11-06', inTime: '18:00', outTime: '09:00', reason: 'x' })).status).toBe(422);
    expect((await send({ date: '2026-11-06', outTime: '18:00', reason: '' })).status).toBe(422);
    expect((await send({ date: '2026-11-11', outTime: '18:00', reason: 'tomorrow' })).status).toBe(422);
    expect((await send({ date: '2023-11-06', outTime: '18:00', reason: 'before joining' })).status).toBe(422);
    expect((await send({ date: '2026-11-06', outTime: '18:00', reason: 'ok' })).status).toBe(201);
    expect((await send({ date: '2026-11-06', outTime: '18:30', reason: 'again' })).status).toBe(409); // one pending request per day
    expect((await (await signIn(w.admin.email)).post('/api/corrections').send({ date: '2026-11-06', outTime: '18:00', reason: 'x' })).status).toBe(403);
  });

  it('an employee can cancel a pending request and bring it back', async () => {
    const { priya, res } = await ask();
    const aarav = await signIn(w.aarav.email);
    expect((await aarav.post(`/api/requests/${res.body.id}/cancel`)).status).toBe(404);
    expect((await priya.post(`/api/requests/${res.body.id}/cancel`)).status).toBe(204);
    expect((await priya.get('/api/me/requests')).body).toMatchObject([{ status: 'cancelled' }]);
    expect((await (await signIn(w.head1.email)).post(`/api/requests/${res.body.id}/decision`).send({ decision: 'approved' })).status).toBe(409);
    expect((await priya.post(`/api/requests/${res.body.id}/restore`)).status).toBe(204);
    expect((await priya.get('/api/me/requests')).body).toMatchObject([{ status: 'pending' }]);
  });

  it('a head can enter the time directly, recorded as a correction they approved', async () => {
    await punch(w.priya, ['2026-11-06 08:55']);
    const head = await signIn(w.head1.email);
    expect((await head.put(`/api/attendance/days/${w.priya.id}/2026-11-06/manual`).send({ outTime: '18:00' })).status).toBe(422); // a reason is required
    expect((await head.put(`/api/attendance/days/${w.sunita.id}/2026-11-06/manual`).send({ outTime: '18:00', reason: 'x' })).status).toBe(403);
    expect((await head.put(`/api/attendance/days/${w.priya.id}/2026-11-06/manual`).send({ outTime: '18:00', reason: 'Terminal was down in the evening' })).status).toBe(204);
    const day = await head.get(`/api/attendance/days/${w.priya.id}/2026-11-06`);
    expect(day.body.day).toMatchObject({ status: 'present', manual: true, outTime: '18:00' });
    expect(day.body.manual).toMatchObject({ byName: 'Vikram Singh', reason: 'Terminal was down in the evening' });
    expect(day.body.requests).toMatchObject([{ status: 'approved', direct: true }]);
    // A later fix replaces the earlier one.
    await head.put(`/api/attendance/days/${w.priya.id}/2026-11-06/manual`).send({ outTime: '13:00', reason: 'Left at lunch, confirmed' });
    expect((await head.get(`/api/attendance/days/${w.priya.id}/2026-11-06`)).body.day).toMatchObject({ status: 'absent', outTime: '13:00' });
    expect((await (await signIn(w.priya.email)).get('/api/me/requests')).body).toEqual([]); // not a request the employee made
    expect(await prisma.auditLog.count({ where: { action: 'Attendance corrected' } })).toBe(2);
  });
});

describe('holidays and calendar overrides', () => {
  it('a holiday changes the day for that office only, and removing it changes it back', async () => {
    const head = await signIn(w.head1.email);
    const admin = await signIn(w.admin.email);
    const reg = () => admin.get('/api/attendance/register?month=2026-11');
    expect(dayOf(await reg(), w.priya.id, '2026-11-09').status).toBe('absent');

    const made = await head.post('/api/holidays').send({ date: '2026-11-09', name: 'Diwali', officeIds: [w.o2.id] }); // a head's holiday is for their own office
    expect(made.status).toBe(201); expect(made.body.officeIds).toEqual([w.o1.id]);
    const after = await reg();
    expect(dayOf(after, w.priya.id, '2026-11-09')).toMatchObject({ status: 'holiday', label: 'Diwali', unpaid: 0 });
    expect(dayOf(after, w.sunita.id, '2026-11-09').status).toBe('absent');
    expect(await stored(w.priya.id, '2026-11-09')).toMatchObject({ status: 'HOLIDAY' }); // recomputed and stored for everyone in the office
    expect(await stored(w.aarav.id, '2026-11-09')).toMatchObject({ status: 'HOLIDAY' });
    expect(await stored(w.sunita.id, '2026-11-09')).toBeNull();
    expect((await head.post('/api/holidays').send({ date: '2026-11-09', name: 'Again' })).status).toBe(409);

    const list = await head.get('/api/holidays?year=2026');
    expect(list.body).toMatchObject([{ date: '2026-11-09', name: 'Diwali', kind: 'holiday', offices: 'Office 1', canEdit: true }]);
    expect((await (await signIn(w.priya.email)).get('/api/holidays?year=2026')).body).toHaveLength(1); // employees can read their calendar
    expect((await (await signIn(w.head2.email)).get('/api/holidays?year=2026')).body).toEqual([]);
    expect((await (await signIn(w.head2.email)).delete(`/api/holidays/${encodeURIComponent(list.body[0].id)}`)).status).toBe(404);

    const gone = await head.delete(`/api/holidays/${encodeURIComponent(list.body[0].id)}`);
    expect(gone.body).toMatchObject({ date: '2026-11-09', name: 'Diwali', officeIds: [w.o1.id] });
    expect(dayOf(await reg(), w.priya.id, '2026-11-09').status).toBe('absent');
    expect((await prisma.auditLog.findMany({ where: { entity: 'holiday' }, orderBy: { id: 'asc' } })).map(l => l.action)).toEqual(['Holiday added', 'Holiday removed']);
  });

  it('the admin sets one holiday for several offices', async () => {
    const admin = await signIn(w.admin.email);
    expect((await admin.post('/api/holidays').send({ date: '2026-11-24', name: 'Guru Nanak Jayanti', officeIds: [w.o1.id, w.o2.id] })).status).toBe(201);
    expect((await admin.get('/api/holidays?year=2026')).body).toMatchObject([{ offices: 'All offices', officeIds: [w.o1.id, w.o2.id] }]);
    expect((await admin.post('/api/holidays').send({ date: '2026-11-25', name: 'Nobody' })).status).toBe(422);
    expect((await (await signIn(w.priya.email)).post('/api/holidays').send({ date: '2026-11-25', name: 'Mine' })).status).toBe(403);
  });

  it('an override wins: a worked Sunday, a closed working day, and a worked holiday', async () => {
    const head = await signIn(w.head1.email);
    await punch(w.priya, ['2026-11-08 09:00', '2026-11-08 18:00']); // Sunday
    const day = async (d: string) => (await head.get(`/api/attendance/days/${w.priya.id}/${d}`)).body.day;
    expect(await day('2026-11-08')).toMatchObject({ status: 'off', inTime: '09:00' }); // punches on an off day are kept and shown
    expect((await head.post('/api/holidays').send({ date: '2026-11-08', name: 'Stock count', kind: 'working' })).status).toBe(201);
    expect(await day('2026-11-08')).toMatchObject({ status: 'present' });
    expect((await head.post('/api/holidays').send({ date: '2026-11-05', name: 'x', kind: 'working' })).status).toBe(422); // already a working day

    expect((await head.post('/api/holidays').send({ date: '2026-11-05', name: 'Office move', kind: 'off' })).status).toBe(201);
    expect(await day('2026-11-05')).toMatchObject({ status: 'off', label: 'Office move', unpaid: 0 });

    await head.post('/api/holidays').send({ date: '2026-11-09', name: 'Diwali' });
    expect(await day('2026-11-09')).toMatchObject({ status: 'holiday' });
    await head.post('/api/holidays').send({ date: '2026-11-09', name: 'Diwali, worked', kind: 'working' });
    expect(await day('2026-11-09')).toMatchObject({ status: 'absent' }); // the override wins over the holiday
    expect((await head.get('/api/holidays?year=2026')).body.map((h: { kind: string }) => h.kind).sort()).toEqual(['holiday', 'off', 'working', 'working']);
  });
});

describe('a locked month', () => {
  it('is frozen: no recompute, no corrections, no holiday changes', async () => {
    setNow('2026-12-02T06:30:00Z');
    await punch(w.priya, ['2026-11-06 08:55']);
    expect((await stored(w.priya.id, '2026-11-06'))!.status).toBe('MISSING_PUNCH');
    const pending = await (await signIn(w.priya.email)).post('/api/corrections').send({ date: '2026-11-05', outTime: '18:00', reason: 'before lock' });
    await prisma.payrollRun.create({ data: { officeId: w.o1.id, month: '2026-11', status: 'locked', lockedAt: new Date() } });

    // A late punch is still stored (raw data is never refused) but the locked day does not change.
    await punch(w.priya, ['2026-11-06 18:00']);
    expect(await prisma.rawPunch.count()).toBe(2);
    expect((await stored(w.priya.id, '2026-11-06'))!.status).toBe('MISSING_PUNCH');
    const head = await signIn(w.head1.email);
    const detail = await head.get(`/api/attendance/days/${w.priya.id}/2026-11-06`);
    expect(detail.body).toMatchObject({ day: { status: 'missing' }, canCorrect: false, lockedNote: 'November 2026 is locked. Figures cannot change.' });
    expect(detail.body.punches).toHaveLength(2);

    expect((await head.put(`/api/attendance/days/${w.priya.id}/2026-11-06/manual`).send({ outTime: '18:00', reason: 'x' })).status).toBe(409);
    expect((await (await signIn(w.priya.email)).post('/api/corrections').send({ date: '2026-11-06', outTime: '18:00', reason: 'x' })).status).toBe(409);
    expect((await head.post(`/api/requests/${pending.body.id}/decision`).send({ decision: 'approved' })).status).toBe(409);
    expect((await head.post('/api/holidays').send({ date: '2026-11-09', name: 'Late holiday' })).status).toBe(409);
    expect((await head.get('/api/attendance/register?month=2026-11')).body.locks).toMatchObject([{ officeId: w.o1.id, officeName: 'Office 1' }]);
    // The other office, and the next month, are still open.
    await punch(w.priya, ['2026-12-01 09:00', '2026-12-01 18:00']);
    expect((await stored(w.priya.id, '2026-12-01'))!.status).toBe('PRESENT');
  });
});

describe('nightly jobs', () => {
  it('23:55 finalizes the day for everyone', async () => {
    setNow('2026-11-10T18:25:00Z'); // 23:55 office time
    await punch(w.priya, ['2026-11-10 09:00', '2026-11-10 18:00']);
    await punch(w.aarav, ['2026-11-10 09:10']);
    expect(await finalizeDay(prisma, '2026-11-10')).toBe(5);
    const rows = await prisma.attendanceDay.findMany({ where: { date: dbDate('2026-11-10') } });
    expect(rows).toHaveLength(5);
    expect(rows.every(r => r.finalized)).toBe(true);
    const of = (id: string) => rows.find(r => r.employeeId === id)!.status;
    expect([of(w.priya.id), of(w.aarav.id), of(w.head1.id), of(w.sunita.id)]).toEqual(['PRESENT', 'MISSING_PUNCH', 'ABSENT', 'ABSENT']);
    // After 23:55 the board and the register judge today as well.
    const board = (await (await signIn(w.head1.email)).get('/api/attendance/today')).body;
    expect(board.people.map((p: { name: string; day: { status: string } }) => [p.name, p.day.status])).toEqual([['Aarav Mehta', 'missing'], ['Priya Nair', 'present'], ['Vikram Singh', 'absent']]);
  });

  it('before 23:55 today stays open on the board', async () => {
    await punch(w.priya, ['2026-11-10 09:20']);
    const board = (await (await signIn(w.head1.email)).get('/api/attendance/today')).body;
    expect(board).toMatchObject({ date: '2026-11-10', time: '12:00', working: true, counts: { total: 3, in: 1, notIn: 2, onLeave: 0 } });
    expect(board.people.find((p: { name: string }) => p.name === 'Priya Nair').day).toMatchObject({ status: 'working', label: 'In since 9:20 AM', late: true, unpaid: 0 });
    // Stored as it would end if nothing else happened, and not yet final.
    expect(await stored(w.priya.id, '2026-11-10')).toMatchObject({ status: 'MISSING_PUNCH', finalized: false });
  });

  it('tells the head and the admin once when a terminal is silent for over 12 hours on a working day', async () => {
    setNow('2026-11-10T18:25:00Z');
    await prisma.device.update({ where: { serialNumber: 'SN001' }, data: { lastSeenAt: new Date('2026-11-10T05:00:00Z') } }); // 13 h 25 min ago
    await prisma.device.update({ where: { serialNumber: 'SN002' }, data: { lastSeenAt: new Date('2026-11-10T18:00:00Z') } }); // 25 min ago
    expect(await alertSilentTerminals(prisma)).toBe(1);
    const notes = await prisma.notification.findMany({ where: { type: 'terminal_silent' } });
    expect(notes.map(n => n.userId).sort()).toEqual([w.admin.id, w.head1.userId].sort());
    expect(notes[0].payload).toMatchObject({ text: 'Office 1 door at Office 1 has not been heard from for over 12 hours. Check its power and network.' });
    expect(await prisma.emailOutbox.count()).toBe(2);
    expect(await alertSilentTerminals(prisma)).toBe(0); // not again the same day

    // Not on a weekly off.
    setNow('2026-11-15T18:25:00Z'); // Sunday
    expect(await alertSilentTerminals(prisma)).toBe(0);
    setNow('2026-11-16T18:25:00Z'); // Monday: both are silent now
    expect(await alertSilentTerminals(prisma)).toBe(2);
  });
});
