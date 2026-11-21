// Scheduled jobs. All times are Asia/Kolkata.
import cron from 'node-cron';
import { prisma } from './db';
import { sendQueuedEmails } from './lib/mail';
import { monthOf, now, today } from './lib/time';
import { alertSilentTerminals, finalizeDay } from './services/attendance';
import { refreshGamification } from './services/gamification';
import { closeLeaveYear, creditLeave, escalateRequests } from './services/leave';

const TZ = 'Asia/Kolkata';

/**
 * Leave bookkeeping. Year end first (dated 31 December), then the monthly credit (dated the 1st).
 * Both write each entry once, so running them every night only catches up what is missing.
 */
export async function leaveBookkeeping(): Promise<{ yearEnd: number; credits: number }> {
  const date = today();
  const yearEnd = await closeLeaveYear(prisma, Number(date.slice(0, 4)) - 1);
  const credits = await creditLeave(prisma, monthOf(date));
  return { yearEnd, credits };
}

export function startJobs(): void {
  const run = (name: string, job: () => Promise<unknown>) => () => {
    job().catch(e => console.error(`[job] ${name} failed:`, e instanceof Error ? e.message : e));
  };
  // Every minute: send waiting emails.
  cron.schedule('* * * * *', run('email', sendQueuedEmails), { timezone: TZ });
  // Every hour: remove expired sessions.
  cron.schedule('7 * * * *', run('sessions', () => prisma.session.deleteMany({ where: { expiresAt: { lte: now() } } })), { timezone: TZ });
  // 00:05 every night, and once at start: on the 1st this writes the month's leave credit, on 1 January it first closes the leave year.
  const leave = run('leave', async () => {
    const r = await leaveBookkeeping();
    if (r.yearEnd || r.credits) console.log(`[job] leave: ${r.credits} credit(s), ${r.yearEnd} year-end entr${r.yearEnd === 1 ? 'y' : 'ies'}`);
  });
  cron.schedule('5 0 * * *', leave, { timezone: TZ });
  leave();
  // Every hour from 09:00 to 19:00: requests that have waited too long also go to the admin.
  cron.schedule('0 9-19 * * *', run('escalation', () => escalateRequests(prisma)), { timezone: TZ });
  // 23:55 every night: store the final attendance of the day for everyone, look for terminals that have
  // been silent for over 12 hours on a working day, then update best streaks and badges.
  cron.schedule('55 23 * * *', run('nightly', async () => {
    const date = today();
    const n = await finalizeDay(prisma, date);
    const silent = await alertSilentTerminals(prisma);
    const badges = await refreshGamification(prisma); // best streaks and newly earned badges
    console.log(`[job] nightly: ${date} finalized for ${n} people, ${silent} silent terminal alert(s), ${badges} badge(s)`);
  }), { timezone: TZ });
}
