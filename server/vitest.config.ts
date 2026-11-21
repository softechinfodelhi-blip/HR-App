import { defineConfig } from 'vitest/config';

// Server tests run against a real Postgres (see test/global-setup.ts), one file at a time.
export const TEST_DB_PORT = 54331;
export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? `postgresql://postgres:postgres@localhost:${TEST_DB_PORT}/sbm_hr_test`;

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 120000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DB_URL,
      DIRECT_URL: TEST_DB_URL,
      SESSION_SECRET: 'test-secret-test-secret-test-secret-test-secret',
      APP_URL: 'http://localhost:5173',
      SMTP_HOST: '',
    },
  },
});
