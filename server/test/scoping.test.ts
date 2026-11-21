// Roles and office scoping, checked through the HTTP API.
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db';
import { anon, resetDb, signIn, world } from './helpers';

beforeEach(resetDb);
const names = (res: { body: { items: { name: string }[] } }) => res.body.items.map(e => e.name).sort();

describe('office scoping', () => {
  it('admin sees every office, or one when asked', async () => {
    const w = await world();
    const admin = await signIn(w.admin.email);
    const all = await admin.get('/api/employees');
    expect(all.body.total).toBe(5);
    expect(all.body).toMatchObject({ page: 1, pageSize: 100 });
    expect(names(await admin.get(`/api/employees?office=${w.o2.id}`))).toEqual(['Rahul Khanna', 'Sunita Agarwal']);
    expect(names(await admin.get('/api/employees?office=all'))).toHaveLength(5);
    expect((await admin.get('/api/employees?office=00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('a head sees only their office and gets 403 for another', async () => {
    const w = await world();
    const head = await signIn(w.head1.email);
    expect(names(await head.get('/api/employees'))).toEqual(['Aarav Mehta', 'Priya Nair', 'Vikram Singh']);
    expect(names(await head.get('/api/employees?office=all'))).toHaveLength(3); // "all" means their own office
    expect(names(await head.get(`/api/employees?office=${w.o1.id}`))).toHaveLength(3);
    expect((await head.get(`/api/employees?office=${w.o2.id}`)).status).toBe(403);
    expect((await head.get(`/api/employees/${w.sunita.id}`)).status).toBe(403);
    expect((await head.get('/api/offices')).body.map((o: { name: string }) => o.name)).toEqual(['Office 1']);
  });

  it('an employee has no manager access and cannot open another person', async () => {
    const w = await world();
    const priya = await signIn(w.priya.email);
    expect((await priya.get('/api/employees')).status).toBe(403);
    expect((await priya.get(`/api/employees/${w.aarav.id}`)).status).toBe(404);
    expect((await priya.get(`/api/employees/${w.priya.id}`)).status).toBe(200);
    expect((await priya.post('/api/employees').send({ name: 'X', email: 'x@test.example', joinDate: '2026-11-02', salary: 1, effectiveMonth: '2026-11' })).status).toBe(403);
    expect((await priya.patch('/api/settings').send({ companyName: 'Mine' })).status).toBe(403);
  });

  it('supports search, status and paging', async () => {
    const w = await world();
    const admin = await signIn(w.admin.email);
    expect(names(await admin.get('/api/employees?search=priya'))).toEqual(['Priya Nair']);
    expect(names(await admin.get(`/api/employees?search=${w.sunita.code}`))).toEqual(['Sunita Agarwal']);
    await prisma.employee.update({ where: { id: w.aarav.id }, data: { status: 'inactive' } });
    expect(names(await admin.get('/api/employees?status=inactive'))).toEqual(['Aarav Mehta']);
    const page2 = await admin.get('/api/employees?pageSize=2&page=2');
    expect(page2.body).toMatchObject({ total: 5, page: 2, pageSize: 2 });
    expect(page2.body.items).toHaveLength(2);
    expect((await admin.get('/api/employees?status=nonsense')).status).toBe(422);
  });
});

describe('salary visibility', () => {
  it('goes to the admin, the office head and the employee only', async () => {
    const w = await world();
    const see = async (email: string, id: string) => (await (await signIn(email)).get(`/api/employees/${id}`)).body;
    expect((await see(w.admin.email, w.priya.id)).employee.salary).toBe(52000);
    expect((await see(w.head1.email, w.priya.id)).employee.salary).toBe(52000);
    const own = await see(w.priya.email, w.priya.id);
    expect(own.employee.salary).toBe(52000); expect(own.canSeeSalary).toBe(true); expect(own.canEdit).toBe(false);
    expect(own.salaryHistory).toHaveLength(1);
    // The other office's head cannot even open the profile.
    expect((await (await signIn(w.head2.email)).get(`/api/employees/${w.priya.id}`)).status).toBe(403);
  });
});

describe('a head and their own record', () => {
  it('cannot change their own details, salary, quota or status', async () => {
    const w = await world();
    const head = await signIn(w.head1.email);
    const id = w.head1.id;
    for (const res of [
      await head.patch(`/api/employees/${id}`).send({ designation: 'Director' }),
      await head.post(`/api/employees/${id}/salary`).send({ amount: 999999, effectiveMonth: '2026-12' }),
      await head.put(`/api/employees/${id}/quota`).send({ year: 2026, clQuota: 30, plQuota: 30 }),
      await head.post(`/api/employees/${id}/status`).send({ status: 'inactive' }),
    ]) expect(res.status).toBe(403);
    expect((await head.post(`/api/employees/${id}/salary`).send({ amount: 999999, effectiveMonth: '2026-12' })).body.message).toMatch(/Ask the admin/);
    const profile = await head.get(`/api/employees/${id}`);
    expect(profile.body.canEdit).toBe(false);
    expect(profile.body.employee.salary).toBe(85000); // they still see their own salary
    // The admin can.
    const admin = await signIn(w.admin.email);
    expect((await admin.post(`/api/employees/${id}/salary`).send({ amount: 90000, effectiveMonth: '2026-12' })).status).toBe(204);
  });

  it('cannot touch another office', async () => {
    const w = await world();
    const head = await signIn(w.head1.email);
    expect((await head.patch(`/api/employees/${w.sunita.id}`).send({ designation: 'X' })).status).toBe(403);
    expect((await head.post(`/api/employees/${w.sunita.id}/salary`).send({ amount: 1, effectiveMonth: '2026-12' })).status).toBe(403);
    // Adding someone always lands in the head's own office, whatever the form says.
    const c = await head.post('/api/employees').send({ name: 'Wrong Office', email: 'wrong@test.example', officeId: w.o2.id, joinDate: '2026-11-02', salary: 30000, effectiveMonth: '2026-11' });
    expect(c.status).toBe(201); expect(c.body.employee.officeId).toBe(w.o1.id);
    expect((await head.post('/api/employees').send({ name: 'New Head', email: 'nh@test.example', role: 'head', joinDate: '2026-11-02', salary: 30000, effectiveMonth: '2026-11' })).status).toBe(403);
  });
});

describe('managing people', () => {
  it('a head edits an employee, sets salary and quota, and each change is audited', async () => {
    const w = await world();
    const head = await signIn(w.head1.email);
    expect((await head.patch(`/api/employees/${w.priya.id}`).send({ designation: 'Team Lead', lastWorkingDate: '2026-12-31', clQuota: 10 })).status).toBe(204);
    expect((await head.post(`/api/employees/${w.priya.id}/salary`).send({ amount: 56000, effectiveMonth: '2020-01' })).status).toBe(204);
    const p = (await head.get(`/api/employees/${w.priya.id}`)).body;
    expect(p.employee).toMatchObject({ designation: 'Team Lead', lastWorkingDate: '2026-12-31', clQuota: 10, plQuota: 18, salary: 52000 });
    expect(p.salaryHistory.map((s: { amount: number }) => s.amount)).toEqual([52000, 56000]);
    expect(p.salaryHistory[1].setByName).toBe('Vikram Singh');

    const log = await prisma.auditLog.findMany({ orderBy: { id: 'asc' } });
    expect(log.map(l => l.action)).toEqual(['Employee updated', 'Salary changed']);
    expect(log[0]).toMatchObject({ actorName: 'Vikram Singh', officeId: w.o1.id, entityId: w.priya.id });
    expect(log[0].oldValue).toMatchObject({ designation: 'Executive', clQuota: 12 });
    expect(log[0].newValue).toMatchObject({ designation: 'Team Lead', clQuota: 10 });
    // The amount is in old/new (admin only), never in the text or the notification.
    expect(log[1].sensitive).toBe(true); expect(log[1].detail).not.toMatch(/56/);
    expect(log[1].newValue).toMatchObject({ amount: 56000 });
    const note = await prisma.notification.findFirstOrThrow({ where: { userId: w.priya.userId } });
    expect(JSON.stringify(note.payload)).not.toMatch(/56/);
  });

  it('refuses a duplicate email or terminal user id', async () => {
    const w = await world();
    const head = await signIn(w.head1.email);
    expect((await head.post('/api/employees').send({ name: 'Dup', email: w.priya.email, joinDate: '2026-11-02', salary: 30000, effectiveMonth: '2026-11' })).status).toBe(409);
    expect((await head.patch(`/api/employees/${w.aarav.id}`).send({ terminalUserId: w.priya.terminalUserId })).status).toBe(409);
    expect((await head.patch(`/api/employees/${w.aarav.id}`).send({ lastWorkingDate: '2020-01-01' })).status).toBe(422);
  });

  it('gives a new employee a code, a terminal user id and the default quota', async () => {
    const w = await world();
    const head = await signIn(w.head1.email);
    const a = (await head.post('/api/employees').send({ name: 'First New', email: 'first@test.example', joinDate: '2026-11-02', salary: 30000, effectiveMonth: '2026-11' })).body.employee;
    const b = (await head.post('/api/employees').send({ name: 'Second New', email: 'second@test.example', joinDate: '2026-11-02', salary: 30000, effectiveMonth: '2026-11' })).body.employee;
    expect(a).toMatchObject({ code: 'EMP-0101', terminalUserId: '101', clQuota: 12, plQuota: 18 });
    expect(b).toMatchObject({ code: 'EMP-0102', terminalUserId: '102' });
  });

  it('switches an account off and on, and undoes an add only while invited', async () => {
    const w = await world();
    const head = await signIn(w.head1.email);
    const priya = await signIn(w.priya.email);
    expect((await head.post(`/api/employees/${w.priya.id}/status`).send({ status: 'inactive' })).status).toBe(204);
    expect((await priya.get('/api/auth/me')).status).toBe(401);
    expect((await head.post(`/api/employees/${w.priya.id}/status`).send({ status: 'active' })).status).toBe(204);
    expect((await head.delete(`/api/employees/${w.priya.id}`)).status).toBe(409);

    const c = await head.post('/api/employees').send({ name: 'Oops Typo', email: 'oops@test.example', joinDate: '2026-11-02', salary: 30000, effectiveMonth: '2026-11' });
    expect((await head.delete(`/api/employees/${c.body.employee.id}`)).status).toBe(204);
    expect(await prisma.user.findUnique({ where: { email: 'oops@test.example' } })).toBeNull();
  });
});

describe('offices and settings (admin)', () => {
  it('creates and edits an office, and only the admin may', async () => {
    const w = await world();
    const admin = await signIn(w.admin.email);
    const head = await signIn(w.head1.email);
    expect((await head.post('/api/offices').send({ name: 'Office 9' })).status).toBe(403);
    expect((await head.patch(`/api/offices/${w.o1.id}`).send({ name: 'Mine' })).status).toBe(403);
    const c = await admin.post('/api/offices').send({ name: 'Office 3', address: 'Gurugram' });
    expect(c.status).toBe(201);
    expect((await admin.patch(`/api/offices/${c.body.id}`).send({ startTime: '09:30' })).status).toBe(204);
    expect((await admin.patch(`/api/offices/${c.body.id}`).send({ minHalfDayHours: 10 })).status).toBe(422);
    const list = (await admin.get('/api/offices')).body;
    expect(list).toHaveLength(3);
    expect(list[2]).toMatchObject({ name: 'Office 3', address: 'Gurugram', startTime: '09:30', fullDayHours: 9, halfDayHours: 4.5, headId: null, headcount: 0 });
    expect(list[0]).toMatchObject({ headName: 'Vikram Singh', headcount: 3 });
  });

  it('changes the head: roles swap and the old head loses manager access at once', async () => {
    const w = await world();
    const admin = await signIn(w.admin.email);
    const oldHead = await signIn(w.head1.email);
    expect((await admin.put(`/api/offices/${w.o1.id}/head`).send({ employeeId: w.sunita.id })).status).toBe(422); // other office
    expect((await admin.put(`/api/offices/${w.o1.id}/head`).send({ employeeId: w.priya.id })).status).toBe(204);
    expect((await oldHead.get('/api/employees')).status).toBe(401);
    expect((await (await signIn(w.head1.email)).get('/api/employees')).status).toBe(403);
    expect((await (await signIn(w.priya.email)).get('/api/auth/me')).body.role).toBe('head');
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'Office head changed' } })).detail).toMatch(/Priya Nair is now head of Office 1, replacing Vikram Singh/);
  });

  it('reads and changes settings', async () => {
    const w = await world();
    const admin = await signIn(w.admin.email);
    expect((await admin.get('/api/settings')).body).toMatchObject({ plCarryMax: 30, escalateAfterWorkingDays: 2, leaveYearStart: 1, defaultClQuota: 12 });
    const res = await admin.patch('/api/settings').send({ companyName: 'SBM Test', defaultPlQuota: 15 });
    expect(res.body).toMatchObject({ companyName: 'SBM Test', defaultPlQuota: 15 });
    expect((await admin.patch('/api/settings').send({ leaveYearStart: 4 })).status).toBe(422);
    expect((await (await signIn(w.priya.email)).get('/api/settings')).body.companyName).toBe('SBM Test');
  });
});

describe('health', () => {
  it('answers without a session', async () => {
    expect((await anon().get('/api/health')).body).toEqual({ ok: true });
  });
});
