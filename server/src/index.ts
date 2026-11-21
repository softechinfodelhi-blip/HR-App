// Two listeners in one process:
//   PORT       the API and the built frontend (behind Railway's HTTPS domain)
//   ADMS_PORT  only /iclock/* for the biometric terminals (plain HTTP, through a Railway TCP proxy)
import { createAdmsApp } from './adms/app';
import { createApp } from './app';
import { prisma } from './db';
import { env } from './env';
import { startJobs } from './jobs';

async function main() {
  await prisma.$connect();
  const app = createApp();
  const server = app.listen(env.PORT, () => console.log(`[api] listening on port ${env.PORT}`));
  if (env.ADMS_PORT === env.PORT) throw new Error('ADMS_PORT must be different from PORT.');
  const adms = createAdmsApp().listen(env.ADMS_PORT, '0.0.0.0', () => console.log(`[adms] terminals listener on port ${env.ADMS_PORT} (/iclock only)`));

  startJobs();

  const stop = async () => { server.close(); adms.close(); await prisma.$disconnect(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
