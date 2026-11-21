// The bell. Every notification row also went out as an email when it was written.
import { Router } from 'express';
import { prisma } from '../db';
import { localDateTime, now } from '../lib/time';
import { actorOf, requireAuth } from '../middleware/auth';

export function notificationRoutes(): Router {
  const r = Router();

  /** GET /notifications  The latest 30 for the signed-in person, with how many are unread. */
  r.get('/', requireAuth, async (req, res) => {
    const a = actorOf(req);
    const [rows, unread] = await Promise.all([
      prisma.notification.findMany({ where: { userId: a.userId }, orderBy: { createdAt: 'desc' }, take: 30 }),
      prisma.notification.count({ where: { userId: a.userId, readAt: null } }),
    ]);
    res.json({
      unread,
      items: rows.map(n => {
        const p = n.payload as { text?: string; link?: string };
        return { id: n.id, userId: n.userId, type: n.type, text: p.text ?? '', link: p.link ?? '/', at: localDateTime(n.createdAt), read: !!n.readAt };
      }),
    });
  });

  /** POST /notifications/read  Marks everything as read. */
  r.post('/read', requireAuth, async (req, res) => {
    await prisma.notification.updateMany({ where: { userId: actorOf(req).userId, readAt: null }, data: { readAt: now() } });
    res.status(204).end();
  });

  return r;
}
