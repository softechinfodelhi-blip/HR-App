// Requests: listing, asking, deciding, undoing. Corrections now; leave joins the same routes in Phase 4.
import { Router } from 'express';
import { z } from 'zod';
import { Prisma, prisma } from '../db';
import { fail } from '../lib/errors';
import { dbDate, monthDays } from '../lib/time';
import { pageOf, parse, zHhmm, zListQuery, zUuid, zYmd } from '../lib/validate';
import { actorOf, officeScope, requireAuth, requireManager, scopeWhere } from '../middleware/auth';
import { announceDay } from '../services/attendance';
import {
  cancelCorrection, correctionInclude, correctionRow, decideCorrection, loadCorrection, requestCorrection, reverseCorrection, undoCorrection, userNames, type RequestRow,
} from '../services/requests';

const zComment = z.string().trim().max(500).default('');

/** Pending first (escalated on top, oldest first), then decided, newest decision first. */
function sortRows(rows: RequestRow[]): RequestRow[] {
  return rows.sort((a, b) => (a.status === 'pending' && b.status === 'pending'
    ? Number(b.escalated) - Number(a.escalated) || a.createdAt.localeCompare(b.createdAt)
    : a.status === 'pending' ? -1 : b.status === 'pending' ? 1 : (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt)));
}

export function requestRoutes(): Router {
  const r = Router();

  /** GET /requests?office=&kind=&status=&month=&search=&page= */
  r.get('/', requireManager, officeScope, async (req, res) => {
    const a = actorOf(req);
    const q = parse(zListQuery.extend({ kind: z.enum(['leave', 'correction']).optional() }), req.query);
    const where: Prisma.CorrectionRequestWhereInput = { employee: { ...scopeWhere(req) } };
    if (q.status === 'decided') where.status = { in: ['approved', 'rejected'] };
    else if (q.status && q.status !== 'all') where.status = parse(z.enum(['pending', 'approved', 'rejected', 'cancelled']), q.status);
    if (q.month) { const d = monthDays(q.month); where.date = { gte: dbDate(d[0]), lte: dbDate(d[d.length - 1]) }; }
    if (q.search) where.employee = { ...scopeWhere(req), OR: [{ name: { contains: q.search, mode: 'insensitive' } }, { code: { contains: q.search, mode: 'insensitive' } }] };
    const corrections = q.kind === 'leave' ? [] : await prisma.correctionRequest.findMany({ where, include: correctionInclude });
    const names = await userNames(prisma, corrections.map(c => c.decidedById));
    const rows = sortRows(corrections.map(c => correctionRow(c, a, names)));
    res.json(pageOf(rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), rows.length, q));
  });

  /** POST /requests/:id/decision  { decision: approved | rejected, comment } */
  r.post('/:id/decision', requireManager, async (req, res) => {
    const a = actorOf(req);
    const body = parse(z.object({ decision: z.enum(['approved', 'rejected']), comment: zComment }), req.body);
    const changed = await prisma.$transaction(async tx => {
      const c = (await loadCorrection(tx, parse(zUuid, req.params.id))) ?? fail(404, 'Request was not found.');
      return decideCorrection(tx, a, c, body.decision, body.comment);
    });
    announceDay(changed);
    res.status(204).end();
  });

  /** POST /requests/:id/undo  Within 60 seconds, by the person who decided. */
  r.post('/:id/undo', requireManager, async (req, res) => {
    const a = actorOf(req);
    const changed = await prisma.$transaction(async tx => {
      const c = (await loadCorrection(tx, parse(zUuid, req.params.id))) ?? fail(404, 'Request was not found.');
      return undoCorrection(tx, a, c);
    });
    announceDay(changed);
    res.status(204).end();
  });

  /** POST /requests/:id/reverse  Admin only, until the month is locked. */
  r.post('/:id/reverse', requireManager, async (req, res) => {
    const a = actorOf(req);
    const { comment } = parse(z.object({ comment: zComment }), req.body);
    const changed = await prisma.$transaction(async tx => {
      const c = (await loadCorrection(tx, parse(zUuid, req.params.id))) ?? fail(404, 'Request was not found.');
      return reverseCorrection(tx, a, c, comment);
    });
    announceDay(changed);
    res.status(204).end();
  });

  /** POST /requests/:id/cancel and /restore  By the employee, for their own pending request. */
  for (const restore of [false, true]) {
    r.post(`/:id/${restore ? 'restore' : 'cancel'}`, requireAuth, async (req, res) => {
      const a = actorOf(req);
      await prisma.$transaction(async tx => {
        const c = await loadCorrection(tx, parse(zUuid, req.params.id));
        // Someone else's request looks the same as one that does not exist.
        if (!c || c.employeeId !== a.employeeId) fail(404, 'Request was not found.');
        await cancelCorrection(tx, a, c, restore);
      });
      res.status(204).end();
    });
  }

  return r;
}

export function correctionRoutes(): Router {
  const r = Router();
  /** POST /corrections  An employee, or a head for themselves, asks for a day to be corrected. */
  r.post('/', requireAuth, async (req, res) => {
    const a = actorOf(req);
    const body = parse(z.object({
      date: zYmd, inTime: zHhmm.nullable().default(null), outTime: zHhmm.nullable().default(null),
      reason: z.string().trim().min(1, 'Add a short reason.').max(500),
    }), req.body);
    const c = await prisma.$transaction(tx => requestCorrection(tx, a, body));
    res.status(201).json(correctionRow(c, a, new Map()));
  });
  return r;
}

export function myRequestRoutes(): Router {
  const r = Router();
  /** GET /me/requests */
  r.get('/requests', requireAuth, async (req, res) => {
    const a = actorOf(req);
    if (!a.employeeId) return void res.json([]);
    const corrections = await prisma.correctionRequest.findMany({ where: { employeeId: a.employeeId }, include: correctionInclude, orderBy: { createdAt: 'desc' } });
    const names = await userNames(prisma, corrections.map(c => c.decidedById));
    // A manager's direct fix is not a request the employee made.
    res.json(corrections.map(c => correctionRow(c, a, names)).filter(x => !x.direct));
  });
  return r;
}
