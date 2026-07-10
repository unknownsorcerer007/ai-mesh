// Block: Message Threading
// Reply to specific messages (like Slack threads)
// Zero AI — just message metadata

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { getDb } from '../../shared/db.js';
import { registerHealthCheck } from '../../core/health.js';
import { authenticate } from '../auth/index.js';
import type { RelayMessage } from '../../shared/types.js';

// Thread metadata stored in memory (ephemeral like messages)
const threads = new Map<string, {
  id: string;
  group_id: string;
  parent_message_id: string;
  parent_content: string;
  parent_sender: string;
  reply_count: number;
  last_reply_at: string;
  created_at: string;
}>();

export function registerThreadingRoutes(app: FastifyInstance) {
  const db = getDb();

  registerHealthCheck('threading', async () => ({
    status: 'healthy' as const,
    message: `${threads.size} active threads`,
    lastCheck: '',
  }));

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

    // Verify membership
    const member = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?').get(group_id, userId) as any;
    if (!member) return reply.code(403).send({ error: 'NOT_A_MEMBER' });

    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string };

    // Update thread metadata
    const threadId = `thread_${parent_message_id}`;
    const existingThread = threads.get(threadId);
    if (existingThread) {
      existingThread.reply_count++;
      existingThread.last_reply_at = new Date().toISOString();
    } else {
      threads.set(threadId, {
        id: threadId,
        group_id,
        parent_message_id,
        parent_content: '', // Will be filled from message
        parent_sender: '',
        reply_count: 1,
        last_reply_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      });
    }

    // Create reply message with thread reference
    const msgId = nanoid();
    const now = new Date().toISOString();

    const relayMsg: RelayMessage = {
      id: msgId,
      group_id,
      sender_id: userId,
      sender_username: user.username,
      type: (type as any) || 'text',
      content: message,
      metadata: {
        thread_id: threadId,
        parent_message_id,
        reply_count: threads.get(threadId)?.reply_count || 1,
      },
      timestamp: now,
    };

    // Publish to group
    try {
      const { publishToGroup } = await import('../relay/index.js');
      publishToGroup(group_id, relayMsg);
    } catch {
      return reply.code(502).send({ error: 'RELAY_UNAVAILABLE' });
    }

    return reply.send({
      id: msgId,
      thread_id: threadId,
      reply_count: threads.get(threadId)?.reply_count || 1,
    });
  });

  // ─── Get Thread Replies ───
  app.get('/thread/:parentMessageId', async (req: FastifyRequest<{
    Params: { parentMessageId: string };
    Querystring: { limit?: string };
  }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const threadId = `thread_${req.params.parentMessageId}`;
    const thread = threads.get(threadId);

    if (!thread) {
      return reply.send({ thread_id: threadId, replies: [], reply_count: 0 });
    }

    // Verify membership
    const member = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(thread.group_id, userId);
    if (!member) return reply.code(403).send({ error: 'NOT_A_MEMBER' });

    // Get replies from JetStream
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
      thread_id: threadId,
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

    // Verify membership
    const member = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(req.params.groupId, userId);
    if (!member) return reply.code(403).send({ error: 'NOT_A_MEMBER' });

    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const groupThreads: any[] = [];

    for (const [, t] of threads) {
      if (t.group_id === req.params.groupId) {
        groupThreads.push(t);
      }
    }

    groupThreads.sort((a, b) => b.last_reply_at.localeCompare(a.last_reply_at));

    return reply.send({
      threads: groupThreads.slice(0, limit),
      count: Math.min(groupThreads.length, limit),
    });
  });
}
