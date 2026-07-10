// Block: Message Search
// Search messages by text, sender, date, group
// Zero AI — simple text matching

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
  } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    // Rate limit search
    const rate = checkRateLimit(`search:${userId}`, 60000, 30);
    if (!rate.allowed) return reply.code(429).send({ error: 'RATE_LIMITED' });

    const { q, group_id, sender, type, limit, after, before } = req.query;
    if (!q || q.length < 2) return reply.code(400).send({ error: 'QUERY_TOO_SHORT', message: 'Search query must be at least 2 characters' });

    // Get user's groups
    const userGroups = db.prepare('SELECT group_id FROM group_members WHERE user_id = ?')
      .all(userId) as { group_id: string }[];
    const allowedGroups = new Set(userGroups.map(g => g.group_id));

    // Filter by group if specified
    const searchGroups = group_id
      ? (allowedGroups.has(group_id) ? [group_id] : [])
      : Array.from(allowedGroups);

    if (searchGroups.length === 0) {
      return reply.send({ results: [], count: 0 });
    }

    const maxResults = Math.min(Number(limit) || 50, 200);
    const query = q.toLowerCase();
    const results: Array<StoredMessage & { match_type: string }> = [];

    // Search in local storage (MCP stored messages)
    for (const gid of searchGroups) {
      const messages = readMessages(gid, 1000, before);

      for (const msg of messages) {
        // Filter by sender
        if (sender && !msg.sender_username.toLowerCase().includes(sender.toLowerCase())) continue;

        // Filter by type
        if (type && msg.type !== type) continue;

        // Filter by date
        if (after && msg.timestamp < after) continue;
        if (before && msg.timestamp > before) continue;

        // Text match
        const contentMatch = msg.content.toLowerCase().includes(query);
        const senderMatch = msg.sender_username.toLowerCase().includes(query);
        const typeMatch = msg.type.toLowerCase().includes(query);

        if (contentMatch || senderMatch || typeMatch) {
          results.push({
            ...msg,
            match_type: contentMatch ? 'content' : senderMatch ? 'sender' : 'type',
          });
        }
      }
    }

    // Sort by timestamp (newest first)
    results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    return reply.send({
      query: q,
      results: results.slice(0, maxResults),
      count: Math.min(results.length, maxResults),
      total_matches: results.length,
    });
  });

  // ─── Search by Sender ───
  app.get('/search/sender/:username', async (req: FastifyRequest<{
    Params: { username: string };
    Querystring: { group_id?: string; limit?: string };
  }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const { group_id, limit } = req.query;
    const maxResults = Math.min(Number(limit) || 50, 200);

    const userGroups = db.prepare('SELECT group_id FROM group_members WHERE user_id = ?')
      .all(userId) as { group_id: string }[];
    const allowedGroups = new Set(userGroups.map(g => g.group_id));

    const searchGroups = group_id
      ? (allowedGroups.has(group_id) ? [group_id] : [])
      : Array.from(allowedGroups);

    const results: StoredMessage[] = [];

    for (const gid of searchGroups) {
      const messages = readMessages(gid, 1000);
      for (const msg of messages) {
        if (msg.sender_username.toLowerCase() === req.params.username.toLowerCase()) {
          results.push(msg);
        }
      }
    }

    results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    return reply.send({
      sender: req.params.username,
      results: results.slice(0, maxResults),
      count: Math.min(results.length, maxResults),
    });
  });

  // ─── Search by Type ───
  app.get('/search/type/:messageType', async (req: FastifyRequest<{
    Params: { messageType: string };
    Querystring: { group_id?: string; limit?: string };
  }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const { group_id, limit } = req.query;
    const maxResults = Math.min(Number(limit) || 50, 200);

    const userGroups = db.prepare('SELECT group_id FROM group_members WHERE user_id = ?')
      .all(userId) as { group_id: string }[];
    const allowedGroups = new Set(userGroups.map(g => g.group_id));

    const searchGroups = group_id
      ? (allowedGroups.has(group_id) ? [group_id] : [])
      : Array.from(allowedGroups);

    const results: StoredMessage[] = [];

    for (const gid of searchGroups) {
      const messages = readMessages(gid, 1000);
      for (const msg of messages) {
        if (msg.type === req.params.messageType) {
          results.push(msg);
        }
      }
    }

    results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    return reply.send({
      type: req.params.messageType,
      results: results.slice(0, maxResults),
      count: Math.min(results.length, maxResults),
    });
  });
}
