// Attendance: the monthly register, correction requests and the biometric terminals.
import { useState } from 'react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { dowShort, fmtDate, fmtDateTime, fmtMonth, fmtNum, fmtTime, monthOf, parts } from '../../lib/format';
import { DayDrawer, RequestItem, useScope } from '../../shared';
import type { DayView, RegisterRow, RequestRow } from '../../types';
import { Banner, Button, Card, cx, Empty, errText, Icon, Load, MonthPicker, PageTitle, SectionTitle, Segmented, Skeleton, SkeletonRows, Tag, useAction, useData, useToast } from '../../ui';

const thisMonth = () => monthOf(api.demo.now());

// =====================================================================
// Register: a quiet grid. A present day is a small green dot, only exceptions carry a letter.
// =====================================================================
function Cell({ d, today }: { d: DayView; today: string }) {
  const corner = d.manual ? <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-brass" /> : d.otherOffice ? <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-slate" /> : null;
  const box = 'relative flex h-7 w-7 items-center justify-center rounded-md text-[11px] font-bold';
  const ring = d.date === today ? 'ring-1 ring-ink ring-offset-1' : '';
  switch (d.status) {
    case 'present': return <span className={cx(box, ring)}><span className="h-1.5 w-1.5 rounded-full bg-present" />{corner}</span>;
    case 'working': return <span className={cx(box, ring)}><span className={cx('h-2 w-2 rounded-full anim-pulse', d.late ? 'bg-half' : 'bg-present')} />{corner}</span>;
    case 'half_late': case 'half_short': return <span className={cx(box, ring, 'bg-half text-white')}>H{corner}</span>;
    case 'absent': return <span className={cx(box, ring, 'bg-absent text-white')}>A{corner}</span>;
    case 'missing': return <span className={cx(box, ring, 'border-2 border-absent text-absent')}>M{corner}</span>;
    case 'leave': return <span className={cx(box, ring, 'bg-leave text-white')}>{d.halfLeave ? '½' : d.leaveType === 'UNPAID' ? 'U' : 'L'}{corner}</span>;
    case 'off': case 'holiday': return <span className={cx(box, 'bg-mist/70 text-off')}>{d.status === 'holiday' ? '•' : ''}</span>;
    case 'not_in': return <span className={cx(box, ring)}><span className="h-2 w-2 rounded-full border-2 border-off" /></span>;
    default: return <span className={box} />;
  }
}
const LEGEND: [string, React.ReactNode][] = [
  ['Present', <span className="h-1.5 w-1.5 rounded-full bg-present" />],
  ['Half day', <span className="flex h-5 w-5 items-center justify-center rounded bg-half text-[10px] font-bold text-white">H</span>],
  ['Absent', <span className="flex h-5 w-5 items-center justify-center rounded bg-absent text-[10px] font-bold text-white">A</span>],
  ['Missing punch', <span className="flex h-5 w-5 items-center justify-center rounded border-2 border-absent text-[10px] font-bold text-absent">M</span>],
  ['Leave (U unpaid)', <span className="flex h-5 w-5 items-center justify-center rounded bg-leave text-[10px] font-bold text-white">L</span>],
  ['Off or holiday', <span className="h-5 w-5 rounded bg-mist" />],
  ['Corrected by hand', <span className="h-1.5 w-1.5 rounded-full bg-brass" />],
];

export function Register() {
  const { scope, label, offices } = useScope();
  const [month, setMonth] = useState(thisMonth);
  const [only, setOnly] = useState<'all' | 'exceptions' | 'missing'>('all');
  const [search, setSearch] = useState('');
  const q = useData(() => api.register(scope, month), [scope, month], 30000);
  const [day, setDay] = useState<{ employeeId: string; date: string } | null>(null);
  const today = api.demo.now().slice(0, 10);
  const keep = (r: RegisterRow) =>
    (!search.trim() || r.name.toLowerCase().includes(search.trim().toLowerCase())) &&
    (only === 'all' || (only === 'missing' ? r.totals.missing > 0 : r.totals.half + r.totals.absent + r.totals.missing > 0));
  return (
    <div>
      <PageTitle title="Attendance register" sub={label} actions={<MonthPicker month={month} onChange={setMonth} max={thisMonth()} min="2026-10" />} />
      <Load q={q} skeleton={<><div className="mb-4 grid grid-cols-5 gap-3">{[0, 1, 2, 3, 4].map(i => <Skeleton key={i} className="h-16 !rounded-xl" />)}</div><SkeletonRows rows={8} /></>}>
        {d => {
          const rows = d.rows.filter(keep);
          return (
            <>
              {d.locks.map(l => <Banner key={l.officeId} tone="leave" icon="lock"><span className="font-semibold">{fmtMonth(month)} is locked for {l.officeName}.</span> Locked by {l.lockedByName} on {fmtDateTime(l.lockedAt)}. The figures can no longer change.</Banner>)}
              <div className="mb-4 grid grid-cols-3 gap-3 sm:grid-cols-5">
                {([['Present', d.totals.present, 'bg-present'], ['Half days', d.totals.half, 'bg-half'], ['Absent', d.totals.absent, 'bg-absent'], ['Leave days', d.totals.leave, 'bg-leave'], ['Missing punch', d.totals.missing, 'border-2 border-absent']] as const).map(([k, v, c]) => (
                  <Card key={k} className="px-4 py-3"><div className="flex items-center gap-2 text-[13px] text-slate"><span className={cx('h-2 w-2 rounded-full', c)} />{k}</div><div className="font-serif text-2xl font-semibold tnum">{fmtNum(v)}</div></Card>
                ))}
              </div>
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <div className="relative min-w-0 flex-1 basis-48 sm:max-w-xs"><Icon name="search" size={16} className="absolute left-3 top-3 text-slate" /><input className="input !pl-9" placeholder="Find a person" value={search} onChange={e => setSearch(e.target.value)} /></div>
                <Segmented value={only} onChange={setOnly} options={[{ value: 'all', label: 'Everyone' }, { value: 'exceptions', label: 'With exceptions' }, { value: 'missing', label: 'Missing punch' }]} />
                <span className="ml-auto text-slate tnum">{rows.length} of {d.rows.length}</span>
              </div>
              {rows.length === 0 ? <Card><Empty title={only === 'missing' ? 'No missing punches' : 'Nothing to show'} text={only === 'all' ? 'No one matches this search.' : 'Nobody matches this filter for the month.'} action={<Button onClick={() => { setOnly('all'); setSearch(''); }}>Show everyone</Button>} /></Card> : (
                <Card className="overflow-x-auto">
                  <table className="border-separate border-spacing-0 text-left">
                    <thead>
                      <tr className="text-[11px] text-slate">
                        <th className="sticky left-0 z-10 min-w-44 border-b border-mist bg-white px-4 py-2 font-semibold uppercase tracking-wide">Employee</th>
                        {d.dates.map(dt => (
                          <th key={dt} className={cx('border-b border-mist px-0.5 py-2 text-center font-medium', dt === today && 'text-ink')}>
                            <div>{dowShort(dt)}</div><div className={cx('tnum', dt === today && 'font-bold')}>{parts(dt).d}</div>
                          </th>
                        ))}
                        <th className="border-b border-mist px-3 py-2 text-right font-semibold uppercase tracking-wide">Unpaid</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(r => (
                        <tr key={r.employeeId} className="group">
                          <td className="sticky left-0 z-10 border-b border-mist bg-white px-4 py-1.5 group-hover:bg-ivory">
                            <div className="truncate font-medium">{r.name}</div>
                            {scope === 'all' && <div className="text-[12px] text-slate">{offices.find(o => o.id === r.officeId)?.name}</div>}
                          </td>
                          {r.days.map(c => (
                            <td key={c.date} className="border-b border-mist p-0.5 group-hover:bg-ivory">
                              {['future', 'not_joined'].includes(c.status) && !c.leaveType ? <Cell d={c} today={today} /> : (
                                <button aria-label={`${r.name}, ${fmtDate(c.date)}, ${c.label}`} title={`${fmtDate(c.date)} · ${c.label}${c.inTime ? ` · in ${fmtTime(c.inTime)}` : ''}${c.outTime ? `, out ${fmtTime(c.outTime)}` : ''}`}
                                  onClick={() => setDay({ employeeId: r.employeeId, date: c.date })} className="block rounded-md transition-transform duration-100 hover:scale-110"><Cell d={c} today={today} /></button>
                              )}
                            </td>
                          ))}
                          <td className="border-b border-mist px-3 text-right font-medium tnum group-hover:bg-ivory">{r.totals.unpaid ? fmtNum(r.totals.unpaid) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              )}
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-slate">{LEGEND.map(([k, el]) => <span key={k} className="inline-flex items-center gap-1.5">{el}{k}</span>)}</div>
            </>
          );
        }}
      </Load>
      <DayDrawer target={day} onClose={() => setDay(null)} onChanged={q.reload} />
    </div>
  );
}

// =====================================================================
/** Used for both leave requests and attendance corrections. */
export function RequestsList({ kind, title, sub }: { kind: 'leave' | 'correction'; title: string; sub: string }) {
  const { user } = useAuth();
  const { scope, label } = useScope();
  const [tab, setTab] = useState<'pending' | 'decided'>('pending');
  const pending = useData(() => api.requests({ scope, kind, status: 'pending' }), [scope, kind], 30000);
  const decided = useData(() => api.requests({ scope, kind, status: 'decided' }), [scope, kind]);
  const reload = () => { pending.reload(); decided.reload(); };
  const q = tab === 'pending' ? pending : decided;
  const body = (rows: RequestRow[]) => rows.length === 0 ? (
    <Empty title={tab === 'pending' ? 'All caught up' : 'Nothing decided yet'} text={tab === 'pending' ? `No ${kind === 'leave' ? 'leave' : 'correction'} requests are waiting in ${label}.` : undefined} />
  ) : <div className="divide-y divide-mist">{rows.map(r => <RequestItem key={r.id} r={r} showOffice={scope === 'all'} onChanged={reload} />)}</div>;
  return (
    <div>
      <PageTitle title={title} sub={`${label} · ${sub}`} />
      <div className="mb-3">
        <Segmented value={tab} onChange={setTab} options={[{ value: 'pending', label: 'Pending', count: pending.data?.length }, { value: 'decided', label: 'Decided', count: decided.data?.length }]} />
      </div>
      <Card><Load q={q} skeleton={<div className="space-y-3 p-4"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>}>{body}</Load></Card>
      {user!.role === 'head' && <p className="mt-3 text-[13px] text-slate">A request you have not decided within 2 working days also goes to the admin. Your own requests are decided by the admin.</p>}
    </div>
  );
}
export const Corrections = () => <RequestsList kind="correction" title="Correction requests" sub="Approving adds a manual entry. Raw punches stay as they are." />;

// =====================================================================
export function Terminals() {
  const { scope } = useScope();
  const toast = useToast();
  const q = useData(() => api.terminals(), [], 15000);
  const log = useData(() => api.recentPunches(scope), [scope], 15000);
  const test = useAction(async (id: string) => {
    try { const r = await api.simulatePunch(id); toast.show(`${r.name} punched ${r.kind} at ${fmtTime(r.time)}.`); q.reload(); log.reload(); }
    catch (e) { toast.show(errText(e)); }
  });
  return (
    <div>
      <PageTitle title="Terminals" sub="Each biometric terminal pushes punches to the server on its own (ADMS). Nothing is typed in by hand." />
      <Load q={q} skeleton={<SkeletonRows rows={3} />}>
        {list => (
          <div className="stagger grid gap-4 lg:grid-cols-3">
            {list.filter(t => scope === 'all' || t.officeId === scope).map(t => (
              <Card key={t.id} className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <div><h2 className="font-serif text-xl font-semibold">{t.officeName}</h2><p className="text-[13px] text-slate">{t.name} · Serial {t.serial}</p></div>
                  {t.online ? <Tag tone="present">Online</Tag> : <Tag tone="absent">Offline</Tag>}
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div><div className="text-[13px] text-slate">{t.online ? 'Last heard from' : 'Offline since'}</div><div className="font-medium tnum">{fmtTime(t.lastSeen.slice(11))}</div></div>
                  <div><div className="text-[13px] text-slate">Punches today</div><div className="font-medium tnum">{t.punchesToday}</div></div>
                </div>
                {!t.online && <p className="mt-3 rounded-lg border border-absent/40 bg-absent/5 px-3 py-2 text-[13px]">Punches made while offline stay on the device and arrive with their original time when it reconnects. Check the network cable or Wi-Fi at this office.</p>}
                <div className="mt-4 border-t border-mist pt-4"><Button size="sm" disabled={test.state !== 'idle'} onClick={() => test.run(t.id)}>Demo: send one punch</Button></div>
              </Card>
            ))}
          </div>
        )}
      </Load>
      <section className="mt-6">
        <SectionTitle>Latest punches received</SectionTitle>
        <Card>
          <Load q={log} skeleton={<div className="p-4"><Skeleton className="h-24 w-full" /></div>}>
            {rows => rows.length === 0 ? <Empty icon="clock" title="No punches yet" /> : (
              <ul className="divide-y divide-mist">
                {rows.map((p, i) => (
                  <li key={p.at + p.employeeId + i} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="w-36 text-slate tnum">{fmtDateTime(p.at)}</span><span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                    {p.other && <Tag>Other office</Tag>}<span className="hidden text-[13px] text-slate sm:block">{p.terminalName}</span>
                  </li>
                ))}
              </ul>
            )}
          </Load>
        </Card>
      </section>
    </div>
  );
}
