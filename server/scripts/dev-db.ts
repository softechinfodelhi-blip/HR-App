// Local Postgres for development: real Postgres binaries from the `embedded-postgres` package.
// No installer and no admin rights. Run `npm run db:start` and leave it open; Ctrl+C stops it.
// The data folder is kept outside the project (and outside OneDrive) so file sync cannot lock it.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

export const DEV_DB = { port: 54329, user: 'postgres', password: 'postgres', database: 'sbm_hr' };
export const devDbUrl = (database = DEV_DB.database) => `postgresql://${DEV_DB.user}:${DEV_DB.password}@localhost:${DEV_DB.port}/${database}`;

export function dataDir(): string {
  const base = process.env.SBM_HR_PGDATA ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'), 'sbm-hr', 'pgdata');
  mkdirSync(path.dirname(base), { recursive: true });
  return base;
}

/** Starts Postgres on `port` with its data in `dir`, creating the cluster and the database on first use. */
export async function startPostgres(dir: string, port: number, database: string, quiet = false): Promise<EmbeddedPostgres> {
  const pg = new EmbeddedPostgres({
    databaseDir: dir, port, user: DEV_DB.user, password: DEV_DB.password, persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: quiet ? () => {} : undefined, onError: e => console.error(e),
  });
  if (!existsSync(path.join(dir, 'PG_VERSION'))) await pg.initialise();
  await pg.start();
  try { await pg.createDatabase(database); } catch { /* it already exists */ }
  return pg;
}

/** First run: write a .env that points at this database, with a fresh session secret. */
function ensureEnvFile() {
  if (existsSync('.env')) return;
  writeFileSync('.env', [
    '# Local development. Created by `npm run db:start`. Not committed to git.',
    `DATABASE_URL="${devDbUrl()}"`,
    `DIRECT_URL="${devDbUrl()}"`,
    `SESSION_SECRET="${randomBytes(48).toString('base64url')}"`,
    'PORT=3000',
    'ADMS_PORT=8081',
    'APP_URL="http://localhost:5173"',
    '# Leave RESEND_API_KEY empty in development: emails are printed in the server window instead.',
    'RESEND_API_KEY=',
    'RESEND_FROM="SBM HR <no-reply@localhost>"',
    'SEED_ADMIN_EMAIL="admin@sbm.example"',
    `SEED_ADMIN_PASSWORD="${randomBytes(9).toString('base64url')}"`,
    '',
  ].join('\n'));
  console.log('[db] Created .env for local development. The admin sign-in for the seed is inside it.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  ensureEnvFile();
  const dir = dataDir();
  const pg = await startPostgres(dir, DEV_DB.port, DEV_DB.database, true);
  console.log(`[db] Postgres is running on port ${DEV_DB.port} (data in ${dir}).`);
  console.log('[db] Leave this window open. Press Ctrl+C to stop.');
  const stop = async () => { await pg.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
