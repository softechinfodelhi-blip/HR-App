// Email. Requests only add a row to email_outbox; a worker sends the rows through Resend (resend.com).
import { Resend } from 'resend';
import { prisma, type Db } from '../db';
import { env, isProd, isTest } from '../env';
import { now } from './time';

export async function queueEmail(db: Db, to: string, subject: string, body: string): Promise<void> {
  await db.emailOutbox.create({ data: { toEmail: to, subject, body, createdAt: now() } });
}

/** A full link into the app, for email bodies. */
export const appLink = (path: string) => new URL(path, env.APP_URL).toString();

let client: Resend | null = null;
function resend(): Resend | null {
  if (!env.RESEND_API_KEY) return null;
  client ??= new Resend(env.RESEND_API_KEY);
  return client;
}

/** Sends one email. Throws with Resend's message when it is refused. */
async function sendWithResend(r: Resend, id: string, to: string, subject: string, text: string): Promise<void> {
  const { error } = await r.emails.send(
    { from: env.RESEND_FROM ?? env.MAIL_FROM, to: [to], subject, text },
    // Same outbox row, same key: a retry after a lost response is not sent twice.
    { idempotencyKey: `outbox-${id}` },
  );
  if (error) throw new Error(`Resend: ${error.name}: ${error.message}`);
}

const MAX_ATTEMPTS = 5;
let warned = false;
let running = false;

/** Sends what is waiting. Called every minute by the scheduler. Returns how many were sent. */
export async function sendQueuedEmails(): Promise<number> {
  if (running || isTest) return 0; // tests read the outbox instead of sending
  running = true;
  try {
    const r = resend();
    if (!r && isProd) {
      if (!warned) { console.warn('[mail] RESEND_API_KEY is not set. Emails are waiting in email_outbox.'); warned = true; }
      return 0;
    }
    const rows = await prisma.emailOutbox.findMany({ where: { status: 'queued' }, orderBy: { createdAt: 'asc' }, take: 20 });
    let sent = 0;
    for (const m of rows) {
      try {
        if (r) await sendWithResend(r, m.id, m.toEmail, m.subject, m.body);
        // Development without Resend: print the email so invite and reset links can be used. Never in production.
        else console.log(`\n[mail, not sent: no RESEND_API_KEY in development]\nTo: ${m.toEmail}\nSubject: ${m.subject}\n\n${m.body}\n`);
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
