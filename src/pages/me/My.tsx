// Employee screens: my attendance, correction request, my leave, apply for leave, my payslips, my profile.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { addDays, dow, fmtDate, fmtDateLong, fmtDays, fmtDuration, fmtMoney, fmtMonth, fmtNum, fmtTime, monthOf, parts } from '../../lib/format';
import { dayChip, RequestStatus } from '../../shared';
import type { DayView, LeavePreview, LeaveType, RequestRow } from '../../types';
import { Avatar, Button, Card, cx, Drawer, Empty, errText, Field, Icon, Load, MonthPicker, PageTitle, SectionTitle, Segmented, Skeleton, SkeletonRows, Tag, useAction, useData, useToast } from '../../ui';

const today = () => api.demo.now().slice(0, 10);
const Back = ({ to, label }: { to: string; label: string }) => <Link to={to} className="mb-3 inline-flex items-center gap-1 text-[13px] font-medium text-slate hover:text-ink"><Icon name="left" size={14} />{label}</Link>;

// =====================================================================
const FILL: Partial<Record<DayView['status'], string>> = {
  present: 'bg-present/15 text-ink', working: 'bg-present/15 text-ink', half_late: 'bg-half text-white', half_short: 'bg-half text-white',
  absent: 'bg-absent text-white', missing: 'border-2 border-absent text-absent', leave: 'bg-leave text-white', off: 'text-off', holiday: 'text-off', not_joined: 'text-off',
};
export function MyAttendance() {
  const [month, setMonth] = useState(() => monthOf(today()));
  const q = useData(() => api.myMonth(month), [month], 30000);
  const [pick, setPick] = useState<DayView | null>(null);
  const t = today();
  return (
    <div>
      <PageTitle title="My attendance" actions={<MonthPicker month={month} onChange={setMonth} max={monthOf(t)} min="2026-10" />} />
      <Load q={q} skeleton={<><Skeleton className="mb-4 h-16 w-full !rounded-xl" /><Skeleton className="h-80 w-full !rounded-xl" /></>}>
        {m => {
          const lead = (dow(m.days[0].date) + 6) % 7;
          return (
            <>
              <Card className="mb-4 grid grid-cols-5 divide-x divide-mist text-center">
                {([['Present', m.totals.present, 'bg-present'], ['Half', m.totals.half, 'bg-half'], ['Absent', m.totals.absent, 'bg-absent'], ['Leave', m.totals.leave, 'bg-leave'], ['Missing', m.totals.missing, 'border-2 border-absent']] as const).map(([k, v, c]) => (
                  <div key={k} className="py-3"><div className="font-serif text-xl font-semibold tnum">{fmtNum(v)}</div><div className="mt-0.5 flex items-center justify-center gap-1 text-[11px] text-slate"><span className={cx('h-2 w-2 rounded-full', c)} />{k}</div></div>
                ))}
              </Card>
              {m.locked && <p className="mb-3 flex items-center gap-2 text-[13px] text-slate"><Icon name="lock" size={14} />{fmtMonth(month)} is locked. The figures are final.</p>}
              <Card className="p-3">
                <div className="grid grid-cols-7 pb-1 text-center text-[11px] font-semibold uppercase tracking-wide text-slate">{['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <div key={i}>{d}</div>)}</div>
                <div className="grid grid-cols-7 gap-1">
                  {Array.from({ length: lead }, (_, i) => <div key={`x${i}`} />)}
                  {m.days.map(d => (
                    <button key={d.date} onClick={() => setPick(d)} aria-label={`${fmtDate(d.date)}, ${d.label || 'upcoming'}`}
                      className={cx('relative flex aspect-square items-center justify-center rounded-lg text-[15px] font-medium transition-transform duration-100 active:scale-95 tnum', FILL[d.status] ?? 'text-slate', d.date === t && 'ring-2 ring-ink ring-offset-1')}>
                      {parts(d.date).d}
                      {d.manual && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-brass" />}
                      {m.pendingDates.includes(d.date) && <span className="absolute bottom-1 h-1 w-3 rounded-full bg-ink" />}
                    </button>
                  ))}
                </div>
              </Card>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-slate">
                {([['Present', 'bg-present/30'], ['Half day', 'bg-half'], ['Absent', 'bg-absent'], ['Leave', 'bg-leave'], ['Missing punch', 'border-2 border-absent']] as const).map(([k, c]) => <span key={k} className="inline-flex items-center gap-1.5"><span className={cx('h-3 w-3 rounded', c)} />{k}</span>)}
                <span className="inline-flex items-center gap-1.5"><span className="h-1 w-3 rounded-full bg-ink" />Correction pending</span>
              </div>
              <Drawer open={!!pick} onClose={() => setPick(null)} title={pick ? fmtDateLong(pick.date) : ''}>
                {pick && (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2">{dayChip(pick)}{pick.manual && <Tag tone="brass">Manual</Tag>}{pick.unpaid > 0 && pick.status !== 'not_joined' && <span className="text-[13px] text-slate">{fmtDays(pick.unpaid)} unpaid</span>}</div>
                    {!['off', 'holiday', 'future', 'not_joined'].includes(pick.status) && !(pick.status === 'leave' && !pick.halfLeave) && (
                      <div className="grid grid-cols-3 gap-3">
                        {[['In', fmtTime(pick.inTime)], ['Out', fmtTime(pick.outTime)], ['Hours', pick.workedMin ? fmtDuration(pick.workedMin) : 'None']].map(([k, v]) => (
                          <div key={k} className="rounded-lg border border-mist p-3"><div className="text-[13px] text-slate">{k}</div><div className="mt-0.5 font-serif text-lg font-semibold tnum">{v}</div></div>
                        ))}
                      </div>
                    )}
                    {pick.status === 'half_late' && <p className="text-slate">The first punch was after 9:00 AM, so the day counts as a half day.</p>}
                    {pick.status === 'half_short' && <p className="text-slate">A full day needs 9 hours between the first and last punch.</p>}
                    {pick.status === 'missing' && <p className="text-slate">Only one punch was recorded. Ask for a correction so the day can be counted.</p>}
                    {m.pendingDates.includes(pick.date)
                      ? <p className="rounded-lg border border-mist bg-ivory px-3 py-2 text-[13px]">Your correction request for this day is waiting for a decision.</p>
                      : pick.date <= t && !m.locked && ['missing', 'absent', 'half_late', 'half_short', 'not_in', 'working'].includes(pick.status) && (
                        <Link to={`/me/correction/${pick.date}`} className="btn btn-secondary">Ask for a correction</Link>
                      )}
                  </div>
                )}
              </Drawer>
            </>
          );
        }}
      </Load>
    </div>
  );
}

/** A correction never edits a punch. It asks the office head to add a manual in or out time. */
export function Correction() {
  const { date = '' } = useParams();
  const { user } = useAuth();
  const q = useData(() => api.day(user!.id, date), [date]);
  const [f, setF] = useState<{ inTime: string; outTime: string; reason: string } | null>(null);
  const [sent, setSent] = useState(false);
  useEffect(() => { if (q.data && !f) setF({ inTime: q.data.day.inTime ?? '', outTime: q.data.day.outTime ?? '', reason: '' }); }, [q.data, f]);
  const act = useAction(async () => { await api.requestCorrection({ date, inTime: f!.inTime || null, outTime: f!.outTime || null, reason: f!.reason }); setSent(true); });
  if (sent) {
    return (
      <Card className="anim-fade-up p-8 text-center">
        <span className="anim-pop mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-present text-white"><Icon name="check" size={28} /></span>
        <h1 className="mt-4 font-serif text-2xl font-semibold">Request sent</h1>
        <p className="mt-1 text-slate">{user!.role === 'head' ? 'The admin' : 'Your office head'} will decide it. You will get a notification and an email.</p>
        <Link to="/me/attendance" className="btn btn-primary mt-5">Back to my attendance</Link>
      </Card>
    );
  }
  return (
    <div>
      <Back to="/me/attendance" label="My attendance" />
      <PageTitle title="Ask for a correction" sub={date && fmtDateLong(date)} />
      <Load q={q} skeleton={<SkeletonRows rows={3} />}>
        {d => f && (
          <form className="space-y-4" onSubmit={e => { e.preventDefault(); act.run(); }}>
            <Card className="p-4">
              <div className="flex flex-wrap items-center gap-2">{dayChip(d.day)}</div>
              <p className="mt-2 text-[13px] text-slate">The terminal recorded: {d.punches.length ? d.punches.map(p => fmtTime(p.time)).join(', ') : 'no punches'}.</p>
            </Card>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Time you came in"><input type="time" className="input" value={f.inTime} onChange={e => setF({ ...f, inTime: e.target.value })} /></Field>
              <Field label="Time you left"><input type="time" className="input" value={f.outTime} onChange={e => setF({ ...f, outTime: e.target.value })} /></Field>
            </div>
            <Field label="What happened" error={act.error} hint="One line is enough. Your office head sees this.">
              <textarea rows={3} className={cx('input', act.error && 'invalid')} value={f.reason} onChange={e => setF({ ...f, reason: e.target.value })} />
            </Field>
            {d.lockedNote && <p className="text-[13px] text-absent">{d.lockedNote}</p>}
            <Button variant="primary" type="submit" state={act.state} disabled={!!d.lockedNote} className="w-full">Send request</Button>
          </form>
        )}
      </Load>
    </div>
  );
}

// =====================================================================
export function MyLeave() {
  const toast = useToast();
  const bal = useData(() => api.myBalances(), []);
  const q = useData(() => api.myRequests(), []);
  const reload = () => { q.reload(); bal.reload(); };
  const cancel = async (r: RequestRow) => {
    try { await api.cancelRequest(r.id); reload(); toast.show('Request cancelled.', { undo: async () => { await api.undoCancel(r.id); reload(); } }); }
    catch (e) { toast.show(errText(e)); }
  };
  return (
    <div>
      <PageTitle title="My leave" actions={<Link to="/me/leave/apply" className="btn btn-primary"><Icon name="plus" size={16} />Apply for leave</Link>} />
      <Load q={bal} skeleton={<Skeleton className="mb-5 h-24 w-full !rounded-xl" />}>
        {b => (
          <Card className="mb-2 grid grid-cols-2 divide-x divide-mist">
            {([['Casual leave (CL)', b.cl], ['Privilege leave (PL)', b.pl]] as const).map(([k, x]) => (
              <div key={k} className="p-4"><div className="text-[13px] text-slate">{k}</div><div className="font-serif text-[30px] font-semibold leading-tight tnum">{fmtNum(x.balance)}</div><div className="text-[13px] text-slate">{x.pending > 0 ? `${fmtNum(x.pending)} waiting for approval` : `${x.quota} per year`}</div></div>
            ))}
          </Card>
        )}
      </Load>
      <p className="mb-5 text-[13px] text-slate">1/12 of your yearly leave is added on the 1st of each month. At year end CL lapses and PL carries over, up to 30 days.</p>
      <SectionTitle>Requests</SectionTitle>
      <Load q={q} skeleton={<SkeletonRows rows={3} />}>
        {rows => {
          const list = rows.filter(r => r.kind === 'leave');
          return (
            <Card>
              {list.length === 0 ? <Empty icon="calendar" title="No leave yet" text="Your leave requests and their status show up here." action={<Link to="/me/leave/apply" className="btn btn-secondary">Apply for leave</Link>} /> : (
                <ul className="divide-y divide-mist">
                  {list.map(r => (
                    <li key={r.id} className={cx('px-4 py-3', r.status === 'cancelled' && 'opacity-60')}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 basis-40 font-medium">{r.title}</span><span className="text-slate">{r.detail}</span><RequestStatus r={r} />
                      </div>
                      <div className="mt-0.5 text-[13px] text-slate">“{r.reason}”</div>
                      {r.status !== 'pending' && r.decidedByName && <div className="mt-0.5 text-[13px] text-slate">{r.status === 'approved' ? 'Approved' : 'Rejected'} by {r.decidedByName}{r.comment && `: ${r.comment}`}</div>}
                      {r.status === 'pending' && <Button size="sm" variant="ghost" className="-ml-3 mt-1" onClick={() => cancel(r)}>Cancel request</Button>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        }}
      </Load>
    </div>
  );
}

/** The balance updates as the dates change, and turns red before the request can be sent if it is short. */
export function ApplyLeave() {
  const { user } = useAuth();
  const nav = useNavigate();
  const start = addDays(today(), 1);
  const [f, setF] = useState<{ type: LeaveType; from: string; to: string; half: boolean; reason: string }>({ type: 'CL', from: start, to: start, half: false, reason: '' });
  const [pv, setPv] = useState<LeavePreview | null>(null);
  const [sent, setSent] = useState<RequestRow | null>(null);
  useEffect(() => { let live = true; api.leavePreview(f).then(p => { if (live) setPv(p); }).catch(() => {}); return () => { live = false; }; }, [f.type, f.from, f.to, f.half]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = useAction(async () => { setSent(await api.applyLeave(f)); });
  const set = (p: Partial<typeof f>) => setF(prev => { const n = { ...prev, ...p }; if (n.to < n.from) n.to = n.from; if (n.from !== n.to) n.half = false; return n; });
  if (sent) {
    return (
      <Card className="anim-fade-up p-8 text-center">
        <span className="anim-pop mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-present text-white"><Icon name="check" size={28} /></span>
        <h1 className="mt-4 font-serif text-2xl font-semibold">Request sent</h1>
        <p className="mt-1 text-slate">{sent.title}, {sent.detail.toLowerCase()}. {user!.role === 'head' ? 'The admin' : 'Your office head'} will decide it. You will get a notification and an email.</p>
        <div className="mt-5 flex justify-center gap-2"><Button variant="primary" onClick={() => nav('/me/leave')}>See my leave</Button><Button onClick={() => nav('/me')}>Home</Button></div>
      </Card>
    );
  }
  const short = !!pv && pv.balanceAfter !== null && pv.balanceAfter < 0;
  return (
    <div>
      <Back to="/me/leave" label="My leave" />
      <PageTitle title="Apply for leave" />
      <form className="space-y-4" onSubmit={e => { e.preventDefault(); act.run(); }}>
        <Field label="Type"><Segmented value={f.type} onChange={type => set({ type })} options={[{ value: 'CL', label: 'Casual (CL)' }, { value: 'PL', label: 'Privilege (PL)' }, { value: 'UNPAID', label: 'Unpaid' }]} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="First day"><input type="date" className="input" value={f.from} onChange={e => set({ from: e.target.value, to: e.target.value > f.to ? e.target.value : f.to })} /></Field>
          <Field label="Last day"><input type="date" className="input" min={f.from} value={f.to} onChange={e => set({ to: e.target.value })} /></Field>
        </div>
        <label className={cx('flex items-center gap-2', f.from !== f.to && 'opacity-50')}>
          <input type="checkbox" className="h-4 w-4 accent-[var(--color-ink)]" disabled={f.from !== f.to} checked={f.half} onChange={e => set({ half: e.target.checked })} />Half day only<span className="text-[13px] text-slate">(for a single date)</span>
        </label>
        <Card className={cx('p-4 transition-colors duration-200', pv && !pv.ok && 'border-absent/60')}>
          <div className="flex items-end justify-between gap-4">
            <div><div className="text-[13px] text-slate">Working days</div><div className="font-serif text-[30px] font-semibold leading-tight tnum">{pv ? fmtNum(pv.days) : ' '}</div></div>
            {f.type !== 'UNPAID' && pv && pv.balanceAfter !== null && (
              <div className="text-right"><div className="text-[13px] text-slate">{f.type} left after this</div><div className={cx('font-serif text-[30px] font-semibold leading-tight tnum transition-colors duration-200', short && 'text-absent')}>{fmtNum(pv.balanceAfter)}</div></div>
            )}
            {f.type === 'UNPAID' && pv && <div className="text-right text-[13px] text-slate">Unpaid leave reduces salary<br />by one day rate per day.</div>}
          </div>
          <p className={cx('mt-2 text-[13px]', pv && !pv.ok ? 'text-absent' : 'text-slate')}>{pv?.message ?? 'Sundays, the 2nd and 4th Saturday and holidays are not counted.'}</p>
        </Card>
        <Field label="Reason" error={act.error}><textarea rows={3} className={cx('input', act.error && 'invalid')} value={f.reason} onChange={e => setF({ ...f, reason: e.target.value })} placeholder="A short note for your office head" /></Field>
        <Button variant="primary" type="submit" state={act.state} disabled={!pv?.ok} className="w-full">Send request</Button>
      </form>
    </div>
  );
}

// =====================================================================
export function MyPayslips() {
  const q = useData(() => api.myPayslips(), []);
  return (
    <div>
      <PageTitle title="My payslips" />
      <Load q={q} skeleton={<SkeletonRows rows={3} />}>
        {rows => (
          <Card>
            {rows.length === 0 ? <Empty icon="wallet" title="No payslips yet" text="Your first payslip appears here after your office head locks the month." /> : (
              <ul className="divide-y divide-mist">
                {rows.map(p => (
                  <li key={p.month}>
                    <Link to={`/me/payslips/${p.month}`} className="flex items-center gap-3 px-4 py-4 transition-colors hover:bg-ivory">
                      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-mist"><Icon name="file" /></span>
                      <span className="min-w-0 flex-1"><span className="block font-medium">{fmtMonth(p.month)}</span><span className="block text-[13px] text-slate">{p.unpaidDays > 0 ? `${fmtDays(p.unpaidDays)} unpaid` : 'Full salary'}</span></span>
                      <span className="font-serif text-lg font-semibold tnum">{fmtMoney(p.net)}</span><Icon name="right" size={16} className="text-slate" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </Load>
      <p className="mt-3 text-[13px] text-slate">The payslip for a month is released when the month is locked, usually in the first days of the next month.</p>
    </div>
  );
}

// =====================================================================
export function MyProfile() {
  const { user, signOut } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const q = useData(() => api.employee(user!.id), [user!.id]);
  const [pw, setPw] = useState({ current: '', next: '' });
  const act = useAction(async () => { await api.changePassword(pw.current, pw.next); setPw({ current: '', next: '' }); toast.show('Password changed.'); });
  return (
    <div>
      <PageTitle title="My profile" />
      <Load q={q} skeleton={<SkeletonRows rows={4} />}>
        {d => (
          <div className="space-y-5">
            <Card className="flex items-center gap-4 p-5">
              <Avatar name={d.employee.name} size={52} />
              <div><div className="font-serif text-xl font-semibold">{d.employee.name}</div><div className="text-slate">{d.employee.id} · {d.employee.designation}</div></div>
            </Card>
            <Card className="divide-y divide-mist">
              {[['Office', d.employee.officeName], ['Email', d.employee.email], ['Phone', d.employee.phone || 'Not added'], ['Joined', `${fmtDate(d.employee.joinDate)} ${d.employee.joinDate.slice(0, 4)}`], ['Terminal user ID', d.employee.terminalUserId],
                ['Monthly salary', d.employee.salary !== null ? fmtMoney(d.employee.salary) : ''], ['Leave per year', `CL ${d.employee.clQuota}, PL ${d.employee.plQuota}`]].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 px-4 py-3"><span className="text-slate">{k}</span><span className="text-right font-medium">{v}</span></div>
              ))}
            </Card>
            <p className="text-[13px] text-slate">Something wrong here? Ask your office head to correct it.</p>
            <section>
              <SectionTitle>Change password</SectionTitle>
              <form className="card space-y-3 p-4" onSubmit={e => { e.preventDefault(); act.run(); }}>
                <Field label="Current password"><input type="password" autoComplete="current-password" className="input" value={pw.current} onChange={e => setPw({ ...pw, current: e.target.value })} /></Field>
                <Field label="New password" error={act.error} hint="At least 8 characters."><input type="password" autoComplete="new-password" className={cx('input', act.error && 'invalid')} value={pw.next} onChange={e => setPw({ ...pw, next: e.target.value })} /></Field>
                <Button type="submit" state={act.state}>Change password</Button>
              </form>
            </section>
            <Button variant="ghost" icon="logout" onClick={async () => { await signOut(); nav('/login'); }}>Sign out</Button>
          </div>
        )}
      </Load>
    </div>
  );
}
