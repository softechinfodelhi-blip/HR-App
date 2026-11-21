// Session cookie, role guards and office scoping.
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../db';
import { env, isProd } from '../env';
import { fail } from '../lib/errors';
import { now } from '../lib/time';
import { hashSession, newToken } from '../lib/tokens';
import { zUuid } from '../lib/validate';
import { type Actor, type ApiRole, isManager, resolveOfficeScope } from '../services/permissions';

declare module 'express-serve-static-core' {
  interface Request {
    actor?: Actor;
    /** Set by `officeScope`: one office id, or null for all offices (admin only). */
    officeScope?: string | null;
  }
}

export const SESSION_COOKIE = 'sid';
const IDLE_MS = 12 * 3600 * 1000; // signed out after 12 hours without a request
const MAX_MS = 7 * 24 * 3600 * 1000; // and after 7 days in any case

const apiRole = (r: string): ApiRole => (r === 'office_head' ? 'head' : (r as ApiRole));

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function cookieOptions() {
  return { httpOnly: true, secure: isProd, sameSite: 'lax' as const, path: '/' };
}

export async function startSession(res: Response, userId: string): Promise<void> {
  const token = newToken();
  const t = now();
  await prisma.session.create({ data: { tokenHash: hashSession(token), userId, expiresAt: new Date(t.getTime() + MAX_MS), lastUsedAt: t } });
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), maxAge: MAX_MS });
}

export async function endSession(req: Request, res: Response): Promise<void> {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await prisma.session.deleteMany({ where: { tokenHash: hashSession(token) } });
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

/** Loads the signed-in person, if any. Never rejects a request by itself. */
export async function loadSession(req: Request, _res: Response, next: NextFunction) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return next();
  const s = await prisma.session.findUnique({
    where: { tokenHash: hashSession(token) },
    include: { user: { include: { employee: true } } },
  });
  if (!s) return next();
  const t = now();
  if (s.expiresAt <= t || t.getTime() - s.lastUsedAt.getTime() > IDLE_MS) {
    await prisma.session.deleteMany({ where: { id: s.id } });
    return next();
  }
  const u = s.user;
  // A switched-off account loses access at once, even with a valid cookie.
  if (u.employee && u.employee.status === 'inactive') return next();
  if (u.role !== 'admin' && !u.employee) return next();
  if (t.getTime() - s.lastUsedAt.getTime() > 60_000) {
    await prisma.session.updateMany({ where: { id: s.id }, data: { lastUsedAt: t } });
  }
  req.actor = {
    userId: u.id, sessionId: s.id, role: apiRole(u.role), employeeId: u.employeeId,
    officeId: u.employee?.officeId ?? null, name: u.employee?.name ?? u.name, email: u.email,
  };
  next();
}

/** The signed-in person, or 401. */
export function actorOf(req: Request): Actor {
  return req.actor ?? fail(401, 'Please sign in again.');
}
export function requireAuth(req: Request, _res: Response, next: NextFunction) { actorOf(req); next(); }
/** Admin or office head. */
export function requireManager(req: Request, _res: Response, next: NextFunction) {
  if (!isManager(actorOf(req))) fail(403, 'You do not have access to this.');
  next();
}
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (actorOf(req).role !== 'admin') fail(403, 'Only the admin can do this.');
  next();
}

/**
 * Office scoping for list routes. Reads `?office=` and sets `req.officeScope`.
 * A head asking for another office gets 403 here, before any query runs.
 * Queries must still filter by the scope: use `scopeWhere(req)`.
 */
export async function officeScope(req: Request, _res: Response, next: NextFunction) {
  const a = actorOf(req);
  const raw = typeof req.query.office === 'string' ? req.query.office : undefined;
  const scope = resolveOfficeScope(a, raw);
  if (scope !== null) {
    if (!zUuid.safeParse(scope).success || !(await prisma.office.findUnique({ where: { id: scope }, select: { id: true } }))) fail(404, 'Office was not found.');
  }
  req.officeScope = scope;
  next();
}
/** `{ officeId }` filter for the request's scope. Empty for the admin looking at all offices. */
export function scopeWhere(req: Request): { officeId?: string } {
  if (req.officeScope === undefined) throw new Error('officeScope middleware is missing on this route');
  return req.officeScope === null ? {} : { officeId: req.officeScope };
}

/**
 * The session cookie is SameSite=Lax. As a second guard against cross-site requests,
 * a write must come from our own origin when the browser says where it came from.
 */
export function sameOrigin(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next(); // not a browser (curl, tests): there is no cookie to steal there
  let host: string;
  try { host = new URL(origin).host; } catch { return fail(403, 'This request was blocked.'); }
  if (host === req.headers.host || origin === new URL(env.APP_URL).origin) return next();
  fail(403, 'This request was blocked.');
}
