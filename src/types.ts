// Shared types: the shapes the API returns.
// Dates and times are local office time (Asia/Kolkata) with no zone suffix.
export type Ymd = string; // 2026-11-23
export type Month = string; // 2026-11
export type LocalDateTime = string; // 2026-11-23T09:12
export type Role = 'admin' | 'head' | 'employee';
export type LeaveType = 'CL' | 'PL' | 'UNPAID';
export type HalfDay = 'none' | 'first' | 'second';
export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface Settings {
  companyName: string;
  defaultClQuota: number;
  defaultPlQuota: number;
  plCarryMax: number; // 30
  escalateAfterWorkingDays: number; // 2
  leaveYearStart: number; // 1 = January
  // Office timings, taken from the offices for the rules card.
  startTime: string; // 09:00
  fullDayHours: number; // 9
  halfDayHours: number; // 4.5
}

export interface TerminalStatus { id: string; officeId: string; officeName: string; name: string; serial: string; online: boolean; lastSeen: LocalDateTime | null; punchesToday: number; }
export interface UnregisteredTerminal { serial: string; firstSeen: LocalDateTime; lastSeen: LocalDateTime; requests: number; }
export interface UnmatchedPunch { id: string; terminalUserId: string; at: LocalDateTime; receivedAt: LocalDateTime; terminalName: string; officeId: string; officeName: string; }
export interface RecentPunch { at: LocalDateTime; employeeId: string | null; name: string; terminalUserId: string; terminalName: string; matched: boolean; other: boolean; }

export interface Office { id: string; number: number; name: string; address: string; startTime: string; fullDayHours: number; halfDayHours: number; headId: string | null; }
export interface OfficeSummary extends Office { headName: string | null; headcount: number; terminal: TerminalStatus | null; }

export interface Employee {
  id: string; code: string; name: string; email: string; phone: string; officeId: string; role: Role;
  designation: string; joinDate: Ymd; lastWorkingDate: Ymd | null; status: 'active' | 'invited' | 'inactive';
  terminalUserId: string; clQuota: number; plQuota: number; bestStreak: number;
}
export interface SalaryRevision { id: string; employeeId: string; amount: number; effectiveMonth: Month; setBy: string | null; setByName?: string; setAt: LocalDateTime; }

export interface Holiday { id: string; date: Ymd; name: string; officeIds: string[]; kind: 'holiday' | 'working' | 'off'; }
export interface HolidayRow extends Holiday { offices: string; canEdit: boolean; }
export interface Notification { id: string; userId: string; type?: string; text: string; at: LocalDateTime; read: boolean; link: string; }
export interface AuditEntry { id: string; at: LocalDateTime; actorId: string | null; actorName: string; officeId: string | null; action: string; detail: string; entity?: string; old?: unknown; new?: unknown; }
export interface SessionUser {
  /** The employee id for heads and employees. The user id for the admin, who is not an employee. */
  id: string; userId: string; employeeId: string | null; code: string | null;
  name: string; email: string; role: Role; officeId: string | null; officeName: string | null;
}

// ---------- computed views ----------
export type DayStatus =
  | 'present' | 'half_late' | 'half_short' | 'missing' | 'absent' | 'leave'
  | 'off' | 'holiday' | 'not_in' | 'working' | 'future' | 'not_joined';

export interface DayView {
  date: Ymd; status: DayStatus; label: string;
  inTime: string | null; outTime: string | null; workedMin: number;
  unpaid: number; // 0, 0.5 or 1
  late: boolean; manual: boolean; otherOffice: string | null;
  leaveType?: LeaveType; halfLeave?: boolean; holidayName?: string;
}

export interface PayrollRow {
  employeeId: string; name: string; code: string; designation: string; salary: number; calendarDays: number; dayRate: number;
  present: number; half: number; absent: number; paidLeave: number; unpaidLeave: number; missing: number; notEmployed: number;
  unpaidDays: number; deduction: number; net: number;
  trace: { date: Ymd; label: string; unpaid: number }[];
}
export interface PayrollTotals { salary: number; unpaidDays: number; deduction: number; net: number; people: number; }

export interface LeaveBalance { quota: number; balance: number; pending: number; available: number; }
export interface Balances { cl: LeaveBalance; pl: LeaveBalance; }
export interface LedgerEntry { id: string; type: 'CL' | 'PL'; days: number; reason: string; ref: string | null; date: Ymd; byName: string; at: LocalDateTime; }

export interface RequestRow {
  id: string; kind: 'leave' | 'correction'; employeeId: string; employeeName: string; employeeCode: string; officeId: string; officeName: string;
  title: string; detail: string; reason: string; status: RequestStatus; createdAt: LocalDateTime;
  escalated: boolean; fromHead: boolean; canAct: boolean; decidedByName?: string; decidedAt?: LocalDateTime; comment?: string;
  dates: Ymd[];
  /** A correction a manager entered directly. */
  direct?: boolean;
  inTime?: string | null; outTime?: string | null;
  leaveType?: LeaveType; from?: Ymd; to?: Ymd; halfDay?: HalfDay; half?: boolean; days?: number;
  /** Approved leave this person may cancel. */
  canCancelApproved?: boolean;
}

export interface Badge { key: string; label: string; earned: boolean; hint: string; earnedOn?: Ymd; count?: number; }
export interface EmployeeRow extends Employee { officeName: string; salary: number | null; isHead: boolean; }
export interface EmployeeDetail {
  employee: EmployeeRow; salaryHistory: SalaryRevision[]; balances: Balances;
  month: { month: Month; present: number; half: number; absent: number; leave: number; missing: number };
  streak: { current: number; best: number }; badges: Badge[];
  recent: RequestRow[]; canEdit: boolean; canSeeSalary: boolean; inviteToken: string | null;
}
export interface NewEmployeeInput {
  name: string; email: string; phone: string; officeId: string; designation: string; joinDate: Ymd;
  salary: number; effectiveMonth: Month; clQuota: number; plQuota: number; role?: 'employee' | 'head';
}

export interface TodayPerson { employeeId: string; name: string; code: string; officeId: string; officeName: string; day: DayView; }
export interface TodayBoard {
  date: Ymd; time: string; working: boolean; dayLabel: string;
  counts: { total: number; in: number; notIn: number; onLeave: number; waiting: number };
  people: TodayPerson[];
  offices: { officeId: string; name: string; headcount: number; onTime: number | null; lastMonth: number | null; best: boolean; terminal: TerminalStatus | null }[];
}

export interface RegisterRow {
  employeeId: string; name: string; code: string; officeId: string; days: DayView[];
  totals: { present: number; half: number; absent: number; leave: number; missing: number; unpaid: number };
}
export interface RegisterData {
  month: Month; dates: Ymd[]; rows: RegisterRow[];
  totals: { present: number; half: number; absent: number; leave: number; missing: number };
  locks: { officeId: string; officeName: string; lockedAt: LocalDateTime | null; lockedByName: string }[];
}
export interface DayDetail {
  employee: { id: string; name: string; code: string; officeId: string; officeName: string };
  day: DayView;
  punches: { time: string; terminalName: string; officeName: string; other: boolean }[];
  manual: { inTime: string | null; outTime: string | null; reason: string; byName: string; at: LocalDateTime | null } | null;
  requests: RequestRow[]; canCorrect: boolean; lockedNote: string | null;
}

export interface PayrollData {
  officeId: string; officeName: string; month: Month; rows: PayrollRow[]; totals: PayrollTotals;
  monthClosed: boolean; reviewed: boolean; reviewedByName: string | null;
  locked: boolean; lockedByName: string | null; lockedAt: LocalDateTime | null;
  missing: { employeeId: string; name: string; date: Ymd; inTime: string | null; outTime: string | null; request: RequestRow | null }[];
  pending: RequestRow[]; blockers: string[]; canLock: boolean; canUnlock: boolean;
}
export interface OfficePayroll { officeId: string; officeName: string; headName: string | null; totals: PayrollTotals; locked: boolean; lockedAt: LocalDateTime | null; reviewed: boolean; missing: number; }
export interface ChangeLine { at: LocalDateTime; byName: string; detail: string; old?: unknown; new?: unknown; }
export interface LockSummary {
  officeId: string; officeName: string; month: Month; locked: boolean; lockedAt: LocalDateTime | null; lockedByName: string | null; totals: PayrollTotals;
  corrections: { employeeName: string; date: Ymd; detail: string; reason: string; byName: string; direct: boolean }[];
  balanceAdjustments: ChangeLine[]; quotaChanges: ChangeLine[]; salaryChanges: ChangeLine[];
}
export interface Payslip {
  company: string; month: Month; employee: { id: string; name: string; code: string; designation: string; officeName: string; joinDate: Ymd };
  row: PayrollRow; lockedAt: LocalDateTime; lockedByName: string;
}
export interface PayslipListItem { employeeId: string; name: string; code: string; month: Month; net: number; salary: number; unpaidDays: number; }

export interface MyHome {
  employee: EmployeeRow; today: DayView; dayKindLabel: string; time: string;
  missing: DayView[]; streak: { current: number; best: number }; badges: Badge[];
  balances: Balances; pending: RequestRow[]; nextHoliday: { date: Ymd; name: string } | null;
  latestPayslip: PayslipListItem | null; month: { present: number; half: number; absent: number; leave: number }; firstDays: boolean;
}
export interface MyMonth { month: Month; days: DayView[]; totals: { present: number; half: number; absent: number; leave: number; missing: number }; locked: boolean; pendingDates: Ymd[]; }
export interface LeavePreview { days: number; ok: boolean; message: string | null; balanceAfter: number | null; balance: number | null; }
export interface CalendarDay { date: Ymd; holiday: string | null; off: boolean; people: { employeeId: string; name: string; type: LeaveType; half: boolean; halfDay?: HalfDay; pending: boolean }[]; }
export interface SearchHit { type: 'person' | 'date' | 'request' | 'payslip' | 'screen'; label: string; sub: string; to: string; }
export interface Page<T> { items: T[]; total: number; page: number; pageSize: number; }
