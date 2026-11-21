import type { LocalDateTime, Month, Ymd } from '../types';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MON_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const pad = (n: number) => String(n).padStart(2, '0');
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// ---------- date maths on plain strings (no time zone surprises) ----------
export function parts(d: Ymd) { const [y, m, dd] = d.split('-').map(Number); return { y, m, d: dd }; }
function utc(d: Ymd) { const p = parts(d); return Date.UTC(p.y, p.m - 1, p.d); }
function fromUtc(ms: number): Ymd { const x = new Date(ms); return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`; }
export function addDays(d: Ymd, n: number): Ymd { return fromUtc(utc(d) + n * 86400000); }
export function dow(d: Ymd): number { return new Date(utc(d)).getUTCDay(); }
export function monthOf(d: string): Month { return d.slice(0, 7); }
export function daysInMonth(m: Month): number { const [y, mm] = m.split('-').map(Number); return new Date(Date.UTC(y, mm, 0)).getUTCDate(); }
export function monthDays(m: Month): Ymd[] { return Array.from({ length: daysInMonth(m) }, (_, i) => `${m}-${pad(i + 1)}`); }
export function addMonths(m: Month, n: number): Month {
  const [y, mm] = m.split('-').map(Number); const t = y * 12 + (mm - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}
export function monthsBetween(a: Month, b: Month): number {
  const [ay, am] = a.split('-').map(Number); const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}
export function dateRange(a: Ymd, b: Ymd): Ymd[] { const out: Ymd[] = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; }
export const dateOf = (t: LocalDateTime): Ymd => t.slice(0, 10);
export const timeOf = (t: LocalDateTime): string => t.slice(11, 16);
export function toMin(hhmm: string): number { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
export function fromMin(min: number): string { return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`; }
export function addMinutes(t: LocalDateTime, n: number): LocalDateTime {
  const p = parts(dateOf(t)); const m = toMin(timeOf(t));
  const x = new Date(Date.UTC(p.y, p.m - 1, p.d, 0, m + n));
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}T${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}`;
}

// ---------- display ----------
export function fmtTime(hhmm: string | null | undefined): string {
  if (!hhmm) return 'No punch';
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
}
export function fmtDate(d: Ymd): string { const p = parts(d); return `${DOW[dow(d)]} ${p.d} ${MON[p.m - 1]}`; }
export function fmtDateLong(d: Ymd): string { const p = parts(d); return `${DOW[dow(d)]} ${p.d} ${MON[p.m - 1]} ${p.y}`; }
export function fmtDay(d: Ymd): string { const p = parts(d); return `${p.d} ${MON[p.m - 1]}`; }
export function fmtRange(a: Ymd, b: Ymd): string {
  if (a === b) return fmtDate(a);
  const pa = parts(a), pb = parts(b);
  return pa.m === pb.m ? `${pa.d} to ${pb.d} ${MON[pb.m - 1]}` : `${fmtDay(a)} to ${fmtDay(b)}`;
}
export function fmtMonth(m: Month): string { const [y, mm] = m.split('-').map(Number); return `${MON_LONG[mm - 1]} ${y}`; }
export function fmtMonthName(m: Month): string { return MON_LONG[Number(m.split('-')[1]) - 1]; }
export function fmtDateTime(t: LocalDateTime): string { return `${fmtDay(dateOf(t))}, ${fmtTime(timeOf(t))}`; }
export function dowShort(d: Ymd): string { return DOW[dow(d)][0]; }
const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inr0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
export function fmtMoney(n: number): string { return `₹${inr.format(n)}`; }
export function fmtMoney0(n: number): string { return `₹${inr0.format(n)}`; }
export function fmtNum(n: number): string { return Number.isInteger(n) ? String(n) : n.toFixed(1); }
export function fmtDays(n: number): string { return `${fmtNum(n)} ${n === 1 || n === 0.5 ? 'day' : 'days'}`; }
export function fmtDuration(min: number): string { return `${Math.floor(min / 60)} h ${pad(min % 60)} m`; }
export function initials(name: string): string { return name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase(); }
export function firstName(name: string): string { return name.split(' ')[0]; }

// ---------- the clock ----------
// The office runs on Asia/Kolkata (UTC+5:30, no daylight saving), whatever the time zone of this device.
// Every API response carries the server's time, so a device with a wrong clock still shows the right day.
let clockOffsetMs = 0;
const istOf = (ms: number): LocalDateTime => new Date(ms + 330 * 60000).toISOString().slice(0, 16);
/** Called by the API client with the server's time ('YYYY-MM-DDTHH:mm', office time). */
export function syncClock(serverNow: LocalDateTime) {
  const server = Date.parse(`${serverNow}:00Z`) - 330 * 60000;
  const diff = server - Date.now();
  // The server sends whole minutes, so a difference under two minutes is just rounding.
  clockOffsetMs = Number.isFinite(diff) && Math.abs(diff) > 120000 ? diff : 0;
}
/** Now, in office time. */
export function nowLocal(): LocalDateTime { return istOf(Date.now() + clockOffsetMs); }
export const todayYmd = (): Ymd => dateOf(nowLocal());
export const thisMonth = (): Month => monthOf(nowLocal());
