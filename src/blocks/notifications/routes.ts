// Notifications: HTTP Routes
// All routes are scoped to the authenticated user — no cross-user access.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate } from '../auth/index.js';
import { getNotifications, getUnreadNotifications, clearNotifications, getUnreadCount, markAllRead } from './index.js';

export function registerNotificationRoutes(app: FastifyInstance) {

  // ─── Get Notifications (mine only) ───
  app.get('/notifications', async (req: FastifyRequest<{ Querystring: { limit?: string; unread?: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const onlyUnread = req.query.unread === '1' || req.query.unread === 'true';
    const notifications = onlyUnread ? getUnreadNotifications(userId, limit) : getNotifications(userId, limit);

    return reply.send({
      notifications,
      count: notifications.length,
      unread: getUnreadCount(userId),
    });
  });

  // ─── Clear MY notifications (not anyone else's) ───
  app.delete('/notifications', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    clearNotifications(userId);
    return reply.send({ status: 'cleared' });
  });

  // ─── Mark all as read ───
  app.post('/notifications/read', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });
    const marked = markAllRead(userId);
    return reply.send({ marked, unread: getUnreadCount(userId) });
  });

  // ─── Unread count ───
  app.get('/notifications/count', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });
    return reply.send({ unread: getUnreadCount(userId) });
  });
}
