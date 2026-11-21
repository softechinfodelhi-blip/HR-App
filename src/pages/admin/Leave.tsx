// Leave: requests, the month calendar and the holiday list of each office.
import { useState } from 'react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { dow, fmtDate, fmtMonth, monthOf, parts } from '../../lib/format';
import { useScope } from '../../shared';
import type { CalendarDay } from '../../types';
import { Button, Card, cx, Drawer, Empty, errText, Field, Load, MonthPicker, PageTitle, Segmented, SkeletonRows, Tag, useAction, useData, useToast } from '../../ui';
import { RequestsList } from './Attendance';

export const LeaveRequests = () => <RequestsList kind="leave" title="Leave requests" sub="Paid leave cannot go beyond the balance." />;

// =====================================================================
export function LeaveCalendar() {
  const { scope, label } = useScope();
  const [month, setMonth] = useState(() => monthOf(api.demo.now()));
  const q = useData(() => api.leaveCalendar(scope, month), [scope, month]);
  const today = api.demo.now().slice(0, 10);
  const chip = (p: CalendarDay['people'][number]) => (
    <span key={p.employeeId} title={`${p.name} · ${p.type === 'UNPAID' ? 'Unpaid leave' : p.type}${p.half ? ', half day' : ''}${p.pending ? ', pending' : ''}`}
      className={cx('block truncate rounded px-1.5 py-0.5 text-[12px] font-medium', p.pending ? 'border border-dashed border-leave text-leave' : 'bg-leave text-white')}>
      {p.name.split(' ')[0]} {p.name.split(' ')[1]?.[0]}.{p.half ? ' ½' : ''}
    </span>
  );
  return (
    <div>
      <PageTitle title="Leave calendar" sub={label} actions={<MonthPicker month={month} onChange={setMonth} />} />
      <Load q={q} skeleton={<SkeletonRows rows={6} />}>
        {days => {
          const lead = (dow(days[0].date) + 6) % 7; // Monday first
          const busy = days.filter(d => d.people.length || d.holiday);
          return (
            <>
              <Card className="hidden overflow-hidden md:block">
                <div className="grid grid-cols-7 border-b border-mist text-center text-[12px] font-semibold uppercase tracking-wide text-slate">
                  {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => <div key={d} className="py-2">{d}</div>)}
                </div>
                <div className="grid grid-cols-7">
                  {Array.from({ length: lead }, (_, i) => <div key={`x${i}`} className="min-h-28 border-b border-r border-mist bg-ivory/60" />)}
                  {days.map(d => (
                    <div key={d.date} className={cx('min-h-28 border-b border-r border-mist p-1.5', (d.off || d.holiday) && 'bg-mist/40')}>
                      <div className="mb-1 flex items-center justify-between">
                        <span className={cx('flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[13px] font-medium tnum', d.date === today && 'bg-ink text-white')}>{parts(d.date).d}</span>
                        {d.holiday && <span className="truncate pl-1 text-[11px] font-medium text-slate">{d.holiday}</span>}
                      </div>
                      <div className="space-y-1">{d.people.slice(0, 3).map(chip)}{d.people.length > 3 && <span className="block text-[12px] text-slate">and {d.people.length - 3} more</span>}</div>
                    </div>
                  ))}
                </div>
              </Card>
              <Card className="md:hidden">
                {busy.length === 0 ? <Empty icon="calendar" title="No leave this month" /> : (
                  <ul className="divide-y divide-mist">
                    {busy.map(d => (
                      <li key={d.date} className="flex gap-3 px-4 py-3">
                        <span className="w-24 shrink-0 font-medium">{fmtDate(d.date)}</span>
                        <span className="min-w-0 flex-1 space-y-1">{d.holiday && <span className="block text-slate">{d.holiday}</span>}{d.people.map(p => <span key={p.employeeId} className="block">{p.name} <span className="text-slate">· {p.type === 'UNPAID' ? 'Unpaid' : p.type}{p.half ? ', half day' : ''}{p.pending ? ', pending' : ''}</span></span>)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-slate">
                <span className="inline-flex items-center gap-1.5"><span className="h-3 w-5 rounded bg-leave" />Approved leave</span>
                <span className="inline-flex items-center gap-1.5"><span className="h-3 w-5 rounded border border-dashed border-leave" />Waiting for a decision</span>
                <span className="inline-flex items-center gap-1.5"><span className="h-3 w-5 rounded bg-mist" />Weekly off or holiday</span>
              </div>
              {busy.length === 0 && <p className="mt-3 hidden text-slate md:block">Nobody has leave in {fmtMonth(month)}.</p>}
            </>
          );
        }}
      </Load>
    </div>
  );
}

// =====================================================================
export function Holidays() {
  const { user } = useAuth();
  const { scope, offices, label } = useScope();
  const toast = useToast();
  const year = Number(api.demo.now().slice(0, 4));
  const q = useData(() => api.holidays(scope, year), [scope, year]);
  const [adding, setAdding] = useState(false);
  const blank = () => ({ date: '', name: '', kind: 'holiday' as 'holiday' | 'working', officeIds: scope === 'all' ? offices.map(o => o.id) : [scope] });
  const [f, setF] = useState(blank);
  const add = useAction(async () => { const h = await api.addHoliday(f); setAdding(false); q.reload(); toast.show(`${h.name} added for ${fmtDate(h.date)}.`, { undo: async () => { await api.removeHoliday(h.id); q.reload(); } }); });
  const remove = async (id: string) => {
    try { const h = await api.removeHoliday(id); q.reload(); toast.show(`${h.name} removed.`, { undo: async () => { await api.restoreHoliday(h); q.reload(); } }); }
    catch (e) { toast.show(errText(e)); }
  };
  const today = api.demo.now().slice(0, 10);
  return (
    <div>
      <PageTitle title={`Holidays ${year}`} sub={`${label} · Sundays and the 2nd and 4th Saturday are always off.`}
        actions={<Button variant="primary" icon="plus" onClick={() => { setF(blank()); setAdding(true); }}>Add a date</Button>} />
      <Load q={q} skeleton={<SkeletonRows rows={6} />}>
        {rows => (
          <Card>
            {rows.length === 0 ? <Empty icon="calendar" title="No holidays yet" text="Add the dates this office is closed." /> : (
              <ul className="divide-y divide-mist">
                {rows.map(h => (
                  <li key={h.id} className={cx('flex flex-wrap items-center gap-3 px-4 py-3', h.date < today && 'text-slate')}>
                    <span className="w-28 font-medium tnum">{fmtDate(h.date)}</span>
                    <span className="min-w-0 flex-1 basis-40"><span className="font-medium">{h.name}</span><span className="block text-[13px] text-slate">{h.offices}</span></span>
                    {h.kind === 'working' ? <Tag tone="navy">Working day</Tag> : <Tag>Holiday</Tag>}
                    {h.canEdit && h.date >= today ? <Button size="sm" variant="ghost" onClick={() => remove(h.id)}>Remove</Button> : <span className="w-[76px]" />}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </Load>
      <Drawer open={adding} onClose={() => setAdding(false)} title="Add a date" sub="A holiday, or a weekly off that will be worked."
        footer={<><Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button><Button variant="primary" state={add.state} onClick={() => add.run()}>Add</Button></>}>
        <div className="space-y-4">
          <Segmented value={f.kind} onChange={kind => setF({ ...f, kind })} options={[{ value: 'holiday', label: 'Holiday' }, { value: 'working', label: 'Working day on an off' }]} />
          <Field label="Date"><input type="date" className="input" value={f.date} onChange={e => setF({ ...f, date: e.target.value })} /></Field>
          <Field label="Name" hint={f.kind === 'working' ? 'For example: Year-end stock count.' : 'For example: Diwali.'}><input className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
          {user!.role === 'admin' ? (
            <fieldset>
              <legend className="mb-1 text-[13px] font-medium">Offices</legend>
              <div className="space-y-2">
                {offices.map(o => (
                  <label key={o.id} className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-[var(--color-ink)]" checked={f.officeIds.includes(o.id)}
                    onChange={e => setF({ ...f, officeIds: e.target.checked ? [...f.officeIds, o.id] : f.officeIds.filter(x => x !== o.id) })} />{o.name}</label>
                ))}
              </div>
            </fieldset>
          ) : <p className="text-[13px] text-slate">This applies to {user!.officeName} only.</p>}
          {add.error && <p className="anim-fade-up text-absent" role="alert">{add.error}</p>}
        </div>
      </Drawer>
    </div>
  );
}
