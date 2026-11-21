// App shells. Admin and office heads share one interface (sidebar on desktop, five tabs on a phone).
// Employees get a phone-first shell with four tabs.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from './api';
import { useNotifications, useOffices } from './api/hooks';
import { useAuth } from './auth';
import { fmtDateTime } from './lib/format';
import { ScopeCtx } from './shared';
import type { SearchHit } from './types';
import { Avatar, cx, Icon, useDismiss } from './ui';

const NAV = [
  { key: '', label: 'Home', to: '/', icon: 'home' },
  { key: 'people', label: 'People', to: '/people', icon: 'people' },
  { key: 'attendance', label: 'Attendance', to: '/attendance', icon: 'clock' },
  { key: 'leave', label: 'Leave', to: '/leave', icon: 'calendar' },
  { key: 'payroll', label: 'Payroll', to: '/payroll', icon: 'wallet' },
];
const TABS: Record<string, { label: string; to: string; admin?: boolean }[]> = {
  people: [{ label: 'Employees', to: '/people' }, { label: 'Offices and heads', to: '/people/offices', admin: true }],
  attendance: [{ label: 'Register', to: '/attendance' }, { label: 'Corrections', to: '/attendance/corrections' }, { label: 'Terminals', to: '/attendance/terminals' }],
  leave: [{ label: 'Requests', to: '/leave' }, { label: 'Calendar', to: '/leave/calendar' }, { label: 'Holidays', to: '/leave/holidays' }],
  payroll: [{ label: 'Month', to: '/payroll' }, { label: 'Payslips', to: '/payroll/payslips' }],
  settings: [{ label: 'Organisation', to: '/settings', admin: true }, { label: 'Audit log', to: '/settings/audit' }],
};

export function AdminLayout() {
  const { user } = useAuth();
  const u = user!;
  const loc = useLocation();
  const section = loc.pathname.split('/')[1] ?? '';
  const officesQ = useOffices(u.id);
  const [picked, setPicked] = useState(() => { try { return sessionStorage.getItem('sbm-hr-scope') ?? 'all'; } catch { return 'all'; } });
  const scope = u.role === 'head' ? u.officeId! : picked;
  const setScope = useCallback((s: string) => { setPicked(s); try { sessionStorage.setItem('sbm-hr-scope', s); } catch { /* ignore */ } }, []);
  const offices = officesQ.data ?? [];
  const label = scope === 'all' ? 'All offices' : offices.find(o => o.id === scope)?.name ?? '';
  const scopeValue = useMemo(() => ({ scope, setScope, offices, label }), [scope, setScope, offices, label]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearching(true); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const tabs = (TABS[section] ?? []).filter(t => !t.admin || u.role === 'admin');
  const activeTab = [...tabs].sort((a, b) => b.to.length - a.to.length).find(t => loc.pathname === t.to || loc.pathname.startsWith(t.to + '/'));
  const myOffice = offices.find(o => o.id === u.officeId);

  return (
    <ScopeCtx.Provider value={scopeValue}>
      <div className="min-h-full lg:pl-60">
        {/* Sidebar: five categories only */}
        <aside className="no-print fixed inset-y-0 left-0 z-30 hidden w-60 flex-col bg-ink text-white lg:flex">
          <div className="px-6 pb-6 pt-7">
            <div className="font-serif text-xl font-semibold leading-tight">SBM Management</div>
            <div className="mt-0.5 text-[13px] text-white/60">{u.role === 'admin' ? 'Admin' : `${u.officeName} · Office head`}</div>
          </div>
          <nav className="flex-1 space-y-1 px-3">
            {NAV.map(n => {
              const on = section === n.key;
              return (
                <Link key={n.key} to={n.to} aria-current={on ? 'page' : undefined}
                  className={cx('relative flex h-11 items-center gap-3 rounded-lg px-3 font-medium transition-colors duration-200', on ? 'bg-white/10 text-white' : 'text-white/70 hover:bg-white/5 hover:text-white')}>
                  <span className={cx('absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-brass transition-opacity duration-200', on ? 'opacity-100' : 'opacity-0')} />
                  <Icon name={n.icon} />{n.label}
                </Link>
              );
            })}
          </nav>
          <div className="px-6 py-5 text-[12px] text-white/50">Internal use only</div>
        </aside>

        <header className="no-print sticky top-0 z-20 border-b border-mist bg-ivory/95 backdrop-blur">
          <div className="mx-auto flex h-16 max-w-[1200px] items-center gap-3 px-4 lg:px-8">
            <span className="font-serif text-lg font-semibold lg:hidden">SBM</span>
            <button onClick={() => setSearching(true)} className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border border-slate bg-white px-3 text-left text-slate transition-colors hover:border-ink sm:max-w-sm">
              <Icon name="search" size={16} /><span className="flex-1 truncate">Search people, dates and screens</span><kbd className="hidden rounded border border-mist px-1.5 text-[11px] sm:block">Ctrl K</kbd>
            </button>
            <div className="flex-1 max-sm:hidden" />
            {u.role === 'admin' ? (
              <select aria-label="Office" value={scope} onChange={e => setScope(e.target.value)} className="input !w-auto !pr-8 font-medium">
                <option value="all">All offices</option>
                {offices.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            ) : (
              <span className="hidden whitespace-nowrap rounded-lg border border-mist bg-white px-3 py-2 font-medium sm:block">{u.officeName}{myOffice ? ` · ${myOffice.headcount} people` : ''}</span>
            )}
            <Bell />
            <ProfileMenu />
          </div>
          {tabs.length > 0 && (
            <div className="mx-auto flex max-w-[1200px] gap-6 overflow-x-auto px-4 lg:px-8">
              {tabs.map(t => (
                <Link key={t.to} to={t.to} className={cx('relative whitespace-nowrap pb-3 pt-1 font-medium transition-colors duration-200', activeTab?.to === t.to ? 'text-ink' : 'text-slate hover:text-ink')}>
                  {t.label}
                  <span className={cx('absolute inset-x-0 bottom-0 h-0.5 origin-left rounded-full bg-brass transition-transform duration-200 ease-enter', activeTab?.to === t.to ? 'scale-x-100' : 'scale-x-0')} />
                </Link>
              ))}
            </div>
          )}
        </header>

        <main className="mx-auto max-w-[1200px] px-4 pb-28 pt-6 lg:px-8 lg:pb-12"><div key={loc.pathname} className="anim-fade-up"><Outlet /></div></main>

        <nav className="no-print fixed inset-x-0 bottom-0 z-30 grid h-16 grid-cols-5 border-t border-mist bg-white lg:hidden">
          {NAV.map(n => {
            const on = section === n.key;
            return (
              <Link key={n.key} to={n.to} className={cx('relative flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium', on ? 'text-ink' : 'text-slate')}>
                <span className={cx('absolute top-0 h-0.5 w-8 rounded-full bg-brass transition-opacity duration-200', on ? 'opacity-100' : 'opacity-0')} />
                <Icon name={n.icon} size={20} />{n.label}
              </Link>
            );
          })}
        </nav>
        {searching && <SearchModal scope={scope} onClose={() => setSearching(false)} />}
      </div>
    </ScopeCtx.Provider>
  );
}

/** Ctrl+K. Finds a person by name or ID, or jumps to a screen. */
function SearchModal({ scope, onClose }: { scope: string; onClose: () => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState(''); const [hits, setHits] = useState<SearchHit[]>([]); const [sel, setSel] = useState(0);
  useEffect(() => { let live = true; api.search(q, scope).then(h => { if (live) { setHits(h); setSel(0); } }); return () => { live = false; }; }, [q, scope]);
  const go = (h?: SearchHit) => { if (!h) return; nav(h.to); onClose(); };
  return (
    <div className="no-print fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Search">
      <div className="anim-fade-in absolute inset-0 bg-ink/40" onClick={onClose} />
      <div className="anim-fade-up relative w-full max-w-lg overflow-hidden rounded-xl bg-white shadow-xl">
        <div className="flex items-center gap-3 border-b border-mist px-4">
          <Icon name="search" className="text-slate" />
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Type a name, an employee ID, a date or a screen"
            className="h-14 flex-1 bg-transparent outline-none placeholder:text-slate"
            onKeyDown={e => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, hits.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
              if (e.key === 'Enter') go(hits[sel]);
            }} />
          <kbd className="rounded border border-mist px-1.5 text-[11px] text-slate">Esc</kbd>
        </div>
        <div className="max-h-80 overflow-y-auto p-2">
          {!q.trim() && <p className="px-3 py-6 text-center text-slate">Try a name, an employee ID, “23 Nov” or “Payroll”.</p>}
          {q.trim() && hits.length === 0 && <p className="px-3 py-6 text-center text-slate">Nothing matches “{q}”. Check the spelling or try the employee ID.</p>}
          {hits.map((h, i) => (
            <button key={h.to + h.label} onMouseEnter={() => setSel(i)} onClick={() => go(h)} className={cx('flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left', i === sel && 'bg-ivory')}>
              {h.type === 'person' ? <Avatar name={h.label} size={28} /> : <span className="flex h-7 w-7 items-center justify-center rounded-full bg-mist"><Icon name="right" size={14} /></span>}
              <span className="min-w-0 flex-1"><span className="block truncate font-medium">{h.label}</span><span className="block truncate text-[13px] text-slate">{h.sub}</span></span>
              {i === sel && <kbd className="rounded border border-mist px-1.5 text-[11px] text-slate">Enter</kbd>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Bell() {
  const { user } = useAuth();
  const nav = useNavigate();
  const q = useNotifications(user!.userId);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  const list = q.data ?? [];
  const unread = list.filter(n => !n.read).length;
  return (
    <div className="relative" ref={ref}>
      <button aria-label={`Notifications, ${unread} unread`} onClick={() => { setOpen(o => !o); }} className="relative flex h-10 w-10 items-center justify-center rounded-lg hover:bg-mist">
        <Icon name="bell" />
        {unread > 0 && <span key={unread} className="anim-pop absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-ink px-1 text-[10px] font-bold text-white">{unread}</span>}
      </button>
      {open && (
        <div className="anim-fade-up absolute right-0 top-12 z-40 w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-mist bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-mist px-4 py-3">
            <span className="font-serif text-lg font-semibold">Notifications</span>
            {unread > 0 && <button className="text-[13px] font-medium text-slate hover:text-ink" onClick={async () => { await api.markNotificationsRead(); q.reload(); }}>Mark all read</button>}
          </div>
          <div className="max-h-96 divide-y divide-mist overflow-y-auto">
            {list.length === 0 && <p className="px-4 py-8 text-center text-slate">Nothing new. You will also get these by email.</p>}
            {list.map(n => (
              <button key={n.id} onClick={async () => { close(); nav(n.link); await api.markNotificationsRead(); q.reload(); }} className="flex w-full gap-3 px-4 py-3 text-left hover:bg-ivory">
                <span className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.read ? 'bg-transparent' : 'bg-ink')} />
                <span className="min-w-0 flex-1"><span className={cx('block', !n.read && 'font-medium')}>{n.text}</span><span className="block text-[13px] text-slate">{fmtDateTime(n.at)}</span></span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ProfileMenu({ employee }: { employee?: boolean }) {
  const { user, signOut } = useAuth();
  const u = user!;
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  const item = 'flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-ivory';
  const go = (to: string) => { close(); nav(to); };
  return (
    <div className="relative" ref={ref}>
      <button aria-label="Your menu" onClick={() => setOpen(o => !o)} className="flex items-center gap-2 rounded-lg p-1 hover:bg-mist"><Avatar name={u.name} /><Icon name="down" size={14} className="max-sm:hidden" /></button>
      {open && (
        <div className="anim-fade-up absolute right-0 top-12 z-40 w-72 overflow-hidden rounded-xl border border-mist bg-white py-1 shadow-xl">
          <div className="border-b border-mist px-4 py-3">
            <div className="font-semibold">{u.name}</div>
            <div className="text-[13px] text-slate">{u.role === 'admin' ? 'Admin' : u.role === 'head' ? `Office head · ${u.officeName}` : `${u.code ?? ''} · ${u.officeName}`}</div>
          </div>
          {u.role === 'head' && !employee && <button className={item} onClick={() => go('/me')}><Icon name="user" size={16} />My attendance, leave and payslips</button>}
          {u.role === 'head' && employee && <button className={item} onClick={() => go('/')}><Icon name="building" size={16} />Back to managing {u.officeName}</button>}
          {employee && <button className={item} onClick={() => go('/me/profile')}><Icon name="user" size={16} />My profile</button>}
          {!employee && u.role === 'admin' && <button className={item} onClick={() => go('/settings')}><Icon name="settings" size={16} />Settings</button>}
          {!employee && <button className={item} onClick={() => go('/settings/audit')}><Icon name="file" size={16} />Audit log</button>}
          <button className={cx(item, 'border-t border-mist')} onClick={async () => { close(); await signOut(); nav('/login'); }}><Icon name="logout" size={16} />Sign out</button>
        </div>
      )}
    </div>
  );
}

const MY_TABS = [
  { label: 'Home', to: '/me', icon: 'home' },
  { label: 'Attendance', to: '/me/attendance', icon: 'clock' },
  { label: 'Leave', to: '/me/leave', icon: 'calendar' },
  { label: 'Payslips', to: '/me/payslips', icon: 'wallet' },
];
export function EmployeeLayout() {
  const loc = useLocation();
  const p = loc.pathname;
  const index = p === '/me' ? 0 : p.startsWith('/me/attendance') || p.startsWith('/me/correction') ? 1 : p.startsWith('/me/leave') ? 2 : p.startsWith('/me/payslips') ? 3 : -1;
  const onTab = index >= 0;
  return (
    <div className="min-h-full">
      <header className="no-print sticky top-0 z-20 border-b border-mist bg-ivory/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-xl items-center gap-2 px-4">
          <Link to="/me" className="flex-1 font-serif text-lg font-semibold">SBM Management</Link>
          <Bell />
          <ProfileMenu employee />
        </div>
      </header>
      <main className="mx-auto max-w-xl px-4 pb-28 pt-5"><div key={loc.pathname} className="anim-fade-up"><Outlet /></div></main>
      <nav className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-mist bg-white">
        <div className="relative mx-auto grid h-16 max-w-xl grid-cols-4">
          <span className={cx('absolute top-0 h-0.5 w-1/4 transition-transform duration-200 ease-enter', !onTab && 'opacity-0')} style={{ transform: `translateX(${index * 100}%)` }}>
            <span className="mx-auto block h-full w-10 rounded-full bg-brass" />
          </span>
          {MY_TABS.map((t, i) => (
            <NavLink key={t.to} to={t.to} end={t.to === '/me'} className={cx('flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium', onTab && i === index ? 'text-ink' : 'text-slate')}>
              <Icon name={t.icon} size={20} />{t.label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
