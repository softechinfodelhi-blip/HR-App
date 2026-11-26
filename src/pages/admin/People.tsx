// People: the employee list with "Add employee", one employee's profile, and offices with their heads.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api';
import { useEmployee, useEmployees, useLedger, useOffices, useSettings } from '../../api/hooks';
import { useAuth } from '../../auth';
import { addMonths, fmtDate, fmtDateTime, fmtDay, fmtMoney, fmtMonth, fmtNum, fmtTime, monthOf, todayYmd } from '../../lib/format';
import { RequestStatus, useScope } from '../../shared';
import type { EmployeeDetail, EmployeeRow, NewEmployeeInput, OfficeSummary } from '../../types';
import { Avatar, Banner, Button, Card, cx, Drawer, Empty, errText, Field, Icon, Load, PageTitle, SectionTitle, Segmented, Skeleton, SkeletonRows, Tag, useAction, useToast } from '../../ui';

const today = todayYmd;
function StatusTag({ e }: { e: EmployeeRow }) {
  if (e.status === 'invited') return <Tag tone="brass">Invite sent</Tag>;
  if (e.status === 'inactive') return <Tag>Switched off</Tag>;
  return <span className="inline-flex items-center gap-1.5 text-[13px]"><span className="h-2 w-2 rounded-full bg-present" />Active</span>;
}

// =====================================================================
export function People() {
  const { user } = useAuth();
  const { scope, offices, label } = useScope();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'invited' | 'inactive'>('all');
  const q = useEmployees(scope, search, status);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<{ row: EmployeeRow; token: string | null } | null>(null);

  return (
    <div>
      <PageTitle title="Employees" sub={label} actions={<Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Add employee</Button>} />
      {added && (
        <Banner tone="present" icon="check" action={<button aria-label="Dismiss" onClick={() => setAdded(null)}><Icon name="x" size={16} /></button>}>
          <span className="font-semibold">{added.row.name} is added as {added.row.code}.</span> An invite to set a password went to {added.row.email}. The link is valid for 72 hours.{' '}
          {added.token && <Link to={`/invite/${added.token}`} className="border-b border-dashed border-ink font-medium">Development only: open the invite link as {added.row.name.split(' ')[0]}</Link>}
        </Banner>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 basis-56 sm:max-w-xs">
          <Icon name="search" size={16} className="absolute left-3 top-3 text-slate" />
          <input className="input !pl-9" placeholder="Name, ID or designation" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <Segmented value={status} onChange={setStatus} options={[{ value: 'all', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'invited', label: 'Invited' }, { value: 'inactive', label: 'Off' }]} />
        <span className="ml-auto text-slate tnum">{q.data ? `${q.data.length} ${q.data.length === 1 ? 'person' : 'people'}` : ''}</span>
      </div>
      <Load q={q} skeleton={<SkeletonRows rows={8} />}>
        {rows => rows.length === 0 ? (
          <Card><Empty icon="search" title="No one matches" text="Clear the search or change the status filter." action={<Button onClick={() => { setSearch(''); setStatus('all'); }}>Clear filters</Button>} /></Card>
        ) : (
          <Card className="overflow-hidden">
            <table className="w-full text-left">
              <thead className="border-b border-mist text-[12px] uppercase tracking-wide text-slate">
                <tr><th className="px-4 py-3 font-semibold">Employee</th>{scope === 'all' && <th className="hidden px-4 py-3 font-semibold md:table-cell">Office</th>}<th className="hidden px-4 py-3 font-semibold md:table-cell">Designation</th><th className="hidden px-4 py-3 font-semibold lg:table-cell">Joined</th><th className="hidden px-4 py-3 text-right font-semibold sm:table-cell">Monthly salary</th><th className="px-4 py-3 font-semibold">Status</th></tr>
              </thead>
              <tbody className="divide-y divide-mist">
                {rows.map(e => (
                  <tr key={e.id} className={cx('group transition-colors hover:bg-ivory', added?.row.id === e.id && 'anim-row-in')}>
                    <td className="px-4 py-3">
                      <Link to={`/people/${e.id}`} className="flex items-center gap-3">
                        <Avatar name={e.name} />
                        <span className="min-w-0"><span className="flex items-center gap-2 font-medium group-hover:underline">{e.name}{e.isHead && <Tag>Office head</Tag>}</span><span className="block text-[13px] text-slate">{e.code}</span></span>
                      </Link>
                    </td>
                    {scope === 'all' && <td className="hidden px-4 py-3 md:table-cell">{e.officeName}</td>}
                    <td className="hidden px-4 py-3 md:table-cell">{e.designation}</td>
                    <td className="hidden px-4 py-3 text-slate lg:table-cell">{fmtDay(e.joinDate)} {e.joinDate.slice(0, 4)}</td>
                    <td className="hidden px-4 py-3 text-right tnum sm:table-cell">{e.salary !== null ? fmtMoney(e.salary) : ''}</td>
                    <td className="px-4 py-3"><StatusTag e={e} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </Load>
      <AddEmployee open={adding} onClose={() => setAdding(false)} offices={offices} fixedOffice={user!.role === 'head' ? user!.officeId! : scope !== 'all' ? scope : null}
        onAdded={(row, token) => {
          setAdding(false); setAdded({ row, token }); setSearch(''); setStatus('all'); q.reload();
          toast.show(`${row.name} added. Invite sent.`, { undo: async () => { try { await api.undoCreateEmployee(row.id); setAdded(null); } catch (e) { toast.show(errText(e)); } q.reload(); } });
        }} />
    </div>
  );
}

/** Five fields to type. Everything else is prefilled with the usual values. */
function AddEmployee({ open, onClose, offices, fixedOffice, onAdded }: { open: boolean; onClose: () => void; offices: OfficeSummary[]; fixedOffice: string | null; onAdded: (row: EmployeeRow, token: string | null) => void }) {
  const { user } = useAuth();
  const settings = useSettings();
  const blank = (): NewEmployeeInput => ({
    name: '', email: '', phone: '', officeId: fixedOffice ?? offices[0]?.id ?? '', designation: '', joinDate: today(), salary: 0, effectiveMonth: monthOf(today()),
    clQuota: settings.data?.defaultClQuota ?? 12, plQuota: settings.data?.defaultPlQuota ?? 18,
  });
  const [f, setF] = useState<NewEmployeeInput>(blank);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) { setWasOpen(open); if (open) { setF(blank()); setTouched({}); } }
  const set = <K extends keyof NewEmployeeInput>(k: K, v: NewEmployeeInput[K]) => setF(p => ({ ...p, [k]: v }));
  const blur = (k: string) => () => setTouched(t => ({ ...t, [k]: true }));
  const errs = {
    name: !f.name.trim() ? 'Enter the full name.' : '',
    email: !/^\S+@\S+\.\S+$/.test(f.email) ? 'Enter a valid email address.' : '',
    salary: !(f.salary > 0) ? 'Enter the monthly salary.' : '',
  };
  // The admin adds office heads: offered when the chosen office has no head yet.
  const noHead = user!.role === 'admin' && !!offices.find(o => o.id === f.officeId) && !offices.find(o => o.id === f.officeId)!.headId;
  const act = useAction(async () => { const r = await api.createEmployee({ ...f, role: noHead && f.role === 'head' ? 'head' : undefined, effectiveMonth: monthOf(f.joinDate) }); onAdded(r.employee, r.inviteToken); });
  const submit = () => { setTouched({ name: true, email: true, salary: true }); if (!errs.name && !errs.email && !errs.salary) act.run(); };
  const show = (k: keyof typeof errs) => (touched[k] ? errs[k] : '');
  return (
    <Drawer open={open} onClose={onClose} title="Add employee" sub="They get an email to set their own password."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" state={act.state} onClick={submit}>Add and send invite</Button></>}>
      <form className="space-y-4" onSubmit={e => { e.preventDefault(); submit(); }}>
        <Field label="Full name" error={show('name')}><input autoFocus className={cx('input', show('name') && 'invalid')} value={f.name} onChange={e => set('name', e.target.value)} onBlur={blur('name')} /></Field>
        <Field label="Work email" error={show('email')}><input type="email" className={cx('input', show('email') && 'invalid')} value={f.email} onChange={e => set('email', e.target.value)} onBlur={blur('email')} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone"><input className="input" value={f.phone} onChange={e => set('phone', e.target.value)} placeholder="+91" /></Field>
          <Field label="Designation"><input className="input" value={f.designation} onChange={e => set('designation', e.target.value)} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Office" hint={user!.role === 'head' ? 'You add people to your own office.' : undefined}>
            <select className="input" value={f.officeId} disabled={user!.role === 'head'} onChange={e => set('officeId', e.target.value)}>{offices.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          </Field>
          <Field label="Joining date"><input type="date" className="input" value={f.joinDate} onChange={e => set('joinDate', e.target.value)} /></Field>
        </div>
        <Field label="Monthly salary (₹)" error={show('salary')} hint={f.salary > 0 ? `${fmtMoney(f.salary)} per month from ${fmtMonth(monthOf(f.joinDate))}. The first month is paid from the joining date.` : 'One amount per month. No other components.'}>
          <input inputMode="numeric" className={cx('input tnum', show('salary') && 'invalid')} value={f.salary || ''} onChange={e => set('salary', Number(e.target.value.replace(/\D/g, '')))} onBlur={blur('salary')} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="CL per year"><input type="number" min={0} className="input tnum" value={f.clQuota} onChange={e => set('clQuota', Number(e.target.value))} /></Field>
          <Field label="PL per year"><input type="number" min={0} className="input tnum" value={f.plQuota} onChange={e => set('plQuota', Number(e.target.value))} /></Field>
        </div>
        {noHead && (
          <label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-[var(--color-ink)]" checked={f.role === 'head'} onChange={e => set('role', e.target.checked ? 'head' : undefined)} />Make this person the office head<span className="text-[13px] text-slate">(this office has none yet)</span></label>
        )}
        <p className="text-[13px] text-slate">Leave is credited 1/12 on the 1st of each month. The employee ID and terminal user ID are assigned for you.</p>
        {act.error && <p className="anim-fade-up text-absent" role="alert">{act.error}</p>}
        <button type="submit" className="hidden" />
      </form>
    </Drawer>
  );
}

// =====================================================================
export function Profile() {
  const { id = '' } = useParams();
  const q = useEmployee(id);
  return (
    <div>
      <Link to="/people" className="mb-3 inline-flex items-center gap-1 text-[13px] font-medium text-slate hover:text-ink"><Icon name="left" size={14} />Employees</Link>
      <Load q={q} skeleton={<div className="space-y-4"><Skeleton className="h-24 w-full !rounded-xl" /><Skeleton className="h-48 w-full !rounded-xl" /></div>}>
        {d => <ProfileBody d={d} reload={q.reload} />}
      </Load>
    </div>
  );
}
function ProfileBody({ d, reload }: { d: EmployeeDetail; reload: () => Promise<void> }) {
  const e = d.employee;
  const { user } = useAuth();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [salaryOpen, setSalaryOpen] = useState(false);
  const [token, setToken] = useState(d.inviteToken);
  const [adjusting, setAdjusting] = useState(false);
  const resend = useAction(async () => { const r = await api.resendInvite(e.id); setToken(r.inviteToken); toast.show('A new invite link was sent.'); });
  const toggle = useAction(async () => {
    const next = e.status === 'inactive' ? 'active' : 'inactive';
    await api.setEmployeeStatus(e.id, next); await reload();
    toast.show(next === 'inactive' ? `${e.name} can no longer sign in.` : `${e.name} can sign in again.`, { undo: async () => { await api.setEmployeeStatus(e.id, next === 'inactive' ? 'active' : 'inactive'); reload(); } });
  });
  const own = user!.id === e.id;
  return (
    <div className="space-y-6">
      <Card className="flex flex-wrap items-center gap-4 p-5">
        <Avatar name={e.name} size={56} />
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex flex-wrap items-center gap-2"><h1 className="font-serif text-[26px] font-semibold leading-tight">{e.name}</h1>{e.isHead && <Tag>Office head</Tag>}<StatusTag e={e} /></div>
          <div className="mt-0.5 text-slate">{e.code} · {e.designation} · {e.officeName}</div>
        </div>
        {d.canEdit && <Button onClick={() => setEditing(true)}>Edit details</Button>}
      </Card>
      {own && <Banner tone="leave" icon="lock">This is your own record. Only the admin can change it or decide your requests.</Banner>}
      {e.status === 'invited' && d.canEdit && (
        <Banner icon="file" action={<Button size="sm" state={resend.state} onClick={() => resend.run()}>Send a new invite</Button>}>
          {e.name.split(' ')[0]} has not set a password yet.{token && <> <Link to={`/invite/${token}`} className="border-b border-dashed border-ink font-medium">Development only: open the invite link</Link></>}
        </Banner>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section>
          <SectionTitle>Details</SectionTitle>
          <Card className="divide-y divide-mist">
            {[['Email', e.email], ['Phone', e.phone || 'Not added'], ['Joined', fmtDate(e.joinDate) + ' ' + e.joinDate.slice(0, 4)], ...(e.lastWorkingDate ? [['Last working date', fmtDate(e.lastWorkingDate) + ' ' + e.lastWorkingDate.slice(0, 4)]] : []), ['Terminal user ID', e.terminalUserId || 'Not set'], ['Leave per year', `CL ${e.clQuota}, PL ${e.plQuota}`]].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4 px-4 py-3"><span className="text-slate">{k}</span><span className="text-right font-medium">{v}</span></div>
            ))}
          </Card>
        </section>

        <section>
          <SectionTitle right={<Link to="/attendance" className="text-[13px] font-medium text-slate hover:text-ink">Open register</Link>}>{fmtMonth(d.month.month)} so far</SectionTitle>
          <Card className="p-4">
            <div className="grid grid-cols-5 gap-2 text-center">
              {[['Present', d.month.present, 'bg-present'], ['Half', d.month.half, 'bg-half'], ['Absent', d.month.absent, 'bg-absent'], ['Leave', d.month.leave, 'bg-leave'], ['Missing', d.month.missing, 'border-2 border-absent']].map(([k, v, c]) => (
                <div key={k as string}><div className="font-serif text-2xl font-semibold tnum">{fmtNum(v as number)}</div><div className="mt-0.5 flex items-center justify-center gap-1.5 text-[12px] text-slate"><span className={cx('h-2 w-2 rounded-full', c as string)} />{k}</div></div>
              ))}
            </div>
            <div className="mt-4 flex items-center gap-2 border-t border-mist pt-3 text-[13px]"><Icon name="flame" size={15} className="text-brass" />{d.streak.current} days on time in a row. Best so far {d.streak.best}.</div>
          </Card>
        </section>

        <section>
          <SectionTitle right={<Button size="sm" onClick={() => setAdjusting(true)}>{d.canEdit ? 'Adjust or see entries' : 'See entries'}</Button>}>Leave balance</SectionTitle>
          <Card className="grid grid-cols-2 divide-x divide-mist">
            {([['CL', d.balances.cl], ['PL', d.balances.pl]] as const).map(([k, b]) => (
              <div key={k} className="p-4"><div className="text-slate">{k}</div><div className="font-serif text-[28px] font-semibold tnum">{fmtNum(b.balance)}</div><div className="text-[13px] text-slate">{b.pending > 0 ? `${fmtNum(b.pending)} pending approval · ` : ''}{b.quota} per year</div></div>
            ))}
          </Card>
        </section>

        {d.canSeeSalary && (
          <section>
            <SectionTitle right={d.canEdit && <Button size="sm" onClick={() => setSalaryOpen(o => !o)}>{salaryOpen ? 'Close' : 'Change salary'}</Button>}>Salary</SectionTitle>
            <Card>
              {salaryOpen && <SalaryForm id={e.id} current={e.salary ?? 0} onDone={() => { setSalaryOpen(false); reload(); }} />}
              <ul className="divide-y divide-mist">
                {d.salaryHistory.map((s, i) => (
                  <li key={s.id} className="flex items-center justify-between gap-4 px-4 py-3">
                    <span><span className="font-medium">From {fmtMonth(s.effectiveMonth)}</span>{i === 0 && s.effectiveMonth <= d.month.month && <span className="ml-2"><Tag tone="present">Current</Tag></span>}{s.effectiveMonth > d.month.month && <span className="ml-2"><Tag tone="brass">Upcoming</Tag></span>}<span className="block text-[13px] text-slate">Set by {s.setByName}, {fmtDateTime(s.setAt)}</span></span>
                    <span className="font-serif text-lg font-semibold tnum">{fmtMoney(s.amount)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        )}
      </div>

      <section>
        <SectionTitle>Recent requests</SectionTitle>
        <Card>
          {d.recent.length === 0 ? <Empty icon="calendar" title="No requests yet" /> : (
            <ul className="divide-y divide-mist">{d.recent.map(r => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3"><span className="min-w-0 flex-1"><span className="font-medium">{r.title}</span>{r.detail && <span className="text-slate"> · {r.detail}</span>}<span className="block text-[13px] text-slate">“{r.reason}”{r.comment && ` · ${r.comment}`}</span></span><RequestStatus r={r} /></li>
            ))}</ul>
          )}
        </Card>
      </section>

      {d.canEdit && e.status !== 'invited' && (
        <section>
          <SectionTitle>Account</SectionTitle>
          <Card className="flex flex-wrap items-center gap-4 p-4">
            <p className="min-w-0 flex-1 basis-64 text-slate">{e.status === 'inactive' ? 'This account is switched off. Past attendance and payslips are kept.' : 'When someone leaves, switch the account off. Past attendance and payslips are kept.'}</p>
            <Button variant={e.status === 'inactive' ? 'secondary' : 'danger'} state={toggle.state} onClick={() => toggle.run()}>{e.status === 'inactive' ? 'Switch account on' : 'Switch account off'}</Button>
            {toggle.error && <p className="basis-full text-absent">{toggle.error}</p>}
          </Card>
        </section>
      )}
      <EditDetails open={editing} onClose={() => setEditing(false)} e={e} onSaved={() => { setEditing(false); reload(); toast.show('Details saved.'); }} />
      <LeaveLedger open={adjusting} onClose={() => setAdjusting(false)} d={d} />
    </div>
  );
}
const LEDGER_LABEL: Record<string, string> = { credit: 'Monthly credit', leave: 'Leave taken', reversal: 'Leave given back', adjustment: 'Adjustment', opening: 'Opening balance', lapse: 'Year end: CL lapsed', carry_cap: 'Year end: PL over the cap' };
/** Every entry behind a leave balance. A manager can add an adjustment, with a reason. */
function LeaveLedger({ open, onClose, d }: { open: boolean; onClose: () => void; d: EmployeeDetail }) {
  const e = d.employee;
  const toast = useToast();
  const q = useLedger(e.id, open);
  const [f, setF] = useState({ type: 'CL' as 'CL' | 'PL', days: '', note: '' });
  const act = useAction(async () => {
    await api.adjustBalance(e.id, { type: f.type, days: Number(f.days), note: f.note });
    toast.show(`${f.type} balance changed by ${Number(f.days) > 0 ? '+' : ''}${Number(f.days)}.`); setF({ type: f.type, days: '', note: '' });
  });
  return (
    <Drawer open={open} onClose={onClose} title="Leave balance" sub={`${e.name} · ${e.code}`} wide>
      <div className="space-y-5">
        {d.canEdit && (
          <form className="space-y-3 rounded-lg border border-mist p-3" onSubmit={ev => { ev.preventDefault(); act.run(); }}>
            <div className="font-semibold">Adjust the balance</div>
            <div className="grid grid-cols-[auto_1fr] items-end gap-3">
              <Segmented value={f.type} onChange={type => setF({ ...f, type })} options={[{ value: 'CL', label: 'CL' }, { value: 'PL', label: 'PL' }]} />
              <Field label="Days to add (or a minus to take away)"><input inputMode="decimal" className="input tnum" placeholder="2 or -1.5" value={f.days} onChange={ev => setF({ ...f, days: ev.target.value.replace(/[^0-9.+-]/g, '') })} /></Field>
            </div>
            <Field label="Reason" error={act.error} hint="Kept in the audit log and shown to the employee."><input className={cx('input', act.error && 'invalid')} value={f.note} onChange={ev => setF({ ...f, note: ev.target.value })} /></Field>
            <Button variant="primary" type="submit" state={act.state} disabled={!f.days || !Number(f.days)}>Save adjustment</Button>
          </form>
        )}
        <Load q={q} skeleton={<SkeletonRows rows={5} />}>
          {l => (
            <div>
              <div className="mb-2 flex items-baseline justify-between gap-3"><span className="font-semibold">Entries</span><span className="text-[13px] text-slate tnum">CL {fmtNum(l.balances.cl.balance)} · PL {fmtNum(l.balances.pl.balance)}</span></div>
              {l.items.length === 0 ? <Empty icon="calendar" title="No entries yet" text="The first credit is written on the 1st of the first full month after joining." /> : (
                <ul className="divide-y divide-mist rounded-lg border border-mist">
                  {l.items.map(x => (
                    <li key={x.id} className="flex items-start gap-3 px-3 py-2">
                      <span className="min-w-0 flex-1"><span className="block font-medium">{LEDGER_LABEL[x.reason] ?? x.reason}{x.reason === 'adjustment' && x.ref ? `: ${x.ref}` : x.reason === 'credit' && x.ref ? ` · ${fmtMonth(x.ref)}` : ''}</span><span className="block text-[13px] text-slate">{fmtDate(x.date)} {x.date.slice(0, 4)} · {x.byName}</span></span>
                      <Tag>{x.type}</Tag><span className={cx('w-12 text-right font-semibold tnum', x.days < 0 && 'text-absent')}>{x.days > 0 ? '+' : ''}{fmtNum(x.days)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {l.total > l.items.length && <p className="mt-2 text-[13px] text-slate">Showing the latest {l.items.length} of {l.total} entries.</p>}
              <p className="mt-2 text-[13px] text-slate">The balance is the sum of these entries. Nothing else changes it.</p>
            </div>
          )}
        </Load>
      </div>
    </Drawer>
  );
}
function SalaryForm({ id, current, onDone }: { id: string; current: number; onDone: () => void }) {
  const toast = useToast();
  const thisMonth = monthOf(today());
  const [amount, setAmount] = useState(current);
  const [month, setMonth] = useState(addMonths(thisMonth, 1));
  const act = useAction(async () => { await api.setSalary(id, amount, month); toast.show(`Salary set to ${fmtMoney(amount)} from ${fmtMonth(month)}.`); onDone(); });
  return (
    <form className="anim-fade-up grid gap-3 border-b border-mist bg-ivory p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={e => { e.preventDefault(); act.run(); }}>
      <Field label="New monthly salary (₹)"><input autoFocus inputMode="numeric" className="input tnum" value={amount || ''} onChange={e => setAmount(Number(e.target.value.replace(/\D/g, '')))} /></Field>
      <Field label="Effective from"><input type="month" className="input" value={month} onChange={e => setMonth(e.target.value)} /></Field>
      <Button variant="primary" type="submit" state={act.state}>Save</Button>
      {act.error ? <p className="text-absent sm:col-span-3">{act.error}</p> : <p className="text-[13px] text-slate sm:col-span-3">Earlier months keep the old amount. A locked month cannot be changed.</p>}
    </form>
  );
}
function EditDetails({ open, onClose, e, onSaved }: { open: boolean; onClose: () => void; e: EmployeeRow; onSaved: () => void }) {
  const init = () => ({ name: e.name, email: e.email, phone: e.phone, designation: e.designation, joinDate: e.joinDate, lastWorkingDate: e.lastWorkingDate ?? '', clQuota: e.clQuota, plQuota: e.plQuota, terminalUserId: e.terminalUserId });
  const [f, setF] = useState(init);
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) { setWasOpen(open); if (open) setF(init()); }
  const act = useAction(async () => { await api.updateEmployee(e.id, { ...f, lastWorkingDate: f.lastWorkingDate || null, terminalUserId: f.terminalUserId || undefined }); onSaved(); });
  const txt = (k: 'name' | 'email' | 'phone' | 'designation' | 'terminalUserId', label: string, hint?: string) => (
    <Field label={label} hint={hint}><input className="input" value={f[k]} onChange={ev => setF({ ...f, [k]: ev.target.value })} /></Field>
  );
  return (
    <Drawer open={open} onClose={onClose} title="Edit details" sub={`${e.name} · ${e.code}`} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" state={act.state} onClick={() => act.run()}>Save</Button></>}>
      <div className="space-y-4">
        {txt('name', 'Full name')}{txt('email', 'Work email')}
        <div className="grid grid-cols-2 gap-3">{txt('phone', 'Phone')}{txt('designation', 'Designation')}</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Joining date"><input type="date" className="input" value={f.joinDate} onChange={ev => setF({ ...f, joinDate: ev.target.value })} /></Field>
          {txt('terminalUserId', 'Terminal user ID', 'The ID enrolled on the device, e.g. 101 or AS101.')}
        </div>
        <Field label="Last working date" hint="Leave empty while the person works here. Salary is paid up to this date."><input type="date" className="input" min={f.joinDate} value={f.lastWorkingDate} onChange={ev => setF({ ...f, lastWorkingDate: ev.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="CL per year"><input type="number" min={0} className="input tnum" value={f.clQuota} onChange={ev => setF({ ...f, clQuota: Number(ev.target.value) })} /></Field>
          <Field label="PL per year"><input type="number" min={0} className="input tnum" value={f.plQuota} onChange={ev => setF({ ...f, plQuota: Number(ev.target.value) })} /></Field>
        </div>
        {act.error && <p className="anim-fade-up text-absent" role="alert">{act.error}</p>}
      </div>
    </Drawer>
  );
}

// =====================================================================
/** Admin only: the three offices and who heads each one. */
export function Offices() {
  const nav = useNavigate();
  const { setScope } = useScope();
  const { user } = useAuth();
  const q = useOffices(user!.id);
  const people = useEmployees('all');
  const toast = useToast();
  // `edit` is an office being changed, or 'new' for the Add office drawer.
  const [edit, setEdit] = useState<OfficeSummary | 'new' | null>(null);
  const blankOffice = { name: '', address: '', startTime: '09:00', fullDayHours: 9, minHalfDayHours: 4.5 };
  const [form, setForm] = useState(blankOffice);
  const saveAct = useAction(async () => {
    if (edit === 'new') await api.createOffice(form); else await api.updateOffice((edit as OfficeSummary).id, form);
    setEdit(null); q.reload(); toast.show(edit === 'new' ? `${form.name} added. Add its people, then choose its head.` : 'Office saved.');
  });
  const changeHead = async (o: OfficeSummary, employeeId: string) => {
    const before = o.headId;
    try {
      await api.setOfficeHead(o.id, employeeId); await Promise.all([q.reload(), people.reload()]);
      toast.show(`${people.data?.find(p => p.id === employeeId)?.name} is now head of ${o.name}.`, before ? { undo: async () => { await api.setOfficeHead(o.id, before); q.reload(); people.reload(); } } : undefined);
    } catch (e) { toast.show(errText(e)); }
  };
  return (
    <div>
      <PageTitle title="Offices and heads" sub="Each head manages one office and is also an employee there. You approve the heads' own requests."
        actions={<Button variant="primary" icon="plus" onClick={() => { setForm(blankOffice); setEdit('new'); }}>Add office</Button>} />
      <Load q={q} skeleton={<SkeletonRows rows={3} />}>
        {offices => (
          <div className="stagger grid gap-4 lg:grid-cols-3">
            {offices.map(o => (
              <Card key={o.id} className="flex flex-col p-5">
                <div className="flex items-start justify-between gap-3">
                  <div><h2 className="font-serif text-xl font-semibold">{o.name}</h2><p className="text-[13px] text-slate">{o.address}</p></div>
                  <Button size="sm" variant="ghost" onClick={() => { setForm({ name: o.name, address: o.address, startTime: o.startTime, fullDayHours: o.fullDayHours, minHalfDayHours: o.halfDayHours }); setEdit(o); }}>Edit</Button>
                </div>
                <div className="mt-4 flex items-center gap-4 text-[13px]">
                  <span><span className="font-serif text-2xl font-semibold tnum">{o.headcount}</span> people</span>
                  <span className="flex items-center gap-1.5 text-slate"><span className={cx('h-2 w-2 rounded-full', o.terminal?.online ? 'anim-pulse bg-present' : 'bg-absent')} />{o.terminal ? `Terminal ${o.terminal.online ? 'online' : 'offline'}` : 'No terminal yet'}</span>
                </div>
                <p className="mt-2 text-[13px] text-slate">Starts {fmtTime(o.startTime)} · full day {fmtNum(o.fullDayHours)} h · half day {fmtNum(o.halfDayHours)} h</p>
                <Field label="Office head" className="mt-4">
                  <select className="input" value={o.headId ?? ''} onChange={e => changeHead(o, e.target.value)}>
                    {!o.headId && <option value="">Choose a head</option>}
                    {(people.data ?? []).filter(p => p.officeId === o.id && p.status === 'active').map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </Field>
                <div className="mt-4 flex gap-2 border-t border-mist pt-4">
                  <Button size="sm" onClick={() => { setScope(o.id); nav('/people'); }}>See people</Button>
                  {o.headId && <Button size="sm" variant="ghost" onClick={() => nav(`/people/${o.headId}`)}>Head's profile</Button>}
                </div>
              </Card>
            ))}
          </div>
        )}
      </Load>
      <Drawer open={!!edit} onClose={() => setEdit(null)} title={edit === 'new' ? 'Add office' : 'Edit office'} footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" state={saveAct.state} onClick={() => saveAct.run()}>Save</Button></>}>
        <div className="space-y-4">
          <Field label="Name"><input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Address"><input className="input" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} /></Field>
          <Field label="Office starts at" hint="A first punch after this minute makes the day a half day."><input type="time" className="input" value={form.startTime} onChange={e => setForm({ ...form, startTime: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Full day (hours)"><input type="number" min={1} step={0.5} className="input tnum" value={form.fullDayHours} onChange={e => setForm({ ...form, fullDayHours: Number(e.target.value) })} /></Field>
            <Field label="Half day (hours)"><input type="number" min={0.5} step={0.5} className="input tnum" value={form.minHalfDayHours} onChange={e => setForm({ ...form, minHalfDayHours: Number(e.target.value) })} /></Field>
          </div>
          {saveAct.error && <p className="anim-fade-up text-absent" role="alert">{saveAct.error}</p>}
          <p className="text-[13px] text-slate">A change to the hours applies to months that are not locked yet.</p>
        </div>
      </Drawer>
    </div>
  );
}
