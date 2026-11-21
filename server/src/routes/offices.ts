// Offices and their heads. Reading is scoped; every write is admin only.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { audit, diff } from '../lib/audit';
import { fail } from '../lib/errors';
import { notify } from '../lib/notify';
import { parse, zHhmm, zUuid } from '../lib/validate';
import { actorOf, requireAdmin, requireAuth } from '../middleware/auth';

const zOffice = z.object({
  name: z.string().trim().min(1, 'Give the office a name.').max(100),
  address: z.string().trim().max(300).default(''),
  startTime: zHhmm.default('09:00'),
  fullDayHours: z.coerce.number().min(1, 'Full day hours must be at least 1.').max(24).default(9),
  minHalfDayHours: z.coerce.number().min(0.5, 'Half day hours must be at least 0.5.').max(24).default(4.5),
});
const hoursOk = (o: { fullDayHours: number; minHalfDayHours: number }) => o.minHalfDayHours < o.fullDayHours || fail(422, 'Half day hours must be less than full day hours.');

export function officeRoutes(): Router {
  const r = Router();

  /** GET /offices  Admin: all offices. Everyone else: their own. */
  r.get('/', requireAuth, async (req, res) => {
    const a = actorOf(req);
    const offices = await prisma.office.findMany({
      where: a.role === 'admin' ? {} : { id: a.officeId! },
      orderBy: { number: 'asc' },
      include: { head: { select: { name: true } }, _count: { select: { employees: { where: { status: { not: 'inactive' } } } } } },
    });
    res.json(offices.map(o => ({
      id: o.id, number: o.number, name: o.name, address: o.address, startTime: o.startTime,
      fullDayHours: Number(o.fullDayHours), halfDayHours: Number(o.minHalfDayHours),
      headId: o.headEmployeeId, headName: o.head?.name ?? null, headcount: o._count.employees,
      terminal: null, // filled in Phase 2
    })));
  });

  /** POST /offices */
  r.post('/', requireAdmin, async (req, res) => {
    const a = actorOf(req);
    const body = parse(zOffice, req.body);
    hoursOk(body);
    const o = await prisma.$transaction(async tx => {
      const created = await tx.office.create({ data: body });
      await audit(tx, a, { action: 'Office added', entity: 'office', entityId: created.id, officeId: created.id, detail: `${created.name}${created.address ? `, ${created.address}` : ''}`, new: body });
      return created;
    });
    res.status(201).json({ id: o.id, number: o.number, name: o.name, address: o.address });
  });

  /** PATCH /offices/:id */
  r.patch('/:id', requireAdmin, async (req, res) => {
    const a = actorOf(req);
    const id = parse(zUuid, req.params.id);
    const patch = parse(zOffice.partial().extend({ address: z.string().trim().max(300).optional(), startTime: zHhmm.optional(), fullDayHours: z.coerce.number().min(1).max(24).optional(), minHalfDayHours: z.coerce.number().min(0.5).max(24).optional() }), req.body);
    const o = (await prisma.office.findUnique({ where: { id } })) ?? fail(404, 'Office was not found.');
    const before = { name: o.name, address: o.address, startTime: o.startTime, fullDayHours: Number(o.fullDayHours), minHalfDayHours: Number(o.minHalfDayHours) };
    const d = diff(before, patch);
    hoursOk({ ...before, ...d.new });
    if (d.changed.length) {
      await prisma.$transaction(async tx => {
        await tx.office.update({ where: { id }, data: d.new });
        await audit(tx, a, { action: 'Office updated', entity: 'office', entityId: id, officeId: id, detail: `${patch.name ?? o.name}: ${d.changed.join(', ')}`, old: d.old, new: d.new });
      });
    }
    res.status(204).end();
  });

  /** PUT /offices/:id/head  The head must be an employee of that office. The previous head becomes an employee again. */
  r.put('/:id/head', requireAdmin, async (req, res) => {
    const a = actorOf(req);
    const id = parse(zUuid, req.params.id);
    const { employeeId } = parse(z.object({ employeeId: zUuid }), req.body);
    const o = (await prisma.office.findUnique({ where: { id }, include: { head: { include: { user: true } } } })) ?? fail(404, 'Office was not found.');
    const e = (await prisma.employee.findUnique({ where: { id: employeeId }, include: { user: true } })) ?? fail(404, 'Employee was not found.');
    if (e.officeId !== id) fail(422, 'The head must belong to this office.');
    if (e.status === 'inactive') fail(422, 'This account is switched off.');
    if (!e.user) fail(422, 'This person has no login.');
    if (o.headEmployeeId === e.id) return void res.status(204).end();
    await prisma.$transaction(async tx => {
      if (o.head?.user) {
        await tx.user.update({ where: { id: o.head.user.id }, data: { role: 'employee' } });
        // The old head loses manager access at once.
        await tx.session.deleteMany({ where: { userId: o.head.user.id } });
      }
      await tx.user.update({ where: { id: e.user!.id }, data: { role: 'office_head' } });
      await tx.office.update({ where: { id }, data: { headEmployeeId: e.id } });
      await audit(tx, a, {
        action: 'Office head changed', entity: 'office', entityId: id, officeId: id,
        detail: `${e.name} is now head of ${o.name}${o.head ? `, replacing ${o.head.name}` : ''}`,
        old: { headId: o.headEmployeeId, headName: o.head?.name ?? null }, new: { headId: e.id, headName: e.name },
      });
      await notify(tx, e.user!.id, { type: 'made_head', text: `You are now the head of ${o.name}`, link: '/' });
    });
    res.status(204).end();
  });

  return r;
}
