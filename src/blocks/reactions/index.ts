// Block: Message Reactions
// Emoji reactions on messages (like Slack)
// SQLite-backed — survives restarts

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { getDb } from '../../shared/db.js';
import { registerHealthCheck } from '../../core/health.js';
import { authenticate } from '../auth/index.js';

export function registerReactionRoutes(app: FastifyInstance) {
  const db = getDb();

  registerHealthCheck('reactions', async () => {
    try {
      const count = db.prepare('SELECT COUNT(*) as c FROM reactions').get() as { c: number };
      return { status: 'healthy' as const, message: `${count.c} reactions stored`, lastCheck: '' };
    } catch {
      return { status: 'healthy' as const, message: '0 reactions', lastCheck: '' };
    }
  });

  // ─── Add Reaction ───
  app.post('/reactions', async (req: FastifyRequest<{ Body: {
    group_id: string;
    message_id: string;
    emoji: string;
  } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const { group_id, message_id, emoji } = req.body;
    if (!group_id || !message_id || !emoji) {
      return reply.code(400).send({ error: 'MISSING_FIELDS' });
    }

    const member = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(group_id, userId);
    if (!member) return reply.code(403).send({ error: 'NOT_A_MEMBER' });

    if (emoji.length > 8) {
      return reply.code(400).send({ error: 'INVALID_EMOJI' });
    }

    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string };

    try {
      db.prepare('INSERT OR IGNORE INTO reactions (id, message_id, group_id, emoji, user_id) VALUES (?,?,?,?,?)')
        .run(nanoid(), message_id, group_id, emoji, userId);
    } catch (err: any) {
      if (err.message?.includes('UNIQUE')) {
        return reply.send({ message_id, emoji, count: getReactionCount(message_id, emoji) });
      }
      throw err;
    }

    return reply.send({
      message_id,
      emoji,
      count: getReactionCount(message_id, emoji),
    });
  });

  // ─── Remove Reaction ───
  app.delete('/reactions', async (req: FastifyRequest<{ Body: {
    group_id: string;
    message_id: string;
    emoji: string;
  } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const { message_id, emoji } = req.body;

    db.prepare('DELETE FROM reactions WHERE message_id = ? AND emoji = ? AND user_id = ?')
      .run(message_id, emoji, userId);

    return reply.send({ message_id, emoji, removed: true });
  });

  // ─── Get Reactions for Message ───
  app.get('/reactions/:messageId', async (req: FastifyRequest<{ Params: { messageId: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const rows = db.prepare(`
      SELECT r.emoji, r.user_id, u.username
      FROM reactions r JOIN users u ON u.id = r.user_id
      WHERE r.message_id = ?
    `).all(req.params.messageId) as { emoji: string; user_id: string; username: string }[];

    const result: Record<string, { count: number; users: string[] }> = {};
    for (const row of rows) {
      if (!result[row.emoji]) result[row.emoji] = { count: 0, users: [] };
      result[row.emoji].count++;
      result[row.emoji].users.push(row.username);
    }

    return reply.send({ message_id: req.params.messageId, reactions: result });
  });
}

function getReactionCount(messageId: string, emoji: string): number {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as c FROM reactions WHERE message_id = ? AND emoji = ?')
    .get(messageId, emoji) as { c: number };
  return row.c;
}
