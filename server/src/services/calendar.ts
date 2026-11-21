// The office calendar: weekly offs, holidays and calendar overrides.
import type { Db } from '../db';
import { addDays, dbDate, dow, ymdFromDb, type Ymd } from '../lib/time';

/** Sundays, plus the 2nd and 4th Saturday of the month. */
export function isWeeklyOff(d: Ymd): boolean {
  const w = dow(d);
  if (w === 0) return true;
  if (w === 6) { const nth = Math.ceil(Number(d.slice(8, 10)) / 7); return nth === 2 || nth === 4; }
  return false;
}

export interface DayKind { kind: 'working' | 'off' | 'holiday'; name?: string; }

/** One office's holidays and overrides for a span of dates. */
export interface OfficeCalendar {
  holidays: Map<Ymd, string>;
  overrides: Map<Ymd, { kind: 'working' | 'off'; name: string }>;
}
export const emptyCalendar = (): OfficeCalendar => ({ holidays: new Map(), overrides: new Map() });

/**
 * What kind of day this is for an office, in this order:
 * 1. a calendar override (working or off) wins over everything
 * 2. an office holiday
 * 3. Sunday, or the 2nd or 4th Saturday
 * 4. otherwise a working day (Monday to Saturday)
 */
export function dayKind(d: Ymd, cal: OfficeCalendar): DayKind {
  const o = cal.overrides.get(d);
  if (o) return o.kind === 'working' ? { kind: 'working', name: o.name || undefined } : { kind: 'off', name: o.name || undefined };
  const h = cal.holidays.get(d);
  if (h !== undefined) return { kind: 'holiday', name: h };
  return isWeeklyOff(d) ? { kind: 'off' } : { kind: 'working' };
}

export function workingDates(from: Ymd, to: Ymd, cal: OfficeCalendar): Ymd[] {
  const out: Ymd[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (dayKind(d, cal).kind === 'working') out.push(d);
  return out;
}
/** Working days that have fully passed after `from`, up to and including `to`. Used for escalation. */
export function workingDaysElapsed(from: Ymd, to: Ymd, cal: OfficeCalendar): number {
  return from >= to ? 0 : workingDates(addDays(from, 1), to, cal).length;
}

/** Calendars for several offices at once. Every office id asked for gets an entry. */
export async function loadCalendars(db: Db, officeIds: string[], from: Ymd, to: Ymd): Promise<Map<string, OfficeCalendar>> {
  const out = new Map<string, OfficeCalendar>(officeIds.map(id => [id, emptyCalendar()]));
  const range = { gte: dbDate(from), lte: dbDate(to) };
  const [holidays, overrides] = await Promise.all([
    db.holiday.findMany({ where: { officeId: { in: officeIds }, date: range } }),
    db.calendarOverride.findMany({ where: { officeId: { in: officeIds }, date: range } }),
  ]);
  for (const h of holidays) out.get(h.officeId)!.holidays.set(ymdFromDb(h.date), h.name);
  for (const o of overrides) out.get(o.officeId)!.overrides.set(ymdFromDb(o.date), { kind: o.kind, name: o.name });
  return out;
}
export async function loadCalendar(db: Db, officeId: string, from: Ymd, to: Ymd): Promise<OfficeCalendar> {
  return (await loadCalendars(db, [officeId], from, to)).get(officeId)!;
}
