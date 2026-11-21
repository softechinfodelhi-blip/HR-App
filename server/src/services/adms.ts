// ADMS push protocol (eSSL / ZKTeco). The terminal calls us; we never call the terminal.
// The handshake below is the one that already works with the real terminal: keep it byte for byte.
import { prisma } from '../db';
import { publish } from '../lib/live';
import { istToUtc, now, ymdOf, hhmmOf } from '../lib/time';
import { announceDay, recomputeDay } from './attendance';

/** Reply to GET /iclock/cdata. There is deliberately no TimeZone line. */
export function handshakeText(serial: string, lastStamp: string | null): string {
  return [
    `GET OPTION FROM: ${serial}`,
    `ATTLOGStamp=${lastStamp || '0'}`,
    'OPERLOGStamp=9999',
    'ErrorDelay=30',
    'Delay=10',
    'TransTimes=00:00;14:05',
    'TransInterval=1',
    'TransFlag=TransData AttLog',
    'Realtime=1',
    'Encrypt=None',
  ].join('\n') + '\n';
}

export interface ParsedPunch { terminalUserId: string; punchTime: Date; rawLine: string; }

/**
 * One punch per line, tab separated: user id, "YYYY-MM-DD HH:MM:SS", status, verify type, more fields.
 * The time is the terminal's wall clock, which is Asia/Kolkata. Lines that cannot be read are skipped.
 */
export function parseAttlog(body: string): { lines: number; punches: ParsedPunch[] } {
  const punches: ParsedPunch[] = [];
  let lines = 0;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    lines++;
    const parts = line.split('\t');
    const userId = (parts[0] ?? '').trim();
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec((parts[1] ?? '').trim());
    if (!userId || userId.length > 32 || !m) continue;
    const punchTime = istToUtc(m[1], m[2]);
    if (Number.isNaN(punchTime.getTime())) continue;
    punches.push({ terminalUserId: userId, punchTime, rawLine: line.slice(0, 500) });
  }
  return { lines, punches };
}

/**
 * Called on every request from a terminal. Returns the registered device, or null for an unknown serial
 * (which is noted in the unregistered list and otherwise ignored).
 */
export async function touchDevice(serial: string, ip: string | undefined) {
  if (!serial) return null;
  const t = now();
  const device = await prisma.device.findUnique({ where: { serialNumber: serial } });
  if (device) {
    await prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: t } });
    return device;
  }
  await prisma.unregisteredDevice.upsert({
    where: { serialNumber: serial },
    create: { serialNumber: serial, firstSeenAt: t, lastSeenAt: t, lastIp: ip ?? null },
    update: { lastSeenAt: t, requestCount: { increment: 1 }, lastIp: ip ?? null },
  });
  return null;
}

/** Stores the punches of one ATTLOG upload. Duplicates are skipped. Returns how many lines the terminal sent. */
export async function ingestAttlog(device: { id: string; officeId: string; name: string }, body: string, stamp: string | null): Promise<{ lines: number; inserted: number }> {
  const { lines, punches } = parseAttlog(body);
  const receivedAt = now();
  // The insert and the stamp commit together, so the terminal is only told "OK" for data that is safely stored.
  const inserted = await prisma.$transaction(async tx => {
    const rows = punches.length
      ? await tx.rawPunch.createManyAndReturn({
          data: punches.map(p => ({ deviceId: device.id, terminalUserId: p.terminalUserId, punchTime: p.punchTime, rawLine: p.rawLine, receivedAt })),
          skipDuplicates: true, // unique (device_id, terminal_user_id, punch_time)
          select: { terminalUserId: true, punchTime: true },
        })
      : [];
    if (stamp !== null) await tx.device.update({ where: { id: device.id }, data: { lastAttlogStamp: stamp } });
    return rows;
  });
  if (inserted.length) await afterPunches(device, inserted);
  return { lines, inserted: inserted.length };
}

/** After new punches are stored: recompute each affected attendance day, then tell the live board. */
async function afterPunches(device: { id: string; officeId: string; name: string }, rows: { terminalUserId: string; punchTime: Date }[]) {
  const employees = await prisma.employee.findMany({
    where: { terminalUserId: { in: [...new Set(rows.map(r => r.terminalUserId))] } },
    select: { id: true, name: true, officeId: true, terminalUserId: true },
  });
  // One recompute per employee and date, however many punches arrived for it.
  const affected = new Map<string, { employeeId: string; date: string }>();
  for (const r of rows) {
    const e = employees.find(x => x.terminalUserId === r.terminalUserId);
    if (e) affected.set(`${e.id}|${ymdOf(r.punchTime)}`, { employeeId: e.id, date: ymdOf(r.punchTime) });
  }
  for (const a of affected.values()) {
    try { announceDay(await recomputeDay(prisma, a.employeeId, a.date)); }
    catch (err) { console.error('[adms] recompute failed:', err instanceof Error ? err.message : err); } // the punch is stored; the day is computed again on read
  }
  for (const r of rows) {
    const e = employees.find(x => x.terminalUserId === r.terminalUserId);
    publish({
      type: 'punch',
      officeIds: [...new Set([device.officeId, ...(e ? [e.officeId] : [])])],
      data: {
        employeeId: e?.id ?? null, name: e?.name ?? null, terminalUserId: r.terminalUserId, date: ymdOf(r.punchTime), time: hhmmOf(r.punchTime),
        deviceId: device.id, terminalName: device.name, matched: !!e, otherOffice: !!e && e.officeId !== device.officeId,
      },
    });
  }
}
