// Starts a throwaway Postgres for the test run and applies the migrations to it.
// Set TEST_DATABASE_URL to use a database of your own instead.
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startPostgres } from '../scripts/dev-db';
import { TEST_DB_PORT, TEST_DB_URL } from '../vitest.config';

export default async function setup() {
  let stop = async () => {};
  if (!process.env.TEST_DATABASE_URL) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sbm-hr-test-'));
    const pg = await startPostgres(path.join(dir, 'data'), TEST_DB_PORT, 'sbm_hr_test', true);
    stop = async () => { await pg.stop(); rmSync(dir, { recursive: true, force: true }); };
  }
  try {
    execSync('npx prisma migrate deploy --schema server/prisma/schema.prisma', {
      cwd: path.resolve(import.meta.dirname, '../..'), stdio: 'pipe',
      env: { ...process.env, DATABASE_URL: TEST_DB_URL, DIRECT_URL: TEST_DB_URL },
    });
  } catch (e) {
    await stop();
    throw new Error(`Migrations failed: ${(e as { stderr?: Buffer }).stderr?.toString() ?? e}`);
  }
  return stop;
}
