// Demo data. Deterministic, so every reset gives the same office.
// "Today" in the demo is Mon 23 Nov 2026, 9:12 AM (see db.ts for the clock).
import type {
  AuditEntry, CorrectionRequest, Employee, Holiday, LeaveRequest, ManualDay, Month, MonthLock, Notification,
  Office, PayrollRow, Punch, Role, SalaryRevision, Settings, Terminal,
} from '../types';
import { dateRange, fromMin, monthOf } from '../lib/format';
import { dayKind } from '../lib/rules';

export interface PayslipSnapshot { officeId: string; month: Month; row: PayrollRow; }
export interface Db {
  version: number;
  settings: Settings;
  offices: Office[];
  terminals: Terminal[];
  employees: Employee[]; // includes the admin (role admin, no office)
  salaries: SalaryRevision[];
  punches: Punch[];
  manualDays: ManualDay[];
  leaves: LeaveRequest[];
  corrections: CorrectionRequest[];
  holidays: Holiday[];
  locks: MonthLock[];
  payslips: PayslipSnapshot[];
  notifications: Notification[];
  audit: AuditEntry[];
  leaveOpening: Record<string, { cl: number; pl: number; creditFrom: Month }>;
  passwords: Record<string, string>;
  invites: { token: string; employeeId: string; usedAt: string | null }[];
  outbox: { to: string; subject: string; at: string }[];
  empSeq: Record<string, number>;
  seq: number;
}

export const DB_VERSION = 3;
export const DEMO_PASSWORD = 'demo1234';
export const DATA_FROM = '2026-10-01';
export const DATA_TO = '2026-12-02';

const rnd = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
};

type Row = [id: string, name: string, designation: string, salary: number, joinDate: string, role?: Role];
const STAFF: Record<string, Row[]> = {
  o1: [
    ['EMP-0102', 'Vikram Singh', 'Office Head', 85000, '2018-06-04', 'head'],
    ['EMP-0103', 'Aarav Mehta', 'Senior Accountant', 48000, '2019-02-11'],
    ['EMP-0104', 'Neha Kapoor', 'Accounts Executive', 45000, '2019-08-19'],
    ['EMP-0105', 'Rohit Bansal', 'Sales Executive', 42000, '2020-01-06'],
    ['EMP-0106', 'Sneha Iyer', 'Operations Executive', 38000, '2020-09-14'],
    ['EMP-0108', 'Karan Malhotra', 'Sales Executive', 36000, '2021-03-01'],
    ['EMP-0109', 'Pooja Reddy', 'Customer Support', 34000, '2021-07-12'],
    ['EMP-0110', 'Amit Joshi', 'Purchase Executive', 40000, '2020-11-02'],
    ['EMP-0111', 'Divya Menon', 'HR Executive', 37000, '2021-10-18'],
    ['EMP-0112', 'Suresh Yadav', 'Office Assistant', 28000, '2022-01-10'],
    ['EMP-0113', 'Meera Pillai', 'Customer Support', 33000, '2022-04-04'],
    ['EMP-0114', 'Arjun Desai', 'Sales Manager', 44000, '2019-11-25'],
    ['EMP-0115', 'Kavita Rao', 'Front Desk', 31000, '2022-08-22'],
    ['EMP-0116', 'Manish Gupta', 'Accounts Executive', 39000, '2021-01-18'],
    ['EMP-0117', 'Priya Nair', 'Operations Executive', 52000, '2020-04-13'],
    ['EMP-0118', 'Deepak Chauhan', 'Dispatch Assistant', 26000, '2023-02-06'],
    ['EMP-0119', 'Ritu Saxena', 'Data Entry Operator', 30000, '2023-05-15'],
    ['EMP-0120', 'Nikhil Jain', 'Sales Executive', 35000, '2022-11-07'],
    ['EMP-0122', 'Anjali Thomas', 'Customer Support', 32000, '2023-09-04'],
    ['EMP-0124', 'Varun Khanna', 'Dispatch Assistant', 29000, '2024-01-08'],
    ['EMP-0126', 'Shreya Ghosh', 'Data Entry Operator', 27000, '2024-06-17'],
    ['EMP-0128', 'Tarun Bhatia', 'Purchase Executive', 41000, '2021-05-24'],
  ],
  o2: [
    ['EMP-0201', 'Rahul Khanna', 'Office Head', 78000, '2019-04-01', 'head'],
    ['EMP-0202', 'Sunita Agarwal', 'Senior Accountant', 41000, '2019-09-09'],
    ['EMP-0203', 'Imran Sheikh', 'Sales Executive', 36000, '2020-06-15'],
    ['EMP-0204', 'Lakshmi Narayan', 'Customer Support', 33000, '2021-02-08'],
    ['EMP-0205', 'Gaurav Tiwari', 'Purchase Executive', 38000, '2020-10-05'],
    ['EMP-0206', 'Nisha Verghese', 'HR Executive', 35000, '2021-08-16'],
    ['EMP-0207', 'Harish Patel', 'Dispatch Assistant', 29000, '2022-03-21'],
    ['EMP-0208', 'Tanvi Kulkarni', 'Operations Executive', 32000, '2022-07-11'],
    ['EMP-0209', 'Mohit Arora', 'Sales Manager', 44000, '2019-12-02'],
    ['EMP-0210', 'Rekha Bose', 'Front Desk', 27000, '2023-01-16'],
    ['EMP-0211', 'Sanjay Mishra', 'Office Assistant', 30000, '2023-06-05'],
    ['EMP-0212', 'Aditi Sen', 'Accounts Executive', 34000, '2022-10-10'],
  ],
  o3: [
    ['EMP-0301', 'Farhan Qureshi', 'Office Head', 72000, '2020-02-03', 'head'],
    ['EMP-0302', 'Geeta Rawat', 'Front Desk', 31000, '2021-04-19'],
    ['EMP-0303', 'Yash Dubey', 'Sales Executive', 36000, '2021-09-06'],
    ['EMP-0304', 'Zoya Ansari', 'Accounts Executive', 39000, '2020-08-24'],
    ['EMP-0305', 'Prakash Nambiar', 'Office Assistant', 28000, '2022-05-09'],
    ['EMP-0306', 'Simran Gill', 'Customer Support', 33000, '2022-12-12'],
    ['EMP-0307', 'Vivek Rathore', 'Sales Manager', 42000, '2020-05-18'],
    ['EMP-0308', 'Bhavna Shetty', 'Operations Executive', 30000, '2023-08-07'],
  ],
};

type Exc = { t: 'absent' } | { t: 'late'; in: string } | { t: 'short'; out: string } | { t: 'noOut'; in?: string } | { t: 'other'; office: string };
// Office 1 in November is fully scripted so the payroll figures are known:
// 12 unpaid days, deductions ₹12,666.67, net ₹8,39,333.33 once the open items are approved.
const EXC: Record<string, Exc> = {
  'EMP-0117|2026-11-04': { t: 'late', in: '09:20' },
  'EMP-0112|2026-11-05': { t: 'absent' }, 'EMP-0112|2026-11-19': { t: 'absent' },
  'EMP-0118|2026-11-03': { t: 'late', in: '09:10' }, 'EMP-0118|2026-11-11': { t: 'absent' }, 'EMP-0118|2026-11-25': { t: 'late', in: '09:25' },
  'EMP-0126|2026-11-24': { t: 'absent' },
  'EMP-0124|2026-11-10': { t: 'late', in: '09:07' }, 'EMP-0124|2026-11-23': { t: 'late', in: '09:20' },
  'EMP-0108|2026-11-12': { t: 'short', out: '16:30' }, 'EMP-0108|2026-11-21': { t: 'noOut', in: '08:55' },
  'EMP-0111|2026-11-18': { t: 'absent' },
  'EMP-0110|2026-11-06': { t: 'late', in: '09:15' }, 'EMP-0110|2026-11-23': { t: 'late', in: '09:14' },
  'EMP-0120|2026-11-07': { t: 'absent' },
  'EMP-0106|2026-11-20': { t: 'noOut', in: '08:50' },
  'EMP-0104|2026-11-06': { t: 'noOut' },
  'EMP-0114|2026-11-17': { t: 'other', office: 'o2' },
  'EMP-0304|2026-11-19': { t: 'noOut', in: '08:47' },
};

const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

export function buildSeed(): Db {
  const settings: Settings = {
    companyName: 'SBM Management', startTime: '09:00', fullDayHours: 9, halfDayHours: 4.5,
    escalateAfterWorkingDays: 2, plCarryMax: 30, defaultClQuota: 12, defaultPlQuota: 18,
  };
  const offices: Office[] = [
    { id: 'o1', name: 'Office 1', address: '5th floor, Tower B, Sector 21', headId: 'EMP-0102' },
    { id: 'o2', name: 'Office 2', address: '2nd floor, Plot 48, Industrial Area', headId: 'EMP-0201' },
    { id: 'o3', name: 'Office 3', address: 'Ground floor, Market Road', headId: 'EMP-0301' },
  ];
  const terminals: Terminal[] = [
    { id: 't1', officeId: 'o1', name: 'Office 1 entrance', serial: 'CQZ7224100381' },
    { id: 't2', officeId: 'o2', name: 'Office 2 entrance', serial: 'CQZ7224100412' },
    { id: 't3', officeId: 'o3', name: 'Office 3 entrance', serial: 'CQZ7224100467', offlineFrom: '2026-11-23T08:41', offlineTo: '2026-11-23T10:30' },
  ];
  const allOffices = offices.map(o => o.id);
  const holidays: Holiday[] = [
    ['2026-01-26', 'Republic Day'], ['2026-03-04', 'Holi'], ['2026-08-15', 'Independence Day'], ['2026-10-02', 'Gandhi Jayanti'],
    ['2026-10-20', 'Dussehra'], ['2026-11-09', 'Diwali holiday'], ['2026-12-25', 'Christmas'],
  ].map(([date, name], i) => ({ id: `H${i + 1}`, date, name, officeIds: allOffices, kind: 'holiday' as const }));
  holidays.push({ id: 'H8', date: '2026-12-12', name: 'Year-end stock count', officeIds: ['o1'], kind: 'working' });
  holidays.push({ id: 'H9', date: '2026-12-18', name: 'Office 2 foundation day', officeIds: ['o2'], kind: 'holiday' });

  const employees: Employee[] = [{
    id: 'ADM-0001', name: 'Anita Verma', email: 'anita.verma@sbm.example', phone: '+91 98110 00001', officeId: '', role: 'admin',
    designation: 'Director', joinDate: '2015-04-01', status: 'active', terminalUserId: '', clQuota: 0, plQuota: 0, bestStreak: 0,
  }];
  const salaries: SalaryRevision[] = [];
  const leaveOpening: Db['leaveOpening'] = {};
  const passwords: Record<string, string> = { 'ADM-0001': DEMO_PASSWORD };
  for (const [officeId, rows] of Object.entries(STAFF)) {
    for (const [id, name, designation, salary, joinDate, role] of rows) {
      const n = 10000000 + Math.floor(rnd(id) * 89999999);
      employees.push({
        id, name, designation, joinDate, officeId, role: role ?? 'employee', status: 'active',
        email: `${name.toLowerCase().replace(' ', '.')}@sbm.example`,
        phone: `+91 98${String(n).slice(0, 3)} ${String(n).slice(3)}`,
        terminalUserId: String(Number(id.slice(4))), clQuota: 12, plQuota: 18,
        bestStreak: 18 + Math.floor(rnd(id + 'best') * 40),
      });
      salaries.push({ id: `S-${id}`, employeeId: id, amount: salary, effectiveMonth: '2026-04', setBy: 'ADM-0001', setAt: '2026-04-02T11:00' });
      leaveOpening[id] = { cl: 2 + Math.floor(rnd(id + 'cl') * 5) * 0.5, pl: 5 + Math.floor(rnd(id + 'pl') * 12) * 0.5, creditFrom: '2026-10' };
      passwords[id] = DEMO_PASSWORD;
    }
  }
  // Priya is the employee persona: CL 3.5 and PL 11.5 on 23 Nov, one earlier salary revision.
  leaveOpening['EMP-0117'] = { cl: 2.5, pl: 8.5, creditFrom: '2026-10' };
  employees.find(e => e.id === 'EMP-0117')!.bestStreak = 31;
  salaries.unshift({ id: 'S-EMP-0117-a', employeeId: 'EMP-0117', amount: 48000, effectiveMonth: '2025-04', setBy: 'ADM-0001', setAt: '2025-04-03T10:30' });

  const L = (id: string, employeeId: string, type: LeaveRequest['type'], from: string, to: string, status: LeaveRequest['status'], createdAt: string,
    reason: string, extra: Partial<LeaveRequest> = {}): LeaveRequest => ({ id, kind: 'leave', employeeId, type, from, to, half: false, days: 0, reason, status, createdAt, ...extra });
  const ok = (by: string, at: string, comment?: string) => ({ decidedBy: by, decidedAt: at, comment });
  const leaves: LeaveRequest[] = [
    L('LV-1', 'EMP-0103', 'PL', '2026-10-12', '2026-10-14', 'approved', '2026-10-05T12:10', 'Trip to Jaipur with family', ok('EMP-0102', '2026-10-05T15:00')),
    L('LV-2', 'EMP-0202', 'CL', '2026-10-05', '2026-10-05', 'approved', '2026-10-01T10:00', 'Bank work', ok('EMP-0201', '2026-10-01T12:30')),
    L('LV-3', 'EMP-0301', 'PL', '2026-10-26', '2026-10-27', 'approved', '2026-10-19T09:40', 'Out of station', ok('ADM-0001', '2026-10-19T14:05')),
    L('LV-4', 'EMP-0128', 'PL', '2026-11-02', '2026-11-03', 'approved', '2026-10-27T11:20', 'Cousin\'s wedding', ok('EMP-0102', '2026-10-27T16:45')),
    L('LV-5', 'EMP-0302', 'CL', '2026-11-06', '2026-11-06', 'approved', '2026-11-03T09:15', 'School admission meeting', ok('EMP-0301', '2026-11-03T11:00')),
    L('LV-6', 'EMP-0118', 'CL', '2026-11-11', '2026-11-11', 'rejected', '2026-11-09T17:30', 'Personal work', ok('EMP-0102', '2026-11-10T09:20', 'Stock audit that day. Please pick another date.')),
    L('LV-7', 'EMP-0203', 'PL', '2026-11-12', '2026-11-13', 'approved', '2026-11-05T13:00', 'Visiting parents', ok('EMP-0201', '2026-11-05T17:10')),
    L('LV-8', 'EMP-0117', 'CL', '2026-11-13', '2026-11-13', 'approved', '2026-11-10T10:05', 'Passport office appointment', ok('EMP-0102', '2026-11-10T12:40')),
    L('LV-9', 'EMP-0119', 'UNPAID', '2026-11-16', '2026-11-17', 'approved', '2026-11-12T16:00', 'Travelling home, no leave balance left', ok('EMP-0102', '2026-11-13T09:30')),
    L('LV-10', 'EMP-0306', 'UNPAID', '2026-11-17', '2026-11-17', 'approved', '2026-11-16T09:10', 'Urgent personal work', ok('EMP-0301', '2026-11-16T10:00')),
    L('LV-11', 'EMP-0113', 'CL', '2026-11-20', '2026-11-20', 'approved', '2026-11-17T14:20', 'Family function', ok('EMP-0102', '2026-11-17T17:00')),
    L('LV-12', 'EMP-0115', 'CL', '2026-11-23', '2026-11-23', 'approved', '2026-11-19T11:45', 'House shifting', ok('EMP-0102', '2026-11-19T15:15')),
    L('LV-13', 'EMP-0208', 'CL', '2026-11-25', '2026-11-25', 'pending', '2026-11-18T10:15', 'Sister\'s engagement'),
    L('LV-14', 'EMP-0117', 'PL', '2026-11-26', '2026-11-27', 'pending', '2026-11-21T16:40', 'Family function in Kochi'),
    L('LV-15', 'EMP-0102', 'PL', '2026-12-03', '2026-12-04', 'pending', '2026-11-21T11:00', 'Daughter\'s school event in Dehradun'),
    L('LV-16', 'EMP-0113', 'CL', '2026-11-30', '2026-11-30', 'pending', '2026-11-23T08:30', 'Bank appointment in the morning', { half: true }),
  ];
  for (const l of leaves) {
    const office = employees.find(e => e.id === l.employeeId)!.officeId;
    const n = dateRange(l.from, l.to).filter(d => dayKind(d, office, holidays).kind === 'working').length;
    l.days = l.half ? 0.5 : n;
  }
  const corrections: CorrectionRequest[] = [
    { id: 'CR-1', kind: 'correction', employeeId: 'EMP-0104', date: '2026-11-06', inTime: null, outTime: '18:05', reason: 'Forgot to punch out after the vendor meeting', status: 'approved', createdAt: '2026-11-07T09:02', decidedBy: 'EMP-0102', decidedAt: '2026-11-07T10:10' },
    { id: 'CR-2', kind: 'correction', employeeId: 'EMP-0304', date: '2026-11-19', inTime: null, outTime: '18:20', reason: 'Terminal did not read my finger in the evening', status: 'pending', createdAt: '2026-11-20T09:30' },
    { id: 'CR-3', kind: 'correction', employeeId: 'EMP-0106', date: '2026-11-20', inTime: null, outTime: '18:02', reason: 'Terminal was busy, missed the punch out', status: 'pending', createdAt: '2026-11-21T09:05' },
    { id: 'CR-4', kind: 'correction', employeeId: 'EMP-0108', date: '2026-11-21', inTime: null, outTime: '18:10', reason: 'Left with the client team and forgot to punch out', status: 'pending', createdAt: '2026-11-23T08:50' },
  ];
  const manualDays: ManualDay[] = [
    { employeeId: 'EMP-0104', date: '2026-11-06', inTime: null, outTime: '18:05', reason: 'Forgot to punch out after the vendor meeting', byId: 'EMP-0102', at: '2026-11-07T10:10' },
  ];

  // ---------- punches ----------
  const punches: Punch[] = [];
  const termOf = (officeId: string) => terminals.find(t => t.officeId === officeId)!;
  const noPunch = (empId: string, d: string) =>
    leaves.some(l => l.employeeId === empId && !l.half && l.from <= d && d <= l.to && (l.status === 'approved' || l.status === 'pending'));
  let pn = 0;
  const add = (empId: string, officeId: string, d: string, min: number) => {
    const t = termOf(officeId); const at = `${d}T${fromMin(min)}`;
    const held = t.offlineFrom && t.offlineTo && at >= t.offlineFrom && at < t.offlineTo;
    punches.push({ id: `P${++pn}`, employeeId: empId, terminalId: t.id, officeId, at, receivedAt: held ? t.offlineTo! : at });
  };
  for (const e of employees) {
    if (e.role === 'admin') continue;
    for (const d of dateRange(DATA_FROM, DATA_TO)) {
      if (dayKind(d, e.officeId, holidays).kind !== 'working' || d < e.joinDate || noPunch(e.id, d)) continue;
      let inMin = 515 + Math.floor(rnd(e.id + d + 'in') * 24); // 8:35 to 8:58
      let outMin: number | null = inMin + 542 + Math.floor(rnd(e.id + d + 'out') * 34);
      let office = e.officeId;
      let x: Exc | undefined = EXC[`${e.id}|${d}`];
      const scripted = e.officeId === 'o1' && monthOf(d) >= '2026-11';
      if (!x && !scripted) {
        const r = rnd(e.id + d + 'x');
        if (r < 0.012) x = { t: 'absent' };
        else if (r < 0.03) x = { t: 'late', in: fromMin(545 + Math.floor(rnd(e.id + d + 'l') * 25)) };
        else if (r < 0.038) x = { t: 'short', out: fromMin(inMin + 300 + Math.floor(rnd(e.id + d + 's') * 200)) };
      }
      if (x?.t === 'absent') continue;
      if (x?.t === 'late') { inMin = toMin(x.in); outMin = inMin + 545 + Math.floor(rnd(e.id + d + 'out') * 25); }
      if (x?.t === 'short') outMin = toMin(x.out);
      if (x?.t === 'noOut') { if (x.in) inMin = toMin(x.in); outMin = null; }
      if (x?.t === 'other') office = x.office;
      add(e.id, office, d, inMin);
      if (outMin != null) add(e.id, office, d, outMin);
    }
  }

  const locks: MonthLock[] = offices.map(o => ({
    officeId: o.id, month: '2026-10', reviewedBy: o.headId!, reviewedAt: '2026-11-02T10:40', lockedBy: o.headId!, lockedAt: '2026-11-02T11:00',
  }));

  const N = (id: string, userId: string, text: string, at: string, link: string, read = false): Notification => ({ id, userId, text, at, link, read });
  const notifications: Notification[] = [
    N('N1', 'EMP-0102', 'Karan Malhotra asked to correct Sat 21 Nov', '2026-11-23T08:50', '/attendance/corrections'),
    N('N2', 'EMP-0102', 'Priya Nair asked for PL, 26 to 27 Nov', '2026-11-21T16:40', '/leave'),
    N('N3', 'EMP-0102', 'Sneha Iyer asked to correct Fri 20 Nov', '2026-11-21T09:05', '/attendance/corrections', true),
    N('N4', 'ADM-0001', 'Escalated: Tanvi Kulkarni\'s CL request has waited 2 working days in Office 2', '2026-11-21T09:00', '/leave'),
    N('N5', 'ADM-0001', 'Vikram Singh asked for PL, 3 to 4 Dec', '2026-11-21T11:00', '/leave'),
    N('N6', 'ADM-0001', 'Escalated: Zoya Ansari\'s correction for Thu 19 Nov has waited 2 working days in Office 3', '2026-11-23T09:00', '/attendance/corrections'),
    N('N7', 'EMP-0117', 'Your CL for Fri 13 Nov was approved', '2026-11-10T12:40', '/me/leave', true),
    N('N8', 'EMP-0117', 'Your October payslip is ready', '2026-11-02T11:00', '/me/payslips', true),
    N('N9', 'EMP-0201', 'Tanvi Kulkarni asked for CL, Wed 25 Nov', '2026-11-18T10:15', '/leave'),
    N('N10', 'EMP-0301', 'Zoya Ansari asked to correct Thu 19 Nov', '2026-11-20T09:30', '/attendance/corrections'),
  ];
  const A = (id: string, at: string, actorId: string, officeId: string | null, action: string, detail: string): AuditEntry =>
    ({ id, at, actorId, actorName: employees.find(e => e.id === actorId)!.name, officeId, action, detail });
  const audit: AuditEntry[] = [
    A('AU8', '2026-11-19T15:15', 'EMP-0102', 'o1', 'Leave approved', 'Kavita Rao, CL, Mon 23 Nov'),
    A('AU7', '2026-11-13T09:30', 'EMP-0102', 'o1', 'Leave approved', 'Ritu Saxena, unpaid leave, 16 to 17 Nov'),
    A('AU6', '2026-11-10T09:20', 'EMP-0102', 'o1', 'Leave rejected', 'Deepak Chauhan, CL, Wed 11 Nov. Reason: Stock audit that day. Please pick another date.'),
    A('AU5', '2026-11-07T10:10', 'EMP-0102', 'o1', 'Correction approved', 'Neha Kapoor, Fri 6 Nov, out time set to 6:05 PM'),
    A('AU4', '2026-11-02T11:00', 'EMP-0301', 'o3', 'Month locked', 'October 2026 locked for Office 3. Payslips released.'),
    A('AU3', '2026-11-02T11:00', 'EMP-0201', 'o2', 'Month locked', 'October 2026 locked for Office 2. Payslips released.'),
    A('AU2', '2026-11-02T11:00', 'EMP-0102', 'o1', 'Month locked', 'October 2026 locked for Office 1. Payslips released.'),
    A('AU1', '2026-10-15T12:00', 'ADM-0001', null, 'Holiday added', 'Diwali holiday, Mon 9 Nov, all offices'),
  ];

  return {
    version: DB_VERSION, settings, offices, terminals, employees, salaries, punches, manualDays, leaves, corrections, holidays, locks,
    payslips: [], notifications, audit, leaveOpening, passwords, invites: [], outbox: [],
    empSeq: { o1: 130, o2: 213, o3: 309 }, seq: 1000,
  };
}
