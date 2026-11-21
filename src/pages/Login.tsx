import { useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { homeFor, useAuth } from '../auth';
import { Button, cx, ErrorBox, Field, Icon, Skeleton, useAction, useData } from '../ui';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-full lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <div className="hidden flex-col justify-between bg-ink p-12 text-white lg:flex">
        <div className="font-serif text-2xl font-semibold">SBM Management</div>
        <div>
          <div className="mb-4 h-1 w-12 rounded-full bg-brass" />
          <p className="max-w-sm font-serif text-3xl font-semibold leading-snug">Attendance, leave and salary for all three offices.</p>
          <p className="mt-3 max-w-sm text-white/60">Punches come straight from the office terminals. Nothing to fill in by hand.</p>
        </div>
        <div className="text-[13px] text-white/50">Internal use only</div>
      </div>
      <div className="flex items-center justify-center px-5 py-10">
        <div className="anim-fade-up w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}

const DEMO = [
  { label: 'Admin', name: 'Anita Verma', email: 'anita.verma@sbm.example' },
  { label: 'Office head', name: 'Vikram Singh, Office 1', email: 'vikram.singh@sbm.example' },
  { label: 'Employee', name: 'Priya Nair, Office 1', email: 'priya.nair@sbm.example' },
];

export function Login() {
  const { user, signIn } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const act = useAction(async (e: string, p: string) => { const u = await signIn(e, p); nav(homeFor(u), { replace: true }); });
  if (user) return <Navigate to={homeFor(user)} replace />;
  return (
    <Shell>
      <div className="mb-8 font-serif text-xl font-semibold lg:hidden">SBM Management</div>
      <h1 className="font-serif text-[28px] font-semibold">Sign in</h1>
      <p className="mt-1 text-slate">Use your work email.</p>
      <form className="mt-6 space-y-4" onSubmit={e => { e.preventDefault(); act.run(email, password); }}>
        <Field label="Email"><input className="input" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required /></Field>
        <Field label="Password" error={act.error}>
          <input className={cx('input', act.error && 'invalid anim-shake')} type="password" autoComplete="current-password" value={password} onChange={e => { setPassword(e.target.value); act.setError(''); }} required />
        </Field>
        <Button variant="primary" type="submit" state={act.state} className="w-full">Sign in</Button>
      </form>
      <p className="mt-3 text-[13px] text-slate">Forgot your password? Ask your office head to send a new invite link.</p>
      <div className="mt-8 rounded-xl border border-mist bg-white p-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate">Demo accounts, one click</div>
        <div className="space-y-2">
          {DEMO.map(d => (
            <button key={d.email} onClick={() => { setEmail(d.email); setPassword('demo1234'); act.run(d.email, 'demo1234'); }}
              className="flex w-full items-center gap-3 rounded-lg border border-mist px-3 py-2 text-left transition-colors hover:border-slate">
              <span className="flex-1"><span className="block font-medium">{d.label}</span><span className="block text-[13px] text-slate">{d.name}</span></span>
              <Icon name="right" size={16} className="text-slate" />
            </button>
          ))}
        </div>
      </div>
    </Shell>
  );
}

/** The link in the invite email opens this. The new employee picks a password and lands on their home. */
export function SetPassword() {
  const { token = '' } = useParams();
  const { setUser } = useAuth();
  const nav = useNavigate();
  const q = useData(() => api.invite(token), [token]);
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [touched, setTouched] = useState({ pw: false, again: false });
  const pwErr = touched.pw && pw.length < 8 ? 'Use at least 8 characters.' : '';
  const againErr = touched.again && again !== pw ? 'The two passwords do not match.' : '';
  const act = useAction(async () => { const u = await api.setPassword(token, pw); setUser(u); nav('/me', { replace: true }); });
  return (
    <Shell>
      {q.error ? <ErrorBox error={q.error} /> : !q.data ? <div className="space-y-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div> : (
        <>
          <div className="mb-8 font-serif text-xl font-semibold lg:hidden">{q.data.companyName}</div>
          <h1 className="font-serif text-[28px] font-semibold">Welcome, {q.data.name.split(' ')[0]}</h1>
          <p className="mt-1 text-slate">You have been added to {q.data.officeName}. Choose a password to finish.</p>
          <form className="mt-6 space-y-4" onSubmit={e => { e.preventDefault(); setTouched({ pw: true, again: true }); if (pw.length >= 8 && pw === again) act.run(); }}>
            <Field label="Email"><input className="input" value={q.data.email} disabled /></Field>
            <Field label="New password" error={pwErr} hint="At least 8 characters.">
              <input className={cx('input', pwErr && 'invalid')} type="password" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} onBlur={() => setTouched(t => ({ ...t, pw: true }))} />
            </Field>
            <Field label="Type it again" error={againErr || act.error}>
              <input className={cx('input', againErr && 'invalid')} type="password" autoComplete="new-password" value={again} onChange={e => setAgain(e.target.value)} onBlur={() => setTouched(t => ({ ...t, again: true }))} />
            </Field>
            <Button variant="primary" type="submit" state={act.state} className="w-full">Set password and continue</Button>
          </form>
        </>
      )}
    </Shell>
  );
}
