// Office stats, the admin's organisation overview, global search, the audit log, and the employee home screen.
import { Router } from 'express';
import { z } from 'zod';
import { Prisma, prisma } from '../db';
import { fail } from '../lib/errors';
import { addMonths, fmtDate, fmtMonth, hhmmOf, isValidYmd, istToUtc, localDateTime, monthDays, monthOf, now, thisMonth, today, ymdFromDb, addDays, type Month, type Ymd } from '../lib/time';
import { pageOf, parse, skipTake, zListQuery, zMonth, zUuid } from '../lib/validate';
import { actorOf, officeScope, requireAdmin, requireAuth, requireManager, scopeWhere } from '../middleware/auth';
import { computeDays, computeMonth, countDays, employedWhere, empSelect, officeNameMap, toView } from '../services/attendance';
import { dayKind, loadCalendar } from '../services/calendar';
import { terminalStatuses } from '../services/devices';
import { employeeRow, loadEmployee } from '../services/employees';
import { gamificationFor, officeOfTheMonth, officeOnTimeRate } from '../services/gamification';
import { balancesOf } from '../services/leave';
import { isLocked } from '../services/locks';
import { assertCanView, resolveOfficeScope } from '../services/permissions';
import { queueFor, requestRows } from './requests';

/** Office on-time figures for the board and the stats endpoint. `best` marks the office of the month (last full month). */
export async function officeStats(officeIds: string[], month: Month) {
  const last = addMonths(month, -1);
  const top = await officeOfTheMonth(prisma, last);
  return Promise.all(officeIds.map(async id => {
    const [cur, prev] = await Promise.all([officeOnTimeRate(prisma, id, month), officeOnTimeRate(prisma, id, last)]);
    return { officeId: id, month, onTime: cur.rate, expected: cur.expected, onTimeCount: cur.onTime, lastMonth: prev.rate, best: top?.officeId === id };
  }));
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** Reads a date out of what someone typed: 2026-11-23, 23/11, 23/11/2026, 23 nov, nov 23. The year defaults to this year. */
export function parseDate(q: string, year: number): Ymd | null {
  const s = q.trim().toLowerCase();
  const pad = (n: number | string) => String(n).padStart(2, '0');
  const ok = (y: number, m: number, d: number) => { const v = `${y}-${pad(m)}-${pad(d)}`; return isValidYmd(v) ? v : null; };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return ok(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}))?$/.exec(s);
  if (m) return ok(m[3] ? Number(m[3]) : year, Number(m[2]), Number(m[1]));
  const word = (w: string) => MONTHS.findIndex(x => w.length >= 3 && x.startsWith(w)) + 1;
  m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)(?:\s+(\d{4}))?$/.exec(s);
  if (m && word(m[2])) return ok(m[3] ? Number(m[3]) : year, word(m[2]), Number(m[1]));
  m = /^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?$/.exec(s);
  if (m && word(m[1])) return ok(m[3] ? Number(m[3]) : year, word(m[1]), Number(m[2]));
  return null;
}
/** A month someone typed: november, nov 2026, 2026-11. */
export function parseMonth(q: string, year: number): Month | null {
  const s = q.trim().toLowerCase();
  let m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${m[1]}-${String(m[2]).padStart(2, '0')}`;
  m = /^([a-z]{3,})(?:\s+(\d{4}))?$/.exec(s);
  const i = m ? MONTHS.findIndex(x => x.startsWith(m![1])) + 1 : 0;
  return i ? `${m![2] ?? year}-${String(i).padStart(2, '0')}` : null;
}

const SCREENS = [
  { label: 'Home', to: '/' }, { label: 'Employees', to: '/people' }, { label: 'Offices and office heads', to: '/people/offices', admin: true },
  { label: 'Attendance register', to: '/attendance' }, { label: 'Correction requests', to: '/attendance/corrections' }, { label: 'Terminals', to: '/attendance/terminals' },
  { label: 'Leave requests', to: '/leave' }, { label: 'Leave calendar', to: '/leave/calendar' }, { label: 'Holidays', to: '/leave/holidays' },
  { label: 'Payroll', to: '/payroll' }, { label: 'Payslips', to: '/payroll/payslips' },
  { label: 'Organisation settings', to: '/settings', admin: true }, { label: 'Audit log', to: '/settings/audit' },
];
const MY_SCREENS = [{ label: 'Home', to: '/me' }, { label: 'My attendance', to: '/me/attendance' }, { label: 'My leave', to: '/me/leave' }, { label: 'Apply for leave', to: '/me/leave/apply' }, { label: 'My payslips', to: '/me/payslips' }, { label: 'My profile', to: '/me/profile' }];
interface SearchHit { type: 'person' | 'date' | 'request' | 'payslip' | 'screen'; label: string; sub: string; to: string; }

export function insightRoutes(): Router {
  const r = Router();

  /** GET /stats/offices?office=&month=  On-time rate per office, and which one is office of the month. */
  r.get('/stats/offices', requireManager, officeScope, async (req, res) => {
    const month = parse(zMonth.default(thisMonth()), req.query.month);
    const scope = scopeWhere(req);
    const offices = await prisma.office.findMany({ where: scope.officeId ? { id: scope.officeId } : {}, orderBy: { number: 'asc' } });
    const stats = await officeStats(offices.map(o => o.id), month);
    res.json(stats.map(s => ({ ...s, name: offices.find(o => o.id === s.officeId)!.name })));
  });

  /** GET /overview  Admin only: every office on one page. */
  r.get('/overview', requireAdmin, async (req, res) => {
    const a = actorOf(req);
    const date = today(); const month = monthOf(date); const prev = addMonths(month, -1);
    const [offices, terminals, names, queue, runs] = await Promise.all([
      prisma.office.findMany({ orderBy: { number: 'asc' }, include: { head: { select: { name: true } } } }),
      terminalStatuses(prisma, {}), officeNameMap(prisma), queueFor(prisma, a),
      prisma.payrollRun.findMany({ where: { month: { in: [month, prev] } } }),
    ]);
    const stats = await officeStats(offices.map(o => o.id), month);
    const emps = await prisma.employee.findMany({ where: employedWhere(date, date), select: empSelect });
    const days = await computeDays(prisma, emps, date, date);
    const pending = await requestRows(prisma, a, { status: 'pending' });
    const rows = offices.map(o => {
      const mine = emps.filter(e => e.officeId === o.id).map(e => toView(days.get(e.id)![0], names));
      const expected = mine.filter(d => !['off', 'holiday', 'not_joined'].includes(d.status));
      const s = stats.find(x => x.officeId === o.id)!;
      const last = runs.find(x => x.officeId === o.id && x.month === prev);
      return {
        officeId: o.id, name: o.name, address: o.address, headId: o.headEmployeeId, headName: o.head?.name ?? null, headcount: mine.length,
        today: {
          working: expected.length > 0 || mine.length === 0, expected: expected.length,
          in: expected.filter(d => !!d.inTime && d.status !== 'leave').length, notIn: expected.filter(d => d.status === 'not_in' || d.status === 'absent').length,
          onLeave: expected.filter(d => d.status === 'leave').length,
        },
        pendingRequests: pending.filter(p => p.officeId === o.id && !p.direct).length,
        escalated: pending.filter(p => p.officeId === o.id && p.escalated).length,
        terminal: terminals.find(t => t.officeId === o.id) ?? null,
        onTime: s.onTime, lastMonth: s.lastMonth, best: s.best,
        payroll: { month: prev, locked: last?.status === 'locked', lockedAt: last?.lockedAt ? localDateTime(last.lockedAt) : null, reviewed: !!last?.reviewedAt },
      };
    });
    res.json({
      date, time: hhmmOf(now()), month, offices: rows,
      totals: {
        offices: rows.length, people: rows.reduce((n, o) => n + o.headcount, 0), in: rows.reduce((n, o) => n + o.today.in, 0), onLeave: rows.reduce((n, o) => n + o.today.onLeave, 0),
        pendingRequests: rows.reduce((n, o) => n + o.pendingRequests, 0), waitingForYou: queue.length, terminalsOffline: terminals.filter(t => !t.online).length,
        monthsToLock: rows.filter(o => !o.payroll.locked).length,
      },
    });
  });

  /** GET /search?q=&office=  People, dates, requests, payslips and screens. Everything is limited to what the caller may see. */
  r.get('/search', requireAuth, async (req, res) => {
    const a = actorOf(req);
    const { q, office } = parse(z.object({ q: z.string().trim().max(80).default(''), office: z.string().max(60).optional() }), req.query);
    if (!q) return void res.json([]);
    const s = q.toLowerCase();
    const year = Number(today().slice(0, 4));
    const hits: SearchHit[] = [];
    const date = parseDate(q, year);
    const month = parseMonth(q, year);

    if (a.role === 'employee') {
      // An employee searches their own record only.
      if (date) hits.push({ type: 'date', label: `${fmtDate(date)} ${date.slice(0, 4)}`, sub: 'My attendance', to: `/me/attendance?month=${monthOf(date)}` });
      const mine = await requestRows(prisma, a, { employeeId: a.employeeId! });
      for (const x of mine.filter(x => !x.direct && `${x.title} ${x.reason} ${x.status}`.toLowerCase().includes(s)).slice(0, 5)) hits.push({ type: 'request', label: x.title, sub: `My request · ${x.status}`, to: x.kind === 'leave' ? '/me/leave' : '/me/attendance' });
      const slips = await prisma.payrollItem.findMany({ where: { employeeId: a.employeeId!, run: { status: 'locked' } }, include: { run: { select: { month: true } } }, orderBy: { run: { month: 'desc' } }, take: 24 });
      for (const p of slips.filter(p => month ? p.run.month === month : `payslip ${fmtMonth(p.run.month)}`.toLowerCase().includes(s)).slice(0, 5)) hits.push({ type: 'payslip', label: `Payslip · ${fmtMonth(p.run.month)}`, sub: 'My payslips', to: `/me/payslips/${p.run.month}` });
      for (const x of MY_SCREENS.filter(x => x.label.toLowerCase().includes(s))) hits.push({ type: 'screen', label: x.label, sub: 'Go to screen', to: x.to });
      return void res.json(hits);
    }

    const scope = resolveOfficeScope(a, office);
    const inScope: Prisma.EmployeeWhereInput = scope ? { officeId: scope } : {};
    const people = await prisma.employee.findMany({
      where: { ...inScope, OR: [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }, { user: { email: { contains: q, mode: 'insensitive' } } }] },
      include: { office: { select: { name: true } } }, orderBy: { name: 'asc' }, take: 6,
    });
    for (const e of people) hits.push({ type: 'person', label: e.name, sub: `${e.code} · ${e.office.name} · ${e.designation}`, to: `/people/${e.id}` });

    if (date) hits.push({ type: 'date', label: `${fmtDate(date)} ${date.slice(0, 4)}`, sub: 'Attendance register', to: `/attendance?month=${monthOf(date)}&date=${date}` });
    else if (month) hits.push({ type: 'date', label: fmtMonth(month), sub: 'Attendance register', to: `/attendance?month=${month}` });

    // Requests: by the person's name, or on the date typed.
    const reqs = await requestRows(prisma, a, { officeId: scope ?? undefined, search: date ? undefined : q });
    const matching = reqs.filter(x => !x.direct && (date ? x.dates.includes(date) : true))
      .sort((x, y) => Number(y.status === 'pending') - Number(x.status === 'pending') || y.createdAt.localeCompare(x.createdAt)).slice(0, 5);
    for (const x of matching) hits.push({ type: 'request', label: `${x.employeeName} · ${x.title}`, sub: `${x.kind === 'leave' ? 'Leave request' : 'Correction request'} · ${x.status}`, to: x.kind === 'leave' ? '/leave' : '/attendance/corrections' });

    // Payslips: by the person's name or code, or every payslip of a month typed.
    const slips = await prisma.payrollItem.findMany({
      where: { run: { status: 'locked', ...(scope ? { officeId: scope } : {}), ...(month && !people.length ? { month } : {}) }, ...(month && !people.length ? {} : { OR: [{ employeeName: { contains: q, mode: 'insensitive' } }, { employeeCode: { contains: q, mode: 'insensitive' } }] }) },
      include: { run: { select: { month: true } } }, orderBy: [{ run: { month: 'desc' } }, { employeeName: 'asc' }], take: 5,
    });
    for (const p of slips) hits.push({ type: 'payslip', label: `${p.employeeName} · ${fmtMonth(p.run.month)}`, sub: `Payslip · ${p.employeeCode}`, to: `/payroll/payslips/${p.employeeId}/${p.run.month}` });

    for (const x of SCREENS.filter(x => (!x.admin || a.role === 'admin') && x.label.toLowerCase().includes(s))) hits.push({ type: 'screen', label: x.label, sub: 'Go to screen', to: x.to });
    res.json(hits);
  });

  /** GET /audit?office=&search=&month=&page=  Newest first. A head sees their office's entries. */
  r.get('/audit', requireManager, officeScope, async (req, res) => {
    const a = actorOf(req);
    const q = parse(zListQuery.extend({ pageSize: z.coerce.number().int().min(1).max(200).default(50), action: z.string().trim().max(60).optional() }), req.query);
    const scope = scopeWhere(req);
    // Entries without an office (settings, the admin's own account) are only in the admin's "all offices" view.
    const where: Prisma.AuditLogWhereInput = { ...(scope.officeId ? { officeId: scope.officeId } : {}) };
    if (q.search) where.OR = [{ action: { contains: q.search, mode: 'insensitive' } }, { detail: { contains: q.search, mode: 'insensitive' } }, { actorName: { contains: q.search, mode: 'insensitive' } }];
    if (q.action) where.action = { contains: q.action, mode: 'insensitive' };
    if (q.month) { const d = monthDays(q.month); where.createdAt = { gte: istToUtc(d[0]), lt: istToUtc(addDays(d[d.length - 1], 1)) }; }
    const [total, rows] = await Promise.all([prisma.auditLog.count({ where }), prisma.auditLog.findMany({ where, orderBy: { id: 'desc' }, ...skipTake(q) })]);
    res.json(pageOf(rows.map(l => {
      // Old and new values that hold a salary amount are shown to the admin only.
      const values = l.sensitive && a.role !== 'admin' ? {} : { old: l.oldValue, new: l.newValue };
      return { id: l.id.toString(), at: localDateTime(l.createdAt), actorId: l.actorId, actorName: l.actorName, officeId: l.officeId, action: l.action, entity: l.entity, entityId: l.entityId, detail: l.detail, ...values };
    }), total, q));
  });

  /** GET /employees/:id/badges  Streak and badges: for the employee, their office head and the admin. */
  r.get('/employees/:id/badges', requireAuth, async (req, res) => {
    const e = await loadEmployee(prisma, parse(zUuid, req.params.id));
    assertCanView(actorOf(req), e);
    res.json(await gamificationFor(prisma, e));
  });

  /** GET /me/home  Everything on the employee's home screen in one call. */
  r.get('/me/home', requireAuth, async (req, res) => {
    const a = actorOf(req);
    if (!a.employeeId) fail(403, 'The admin account has no attendance.');
    const e = await loadEmployee(prisma, a.employeeId);
    const date = today(); const month = monthOf(date); const prev = addMonths(month, -1);
    const first = `${prev}-01`; const last = monthDays(month).at(-1)!;
    const [names, span, game, balances, requests, cal, slip] = await Promise.all([
      officeNameMap(prisma), computeDays(prisma, [e], first, last), gamificationFor(prisma, e), balancesOf(prisma, e.id),
      requestRows(prisma, a, { employeeId: e.id, status: 'pending' }), loadCalendar(prisma, e.officeId, date, `${Number(date.slice(0, 4)) + 1}-12-31`),
      prisma.payrollItem.findFirst({ where: { employeeId: e.id, run: { status: 'locked' } }, include: { run: { select: { month: true } } }, orderBy: { run: { month: 'desc' } } }),
    ]);
    const days = span.get(e.id)!;
    const thisMonthDays = days.filter(d => monthOf(d.date) === month);
    const todayDay = days.find(d => d.date === date)!;
    const kind = dayKind(date, cal);
    const pendingFix = new Set(requests.filter(x => x.kind === 'correction').flatMap(x => x.dates));
    const locked = { [prev]: await isLocked(prisma, e.officeId, prev), [month]: await isLocked(prisma, e.officeId, month) };
    const next = [...cal.holidays.entries()].filter(([d]) => d >= date && dayKind(d, cal).kind === 'holiday').sort((x, y) => x[0].localeCompare(y[0]))[0];
    const t = countDays(thisMonthDays, date);
    res.json({
      employee: employeeRow(e, a), today: toView(todayDay, names), time: hhmmOf(now()),
      dayKindLabel: kind.kind === 'working' ? '' : kind.kind === 'holiday' ? kind.name ?? 'Holiday' : kind.name ?? 'Weekly off',
      // Missing punches the employee can still do something about.
      missing: days.filter(d => d.status === 'missing' && !pendingFix.has(d.date) && !locked[monthOf(d.date)]).map(d => toView(d, names)),
      streak: game.streak, badges: game.badges, balances, pending: requests.filter(x => !x.direct),
      nextHoliday: next ? { date: next[0], name: next[1] } : null,
      latestPayslip: slip ? { employeeId: e.id, name: slip.employeeName, code: slip.employeeCode, month: slip.run.month, net: Number(slip.netSalary), salary: Number(slip.monthlySalary), unpaidDays: Number(slip.unpaidDays) } : null,
      month: { present: t.present, half: t.half, absent: t.absent, leave: t.leave },
      firstDays: ymdFromDb(e.joiningDate) >= addDays(date, -6),
    });
  });

  return r;
}

/** The parts of the profile that come from attendance: this month so far, the streak and recent requests. */
export async function profileExtras(employeeId: string, actor: Parameters<typeof requestRows>[1]) {
  const e = await loadEmployee(prisma, employeeId);
  const month = thisMonth();
  const [days, game, recent] = await Promise.all([computeMonth(prisma, [e], month), gamificationFor(prisma, e), requestRows(prisma, actor, { employeeId })]);
  const t = countDays(days.get(e.id)!, today());
  return {
    month: { month, present: t.present, half: t.half, absent: t.absent, leave: t.leave, missing: t.missing },
    streak: game.streak, badges: game.badges,
    recent: recent.filter(x => !x.direct).sort((x, y) => y.createdAt.localeCompare(x.createdAt)).slice(0, 6),
  };
}
