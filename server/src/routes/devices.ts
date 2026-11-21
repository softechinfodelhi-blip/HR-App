// Terminals: registered devices, serials that called but are not registered, and punches nobody owns yet.
import { Router } from 'express';
import { z } from 'zod';
import { Prisma, prisma } from '../db';
import { audit } from '../lib/audit';
import { fail } from '../lib/errors';
import { publish } from '../lib/live';
import { localDateTime } from '../lib/time';
import { pageOf, parse, skipTake, zListQuery, zUuid } from '../lib/validate';
import { actorOf, officeScope, requireManager, scopeWhere } from '../middleware/auth';
import { terminalStatuses } from '../services/devices';
import { assertOffice } from '../services/permissions';

const zSerial = z.string().trim().min(3, 'Enter the serial number printed on the terminal.').max(64).regex(/^[A-Za-z0-9_-]+$/, 'A serial number has only letters and digits.');
const zDeviceName = z.string().trim().max(60).default('');

export function deviceRoutes(): Router {
  const r = Router();

  /** GET /devices?office= */
  r.get('/', requireManager, officeScope, async (req, res) => { res.json(await terminalStatuses(prisma, scopeWhere(req))); });

  /**
   * GET /devices/unregistered  Serials that reached the server but are not registered.
   * They belong to no office yet, so every manager sees them and can claim theirs.
   */
  r.get('/unregistered', requireManager, async (_req, res) => {
    const rows = await prisma.unregisteredDevice.findMany({ orderBy: { lastSeenAt: 'desc' }, take: 50 });
    res.json(rows.map(u => ({ serial: u.serialNumber, firstSeen: localDateTime(u.firstSeenAt), lastSeen: localDateTime(u.lastSeenAt), requests: u.requestCount })));
  });

  /** GET /devices/punches?office=&page=  Latest punches received, newest first. */
  r.get('/punches', requireManager, officeScope, async (req, res) => {
    const q = parse(zListQuery.extend({ pageSize: z.coerce.number().int().min(1).max(200).default(40) }), req.query);
    const scope = scopeWhere(req);
    const employees = await prisma.employee.findMany({ where: { terminalUserId: { not: null } }, select: { id: true, name: true, officeId: true, terminalUserId: true } });
    // A punch belongs to an office when it was made on its terminal or by one of its people.
    const where: Prisma.RawPunchWhereInput = scope.officeId
      ? { OR: [{ device: { officeId: scope.officeId } }, { terminalUserId: { in: employees.filter(e => e.officeId === scope.officeId).map(e => e.terminalUserId!) } }] }
      : {};
    const [total, rows] = await Promise.all([
      prisma.rawPunch.count({ where }),
      prisma.rawPunch.findMany({ where, orderBy: [{ punchTime: 'desc' }, { id: 'desc' }], ...skipTake(q), include: { device: { select: { name: true, officeId: true } } } }),
    ]);
    res.json(pageOf(rows.map(p => {
      const e = employees.find(x => x.terminalUserId === p.terminalUserId);
      return {
        at: localDateTime(p.punchTime), receivedAt: localDateTime(p.receivedAt), employeeId: e?.id ?? null, name: e?.name ?? `Unknown user ${p.terminalUserId}`,
        terminalUserId: p.terminalUserId, terminalName: p.device.name, matched: !!e, other: !!e && e.officeId !== p.device.officeId,
      };
    }), total, q));
  });

  /** POST /devices  Register a terminal for an office. A head registers for their own office. */
  r.post('/', requireManager, async (req, res) => {
    const a = actorOf(req);
    const body = parse(z.object({ serialNumber: zSerial, officeId: z.string().max(60).optional(), name: zDeviceName }), req.body);
    const officeId = a.role === 'head' ? a.officeId! : parse(zUuid, body.officeId);
    const office = (await prisma.office.findUnique({ where: { id: officeId } })) ?? fail(404, 'Office was not found.');
    const taken = await prisma.device.findUnique({ where: { serialNumber: body.serialNumber }, include: { office: { select: { name: true } } } });
    if (taken) fail(409, `This terminal is already registered to ${taken.office.name}.`);
    const d = await prisma.$transaction(async tx => {
      const created = await tx.device.create({ data: { serialNumber: body.serialNumber, officeId, name: body.name || `${office.name} terminal` } });
      await tx.unregisteredDevice.deleteMany({ where: { serialNumber: body.serialNumber } });
      await audit(tx, a, { action: 'Terminal registered', entity: 'device', entityId: created.id, officeId, detail: `${created.name}, serial ${created.serialNumber}, ${office.name}`, new: { serialNumber: created.serialNumber, name: created.name, officeId } });
      return created;
    });
    publish({ type: 'device', officeIds: [officeId], data: { deviceId: d.id } });
    res.status(201).json({ id: d.id, serial: d.serialNumber, name: d.name, officeId });
  });

  /** PATCH /devices/:id  Rename. Only the admin can move a terminal to another office. */
  r.patch('/:id', requireManager, async (req, res) => {
    const a = actorOf(req);
    const patch = parse(z.object({ name: z.string().trim().min(1, 'Give the terminal a name.').max(60).optional(), officeId: zUuid.optional() }), req.body);
    const d = (await prisma.device.findUnique({ where: { id: parse(zUuid, req.params.id) } })) ?? fail(404, 'Terminal was not found.');
    assertOffice(a, d.officeId);
    const move = patch.officeId && patch.officeId !== d.officeId ? patch.officeId : undefined;
    if (move && a.role !== 'admin') fail(403, 'Only the admin can move a terminal to another office.');
    if (move && !(await prisma.office.findUnique({ where: { id: move } }))) fail(404, 'Office was not found.');
    await prisma.$transaction(async tx => {
      await tx.device.update({ where: { id: d.id }, data: { name: patch.name, officeId: move } });
      await audit(tx, a, { action: 'Terminal updated', entity: 'device', entityId: d.id, officeId: move ?? d.officeId, detail: `${patch.name ?? d.name}, serial ${d.serialNumber}`, old: { name: d.name, officeId: d.officeId }, new: { name: patch.name ?? d.name, officeId: move ?? d.officeId } });
    });
    publish({ type: 'device', officeIds: [d.officeId, ...(move ? [move] : [])], data: { deviceId: d.id } });
    res.status(204).end();
  });

  /** DELETE /devices/:id  Only for a terminal that never sent a punch. Punches are never deleted. */
  r.delete('/:id', requireManager, async (req, res) => {
    const a = actorOf(req);
    const d = (await prisma.device.findUnique({ where: { id: parse(zUuid, req.params.id) } })) ?? fail(404, 'Terminal was not found.');
    assertOffice(a, d.officeId);
    if (await prisma.rawPunch.count({ where: { deviceId: d.id } })) fail(409, 'This terminal has punches on record, so it cannot be removed. Rename it instead.');
    await prisma.$transaction(async tx => {
      await tx.device.delete({ where: { id: d.id } });
      await audit(tx, a, { action: 'Terminal removed', entity: 'device', entityId: d.id, officeId: d.officeId, detail: `${d.name}, serial ${d.serialNumber}`, old: { serialNumber: d.serialNumber, name: d.name, officeId: d.officeId } });
    });
    publish({ type: 'device', officeIds: [d.officeId], data: { deviceId: d.id } });
    res.status(204).end();
  });

  return r;
}

export function punchRoutes(): Router {
  const r = Router();

  /**
   * GET /punches/unmatched?office=&page=  Punches whose terminal user id belongs to no employee.
   * They are kept. Setting that id on an employee's profile matches them.
   */
  r.get('/unmatched', requireManager, officeScope, async (req, res) => {
    const q = parse(zListQuery, req.query);
    const known = (await prisma.employee.findMany({ where: { terminalUserId: { not: null } }, select: { terminalUserId: true } })).map(e => e.terminalUserId!);
    const scope = scopeWhere(req);
    const where: Prisma.RawPunchWhereInput = { terminalUserId: { notIn: known }, ...(scope.officeId ? { device: { officeId: scope.officeId } } : {}) };
    const [total, rows] = await Promise.all([
      prisma.rawPunch.count({ where }),
      prisma.rawPunch.findMany({ where, orderBy: [{ punchTime: 'desc' }, { id: 'desc' }], ...skipTake(q), include: { device: { select: { name: true, officeId: true, office: { select: { name: true } } } } } }),
    ]);
    res.json(pageOf(rows.map(p => ({
      id: p.id.toString(), terminalUserId: p.terminalUserId, at: localDateTime(p.punchTime), receivedAt: localDateTime(p.receivedAt),
      terminalName: p.device.name, officeId: p.device.officeId, officeName: p.device.office.name,
    })), total, q));
  });

  return r;
}
