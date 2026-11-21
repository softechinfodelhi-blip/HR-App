// Sign in, sign out, invite links, password reset and password change.
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { prisma, type Db } from '../db';
import { audit } from '../lib/audit';
import { fail } from '../lib/errors';
import { hashPassword, verifyPassword } from '../lib/password';
import { now } from '../lib/time';
import { hashToken } from '../lib/tokens';
import { parse, zEmail, zPassword } from '../lib/validate';
import { actorOf, endSession, startSession } from '../middleware/auth';
import { sendInvite, sendReset } from '../services/invites';
import type { Actor, ApiRole } from '../services/permissions';
import { getSettings } from '../services/settings';

export interface SessionUser {
  /** The employee id for heads and employees (screens compare it with employeeId). The user id for the admin. */
  id: string; userId: string; employeeId: string | null; code: string | null;
  name: string; email: string; role: ApiRole; officeId: string | null; officeName: string | null;
}

async function sessionUser(db: Db, userId: string): Promise<SessionUser> {
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, include: { employee: { include: { office: { select: { name: true } } } } } });
  return {
    id: u.employeeId ?? u.id, userId: u.id, employeeId: u.employeeId, code: u.employee?.code ?? null,
    name: u.employee?.name ?? u.name, email: u.email, role: u.role === 'office_head' ? 'head' : u.role,
    officeId: u.employee?.officeId ?? null, officeName: u.employee?.office.name ?? null,
  };
}

const GONE_INVITE = 'This invite link has been used or has expired. Ask your office head to send a new one.';
const GONE_RESET = 'This reset link has been used or has expired. Ask for a new one from the sign in page.';

async function userByInvite(token: string) {
  const u = await prisma.user.findUnique({ where: { inviteTokenHash: hashToken(token) }, include: { employee: { include: { office: { select: { name: true } } } } } });
  if (!u || !u.inviteExpiresAt || u.inviteExpiresAt <= now() || u.employee?.status === 'inactive') fail(410, GONE_INVITE);
  return u;
}
async function userByReset(token: string) {
  const u = await prisma.user.findUnique({ where: { resetTokenHash: hashToken(token) }, include: { employee: true } });
  if (!u || !u.resetExpiresAt || u.resetExpiresAt <= now() || u.employee?.status === 'inactive') fail(410, GONE_RESET);
  return u;
}
/** For audit rows written before a session exists (the person is acting on their own account). */
const selfActor = (u: { id: string; email: string; name: string; employeeId: string | null; employee?: { name: string; officeId: string } | null }): Actor => ({
  userId: u.id, sessionId: '', role: 'employee', employeeId: u.employeeId, officeId: u.employee?.officeId ?? null, name: u.employee?.name ?? u.name, email: u.email,
});

/** `limiter` is applied to every route here that takes a password, an email or a token from someone not signed in. */
export function authRoutes(limiter: RequestHandler, loginByEmail: RequestHandler): Router {
  const r = Router();

  r.post('/login', limiter, loginByEmail, async (req, res) => {
    const body = parse(z.object({ email: zEmail, password: z.string().min(1, 'Enter your password.').max(200) }), req.body);
    const u = await prisma.user.findUnique({ where: { email: body.email }, include: { employee: true } });
    const ok = await verifyPassword(u?.passwordHash, body.password);
    // An invited person has no password yet. Telling them is more useful here than hiding that the email exists.
    if (u && !u.passwordHash && u.employee?.status === 'invited') fail(403, 'Set your password from the invite email first.');
    if (!u || !ok) fail(401, 'Email or password is not right.');
    if (u.employee?.status === 'inactive') fail(403, 'This account is switched off. Ask your office head.');
    await prisma.user.update({ where: { id: u.id }, data: { lastLoginAt: now() } });
    await startSession(res, u.id);
    res.json(await sessionUser(prisma, u.id));
  });

  r.post('/logout', async (req, res) => { await endSession(req, res); res.status(204).end(); });

  r.get('/me', async (req, res) => { res.json(await sessionUser(prisma, actorOf(req).userId)); });

  // ----- invite: set the first password -----
  r.get('/invites/:token', limiter, async (req, res) => {
    const u = await userByInvite(String(req.params.token));
    res.json({ name: u.employee?.name ?? u.name, email: u.email, officeName: u.employee?.office.name ?? '', companyName: (await getSettings(prisma)).companyName });
  });

  r.post('/invites/:token', limiter, async (req, res) => {
    const { password } = parse(z.object({ password: zPassword }), req.body);
    const u = await userByInvite(String(req.params.token));
    const passwordHash = await hashPassword(password);
    await prisma.$transaction(async tx => {
      // The token is cleared in the same statement that checks it, so a link cannot be used twice.
      const done = await tx.user.updateMany({ where: { id: u.id, inviteTokenHash: u.inviteTokenHash }, data: { passwordHash, inviteTokenHash: null, inviteExpiresAt: null } });
      if (done.count !== 1) fail(410, GONE_INVITE);
      if (u.employee) await tx.employee.update({ where: { id: u.employee.id }, data: { status: 'active' } });
      await audit(tx, selfActor(u), { action: 'Password set from invite', entity: 'user', entityId: u.id, officeId: u.employee?.officeId, detail: u.employee ? `${u.employee.name} (${u.employee.code})` : u.email, old: { status: 'invited' }, new: { status: 'active' } });
    });
    await startSession(res, u.id);
    res.json(await sessionUser(prisma, u.id));
  });

  // ----- forgot password -----
  r.post('/forgot', limiter, async (req, res) => {
    const { email } = parse(z.object({ email: zEmail }), req.body);
    const u = await prisma.user.findUnique({ where: { email }, include: { employee: true } });
    // Always the same answer, so this cannot be used to find out who has an account.
    if (u && u.employee?.status !== 'inactive') {
      const name = u.employee?.name ?? u.name;
      if (u.passwordHash) await sendReset(prisma, u, name);
      else await sendInvite(prisma, u, name); // never set a password: a fresh invite does the same job
    }
    res.status(204).end();
  });

  r.get('/reset/:token', limiter, async (req, res) => {
    const u = await userByReset(String(req.params.token));
    res.json({ name: u.employee?.name ?? u.name, email: u.email, companyName: (await getSettings(prisma)).companyName });
  });

  r.post('/reset/:token', limiter, async (req, res) => {
    const { password } = parse(z.object({ password: zPassword }), req.body);
    const u = await userByReset(String(req.params.token));
    const passwordHash = await hashPassword(password);
    await prisma.$transaction(async tx => {
      const done = await tx.user.updateMany({ where: { id: u.id, resetTokenHash: u.resetTokenHash }, data: { passwordHash, resetTokenHash: null, resetExpiresAt: null } });
      if (done.count !== 1) fail(410, GONE_RESET);
      await tx.session.deleteMany({ where: { userId: u.id } }); // sign out everywhere
      await audit(tx, selfActor(u), { action: 'Password reset', entity: 'user', entityId: u.id, officeId: u.employee?.officeId, detail: u.employee ? `${u.employee.name} (${u.employee.code})` : u.email });
    });
    await startSession(res, u.id);
    res.json(await sessionUser(prisma, u.id));
  });

  // ----- change password while signed in -----
  r.post('/password', limiter, async (req, res) => {
    const a = actorOf(req);
    const body = parse(z.object({ current: z.string().min(1, 'Enter your current password.').max(200), next: zPassword }), req.body);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: a.userId } });
    if (!(await verifyPassword(u.passwordHash, body.current))) fail(422, 'Current password is not right.');
    const passwordHash = await hashPassword(body.next);
    await prisma.$transaction(async tx => {
      await tx.user.update({ where: { id: a.userId }, data: { passwordHash } });
      await tx.session.deleteMany({ where: { userId: a.userId, id: { not: a.sessionId } } }); // other devices are signed out
      await audit(tx, a, { action: 'Password changed', entity: 'user', entityId: a.userId, officeId: a.officeId });
    });
    res.status(204).end();
  });

  return r;
}
