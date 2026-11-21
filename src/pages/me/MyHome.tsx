// Employee home: today's status, the on-time streak, leave balance and anything that needs attention.
import { Link } from 'react-router-dom';
import { useMyHome } from '../../api/hooks';
import { firstName, fmtDate, fmtDateLong, fmtDuration, fmtMoney, fmtMonth, fmtNum, fmtTime, fromMin, toMin } from '../../lib/format';
import { RULES } from '../../lib/rules';
import { dayChip, RequestStatus } from '../../shared';
import type { MyHome as MyHomeData } from '../../types';
import { Bar, Card, cx, Icon, Load, Ring, SectionTitle, Skeleton, Tag } from '../../ui';

export default function MyHome() {
  const q = useMyHome();
  return (
    <Load q={q} skeleton={<div className="space-y-4"><Skeleton className="h-8 w-56" /><Skeleton className="h-56 w-full !rounded-xl" /><Skeleton className="h-40 w-full !rounded-xl" /></div>}>
      {h => {
        const hour = Number(h.time.slice(0, 2));
        return (
          <div className="stagger space-y-5">
            <div>
              <h1 className="font-serif text-[26px] font-semibold leading-tight">{hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'}, {firstName(h.employee.name)}</h1>
              <p className="mt-1 text-slate">{fmtDateLong(h.today.date)} · {fmtTime(h.time)}</p>
            </div>
            {h.firstDays && <Welcome h={h} />}
            <DayCard h={h} />
            {h.missing.map(d => (
              <Link key={d.date} to={`/me/correction/${d.date}`} className="flex items-center gap-3 rounded-xl border-2 border-absent/60 bg-white px-4 py-3 transition-colors hover:bg-absent/5">
                <Icon name="alert" className="text-absent" />
                <span className="min-w-0 flex-1"><span className="block font-semibold">{fmtDate(d.date)} has no punch out</span><span className="block text-[13px] text-slate">Ask for a correction so the day counts.</span></span>
                <Icon name="right" size={16} />
              </Link>
            ))}
            {!h.firstDays && <StreakCard h={h} />}
            <section>
              <SectionTitle right={<Link to="/me/leave/apply" className="btn btn-secondary btn-sm">Apply for leave</Link>}>Leave balance</SectionTitle>
              <Card className="grid grid-cols-2 divide-x divide-mist">
                {([['Casual leave (CL)', h.balances.cl], ['Privilege leave (PL)', h.balances.pl]] as const).map(([k, b]) => (
                  <div key={k} className="p-4"><div className="text-[13px] text-slate">{k}</div><div className="font-serif text-[30px] font-semibold leading-tight tnum">{fmtNum(b.balance)}</div><div className="text-[13px] text-slate">{b.pending > 0 ? `${fmtNum(b.pending)} waiting for approval` : 'days available'}</div></div>
                ))}
              </Card>
            </section>
            {h.pending.length > 0 && (
              <section>
                <SectionTitle>Your open requests</SectionTitle>
                <Card className="divide-y divide-mist">
                  {h.pending.map(r => <Link key={r.id} to={r.kind === 'leave' ? '/me/leave' : '/me/attendance'} className="flex items-center gap-3 px-4 py-3 hover:bg-ivory"><span className="min-w-0 flex-1"><span className="block font-medium">{r.title}</span><span className="block text-[13px] text-slate">{r.detail}</span></span><RequestStatus r={r} /></Link>)}
                </Card>
              </section>
            )}
            <section>
              <SectionTitle right={<Link to="/me/attendance" className="text-[13px] font-medium text-slate hover:text-ink">See the month</Link>}>{fmtMonth(h.today.date.slice(0, 7))} so far</SectionTitle>
              <Card className="grid grid-cols-4 divide-x divide-mist text-center">
                {([['Present', h.month.present, 'bg-present'], ['Half', h.month.half, 'bg-half'], ['Absent', h.month.absent, 'bg-absent'], ['Leave', h.month.leave, 'bg-leave']] as const).map(([k, v, c]) => (
                  <div key={k} className="py-3"><div className="font-serif text-2xl font-semibold tnum">{fmtNum(v)}</div><div className="mt-0.5 flex items-center justify-center gap-1.5 text-[12px] text-slate"><span className={cx('h-2 w-2 rounded-full', c)} />{k}</div></div>
                ))}
              </Card>
            </section>
            <Card className="divide-y divide-mist">
              {h.nextHoliday && <div className="flex items-center gap-3 px-4 py-3"><Icon name="calendar" className="text-slate" /><span className="flex-1">Next holiday</span><span className="font-medium">{h.nextHoliday.name}, {fmtDate(h.nextHoliday.date)}</span></div>}
              {h.latestPayslip && <Link to={`/me/payslips/${h.latestPayslip.month}`} className="flex items-center gap-3 px-4 py-3 hover:bg-ivory"><Icon name="wallet" className="text-slate" /><span className="flex-1">{fmtMonth(h.latestPayslip.month)} payslip</span><span className="font-medium tnum">{fmtMoney(h.latestPayslip.net)}</span><Icon name="right" size={16} className="text-slate" /></Link>}
            </Card>
          </div>
        );
      }}
    </Load>
  );
}

/** The one card that answers "how is my day counted?" */
function DayCard({ h }: { h: MyHomeData }) {
  const d = h.today;
  const nowMin = toMin(h.time);
  const wrap = (children: React.ReactNode, tone = '') => <Card className={cx('p-5', tone)}>{children}</Card>;
  if (d.status === 'off' || d.status === 'holiday') {
    return wrap(<><div className="text-[13px] font-semibold uppercase tracking-wide text-slate">Today</div><div className="mt-1 font-serif text-2xl font-semibold">{h.dayKindLabel || 'Day off'}</div><p className="mt-1 text-slate">No attendance is expected today. Enjoy the day.</p></>);
  }
  if (d.status === 'leave' && !d.halfLeave) {
    return wrap(<><div className="text-[13px] font-semibold uppercase tracking-wide text-slate">Today</div><div className="mt-1 font-serif text-2xl font-semibold">{d.label}</div><p className="mt-1 text-slate">Your leave for today is approved. Nothing to do.</p></>);
  }
  if (d.status === 'not_in') {
    const left = RULES.startMin - nowMin;
    return d.late
      ? wrap(<><div className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wide text-absent"><Icon name="alert" size={15} />Past 9:00 AM</div>
          <div className="mt-1 font-serif text-2xl font-semibold">No punch in yet</div>
          <p className="mt-1 text-slate">A punch in after 9:00 AM counts as a half day. Punch at the terminal when you arrive. If you are in and the terminal missed you, ask for a correction.</p>
          <Link to={`/me/correction/${d.date}`} className="btn btn-secondary btn-sm mt-3">Ask for a correction</Link></>, 'border-absent/50')
      : wrap(<div className="flex items-center gap-5">
          <Ring value={1 - Math.min(1, left / 60)} size={92}><span className="font-serif text-xl font-semibold tnum">{left}</span><span className="text-[11px] text-slate">min left</span></Ring>
          <div><div className="text-[13px] font-semibold uppercase tracking-wide text-slate">Today</div><div className="mt-1 font-serif text-2xl font-semibold">Punch in by 9:00 AM</div><p className="mt-1 text-slate">Use the terminal at the entrance. Your day starts counting from the first punch.</p></div>
        </div>);
  }
  // In the office, or finished for the day.
  if (!d.inTime) {
    return wrap(<><div className="text-[13px] font-semibold uppercase tracking-wide text-slate">Today</div><div className="mt-1 font-serif text-2xl font-semibold">{d.label}</div><p className="mt-1 text-slate">Punch in when you arrive. The half you work needs 4.5 hours at the office.</p></>);
  }
  const shown = d.outTime ? d.workedMin : Math.max(0, nowMin - toMin(d.inTime));
  const fullAt = d.inTime ? fromMin(toMin(d.inTime) + RULES.fullDayMin) : null;
  const done = shown >= RULES.fullDayMin;
  return wrap(
    <div className="flex items-center gap-5">
      <Ring value={shown / RULES.fullDayMin} size={104} color={done ? 'var(--color-present)' : 'var(--color-brass)'}>
        <span className="font-serif text-xl font-semibold leading-none tnum">{Math.floor(shown / 60)}<span className="text-sm">h</span> {String(shown % 60).padStart(2, '0')}</span><span className="mt-0.5 text-[11px] text-slate">of 9 h</span>
      </Ring>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">{dayChip(d)}{d.late && <Tag tone="absent">Half day (late)</Tag>}{d.manual && <Tag tone="brass">Manual</Tag>}</div>
        <div className="mt-2 font-serif text-2xl font-semibold">{done && !d.late ? 'Full day done' : `In at ${fmtTime(d.inTime)}`}</div>
        <p className="mt-1 text-slate">
          {d.late ? 'You punched in after 9:00 AM, so today counts as a half day.'
            : done ? `${fmtDuration(shown)} between your first and last punch.`
            : `Full day at ${fmtTime(fullAt)}. Remember to punch out when you leave.`}
        </p>
      </div>
    </div>,
  );
}

const STREAKS = [10, 25, 50, 100];
/** Quiet gamification: a streak of on-time days, the best so far, and five badges. Only this person, their head and the admin see it. */
function StreakCard({ h }: { h: MyHomeData }) {
  const { current, best } = h.streak;
  const next = STREAKS.find(n => current < n) ?? 100;
  const milestone = STREAKS.includes(current);
  return (
    <section>
      <SectionTitle>On-time streak</SectionTitle>
      <Card className="p-5">
        <div className="flex items-center gap-4">
          <span key={current} className={cx('flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-brass/15 text-brass', milestone && 'anim-pop')}><Icon name="flame" size={28} /></span>
          <div className="min-w-0 flex-1">
            <div className="font-serif text-[28px] font-semibold leading-none tnum">{current} <span className="text-lg">{current === 1 ? 'day' : 'days'}</span></div>
            <p className="mt-1 text-slate">{current === 0 ? 'The streak restarted. Be in by 9:00 AM and stay the full day to start a new one.' : milestone ? `A ${current} day milestone. Well done.` : `In by 9:00 AM with full hours, ${current} working days in a row.`}</p>
          </div>
          <div className="text-right"><div className="text-[12px] uppercase tracking-wide text-slate">Best</div><div className="font-serif text-xl font-semibold tnum">{best}</div></div>
        </div>
        <div className="mt-4"><Bar value={Math.min(1, current / next)} /><div className="mt-1 flex justify-between text-[12px] text-slate"><span>{current >= 100 ? '100 in a row and counting' : `${next - current} more ${next - current === 1 ? 'day' : 'days'} to reach ${next} in a row`}</span><span className="tnum">{Math.min(current, next)} of {next}</span></div></div>
        <div className="mt-4 grid grid-cols-5 gap-2 border-t border-mist pt-4">
          {h.badges.map(b => (
            <div key={b.key} className="text-center" title={b.hint}>
              <span className={cx('mx-auto flex h-10 w-10 items-center justify-center rounded-full border-2', b.earned ? 'border-brass bg-brass/15 text-brass' : 'border-dashed border-mist text-off')}><Icon name="star" size={18} /></span>
              <div className={cx('mt-1 text-[11px] leading-tight', b.earned ? 'font-medium' : 'text-slate')}>{b.label}</div>
            </div>
          ))}
        </div>
      </Card>
    </section>
  );
}

function Welcome({ h }: { h: MyHomeData }) {
  const items = [
    ['Be in by 9:00 AM', 'A punch in after 9:00 counts as a half day. A full day is 9 hours between your first and last punch.'],
    ['Punch in and out at the terminal', `Your terminal ID is ${h.employee.terminalUserId}. Your office head will enrol your fingerprint.`],
    ['Leave and payslips are here', 'Apply for leave from the Leave tab. Your payslip appears under Payslips after each month is locked.'],
  ];
  return (
    <Card className="border-brass/60 p-5">
      <div className="mb-1 h-1 w-10 rounded-full bg-brass" />
      <div className="font-serif text-xl font-semibold">Welcome to {h.employee.officeName}</div>
      <p className="mt-1 text-slate">You are {h.employee.code}. Three things to know:</p>
      <ol className="mt-3 space-y-3">
        {items.map(([t, s], i) => <li key={t} className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-slate text-[12px] font-bold">{i + 1}</span><span><span className="block font-semibold">{t}</span><span className="block text-[13px] text-slate">{s}</span></span></li>)}
      </ol>
    </Card>
  );
}
