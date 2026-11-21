// Terminals as the app shows them, and the live "today" board built from raw punches.
import type { Db } from '../db';
import { addDays, hhmmOf, istToUtc, localDateTime, now, secondsOfDay, today, ymdOf, type Ymd } from '../lib/time';
import { isWeeklyOff } from './calendar';

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

const clock = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const toSec = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 3600 + m * 60; };

/**
 * Who is in today, straight from the punches. First punch = in, last punch = out.
 * Phase 3 replaces the status logic with the attendance engine (leave, holidays, corrections).
 */
export async function todayBoard(db: Db, scope: { officeId?: string }) {
  const date = today();
  const t = now();
  const offices = await db.office.findMany({ where: scope.officeId ? { id: scope.officeId } : {}, orderBy: { number: 'asc' } });
  const employees = await db.employee.findMany({
    where: { ...scope, status: { not: 'inactive' }, joiningDate: { lte: new Date(`${date}T00:00:00Z`) }, OR: [{ lastWorkingDate: null }, { lastWorkingDate: { gte: new Date(`${date}T00:00:00Z`) } }] },
    orderBy: { name: 'asc' }, select: { id: true, name: true, officeId: true, terminalUserId: true },
  });
  const ids = employees.map(e => e.terminalUserId).filter((x): x is string => !!x);
  const punches = await db.rawPunch.findMany({
    where: { terminalUserId: { in: ids }, punchTime: dayBounds(date) }, orderBy: { punchTime: 'asc' },
    select: { terminalUserId: true, punchTime: true, device: { select: { officeId: true } } },
  });
  const working = !isWeeklyOff(date);
  const officeById = new Map(offices.map(o => [o.id, o]));
  const allOffices = new Map((await db.office.findMany({ select: { id: true, name: true } })).map(o => [o.id, o.name]));

  const people = employees.map(e => {
    const office = officeById.get(e.officeId)!;
    const mine = punches.filter(p => p.terminalUserId === e.terminalUserId);
    const first = mine[0]?.punchTime ?? null;
    const last = mine.length > 1 ? mine[mine.length - 1].punchTime : null;
    const startSec = toSec(office.startTime) + 59; // 09:00:59 is still on time
    const late = first ? secondsOfDay(first) > startSec : working && ymdOf(t) === date && secondsOfDay(t) > startSec;
    const other = mine.find(p => p.device.officeId !== e.officeId)?.device.officeId ?? null;
    const status = !working ? 'off' : first ? 'working' : 'not_in';
    const label = !working ? 'Weekly off' : !first ? 'Not yet in' : last ? `Last punch ${clock(hhmmOf(last))}` : `In since ${clock(hhmmOf(first))}`;
    return {
      employeeId: e.id, name: e.name, officeId: e.officeId, officeName: office.name,
      day: {
        date, status, label, inTime: first ? hhmmOf(first) : null, outTime: last ? hhmmOf(last) : null,
        workedMin: first && last ? Math.floor((last.getTime() - first.getTime()) / 60000) : 0,
        unpaid: 0, late, manual: false, otherOffice: other ? allOffices.get(other) ?? null : null,
      },
    };
  });

  const expected = people.filter(p => p.day.status !== 'off');
  const terminals = await terminalStatuses(db, scope);
  return {
    date, time: hhmmOf(t), working, dayLabel: working ? '' : 'Weekly off',
    counts: {
      total: expected.length, in: expected.filter(p => p.day.status === 'working').length,
      notIn: expected.filter(p => p.day.status === 'not_in').length,
      onLeave: 0, // Phase 4
      waiting: 0, // Phase 4: requests waiting for this person
    },
    people,
    offices: offices.map(o => ({
      officeId: o.id, name: o.name, headcount: employees.filter(e => e.officeId === o.id).length,
      onTime: null as number | null, lastMonth: null as number | null, best: false, // Phase 6
      terminal: terminals.find(x => x.officeId === o.id) ?? null,
    })),
  };
}
