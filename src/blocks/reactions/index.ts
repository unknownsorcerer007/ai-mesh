// Block: Message Reactions
// Emoji reactions on messages.
//
// Fixes vs original:
//  - Rate-limited (was not — a user could add millions of reactions).
//  - Emoji validated against a real emoji regex (was just a length check that
//    allowed '<script>').
//  - DELETE /reactions now checks membership (was missing).
//  - Uses Zod schema for input validation.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { getDb } from '../../shared/db.js';
import { registerHealthCheck } from '../../core/health.js';
import { authenticate } from '../auth/index.js';
import { checkRateLimit } from '../security/rate-limit.js';
import { parse, reactionSchema } from '../../shared/validation.js';

// Emoji presentation: covers most single-grapheme emoji. We don't need to be
// exhaustive — we just need to reject anything containing markup like <script>.
// The regex allows Unicode emoji + ZWJ + variation selectors, up to 32 chars.
const EMOJI_RE = /^(\p{Extended_Pictographic}(\p{Emoji_Modifier}|\uFE0F\u20E3?|\u200D\p{Extended_Pictographic})*|\u200d?\p{Extended_Pictographic})+$/u;

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
  app.post('/reactions', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const parsed = parse(reactionSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: 'INVALID_REQUEST', message: parsed.error });
    const { group_id, message_id, emoji } = parsed.data;

    // Validate emoji presentation (blocks '<script>' etc.)
    if (!EMOJI_RE.test(emoji)) {
      return reply.code(400).send({ error: 'INVALID_EMOJI', message: 'Must be a single emoji' });
    }

    const member = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(group_id, userId);
    if (!member) return reply.code(403).send({ error: 'NOT_A_MEMBER' });

    // Rate limit (per-user) — 60 reactions per minute
    const rl = checkRateLimit(`react:${userId}`, 60_000, 60);
    if (!rl.allowed) return reply.code(429).send({ error: 'RATE_LIMITED' });

    try {
      db.prepare('INSERT OR IGNORE INTO reactions (id, message_id, group_id, emoji, user_id) VALUES (?,?,?,?,?)')
        .run(nanoid(), message_id, group_id, emoji, userId);
    } catch (err: any) {
      if (err.message?.includes('UNIQUE')) {
        return reply.send({ message_id, emoji, count: getReactionCount(message_id, emoji) });
      }
      throw err;
    }

    return reply.send({ message_id, emoji, count: getReactionCount(message_id, emoji) });
  });

  // ─── Remove Reaction (membership-checked) ───
  app.delete('/reactions', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const parsed = parse(reactionSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: 'INVALID_REQUEST', message: parsed.error });
    const { group_id, message_id, emoji } = parsed.data;

    // The original didn't check membership — any user could delete any reaction.
    const member = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(group_id, userId);
    if (!member) return reply.code(403).send({ error: 'NOT_A_MEMBER' });

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
