// Block: Message Search
// Search messages by text, sender, date, group.
//
// Fix vs original: pagination via cursor. The original read up to 1000 messages
// per group per request and loaded them all into memory — a user in 50 groups
// got 50,000 messages in RAM for a single search. Now we page (default 50,
// max 200) and accept a `cursor` (ISO timestamp) for offset.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { registerHealthCheck } from '../../core/health.js';
import { authenticate } from '../auth/index.js';
import { checkRateLimit } from '../security/index.js';
import { getDb } from '../../shared/db.js';
import { readMessages } from '../mcp/local-store.js';
import type { StoredMessage } from '../mcp/local-store.js';

export function registerSearchRoutes(app: FastifyInstance) {
  const db = getDb();

  registerHealthCheck('search', async () => ({
    status: 'healthy' as const,
    lastCheck: '',
  }));

  // ─── Search Messages ───
  app.get('/search', async (req: FastifyRequest<{ Querystring: {
    q: string;
    group_id?: string;
    sender?: string;
    type?: string;
    limit?: string;
    after?: string;
    before?: string;
    cursor?: string; // ISO timestamp — return messages older than this
  } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const rate = checkRateLimit(`search:${userId}`, 60_000, 30);
    if (!rate.allowed) return reply.code(429).send({ error: 'RATE_LIMITED' });

    const { q, group_id, sender, type, limit, after, before, cursor } = req.query;
    if (!q || q.length < 2) return reply.code(400).send({ error: 'QUERY_TOO_SHORT', message: 'Search query must be at least 2 characters' });

    const userGroups = db.prepare('SELECT group_id FROM group_members WHERE user_id = ?')
      .all(userId) as { group_id: string }[];
    const allowedGroups = new Set(userGroups.map(g => g.group_id));

    const searchGroups = group_id
      ? (allowedGroups.has(group_id) ? [group_id] : [])
      : Array.from(allowedGroups);

    if (searchGroups.length === 0) return reply.send({ results: [], count: 0, next_cursor: null });

    const maxResults = Math.min(Number(limit) || 50, 200);
    const query = q.toLowerCase();
    const results: Array<StoredMessage & { match_type: string }> = [];

    // Cap the number of messages scanned per group so a single search can't
    // load unbounded data. 500 per group × N groups is the worst case.
    const SCAN_PER_GROUP = 500;
    const effectiveBefore = cursor || before;

    for (const gid of searchGroups) {
      const messages = readMessages(gid, SCAN_PER_GROUP, effectiveBefore);
      for (const msg of messages) {
        if (sender && !msg.sender_username.toLowerCase().includes(sender.toLowerCase())) continue;
        if (type && msg.type !== type) continue;
        if (after && msg.timestamp < after) continue;

        const contentMatch = msg.content.toLowerCase().includes(query);
        const senderMatch = msg.sender_username.toLowerCase().includes(query);
        const typeMatch = msg.type.toLowerCase().includes(query);

        if (contentMatch || senderMatch || typeMatch) {
          results.push({ ...msg, match_type: contentMatch ? 'content' : senderMatch ? 'sender' : 'type' });
        }
      }
    }

    results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const page = results.slice(0, maxResults);

    // next_cursor = timestamp of the last result, if there are more.
    const nextCursor = results.length > maxResults && page.length > 0
      ? page[page.length - 1].timestamp
      : null;

    return reply.send({
      query: q,
      results: page,
      count: page.length,
      next_cursor: nextCursor,
    });
  });

  // ─── Search by Sender ───
  app.get('/search/sender/:username', async (req: FastifyRequest<{
    Params: { username: string };
    Querystring: { group_id?: string; limit?: string; cursor?: string };
  }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const rate = checkRateLimit(`search:${userId}`, 60_000, 30);
    if (!rate.allowed) return reply.code(429).send({ error: 'RATE_LIMITED' });

    const { group_id, limit, cursor } = req.query;
    const maxResults = Math.min(Number(limit) || 50, 200);

    const userGroups = db.prepare('SELECT group_id FROM group_members WHERE user_id = ?')
      .all(userId) as { group_id: string }[];
    const allowedGroups = new Set(userGroups.map(g => g.group_id));

    const searchGroups = group_id
      ? (allowedGroups.has(group_id) ? [group_id] : [])
      : Array.from(allowedGroups);

    const results: StoredMessage[] = [];
    for (const gid of searchGroups) {
      const messages = readMessages(gid, 500, cursor);
      for (const msg of messages) {
        if (msg.sender_username.toLowerCase() === req.params.username.toLowerCase()) {
          results.push(msg);
        }
      }
    }

    results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const page = results.slice(0, maxResults);
    const nextCursor = results.length > maxResults && page.length > 0 ? page[page.length - 1].timestamp : null;

    return reply.send({ sender: req.params.username, results: page, count: page.length, next_cursor: nextCursor });
  });

  // ─── Search by Type ───
  app.get('/search/type/:messageType', async (req: FastifyRequest<{
    Params: { messageType: string };
    Querystring: { group_id?: string; limit?: string; cursor?: string };
  }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const rate = checkRateLimit(`search:${userId}`, 60_000, 30);
    if (!rate.allowed) return reply.code(429).send({ error: 'RATE_LIMITED' });

    const { group_id, limit, cursor } = req.query;
    const maxResults = Math.min(Number(limit) || 50, 200);

    const userGroups = db.prepare('SELECT group_id FROM group_members WHERE user_id = ?')
      .all(userId) as { group_id: string }[];
    const allowedGroups = new Set(userGroups.map(g => g.group_id));

    const searchGroups = group_id
      ? (allowedGroups.has(group_id) ? [group_id] : [])
      : Array.from(allowedGroups);

    const results: StoredMessage[] = [];
    for (const gid of searchGroups) {
      const messages = readMessages(gid, 500, cursor);
      for (const msg of messages) {
        if (msg.type === req.params.messageType) results.push(msg);
      }
    }

    results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const page = results.slice(0, maxResults);
    const nextCursor = results.length > maxResults && page.length > 0 ? page[page.length - 1].timestamp : null;

    return reply.send({ type: req.params.messageType, results: page, count: page.length, next_cursor: nextCursor });
  });
}
