// Shared types. The same shapes are described in docs/openapi.yaml.
// Dates and times are local office time (Asia/Kolkata) with no zone suffix.
export type Ymd = string; // 2026-11-23
export type Month = string; // 2026-11
export type LocalDateTime = string; // 2026-11-23T09:12
export type Role = 'admin' | 'head' | 'employee';
export type LeaveType = 'CL' | 'PL' | 'UNPAID';
export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface Settings {
  companyName: string;
  startTime: string; // 09:00
  fullDayHours: number; // 9
  halfDayHours: number; // 4.5
  escalateAfterWorkingDays: number; // 2
  plCarryMax: number; // 30
  defaultClQuota: number;
  defaultPlQuota: number;
}

export interface Office { id: string; name: string; address: string; headId: string | null; }

export interface Terminal {
  id: string; officeId: string; name: string; serial: string;
  offlineFrom?: LocalDateTime; offlineTo?: LocalDateTime; // demo outage window
}
export interface TerminalStatus extends Terminal { officeName: string; online: boolean; lastSeen: LocalDateTime; punchesToday: number; }

export interface Employee {
  id: string; name: string; email: string; phone: string; officeId: string; role: Role;
  designation: string; joinDate: Ymd; status: 'active' | 'invited' | 'inactive';
  terminalUserId: string; clQuota: number; plQuota: number; bestStreak: number;
}
export interface SalaryRevision { id: string; employeeId: string; amount: number; effectiveMonth: Month; setBy: string; setByName?: string; setAt: LocalDateTime; }

export interface Punch { id: string; employeeId: string; terminalId: string; officeId: string; at: LocalDateTime; receivedAt: LocalDateTime; }
export interface ManualDay { employeeId: string; date: Ymd; inTime: string | null; outTime: string | null; reason: string; byId: string; at: LocalDateTime; }

export interface LeaveRequest {
  id: string; kind: 'leave'; employeeId: string; type: LeaveType; from: Ymd; to: Ymd; half: boolean; days: number;
  reason: string; status: RequestStatus; createdAt: LocalDateTime; decidedBy?: string; decidedAt?: LocalDateTime; comment?: string;
}
export interface CorrectionRequest {
  id: string; kind: 'correction'; employeeId: string; date: Ymd; inTime: string | null; outTime: string | null;
  reason: string; status: RequestStatus; createdAt: LocalDateTime; decidedBy?: string; decidedAt?: LocalDateTime; comment?: string;
}
export type AnyRequest = LeaveRequest | CorrectionRequest;

export interface Holiday { id: string; date: Ymd; name: string; officeIds: string[]; kind: 'holiday' | 'working'; }
export interface MonthLock { officeId: string; month: Month; reviewedBy?: string; reviewedAt?: LocalDateTime; lockedBy?: string; lockedAt?: LocalDateTime; }
export interface Notification { id: string; userId: string; text: string; at: LocalDateTime; read: boolean; link: string; }
export interface AuditEntry { id: string; at: LocalDateTime; actorId: string; actorName: string; officeId: string | null; action: string; detail: string; }
export interface SessionUser { id: string; name: string; email: string; role: Role; officeId: string | null; officeName: string | null; }

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
  employeeId: string; name: string; designation: string; salary: number; calendarDays: number; dayRate: number;
  present: number; half: number; absent: number; paidLeave: number; unpaidLeave: number; missing: number; notEmployed: number;
  unpaidDays: number; deduction: number; net: number;
  trace: { date: Ymd; label: string; unpaid: number }[];
}
export interface PayrollTotals { salary: number; unpaidDays: number; deduction: number; net: number; people: number; }

export interface LeaveBalance { quota: number; balance: number; pending: number; available: number; }
export interface Balances { cl: LeaveBalance; pl: LeaveBalance; }

export interface RequestRow {
  id: string; kind: 'leave' | 'correction'; employeeId: string; employeeName: string; officeId: string; officeName: string;
  title: string; detail: string; reason: string; status: RequestStatus; createdAt: LocalDateTime;
  escalated: boolean; fromHead: boolean; canAct: boolean; decidedByName?: string; decidedAt?: LocalDateTime; comment?: string;
  dates: Ymd[];
}

export interface EmployeeRow extends Employee { officeName: string; salary: number | null; isHead: boolean; }
export interface EmployeeDetail {
  employee: EmployeeRow; salaryHistory: SalaryRevision[]; balances: Balances;
  month: { month: Month; present: number; half: number; absent: number; leave: number; missing: number };
  streak: { current: number; best: number };
  recent: RequestRow[]; canEdit: boolean; canSeeSalary: boolean; inviteToken: string | null;
}
export interface NewEmployeeInput {
  name: string; email: string; phone: string; officeId: string; designation: string; joinDate: Ymd;
  salary: number; effectiveMonth: Month; clQuota: number; plQuota: number; role?: Role;
}

export interface OfficeSummary extends Office { headName: string | null; headcount: number; terminal: TerminalStatus | null; }

export interface TodayPerson { employeeId: string; name: string; officeId: string; officeName: string; day: DayView; }
export interface TodayBoard {
  date: Ymd; time: string; working: boolean; dayLabel: string;
  counts: { total: number; in: number; notIn: number; onLeave: number; waiting: number };
  people: TodayPerson[];
  offices: { officeId: string; name: string; headcount: number; onTime: number | null; lastMonth: number | null; best: boolean; terminal: TerminalStatus | null }[];
}

export interface RegisterRow {
  employeeId: string; name: string; officeId: string; days: DayView[];
  totals: { present: number; half: number; absent: number; leave: number; missing: number; unpaid: number };
}
export interface RegisterData {
  month: Month; dates: Ymd[]; rows: RegisterRow[];
  totals: { present: number; half: number; absent: number; leave: number; missing: number };
  locks: { officeId: string; officeName: string; lockedAt: LocalDateTime; lockedByName: string }[];
}
export interface DayDetail {
  employee: { id: string; name: string; officeId: string; officeName: string };
  day: DayView;
  punches: { time: string; terminalName: string; officeName: string; other: boolean }[];
  manual: (ManualDay & { byName: string }) | null;
  requests: RequestRow[]; canCorrect: boolean; lockedNote: string | null;
}

export interface PayrollData {
  officeId: string; officeName: string; month: Month; rows: PayrollRow[]; totals: PayrollTotals;
  monthClosed: boolean; reviewed: boolean; reviewedByName: string | null;
  locked: boolean; lockedByName: string | null; lockedAt: LocalDateTime | null;
  missing: { employeeId: string; name: string; date: Ymd; inTime: string | null; request: RequestRow | null }[];
  pending: RequestRow[]; canLock: boolean; canUnlock: boolean;
}
export interface OfficePayroll { officeId: string; officeName: string; headName: string | null; totals: PayrollTotals; locked: boolean; lockedAt: LocalDateTime | null; missing: number; }
export interface Payslip {
  company: string; month: Month; employee: { id: string; name: string; designation: string; officeName: string; joinDate: Ymd };
  row: PayrollRow; lockedAt: LocalDateTime; lockedByName: string;
}
export interface PayslipListItem { employeeId: string; name: string; month: Month; net: number; salary: number; unpaidDays: number; }

export interface MyHome {
  employee: EmployeeRow; today: DayView; dayKindLabel: string; time: string;
  missing: DayView[]; streak: { current: number; best: number }; badges: { key: string; label: string; earned: boolean; hint: string }[];
  balances: Balances; pending: RequestRow[]; nextHoliday: Holiday | null;
  latestPayslip: PayslipListItem | null; month: { present: number; half: number; absent: number; leave: number }; firstDays: boolean;
}
export interface MyMonth { month: Month; days: DayView[]; totals: { present: number; half: number; absent: number; leave: number; missing: number }; locked: boolean; pendingDates: Ymd[]; }
export interface LeavePreview { days: number; ok: boolean; message: string | null; balanceAfter: number | null; balance: number | null; }
export interface CalendarDay { date: Ymd; holiday: string | null; off: boolean; people: { employeeId: string; name: string; type: LeaveType; half: boolean; pending: boolean }[]; }
export interface SearchHit { type: 'person' | 'screen'; label: string; sub: string; to: string; }
