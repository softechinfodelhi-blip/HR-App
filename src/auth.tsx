// Who is signed in. The session itself is an httpOnly cookie the browser sends by itself:
// this context only holds what GET /api/auth/me says about it.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import { queryClient, setUnauthorizedHandler } from './api/http';
import type { SessionUser } from './types';

interface Auth {
  user: SessionUser | null; ready: boolean;
  signIn: (email: string, password: string) => Promise<SessionUser>;
  signOut: () => Promise<void>;
  setUser: (u: SessionUser | null) => void;
}
const Ctx = createContext<Auth>(null as unknown as Auth);
export const useAuth = () => useContext(Ctx);
/** Where each role lands after signing in. */
export const homeFor = (u: SessionUser) => (u.role === 'employee' ? '/me' : '/');

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);
  /** Changing who is signed in throws away everything the previous person had loaded. */
  const setUser = useCallback((u: SessionUser | null) => { queryClient.clear(); setUserState(u); }, []);

  useEffect(() => {
    // Any request that comes back 401 means the session has ended: the route guards then show the sign in screen.
    setUnauthorizedHandler(() => setUser(null));
    api.me().then(u => { setUserState(u); setReady(true); }, () => setReady(true));
    return () => setUnauthorizedHandler(() => {});
  }, [setUser]);

  const signIn = async (email: string, password: string) => { const u = await api.login(email, password); setUser(u); return u; };
  const signOut = async () => { try { await api.logout(); } finally { setUser(null); } };
  return <Ctx.Provider value={{ user, ready, signIn, signOut, setUser }}>{children}</Ctx.Provider>;
}
