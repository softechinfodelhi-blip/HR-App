// Payroll: one month for one office, the month-end checklist, locking, and payslips.
import { Fragment, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { addMonths, fmtDate, fmtDateTime, fmtDays, fmtMoney, fmtMonth, fmtMonthName, fmtNum, fmtTime, monthDays, monthOf } from '../../lib/format';
import { DayDrawer, PayslipSheet, RequestItem, useScope } from '../../shared';
import type { PayrollData } from '../../types';
import { Avatar, Bar, Button, Card, CountUp, cx, Empty, errText, HoldButton, Icon, Load, MonthPicker, PageTitle, SectionTitle, Skeleton, SkeletonRows, Tag, useAction, useData, useToast } from '../../ui';

/** In the first days of a month people are closing the previous one, so open that. */
const defaultMonth = () => { const t = api.demo.now(); const m = monthOf(t); return Number(t.slice(8, 10)) <= 10 ? addMonths(m, -1) : m; };

export function Payroll() {
  const { scope, setScope } = useScope();
  const [month, setMonth] = useState(defaultMonth);
  return (
    <div>
      <PageTitle title="Payroll" sub="Net pay = salary − day rate × unpaid days. Day rate = salary ÷ calendar days in the month."
        actions={<MonthPicker month={month} onChange={setMonth} max={monthOf(api.demo.now())} min="2026-10" />} />
      {scope === 'all' ? <Overview month={month} open={setScope} /> : <OfficeMonth key={`${scope}|${month}`} officeId={scope} month={month} />}
    </div>
  );
}

function Overview({ month, open }: { month: string; open: (officeId: string) => void }) {
  const q = useData(() => api.payrollOverview(month), [month]);
  return (
    <Load q={q} skeleton={<SkeletonRows rows={3} />}>
      {rows => (
        <>
          <Card className="divide-y divide-mist">
            {rows.map(o => (
              <button key={o.officeId} onClick={() => open(o.officeId)} className="flex w-full flex-wrap items-center gap-x-6 gap-y-2 px-4 py-4 text-left transition-colors hover:bg-ivory">
                <span className="w-44"><span className="block font-semibold">{o.officeName}</span><span className="block text-[13px] text-slate">{o.totals.people} people · {o.headName ?? 'No head'}</span></span>
                <span className="min-w-32 flex-1"><span className="block text-[13px] text-slate">Net pay</span><span className="font-serif text-xl font-semibold tnum">{fmtMoney(o.totals.net)}</span></span>
                <span className="w-28"><span className="block text-[13px] text-slate">Unpaid days</span><span className="font-medium tnum">{fmtNum(o.totals.unpaidDays)}</span></span>
                <span className="w-40">{o.locked ? <Tag tone="present">Locked</Tag> : o.missing > 0 ? <Tag tone="absent">{o.missing} missing {o.missing === 1 ? 'punch' : 'punches'}</Tag> : <Tag tone="brass">Open</Tag>}</span>
                <Icon name="right" size={16} className="text-slate" />
              </button>
            ))}
          </Card>
          <p className="mt-3 text-[13px] text-slate">Each office head locks their own office. Pick an office to see its people, or to unlock a month.</p>
        </>
      )}
    </Load>
  );
}

function OfficeMonth({ officeId, month }: { officeId: string; month: string }) {
  const q = useData(() => api.payroll(officeId, month), [officeId, month]);
  const [justLocked, setJustLocked] = useState(false);
  return (
    <Load q={q} skeleton={<><div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-[92px] !rounded-xl" />)}</div><SkeletonRows rows={8} /></>}>
      {d => (
        <>
          <div className="stagger mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {([['Total salary', d.totals.salary, fmtMoney], ['Unpaid days', d.totals.unpaidDays, fmtNum], ['Deductions', d.totals.deduction, fmtMoney], ['Net pay', d.totals.net, fmtMoney]] as const).map(([k, v, f]) => (
              <Card key={k} className="p-4"><div className="text-slate">{k}</div><div className="mt-1 font-serif text-[22px] font-semibold leading-tight sm:text-[26px]"><CountUp value={v} format={f} /></div></Card>
            ))}
          </div>
          {d.locked ? <Locked d={d} fresh={justLocked} reload={q.reload} /> : <Checklist d={d} reload={q.reload} onLocked={() => setJustLocked(true)} />}
          <Table d={d} />
        </>
      )}
    </Load>
  );
}

function Step({ n, ok, title, children }: { n: number; ok: boolean; title: string; children?: React.ReactNode }) {
  return (
    <li className="px-4 py-4">
      <div className="flex items-center gap-3">
        <span key={String(ok)} className={cx('flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-bold', ok ? 'anim-pop bg-present text-white' : 'border border-slate text-slate')}>{ok ? <Icon name="check" size={15} /> : n}</span>
        <span className={cx('font-semibold', ok && 'text-slate')}>{title}</span>
      </div>
      {children && <div className="mt-3 sm:pl-10">{children}</div>}
    </li>
  );
}

/** Month end in three steps and a lock. The lock is the only action in the app that asks for a deliberate press and hold. */
function Checklist({ d, reload, onLocked }: { d: PayrollData; reload: () => Promise<void>; onLocked: () => void }) {
  const toast = useToast();
  const [day, setDay] = useState<{ employeeId: string; date: string } | null>(null);
  const review = useAction(async () => { await api.markReviewed(d.officeId, d.month, !d.reviewed); await reload(); });
  const lock = async () => {
    try { await api.lockMonth(d.officeId, d.month); onLocked(); await reload(); toast.show(`${fmtMonth(d.month)} is locked. Payslips are released.`); }
    catch (e) { toast.show(errText(e)); }
  };
  const steps = [d.missing.length === 0, d.pending.length === 0, d.reviewed];
  const done = steps.filter(Boolean).length;
  const name = fmtMonthName(d.month);
  return (
    <section className="mb-6">
      <SectionTitle right={<span className="text-[13px] text-slate tnum">{done} of 3 done</span>}>Month-end checklist</SectionTitle>
      <Card className="overflow-hidden">
        <div className="px-4 pt-4"><Bar value={done / 3} /></div>
        {!d.monthClosed && <p className="px-4 pt-3 text-[13px] text-slate">{name} is still running. These figures are so far. You can lock it from {fmtDate(addMonths(d.month, 1) + '-01')}.</p>}
        <ol className="divide-y divide-mist">
          <Step n={1} ok={steps[0]} title={steps[0] ? 'No missing punches' : `Resolve ${d.missing.length} missing ${d.missing.length === 1 ? 'punch' : 'punches'}`}>
            {d.missing.length > 0 && (
              <div className="divide-y divide-mist rounded-lg border border-mist">
                {d.missing.map(m => m.request ? <RequestItem key={m.employeeId + m.date} r={m.request} onChanged={reload} /> : (
                  <div key={m.employeeId + m.date} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <Avatar name={m.name} />
                    <span className="min-w-0 flex-1 basis-48"><span className="block font-semibold">{m.name}</span><span className="block text-[13px] text-slate">{fmtDate(m.date)} · in {fmtTime(m.inTime)}, no punch out · no request sent yet</span></span>
                    <Button size="sm" onClick={() => setDay({ employeeId: m.employeeId, date: m.date })}>Enter the out time</Button>
                  </div>
                ))}
              </div>
            )}
          </Step>
          <Step n={2} ok={steps[1]} title={steps[1] ? `No pending requests for ${name}` : `Decide ${d.pending.length} pending ${d.pending.length === 1 ? 'request' : 'requests'} for ${name}`}>
            {d.pending.length > 0 && <div className="divide-y divide-mist rounded-lg border border-mist">{d.pending.map(r => <RequestItem key={r.id} r={r} onChanged={reload} />)}</div>}
          </Step>
          <Step n={3} ok={steps[2]} title={d.reviewed ? `Salaries reviewed${d.reviewedByName ? ` by ${d.reviewedByName}` : ''}` : 'Review the salaries below'}>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" state={review.state} onClick={() => review.run()}>{d.reviewed ? 'Undo review' : 'Mark as reviewed'}</Button>
              {!d.reviewed && <span className="text-[13px] text-slate">Open any row to see which days are unpaid.</span>}
            </div>
          </Step>
        </ol>
        <div className="flex flex-wrap items-center gap-4 border-t border-mist bg-ivory px-4 py-4">
          <HoldButton label={`Hold to lock ${name}`} disabled={!d.canLock} onDone={lock} />
          <p className="min-w-0 flex-1 basis-56 text-[13px] text-slate">
            {d.canLock ? 'Press and hold for one second. After locking, attendance and salaries for the month are frozen and payslips go to everyone.'
              : !d.monthClosed ? `Locking opens once ${name} has ended.` : 'Finish the three steps above to lock.'}
          </p>
        </div>
      </Card>
      <DayDrawer target={day} onClose={() => setDay(null)} onChanged={reload} />
    </section>
  );
}

function Locked({ d, fresh, reload }: { d: PayrollData; fresh: boolean; reload: () => Promise<void> }) {
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const unlock = useAction(async () => { await api.unlockMonth(d.officeId, d.month, reason); setAsking(false); await reload(); toast.show(`${fmtMonth(d.month)} is unlocked. Payslips are withdrawn.`); });
  return (
    <Card className="mb-6 p-5">
      <div className="flex flex-wrap items-center gap-4">
        <span className={cx('flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brass/15 text-brass', fresh && 'anim-pop')}><Icon name="lock" size={22} /></span>
        <div className="min-w-0 flex-1 basis-56">
          <div className="font-serif text-xl font-semibold">{fresh ? 'All done. ' : ''}{fmtMonth(d.month)} is locked</div>
          <p className="text-slate">Locked by {d.lockedByName} on {d.lockedAt && fmtDateTime(d.lockedAt)}. Payslips are released to {d.totals.people} people.</p>
        </div>
        <Link to="/payroll/payslips" className="btn btn-secondary">View payslips</Link>
        {d.canUnlock && !asking && <Button variant="ghost" onClick={() => setAsking(true)}>Unlock</Button>}
      </div>
      {asking && (
        <form className="anim-fade-up mt-4 flex flex-wrap items-start gap-2 border-t border-mist pt-4" onSubmit={e => { e.preventDefault(); unlock.run(); }}>
          <div className="min-w-0 flex-1 basis-64">
            <input autoFocus className={cx('input', unlock.error && 'invalid')} placeholder="Why is this month being unlocked? (required)" value={reason} onChange={e => setReason(e.target.value)} />
            <p className={cx('mt-1 text-[13px]', unlock.error ? 'text-absent' : 'text-slate')}>{unlock.error || 'Payslips are withdrawn until the head locks the month again. This is written to the audit log.'}</p>
          </div>
          <Button variant="danger" type="submit" state={unlock.state}>Unlock month</Button>
          <Button variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
        </form>
      )}
    </Card>
  );
}

function Table({ d }: { d: PayrollData }) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const extra = 'hidden px-3 py-3 text-right lg:table-cell';
  const cols = all ? 10 : 5;
  return (
    <section>
      <SectionTitle right={<Button size="sm" variant="ghost" className="max-lg:hidden" onClick={() => setAll(a => !a)}>{all ? 'Show fewer columns' : 'Show all 10 columns'}</Button>}>{d.officeName}, {fmtMonth(d.month)}</SectionTitle>
      <Card className="overflow-x-auto">
        <table className="w-full text-left">
          <thead className="border-b border-mist text-[12px] uppercase tracking-wide text-slate">
            <tr>
              <th className="px-4 py-3 font-semibold">Employee</th>
              <th className="hidden px-3 py-3 text-right font-semibold sm:table-cell">Salary</th>
              {all && ['Present', 'Half', 'Absent', 'Paid leave', 'Unpaid leave'].map(h => <th key={h} className={cx(extra, 'font-semibold')}>{h}</th>)}
              <th className="px-3 py-3 text-right font-semibold">Unpaid days</th>
              <th className="hidden px-3 py-3 text-right font-semibold sm:table-cell">Deduction</th>
              <th className="px-4 py-3 text-right font-semibold">Net pay</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-mist">
            {d.rows.map(r => (
              <Fragment key={r.employeeId}>
                <tr onClick={() => setOpen(o => (o === r.employeeId ? null : r.employeeId))} className="cursor-pointer transition-colors hover:bg-ivory" aria-expanded={open === r.employeeId}>
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2"><Icon name={open === r.employeeId ? 'down' : 'right'} size={14} className="text-slate" /><span><span className="block font-medium">{r.name}</span><span className="block text-[13px] text-slate">{r.employeeId}</span></span>
                      {r.missing > 0 && <Tag tone="absent">Missing punch</Tag>}</span>
                  </td>
                  <td className="hidden px-3 py-3 text-right tnum sm:table-cell">{fmtMoney(r.salary)}</td>
                  {all && [r.present, r.half, r.absent, r.paidLeave, r.unpaidLeave].map((v, i) => <td key={i} className={cx(extra, 'tnum', !v && 'text-off')}>{fmtNum(v)}</td>)}
                  <td className={cx('px-3 py-3 text-right tnum', r.unpaidDays ? 'font-semibold' : 'text-off')}>{fmtNum(r.unpaidDays)}</td>
                  <td className={cx('hidden px-3 py-3 text-right tnum sm:table-cell', !r.deduction && 'text-off')}>{fmtMoney(r.deduction)}</td>
                  <td className="px-4 py-3 text-right font-semibold tnum">{fmtMoney(r.net)}</td>
                </tr>
                {open === r.employeeId && (
                  <tr className="bg-ivory">
                    <td colSpan={cols} className="px-4 py-3">
                      <div className="anim-fade-up sm:pl-6">
                        <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-slate">Where the unpaid days come from</div>
                        {r.trace.length === 0 ? <p className="text-slate">No unpaid days. Full salary of {fmtMoney(r.salary)}.</p> : (
                          <ul className="max-w-xl divide-y divide-mist">
                            {r.trace.map(t => <li key={t.date + t.label} className="flex justify-between gap-4 py-1.5"><span>{fmtDate(t.date)} · {t.label}</span><span className="tnum">{fmtDays(t.unpaid)}</span></li>)}
                            <li className="flex justify-between gap-4 py-1.5 font-semibold"><span>{fmtNum(r.unpaidDays)} × day rate {fmtMoney(r.dayRate)}</span><span className="tnum">− {fmtMoney(r.deduction)}</span></li>
                          </ul>
                        )}
                        <div className="mt-2 flex gap-4 text-[13px] font-medium">
                          <Link to={`/people/${r.employeeId}`} className="underline">Profile</Link>
                          {d.locked && <Link to={`/payroll/payslips/${r.employeeId}/${d.month}`} className="underline">Payslip</Link>}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
          <tfoot className="border-t-2 border-ink font-semibold">
            <tr>
              <td className="px-4 py-3">{d.totals.people} people</td>
              <td className="hidden px-3 py-3 text-right tnum sm:table-cell">{fmtMoney(d.totals.salary)}</td>
              {all && <td colSpan={5} className="hidden lg:table-cell" />}
              <td className="px-3 py-3 text-right tnum">{fmtNum(d.totals.unpaidDays)}</td>
              <td className="hidden px-3 py-3 text-right tnum sm:table-cell">{fmtMoney(d.totals.deduction)}</td>
              <td className="px-4 py-3 text-right tnum">{fmtMoney(d.totals.net)}</td>
            </tr>
          </tfoot>
        </table>
      </Card>
      <p className="mt-2 text-[13px] text-slate">{fmtMonthName(d.month)} has {monthDays(d.month).length} calendar days. Unpaid days = absent + half of each half day + unpaid leave.</p>
    </section>
  );
}

// =====================================================================
export function Payslips() {
  const { scope, label } = useScope();
  const [month, setMonth] = useState(() => addMonths(monthOf(api.demo.now()), -1));
  const q = useData(() => api.payslips(scope, month), [scope, month]);
  return (
    <div>
      <PageTitle title="Payslips" sub={label} actions={<MonthPicker month={month} onChange={setMonth} max={monthOf(api.demo.now())} min="2026-10" />} />
      <Load q={q} skeleton={<SkeletonRows rows={6} />}>
        {rows => (
          <Card>
            {rows.length === 0 ? <Empty icon="lock" title="Not released yet" text={`Payslips for ${fmtMonth(month)} appear here once the month is locked.`} action={<Link to="/payroll" className="btn btn-secondary">Go to payroll</Link>} /> : (
              <ul className="divide-y divide-mist">
                {rows.map(p => (
                  <li key={p.employeeId}>
                    <Link to={`/payroll/payslips/${p.employeeId}/${p.month}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-ivory">
                      <Avatar name={p.name} /><span className="min-w-0 flex-1"><span className="block font-medium">{p.name}</span><span className="block text-[13px] text-slate">{p.employeeId}{p.unpaidDays > 0 && ` · ${fmtDays(p.unpaidDays)} unpaid`}</span></span>
                      <span className="font-semibold tnum">{fmtMoney(p.net)}</span><Icon name="right" size={16} className="text-slate" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </Load>
    </div>
  );
}

/** A4 preview. Used by managers (/payroll/payslips/:id/:month) and by employees (/me/payslips/:month). */
export function PayslipPage() {
  const { user } = useAuth();
  const nav = useNavigate();
  const p = useParams();
  const employeeId = p.employeeId ?? user!.id;
  const month = p.month ?? '';
  const q = useData(() => api.payslip(employeeId, month), [employeeId, month]);
  const pdf = api.payslipPdfUrl(employeeId, month);
  return (
    <div>
      <div className="no-print mb-4 flex flex-wrap items-center gap-3">
        <button onClick={() => nav(-1)} className="inline-flex items-center gap-1 text-[13px] font-medium text-slate hover:text-ink"><Icon name="left" size={14} />Back</button>
        <span className="flex-1" />
        {pdf ? <a className="btn btn-primary" href={pdf}>Download PDF</a> : <Button variant="primary" icon="print" onClick={() => window.print()}>Print or save as PDF</Button>}
      </div>
      <Load q={q} skeleton={<Skeleton className="mx-auto h-[600px] w-full max-w-[794px]" />}>{slip => <PayslipSheet slip={slip} />}</Load>
    </div>
  );
}

// =====================================================================
// Settings (opened from the profile menu)
// =====================================================================
export function Organisation() {
  const q = useData(() => api.settings(), []);
  const toast = useToast();
  const [f, setF] = useState<{ companyName: string; defaultClQuota: number; defaultPlQuota: number } | null>(null);
  const v = f ?? (q.data ? { companyName: q.data.companyName, defaultClQuota: q.data.defaultClQuota, defaultPlQuota: q.data.defaultPlQuota } : null);
  const save = useAction(async () => { await api.updateSettings(v!); await q.reload(); setF(null); toast.show('Settings saved.'); });
  return (
    <div>
      <PageTitle title="Organisation" sub="Company details and the rules the system applies to everyone." />
      <Load q={q} skeleton={<SkeletonRows rows={4} />}>
        {s => v && (
          <div className="grid gap-6 lg:grid-cols-2">
            <section>
              <SectionTitle>Company</SectionTitle>
              <Card className="space-y-4 p-5">
                <label className="block"><span className="mb-1 block text-[13px] font-medium">Company name</span><input className="input" value={v.companyName} onChange={e => setF({ ...v, companyName: e.target.value })} /><span className="mt-1 block text-[13px] text-slate">Printed on payslips.</span></label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block"><span className="mb-1 block text-[13px] font-medium">Default CL per year</span><input type="number" min={0} className="input tnum" value={v.defaultClQuota} onChange={e => setF({ ...v, defaultClQuota: Number(e.target.value) })} /></label>
                  <label className="block"><span className="mb-1 block text-[13px] font-medium">Default PL per year</span><input type="number" min={0} className="input tnum" value={v.defaultPlQuota} onChange={e => setF({ ...v, defaultPlQuota: Number(e.target.value) })} /></label>
                </div>
                {save.error && <p className="text-absent">{save.error}</p>}
                <Button variant="primary" state={save.state} disabled={!f} onClick={() => save.run()}>Save</Button>
              </Card>
            </section>
            <section>
              <SectionTitle>Rules</SectionTitle>
              <Card className="divide-y divide-mist">
                {[
                  ['Office starts', `${fmtTime(s.startTime)}. A first punch after this makes the day a half day.`],
                  ['Full day', `${s.fullDayHours} hours between the first and last punch.`],
                  ['Half day', `${s.halfDayHours} hours or more. Under that the day is absent.`],
                  ['Working week', 'Monday to Saturday. Sundays and the 2nd and 4th Saturday are off.'],
                  ['Leave credit', '1/12 of the yearly quota on the 1st of each month.'],
                  ['Year end', `CL lapses. PL carries over, up to ${s.plCarryMax} days.`],
                  ['Escalation', `A request pending ${s.escalateAfterWorkingDays} working days also goes to the admin.`],
                  ['Month lock', 'Each head locks their office. Missing punches block the lock. Only the admin can unlock.'],
                ].map(([k, t]) => <div key={k} className="flex gap-4 px-4 py-3"><span className="w-32 shrink-0 font-medium">{k}</span><span className="text-slate">{t}</span></div>)}
              </Card>
              <p className="mt-2 text-[13px] text-slate">These rules are fixed in the system. Changing one is a code change, so past months stay consistent.</p>
            </section>
          </div>
        )}
      </Load>
    </div>
  );
}

export function AuditLog() {
  const { scope, label, offices } = useScope();
  const [search, setSearch] = useState('');
  const q = useData(() => api.audit({ scope, search }), [scope, search]);
  return (
    <div>
      <PageTitle title="Audit log" sub={`${label} · Every approval, correction, salary change and lock, with who did it.`} />
      <div className="relative mb-3 max-w-xs"><Icon name="search" size={16} className="absolute left-3 top-3 text-slate" /><input className="input !pl-9" placeholder="Search the log" value={search} onChange={e => setSearch(e.target.value)} /></div>
      <Load q={q} skeleton={<SkeletonRows rows={6} />}>
        {rows => (
          <Card>
            {rows.length === 0 ? <Empty icon="search" title="No entries" text="Nothing in the log matches." /> : (
              <ul className="divide-y divide-mist">
                {rows.map(a => (
                  <li key={a.id} className="flex flex-wrap gap-x-4 gap-y-1 px-4 py-3">
                    <span className="w-36 shrink-0 text-slate tnum">{fmtDateTime(a.at)}</span>
                    <span className="min-w-0 flex-1 basis-64"><span className="font-medium">{a.action}</span><span className="text-slate"> · {a.actorName}{a.officeId ? ` · ${offices.find(o => o.id === a.officeId)?.name ?? ''}` : ''}</span><span className="block text-[13px] text-slate">{a.detail}</span></span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </Load>
    </div>
  );
}
