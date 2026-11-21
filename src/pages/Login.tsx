import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { homeFor, useAuth } from '../auth';
import { useInvite } from '../api/hooks';
import { Button, cx, ErrorBox, Field, Icon, Skeleton, useAction } from '../ui';

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
      <p className="mt-3 text-[13px] text-slate"><Link to="/forgot" className="border-b border-dashed border-slate font-medium hover:text-ink">Forgot your password?</Link> There is no sign up here: your office head adds you.</p>
    </Shell>
  );
}

/** Asks for the work email and sends a reset link. The answer is the same whether or not the address is known. */
export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const act = useAction(async () => { await api.forgotPassword(email); setSent(true); });
  return (
    <Shell>
      <div className="mb-8 font-serif text-xl font-semibold lg:hidden">SBM Management</div>
      {sent ? (
        <>
          <span className="anim-pop flex h-14 w-14 items-center justify-center rounded-full bg-present text-white"><Icon name="check" size={28} /></span>
          <h1 className="mt-4 font-serif text-[28px] font-semibold">Check your email</h1>
          <p className="mt-1 text-slate">If {email} is registered, a link to choose a new password is on its way. It works once and is valid for one hour.</p>
          <Link to="/login" className="btn btn-secondary mt-6">Back to sign in</Link>
        </>
      ) : (
        <>
          <h1 className="font-serif text-[28px] font-semibold">Forgot your password?</h1>
          <p className="mt-1 text-slate">Enter your work email and we will send you a link to choose a new one.</p>
          <form className="mt-6 space-y-4" onSubmit={e => { e.preventDefault(); act.run(); }}>
            <Field label="Email" error={act.error}><input autoFocus className={cx('input', act.error && 'invalid')} type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required /></Field>
            <Button variant="primary" type="submit" state={act.state} className="w-full">Send the link</Button>
          </form>
          <p className="mt-3 text-[13px] text-slate"><Link to="/login" className="border-b border-dashed border-slate font-medium hover:text-ink">Back to sign in</Link></p>
        </>
      )}
    </Shell>
  );
}

/**
 * The link in the invite email opens this: the new employee picks a password and lands on their home.
 * The link in a reset email opens the same form.
 */
export function SetPassword({ kind = 'invite' }: { kind?: 'invite' | 'reset' }) {
  const { token = '' } = useParams();
  const { setUser } = useAuth();
  const nav = useNavigate();
  const q = useInvite(token, kind);
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [touched, setTouched] = useState({ pw: false, again: false });
  const pwErr = touched.pw && pw.length < 8 ? 'Use at least 8 characters.' : '';
  const againErr = touched.again && again !== pw ? 'The two passwords do not match.' : '';
  const act = useAction(async () => {
    const u = kind === 'invite' ? await api.setPassword(token, pw) : await api.resetPassword(token, pw);
    setUser(u); nav(homeFor(u), { replace: true });
  });
  return (
    <Shell>
      {q.error ? <><ErrorBox error={q.error} /><p className="mt-4 text-center text-[13px]"><Link to="/login" className="border-b border-dashed border-slate font-medium text-slate hover:text-ink">Back to sign in</Link></p></>
        : !q.data ? <div className="space-y-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div> : (
        <>
          <div className="mb-8 font-serif text-xl font-semibold lg:hidden">{q.data.companyName}</div>
          <h1 className="font-serif text-[28px] font-semibold">{kind === 'invite' ? `Welcome, ${q.data.name.split(' ')[0]}` : 'Choose a new password'}</h1>
          <p className="mt-1 text-slate">{kind === 'invite' ? `You have been added to ${q.data.officeName}. Choose a password to finish.` : 'You will be signed in, and signed out everywhere else.'}</p>
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
