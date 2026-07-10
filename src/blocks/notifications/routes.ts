// Notifications: HTTP Routes
// MCP agents can check notifications via API

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate } from '../auth/index.js';
import { getNotifications, clearNotifications, getUnreadCount, type Notification } from './index.js';

export function registerNotificationRoutes(app: FastifyInstance) {

  // ─── Get Notifications ───
  app.get('/notifications', async (req: FastifyRequest<{ Querystring: { limit?: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const notifications = getNotifications(limit);

    return reply.send({
      notifications,
      count: notifications.length,
      unread: getUnreadCount(),
    });
  });

  // ─── Clear Notifications ───
  app.delete('/notifications', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    clearNotifications();
    return reply.send({ status: 'cleared' });
  });

  // ─── Notification Count ───
  app.get('/notifications/count', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    return reply.send({ unread: getUnreadCount() });
  });
}
