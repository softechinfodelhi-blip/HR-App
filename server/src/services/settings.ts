import type { Db } from '../db';

export interface Settings {
  companyName: string;
  defaultClQuota: number;
  defaultPlQuota: number;
  /** PL carried into the next year is capped at this many days. */
  plCarryMax: number;
  /** A request pending this many working days also goes to the admin. */
  escalateAfterWorkingDays: number;
  /** Month the leave year starts: 1 = January. Only January is supported. */
  leaveYearStart: number;
}

export const DEFAULT_SETTINGS: Settings = {
  companyName: 'SBM Management',
  defaultClQuota: 12,
  defaultPlQuota: 18,
  plCarryMax: 30,
  escalateAfterWorkingDays: 2,
  leaveYearStart: 1,
};

export async function getSettings(db: Db): Promise<Settings> {
  const rows = await db.setting.findMany();
  const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const r of rows) if (r.key in DEFAULT_SETTINGS) out[r.key] = r.value;
  return out as unknown as Settings;
}

export async function saveSettings(db: Db, patch: Partial<Settings>): Promise<void> {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
}
