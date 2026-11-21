// Pieces shared by several screens: status chips, the request row with inline approve and reject,
// the day drawer and the A4 payslip.
import { createContext, useContext, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from './api';
import { useDay, useDecide } from './api/hooks';
import { useAuth } from './auth';
import type { DayStatus, DayView, OfficeSummary, Payslip, RequestRow } from './types';
import { fmtDate, fmtDateLong, fmtDateTime, fmtDays, fmtDuration, fmtMoney, fmtMonth, fmtNum, fmtTime } from './lib/format';
import { Avatar, Button, cx, Drawer, errText, Field, Icon, Load, Skeleton, Tag, useAction, useToast } from './ui';

// ---------- office scope (admin switches, a head is pinned) ----------
export interface Scope { scope: string; setScope: (s: string) => void; offices: OfficeSummary[]; label: string; }
export const ScopeCtx = createContext<Scope>({ scope: 'all', setScope: () => {}, offices: [], label: '' });
export const useScope = () => useContext(ScopeCtx);

// ---------- status ----------
export const STATUS_DOT: Record<DayStatus, string> = {
  present: 'bg-present', half_late: 'bg-half', half_short: 'bg-half', absent: 'bg-absent', leave: 'bg-leave', off: 'bg-off', holiday: 'bg-off',
  missing: 'border-2 border-absent bg-white', not_in: 'border-2 border-off bg-white', working: 'bg-present', future: 'bg-mist', not_joined: 'bg-mist',
};
export function StatusChip({ status, label, pulse }: { status: DayStatus; label: string; pulse?: boolean }) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border border-mist bg-white px-2 text-[12px] font-medium">
      <span className={cx('h-2 w-2 rounded-full', STATUS_DOT[status], pulse && 'anim-pulse')} />{label}
    </span>
  );
}
export const dayChip = (d: DayView) => <StatusChip status={d.status} label={d.label || 'Upcoming'} pulse={d.status === 'working'} />;
export function RequestStatus({ r }: { r: RequestRow }) {
  if (r.status === 'approved') return <Tag tone="present">Approved</Tag>;
  if (r.status === 'rejected') return <Tag tone="absent">Rejected</Tag>;
  if (r.status === 'cancelled') return <Tag>Cancelled</Tag>;
  return <Tag tone="brass">Pending</Tag>;
}

// ---------- request row ----------
/** One click approves. Reject opens a required reason in place. Either one can be undone from the toast. */
export function RequestItem({ r, onChanged, showOffice }: { r: RequestRow; onChanged: () => void; showOffice?: boolean }) {
  const toast = useToast();
  const { user } = useAuth();
  const decide = useDecide();
  const [mode, setMode] = useState<'idle' | 'reject' | 'busy' | 'approved' | 'rejected'>('idle');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  // A decided row can be followed up: the admin reverses the decision, the office head cancels approved leave.
  const [follow, setFollow] = useState<null | 'reverse' | 'cancel'>(null);
  const decided = r.status === 'approved' || r.status === 'rejected';
  const canReverse = user?.role === 'admin' && decided && !r.direct && mode === 'idle';
  const canCancel = !!r.canCancelApproved && mode === 'idle';
  const followUp = useAction(async () => {
    if (follow === 'reverse') await api.reverseDecision(r.id, reason); else await api.cancelApprovedLeave(r.id, reason);
    toast.show(follow === 'reverse' ? `Decision reversed: ${r.employeeName}` : `Leave cancelled: ${r.employeeName}. The days are back in the balance.`);
    setFollow(null); setReason(''); onChanged();
  });
  async function act(decision: 'approved' | 'rejected') {
    if (decision === 'rejected' && !reason.trim()) { setErr('Write a reason. The employee will see it.'); return; }
    // Optimistic: the row shows the result at once. If the server refuses, it goes back.
    setMode(decision); setErr('');
    try {
      await decide.mutateAsync({ id: r.id, decision, comment: decision === 'rejected' ? reason : '' });
      setTimeout(() => {
        onChanged();
        toast.show(`${decision === 'approved' ? 'Approved' : 'Rejected'}: ${r.employeeName}, ${r.title.toLowerCase().replace('correction ·', 'correction for').replace(' · ', ' ')}`, {
          undo: async () => { try { await api.undoDecision(r.id); } catch (e) { toast.show(errText(e)); } onChanged(); },
        });
      }, 420);
    } catch (e) { setErr(errText(e)); setMode(decision === 'rejected' ? 'reject' : 'idle'); onChanged(); }
  }
  return (
    <div className={cx('px-4 py-3 transition-opacity duration-300', mode === 'approved' && 'anim-flash-ok opacity-50', mode === 'rejected' && 'anim-flash-no opacity-50')}>
      <div className="flex flex-wrap items-start gap-3">
        <Avatar name={r.employeeName} />
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link to={`/people/${r.employeeId}`} className="font-semibold hover:underline">{r.employeeName}</Link>
            {r.escalated && <Tag tone="navy">Escalated</Tag>}
            {r.fromHead && <Tag>Office head</Tag>}
            {r.status !== 'pending' && mode === 'idle' && <RequestStatus r={r} />}
          </div>
          <div className="mt-0.5">{r.title}{r.detail && <span className="text-slate"> · {r.detail}</span>}{showOffice && <span className="text-slate"> · {r.officeName}</span>}</div>
          <div className="mt-0.5 text-[13px] text-slate">“{r.reason}” · asked {fmtDateTime(r.createdAt)}</div>
          {r.status !== 'pending' && mode === 'idle' && r.decidedByName && (
            <div className="mt-0.5 text-[13px] text-slate">{r.status === 'approved' ? 'Approved' : 'Rejected'} by {r.decidedByName}{r.decidedAt && `, ${fmtDateTime(r.decidedAt)}`}{r.comment && `. ${r.comment}`}</div>
          )}
        </div>
        {(canReverse || canCancel) && !follow && (
          <div className="flex gap-2">
            {canCancel && <Button size="sm" variant="ghost" onClick={() => { setReason(''); setFollow('cancel'); }}>Cancel leave</Button>}
            {canReverse && <Button size="sm" variant="ghost" onClick={() => { setReason(''); setFollow('reverse'); }}>Reverse</Button>}
          </div>
        )}
        {(r.status === 'pending' || mode === 'approved' || mode === 'rejected') && (r.canAct || mode !== 'idle' ? (
          mode === 'approved' || mode === 'rejected' ? (
            <span className={cx('anim-pop inline-flex h-8 items-center gap-1 font-semibold', mode === 'approved' ? 'text-present' : 'text-absent')}>
              <Icon name={mode === 'approved' ? 'check' : 'x'} size={16} />{mode === 'approved' ? 'Approved' : 'Rejected'}
            </span>
          ) : mode !== 'reject' && (
            <div className="flex gap-2">
              <Button size="sm" state={mode === 'busy' ? 'busy' : 'idle'} onClick={() => act('approved')}>Approve</Button>
              <Button size="sm" variant="ghost" disabled={mode === 'busy'} onClick={() => setMode('reject')}>Reject</Button>
            </div>
          )
        ) : <span className="text-[13px] text-slate">{r.fromHead ? 'The admin decides this' : 'Waiting'}</span>)}
      </div>
      {mode === 'reject' && (
        <form className="anim-fade-up mt-3 flex flex-wrap items-start gap-2 pl-11" onSubmit={e => { e.preventDefault(); act('rejected'); }}>
          <div className="min-w-0 flex-1 basis-56">
            <input autoFocus className={cx('input', err && 'invalid anim-shake')} placeholder="Reason for rejecting (required)" value={reason} onChange={e => { setReason(e.target.value); setErr(''); }} />
          </div>
          <Button size="sm" variant="danger" type="submit" className="!h-10">Reject</Button>
          <Button size="sm" variant="ghost" className="!h-10" onClick={() => { setMode('idle'); setErr(''); }}>Cancel</Button>
        </form>
      )}
      {follow && (
        <form className="anim-fade-up mt-3 flex flex-wrap items-start gap-2 pl-11" onSubmit={e => { e.preventDefault(); followUp.run(); }}>
          <div className="min-w-0 flex-1 basis-56">
            <input autoFocus className={cx('input', followUp.error && 'invalid')} placeholder={follow === 'reverse' ? `Why is this being changed to ${r.status === 'approved' ? 'rejected' : 'approved'}? (required)` : 'Reason for cancelling (the employee will see it)'} value={reason} onChange={e => setReason(e.target.value)} />
          </div>
          <Button size="sm" variant="danger" type="submit" state={followUp.state} className="!h-10">{follow === 'reverse' ? (r.status === 'approved' ? 'Change to rejected' : 'Change to approved') : 'Cancel this leave'}</Button>
          <Button size="sm" variant="ghost" className="!h-10" onClick={() => setFollow(null)}>Keep as is</Button>
        </form>
      )}
      {followUp.error && <div className="anim-fade-up mt-2 pl-11 text-[13px] text-absent">{followUp.error}</div>}
      {err && <div className="anim-fade-up mt-2 pl-11 text-[13px] text-absent">{err}</div>}
    </div>
  );
}

// ---------- day drawer ----------
/** Everything about one person on one date: status, hours, raw punches, requests, and a manual correction. */
export function DayDrawer({ target, onClose, onChanged }: { target: { employeeId: string; date: string } | null; onClose: () => void; onChanged: () => void }) {
  return (
    <Drawer open={!!target} onClose={onClose} title={target ? fmtDateLong(target.date) : ''} sub="Day details">
      {target && <DayBody key={`${target.employeeId}|${target.date}`} employeeId={target.employeeId} date={target.date} onChanged={onChanged} />}
    </Drawer>
  );
}
function DayBody({ employeeId, date, onChanged }: { employeeId: string; date: string; onChanged: () => void }) {
  const q = useDay(employeeId, date);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ inTime: '', outTime: '', reason: '' });
  const saveAct = useAction(async () => {
    await api.correctDay(employeeId, date, { inTime: form.inTime || null, outTime: form.outTime || null, reason: form.reason });
    setEditing(false); await q.reload(); onChanged(); toast.show('Day corrected. It now carries the Manual tag.');
  });
  return (
    <Load q={q} skeleton={<div className="space-y-3"><Skeleton className="h-6 w-40" /><Skeleton className="h-20 w-full" /><Skeleton className="h-28 w-full" /></div>}>
      {d => (
        <div className="space-y-5">
          <div>
            <Link to={`/people/${d.employee.id}`} className="font-semibold hover:underline">{d.employee.name}</Link>
            <span className="text-slate"> · {d.employee.code} · {d.employee.officeName}</span>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {dayChip(d.day)}
              {d.day.manual && <Tag tone="brass">Manual</Tag>}
              {d.day.otherOffice && <Tag>Punched at {d.punches.find(p => p.other)?.officeName}</Tag>}
              {d.day.unpaid > 0 && <span className="text-[13px] text-slate">{fmtDays(d.day.unpaid)} unpaid</span>}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            {[['In', fmtTime(d.day.inTime)], ['Out', fmtTime(d.day.outTime)], ['Hours', d.day.workedMin ? fmtDuration(d.day.workedMin) : 'None']].map(([k, v]) => (
              <div key={k} className="rounded-lg border border-mist p-3"><div className="text-[13px] text-slate">{k}</div><div className="mt-0.5 font-serif text-lg font-semibold tnum">{v}</div></div>
            ))}
          </div>
          {d.lockedNote && <div className="flex items-center gap-2 rounded-lg border border-mist bg-ivory px-3 py-2 text-[13px]"><Icon name="lock" size={15} />{d.lockedNote}</div>}
          <div>
            <div className="mb-2 font-semibold">Raw punches from the terminal</div>
            {d.punches.length === 0 ? <p className="text-slate">No punches were received for this day.</p> : (
              <ul className="divide-y divide-mist rounded-lg border border-mist">
                {d.punches.map((p, i) => (
                  <li key={i} className="flex items-center gap-3 px-3 py-2"><span className="w-20 font-medium tnum">{fmtTime(p.time)}</span><span className="flex-1 text-slate">{p.terminalName}</span>{p.other && <Tag>Other office</Tag>}</li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[13px] text-slate">Raw punches are never edited. A correction is stored next to them.</p>
          </div>
          {d.manual && (
            <div className="rounded-lg border border-brass/50 bg-brass/10 p-3">
              <div className="font-semibold">Manual correction</div>
              <div className="mt-0.5 text-[13px]">{[d.manual.inTime && `In ${fmtTime(d.manual.inTime)}`, d.manual.outTime && `Out ${fmtTime(d.manual.outTime)}`].filter(Boolean).join(', ')} · by {d.manual.byName}{d.manual.at && `, ${fmtDateTime(d.manual.at)}`}</div>
              <div className="mt-0.5 text-[13px] text-slate">“{d.manual.reason}”</div>
            </div>
          )}
          {d.requests.length > 0 && (
            <div>
              <div className="mb-2 font-semibold">Requests for this day</div>
              <div className="divide-y divide-mist rounded-lg border border-mist">{d.requests.map(r => <RequestItem key={r.id} r={r} onChanged={() => { q.reload(); onChanged(); }} />)}</div>
            </div>
          )}
          {d.canCorrect && !editing && <Button onClick={() => { setForm({ inTime: d.day.inTime ?? '', outTime: d.day.outTime ?? '', reason: '' }); setEditing(true); }}>Correct this day</Button>}
          {editing && (
            <form className="anim-fade-up space-y-3 rounded-lg border border-mist p-3" onSubmit={e => { e.preventDefault(); saveAct.run(); }}>
              <div className="grid grid-cols-2 gap-3">
                <Field label="In time"><input type="time" className="input" value={form.inTime} onChange={e => setForm({ ...form, inTime: e.target.value })} /></Field>
                <Field label="Out time"><input type="time" className="input" value={form.outTime} onChange={e => setForm({ ...form, outTime: e.target.value })} /></Field>
              </div>
              <Field label="Reason" error={saveAct.error} hint="Kept in the audit log and shown to the employee.">
                <input className={cx('input', saveAct.error && 'invalid')} value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} />
              </Field>
              <div className="flex gap-2"><Button variant="primary" type="submit" state={saveAct.state}>Save correction</Button><Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button></div>
            </form>
          )}
        </div>
      )}
    </Load>
  );
}

// ---------- payslip (A4) ----------
/** The same layout the backend renders to PDF. Prints cleanly on one A4 page. */
export function PayslipSheet({ slip }: { slip: Payslip }) {
  const r = slip.row;
  const line = (k: string, v: string, strong?: boolean) => (
    <div key={k} className={cx('flex justify-between gap-4 py-2', strong && 'font-semibold')}><span>{k}</span><span className="tnum">{v}</span></div>
  );
  return (
    <div className="a4 mx-auto w-full max-w-[794px] border border-mist bg-white p-6 shadow-[0_1px_0_rgba(20,33,61,0.04)] md:min-h-[1123px] md:p-14">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-ink pb-4">
        <div><div className="font-serif text-2xl font-semibold">{slip.company}</div><div className="text-slate">{slip.employee.officeName}</div></div>
        <div className="text-right"><div className="text-[13px] uppercase tracking-wide text-slate">Payslip</div><div className="font-serif text-xl font-semibold">{fmtMonth(slip.month)}</div></div>
      </div>
      <div className="grid grid-cols-2 gap-x-8 gap-y-3 border-b border-mist py-5 md:grid-cols-4">
        {[['Employee', slip.employee.name], ['Employee ID', slip.employee.code], ['Designation', slip.employee.designation], ['Joined', fmtDate(slip.employee.joinDate) + ' ' + slip.employee.joinDate.slice(0, 4)]].map(([k, v]) => (
          <div key={k}><div className="text-[12px] uppercase tracking-wide text-slate">{k}</div><div className="font-medium">{v}</div></div>
        ))}
      </div>
      <div className="grid gap-x-12 py-5 md:grid-cols-2">
        <div>
          <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-slate">Pay</div>
          <div className="divide-y divide-mist">
            {line('Monthly salary', fmtMoney(r.salary))}
            {line(`Day rate (salary ÷ ${r.calendarDays} days)`, fmtMoney(r.dayRate))}
            {line(`Unpaid days (${fmtNum(r.unpaidDays)})`, `− ${fmtMoney(r.deduction)}`)}
          </div>
        </div>
        <div>
          <div className="mb-1 mt-5 text-[12px] font-semibold uppercase tracking-wide text-slate md:mt-0">Attendance</div>
          <div className="divide-y divide-mist">
            {line('Present', fmtNum(r.present))}
            {line('Half days', fmtNum(r.half))}
            {line('Absent', fmtNum(r.absent))}
            {line('Paid leave (CL and PL)', fmtNum(r.paidLeave))}
            {line('Unpaid leave', fmtNum(r.unpaidLeave))}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-4 rounded-lg bg-ivory px-5 py-4">
        <span className="font-semibold">Net pay</span><span className="font-serif text-3xl font-semibold tnum">{fmtMoney(r.net)}</span>
      </div>
      {r.trace.length > 0 && (
        <div className="pt-6">
          <div className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-slate">How the unpaid days add up</div>
          <div className="divide-y divide-mist">{r.trace.map(t => line(`${fmtDate(t.date)} · ${t.label}`, fmtDays(t.unpaid)))}</div>
        </div>
      )}
      <p className="pt-8 text-[12px] text-slate">Locked by {slip.lockedByName} on {fmtDateTime(slip.lockedAt)}. Net pay = salary − day rate × unpaid days, rounded to the nearest rupee. Unpaid days = absent days + half of each half day + unpaid leave. This payslip is generated by the system and needs no signature.</p>
    </div>
  );
}
