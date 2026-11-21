// Invite links (set the first password, valid 72 hours) and reset links (valid 1 hour).
import type { Db } from '../db';
import { appLink, queueEmail } from '../lib/mail';
import { now } from '../lib/time';
import { hashToken, newToken } from '../lib/tokens';
import { getSettings } from './settings';

export const INVITE_HOURS = 72;
export const RESET_MINUTES = 60;

/** Replaces any earlier invite for this user and emails the new link. Returns the token (only for development and tests). */
export async function sendInvite(db: Db, user: { id: string; email: string }, name: string): Promise<string> {
  const token = newToken();
  await db.user.update({
    where: { id: user.id },
    data: { inviteTokenHash: hashToken(token), inviteExpiresAt: new Date(now().getTime() + INVITE_HOURS * 3600_000) },
  });
  const { companyName } = await getSettings(db);
  await queueEmail(db, user.email, `Welcome to ${companyName}. Set your password.`, [
    `Hello ${name},`,
    `An account has been created for you on the ${companyName} HR system. Open this link to set your password:`,
    appLink(`/invite/${token}`),
    `The link works once and is valid for ${INVITE_HOURS} hours. If it has expired, ask your office head for a new one.`,
  ].join('\n\n'));
  return token;
}

export async function sendReset(db: Db, user: { id: string; email: string }, name: string): Promise<string> {
  const token = newToken();
  await db.user.update({
    where: { id: user.id },
    data: { resetTokenHash: hashToken(token), resetExpiresAt: new Date(now().getTime() + RESET_MINUTES * 60_000) },
  });
  const { companyName } = await getSettings(db);
  await queueEmail(db, user.email, `Reset your ${companyName} HR password`, [
    `Hello ${name},`,
    'Open this link to choose a new password:',
    appLink(`/reset/${token}`),
    `The link works once and is valid for ${RESET_MINUTES} minutes. If you did not ask for this, ignore this email. Your password stays the same.`,
  ].join('\n\n'));
  return token;
}
