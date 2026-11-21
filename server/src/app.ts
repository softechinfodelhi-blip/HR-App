// The API app (and, in production, the built frontend). The terminal routes live in a separate app on ADMS_PORT.
import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type ErrorRequestHandler, type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { Prisma, prisma } from './db';
import { isProd } from './env';
import { HttpError } from './lib/errors';
import { localDateTime, now } from './lib/time';
import { loadSession, sameOrigin } from './middleware/auth';
import { attendanceRoutes, meRoutes } from './routes/attendance';
import { authRoutes } from './routes/auth';
import { deviceRoutes, punchRoutes } from './routes/devices';
import { employeeRoutes } from './routes/employees';
import { holidayRoutes } from './routes/holidays';
import { insightRoutes } from './routes/insights';
import { liveRoutes } from './routes/live';
import { notificationRoutes } from './routes/notifications';
import { officeRoutes } from './routes/offices';
import { myPayslipRoutes, payrollRoutes, payslipRoutes } from './routes/payroll';
import { correctionRoutes, leaveRoutes, myRequestRoutes, requestRoutes } from './routes/requests';
import { settingsRoutes } from './routes/settings';

export interface AppOptions {
  /** Sign-in attempts per minute for one email address. The limit per IP address is six times this. */
  authRateLimit?: number;
  /** Folder with the built Vite app. Served when it exists. */
  staticDir?: string;
}

const TOO_MANY = { message: 'Too many attempts. Wait a minute and try again.' };

export function createApp(opts: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Railway's proxy sits in front: needed for the client IP and Secure cookies

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        // Only on the real HTTPS site. On http://localhost it would break the page in some browsers.
        upgradeInsecureRequests: isProd ? [] : null,
      },
    },
  }));

  const api = express.Router();
  api.use(express.json({ limit: '100kb' }));
  // Every answer carries the server's time (office time), so the app shows the right day even on a device with a wrong clock.
  api.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Now', localDateTime(now())); next(); });

  /** GET /api/health  Railway's health check. */
  api.get('/health', async (_req, res) => {
    try { await prisma.$queryRaw`select 1`; res.json({ ok: true }); }
    catch { res.status(503).json({ ok: false, message: 'Database is not reachable.' }); }
  });

  api.use(sameOrigin);
  api.use(loadSession);

  const limit = opts.authRateLimit ?? 10;
  // A whole office shares one IP address, so the limit per IP is generous. It still stops a script.
  const byIp = rateLimit({ windowMs: 60_000, limit: limit * 6, standardHeaders: true, legacyHeaders: false, message: TOO_MANY });
  // The strict limit is per email address: this is what stops someone guessing one person's password.
  const byEmail = rateLimit({
    windowMs: 60_000, limit, standardHeaders: false, legacyHeaders: false, message: TOO_MANY,
    keyGenerator: req => `email:${String((req.body as { email?: unknown } | undefined)?.email ?? '').trim().toLowerCase().slice(0, 200)}`,
  });

  api.use('/auth', authRoutes(byIp, byEmail));
  api.use('/offices', officeRoutes());
  api.use('/employees', employeeRoutes());
  api.use('/settings', settingsRoutes());
  api.use('/devices', deviceRoutes());
  api.use('/punches', punchRoutes());
  api.use('/attendance', attendanceRoutes());
  api.use('/live', liveRoutes());
  api.use('/requests', requestRoutes());
  api.use('/corrections', correctionRoutes());
  api.use('/leave', leaveRoutes());
  api.use('/notifications', notificationRoutes());
  api.use('/holidays', holidayRoutes());
  api.use('/me', meRoutes());
  api.use('/me', myRequestRoutes());
  api.use('/me', myPayslipRoutes());
  api.use('/payroll', payrollRoutes());
  api.use('/payslips', payslipRoutes());
  api.use('/', insightRoutes()); // /stats, /overview, /search, /audit, /me/home, /employees/:id/badges

  api.use((_req, res) => { res.status(404).json({ message: 'This address does not exist.' }); });
  api.use(errorHandler);
  app.use('/api', api);

  // The built frontend. Every path that is not a file falls back to index.html (client-side routes).
  const dist = opts.staticDir ?? path.resolve('dist');
  if (existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false, maxAge: isProd ? '1h' : 0 }));
    app.get(/^\/(?!api\/|iclock\/).*/, (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(dist, 'index.html')); });
  }
  return app;
}

/** Turns every error into `{ message }` with a status code. The app shows the message as it is. */
const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) return;
  if (err instanceof HttpError) return void res.status(err.status).json({ message: err.message });
  if (err instanceof ZodError) return void res.status(422).json({ message: err.issues[0]?.message ?? 'Check what you entered.' });
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return void res.status(409).json({ message: 'This already exists.' });
  const e = err as { type?: string; status?: number };
  if (e?.type === 'entity.parse.failed') return void res.status(400).json({ message: 'The request could not be read.' });
  if (e?.type === 'entity.too.large') return void res.status(413).json({ message: 'The request is too large.' });
  // The path and the error only. Request bodies (passwords, tokens) are never logged.
  console.error(`[error] ${req.method} ${req.path}:`, err instanceof Error ? err.stack ?? err.message : err);
  res.status(500).json({ message: 'Something went wrong on the server. Try again.' });
};
