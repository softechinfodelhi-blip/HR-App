import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { setNow } from '../src/lib/time';
import { anon, app, makeAdmin, makeEmployee, makeOffice, PASSWORD, resetDb, signIn, tokenFromEmail, world } from './helpers';

beforeEach(resetDb);

describe('sign in', () => {
  it('signs in, reports who you are, and signs out', async () => {
    const w = await world();
    const agent = await signIn(w.priya.email);
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ id: w.priya.id, employeeId: w.priya.id, role: 'employee', officeId: w.o1.id, officeName: 'Office 1', name: 'Priya Nair' });
    expect((await agent.post('/api/auth/logout')).status).toBe(204);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('maps roles: admin has no office, a head is "head"', async () => {
    const w = await world();
    const admin = await (await signIn(w.admin.email)).get('/api/auth/me');
    expect(admin.body).toMatchObject({ role: 'admin', officeId: null, employeeId: null, id: w.admin.id });
    const head = await (await signIn(w.head1.email)).get('/api/auth/me');
    expect(head.body).toMatchObject({ role: 'head', officeId: w.o1.id });
  });

  it('sets an httpOnly, SameSite=Lax cookie and never returns the password hash', async () => {
    const w = await world();
    const res = await anon().post('/api/auth/login').send({ email: w.priya.email, password: PASSWORD });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/sid=/); expect(cookie).toMatch(/HttpOnly/i); expect(cookie).toMatch(/SameSite=Lax/i);
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|passwordHash/);
  });

  it('rejects a wrong password and an unknown email with the same answer', async () => {
    const w = await world();
    const a = await anon().post('/api/auth/login').send({ email: w.priya.email, password: 'wrong-password' });
    const b = await anon().post('/api/auth/login').send({ email: 'nobody@test.example', password: 'wrong-password' });
    expect(a.status).toBe(401); expect(b.status).toBe(401); expect(a.body).toEqual(b.body);
  });

  it('is not case sensitive about the email', async () => {
    const w = await world();
    expect((await anon().post('/api/auth/login').send({ email: w.priya.email.toUpperCase(), password: PASSWORD })).status).toBe(200);
  });

  it('refuses a switched-off account and drops its open session', async () => {
    const w = await world();
    const agent = await signIn(w.priya.email);
    await prisma.employee.update({ where: { id: w.priya.id }, data: { status: 'inactive' } });
    expect((await agent.get('/api/auth/me')).status).toBe(401);
    expect((await anon().post('/api/auth/login').send({ email: w.priya.email, password: PASSWORD })).status).toBe(403);
  });

  it('ends a session after 12 idle hours', async () => {
    const w = await world();
    const agent = await signIn(w.priya.email);
    setNow(new Date(Date.now() + 13 * 3600 * 1000));
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('answers 401 without a session and 422 for a bad body', async () => {
    expect((await anon().get('/api/employees')).status).toBe(401);
    expect((await anon().post('/api/auth/login').send({ email: 'not-an-email', password: 'x' })).status).toBe(422);
  });

  it('rate limits sign in', async () => {
    const limited = createApp({ authRateLimit: 3, staticDir: 'no-such-folder' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await request(limited).post('/api/auth/login').send({ email: 'x@test.example', password: 'wrong-password' })).status);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
  });

  it('blocks a write that comes from another site', async () => {
    const w = await world();
    const agent = await signIn(w.priya.email);
    const res = await agent.post('/api/auth/logout').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect((await agent.get('/api/auth/me')).status).toBe(200);
  });
});

describe('invite', () => {
  it('a head adds an employee, who sets a password from the emailed link and is signed in', async () => {
    const w = await world();
    const head = await signIn(w.head1.email);
    const created = await head.post('/api/employees').send({ name: 'Asha Rao', email: 'Asha.Rao@test.example', phone: '', officeId: '', designation: 'Clerk', joinDate: '2026-11-02', salary: 30000, effectiveMonth: '2026-11' });
    expect(created.status).toBe(201);
    expect(created.body.employee).toMatchObject({ name: 'Asha Rao', email: 'asha.rao@test.example', status: 'invited', officeId: w.o1.id, role: 'employee', salary: 30000 });

    // No password yet.
    expect((await anon().post('/api/auth/login').send({ email: 'asha.rao@test.example', password: PASSWORD })).status).toBe(403);

    const token = await tokenFromEmail('asha.rao@test.example', 'invite');
    const info = await anon().get(`/api/auth/invites/${token}`);
    expect(info.body).toMatchObject({ name: 'Asha Rao', email: 'asha.rao@test.example', officeName: 'Office 1' });

    expect((await anon().post(`/api/auth/invites/${token}`).send({ password: 'short' })).status).toBe(422);
    const agent = request.agent(app);
    const set = await agent.post(`/api/auth/invites/${token}`).send({ password: 'a-new-password' });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ name: 'Asha Rao', role: 'employee' });
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: created.body.employee.id } })).status).toBe('active');

    // The link works once.
    expect((await anon().post(`/api/auth/invites/${token}`).send({ password: 'another-password' })).status).toBe(410);
    expect((await anon().post('/api/auth/login').send({ email: 'asha.rao@test.example', password: 'a-new-password' })).status).toBe(200);
  });

  it('expires after 72 hours', async () => {
    const w = await world();
    const head = await signIn(w.head1.email);
    await head.post('/api/employees').send({ name: 'Late Joiner', email: 'late@test.example', joinDate: '2026-11-02', salary: 30000, effectiveMonth: '2026-11' });
    const token = await tokenFromEmail('late@test.example', 'invite');
    setNow(new Date(Date.now() + 71 * 3600 * 1000));
    expect((await anon().get(`/api/auth/invites/${token}`)).status).toBe(200);
    setNow(new Date(Date.now() + 73 * 3600 * 1000));
    expect((await anon().get(`/api/auth/invites/${token}`)).status).toBe(410);
    expect((await anon().post(`/api/auth/invites/${token}`).send({ password: 'a-new-password' })).status).toBe(410);
  });

  it('a new invite replaces the old link', async () => {
    const w = await world();
    const head = await signIn(w.head1.email);
    const c = await head.post('/api/employees').send({ name: 'Two Links', email: 'two@test.example', joinDate: '2026-11-02', salary: 30000, effectiveMonth: '2026-11' });
    const first = await tokenFromEmail('two@test.example', 'invite');
    const again = await head.post(`/api/employees/${c.body.employee.id}/invite`);
    expect(again.status).toBe(200);
    expect(again.body.inviteToken).not.toBe(first);
    expect((await anon().get(`/api/auth/invites/${first}`)).status).toBe(410);
    expect((await anon().get(`/api/auth/invites/${again.body.inviteToken}`)).status).toBe(200);
  });

  it('stores only a hash of the token', async () => {
    const w = await world();
    const head = await signIn(w.head1.email);
    await head.post('/api/employees').send({ name: 'Hash Check', email: 'hash@test.example', joinDate: '2026-11-02', salary: 30000, effectiveMonth: '2026-11' });
    const token = await tokenFromEmail('hash@test.example', 'invite');
    const u = await prisma.user.findUniqueOrThrow({ where: { email: 'hash@test.example' } });
    expect(u.inviteTokenHash).toBeTruthy(); expect(u.inviteTokenHash).not.toBe(token);
  });

  it('there is no self sign-up', async () => {
    const res = await anon().post('/api/employees').send({ name: 'Me', email: 'me@test.example', joinDate: '2026-11-02', salary: 1, effectiveMonth: '2026-11' });
    expect(res.status).toBe(401);
    expect((await anon().post('/api/auth/signup').send({})).status).toBe(404);
  });
});

describe('password reset and change', () => {
  it('emails a reset link that works once and signs out other sessions', async () => {
    const w = await world();
    const old = await signIn(w.priya.email);
    expect((await anon().post('/api/auth/forgot').send({ email: w.priya.email })).status).toBe(204);
    const token = await tokenFromEmail(w.priya.email, 'reset');
    expect((await anon().get(`/api/auth/reset/${token}`)).body).toMatchObject({ name: 'Priya Nair' });
    expect((await anon().post(`/api/auth/reset/${token}`).send({ password: 'brand-new-password' })).status).toBe(200);
    expect((await old.get('/api/auth/me')).status).toBe(401);
    expect((await anon().post(`/api/auth/reset/${token}`).send({ password: 'yet-another-one' })).status).toBe(410);
    expect((await anon().post('/api/auth/login').send({ email: w.priya.email, password: PASSWORD })).status).toBe(401);
    expect((await anon().post('/api/auth/login').send({ email: w.priya.email, password: 'brand-new-password' })).status).toBe(200);
  });

  it('gives the same answer for an unknown email and sends nothing', async () => {
    await makeAdmin();
    expect((await anon().post('/api/auth/forgot').send({ email: 'ghost@test.example' })).status).toBe(204);
    expect(await prisma.emailOutbox.count()).toBe(0);
  });

  it('a reset link expires after an hour', async () => {
    const w = await world();
    await anon().post('/api/auth/forgot').send({ email: w.priya.email });
    const token = await tokenFromEmail(w.priya.email, 'reset');
    setNow(new Date(Date.now() + 61 * 60 * 1000));
    expect((await anon().get(`/api/auth/reset/${token}`)).status).toBe(410);
  });

  it('changes a password only with the current one', async () => {
    const o = await makeOffice('Office 1');
    const e = await makeEmployee(o.id, 'Change Me');
    const agent = await signIn(e.email);
    expect((await agent.post('/api/auth/password').send({ current: 'not-it', next: 'new-password-1' })).status).toBe(422);
    expect((await agent.post('/api/auth/password').send({ current: PASSWORD, next: 'new-password-1' })).status).toBe(204);
    expect((await agent.get('/api/auth/me')).status).toBe(200); // this session stays
    expect((await anon().post('/api/auth/login').send({ email: e.email, password: 'new-password-1' })).status).toBe(200);
  });
});
