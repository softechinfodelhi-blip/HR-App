// The office calendar. Phase 3 adds holidays and calendar overrides on top of the weekly offs.
import { dow, type Ymd } from '../lib/time';

/** Sundays, plus the 2nd and 4th Saturday of the month. */
export function isWeeklyOff(d: Ymd): boolean {
  const w = dow(d);
  if (w === 0) return true;
  if (w === 6) { const nth = Math.ceil(Number(d.slice(8, 10)) / 7); return nth === 2 || nth === 4; }
  return false;
}
