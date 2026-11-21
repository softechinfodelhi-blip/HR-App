// On-time streaks, badges, and the office on-time rate.
// Streaks and badges belong to one person: they are shown to that employee, their office head and the admin.
// Nothing here ever ranks individuals against each other. Only offices are compared.
import type { Db } from '../db';
import { isTest } from '../env';
import { addMonths, dbDate, fmtMonth, monthDays, monthOf, today, ymdFromDb, type Month, type Ymd } from '../lib/time';
import { computeDays, computeMonth, employedWhere, empSelect, type Emp } from './attendance';
import type { DayResult } from './day-rules';

export const STREAK_BADGES = [10, 25, 50, 100] as const;
/** How far back streaks are counted from. Long enough for the 100 day badge with room to spare. */
const WINDOW_MONTHS = 13;

export interface StreakResult {
  current: number; best: number;
  /** The date each streak length was first reached in the window. */
  reached: Map<number, Ymd>;
}

/**
 * Consecutive working days with status PRESENT, oldest day first.
 * ON_LEAVE, OFF and HOLIDAY days are skipped and do not break the streak.
 * Any other finished day (half day, absent, missing punch) ends it. Today does not count against anyone while it is open.
 */
export function streakOf(days: DayResult[]): StreakResult {
  let run = 0; let best = 0;
  const reached = new Map<number, Ymd>();
  for (const d of days) {
    if (d.engine === 'ON_LEAVE' || d.engine === 'OFF' || d.engine === 'HOLIDAY') continue;
    if (d.engine === 'PRESENT' || (d.engine === null && d.status === 'present')) {
      run++;
      if (run > best) best = run;
      for (const n of STREAK_BADGES) if (run === n && !reached.has(n)) reached.set(n, d.date);
      continue;
    }
    if (d.engine === null) continue; // today still open, a future date, or outside employment
    run = 0;
  }
  return { current: run, best, reached };
}

/** Months in which every working day was PRESENT (approved leave, offs and holidays aside), for someone employed all month. */
export function perfectMonths(days: DayResult[], before: Month): Month[] {
  const byMonth = new Map<Month, DayResult[]>();
  for (const d of days) { const m = monthOf(d.date); const list = byMonth.get(m); if (list) list.push(d); else byMonth.set(m, [d]); }
  const out: Month[] = [];
  for (const [m, list] of byMonth) {
    if (m >= before || list.length !== monthDays(m).length) continue; // only whole, finished months
    const ok = list.every(d => d.engine === 'PRESENT' || d.engine === 'OFF' || d.engine === 'HOLIDAY' || d.engine === 'ON_LEAVE');
    if (ok && list.some(d => d.engine === 'PRESENT')) out.push(m);
  }
  return out.sort();
}

const windowStart = (e: Emp, t: Ymd): Ymd => {
  const from = `${addMonths(monthOf(t), -WINDOW_MONTHS)}-01`;
  const join = ymdFromDb(e.joiningDate);
  return join > from ? join : from;
};

export interface Badge { key: string; label: string; earned: boolean; hint: string; earnedOn?: Ymd; count?: number; }
export interface Gamification { streak: { current: number; best: number }; badges: Badge[]; }

function badgeList(current: number, best: number, stored: { kind: string; ref: string; earnedOn: Date }[]): Badge[] {
  const out: Badge[] = STREAK_BADGES.map(n => {
    const have = stored.find(b => b.kind === `streak_${n}`);
    const earned = !!have || best >= n;
    const left = n - current;
    return { key: `streak_${n}`, label: `${n} days on time`, earned, hint: earned ? 'Earned' : `${left} more ${left === 1 ? 'day' : 'days'}`, earnedOn: have ? ymdFromDb(have.earnedOn) : undefined };
  });
  const perfect = stored.filter(b => b.kind === 'perfect_month').sort((a, b) => b.ref.localeCompare(a.ref));
  out.push({
    key: 'perfect_month', label: 'Perfect month', earned: perfect.length > 0, count: perfect.length,
    hint: perfect.length ? `Earned for ${fmtMonth(perfect[0].ref)}` : 'Every working day on time in a month',
    earnedOn: perfect[0] ? ymdFromDb(perfect[0].earnedOn) : undefined,
  });
  return out;
}

/** One person's streak and badges, computed now. Reads only. */
export async function gamificationFor(db: Db, e: Emp & { bestStreak: number }): Promise<Gamification> {
  const t = today();
  const days = (await computeDays(db, [e], windowStart(e, t), t)).get(e.id)!;
  const s = streakOf(days);
  const best = Math.max(s.best, e.bestStreak);
  const stored = await db.badge.findMany({ where: { employeeId: e.id } });
  return { streak: { current: s.current, best }, badges: badgeList(s.current, best, stored) };
}

/**
 * Nightly, after the day is finalized: store each person's best streak and any badge newly earned,
 * and tell them about it in the app.
 */
export async function refreshGamification(db: Db): Promise<number> {
  const t = today();
  const emps = await db.employee.findMany({ where: employedWhere(t, t), select: { ...empSelect, bestStreak: true, user: { select: { id: true } } } });
  let awarded = 0;
  for (const e of emps) {
    const days = (await computeDays(db, [e], windowStart(e, t), t)).get(e.id)!;
    const s = streakOf(days);
    if (s.best > e.bestStreak) await db.employee.update({ where: { id: e.id }, data: { bestStreak: s.best } });
    const have = new Set((await db.badge.findMany({ where: { employeeId: e.id }, select: { kind: true, ref: true } })).map(b => `${b.kind}|${b.ref}`));
    const fresh: { kind: string; ref: string; earnedOn: Ymd; text: string }[] = [];
    for (const [n, date] of s.reached) if (!have.has(`streak_${n}|`)) fresh.push({ kind: `streak_${n}`, ref: '', earnedOn: date, text: `${n} days on time in a row. You earned a badge.` });
    for (const m of perfectMonths(days, monthOf(t))) {
      if (!have.has(`perfect_month|${m}`)) fresh.push({ kind: 'perfect_month', ref: m, earnedOn: monthDays(m).at(-1)!, text: `A perfect ${fmtMonth(m)}: on time every working day.` });
    }
    for (const b of fresh) {
      await db.badge.create({ data: { employeeId: e.id, kind: b.kind, ref: b.ref, earnedOn: dbDate(b.earnedOn) } });
      // In the app only: a badge is not worth an email.
      if (e.user) await db.notification.create({ data: { userId: e.user.id, type: 'badge_earned', payload: { text: b.text, link: '/me' } } });
      awarded++;
    }
  }
  return awarded;
}

// ---------- offices ----------
export interface OfficeRate { officeId: string; month: Month; expected: number; onTime: number; rate: number | null; }

const cache = new Map<string, { at: number; value: OfficeRate }>();
const CACHE_MS = 60_000;

/**
 * Share of expected check-ins that were on time, for one office and month, to date.
 * Expected: every finished working day of every person, except full-day leave. On time: checked in by the office start time.
 * Today counts for someone once they have punched in.
 */
export async function officeOnTimeRate(db: Db, officeId: string, month: Month): Promise<OfficeRate> {
  const key = `${officeId}|${month}|${today()}`;
  const hit = cache.get(key);
  if (!isTest && hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const d = monthDays(month);
  const emps = await db.employee.findMany({ where: { officeId, ...employedWhere(d[0], d[d.length - 1]) }, select: empSelect });
  const days = await computeMonth(db, emps, month);
  let expected = 0; let onTime = 0;
  for (const list of days.values()) for (const day of list) {
    if (day.status === 'off' || day.status === 'holiday' || day.status === 'future' || day.status === 'not_joined') continue;
    if (day.engine === 'ON_LEAVE') continue;
    if (!day.closed && !day.inTime) continue; // today, not in yet
    expected++;
    if (day.inTime && !day.late) onTime++;
  }
  const value = { officeId, month, expected, onTime, rate: expected ? Math.round((onTime / expected) * 100) : null };
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** The office with the highest on-time rate in a month. Null when no office has any attendance in it. */
export async function officeOfTheMonth(db: Db, month: Month): Promise<{ officeId: string; rate: number } | null> {
  const offices = await db.office.findMany({ orderBy: { number: 'asc' }, select: { id: true } });
  let best: { officeId: string; rate: number } | null = null;
  for (const o of offices) {
    const r = await officeOnTimeRate(db, o.id, month);
    if (r.rate !== null && (!best || r.rate > best.rate)) best = { officeId: o.id, rate: r.rate };
  }
  return best;
}
