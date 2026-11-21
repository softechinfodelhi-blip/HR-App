// The permission rules as pure functions, plus the time helpers. No database.
import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/lib/errors';
import { addMonths, daysInMonth, dow, hhmmOf, isValidYmd, istToUtc, localDateTime, secondsOfDay, ymdOf } from '../src/lib/time';
import { type Actor, canManage, canView, resolveOfficeScope } from '../src/services/permissions';

const base = { userId: 'u', sessionId: 's', name: 'n', email: 'e' };
const admin: Actor = { ...base, role: 'admin', employeeId: null, officeId: null };
const head: Actor = { ...base, role: 'head', employeeId: 'h1', officeId: 'o1' };
const emp: Actor = { ...base, role: 'employee', employeeId: 'e1', officeId: 'o1' };
const status = (fn: () => unknown) => { try { fn(); return 200; } catch (e) { return (e as HttpError).status; } };

describe('permissions', () => {
  it('view: admin all, head own office, everyone themselves', () => {
    expect(canView(admin, { id: 'x', officeId: 'o2' })).toBe(true);
    expect(canView(head, { id: 'e1', officeId: 'o1' })).toBe(true);
    expect(canView(head, { id: 'e9', officeId: 'o2' })).toBe(false);
    expect(canView(emp, { id: 'e1', officeId: 'o1' })).toBe(true);
    expect(canView(emp, { id: 'e2', officeId: 'o1' })).toBe(false);
  });
  it('manage: a head never manages their own record or another office', () => {
    expect(canManage(admin, { id: 'h1', officeId: 'o1' })).toBe(true);
    expect(canManage(head, { id: 'e1', officeId: 'o1' })).toBe(true);
    expect(canManage(head, { id: 'h1', officeId: 'o1' })).toBe(false);
    expect(canManage(head, { id: 'e9', officeId: 'o2' })).toBe(false);
    expect(canManage(emp, { id: 'e1', officeId: 'o1' })).toBe(false);
  });
  it('scope: the admin chooses, a head is pinned, an employee has none', () => {
    expect(resolveOfficeScope(admin, undefined)).toBeNull();
    expect(resolveOfficeScope(admin, 'all')).toBeNull();
    expect(resolveOfficeScope(admin, 'o2')).toBe('o2');
    expect(resolveOfficeScope(head, undefined)).toBe('o1');
    expect(resolveOfficeScope(head, 'all')).toBe('o1');
    expect(resolveOfficeScope(head, 'o1')).toBe('o1');
    expect(status(() => resolveOfficeScope(head, 'o2'))).toBe(403);
    expect(status(() => resolveOfficeScope(emp, 'o1'))).toBe(403);
  });
});

describe('office time (Asia/Kolkata)', () => {
  it('converts between the office clock and UTC', () => {
    expect(istToUtc('2026-11-23', '09:00:59').toISOString()).toBe('2026-11-23T03:30:59.000Z');
    expect(istToUtc('2026-11-23', '02:00').toISOString()).toBe('2026-11-22T20:30:00.000Z'); // the UTC date is the day before
    const d = new Date('2026-11-22T20:30:00Z');
    expect(ymdOf(d)).toBe('2026-11-23'); expect(hhmmOf(d)).toBe('02:00'); expect(localDateTime(d)).toBe('2026-11-23T02:00');
    expect(secondsOfDay(istToUtc('2026-11-23', '09:00:59'))).toBe(9 * 3600 + 59);
  });
  it('does calendar maths', () => {
    expect(daysInMonth('2026-11')).toBe(30); expect(daysInMonth('2028-02')).toBe(29);
    expect(dow('2026-11-22')).toBe(0); // Sunday
    expect(addMonths('2026-12', 1)).toBe('2027-01'); expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(isValidYmd('2026-02-30')).toBe(false); expect(isValidYmd('2026-02-28')).toBe(true);
  });
});
