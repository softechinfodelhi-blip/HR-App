// Scheduled jobs. All times are Asia/Kolkata.
import cron from 'node-cron';
import { prisma } from './db';
import { sendQueuedEmails } from './lib/mail';
import { now, today } from './lib/time';
import { alertSilentTerminals, finalizeDay } from './services/attendance';

const TZ = 'Asia/Kolkata';

export function startJobs(): void {
  const run = (name: string, job: () => Promise<unknown>) => () => {
    job().catch(e => console.error(`[job] ${name} failed:`, e instanceof Error ? e.message : e));
  };
  // Every minute: send waiting emails.
  cron.schedule('* * * * *', run('email', sendQueuedEmails), { timezone: TZ });
  // Every hour: remove expired sessions.
  cron.schedule('7 * * * *', run('sessions', () => prisma.session.deleteMany({ where: { expiresAt: { lte: now() } } })), { timezone: TZ });
  // 23:55 every night: store the final attendance of the day for everyone,
  // then look for terminals that have been silent for over 12 hours on a working day.
  cron.schedule('55 23 * * *', run('nightly', async () => {
    const date = today();
    const n = await finalizeDay(prisma, date);
    const silent = await alertSilentTerminals(prisma);
    console.log(`[job] nightly: ${date} finalized for ${n} people, ${silent} silent terminal alert(s)`);
  }), { timezone: TZ });
}
