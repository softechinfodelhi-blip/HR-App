// Terminals as the app shows them.
import type { Db } from '../db';
import { addDays, istToUtc, localDateTime, now, today, type Ymd } from '../lib/time';

/** A terminal polls every few seconds. Silent for longer than this shows as Offline. */
export const ONLINE_WINDOW_MS = 5 * 60 * 1000;

export interface TerminalStatus {
  id: string; officeId: string; officeName: string; name: string; serial: string;
  online: boolean; lastSeen: string | null; punchesToday: number;
}

/** The UTC instants that bound one office day. */
export const dayBounds = (d: Ymd) => ({ gte: istToUtc(d), lt: istToUtc(addDays(d, 1)) });

export async function terminalStatuses(db: Db, where: { officeId?: string }): Promise<TerminalStatus[]> {
  const devices = await db.device.findMany({ where, include: { office: { select: { name: true, number: true } } } });
  const counts = await db.rawPunch.groupBy({ by: ['deviceId'], where: { deviceId: { in: devices.map(d => d.id) }, punchTime: dayBounds(today()) }, _count: { _all: true } });
  const t = now().getTime();
  return devices
    .sort((a, b) => a.office.number - b.office.number || a.name.localeCompare(b.name))
    .map(d => ({
      id: d.id, officeId: d.officeId, officeName: d.office.name, name: d.name, serial: d.serialNumber,
      online: !!d.lastSeenAt && t - d.lastSeenAt.getTime() <= ONLINE_WINDOW_MS,
      lastSeen: d.lastSeenAt ? localDateTime(d.lastSeenAt) : null,
      punchesToday: counts.find(c => c.deviceId === d.id)?._count._all ?? 0,
    }));
}
