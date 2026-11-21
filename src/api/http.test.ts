// The API client: errors, the signed-out handler, list unwrapping, cache refresh, and the server clock.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nowLocal, syncClock, todayYmd } from '../lib/format';
import { api, ApiError } from './index';
import { http, list, qs, queryClient, setUnauthorizedHandler } from './http';

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
const calls: { url: string; init: RequestInit }[] = [];
function serve(...replies: Reply[]) {
  let i = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = replies[Math.min(i++, replies.length - 1)];
    const status = r.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), { status, headers: { 'Content-Type': 'application/json', ...r.headers } });
  }));
}

beforeEach(() => { calls.length = 0; setUnauthorizedHandler(() => {}); syncClock(nowLocal()); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('http', () => {
  it('calls /api on the same origin with the session cookie, and JSON only when there is a body', async () => {
    serve({ body: { ok: true } });
    await http('GET', '/offices');
    await http('POST', '/leave', { type: 'CL' });
    expect(calls[0]).toMatchObject({ url: '/api/offices', init: { method: 'GET', credentials: 'same-origin', headers: undefined, body: undefined } });
    expect(calls[1]).toMatchObject({ url: '/api/leave', init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"type":"CL"}' } });
  });

  it('throws the server\'s own message, with the status', async () => {
    serve({ status: 409, body: { message: 'November 2026 is locked for this office. Ask the admin to unlock it first.' } });
    const e = await http('PUT', '/attendance/days/x/2026-11-05/manual', {}).catch(x => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 409, message: 'November 2026 is locked for this office. Ask the admin to unlock it first.' });
  });

  it('a 401 signs the app out, except on the sign in form and the first "who am I" check', async () => {
    const signedOut = vi.fn(); setUnauthorizedHandler(signedOut);
    serve({ status: 401, body: { message: 'Please sign in again.' } });
    await expect(http('GET', '/employees')).rejects.toMatchObject({ status: 401 });
    expect(signedOut).toHaveBeenCalledTimes(1);
    expect(await api.me()).toBeNull();                                   // not signed in is an answer, not an error
    await expect(api.login('a@b.c', 'wrong')).rejects.toMatchObject({ status: 401 });
    expect(signedOut).toHaveBeenCalledTimes(1);
  });

  it('gives a plain message when the server cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(http('GET', '/offices')).rejects.toThrow('Could not reach the server. Check your connection and try again.');
  });

  it('returns nothing for 204, and unwraps paginated lists', async () => {
    serve({ status: 204 }, { body: { items: [{ id: 'a' }, { id: 'b' }], total: 2, page: 1, pageSize: 500 } });
    expect(await http('POST', '/notifications/read')).toBeUndefined();
    expect(await list('/employees', { office: 'all', search: '' })).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(calls[1].url).toBe('/api/employees?pageSize=500&office=all'); // empty filters are left out
    expect(qs({ a: 1, b: undefined, c: null, d: '', e: false })).toBe('?a=1&e=false');
  });

  it('a successful write refreshes what is on screen, a read or a preview does not', async () => {
    const refresh = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    serve({ body: {} });
    await http('GET', '/offices'); expect(refresh).not.toHaveBeenCalled();
    await api.leavePreview({ type: 'CL', from: '2026-12-02', to: '2026-12-02', halfDay: 'none' }); expect(refresh).not.toHaveBeenCalled();
    await api.setSalary('e1', 30000, '2026-12'); expect(refresh).toHaveBeenCalledTimes(1);
    serve({ status: 422, body: { message: 'Enter the monthly salary.' } });
    await api.setSalary('e1', 0, '2026-12').catch(() => {}); expect(refresh).toHaveBeenCalledTimes(1); // a refused write changed nothing
    refresh.mockRestore();
  });

  it('sends leave with first or second half, and encodes holiday ids', async () => {
    serve({ body: {} });
    await api.applyLeave({ type: 'CL', from: '2026-12-02', to: '2026-12-02', halfDay: 'second', reason: 'Bank work' });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ type: 'CL', from: '2026-12-02', to: '2026-12-02', halfDay: 'second', reason: 'Bank work' });
    await api.removeHoliday('holiday~2026-11-09~Diwali%20break');
    expect(calls[1].url).toBe('/api/holidays/holiday~2026-11-09~Diwali%2520break');
    expect(api.payslipPdfUrl('e1', '2026-11')).toBe('/api/payslips/e1/2026-11/pdf');
  });
});

describe('the clock', () => {
  it('is office time (Asia/Kolkata) whatever the time zone of the device', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-22T20:15:00Z')); // 01:45 on the 23rd in India
    syncClock(nowLocal());
    expect(nowLocal()).toBe('2026-11-23T01:45'); expect(todayYmd()).toBe('2026-11-23');
  });
  it('follows the server when the device clock is wrong', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-21T06:00:00Z')); // the device says 21 Nov
    serve({ body: [], headers: { 'X-Now': '2026-12-01T10:00' } });           // the server says 1 Dec
    await api.offices();
    expect(todayYmd()).toBe('2026-12-01');
    vi.setSystemTime(new Date('2026-11-21T06:30:00Z'));                       // and it keeps ticking
    expect(nowLocal()).toBe('2026-12-01T10:30');
  });
  it('ignores a difference that is only the server rounding to the minute', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-23T03:42:50Z')); // 09:12:50
    syncClock('2026-11-23T09:12');
    expect(nowLocal()).toBe('2026-11-23T09:12');
  });
});
