// Starts the server. Phase 2 adds the second listener (ADMS_PORT) for the terminals.
import cron from 'node-cron';
import { createApp } from './app';
import { prisma } from './db';
import { env } from './env';
import { sendQueuedEmails } from './lib/mail';
import { now } from './lib/time';

const TZ = 'Asia/Kolkata';

async function main() {
  await prisma.$connect();
  const app = createApp();
  const server = app.listen(env.PORT, () => console.log(`[api] listening on port ${env.PORT}`));

  const safe = (name: string, job: () => Promise<unknown>) => () => { job().catch(e => console.error(`[job] ${name} failed:`, e instanceof Error ? e.message : e)); };
  // Every minute: send waiting emails.
  cron.schedule('* * * * *', safe('email', sendQueuedEmails), { timezone: TZ });
  // Every hour: remove expired sessions.
  cron.schedule('7 * * * *', safe('sessions', () => prisma.session.deleteMany({ where: { expiresAt: { lte: now() } } })), { timezone: TZ });

  const stop = async () => { server.close(); await prisma.$disconnect(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
