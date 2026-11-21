// The one place that talks to the server. Same origin, so the session cookie goes along by itself.
import { QueryClient } from '@tanstack/react-query';
import { syncClock } from '../lib/format';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      // A 4xx is an answer, not a glitch: do not ask again. Network errors get two more tries.
      retry: (count, error) => !(error instanceof ApiError) && count < 2,
    },
  },
});

let onUnauthorized: () => void = () => {};
/** Called when any request comes back 401: the session has ended, so the app goes to the sign in screen. */
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

export interface HttpOptions {
  /** Do not treat a 401 as "signed out" (the first "who am I" check, and the sign in form itself). */
  authCheck?: boolean;
  /** A write that changes nothing on screen (a preview): do not refresh the cached data after it. */
  quiet?: boolean;
}

type Query = Record<string, string | number | boolean | null | undefined>;
export function qs(q: Query): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export async function http<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, opts: HttpOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  const serverNow = res.headers.get('X-Now');
  if (serverNow) syncClock(serverNow);

  if (!res.ok) {
    let message = res.status === 429 ? 'Too many attempts. Wait a minute and try again.' : 'Something went wrong. Try again.';
    try { const j = (await res.json()) as { message?: string }; if (j?.message) message = j.message; } catch { /* not JSON */ }
    if (res.status === 401 && !opts.authCheck) onUnauthorized();
    throw new ApiError(res.status, message);
  }
  // Anything that changed data makes what is on screen stale: refresh the active queries.
  if (method !== 'GET' && !opts.quiet) void queryClient.invalidateQueries();
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const get = <T>(path: string, q: Query = {}) => http<T>('GET', path + qs(q));
/** Every list endpoint is paginated. Screens show whole lists (an office has at most a few dozen people). */
export const list = async <T>(path: string, q: Query = {}) => (await get<{ items: T[] }>(path, { pageSize: 500, ...q })).items;
