// The month lock. Once an office's month is locked nothing in it may change until the admin unlocks it.
import type { Db } from '../db';
import { fail } from '../lib/errors';
import { fmtMonth, monthOf, type Month, type Ymd } from '../lib/time';

export async function isLocked(db: Db, officeId: string, month: Month): Promise<boolean> {
  const run = await db.payrollRun.findUnique({ where: { officeId_month: { officeId, month } }, select: { status: true } });
  return run?.status === 'locked';
}

/** 409 when any of the dates falls in a locked month of this office. */
export async function assertOpen(db: Db, officeId: string, dates: Ymd[]): Promise<void> {
  for (const m of new Set(dates.map(monthOf))) {
    if (await isLocked(db, officeId, m)) fail(409, `${fmtMonth(m)} is locked for this office. Ask the admin to unlock it first.`);
  }
}
