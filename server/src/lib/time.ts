// The business runs on Asia/Kolkata, which is UTC+5:30 all year (no daylight saving).
// Instants are stored in UTC. Calendar dates are plain 'YYYY-MM-DD' strings in office time.
export type Ymd = string; // 2026-11-23
export type Month = string; // 2026-11

const IST_OFFSET_MS = 330 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, '0');

/** The clock. Tests replace it with setNow(). */
let fixedNow: Date | null = null;
export const now = (): Date => (fixedNow ? new Date(fixedNow) : new Date());
export function setNow(d: Date | string | null) { fixedNow = d === null ? null : new Date(d); }

/** A Date whose UTC fields read as the wall clock in India. Only for formatting. */
const shifted = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS);

export function ymdOf(d: Date): Ymd { const s = shifted(d); return `${s.getUTCFullYear()}-${pad(s.getUTCMonth() + 1)}-${pad(s.getUTCDate())}`; }
export function hhmmOf(d: Date): string { const s = shifted(d); return `${pad(s.getUTCHours())}:${pad(s.getUTCMinutes())}`; }
/** Seconds since midnight, office time. */
export function secondsOfDay(d: Date): number { const s = shifted(d); return s.getUTCHours() * 3600 + s.getUTCMinutes() * 60 + s.getUTCSeconds(); }
/** 'YYYY-MM-DDTHH:mm' in office time: the timestamp format the app displays. */
export function localDateTime(d: Date): string { return `${ymdOf(d)}T${hhmmOf(d)}`; }
export const today = (): Ymd => ymdOf(now());
export const monthOf = (d: string): Month => d.slice(0, 7);
export const thisMonth = (): Month => monthOf(today());

/** Office wall clock ('YYYY-MM-DD', 'HH:mm' or 'HH:mm:ss') to the UTC instant. */
export function istToUtc(date: Ymd, time = '00:00:00'): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm, ss = 0] = time.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm, ss) - IST_OFFSET_MS);
}

// Postgres `date` columns arrive from Prisma as a Date at UTC midnight.
export function dbDate(d: Ymd): Date { return new Date(`${d}T00:00:00.000Z`); }
export function ymdFromDb(d: Date): Ymd { return d.toISOString().slice(0, 10); }

// ---------- calendar maths on plain strings ----------
const utcMs = (d: Ymd) => Date.parse(`${d}T00:00:00Z`);
export function addDays(d: Ymd, n: number): Ymd { return new Date(utcMs(d) + n * 86400000).toISOString().slice(0, 10); }
/** 0 = Sunday ... 6 = Saturday */
export function dow(d: Ymd): number { return new Date(utcMs(d)).getUTCDay(); }
export function daysInMonth(m: Month): number { const [y, mm] = m.split('-').map(Number); return new Date(Date.UTC(y, mm, 0)).getUTCDate(); }
export function monthDays(m: Month): Ymd[] { return Array.from({ length: daysInMonth(m) }, (_, i) => `${m}-${pad(i + 1)}`); }
export function addMonths(m: Month, n: number): Month {
  const [y, mm] = m.split('-').map(Number); const t = y * 12 + (mm - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}
export function dateRange(a: Ymd, b: Ymd): Ymd[] { const out: Ymd[] = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; }
export function isValidYmd(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const ms = utcMs(s);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === s;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** 'Mon 23 Nov', for messages and the audit log. */
export function fmtDate(d: Ymd): string { const [, m, dd] = d.split('-').map(Number); return `${DOW[dow(d)]} ${dd} ${MON[m - 1]}`; }
/** 'November 2026' */
export function fmtMonth(m: Month): string { const [y, mm] = m.split('-').map(Number); return `${MON_LONG[mm - 1]} ${y}`; }
/** '23 Nov' */
export function fmtDay(d: Ymd): string { const [, m, dd] = d.split('-').map(Number); return `${dd} ${MON[m - 1]}`; }
/** 'Mon 23 Nov', '23 to 25 Nov' or '30 Nov to 2 Dec' */
export function fmtRange(a: Ymd, b: Ymd): string {
  if (a === b) return fmtDate(a);
  const ma = Number(a.slice(5, 7)), mb = Number(b.slice(5, 7));
  return ma === mb ? `${Number(a.slice(8))} to ${Number(b.slice(8))} ${MON[mb - 1]}` : `${fmtDay(a)} to ${fmtDay(b)}`;
}
/** '1 day', '0.5 day', '2.5 days' */
export function fmtDays(n: number): string { return `${Number.isInteger(n) ? n : n.toFixed(1)} ${n === 1 || n === 0.5 ? 'day' : 'days'}`; }
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
