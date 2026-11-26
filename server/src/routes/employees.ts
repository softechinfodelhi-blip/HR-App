// People and Profile. A head works inside their own office and cannot change their own record.
import { Router } from 'express';
import { z } from 'zod';
import { Prisma, prisma } from '../db';
import { isProd } from '../env';
import { audit } from '../lib/audit';
import { fail } from '../lib/errors';
import { localDateTime, today, ymdFromDb } from '../lib/time';
import { pageOf, parse, skipTake, zEmail, zListQuery, zMonth, zUuid, zYmd } from '../lib/validate';
import { actorOf, officeScope, requireAuth, requireManager, scopeWhere } from '../middleware/auth';
import {
  createEmployee, employeeInclude, employeeRow, loadEmployee, removeInvited, setQuota, setSalary, setStatus, updateEmployee,
} from '../services/employees';
import { sendInvite } from '../services/invites';
import { adjustBalance, balancesOf } from '../services/leave';
import { assertCanManage, assertCanView, canManage, canSeeSalary } from '../services/permissions';
import { profileExtras } from './insights';

const zName = z.string().trim().min(1, 'Enter the full name.').max(120);
const zQuota = z.coerce.number().min(0, 'A quota cannot be negative.').max(365).multipleOf(0.5, 'Use whole or half days.');
const zSalary = z.coerce.number().positive('Enter the monthly salary.').max(100_000_000);
// Letters and digits, e.g. 101 or AS101. Stored in capitals so it matches what the terminal sends.
const zTerminalId = z.string().trim().regex(/^[A-Za-z0-9]{1,24}$/, 'The terminal user ID has only letters and digits, up to 24.').transform(s => s.toUpperCase());

const zNew = z.object({
  name: zName, email: zEmail, phone: z.string().trim().max(30).default(''),
  officeId: z.string().max(60).default(''), designation: z.string().trim().max(80).default(''), joinDate: zYmd,
  salary: zSalary, effectiveMonth: zMonth, clQuota: zQuota.optional(), plQuota: zQuota.optional(),
  terminalUserId: zTerminalId.optional(), role: z.enum(['employee', 'head']).optional(),
});
const zPatch = z.object({
  name: zName.optional(), email: zEmail.optional(), phone: z.string().trim().max(30).optional(), designation: z.string().trim().max(80).optional(),
  joinDate: zYmd.optional(), lastWorkingDate: zYmd.nullable().optional(), terminalUserId: zTerminalId.optional(),
  clQuota: zQuota.optional(), plQuota: zQuota.optional(),
});

/** Invite tokens leave the server only by email. Outside production they are also returned, for the demo link and tests. */
const devToken = (token: string) => (isProd ? null : token);

export function employeeRoutes(): Router {
  const r = Router();

  /** GET /employees?office=&status=&search=&page=&pageSize= */
  r.get('/', requireManager, officeScope, async (req, res) => {
    const a = actorOf(req);
    const q = parse(zListQuery, req.query);
    const where: Prisma.EmployeeWhereInput = { ...scopeWhere(req) };
    if (q.status && q.status !== 'all') where.status = parse(z.enum(['invited', 'active', 'inactive']), q.status);
    if (q.search) {
      where.OR = [
        { name: { contains: q.search, mode: 'insensitive' } }, { code: { contains: q.search, mode: 'insensitive' } },
        { designation: { contains: q.search, mode: 'insensitive' } }, { user: { email: { contains: q.search, mode: 'insensitive' } } },
      ];
    }
    const [total, rows] = await Promise.all([
      prisma.employee.count({ where }),
      prisma.employee.findMany({ where, include: employeeInclude, orderBy: [{ name: 'asc' }, { code: 'asc' }], ...skipTake(q) }),
    ]);
    res.json(pageOf(rows.map(e => employeeRow(e, a)), total, q));
  });

  /** GET /employees/:id  Also used by an employee for their own profile. */
  r.get('/:id', requireAuth, async (req, res) => {
    const a = actorOf(req);
    const e = await loadEmployee(prisma, parse(zUuid, req.params.id));
    assertCanView(a, e);
    const seeSalary = canSeeSalary(a, e);
    const setters = seeSalary ? await prisma.user.findMany({
      where: { id: { in: e.salaryHistory.map(s => s.setById).filter((x): x is string => !!x) } },
      select: { id: true, name: true, employee: { select: { name: true } } },
    }) : [];
    const year = Number(today().slice(0, 4));
    res.json({
      employee: employeeRow(e, a),
      canEdit: canManage(a, e),
      canSeeSalary: seeSalary,
      salaryHistory: seeSalary ? [...e.salaryHistory].sort((x, y) => y.effectiveMonth.localeCompare(x.effectiveMonth)).map(s => {
        const by = setters.find(u => u.id === s.setById);
        return { id: s.id, employeeId: e.id, amount: Number(s.monthlyAmount), effectiveMonth: s.effectiveMonth, setBy: s.setById, setByName: by?.employee?.name ?? by?.name ?? '', setAt: localDateTime(s.setAt) };
      }) : [],
      quotas: e.leaveQuotas.filter(q => q.year >= year - 1).sort((x, y) => y.year - x.year).map(q => ({ year: q.year, cl: Number(q.clPerYear), pl: Number(q.plPerYear) })),
      balances: await balancesOf(prisma, e.id),
      ...(await profileExtras(e.id, a)),
      inviteToken: null, // only the hash is stored. "Send a new invite" makes a fresh link
    });
  });

  /** GET /employees/:id/ledger  Every entry behind the leave balance, newest first. */
  r.get('/:id/ledger', requireAuth, async (req, res) => {
    const a = actorOf(req);
    const e = await loadEmployee(prisma, parse(zUuid, req.params.id));
    assertCanView(a, e);
    const q = parse(zListQuery, req.query);
    const where = { employeeId: e.id };
    const [total, rows] = await Promise.all([
      prisma.leaveLedger.count({ where }),
      prisma.leaveLedger.findMany({ where, orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }], ...skipTake(q) }),
    ]);
    const by = await prisma.user.findMany({ where: { id: { in: rows.map(x => x.createdById).filter((x): x is string => !!x) } }, select: { id: true, name: true, employee: { select: { name: true } } } });
    res.json({
      balances: await balancesOf(prisma, e.id),
      ...pageOf(rows.map(x => {
        const u = by.find(b => b.id === x.createdById);
        return { id: x.id, type: x.leaveType, days: Number(x.deltaDays), reason: x.reason, ref: x.ref, date: ymdFromDb(x.entryDate), byName: u ? u.employee?.name ?? u.name : 'System', at: localDateTime(x.createdAt) };
      }), total, q),
    });
  });

  /** POST /employees/:id/leave-adjustments  { type: CL | PL, days: + or -, note } */
  r.post('/:id/leave-adjustments', requireManager, async (req, res) => {
    const a = actorOf(req);
    const body = parse(z.object({
      type: z.enum(['CL', 'PL']),
      days: z.coerce.number().min(-366).max(366).multipleOf(0.5, 'Use whole or half days.').refine(n => n !== 0, 'Enter the number of days to add or take away.'),
      note: z.string().trim().min(1, 'Write why the balance is being changed.').max(300),
    }), req.body);
    await prisma.$transaction(async tx => {
      const e = await loadEmployee(tx, parse(zUuid, req.params.id));
      assertCanManage(a, e, 'You cannot change your own leave balance. Ask the admin.');
      await adjustBalance(tx, a, e, body.type, body.days, body.note);
    });
    res.status(204).end();
  });

  /** POST /employees */
  r.post('/', requireManager, async (req, res) => {
    const a = actorOf(req);
    const body = parse(zNew, req.body);
    if (a.role === 'admin') parse(zUuid, body.officeId || undefined);
    const out = await prisma.$transaction(tx => createEmployee(tx, a, body));
    res.status(201).json({ employee: employeeRow(out.employee, a), inviteToken: devToken(out.inviteToken) });
  });

  /** PATCH /employees/:id */
  r.patch('/:id', requireManager, async (req, res) => {
    const a = actorOf(req);
    const patch = parse(zPatch, req.body);
    await prisma.$transaction(async tx => {
      const e = await loadEmployee(tx, parse(zUuid, req.params.id));
      assertCanManage(a, e);
      await updateEmployee(tx, a, e, patch);
    });
    res.status(204).end();
  });

  /** PUT /employees/:id/quota  The yearly CL and PL quota for one year. */
  r.put('/:id/quota', requireManager, async (req, res) => {
    const a = actorOf(req);
    const body = parse(z.object({ year: z.coerce.number().int().min(2000).max(2100), clQuota: zQuota, plQuota: zQuota }), req.body);
    await prisma.$transaction(async tx => {
      const e = await loadEmployee(tx, parse(zUuid, req.params.id));
      assertCanManage(a, e, 'You cannot change your own leave quota. Ask the admin.');
      const old = e.leaveQuotas.find(q => q.year === body.year);
      await setQuota(tx, e.id, body.year, body.clQuota, body.plQuota);
      await audit(tx, a, {
        action: 'Leave quota changed', entity: 'leave_quota', entityId: e.id, officeId: e.officeId, detail: `${e.name} (${e.code}) for ${body.year}`,
        old: old ? { year: old.year, clQuota: Number(old.clPerYear), plQuota: Number(old.plPerYear) } : null, new: body,
      });
    });
    res.status(204).end();
  });

  /** POST /employees/:id/salary */
  r.post('/:id/salary', requireManager, async (req, res) => {
    const a = actorOf(req);
    const body = parse(z.object({ amount: zSalary, effectiveMonth: zMonth }), req.body);
    await prisma.$transaction(async tx => {
      const e = await loadEmployee(tx, parse(zUuid, req.params.id));
      assertCanManage(a, e, 'You cannot change your own salary. Ask the admin.');
      await setSalary(tx, a, e, body.amount, body.effectiveMonth);
    });
    res.status(204).end();
  });

  /** POST /employees/:id/invite  A new link. The earlier one stops working. */
  r.post('/:id/invite', requireManager, async (req, res) => {
    const a = actorOf(req);
    const token = await prisma.$transaction(async tx => {
      const e = await loadEmployee(tx, parse(zUuid, req.params.id));
      assertCanManage(a, e);
      if (e.status !== 'invited' || !e.user) fail(409, 'This person has already set a password.');
      const t = await sendInvite(tx, e.user, e.name);
      await audit(tx, a, { action: 'Invite sent again', entity: 'employee', entityId: e.id, officeId: e.officeId, detail: `${e.name} (${e.code})` });
      return t;
    });
    res.json({ inviteToken: devToken(token) });
  });

  /** POST /employees/:id/status */
  r.post('/:id/status', requireManager, async (req, res) => {
    const a = actorOf(req);
    const { status } = parse(z.object({ status: z.enum(['active', 'inactive']) }), req.body);
    await prisma.$transaction(async tx => {
      const e = await loadEmployee(tx, parse(zUuid, req.params.id));
      assertCanManage(a, e);
      await setStatus(tx, a, e, status);
    });
    res.status(204).end();
  });

  /** DELETE /employees/:id  Only while the invite is unused (the Undo on "Add employee"). */
  r.delete('/:id', requireManager, async (req, res) => {
    const a = actorOf(req);
    await prisma.$transaction(async tx => {
      const e = await loadEmployee(tx, parse(zUuid, req.params.id));
      assertCanManage(a, e);
      await removeInvited(tx, a, e);
    });
    res.status(204).end();
  });

  return r;
}
