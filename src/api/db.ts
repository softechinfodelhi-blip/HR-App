// In-memory database for the mock API, kept in localStorage so a reload keeps your changes.
// Replace this whole folder with real HTTP calls when the backend exists (see api/index.ts).
import type { LocalDateTime } from '../types';
import { addMinutes } from '../lib/format';
import { buildSeed, DB_VERSION, type Db } from './seed';

const KEY = 'sbm-hr-demo-db';
const CLOCK_KEY = 'sbm-hr-demo-clock';
const store = (): Storage | null => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } };

function load(): Db {
  try {
    const raw = store()?.getItem(KEY);
    if (raw) { const d = JSON.parse(raw) as Db; if (d.version === DB_VERSION) return d; }
  } catch { /* fall through to a fresh seed */ }
  return buildSeed();
}

export let db: Db = load();
let timer: ReturnType<typeof setTimeout> | null = null;
/** Call after every change. Writes are batched. */
export function save() {
  if (!store()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { try { store()?.setItem(KEY, JSON.stringify(db)); } catch { /* storage full or blocked */ } }, 150);
}
export function resetDb() {
  db = buildSeed();
  try { store()?.removeItem(KEY); } catch { /* ignore */ }
  setClock(CLOCK_PRESETS[0].at);
}
export const nextId = (prefix: string) => `${prefix}-${++db.seq}`;

// ---------- demo clock ----------
// The demo runs on a fixed date and then ticks in real time, so late arrivals show up while you watch.
export const CLOCK_PRESETS: { label: string; at: LocalDateTime }[] = [
  { label: 'Mon 23 Nov, 9:12 AM', at: '2026-11-23T09:12' },
  { label: 'Mon 23 Nov, 6:45 PM', at: '2026-11-23T18:45' },
  { label: 'Tue 1 Dec, 10:00 AM (month end)', at: '2026-12-01T10:00' },
];
let clock = { base: CLOCK_PRESETS[0].at, started: Date.now() };
try {
  const raw = store()?.getItem(CLOCK_KEY);
  if (raw) clock = JSON.parse(raw);
  // A demo left open overnight would run past the sample data, so start the same preset again.
  if (Date.now() - clock.started > 8 * 3600 * 1000) clock.started = Date.now();
} catch { /* ignore */ }
export function now(): LocalDateTime { return addMinutes(clock.base, Math.floor((Date.now() - clock.started) / 60000)); }
export function setClock(at: LocalDateTime) {
  clock = { base: at, started: Date.now() };
  try { store()?.setItem(CLOCK_KEY, JSON.stringify(clock)); } catch { /* ignore */ }
}
export const clockBase = () => clock.base;
