// Who may see and change what. Every route goes through these, so the rules live in one place.
import { fail } from '../lib/errors';

/** 'head' is the API name for the office_head role (the app's screens use it). */
export type ApiRole = 'admin' | 'head' | 'employee';

/** The signed-in person, loaded from the session on every request. */
export interface Actor {
  userId: string;
  sessionId: string;
  role: ApiRole;
  /** Null for the admin, who is not an employee. */
  employeeId: string | null;
  /** The office a head or employee belongs to. Null for the admin. */
  officeId: string | null;
  name: string;
  email: string;
}

/** The part of an employee the rules need. */
export interface Target { id: string; officeId: string; }

export const isManager = (a: Actor) => a.role === 'admin' || a.role === 'head';

/** Admin: everyone. Head: their office. Everyone: themselves. */
export function canView(a: Actor, e: Target): boolean {
  if (a.role === 'admin') return true;
  if (a.employeeId === e.id) return true;
  return a.role === 'head' && a.officeId === e.officeId;
}

/**
 * Admin: everyone. Head: their office, except their own record
 * (salary, quota, balance, details and their own requests go to the admin).
 */
export function canManage(a: Actor, e: Target): boolean {
  if (a.role === 'admin') return true;
  return a.role === 'head' && a.officeId === e.officeId && a.employeeId !== e.id;
}

/** Salary is visible to the admin, the employee's office head and the employee. */
export const canSeeSalary = canView;

export function assertCanView(a: Actor, e: Target) {
  // An employee asking for someone else gets "not found", so ids cannot be probed.
  if (!canView(a, e)) fail(a.role === 'employee' ? 404 : 403, a.role === 'employee' ? 'This was not found.' : 'You can only see your own office.');
}

export function assertCanManage(a: Actor, e: Target, own = 'You cannot change your own record. Ask the admin.') {
  if (canManage(a, e)) return;
  if (a.employeeId === e.id) fail(403, own);
  fail(403, a.role === 'head' ? 'You can only manage your own office.' : 'You do not have access to this.');
}

/** For routes that name an office in the path. A head naming another office gets 403. */
export function assertOffice(a: Actor, officeId: string) {
  if (a.role === 'admin') return;
  if (a.role !== 'head' || a.officeId !== officeId) fail(403, 'You can only see your own office.');
}

/**
 * Turns the `office` query parameter into the offices a manager may read.
 * Returns null for "all offices" (admin only). A head is pinned to their office:
 * `all` or nothing means their office, any other office is refused.
 */
export function resolveOfficeScope(a: Actor, office: string | undefined): string | null {
  if (a.role === 'admin') return !office || office === 'all' ? null : office;
  if (a.role === 'head') {
    if (!office || office === 'all' || office === a.officeId) return a.officeId!;
    fail(403, 'You can only see your own office.');
  }
  fail(403, 'You do not have access to this.');
}
