import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
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
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => { api.me().then(u => { setUser(u); setReady(true); }); }, []);
  const signIn = async (email: string, password: string) => { const u = await api.login(email, password); setUser(u); return u; };
  const signOut = async () => { await api.logout(); setUser(null); };
  return <Ctx.Provider value={{ user, ready, signIn, signOut, setUser }}>{children}</Ctx.Provider>;
}
