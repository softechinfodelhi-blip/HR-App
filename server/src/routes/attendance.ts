// Today's board, the monthly register, one day in detail, and a manager's direct correction.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { fail } from '../lib/errors';
import { dbDate, fmtMonth, hhmmOf, localDateTime, monthDays, monthOf, now, thisMonth, today, ymdFromDb, type Month } from '../lib/time';
import { parse, zHhmm, zMonth, zUuid, zYmd } from '../lib/validate';
import { actorOf, officeScope, requireAuth, requireManager, scopeWhere } from '../middleware/auth';
import { announceDay, computeDays, computeMonth, countDays, employedWhere, empSelect, officeNameMap, toView } from '../services/attendance';
import { dayBounds, terminalStatuses } from '../services/devices';
import { dayKind, loadCalendars } from '../services/calendar';
import { isLocked } from '../services/locks';
import { assertCanView, canManage } from '../services/permissions';
import { leaveInclude, leaveRow } from '../services/leave';
import { correctDirectly, correctionInclude, correctionRow, userNames } from '../services/requests';
import { queueFor } from './requests';

const zTimes = z.object({
  inTime: zHhmm.nullable().default(null), outTime: zHhmm.nullable().default(null),
  reason: z.string().trim().min(1, 'Write the reason. It is kept in the audit log.').max(500),
});

export function attendanceRoutes(): Router {
  const r = Router();

  /** GET /attendance/today?office=  The live board. */
  r.get('/today', requireManager, officeScope, async (req, res) => {
    const scope = scopeWhere(req);
    const date = today(); const t = now();
    const [offices, emps, names, terminals] = await Promise.all([
      prisma.office.findMany({ where: scope.officeId ? { id: scope.officeId } : {}, orderBy: { number: 'asc' } }),
      prisma.employee.findMany({ where: { ...scope, ...employedWhere(date, date) }, select: empSelect, orderBy: { name: 'asc' } }),
      officeNameMap(prisma), terminalStatuses(prisma, scope),
    ]);
    const days = await computeDays(prisma, emps, date, date);
    const waiting = (await queueFor(prisma, actorOf(req), scope.officeId)).length;
    const people = emps.map(e => ({ employeeId: e.id, name: e.name, code: e.code, officeId: e.officeId, officeName: names.get(e.officeId) ?? '', day: toView(days.get(e.id)![0], names) }));
    const expected = people.filter(p => !['off', 'holiday', 'not_joined'].includes(p.day.status));
    const calendars = await loadCalendars(prisma, offices.map(o => o.id), date, date);
    const kinds = offices.map(o => dayKind(date, calendars.get(o.id)!));
    const only = kinds.length === 1 ? kinds[0] : null;
    res.json({
      date, time: hhmmOf(t), working: kinds.some(k => k.kind === 'working'),
      dayLabel: only && only.kind !== 'working' ? (only.kind === 'holiday' ? only.name ?? 'Holiday' : only.name ?? 'Weekly off') : '',
      counts: {
        total: expected.length,
        in: expected.filter(p => ['working', 'present', 'half_late', 'half_short', 'missing'].includes(p.day.status) || (p.day.status === 'leave' && !!p.day.inTime)).length,
        notIn: expected.filter(p => p.day.status === 'not_in' || p.day.status === 'absent').length,
        onLeave: expected.filter(p => p.day.status === 'leave').length,
        waiting, // requests waiting for this person to decide
      },
      people,
      offices: offices.map(o => ({
        officeId: o.id, name: o.name, headcount: emps.filter(e => e.officeId === o.id).length,
        onTime: null as number | null, lastMonth: null as number | null, best: false, // Phase 6
        terminal: terminals.find(x => x.officeId === o.id) ?? null,
      })),
    });
  });

  /** GET /attendance/register?office=&month= */
  r.get('/register', requireManager, officeScope, async (req, res) => {
    const { month } = parse(z.object({ month: zMonth.default(thisMonth()) }), { month: req.query.month });
    const scope = scopeWhere(req);
    const dates = monthDays(month);
    const [emps, names] = await Promise.all([
      prisma.employee.findMany({ where: { ...scope, ...employedWhere(dates[0], dates[dates.length - 1]) }, select: { ...empSelect, office: { select: { number: true } } }, orderBy: { name: 'asc' } }),
      officeNameMap(prisma),
    ]);
    emps.sort((a, b) => a.office.number - b.office.number || a.name.localeCompare(b.name));
    const days = await computeMonth(prisma, emps, month);
    const t = today();
    const totals = { present: 0, half: 0, absent: 0, leave: 0, missing: 0 };
    const rows = emps.map(e => {
      const list = days.get(e.id)!; const c = countDays(list, t);
      totals.present += c.present; totals.half += c.half; totals.absent += c.absent; totals.leave += c.leave; totals.missing += c.missing;
      return { employeeId: e.id, name: e.name, code: e.code, officeId: e.officeId, days: list.map(d => toView(d, names)), totals: c };
    });
    const runs = await prisma.payrollRun.findMany({ where: { ...scope, month, status: 'locked' } });
    const who = await userNames(prisma, runs.map(l => l.lockedById));
    res.json({
      month, dates, rows, totals,
      locks: runs.map(l => ({ officeId: l.officeId, officeName: names.get(l.officeId) ?? '', lockedAt: l.lockedAt ? localDateTime(l.lockedAt) : null, lockedByName: (l.lockedById && who.get(l.lockedById)) || '' })),
    });
  });

  /** GET /attendance/days/:employeeId/:date  One day, with the raw punches behind it. Also used by an employee for their own day. */
  r.get('/days/:employeeId/:date', requireAuth, async (req, res) => {
    const a = actorOf(req);
    const date = parse(zYmd, req.params.date);
    const e = (await prisma.employee.findUnique({ where: { id: parse(zUuid, req.params.employeeId) }, select: empSelect })) ?? fail(404, 'Employee was not found.');
    assertCanView(a, e);
    const names = await officeNameMap(prisma);
    const day = (await computeDays(prisma, [e], date, date)).get(e.id)![0];
    const [punches, requests, leaves, locked] = await Promise.all([
      e.terminalUserId ? prisma.rawPunch.findMany({ where: { terminalUserId: e.terminalUserId, punchTime: dayBounds(date) }, orderBy: { punchTime: 'asc' }, include: { device: { select: { name: true, officeId: true } } } }) : [],
      prisma.correctionRequest.findMany({ where: { employeeId: e.id, date: dbDate(date) }, include: correctionInclude, orderBy: { createdAt: 'desc' } }),
      prisma.leaveRequest.findMany({ where: { employeeId: e.id, fromDate: { lte: dbDate(date) }, toDate: { gte: dbDate(date) } }, include: leaveInclude, orderBy: { createdAt: 'desc' } }),
      isLocked(prisma, e.officeId, monthOf(date)),
    ]);
    const who = await userNames(prisma, [...requests.map(c => c.decidedById), ...leaves.map(l => l.decidedById)]);
    const applied = day.correctionId ? requests.find(c => c.id === day.correctionId) : undefined;
    res.json({
      employee: { id: e.id, name: e.name, code: e.code, officeId: e.officeId, officeName: names.get(e.officeId) ?? '' },
      day: toView(day, names),
      // Exactly what the terminals recorded. These never change.
      punches: punches.map(p => ({ time: hhmmOf(p.punchTime), at: localDateTime(p.punchTime), terminalName: p.device.name, officeName: names.get(p.device.officeId) ?? '', other: p.device.officeId !== e.officeId })),
      // The approved correction in force for this day: who approved it and when.
      manual: applied ? { employeeId: e.id, date, inTime: applied.claimedIn, outTime: applied.claimedOut, reason: applied.reason, byId: applied.decidedById, byName: (applied.decidedById && who.get(applied.decidedById)) || '', at: applied.decidedAt ? localDateTime(applied.decidedAt) : null } : null,
      requests: [...requests.map(c => correctionRow(c, a, who)), ...leaves.map(l => leaveRow(l, a, who))],
      canCorrect: canManage(a, e) && !locked && date <= today() && date >= ymdFromDb(e.joiningDate),
      lockedNote: locked ? `${fmtMonth(monthOf(date))} is locked. Figures cannot change.` : null,
    });
  });

  /** PUT /attendance/days/:employeeId/:date/manual  A manager supplies the missing or disputed time. */
  r.put('/days/:employeeId/:date/manual', requireManager, async (req, res) => {
    const a = actorOf(req);
    const date = parse(zYmd, req.params.date);
    const body = parse(zTimes, req.body);
    const changed = await prisma.$transaction(tx => correctDirectly(tx, a, parse(zUuid, req.params.employeeId), date, body));
    announceDay(changed);
    res.status(204).end();
  });

  return r;
}

export function meRoutes(): Router {
  const r = Router();

  /** GET /me/attendance?month= */
  r.get('/attendance', requireAuth, async (req, res) => {
    const a = actorOf(req);
    if (!a.employeeId) fail(403, 'The admin account has no attendance.');
    const month: Month = parse(zMonth.default(thisMonth()), req.query.month);
    const e = await prisma.employee.findUniqueOrThrow({ where: { id: a.employeeId }, select: empSelect });
    const [names, days, pending, locked] = await Promise.all([
      officeNameMap(prisma), computeMonth(prisma, [e], month),
      prisma.correctionRequest.findMany({ where: { employeeId: e.id, status: 'pending' }, select: { date: true } }),
      isLocked(prisma, e.officeId, month),
    ]);
    const list = days.get(e.id)!;
    res.json({ month, days: list.map(d => toView(d, names)), totals: countDays(list, today()), locked, pendingDates: pending.map(p => ymdFromDb(p.date)) });
  });

  return r;
}
