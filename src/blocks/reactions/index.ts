// Block: Message Reactions
// Emoji reactions on messages (like Slack)
// Zero AI — just metadata

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { getDb } from '../../shared/db.js';
import { registerHealthCheck } from '../../core/health.js';
import { authenticate } from '../auth/index.js';
import type { RelayMessage } from '../../shared/types.js';

// Reactions stored in memory (ephemeral like messages)
const reactions = new Map<string, Map<string, Set<string>>>(); // messageId -> emoji -> Set<userId>

export function registerReactionRoutes(app: FastifyInstance) {
  const db = getDb();

  registerHealthCheck('reactions', async () => ({
    status: 'healthy' as const,
    message: `${reactions.size} messages with reactions`,
    lastCheck: '',
  }));

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

    // Verify membership
    const member = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(group_id, userId);
    if (!member) return reply.code(403).send({ error: 'NOT_A_MEMBER' });

    // Validate emoji (basic check — must be a single emoji)
    if (emoji.length > 8) {
      return reply.code(400).send({ error: 'INVALID_EMOJI' });
    }

    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string };

    // Add reaction
    if (!reactions.has(message_id)) reactions.set(message_id, new Map());
    const msgReactions = reactions.get(message_id)!;
    if (!msgReactions.has(emoji)) msgReactions.set(emoji, new Set());
    msgReactions.get(emoji)!.add(userId);

    // Notify group about reaction
    try {
      const { publishToGroup } = await import('../relay/index.js');
      publishToGroup(group_id, {
        id: nanoid(),
        group_id,
        sender_id: 'system',
        sender_username: user.username,
        type: 'system',
        content: `${emoji} reaction by ${user.username}`,
        metadata: { reaction: true, message_id, emoji, user_id: userId },
        timestamp: new Date().toISOString(),
      });
    } catch { /* NATS may be down */ }

    return reply.send({
      message_id,
      emoji,
      count: msgReactions.get(emoji)?.size || 0,
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

    const msgReactions = reactions.get(message_id);
    if (msgReactions?.has(emoji)) {
      msgReactions.get(emoji)!.delete(userId);
      if (msgReactions.get(emoji)!.size === 0) msgReactions.delete(emoji);
      if (msgReactions.size === 0) reactions.delete(message_id);
    }

    return reply.send({ message_id, emoji, removed: true });
  });

  // ─── Get Reactions for Message ───
  app.get('/reactions/:messageId', async (req: FastifyRequest<{ Params: { messageId: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const msgReactions = reactions.get(req.params.messageId);
    if (!msgReactions) {
      return reply.send({ message_id: req.params.messageId, reactions: {} });
    }

    const result: Record<string, { count: number; users: string[] }> = {};
    for (const [emoji, userIds] of msgReactions) {
      const usernames: string[] = [];
      for (const uid of userIds) {
        const user = db.prepare('SELECT username FROM users WHERE id = ?').get(uid) as { username: string } | undefined;
        if (user) usernames.push(user.username);
      }
      result[emoji] = { count: userIds.size, users: usernames };
    }

    return reply.send({ message_id: req.params.messageId, reactions: result });
  });
}
