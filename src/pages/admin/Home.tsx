// Home for the admin and for office heads: who is in, who is not, and what is waiting for a decision.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { firstName, fmtDateLong, fmtTime } from '../../lib/format';
import { dayChip, DayDrawer, RequestItem, useScope } from '../../shared';
import type { TodayPerson } from '../../types';
import { Avatar, Banner, Bar, Card, cx, Drawer, Empty, Icon, Load, Ring, SectionTitle, Skeleton, SkeletonRows, Stat, Tag, useData } from '../../ui';

type ListKey = 'in' | 'notIn' | 'onLeave';
const LIST_TITLE: Record<ListKey, string> = { in: 'In the office', notIn: 'Not in yet', onLeave: 'On leave today' };

export default function Home() {
  const { user } = useAuth();
  const { scope, label } = useScope();
  const board = useData(() => api.today(scope), [scope], 15000);
  const queue = useData(() => api.queue(scope), [scope], 30000);
  const mine = useData(() => (user!.role === 'head' ? api.myHome() : Promise.resolve(null)), [user!.id]);
  const [list, setList] = useState<ListKey | null>(null);
  const [day, setDay] = useState<{ employeeId: string; date: string } | null>(null);
  const queueRef = useRef<HTMLDivElement>(null);
  const refresh = () => { board.reload(); queue.reload(); };

  // Rows that were not on the previous poll slide in, so a new punch is easy to spot.
  const seen = useRef<Set<string> | null>(null);
  const lateIds = (board.data?.people ?? []).filter(p => p.day.status === 'working' && p.day.late).map(p => p.employeeId);
  const fresh = seen.current ? lateIds.filter(id => !seen.current!.has(id)) : [];
  useEffect(() => { if (board.data) seen.current = new Set(lateIds); });

  const hour = Number((board.data?.time ?? '09:00').slice(0, 2));
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const pick = (k: ListKey, people: TodayPerson[]) => people.filter(p => (k === 'in' ? ['working', 'present'].includes(p.day.status) : k === 'notIn' ? p.day.status === 'not_in' : p.day.status === 'leave'));

  return (
    <div>
      <div className="mb-5">
        <h1 className="font-serif text-[26px] font-semibold leading-tight">{greet}, {firstName(user!.name)}</h1>
        <p className="mt-1 text-slate">{board.data ? `${fmtDateLong(board.data.date)} · ${fmtTime(board.data.time)}` : 'Loading today'} · {label}</p>
      </div>

      <Load q={board} skeleton={<div className="space-y-4"><div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-[104px] !rounded-xl" />)}</div><SkeletonRows rows={4} /></div>}>
        {b => {
          const notIn = pick('notIn', b.people);
          const late = b.people.filter(p => p.day.status === 'working' && p.day.late);
          const after9 = b.time > '09:00';
          return (
            <>
              {b.offices.filter(o => o.terminal && !o.terminal.online).map(o => (
                <Banner key={o.officeId} icon="wifi" action={<Link to="/attendance/terminals" className="font-semibold underline">Terminals</Link>}>
                  <span className="font-semibold">{o.name} terminal is offline</span> since {fmtTime(o.terminal!.lastSeen.slice(11))}. Punches are kept on the device and arrive when it reconnects, so people there may show as not in.
                </Banner>
              ))}
              {!b.working && <Banner tone="leave" icon="calendar">Today is {b.dayLabel || 'a day off'}. No attendance is expected.</Banner>}

              <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat label="In the office" tone="bg-present" value={b.counts.in} hint={`of ${b.counts.total} expected`} onClick={() => setList('in')} />
                <Stat label="Not in yet" tone={after9 ? 'bg-absent' : 'border-2 border-off'} value={b.counts.notIn} hint={after9 ? 'Past 9:00 AM' : 'Office starts at 9:00 AM'} onClick={() => setList('notIn')} />
                <Stat label="On leave" tone="bg-leave" value={b.counts.onLeave} hint="Approved for today" onClick={() => setList('onLeave')} />
                <Stat label="Waiting for you" tone="bg-ink" value={queue.data?.length ?? b.counts.waiting} hint="Leave and corrections" onClick={() => queueRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })} />
              </div>

              <div className="mt-6 grid gap-6 lg:grid-cols-2">
                <section>
                  <SectionTitle right={<Link to="/attendance" className="text-[13px] font-medium text-slate hover:text-ink">Open register</Link>}>{after9 ? 'Not in by 9:00 AM' : 'Not in yet'}</SectionTitle>
                  <Card>
                    {notIn.length === 0 && late.length === 0 ? (
                      <Empty title={b.working ? 'Everyone is in' : 'Day off'} text={b.working ? 'All expected people have punched in on time.' : undefined} />
                    ) : (
                      <ul className="divide-y divide-mist">
                        {notIn.map(p => (
                          <li key={p.employeeId}>
                            <button onClick={() => setDay({ employeeId: p.employeeId, date: b.date })} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-ivory">
                              <Avatar name={p.name} /><span className="min-w-0 flex-1"><span className="block truncate font-medium">{p.name}</span><span className="block text-[13px] text-slate">{p.officeName}</span></span>
                              {dayChip(p.day)}
                            </button>
                          </li>
                        ))}
                        {late.map(p => (
                          <li key={p.employeeId} className={cx(fresh.includes(p.employeeId) && 'anim-row-in')}>
                            <button onClick={() => setDay({ employeeId: p.employeeId, date: b.date })} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-ivory">
                              <Avatar name={p.name} /><span className="min-w-0 flex-1"><span className="block truncate font-medium">{p.name}</span><span className="block text-[13px] text-slate">{p.officeName} · came in {fmtTime(p.day.inTime)}</span></span>
                              <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-mist bg-white px-2 text-[12px] font-medium"><span className="h-2 w-2 rounded-full bg-half" />Half day (late)</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                  <p className="mt-2 text-[13px] text-slate">Updates on its own as punches arrive from the terminals.</p>
                </section>

                <section ref={queueRef} className="scroll-mt-32">
                  <SectionTitle right={<Link to="/leave" className="text-[13px] font-medium text-slate hover:text-ink">All requests</Link>}>Waiting for you</SectionTitle>
                  <Card>
                    <Load q={queue} skeleton={<div className="p-4"><Skeleton className="h-16 w-full" /></div>}>
                      {q => q.length === 0
                        ? <Empty title="All caught up" text={user!.role === 'admin' ? 'Requests from office heads and anything waiting more than 2 working days show up here.' : 'New leave and correction requests from your office show up here.'} />
                        : <div className="divide-y divide-mist">{q.map(r => <RequestItem key={r.id} r={r} showOffice={user!.role === 'admin'} onChanged={refresh} />)}</div>}
                    </Load>
                  </Card>
                </section>
              </div>

              <section className="mt-6">
                <SectionTitle>{b.offices.length > 1 ? 'Offices, on time this month' : 'On time this month'}</SectionTitle>
                {b.offices.length === 1 ? (
                  <Card className="flex flex-wrap items-center gap-6 p-5">
                    <Ring value={(b.offices[0].onTime ?? 0) / 100} size={104}><span className="font-serif text-2xl font-semibold tnum">{b.offices[0].onTime ?? 0}%</span></Ring>
                    <div className="min-w-0 flex-1 basis-48">
                      <div className="font-semibold">{b.offices[0].name} · {b.offices[0].headcount} people</div>
                      <p className="mt-1 text-slate">Share of check-ins at or before 9:00 AM. Last month was {b.offices[0].lastMonth ?? 0}%.</p>
                      <TerminalLine online={b.offices[0].terminal?.online ?? false} />
                    </div>
                    {mine.data && (
                      <Link to="/me" className="rounded-lg border border-mist px-4 py-3 transition-colors hover:border-slate">
                        <div className="text-[13px] text-slate">Your own day</div>
                        <div className="mt-1">{dayChip(mine.data.today)}</div>
                        <div className="mt-1 flex items-center gap-1 text-[13px]"><Icon name="flame" size={14} className="text-brass" />{mine.data.streak.current} days on time</div>
                      </Link>
                    )}
                  </Card>
                ) : (
                  <Card className="divide-y divide-mist">
                    {b.offices.map(o => (
                      <div key={o.officeId} className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-4">
                        <div className="w-60">
                          <div className="flex items-center gap-2 whitespace-nowrap font-semibold">{o.name}{o.best && <Tag tone="brass">Best last month</Tag>}</div>
                          <div className="text-[13px] text-slate">{o.headcount} people</div>
                        </div>
                        <div className="min-w-40 flex-1"><Bar value={(o.onTime ?? 0) / 100} /><div className="mt-1 text-[13px] text-slate">Last month {o.lastMonth ?? 0}%</div></div>
                        <div className="w-16 text-right font-serif text-2xl font-semibold tnum">{o.onTime ?? 0}%</div>
                        <div className="w-28"><TerminalLine online={o.terminal?.online ?? false} /></div>
                      </div>
                    ))}
                  </Card>
                )}
              </section>

              <Drawer open={!!list} onClose={() => setList(null)} title={list ? LIST_TITLE[list] : ''} sub={`${label} · ${fmtTime(b.time)}`}>
                {list && (pick(list, b.people).length === 0 ? <Empty title="Nobody here" /> : (
                  <ul className="-mx-2 divide-y divide-mist">
                    {pick(list, b.people).map(p => (
                      <li key={p.employeeId}>
                        <button onClick={() => { setList(null); setDay({ employeeId: p.employeeId, date: b.date }); }} className="flex w-full items-center gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-ivory">
                          <Avatar name={p.name} /><span className="min-w-0 flex-1"><span className="block truncate font-medium">{p.name}</span><span className="block text-[13px] text-slate">{p.officeName}</span></span>
                          {dayChip(p.day)}
                        </button>
                      </li>
                    ))}
                  </ul>
                ))}
              </Drawer>
            </>
          );
        }}
      </Load>
      <DayDrawer target={day} onClose={() => setDay(null)} onChanged={refresh} />
    </div>
  );
}

function TerminalLine({ online }: { online: boolean }) {
  return (
    <div className="mt-1 flex items-center gap-1.5 text-[13px] text-slate">
      <span className={cx('h-2 w-2 rounded-full', online ? 'anim-pulse bg-present' : 'bg-absent')} />Terminal {online ? 'online' : 'offline'}
    </div>
  );
}
