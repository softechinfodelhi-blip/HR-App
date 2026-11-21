// The typed API client: one function per endpoint. Screens read through the hooks in ./hooks
// and write by calling these directly.
import type {
  AuditEntry, Balances, CalendarDay, DayDetail, Employee, EmployeeDetail, EmployeeRow, HalfDay, Holiday, HolidayRow, LeavePreview, LeaveType, LedgerEntry,
  LockSummary, Month, MyHome, MyMonth, NewEmployeeInput, Notification, OfficePayroll, OfficeSummary, Page, PayrollData, Payslip, PayslipListItem, RecentPunch,
  RegisterData, RequestRow, RequestStatus, SearchHit, SessionUser, Settings, TerminalStatus, TodayBoard, UnmatchedPunch, UnregisteredTerminal, Ymd,
} from '../types';
import { ApiError, get, http, list } from './http';

export { ApiError };

/** `all` (admin only) or an office id. */
type Scope = string;
const office = (scope: Scope) => ({ office: scope });
export interface LeaveInput { type: LeaveType; from: Ymd; to: Ymd; halfDay: HalfDay; }
type ServerSettings = Omit<Settings, 'startTime' | 'fullDayHours' | 'halfDayHours'>;

export const api = {
  // =====================================================================
  // Auth
  // =====================================================================
  login: (email: string, password: string) => http<SessionUser>('POST', '/auth/login', { email, password }, { authCheck: true }),
  logout: () => http<void>('POST', '/auth/logout'),
  /** Who is signed in, or null. */
  async me(): Promise<SessionUser | null> {
    try { return await http<SessionUser>('GET', '/auth/me', undefined, { authCheck: true }); }
    catch (e) { if (e instanceof ApiError && e.status === 401) return null; throw e; }
  },
  invite: (token: string) => http<{ name: string; email: string; officeName: string; companyName: string }>('GET', `/auth/invites/${token}`, undefined, { authCheck: true }),
  setPassword: (token: string, password: string) => http<SessionUser>('POST', `/auth/invites/${token}`, { password }, { authCheck: true }),
  forgotPassword: (email: string) => http<void>('POST', '/auth/forgot', { email }, { authCheck: true, quiet: true }),
  resetInfo: (token: string) => http<{ name: string; email: string; companyName: string }>('GET', `/auth/reset/${token}`, undefined, { authCheck: true }),
  resetPassword: (token: string, password: string) => http<SessionUser>('POST', `/auth/reset/${token}`, { password }, { authCheck: true }),
  changePassword: (current: string, next: string) => http<void>('POST', '/auth/password', { current, next }),

  // =====================================================================
  // Organisation
  // =====================================================================
  offices: () => get<OfficeSummary[]>('/offices'),
  createOffice: (input: { name: string; address: string; startTime?: string; fullDayHours?: number; minHalfDayHours?: number }) => http<{ id: string }>('POST', '/offices', input),
  updateOffice: (id: string, patch: { name?: string; address?: string; startTime?: string; fullDayHours?: number; minHalfDayHours?: number }) => http<void>('PATCH', `/offices/${id}`, patch),
  setOfficeHead: (officeId: string, employeeId: string) => http<void>('PUT', `/offices/${officeId}/head`, { employeeId }),
  /** Organisation settings, with the office timings added for the rules card. */
  async settings(): Promise<Settings> {
    const [s, offices] = await Promise.all([get<ServerSettings>('/settings'), get<OfficeSummary[]>('/offices').catch(() => [])]);
    const o = offices[0];
    return { ...s, startTime: o?.startTime ?? '09:00', fullDayHours: o?.fullDayHours ?? 9, halfDayHours: o?.halfDayHours ?? 4.5 };
  },
  updateSettings: (patch: Partial<Pick<Settings, 'companyName' | 'defaultClQuota' | 'defaultPlQuota' | 'plCarryMax' | 'escalateAfterWorkingDays'>>) => http<ServerSettings>('PATCH', '/settings', patch),

  // =====================================================================
  // People
  // =====================================================================
  employees: (q: { scope: Scope; search?: string; status?: string }) => list<EmployeeRow>('/employees', { office: q.scope, search: q.search, status: q.status }),
  employee: (id: string) => get<EmployeeDetail>(`/employees/${id}`),
  createEmployee: (input: NewEmployeeInput) => http<{ employee: EmployeeRow; inviteToken: string | null }>('POST', '/employees', input),
  undoCreateEmployee: (id: string) => http<void>('DELETE', `/employees/${id}`),
  updateEmployee: (id: string, patch: Partial<Pick<Employee, 'name' | 'email' | 'phone' | 'designation' | 'joinDate' | 'lastWorkingDate' | 'clQuota' | 'plQuota' | 'terminalUserId'>>) => http<void>('PATCH', `/employees/${id}`, patch),
  setSalary: (id: string, amount: number, effectiveMonth: Month) => http<void>('POST', `/employees/${id}/salary`, { amount, effectiveMonth }),
  resendInvite: (id: string) => http<{ inviteToken: string | null }>('POST', `/employees/${id}/invite`),
  setEmployeeStatus: (id: string, status: 'active' | 'inactive') => http<void>('POST', `/employees/${id}/status`, { status }),
  ledger: (id: string) => get<Page<LedgerEntry> & { balances: Balances }>(`/employees/${id}/ledger`, { pageSize: 100 }),
  adjustBalance: (id: string, input: { type: 'CL' | 'PL'; days: number; note: string }) => http<void>('POST', `/employees/${id}/leave-adjustments`, input),

  // =====================================================================
  // Attendance
  // =====================================================================
  today: (scope: Scope) => get<TodayBoard>('/attendance/today', office(scope)),
  register: (scope: Scope, month: Month) => get<RegisterData>('/attendance/register', { ...office(scope), month }),
  day: (employeeId: string, date: Ymd) => get<DayDetail>(`/attendance/days/${employeeId}/${date}`),
  correctDay: (employeeId: string, date: Ymd, input: { inTime: string | null; outTime: string | null; reason: string }) => http<void>('PUT', `/attendance/days/${employeeId}/${date}/manual`, input),
  terminals: (scope: Scope = 'all') => get<TerminalStatus[]>('/devices', office(scope)),
  unregisteredTerminals: () => get<UnregisteredTerminal[]>('/devices/unregistered'),
  registerTerminal: (input: { serialNumber: string; officeId?: string; name: string }) => http<{ id: string }>('POST', '/devices', input),
  renameTerminal: (id: string, name: string) => http<void>('PATCH', `/devices/${id}`, { name }),
  recentPunches: (scope: Scope) => list<RecentPunch>('/devices/punches', { ...office(scope), pageSize: 40 }),
  unmatchedPunches: (scope: Scope) => list<UnmatchedPunch>('/punches/unmatched', { ...office(scope), pageSize: 100 }),

  // =====================================================================
  // Requests: leave and attendance corrections
  // =====================================================================
  requests: (q: { scope: Scope; kind?: 'leave' | 'correction'; status?: RequestStatus | 'decided' }) => list<RequestRow>('/requests', { office: q.scope, kind: q.kind, status: q.status }),
  queue: (scope: Scope) => get<RequestRow[]>('/requests/queue', office(scope)),
  myRequests: () => get<RequestRow[]>('/me/requests'),
  leavePreview: (input: LeaveInput) => http<LeavePreview>('POST', '/leave/preview', input, { quiet: true }),
  applyLeave: (input: LeaveInput & { reason: string }) => http<RequestRow>('POST', '/leave', input),
  requestCorrection: (input: { date: Ymd; inTime: string | null; outTime: string | null; reason: string }) => http<RequestRow>('POST', '/corrections', input),
  decide: (id: string, decision: 'approved' | 'rejected', comment = '') => http<void>('POST', `/requests/${id}/decision`, { decision, comment }, { quiet: true }),
  /** Within 60 seconds, for the person who decided. */
  undoDecision: (id: string) => http<void>('POST', `/requests/${id}/undo`),
  /** Admin only, until the month is locked. */
  reverseDecision: (id: string, comment: string) => http<void>('POST', `/requests/${id}/reverse`, { comment }),
  /** The office head (or the admin) cancels leave that was already approved. */
  cancelApprovedLeave: (id: string, comment: string) => http<void>('POST', `/requests/${id}/cancel-approved`, { comment }),
  cancelRequest: (id: string) => http<void>('POST', `/requests/${id}/cancel`),
  undoCancel: (id: string) => http<void>('POST', `/requests/${id}/restore`),
  leaveCalendar: (scope: Scope, month: Month) => get<CalendarDay[]>('/leave/calendar', { ...office(scope), month }),
  holidays: (scope: Scope, year: number) => get<HolidayRow[]>('/holidays', { ...office(scope), year }),
  addHoliday: (input: { date: Ymd; name: string; officeIds: string[]; kind: Holiday['kind'] }) => http<Holiday>('POST', '/holidays', input),
  removeHoliday: (id: string) => http<Holiday>('DELETE', `/holidays/${encodeURIComponent(id)}`),
  /** Used by Undo: puts back what removeHoliday returned. */
  restoreHoliday: (h: Holiday) => http<Holiday>('POST', '/holidays', { date: h.date, name: h.name, officeIds: h.officeIds, kind: h.kind }),

  // =====================================================================
  // Payroll
  // =====================================================================
  payrollOverview: (month: Month) => get<OfficePayroll[]>('/payroll', { month }),
  payroll: (officeId: string, month: Month) => get<PayrollData>(`/payroll/${officeId}/${month}`),
  markReviewed: (officeId: string, month: Month, reviewed = true) => http<void>('POST', `/payroll/${officeId}/${month}/review`, { reviewed }),
  lockMonth: (officeId: string, month: Month) => http<PayrollData>('POST', `/payroll/${officeId}/${month}/lock`),
  unlockMonth: (officeId: string, month: Month, reason: string) => http<void>('POST', `/payroll/${officeId}/${month}/unlock`, { reason }),
  lockSummary: (officeId: string, month: Month) => get<LockSummary>(`/payroll/${officeId}/${month}/summary`),
  payslips: (scope: Scope, month: Month) => list<PayslipListItem>('/payslips', { ...office(scope), month }),
  myPayslips: () => get<PayslipListItem[]>('/me/payslips'),
  payslip: (employeeId: string, month: Month) => get<Payslip>(`/payslips/${employeeId}/${month}`),
  /** The PDF the server renders. */
  payslipPdfUrl: (employeeId: string, month: Month) => `/api/payslips/${employeeId}/${month}/pdf`,

  // =====================================================================
  // Employee self service
  // =====================================================================
  myHome: () => get<MyHome>('/me/home'),
  myMonth: (month: Month) => get<MyMonth>('/me/attendance', { month }),
  myBalances: () => get<Balances>('/me/balances'),

  // =====================================================================
  // Notifications, audit, search
  // =====================================================================
  notifications: async () => (await get<{ unread: number; items: Notification[] }>('/notifications')).items,
  markNotificationsRead: () => http<void>('POST', '/notifications/read'),
  audit: (q: { scope: Scope; search?: string }) => list<AuditEntry>('/audit', { office: q.scope, search: q.search, pageSize: 200 }),
  search: (q: string, scope: Scope) => (q.trim() ? get<SearchHit[]>('/search', { q: q.trim(), office: scope }) : Promise.resolve([] as SearchHit[])),
};
