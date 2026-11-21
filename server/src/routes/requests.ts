// Leave and correction requests share one workflow: ask, decide, undo, reverse, cancel.
import { Router, type Request } from 'express';
import { z } from 'zod';
import { Prisma, prisma, type Db } from '../db';
import { fail } from '../lib/errors';
import { dbDate, monthDays, today, ymdFromDb } from '../lib/time';
import { pageOf, parse, zHhmm, zListQuery, zUuid, zYmd } from '../lib/validate';
import { actorOf, officeScope, requireAuth, requireManager, scopeWhere } from '../middleware/auth';
import { announceDay, employedWhere, empSelect } from '../services/attendance';
import { dayKind, loadCalendars } from '../services/calendar';
import {
  applyLeave, balancesOf, cancelApprovedLeave, cancelLeave, decideLeave, leaveInclude, leaveRow, previewLeave, reverseLeave, undoLeave, type LeaveFull,
} from '../services/leave';
import type { Actor } from '../services/permissions';
import {
  cancelCorrection, correctionInclude, correctionRow, decideCorrection, requestCorrection, reverseCorrection, undoCorrection, userNames,
  type CorrectionFull, type RequestRow,
} from '../services/requests';

const zComment = z.string().trim().max(500).default('');
const zStatus = z.enum(['pending', 'approved', 'rejected', 'cancelled']);

/** Pending first (escalated on top, oldest first), then decided, newest decision first. */
function sortRows(rows: RequestRow[]): RequestRow[] {
  return rows.sort((a, b) => (a.status === 'pending' && b.status === 'pending'
    ? Number(b.escalated) - Number(a.escalated) || a.createdAt.localeCompare(b.createdAt)
    : a.status === 'pending' ? -1 : b.status === 'pending' ? 1 : (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt)));
}

export interface RequestFilter { officeId?: string; employeeId?: string; kind?: 'leave' | 'correction'; status?: string; month?: string; search?: string; }

/** Both kinds of request as rows, for one office scope or one employee. */
export async function requestRows(db: Db, actor: Actor, f: RequestFilter): Promise<RequestRow[]> {
  const employee: Prisma.EmployeeWhereInput = {
    ...(f.officeId ? { officeId: f.officeId } : {}),
    ...(f.search ? { OR: [{ name: { contains: f.search, mode: 'insensitive' } }, { code: { contains: f.search, mode: 'insensitive' } }] } : {}),
  };
  const status = f.status === 'decided' ? { in: ['approved', 'rejected'] as ('approved' | 'rejected')[] } : f.status && f.status !== 'all' ? parse(zStatus, f.status) : undefined;
  const base = { ...(f.employeeId ? { employeeId: f.employeeId } : {}), employee, ...(status ? { status } : {}) };
  const span = f.month ? monthDays(f.month) : null;
  const [corrections, leaves] = await Promise.all([
    f.kind === 'leave' ? [] : db.correctionRequest.findMany({ where: { ...base, ...(span ? { date: { gte: dbDate(span[0]), lte: dbDate(span[span.length - 1]) } } : {}) }, include: correctionInclude }),
    f.kind === 'correction' ? [] : db.leaveRequest.findMany({ where: { ...base, ...(span ? { fromDate: { lte: dbDate(span[span.length - 1]) }, toDate: { gte: dbDate(span[0]) } } : {}) }, include: leaveInclude }),
  ]);
  const names = await userNames(db, [...corrections.map(c => c.decidedById), ...leaves.map(l => l.decidedById)]);
  return [...corrections.map(c => correctionRow(c, actor, names)), ...leaves.map(l => leaveRow(l, actor, names))];
}

/**
 * The "Waiting for you" list. A head: pending requests of their office, except their own.
 * The admin: requests from heads (and from offices without a head), plus anything escalated.
 */
export async function queueFor(db: Db, actor: Actor, officeId?: string): Promise<RequestRow[]> {
  const rows = await requestRows(db, actor, { officeId, status: 'pending' });
  const noHead = new Set((await db.office.findMany({ where: { headEmployeeId: null }, select: { id: true } })).map(o => o.id));
  return sortRows(rows.filter(r => r.canAct && !r.direct && (actor.role === 'head' || r.fromHead || r.escalated || noHead.has(r.officeId))));
}

type Found = { kind: 'correction'; c: CorrectionFull } | { kind: 'leave'; l: LeaveFull };
async function find(db: Db, req: Request): Promise<Found> {
  const id = parse(zUuid, req.params.id);
  const c = await db.correctionRequest.findUnique({ where: { id }, include: correctionInclude });
  if (c) return { kind: 'correction', c };
  const l = await db.leaveRequest.findUnique({ where: { id }, include: leaveInclude });
  return l ? { kind: 'leave', l } : fail(404, 'Request was not found.');
}

export function requestRoutes(): Router {
  const r = Router();

  /** GET /requests?office=&kind=&status=&month=&search=&page=  status may also be `decided`. */
  r.get('/', requireManager, officeScope, async (req, res) => {
    const q = parse(zListQuery.extend({ kind: z.enum(['leave', 'correction']).optional() }), req.query);
    const rows = sortRows(await requestRows(prisma, actorOf(req), { ...scopeWhere(req), kind: q.kind, status: q.status, month: q.month, search: q.search }));
    res.json(pageOf(rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize), rows.length, q));
  });

  /** GET /requests/queue?office= */
  r.get('/queue', requireManager, officeScope, async (req, res) => { res.json(await queueFor(prisma, actorOf(req), scopeWhere(req).officeId)); });

  /** POST /requests/:id/decision  { decision: approved | rejected, comment } */
  r.post('/:id/decision', requireManager, async (req, res) => {
    const a = actorOf(req);
    const body = parse(z.object({ decision: z.enum(['approved', 'rejected']), comment: zComment }), req.body);
    announceDay(await prisma.$transaction(async tx => {
      const f = await find(tx, req);
      return f.kind === 'correction' ? decideCorrection(tx, a, f.c, body.decision, body.comment) : decideLeave(tx, a, f.l, body.decision, body.comment);
    }, { timeout: 30_000 }));
    res.status(204).end();
  });

  /** POST /requests/:id/undo  Within 60 seconds, by the person who decided. */
  r.post('/:id/undo', requireManager, async (req, res) => {
    const a = actorOf(req);
    announceDay(await prisma.$transaction(async tx => {
      const f = await find(tx, req);
      return f.kind === 'correction' ? undoCorrection(tx, a, f.c) : undoLeave(tx, a, f.l);
    }, { timeout: 30_000 }));
    res.status(204).end();
  });

  /** POST /requests/:id/reverse  Admin only, until the month is locked. */
  r.post('/:id/reverse', requireManager, async (req, res) => {
    const a = actorOf(req);
    const { comment } = parse(z.object({ comment: zComment }), req.body);
    announceDay(await prisma.$transaction(async tx => {
      const f = await find(tx, req);
      return f.kind === 'correction' ? reverseCorrection(tx, a, f.c, comment) : reverseLeave(tx, a, f.l, comment);
    }, { timeout: 30_000 }));
    res.status(204).end();
  });

  /** POST /requests/:id/cancel-approved  The office head (or the admin) cancels leave that was already approved. */
  r.post('/:id/cancel-approved', requireManager, async (req, res) => {
    const a = actorOf(req);
    const { comment } = parse(z.object({ comment: zComment }), req.body);
    announceDay(await prisma.$transaction(async tx => {
      const f = await find(tx, req);
      if (f.kind !== 'leave') fail(409, 'Only leave can be cancelled this way.');
      return cancelApprovedLeave(tx, a, f.l, comment);
    }, { timeout: 30_000 }));
    res.status(204).end();
  });

  /** POST /requests/:id/cancel and /restore  By the employee, for their own pending request. */
  for (const restore of [false, true]) {
    r.post(`/:id/${restore ? 'restore' : 'cancel'}`, requireAuth, async (req, res) => {
      const a = actorOf(req);
      await prisma.$transaction(async tx => {
        const f = await find(tx, req);
        // Someone else's request looks the same as one that does not exist.
        if ((f.kind === 'correction' ? f.c.employeeId : f.l.employeeId) !== a.employeeId) fail(404, 'Request was not found.');
        if (f.kind === 'correction') await cancelCorrection(tx, a, f.c, restore); else await cancelLeave(tx, a, f.l, restore);
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

const zLeave = z.object({
  type: z.enum(['CL', 'PL', 'UNPAID']), from: zYmd, to: zYmd,
  // `half: true` is accepted from older forms and means the first half.
  halfDay: z.enum(['none', 'first', 'second']).optional(), half: z.boolean().optional(),
}).transform(v => ({ type: v.type, from: v.from, to: v.to, halfDay: v.halfDay ?? (v.half ? 'first' as const : 'none' as const) }));

export function leaveRoutes(): Router {
  const r = Router();

  /** POST /leave/preview  Working days and balance while the form is being filled in. Never fails for a bad request: it explains instead. */
  r.post('/preview', requireAuth, async (req, res) => {
    const a = actorOf(req);
    if (!a.employeeId) fail(403, 'The admin account has no leave.');
    const input = zLeave.safeParse(req.body);
    if (!input.success) return void res.json({ days: 0, ok: false, message: 'Pick the dates.', balance: null, balanceAfter: null });
    const e = await prisma.employee.findUniqueOrThrow({ where: { id: a.employeeId } });
    res.json(await previewLeave(prisma, e, input.data));
  });

  /** POST /leave */
  r.post('/', requireAuth, async (req, res) => {
    const a = actorOf(req);
    const input = parse(zLeave, req.body);
    const { reason } = parse(z.object({ reason: z.string().trim().min(1, 'Add a short reason.').max(500) }), { reason: (req.body as { reason?: unknown })?.reason });
    const l = await prisma.$transaction(tx => applyLeave(tx, a, { ...input, reason }));
    res.status(201).json(leaveRow(l, a, new Map()));
  });

  /** GET /leave/calendar?office=&month=  Who is away on each date, approved or pending. */
  r.get('/calendar', requireManager, officeScope, async (req, res) => {
    const { month } = parse(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Enter a valid month.').default(today().slice(0, 7)) }), { month: req.query.month });
    const scope = scopeWhere(req);
    const dates = monthDays(month); const first = dates[0]; const last = dates[dates.length - 1];
    const emps = await prisma.employee.findMany({ where: { ...scope, ...employedWhere(first, last) }, select: empSelect });
    const officeIds = scope.officeId ? [scope.officeId] : (await prisma.office.findMany({ select: { id: true } })).map(o => o.id);
    const [calendars, leaves] = await Promise.all([
      loadCalendars(prisma, officeIds, first, last),
      prisma.leaveRequest.findMany({ where: { employeeId: { in: emps.map(e => e.id) }, status: { in: ['approved', 'pending'] }, fromDate: { lte: dbDate(last) }, toDate: { gte: dbDate(first) } } }),
    ]);
    res.json(dates.map(date => {
      const kinds = officeIds.map(id => dayKind(date, calendars.get(id)!));
      const hol = kinds.find(k => k.kind === 'holiday');
      const people = leaves
        .filter(l => ymdFromDb(l.fromDate) <= date && date <= ymdFromDb(l.toDate))
        .map(l => ({ l, e: emps.find(x => x.id === l.employeeId)! }))
        .filter(x => dayKind(date, calendars.get(x.e.officeId)!).kind === 'working') // leave only counts on that person's working days
        .map(x => ({ employeeId: x.e.id, name: x.e.name, type: x.l.type, half: x.l.halfDay !== 'none', halfDay: x.l.halfDay, pending: x.l.status === 'pending' }))
        .sort((x, y) => x.name.localeCompare(y.name));
      return { date, holiday: hol?.name ?? null, off: !hol && kinds.every(k => k.kind !== 'working'), people };
    }));
  });

  return r;
}

export function myRequestRoutes(): Router {
  const r = Router();
  /** GET /me/requests */
  r.get('/requests', requireAuth, async (req, res) => {
    const a = actorOf(req);
    if (!a.employeeId) return void res.json([]);
    const rows = await requestRows(prisma, a, { employeeId: a.employeeId });
    // A manager's direct fix is not a request the employee made.
    res.json(rows.filter(x => !x.direct).sort((x, y) => y.createdAt.localeCompare(x.createdAt)));
  });
  /** GET /me/balances */
  r.get('/balances', requireAuth, async (req, res) => {
    const a = actorOf(req);
    if (!a.employeeId) fail(403, 'The admin account has no leave.');
    res.json(await balancesOf(prisma, a.employeeId));
  });
  return r;
}
