// Block: Message Threading
// Reply to specific messages (like Slack threads).
//
// Fixes vs original:
//  - POST /thread/reply now goes through sendMessageToGroup (shared business
//    logic), so it gets the SAME injection-detection, sanitization, and rate
//    limiting as /messages. The original skipped all three.
//  - sender_ai is now propagated (the original dropped it).
//  - GET /thread/:id reads from the thread_replies SQLite table instead of
//    fetching+acking ALL pending group messages and filtering client-side
//    (which destroyed the user's inbox on every thread view).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { getDb } from '../../shared/db.js';
import { registerHealthCheck } from '../../core/health.js';
import { authenticate } from '../auth/index.js';
import { checkRateLimit } from '../security/rate-limit.js';
import { sanitizeMessage } from '../security/injection.js';
import { publishToGroup } from '../relay/index.js';
import { sendMessageToGroup } from '../messages/index.js';
import { parse, threadReplySchema } from '../../shared/validation.js';
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
  app.post('/thread/reply', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const parsed = parse(threadReplySchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: 'INVALID_REQUEST', message: parsed.error });

    // Rate limit thread replies (per-user) — same window as messages.
    const rl = checkRateLimit(`thread:${userId}`, 60_000, 60);
    if (!rl.allowed) return reply.code(429).send({ error: 'RATE_LIMITED', message: 'Too many thread replies' });

    // Upsert thread metadata
    const now = new Date().toISOString();
    const existing = db.prepare('SELECT id, reply_count FROM threads WHERE parent_message_id = ?').get(parsed.data.parent_message_id) as { id: string; reply_count: number } | undefined;
    let threadId: string;
    let replyCount: number;
    if (existing) {
      threadId = existing.id;
      replyCount = existing.reply_count + 1;
      db.prepare("UPDATE threads SET reply_count = ?, last_reply_at = ? WHERE parent_message_id = ?")
        .run(replyCount, now, parsed.data.parent_message_id);
    } else {
      threadId = nanoid();
      replyCount = 1;
      db.prepare('INSERT INTO threads (id, group_id, parent_message_id, reply_count, last_reply_at) VALUES (?,?,?,?,?)')
        .run(threadId, parsed.data.group_id, parsed.data.parent_message_id, replyCount, now);
    }

    // Send the reply as a real message through shared business-logic — this
    // enforces injection detection, sanitization, rate-limit, membership, and
    // audit logging. The thread metadata rides along in `metadata`.
    const result = sendMessageToGroup(userId, {
      group_id: parsed.data.group_id,
      message: parsed.data.message,
      type: parsed.data.type,
      sender_ai: parsed.data.sender_ai,
      metadata: {
        thread_id: threadId,
        parent_message_id: parsed.data.parent_message_id,
        reply_count: replyCount,
      },
    });
    if (!result.ok) return reply.code(result.status).send({ error: result.code, message: result.message });

    // Persist the reply content in thread_replies so GET /thread/:id is a pure
    // SQLite read (no NATS ack, no inbox destruction).
    const senderRow = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string };
    db.prepare(
      `INSERT INTO thread_replies (id, thread_id, group_id, parent_message_id, sender_id, sender_username, sender_ai, type, content, timestamp)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      result.data.id, threadId, parsed.data.group_id, parsed.data.parent_message_id,
      userId, senderRow.username, parsed.data.sender_ai ?? null,
      parsed.data.type, sanitizeMessage(parsed.data.message), result.data.timestamp
    );

    return reply.send({
      id: result.data.id,
      thread_id: threadId,
      reply_count: replyCount,
    });
  });

  // ─── Get Thread Replies (non-destructive SQLite read) ───
  app.get('/thread/:parentMessageId', async (req: FastifyRequest<{
    Params: { parentMessageId: string };
    Querystring: { limit?: string; before?: string };
  }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const thread = db.prepare('SELECT * FROM threads WHERE parent_message_id = ?')
      .get(req.params.parentMessageId) as { id: string; group_id: string; reply_count: number; last_reply_at: string } | undefined;

    if (!thread) {
      return reply.send({ thread_id: `thread_${req.params.parentMessageId}`, replies: [], reply_count: 0 });
    }

    // Authorize: user must be a member of the thread's group
    const member = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(thread.group_id, userId);
    if (!member) return reply.code(403).send({ error: 'NOT_A_MEMBER' });

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    let replies;
    if (req.query.before) {
      replies = db.prepare(
        'SELECT * FROM thread_replies WHERE thread_id = ? AND timestamp < ? ORDER BY timestamp ASC LIMIT ?'
      ).all(thread.id, req.query.before, limit);
    } else {
      replies = db.prepare(
        'SELECT * FROM thread_replies WHERE thread_id = ? ORDER BY timestamp ASC LIMIT ?'
      ).all(thread.id, limit);
    }

    return reply.send({
      thread_id: thread.id,
      parent_message_id: req.params.parentMessageId,
      reply_count: thread.reply_count,
      last_reply_at: thread.last_reply_at,
      replies,
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

    return reply.send({ threads, count: threads.length });
  });
}
