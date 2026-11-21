// Payroll per office and month, the lock, and payslips.
import { Router, type Request } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { fail } from '../lib/errors';
import { fmtMonth, thisMonth, type Month } from '../lib/time';
import { pageOf, parse, zListQuery, zMonth, zUuid } from '../lib/validate';
import { actorOf, officeScope, requireAuth, requireManager, scopeWhere } from '../middleware/auth';
import { getPayroll, liveRows, loadPayslip, lockedRows, lockMonth, lockSummary, markReviewed, unlockMonth } from '../services/payroll';
import { totalsOf } from '../services/payroll-rules';
import { payslipPdf } from '../services/payslip-pdf';
import { assertCanView, assertOffice } from '../services/permissions';

/** `:officeId/:month` from the path. A head naming another office gets 403 here. */
function target(req: Request): { officeId: string; month: Month } {
  const officeId = parse(zUuid, req.params.officeId);
  assertOffice(actorOf(req), officeId);
  return { officeId, month: parse(zMonth, req.params.month) };
}
const itemOf = (i: { employeeId: string; employeeName: string; employeeCode: string; netSalary: unknown; monthlySalary: unknown; unpaidDays: unknown; run: { month: string } }) =>
  ({ employeeId: i.employeeId, name: i.employeeName, code: i.employeeCode, month: i.run.month, net: Number(i.netSalary), salary: Number(i.monthlySalary), unpaidDays: Number(i.unpaidDays) });

export function payrollRoutes(): Router {
  const r = Router();

  /** GET /payroll?month=&office=  One line per office. */
  r.get('/', requireManager, officeScope, async (req, res) => {
    const month = parse(zMonth.default(thisMonth()), req.query.month);
    const scope = scopeWhere(req);
    const offices = await prisma.office.findMany({ where: scope.officeId ? { id: scope.officeId } : {}, orderBy: { number: 'asc' }, include: { head: { select: { name: true } } } });
    const runs = await prisma.payrollRun.findMany({ where: { month, officeId: { in: offices.map(o => o.id) } } });
    res.json(await Promise.all(offices.map(async o => {
      const run = runs.find(x => x.officeId === o.id);
      const locked = run?.status === 'locked';
      const rows = locked ? await lockedRows(prisma, run.id) : (await liveRows(prisma, o.id, month)).rows;
      return { officeId: o.id, officeName: o.name, headName: o.head?.name ?? null, totals: totalsOf(rows), locked, lockedAt: run?.lockedAt ?? null, reviewed: !!run?.reviewedAt, missing: rows.reduce((n, x) => n + x.missing, 0) };
    })));
  });

  /** GET /payroll/:officeId/:month  Figures per person and the lock checklist. */
  r.get('/:officeId/:month', requireManager, async (req, res) => {
    const t = target(req);
    res.json(await getPayroll(prisma, actorOf(req), t.officeId, t.month));
  });

  /** POST /payroll/:officeId/:month/review  { reviewed } */
  r.post('/:officeId/:month/review', requireManager, async (req, res) => {
    const t = target(req);
    const { reviewed } = parse(z.object({ reviewed: z.boolean().default(true) }), req.body ?? {});
    await prisma.$transaction(tx => markReviewed(tx, actorOf(req), t.officeId, t.month, reviewed));
    res.status(204).end();
  });

  /** POST /payroll/:officeId/:month/lock */
  r.post('/:officeId/:month/lock', requireManager, async (req, res) => {
    const t = target(req);
    res.json(await prisma.$transaction(tx => lockMonth(tx, actorOf(req), t.officeId, t.month), { timeout: 120_000, maxWait: 10_000 }));
  });

  /** POST /payroll/:officeId/:month/unlock  { reason }  Admin only. */
  r.post('/:officeId/:month/unlock', requireManager, async (req, res) => {
    const t = target(req);
    const { reason } = parse(z.object({ reason: z.string().trim().min(1, 'Write why the month is being unlocked.').max(500) }), req.body);
    await prisma.$transaction(tx => unlockMonth(tx, actorOf(req), t.officeId, t.month, reason));
    res.status(204).end();
  });

  /** GET /payroll/:officeId/:month/summary  Totals and every manual change of the month. */
  r.get('/:officeId/:month/summary', requireManager, async (req, res) => {
    const t = target(req);
    res.json(await lockSummary(prisma, actorOf(req), t.officeId, t.month));
  });

  return r;
}

export function payslipRoutes(): Router {
  const r = Router();

  /** GET /payslips?office=&month=&search=&page=  Released payslips. */
  r.get('/', requireManager, officeScope, async (req, res) => {
    const q = parse(zListQuery, req.query);
    const where = {
      run: { status: 'locked' as const, ...scopeWhere(req), ...(q.month ? { month: q.month } : {}) },
      ...(q.search ? { OR: [{ employeeName: { contains: q.search, mode: 'insensitive' as const } }, { employeeCode: { contains: q.search, mode: 'insensitive' as const } }] } : {}),
    };
    const [total, items] = await Promise.all([
      prisma.payrollItem.count({ where }),
      prisma.payrollItem.findMany({ where, include: { run: { select: { month: true } } }, orderBy: [{ run: { month: 'desc' } }, { employeeName: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    res.json(pageOf(items.map(itemOf), total, q));
  });

  /** Salary data: the admin, the employee's office head and the employee. */
  async function slip(req: Request) {
    const a = actorOf(req);
    const employeeId = parse(zUuid, req.params.employeeId);
    const month = parse(zMonth, req.params.month);
    const e = (await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true, officeId: true } })) ?? fail(404, 'Employee was not found.');
    assertCanView(a, e);
    return (await loadPayslip(prisma, employeeId, month)) ?? fail(404, `The ${fmtMonth(month)} payslip is not released yet. It appears once the month is locked.`);
  }

  /** GET /payslips/:employeeId/:month */
  r.get('/:employeeId/:month', requireAuth, async (req, res) => { res.json(await slip(req)); });

  /** GET /payslips/:employeeId/:month/pdf */
  r.get('/:employeeId/:month/pdf', requireAuth, async (req, res) => {
    const p = await slip(req);
    const pdf = await payslipPdf(p);
    res.status(200).set({
      'Content-Type': 'application/pdf', 'Content-Length': String(pdf.length),
      'Content-Disposition': `inline; filename="payslip-${p.employee.code}-${p.month}.pdf"`,
    }).end(pdf);
  });

  return r;
}

export function myPayslipRoutes(): Router {
  const r = Router();
  /** GET /me/payslips  Newest first. */
  r.get('/payslips', requireAuth, async (req, res) => {
    const a = actorOf(req);
    if (!a.employeeId) return void res.json([]);
    const items = await prisma.payrollItem.findMany({ where: { employeeId: a.employeeId, run: { status: 'locked' } }, include: { run: { select: { month: true } } }, orderBy: { run: { month: 'desc' } } });
    res.json(items.map(itemOf));
  });
  return r;
}
