import type { Db } from '../db';
import { appLink, queueEmail } from './mail';

export interface NotifyInput {
  type: string; // 'leave_decided', 'salary_changed', ...
  /** What the bell shows. Never include a salary amount. */
  text: string;
  /** Path in the app, for example '/me/leave'. */
  link: string;
  /** Extra lines for the email. The email always carries `text` and the link. */
  emailBody?: string;
}

/** One in-app notification and one email to the same person. */
export async function notify(db: Db, userId: string | null | undefined, n: NotifyInput): Promise<void> {
  if (!userId) return;
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) return;
  await db.notification.create({ data: { userId, type: n.type, payload: { text: n.text, link: n.link } } });
  await queueEmail(db, user.email, n.text, [n.text, n.emailBody, `Open: ${appLink(n.link)}`].filter(Boolean).join('\n\n'));
}

/** The user ids of all admins. */
export async function adminUserIds(db: Db): Promise<string[]> {
  return (await db.user.findMany({ where: { role: 'admin' }, select: { id: true } })).map(u => u.id);
}

/** The user id of an office's head, if it has one. */
export async function headUserId(db: Db, officeId: string): Promise<string | null> {
  const o = await db.office.findUnique({ where: { id: officeId }, select: { head: { select: { user: { select: { id: true } } } } } });
  return o?.head?.user?.id ?? null;
}
