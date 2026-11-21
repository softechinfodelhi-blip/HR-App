// Small design system: every screen is built from these pieces. Tokens live in index.css.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Month } from './types';
import type { Query } from './api/hooks';
import { addMonths, fmtMonth, initials } from './lib/format';

export function cx(...a: (string | false | null | undefined)[]) { return a.filter(Boolean).join(' '); }
export const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Try again.');

// ---------- icons ----------
const PATHS: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  people: 'M15.5 8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0zM5 20a7 7 0 0 1 14 0',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  calendar: 'M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
  wallet: 'M19 9V6a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a2 2 0 0 1-2-2V7M16.5 14h.01',
  search: 'M21 21l-4.3-4.3M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14z',
  bell: 'M6 9a6 6 0 1 1 12 0c0 6 2 7 2 7H4s2-1 2-7zM10 20a2 2 0 0 0 4 0',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 2.4 17.5a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  right: 'M9 6l6 6-6 6',
  left: 'M15 6l-6 6 6 6',
  down: 'M6 9l6 6 6-6',
  print: 'M7 8V4h10v4M7 17H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2M7 14h10v6H7z',
  logout: 'M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3M10 16l4-4-4-4M14 12H4',
  settings: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M16 4v4M10 10v4M18 16v4',
  flame: 'M12 3c.5 3 4 5 4 9.5a4 4 0 0 1-8 0c0-1.5.6-2.6 1.2-3.2.4 1.4 1.3 2 1.3 2C10.5 8.5 11 5.5 12 3z',
  file: 'M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v5h5',
  building: 'M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 9h4a1 1 0 0 1 1 1v11M3 21h18M8 8h3M8 12h3M8 16h3',
  star: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.2 1 5.9L12 17l-5.2 2.8 1-5.9L3.5 9.7l5.9-.8z',
  wifi: 'M5 12.5a10 10 0 0 1 14 0M8 15.5a6 6 0 0 1 8 0M12 19h.01',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5 21a7 7 0 0 1 14 0',
  swap: 'M7 7h13l-3-3M17 17H4l3 3',
};
export function Icon({ name, size = 18, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={cx('shrink-0', className)} aria-hidden="true">
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}
export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="anim-spin inline-block rounded-full border-2 border-current border-t-transparent" style={{ width: size, height: size }} aria-label="Working" />;
}
function CheckMark({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path className="anim-check" d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
}

// ---------- buttons ----------
type BtnState = 'idle' | 'busy' | 'done';
interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'md' | 'sm'; state?: BtnState; icon?: string; }
/** Press scales to 0.97. `state` swaps the label for a spinner, then a drawn check. */
export function Button({ variant = 'secondary', size = 'md', state = 'idle', icon, className, children, disabled, type = 'button', ...rest }: BtnProps) {
  return (
    <button type={type} disabled={disabled || state !== 'idle'} className={cx('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', state !== 'idle' && '!opacity-100', className)} {...rest}>
      {state === 'busy' ? <Spinner size={size === 'sm' ? 13 : 16} /> : state === 'done' ? <CheckMark size={size === 'sm' ? 14 : 16} /> : icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children}
    </button>
  );
}
/** Runs an async action and drives a Button through busy and done. */
export function useAction<A extends unknown[]>(fn: (...a: A) => Promise<unknown>) {
  const [state, setState] = useState<BtnState>('idle');
  const [error, setError] = useState('');
  const run = async (...a: A): Promise<boolean> => {
    setState('busy'); setError('');
    try { await fn(...a); setState('done'); setTimeout(() => setState('idle'), 700); return true; }
    catch (e) { setError(errText(e)); setState('idle'); return false; }
  };
  return { state, error, run, setError };
}
/** Press and hold to confirm. Used only for locking a month. */
export function HoldButton({ label, holdingLabel = 'Keep holding', ms = 1000, disabled, onDone }: { label: string; holdingLabel?: string; ms?: number; disabled?: boolean; onDone: () => void }) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; setHolding(false); };
  const start = () => { if (disabled) return; setHolding(true); timer.current = setTimeout(() => { stop(); onDone(); }, ms); };
  useEffect(() => stop, []);
  return (
    <button type="button" disabled={disabled} onPointerDown={start} onPointerUp={stop} onPointerLeave={stop}
      onKeyDown={e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) start(); }} onKeyUp={stop}
      className="btn btn-primary relative overflow-hidden select-none touch-none">
      <span className="absolute inset-y-0 left-0 bg-brass" style={{ width: holding ? '100%' : '0%', transition: holding ? `width ${ms}ms linear` : 'width 120ms' }} />
      <span className="relative inline-flex items-center gap-2"><Icon name="lock" size={16} />{holding ? holdingLabel : label}</span>
    </button>
  );
}

// ---------- surfaces ----------
export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('card', className)} {...rest}>{children}</div>;
}
export function PageTitle({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-serif text-[26px] font-semibold leading-tight">{title}</h1>
        {sub && <p className="mt-1 text-slate">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return <div className="mb-3 flex items-center justify-between gap-3"><h2 className="font-serif text-lg font-semibold">{children}</h2>{right}</div>;
}
export function Tag({ tone = 'slate', children }: { tone?: 'slate' | 'brass' | 'navy' | 'absent' | 'present'; children: ReactNode }) {
  const tones = {
    slate: 'border-mist text-slate bg-ivory', brass: 'border-brass/50 text-ink bg-brass/10', navy: 'border-ink text-ink bg-white',
    absent: 'border-absent/50 text-absent bg-white', present: 'border-present/40 text-present bg-white',
  };
  return <span className={cx('inline-flex h-5 items-center rounded border px-1.5 text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap', tones[tone])}>{children}</span>;
}
export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  return <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-mist font-semibold text-ink" style={{ width: size, height: size, fontSize: size * 0.38 }}>{initials(name)}</span>;
}
export function Banner({ tone = 'half', icon = 'alert', children, action }: { tone?: 'half' | 'absent' | 'leave' | 'present'; icon?: string; children: ReactNode; action?: ReactNode }) {
  const tones = { half: 'border-half/50 bg-half/10', absent: 'border-absent/40 bg-absent/5', leave: 'border-leave/40 bg-leave/5', present: 'border-present/40 bg-present/5' };
  return (
    <div className={cx('anim-fade-up mb-4 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3', tones[tone])}>
      <Icon name={icon} /><div className="min-w-0 flex-1">{children}</div>{action}
    </div>
  );
}

// ---------- numbers and progress ----------
/** Counts up to the value over 600 ms. */
export function CountUp({ value, format = (n: number) => String(Math.round(n)) }: { value: number; format?: (n: number) => string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current, t0 = performance.now(); let raf = 0;
    if (start === value || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setShown(value); from.current = value; return; }
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / 600); const eased = 1 - Math.pow(1 - k, 3);
      setShown(start + (value - start) * eased);
      if (k < 1) raf = requestAnimationFrame(tick); else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); from.current = value; };
  }, [value]);
  return <span className="tnum">{format(shown)}</span>;
}
export function Stat({ label, value, tone, onClick, format, hint }: { label: string; value: number; tone?: string; onClick?: () => void; format?: (n: number) => string; hint?: string }) {
  const body = (
    <>
      <div className="flex items-center gap-2 text-slate">{tone && <span className={cx('h-2 w-2 rounded-full', tone)} />}<span>{label}</span></div>
      <div className="mt-1 font-serif text-[32px] font-semibold leading-none"><CountUp value={value} format={format} /></div>
      {hint && <div className="mt-1.5 text-xs text-slate">{hint}</div>}
    </>
  );
  return onClick
    ? <button onClick={onClick} className="card p-4 text-left transition-[transform,border-color] duration-200 ease-enter hover:-translate-y-0.5 hover:border-slate">{body}</button>
    : <div className="card p-4">{body}</div>;
}
/** Brass progress ring. */
export function Ring({ value, size = 96, stroke = 8, color = 'var(--color-brass)', children }: { value: number; size?: number; stroke?: number; color?: string; children?: ReactNode }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, v = Math.max(0, Math.min(1, value));
  return (
    <span className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-mist)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - v)} style={{ transition: 'stroke-dashoffset 600ms cubic-bezier(0.2,0,0,1)' }} />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center text-center">{children}</span>
    </span>
  );
}
export function Bar({ value, color = 'bg-brass' }: { value: number; color?: string }) {
  return <div className="h-1.5 w-full overflow-hidden rounded-full bg-mist"><div className={cx('h-full rounded-full transition-[width] duration-[600ms] ease-enter', color)} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} /></div>;
}

// ---------- forms ----------
export function Field({ label, error, hint, children, className }: { label: string; error?: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 block text-[13px] font-medium">{label}</span>
      {children}
      {error ? <span className="anim-fade-up mt-1 block text-[13px] text-absent">{error}</span> : hint ? <span className="mt-1 block text-[13px] text-slate">{hint}</span> : null}
    </label>
  );
}
export function Segmented<T extends string>({ value, onChange, options, size = 'md' }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; count?: number }[]; size?: 'md' | 'sm' }) {
  return (
    <div className="inline-flex rounded-lg border border-mist bg-white p-0.5" role="tablist">
      {options.map(o => (
        <button key={o.value} role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
          className={cx('rounded-md px-3 font-medium transition-colors duration-200', size === 'sm' ? 'h-7 text-[13px]' : 'h-8', value === o.value ? 'bg-ink text-white' : 'text-slate hover:text-ink')}>
          {o.label}{o.count !== undefined && <span className={cx('ml-1.5 tnum', value === o.value ? 'text-white/70' : 'text-slate')}>{o.count}</span>}
        </button>
      ))}
    </div>
  );
}
export function MonthPicker({ month, onChange, max, min }: { month: Month; onChange: (m: Month) => void; max?: Month; min?: Month }) {
  return (
    <div className="inline-flex items-center rounded-lg border border-slate bg-white">
      <button aria-label="Previous month" disabled={!!min && month <= min} onClick={() => onChange(addMonths(month, -1))} className="flex h-10 w-9 items-center justify-center rounded-l-lg hover:bg-ivory disabled:opacity-30"><Icon name="left" size={16} /></button>
      <span className="min-w-[128px] px-1 text-center font-medium">{fmtMonth(month)}</span>
      <button aria-label="Next month" disabled={!!max && month >= max} onClick={() => onChange(addMonths(month, 1))} className="flex h-10 w-9 items-center justify-center rounded-r-lg hover:bg-ivory disabled:opacity-30"><Icon name="right" size={16} /></button>
    </div>
  );
}

// ---------- states ----------
export function Skeleton({ className }: { className?: string }) { return <div className={cx('skeleton', className)} />; }
export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return <div className="card divide-y divide-mist">{Array.from({ length: rows }, (_, i) => (
    <div key={i} className="flex items-center gap-3 p-4"><Skeleton className="h-8 w-8 !rounded-full" /><div className="flex-1 space-y-2"><Skeleton className="h-3 w-1/3" /><Skeleton className="h-3 w-1/2" /></div><Skeleton className="h-6 w-20" /></div>
  ))}</div>;
}
export function Empty({ icon = 'check', title, text, action }: { icon?: string; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="anim-fade-up flex flex-col items-center px-6 py-10 text-center">
      <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-full border border-mist bg-ivory text-slate"><Icon name={icon} size={20} /></span>
      <div className="font-serif text-lg font-semibold">{title}</div>
      {text && <p className="mt-1 max-w-sm text-slate">{text}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="anim-fade-up card flex flex-col items-center px-6 py-8 text-center" role="alert">
      <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-full border border-absent/40 text-absent"><Icon name="alert" size={20} /></span>
      <div className="font-serif text-lg font-semibold">This did not load</div>
      <p className="mt-1 max-w-sm text-slate">{errText(error)}</p>
      {onRetry && <Button className="mt-4" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

// ---------- data loading ----------
// The data hooks are in api/hooks.ts. <Load> turns one into a skeleton, an error box with Retry, or the content.
export type { Query } from './api/hooks';
export function Load<T>({ q, skeleton, children }: { q: Query<T>; skeleton?: ReactNode; children: (data: T) => ReactNode }) {
  if (q.data !== undefined) return <div className={cx('transition-opacity duration-200', q.loading && 'opacity-60')}>{children(q.data)}</div>;
  if (q.error) return <ErrorBox error={q.error} onRetry={q.reload} />;
  return <>{skeleton ?? <SkeletonRows />}</>;
}

// ---------- drawer ----------
/** Slides from the right on desktop and from the bottom on a phone. Esc or the dim layer closes it. */
export function Drawer({ open, onClose, title, sub, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; sub?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  // Rendered on <body> so it always covers the whole window, whatever it is opened from.
  return createPortal(
    <div className="no-print fixed inset-0 z-40 flex items-end justify-end md:items-stretch" role="dialog" aria-modal="true">
      <div className="anim-fade-in absolute inset-0 bg-ink/40" onClick={onClose} />
      <aside className={cx('drawer-panel relative flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white shadow-xl md:max-h-none md:rounded-none', wide ? 'md:w-[560px]' : 'md:w-[440px]')}>
        <header className="flex items-start gap-3 border-b border-mist px-5 py-4">
          <div className="min-w-0 flex-1"><div className="font-serif text-xl font-semibold leading-tight">{title}</div>{sub && <div className="mt-0.5 text-slate">{sub}</div>}</div>
          <button aria-label="Close" onClick={onClose} className="-mr-1 flex h-9 w-9 items-center justify-center rounded-lg hover:bg-mist"><Icon name="x" /></button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-mist px-5 py-3">{footer}</footer>}
      </aside>
    </div>,
    document.body,
  );
}

// ---------- toast with Undo ----------
interface ToastItem { id: number; text: string; undo?: () => void | Promise<void>; }
const ToastCtx = createContext<{ show: (text: string, opts?: { undo?: () => void | Promise<void> }) => void }>({ show: () => {} });
export const useToast = () => useContext(ToastCtx);
/** One toast at a time. Reversible actions carry Undo for 5 seconds, shown by the brass bar. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [item, setItem] = useState<ToastItem | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((text: string, opts?: { undo?: () => void | Promise<void> }) => {
    if (timer.current) clearTimeout(timer.current);
    setItem({ id: Date.now(), text, undo: opts?.undo });
    timer.current = setTimeout(() => setItem(null), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={{ show }}>
      {children}
      {item && (
        <div className="no-print pointer-events-none fixed inset-x-0 bottom-20 z-50 flex justify-center px-4 lg:bottom-6" aria-live="polite">
          <div key={item.id} className="anim-toast pointer-events-auto relative flex max-w-md items-center gap-4 overflow-hidden rounded-lg bg-ink px-4 py-3 text-white shadow-lg">
            <span>{item.text}</span>
            {item.undo && <button className="font-semibold text-brass hover:underline" onClick={async () => { const u = item.undo!; setItem(null); await u(); }}>Undo</button>}
            {item.undo && <span className="anim-toast-bar absolute inset-x-0 bottom-0 h-0.5 bg-brass" />}
          </div>
        </div>
      )}
    </ToastCtx.Provider>
  );
}

/** Closes a popover when you click outside it or press Esc. */
export function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open, close]);
  return ref;
}
