// Block: Message Threading
// Reply to specific messages (like Slack threads)
// SQLite-backed — survives restarts

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { getDb } from '../../shared/db.js';
import { registerHealthCheck } from '../../core/health.js';
import { authenticate } from '../auth/index.js';
import type { RelayMessage } from '../../shared/types.js';

export function registerThreadingRoutes(app: FastifyInstance) {
  const db = getDb();

  registerHealthCheck('threading', async () => {
    try {
      const count = db.prepare('SELECT COUNT(*) as c FROM threads').get() as { c: number };
      return { status: 'healthy' as const, message: `${count.c} active threads`, lastCheck: '' };
    } catch {
      return { status: 'healthy' as const, message: '0 threads', lastCheck: '' };
    }
  });

  // ─── Reply to Message (Thread) ───
  app.post('/thread/reply', async (req: FastifyRequest<{ Body: {
    group_id: string;
    parent_message_id: string;
    message: string;
    type?: string;
  } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const { group_id, parent_message_id, message, type } = req.body;
    if (!group_id || !parent_message_id || !message) {
      return reply.code(400).send({ error: 'MISSING_FIELDS' });
    }

    const member = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?').get(group_id, userId) as any;
    if (!member) return reply.code(403).send({ error: 'NOT_A_MEMBER' });

    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string };
    const now = new Date().toISOString();

    // Upsert thread metadata
    const existing = db.prepare('SELECT * FROM threads WHERE parent_message_id = ?').get(parent_message_id) as any;
    if (existing) {
      db.prepare("UPDATE threads SET reply_count = reply_count + 1, last_reply_at = ? WHERE parent_message_id = ?")
        .run(now, parent_message_id);
    } else {
      db.prepare('INSERT INTO threads (id, group_id, parent_message_id, reply_count, last_reply_at) VALUES (?,?,?,?,?)')
        .run(nanoid(), group_id, parent_message_id, 1, now);
    }

    const thread = db.prepare('SELECT * FROM threads WHERE parent_message_id = ?').get(parent_message_id) as any;

    const msgId = nanoid();
    const relayMsg: RelayMessage = {
      id: msgId,
      group_id,
      sender_id: userId,
      sender_username: user.username,
      type: (type as any) || 'text',
      content: message,
      metadata: {
        thread_id: thread.id,
        parent_message_id,
        reply_count: thread.reply_count,
      },
      timestamp: now,
    };

    try {
      const { publishToGroup } = await import('../relay/index.js');
      publishToGroup(group_id, relayMsg);
    } catch {
      return reply.code(502).send({ error: 'RELAY_UNAVAILABLE' });
    }

    return reply.send({
      id: msgId,
      thread_id: thread.id,
      reply_count: thread.reply_count,
    });
  });

  // ─── Get Thread Replies ───
  app.get('/thread/:parentMessageId', async (req: FastifyRequest<{
    Params: { parentMessageId: string };
    Querystring: { limit?: string };
  }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const thread = db.prepare('SELECT * FROM threads WHERE parent_message_id = ?')
      .get(req.params.parentMessageId) as any;

    if (!thread) {
      return reply.send({ thread_id: `thread_${req.params.parentMessageId}`, replies: [], reply_count: 0 });
    }

    const member = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(thread.group_id, userId);
    if (!member) return reply.code(403).send({ error: 'NOT_A_MEMBER' });

    let replies: RelayMessage[] = [];
    try {
      const { getPendingMessages } = await import('../relay/index.js');
      const allMessages = await getPendingMessages(userId, thread.group_id);
      replies = allMessages.filter(m =>
        m.metadata && (m.metadata as any).parent_message_id === req.params.parentMessageId
      );
    } catch { /* NATS may be down */ }

    const limit = Math.min(Number(req.query.limit) || 50, 200);

    return reply.send({
      thread_id: thread.id,
      parent_message_id: req.params.parentMessageId,
      reply_count: thread.reply_count,
      last_reply_at: thread.last_reply_at,
      replies: replies.slice(0, limit),
    });
  });

  // ─── List Active Threads in Group ───
  app.get('/threads/:groupId', async (req: FastifyRequest<{
    Params: { groupId: string };
    Querystring: { limit?: string };
  }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const member = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(req.params.groupId, userId);
    if (!member) return reply.code(403).send({ error: 'NOT_A_MEMBER' });

    const limit = Math.min(Number(req.query.limit) || 20, 100);

    const threads = db.prepare('SELECT * FROM threads WHERE group_id = ? ORDER BY last_reply_at DESC LIMIT ?')
      .all(req.params.groupId, limit);

    return reply.send({
      threads,
      count: threads.length,
    });
  });
}
