// Email. Requests only add a row to email_outbox; a worker sends the rows over SMTP.
import nodemailer, { type Transporter } from 'nodemailer';
import { prisma, type Db } from '../db';
import { env, isProd, isTest } from '../env';
import { now } from './time';

export async function queueEmail(db: Db, to: string, subject: string, body: string): Promise<void> {
  await db.emailOutbox.create({ data: { toEmail: to, subject, body } });
}

/** A full link into the app, for email bodies. */
export const appLink = (path: string) => new URL(path, env.APP_URL).toString();

let transport: Transporter | null = null;
function smtp(): Transporter | null {
  if (!env.SMTP_HOST) return null;
  transport ??= nodemailer.createTransport({
    host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } : undefined,
  });
  return transport;
}

const MAX_ATTEMPTS = 5;
let warned = false;
let running = false;

/** Sends what is waiting. Called every minute by the scheduler. Returns how many were sent. */
export async function sendQueuedEmails(): Promise<number> {
  if (running || isTest) return 0; // tests read the outbox instead of sending
  running = true;
  try {
    const t = smtp();
    if (!t && isProd) {
      if (!warned) { console.warn('[mail] SMTP_HOST is not set. Emails are waiting in email_outbox.'); warned = true; }
      return 0;
    }
    const rows = await prisma.emailOutbox.findMany({ where: { status: 'queued' }, orderBy: { createdAt: 'asc' }, take: 20 });
    let sent = 0;
    for (const m of rows) {
      try {
        if (t) await t.sendMail({ from: env.MAIL_FROM, to: m.toEmail, subject: m.subject, text: m.body });
        // Development without SMTP: print the email so invite and reset links can be used. Never in production.
        else console.log(`\n[mail, not sent: no SMTP in development]\nTo: ${m.toEmail}\nSubject: ${m.subject}\n\n${m.body}\n`);
        // The body may hold a one-time link, so it is not kept after sending.
        await prisma.emailOutbox.update({ where: { id: m.id }, data: { status: 'sent', sentAt: now(), body: '', attempts: { increment: 1 } } });
        sent++;
      } catch (e) {
        const attempts = m.attempts + 1;
        await prisma.emailOutbox.update({
          where: { id: m.id },
          data: { attempts, status: attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', lastError: e instanceof Error ? e.message.slice(0, 500) : 'send failed' },
        });
      }
    }
    return sent;
  } finally { running = false; }
}
