// Holidays and calendar overrides, per office.
// kind = holiday    an office holiday (holidays table)
// kind = working    a weekly off or holiday that will be worked (calendar_overrides)
// kind = off        a working day the office is closed (calendar_overrides)
// An override wins over a holiday and over the weekly offs.
import { Router } from 'express';
import { z } from 'zod';
import { prisma, type Db } from '../db';
import { audit } from '../lib/audit';
import { fail } from '../lib/errors';
import { publish } from '../lib/live';
import { dbDate, fmtDate, today, ymdFromDb, type Ymd } from '../lib/time';
import { parse, zUuid, zYmd } from '../lib/validate';
import { actorOf, requireAuth, requireManager } from '../middleware/auth';
import { recomputeOfficeDate } from '../services/attendance';
import { dayKind, loadCalendar } from '../services/calendar';
import { assertOpen } from '../services/locks';
import { type Actor, resolveOfficeScope } from '../services/permissions';

type Kind = 'holiday' | 'working' | 'off';
const zKind = z.enum(['holiday', 'working', 'off']);
/** One row on the Holidays screen: the same date and name across one or more offices. */
const idOf = (kind: Kind, date: Ymd, name: string) => `${kind}~${date}~${encodeURIComponent(name)}`;
function parseId(id: string): { kind: Kind; date: Ymd; name: string } {
  const [kind, date, ...rest] = id.split('~');
  return { kind: parse(zKind, kind), date: parse(zYmd, date), name: decodeURIComponent(rest.join('~')) };
}
const LABEL: Record<Kind, string> = { holiday: 'Holiday', working: 'Working day', off: 'Office closed' };

/** Offices this person may change the calendar of, out of the ones asked for. */
function writableOffices(a: Actor, asked: string[]): string[] {
  if (a.role === 'head') return [a.officeId!]; // a head's change always applies to their own office only
  return asked;
}

async function remove(db: Db, kind: Kind, officeId: string, date: Ymd, name: string): Promise<boolean> {
  const where = { officeId, date: dbDate(date), name };
  const n = kind === 'holiday' ? await db.holiday.deleteMany({ where }) : await db.calendarOverride.deleteMany({ where: { ...where, kind } });
  return n.count > 0;
}

export function holidayRoutes(): Router {
  const r = Router();

  /** GET /holidays?office=&year=  Employees see their own office's calendar. */
  r.get('/', requireAuth, async (req, res) => {
    const a = actorOf(req);
    const q = parse(z.object({ office: z.string().max(60).optional(), year: z.coerce.number().int().min(2000).max(2100).default(Number(today().slice(0, 4))) }), req.query);
    const scope = a.role === 'employee' ? a.officeId! : resolveOfficeScope(a, q.office);
    const where = { ...(scope ? { officeId: scope } : {}), date: { gte: dbDate(`${q.year}-01-01`), lte: dbDate(`${q.year}-12-31`) } };
    const [holidays, overrides, offices] = await Promise.all([
      prisma.holiday.findMany({ where }), prisma.calendarOverride.findMany({ where }), prisma.office.findMany({ orderBy: { number: 'asc' } }),
    ]);
    const groups = new Map<string, { id: string; date: Ymd; name: string; kind: Kind; officeIds: string[] }>();
    const add = (kind: Kind, date: Ymd, name: string, officeId: string) => {
      const id = idOf(kind, date, name);
      const g = groups.get(id); if (g) g.officeIds.push(officeId); else groups.set(id, { id, date, name, kind, officeIds: [officeId] });
    };
    for (const h of holidays) add('holiday', ymdFromDb(h.date), h.name, h.officeId);
    for (const o of overrides) add(o.kind, ymdFromDb(o.date), o.name, o.officeId);
    res.json([...groups.values()].sort((x, y) => x.date.localeCompare(y.date) || x.name.localeCompare(y.name)).map(g => ({
      ...g,
      offices: g.officeIds.length === offices.length && offices.length > 1 ? 'All offices' : offices.filter(o => g.officeIds.includes(o.id)).map(o => o.name).join(', '),
      canEdit: a.role === 'admin' || (a.role === 'head' && g.officeIds.includes(a.officeId!)),
    })));
  });

  /** POST /holidays  { date, name, kind, officeIds } */
  r.post('/', requireManager, async (req, res) => {
    const a = actorOf(req);
    const body = parse(z.object({
      date: zYmd, name: z.string().trim().min(1, 'Give it a name.').max(80), kind: zKind.default('holiday'), officeIds: z.array(zUuid).max(50).default([]),
    }), req.body);
    const officeIds = [...new Set(writableOffices(a, body.officeIds))];
    if (!officeIds.length) fail(422, 'Choose at least one office.');
    const offices = await prisma.office.findMany({ where: { id: { in: officeIds } } });
    if (offices.length !== officeIds.length) fail(404, 'Office was not found.');

    await prisma.$transaction(async tx => {
      for (const o of offices) {
        await assertOpen(tx, o.id, [body.date]);
        const cal = await loadCalendar(tx, o.id, body.date, body.date);
        const now = dayKind(body.date, cal);
        if (body.kind === 'holiday' && cal.holidays.has(body.date)) fail(409, `${o.name} already has a holiday on ${fmtDate(body.date)}.`);
        if (body.kind !== 'holiday' && cal.overrides.has(body.date)) fail(409, `${o.name} already has a change on ${fmtDate(body.date)}. Remove it first.`);
        if (body.kind === 'working' && now.kind === 'working') fail(422, `${fmtDate(body.date)} is already a working day for ${o.name}.`);
        if (body.kind === 'off' && now.kind !== 'working') fail(422, `${fmtDate(body.date)} is already off for ${o.name}.`);
        if (body.kind === 'holiday') await tx.holiday.create({ data: { officeId: o.id, date: dbDate(body.date), name: body.name } });
        else await tx.calendarOverride.create({ data: { officeId: o.id, date: dbDate(body.date), name: body.name, kind: body.kind } });
        await audit(tx, a, { action: `${LABEL[body.kind]} added`, entity: body.kind === 'holiday' ? 'holiday' : 'calendar_override', entityId: `${o.id}:${body.date}`, officeId: o.id, detail: `${body.name}, ${fmtDate(body.date)}, ${o.name}`, new: { date: body.date, name: body.name, kind: body.kind } });
        // The day changes for everyone in the office.
        await recomputeOfficeDate(tx, o.id, body.date);
      }
    }, { timeout: 30_000 });
    publish({ type: 'day', officeIds, data: { date: body.date } });
    res.status(201).json({ id: idOf(body.kind, body.date, body.name), date: body.date, name: body.name, kind: body.kind, officeIds });
  });

  /** DELETE /holidays/:id  A head removes it for their office only. Returns what was removed, so the app can offer Undo. */
  r.delete('/:id', requireManager, async (req, res) => {
    const a = actorOf(req);
    const { kind, date, name } = parseId(String(req.params.id));
    const all = kind === 'holiday'
      ? await prisma.holiday.findMany({ where: { date: dbDate(date), name }, select: { officeId: true } })
      : await prisma.calendarOverride.findMany({ where: { date: dbDate(date), name, kind }, select: { officeId: true } });
    const officeIds = a.role === 'head' ? all.map(x => x.officeId).filter(id => id === a.officeId) : all.map(x => x.officeId);
    if (!officeIds.length) fail(404, 'This date was not found.');
    const offices = await prisma.office.findMany({ where: { id: { in: officeIds } } });
    await prisma.$transaction(async tx => {
      for (const o of offices) {
        await assertOpen(tx, o.id, [date]);
        if (!(await remove(tx, kind, o.id, date, name))) continue;
        await audit(tx, a, { action: `${LABEL[kind]} removed`, entity: kind === 'holiday' ? 'holiday' : 'calendar_override', entityId: `${o.id}:${date}`, officeId: o.id, detail: `${name}, ${fmtDate(date)}, ${o.name}`, old: { date, name, kind } });
        await recomputeOfficeDate(tx, o.id, date);
      }
    }, { timeout: 30_000 });
    publish({ type: 'day', officeIds, data: { date } });
    res.json({ id: idOf(kind, date, name), date, name, kind, officeIds });
  });

  return r;
}
