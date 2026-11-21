// Reads and validates the environment once. Import `env` everywhere instead of process.env.
import { existsSync } from 'node:fs';
import { z } from 'zod';

// A local .env file is optional. On Railway the variables come from the service settings.
if (existsSync('.env')) process.loadEnvFile('.env');

const optional = z.preprocess(v => (v === '' ? undefined : v), z.string().optional());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  PORT: z.coerce.number().int().positive().default(3000),
  ADMS_PORT: z.coerce.number().int().positive().default(8081),
  APP_URL: z.string().url().default('http://localhost:5173'),
  SMTP_HOST: optional,
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: optional,
  SMTP_PASS: optional,
  MAIL_FROM: z.string().default('SBM HR <no-reply@localhost>'),
  SEED_ADMIN_EMAIL: optional,
  SEED_ADMIN_PASSWORD: optional,
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Names of the bad variables only. Values are never printed.
  const lines = parsed.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`);
  throw new Error(`Environment is not set up:\n${lines.join('\n')}\nCopy .env.example to .env and fill it in.`);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
