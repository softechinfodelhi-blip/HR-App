// TanStack Query hooks: one per read. Each returns the small `Query` shape the screens' <Load> expects,
// so loading, empty and error states come straight from the real request.
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { Month, RequestRow, RequestStatus, Ymd } from '../types';
import { api } from './index';
import { qs } from './http';

export interface Query<T> { data: T | undefined; error: unknown; loading: boolean; reload: () => Promise<void>; }
interface Options { pollMs?: number; enabled?: boolean; }

function useQ<T>(key: QueryKey, fn: () => Promise<T>, opts: Options = {}): Query<T> {
  const q = useQuery({
    queryKey: key, queryFn: fn, enabled: opts.enabled ?? true,
    refetchInterval: opts.pollMs, placeholderData: keepPreviousData, // keep the old rows on screen while a filter changes
  });
  return {
    data: q.data,
    // With data on screen, a failed background refresh stays quiet. Without data, the error is shown.
    error: q.data === undefined ? q.error : null,
    loading: q.isPending || (q.isFetching && q.isPlaceholderData),
    reload: async () => { await q.refetch(); },
  };
}

// ----- organisation, people -----
export const useOffices = (userId: string) => useQ(['offices', userId], () => api.offices());
export const useSettings = () => useQ(['settings'], () => api.settings());
export const useEmployees = (scope: string, search = '', status = 'all') => useQ(['employees', scope, search, status], () => api.employees({ scope, search, status }));
export const useEmployee = (id: string) => useQ(['employee', id], () => api.employee(id));
export const useLedger = (id: string, enabled: boolean) => useQ(['ledger', id], () => api.ledger(id), { enabled });

// ----- attendance -----
export const useToday = (scope: string) => useQ(['today', scope], () => api.today(scope), { pollMs: 60_000 }); // the live stream refreshes it sooner
export const useRegister = (scope: string, month: Month) => useQ(['register', scope, month], () => api.register(scope, month), { pollMs: 60_000 });
export const useDay = (employeeId: string, date: Ymd) => useQ(['day', employeeId, date], () => api.day(employeeId, date));
export const useTerminals = (scope: string) => useQ(['terminals', scope], () => api.terminals(scope), { pollMs: 15_000 });
export const useUnregisteredTerminals = () => useQ(['terminals-unregistered'], () => api.unregisteredTerminals(), { pollMs: 15_000 });
export const useRecentPunches = (scope: string) => useQ(['punches', scope], () => api.recentPunches(scope), { pollMs: 15_000 });
export const useUnmatchedPunches = (scope: string) => useQ(['punches-unmatched', scope], () => api.unmatchedPunches(scope), { pollMs: 30_000 });

// ----- requests, leave -----
export const useRequests = (scope: string, kind: 'leave' | 'correction', status: RequestStatus | 'decided', pollMs?: number) =>
  useQ(['requests', scope, kind, status], () => api.requests({ scope, kind, status }), { pollMs });
export const useQueue = (scope: string) => useQ(['queue', scope], () => api.queue(scope), { pollMs: 30_000 });
export const useMyRequests = () => useQ(['my-requests'], () => api.myRequests());
export const useMyBalances = () => useQ(['my-balances'], () => api.myBalances());
export const useLeaveCalendar = (scope: string, month: Month) => useQ(['leave-calendar', scope, month], () => api.leaveCalendar(scope, month));
export const useHolidays = (scope: string, year: number) => useQ(['holidays', scope, year], () => api.holidays(scope, year));

// ----- payroll -----
export const usePayrollOverview = (month: Month) => useQ(['payroll-overview', month], () => api.payrollOverview(month));
export const usePayroll = (officeId: string, month: Month) => useQ(['payroll', officeId, month], () => api.payroll(officeId, month));
export const useLockSummary = (officeId: string, month: Month, enabled: boolean) => useQ(['lock-summary', officeId, month], () => api.lockSummary(officeId, month), { enabled });
export const usePayslips = (scope: string, month: Month) => useQ(['payslips', scope, month], () => api.payslips(scope, month));
export const usePayslip = (employeeId: string, month: Month) => useQ(['payslip', employeeId, month], () => api.payslip(employeeId, month));
export const useMyPayslips = () => useQ(['my-payslips'], () => api.myPayslips());

// ----- employee self service -----
export const useMyHome = (enabled = true) => useQ(['my-home'], () => api.myHome(), { pollMs: 30_000, enabled });
export const useMyMonth = (month: Month) => useQ(['my-month', month], () => api.myMonth(month), { pollMs: 60_000 });

// ----- shell -----
export const useNotifications = (userId: string) => useQ(['notifications', userId], () => api.notifications(), { pollMs: 15_000 });
export const useAudit = (scope: string, search: string) => useQ(['audit', scope, search], () => api.audit({ scope, search }));
export const useInvite = (token: string, kind: 'invite' | 'reset') =>
  useQ([kind, token], async () => (kind === 'invite' ? api.invite(token) : { ...(await api.resetInfo(token)), officeName: '' }));

// ---------------------------------------------------------------------
/**
 * Approve or reject, optimistically: the row shows the decision before the server has answered.
 * If the server refuses, the lists are put back and the error is thrown to the caller.
 */
export function useDecide() {
  const qc = useQueryClient();
  const isRows = (v: unknown): v is RequestRow[] => Array.isArray(v) && (v.length === 0 || (typeof v[0] === 'object' && v[0] !== null && 'canAct' in v[0]));
  return useMutation({
    mutationFn: (v: { id: string; decision: 'approved' | 'rejected'; comment?: string }) => api.decide(v.id, v.decision, v.comment ?? ''),
    onMutate: async v => {
      const keys = [['queue'], ['requests']];
      await Promise.all(keys.map(k => qc.cancelQueries({ queryKey: k })));
      const before = keys.flatMap(k => qc.getQueriesData<RequestRow[]>({ queryKey: k }));
      for (const [key, rows] of before) {
        if (!isRows(rows)) continue;
        // The row takes its new status at once. It stays in place for a moment so the tick can be seen.
        qc.setQueryData<RequestRow[]>(key, rows.map(r => (r.id === v.id ? { ...r, status: v.decision, canAct: false } : r)));
      }
      return { before };
    },
    onError: (_e, _v, ctx) => { for (const [key, rows] of ctx?.before ?? []) qc.setQueryData(key, rows); },
    // Then the server's answer replaces the guess everywhere (lists, counts, the register, balances).
    onSettled: () => { setTimeout(() => void qc.invalidateQueries(), 450); },
  });
}

/**
 * The live board. Subscribes to the server's event stream (Server-Sent Events) and refreshes
 * today's figures the moment a punch arrives or a day is recomputed.
 */
export function useLiveBoard(scope: string) {
  const qc = useQueryClient();
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const es = new EventSource(`/api/live${qs({ office: scope })}`);
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Several punches often arrive together: one refresh for the burst.
    const refresh = (keys: string[]) => () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { for (const k of keys) void qc.invalidateQueries({ queryKey: [k] }); }, 250);
    };
    es.addEventListener('punch', refresh(['today', 'punches', 'punches-unmatched', 'terminals']));
    es.addEventListener('day', refresh(['today', 'register']));
    es.addEventListener('device', refresh(['today', 'terminals', 'terminals-unregistered', 'offices']));
    // The browser reconnects by itself after an error or when the server ends the stream.
    return () => { if (timer) clearTimeout(timer); es.close(); };
  }, [scope, qc]);
}
