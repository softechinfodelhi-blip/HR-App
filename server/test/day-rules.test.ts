// Every attendance rule, as a unit test on the pure function. No database.
import { describe, expect, it } from 'vitest';
import { dayKind, emptyCalendar, isWeeklyOff, workingDates, workingDaysElapsed, type DayKind, type OfficeCalendar } from '../src/services/calendar';
import { classifyDay, countDays, firstAndLast, type DayInput, type HalfDay, type LeaveType } from '../src/services/day-rules';

const RULES = { startSec: 9 * 3600, fullDayMin: 540, halfDayMin: 270 };
const sec = (t: string) => { const [h, m, s = 0] = t.split(':').map(Number); return h * 3600 + m * 60 + s; };
const WORKING: DayKind = { kind: 'working' };

/** A past working day (Tue 3 Nov 2026) with these punches, judged on a later date. */
function day(punches: string[], extra: Partial<DayInput> = {}) {
  return classifyDay({
    date: '2026-11-03', today: '2026-11-10', nowSec: sec('12:00'), kind: WORKING, rules: RULES, joinDate: '2024-01-01', homeOfficeId: 'o1',
    punches: punches.map(t => ({ sec: sec(t), officeId: 'o1' })), ...extra,
  });
}
const leave = (type: LeaveType, half: HalfDay = 'none') => ({ leave: { type, half } });

describe('status on a working day, in rule order', () => {
  it('1. approved full-day leave: ON_LEAVE, paid 1 for CL and PL, 0 for UNPAID', () => {
    expect(day([], leave('CL'))).toMatchObject({ engine: 'ON_LEAVE', paidFraction: 1, unpaid: 0, status: 'leave', leaveType: 'CL', label: 'On leave (CL)' });
    expect(day([], leave('PL'))).toMatchObject({ engine: 'ON_LEAVE', paidFraction: 1 });
    expect(day([], leave('UNPAID'))).toMatchObject({ engine: 'ON_LEAVE', paidFraction: 0, unpaid: 1, label: 'On leave (Unpaid leave)' });
  });
  it('1. leave wins over punches made that day', () => {
    expect(day(['09:30', '12:00'], leave('CL'))).toMatchObject({ engine: 'ON_LEAVE', paidFraction: 1, late: false, inTime: '09:30' });
  });
  it('2. no punches: ABSENT, paid 0', () => {
    expect(day([])).toMatchObject({ engine: 'ABSENT', paidFraction: 0, unpaid: 1, status: 'absent', inTime: null, outTime: null });
  });
  it('3. one punch only: MISSING_PUNCH, to be decided before the lock', () => {
    expect(day(['08:55'])).toMatchObject({ engine: 'MISSING_PUNCH', status: 'missing', inTime: '08:55', outTime: null, unpaid: 0 });
    expect(day(['18:10'])).toMatchObject({ engine: 'MISSING_PUNCH' }); // a lone evening punch is still one punch
  });
  it('4. hours below the half-day minimum: ABSENT, paid 0', () => {
    expect(day(['09:00', '13:29'])).toMatchObject({ engine: 'ABSENT', paidFraction: 0, workedMin: 269, label: 'Absent (under 4.5 h)' });
  });
  it('4 comes before 5: late and under 4.5 hours is ABSENT, not a half day', () => {
    expect(day(['10:00', '14:00'])).toMatchObject({ engine: 'ABSENT', paidFraction: 0, late: true });
  });
  it('5. check-in after 09:00:59: HALF_DAY_LATE, paid 0.5', () => {
    expect(day(['09:01:00', '18:30'])).toMatchObject({ engine: 'HALF_DAY_LATE', paidFraction: 0.5, unpaid: 0.5, late: true, status: 'half_late' });
    expect(day(['11:00', '20:30'])).toMatchObject({ engine: 'HALF_DAY_LATE', paidFraction: 0.5 }); // long hours do not make up for a late start
  });
  it('5. 09:00:59 is on time, 09:01:00 is late', () => {
    expect(day(['09:00:59', '18:00:59'])).toMatchObject({ engine: 'PRESENT', late: false });
    expect(day(['09:01:00', '18:01:00'])).toMatchObject({ engine: 'HALF_DAY_LATE', late: true });
  });
  it('5 comes before 6: late and short hours is HALF_DAY_LATE', () => {
    expect(day(['09:30', '15:00'])).toMatchObject({ engine: 'HALF_DAY_LATE', paidFraction: 0.5 });
  });
  it('6. hours below the full day: HALF_DAY_SHORT, paid 0.5', () => {
    expect(day(['09:00', '13:30'])).toMatchObject({ engine: 'HALF_DAY_SHORT', paidFraction: 0.5, workedMin: 270, status: 'half_short' });
    expect(day(['09:00', '17:59'])).toMatchObject({ engine: 'HALF_DAY_SHORT', paidFraction: 0.5, workedMin: 539 });
  });
  it('7. otherwise PRESENT, paid 1', () => {
    expect(day(['09:00', '18:00'])).toMatchObject({ engine: 'PRESENT', paidFraction: 1, unpaid: 0, workedMin: 540, status: 'present', late: false });
    expect(day(['08:15', '19:40'])).toMatchObject({ engine: 'PRESENT', paidFraction: 1 });
  });
});

describe('first and last punch', () => {
  it('uses the first and last punch whatever the order, and does not subtract breaks', () => {
    expect(day(['13:05', '18:02', '08:58', '13:40'])).toMatchObject({ inTime: '08:58', outTime: '18:02', workedMin: 544, engine: 'PRESENT' });
  });
  it('merges a double tap: punches under 2 minutes apart are one punch', () => {
    expect(firstAndLast([sec('09:12:27'), sec('09:12:29')])).toEqual({ inSec: sec('09:12:27'), outSec: null });
    expect(day(['09:12:27', '09:12:29'])).toMatchObject({ engine: 'MISSING_PUNCH' }); // not "absent with 0 hours"
    expect(firstAndLast([sec('09:00'), sec('09:02')])).toEqual({ inSec: sec('09:00'), outSec: sec('09:02') }); // 2 full minutes apart are two punches
    expect(day(['09:00', '18:00:00', '18:00:40'])).toMatchObject({ outTime: '18:00', engine: 'PRESENT' });
  });
  it('flags a punch at another office and still counts it', () => {
    const d = classifyDay({ date: '2026-11-03', today: '2026-11-10', nowSec: 0, kind: WORKING, rules: RULES, joinDate: '2024-01-01', homeOfficeId: 'o1', punches: [{ sec: sec('09:00'), officeId: 'o2' }, { sec: sec('18:05'), officeId: 'o1' }] });
    expect(d).toMatchObject({ engine: 'PRESENT', otherOfficeId: 'o2' });
    expect(day(['09:00', '18:00']).otherOfficeId).toBeNull();
  });
  it('uses the office\'s own start time and hours', () => {
    const rules = { startSec: sec('10:00'), fullDayMin: 480, halfDayMin: 240 };
    expect(day(['10:00:59', '18:01'], { rules })).toMatchObject({ engine: 'PRESENT' });
    expect(day(['10:01', '18:30'], { rules })).toMatchObject({ engine: 'HALF_DAY_LATE' });
    expect(day(['09:00', '12:59'], { rules })).toMatchObject({ engine: 'ABSENT', label: 'Absent (under 4 h)' });
  });
});

describe('half-day leave', () => {
  it('CL or PL on a half-day status raises the day to paid 1', () => {
    // First half on leave: arrives after lunch, so the day is a late half day.
    expect(day(['13:30', '18:30'], leave('CL', 'first'))).toMatchObject({ engine: 'HALF_DAY_LATE', paidFraction: 1, unpaid: 0, status: 'leave', halfLeave: true, leaveType: 'CL', label: 'Half day leave (CL)' });
    // Second half on leave: leaves at lunch, so the day is a short half day.
    expect(day(['09:00', '13:30'], leave('PL', 'second'))).toMatchObject({ engine: 'HALF_DAY_SHORT', paidFraction: 1, status: 'leave', halfLeave: true });
  });
  it('unpaid half-day leave does not raise anything', () => {
    expect(day(['09:00', '13:30'], leave('UNPAID', 'second'))).toMatchObject({ engine: 'HALF_DAY_SHORT', paidFraction: 0.5, unpaid: 0.5, status: 'leave', label: 'Half day leave (Unpaid leave)' });
    expect(day([], leave('UNPAID', 'first'))).toMatchObject({ engine: 'ABSENT', paidFraction: 0, status: 'absent' });
  });
  it('CL or PL on a day that is otherwise ABSENT pays 0.5', () => {
    expect(day(['09:00', '13:00'], leave('CL', 'second'))).toMatchObject({ engine: 'ABSENT', paidFraction: 0.5, unpaid: 0.5, status: 'leave', label: 'Half day leave (CL), other half absent' });
    expect(day([], leave('PL', 'first'))).toMatchObject({ engine: 'ABSENT', paidFraction: 0.5 });
  });
  it('a full day worked stays PRESENT, and one punch is still MISSING_PUNCH', () => {
    expect(day(['09:00', '18:00'], leave('CL', 'first'))).toMatchObject({ engine: 'PRESENT', paidFraction: 1, status: 'present', halfLeave: true });
    expect(day(['09:00'], leave('CL', 'second'))).toMatchObject({ engine: 'MISSING_PUNCH', status: 'missing', halfLeave: true });
  });
});

describe('weekly off and holiday', () => {
  it('OFF and HOLIDAY are paid in full and keep their punches', () => {
    expect(day([], { kind: { kind: 'off' } })).toMatchObject({ engine: 'OFF', paidFraction: 1, unpaid: 0, status: 'off', label: 'Weekly off' });
    expect(day(['10:00', '14:00'], { kind: { kind: 'holiday', name: 'Diwali' } })).toMatchObject({ engine: 'HOLIDAY', paidFraction: 1, status: 'holiday', label: 'Diwali', holidayName: 'Diwali', inTime: '10:00', outTime: '14:00', late: false });
  });
  it('leave on an off day does not turn it into leave', () => {
    expect(day([], { kind: { kind: 'off' }, ...leave('CL') })).toMatchObject({ engine: 'OFF', paidFraction: 1 });
  });
});

describe('approved correction', () => {
  it('supplies the missing out time, marks the day manual, and leaves the punches alone', () => {
    const input = { correction: { id: 'c1', inMin: null, outMin: 18 * 60 + 5 } };
    expect(day(['08:55'], input)).toMatchObject({ engine: 'PRESENT', paidFraction: 1, inTime: '08:55', outTime: '18:05', manual: true, correctionId: 'c1' });
  });
  it('replaces a disputed in time, which also decides whether the day is late', () => {
    expect(day(['09:20', '18:30'])).toMatchObject({ engine: 'HALF_DAY_LATE' });
    expect(day(['09:20', '18:30'], { correction: { id: 'c1', inMin: 9 * 60, outMin: null } })).toMatchObject({ engine: 'PRESENT', inTime: '09:00', outTime: '18:30', late: false, manual: true });
  });
  it('supplies both times for a day with no punches', () => {
    expect(day([], { correction: { id: 'c1', inMin: 540, outMin: 1080 } })).toMatchObject({ engine: 'PRESENT', manual: true });
  });
  it('is still judged by the rules', () => {
    expect(day(['08:55'], { correction: { id: 'c1', inMin: null, outMin: 12 * 60 } })).toMatchObject({ engine: 'ABSENT', manual: true });
  });
});

describe('today, future and employment dates', () => {
  const todayAt = (now: string, punches: string[], extra: Partial<DayInput> = {}) => day(punches, { date: '2026-11-10', today: '2026-11-10', nowSec: sec(now), ...extra });
  it('today is not judged while it is open', () => {
    expect(todayAt('08:30', [])).toMatchObject({ engine: null, status: 'not_in', late: false, closed: false });
    expect(todayAt('09:30', [])).toMatchObject({ status: 'not_in', late: true, unpaid: 0 });
    expect(todayAt('11:00', ['09:20'])).toMatchObject({ status: 'working', label: 'In since 9:20 AM', late: true, unpaid: 0 });
    expect(todayAt('14:00', ['08:50', '13:10'])).toMatchObject({ status: 'working', label: 'Last punch 1:10 PM' });
    expect(todayAt('18:30', ['08:50', '18:05'])).toMatchObject({ status: 'present', engine: null });
  });
  it('today is judged once the 23:55 job has closed it', () => {
    expect(todayAt('23:56', [], { todayClosed: true })).toMatchObject({ engine: 'ABSENT', paidFraction: 0, closed: true });
    expect(todayAt('23:56', ['09:20'], { todayClosed: true })).toMatchObject({ engine: 'MISSING_PUNCH' });
    expect(todayAt('23:56', ['09:20', '18:30'], { todayClosed: true })).toMatchObject({ engine: 'HALF_DAY_LATE' });
  });
  it('a future date has no status, except leave, offs and holidays', () => {
    const future = (extra: Partial<DayInput> = {}) => day([], { date: '2026-11-20', ...extra });
    expect(future()).toMatchObject({ engine: null, paidFraction: null, status: 'future', unpaid: 0 });
    expect(future(leave('CL'))).toMatchObject({ engine: 'ON_LEAVE', status: 'leave' });
    expect(future(leave('CL', 'first'))).toMatchObject({ engine: null, status: 'leave', halfLeave: true });
    expect(future({ kind: { kind: 'holiday', name: 'Guru Nanak Jayanti' } })).toMatchObject({ engine: 'HOLIDAY', status: 'holiday' });
  });
  it('dates before joining and after the last working date are outside employment', () => {
    expect(day(['09:00', '18:00'], { joinDate: '2026-11-04' })).toMatchObject({ engine: null, status: 'not_joined', unpaid: 1, label: 'Before joining' });
    expect(day([], { lastWorkingDate: '2026-11-02' })).toMatchObject({ engine: null, status: 'not_joined', unpaid: 1, label: 'After last working day' });
    expect(day(['09:00', '18:00'], { joinDate: '2026-11-03', lastWorkingDate: '2026-11-03' })).toMatchObject({ engine: 'PRESENT' });
  });
});

describe('monthly counts', () => {
  it('adds up the way the register shows them', () => {
    const days = [day(['09:00', '18:00']), day(['09:30', '18:30']), day(['09:00', '14:00']), day([]), day(['09:00']), day([], leave('CL')), day(['09:00', '13:30'], leave('CL', 'second')), day([], { kind: { kind: 'off' } })];
    expect(countDays(days, '2026-11-10')).toEqual({ present: 1, half: 2, absent: 1, leave: 1.5, missing: 1, unpaid: 2 });
  });
});

describe('office calendar', () => {
  const cal = (holidays: Record<string, string> = {}, overrides: Record<string, 'working' | 'off'> = {}): OfficeCalendar => ({
    holidays: new Map(Object.entries(holidays)), overrides: new Map(Object.entries(overrides).map(([d, kind]) => [d, { kind, name: '' }])),
  });
  it('Monday to Saturday are working days, except the 2nd and 4th Saturday. Sunday is off', () => {
    // November 2026: Saturdays are the 7th, 14th, 21st and 28th. Sundays are the 1st, 8th, 15th, 22nd and 29th.
    expect(['2026-11-07', '2026-11-14', '2026-11-21', '2026-11-28'].map(isWeeklyOff)).toEqual([false, true, false, true]);
    expect(['2026-11-01', '2026-11-08', '2026-11-29'].every(isWeeklyOff)).toBe(true);
    expect(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'].some(isWeeklyOff)).toBe(false);
    // A month with five Saturdays: the 5th one is worked (October 2026: 3, 10, 17, 24, 31).
    expect(['2026-10-03', '2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31'].map(isWeeklyOff)).toEqual([false, true, false, true, false]);
    expect(workingDates('2026-11-01', '2026-11-30', emptyCalendar())).toHaveLength(23);
  });
  it('an office holiday is off', () => {
    expect(dayKind('2026-11-09', cal({ '2026-11-09': 'Diwali' }))).toEqual({ kind: 'holiday', name: 'Diwali' });
    expect(workingDates('2026-11-01', '2026-11-30', cal({ '2026-11-09': 'Diwali' }))).toHaveLength(22);
  });
  it('an override wins over everything', () => {
    expect(dayKind('2026-11-14', cal({}, { '2026-11-14': 'working' })).kind).toBe('working'); // a 2nd Saturday that is worked
    expect(dayKind('2026-11-08', cal({}, { '2026-11-08': 'working' })).kind).toBe('working'); // a Sunday that is worked
    expect(dayKind('2026-11-09', cal({ '2026-11-09': 'Diwali' }, { '2026-11-09': 'working' })).kind).toBe('working'); // a holiday that is worked
    expect(dayKind('2026-11-10', cal({}, { '2026-11-10': 'off' })).kind).toBe('off'); // a working day the office is closed
  });
  it('counts working days that have fully passed, for escalation', () => {
    // Asked on Fri 13 Nov. Sat 14 (2nd Saturday) and Sun 15 are off, so Mon 16 is 1 and Tue 17 is 2.
    expect(workingDaysElapsed('2026-11-13', '2026-11-13', emptyCalendar())).toBe(0);
    expect(workingDaysElapsed('2026-11-13', '2026-11-15', emptyCalendar())).toBe(0);
    expect(workingDaysElapsed('2026-11-13', '2026-11-16', emptyCalendar())).toBe(1);
    expect(workingDaysElapsed('2026-11-13', '2026-11-17', emptyCalendar())).toBe(2);
  });
});
