// Block: Message Routing
// Send via NATS, deliver via WS, offline handled by JetStream
// Depends on: relay, groups, auth, security, shared/db

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { getDb } from '../../shared/db.js';
import { registerHealthCheck, type BlockHealth } from '../../core/health.js';
import { authenticate } from '../auth/index.js';
import { detectInjection, sanitizeMessage, checkRateLimit } from '../security/index.js';
import { getConfig } from '../../core/config.js';
import { publishToGroup, subscribeToGroup, subscribeToUser, ensureConsumer, getPendingMessages, getAllPendingMessages } from '../relay/index.js';
import { logMessage, logFullMessage } from '../logs/index.js';
import { pushNotification } from '../notifications/index.js';
import type { RelayMessage } from '../../shared/types.js';
import type { Subscription } from 'nats';

// ─── Active connections ───
const MAX_WS_PER_USER = 5;
const WS_RATE_LIMIT = 30; // messages per minute per socket
const wsConnections = new Map<string, Set<{ readyState: number; send: (d: string) => void; close?: (c?: number, r?: string) => void }>>();
const groupSubscriptions = new Map<string, Subscription>();
const userSubscriptions = new Map<string, Subscription>();
const wsRateLimits = new Map<string, { count: number; resetAt: number }>(); // per-socket rate limit

function deliverToUser(userId: string, data: unknown): boolean {
  const sockets = wsConnections.get(userId);
  if (!sockets || sockets.size === 0) return false;
  const json = JSON.stringify(data);
  let delivered = false;
  for (const ws of sockets) {
    try { if (ws.readyState === 1) { ws.send(json); delivered = true; } } catch { /* closed */ }
  }

  // Fix: Trigger notification for message delivery
  if (delivered) {
    try {
      const event = data as any;
      if (event.type === 'message' && event.payload) {
        pushNotification({
          type: 'message',
          title: event.payload.sender_username || 'Agent',
          body: event.payload.content?.slice(0, 200) || 'New message',
          sender: event.payload.sender_username,
          timestamp: event.timestamp || new Date().toISOString(),
        });
      }
    } catch { /* notification failure is non-critical */ }
  }

  return delivered;
}

async function deliverToGroupMembers(groupId: string, msg: RelayMessage, excludeUserId?: string) {
  const db = getDb();
  const members = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(groupId) as { user_id: string }[];
  let online = 0, offline = 0;

  for (const m of members) {
    if (m.user_id === excludeUserId) continue;
    if (deliverToUser(m.user_id, { type: 'message', payload: msg, group_id: groupId, timestamp: msg.timestamp })) {
      online++;
    } else {
      offline++;
      try { await ensureConsumer(groupId, m.user_id); } catch { /* NATS down */ }
    }
  }

  return { online, offline };
}

export function registerMessageRoutes(app: FastifyInstance) {
  const db = getDb();
  const config = getConfig();

  // Health check
  registerHealthCheck('messages', async (): Promise<BlockHealth> => {
    return { status: 'healthy', lastCheck: '' };
  });

  // ─── Send Message ───
  app.post('/messages', async (req: FastifyRequest<{ Body: {
    group_id: string; message: string; type?: string;
    metadata?: Record<string, unknown>; sender_ai?: string;
  } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const { group_id, message, type, metadata, sender_ai } = req.body;
    if (!group_id || !message) return reply.code(400).send({ error: 'MISSING_FIELDS' });

    const validTypes = ['text', 'code', 'alert', 'system'];
    if (type && !validTypes.includes(type)) return reply.code(400).send({ error: 'INVALID_TYPE' });

    const rate = checkRateLimit(`msg:${userId}`, config.rateLimit.windowMs, config.rateLimit.maxRequests);
    if (!rate.allowed) {
      reply.header('X-RateLimit-Limit', config.rateLimit.maxRequests);
      reply.header('X-RateLimit-Remaining', 0);
      reply.header('Retry-After', Math.ceil(config.rateLimit.windowMs / 1000));
      return reply.code(429).send({ error: 'RATE_LIMITED', retry_after: Math.ceil(config.rateLimit.windowMs / 1000) });
    }

    const member = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?').get(group_id, userId);
    if (!member) return reply.code(403).send({ error: 'NOT_A_MEMBER' });

    const injection = detectInjection(message);
    if (!injection.safe) return reply.code(400).send({ error: 'INJECTION_BLOCKED', message: injection.reason });

    const clean = sanitizeMessage(message);
    const sender = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string };
    const groupInfo = db.prepare('SELECT name FROM groups WHERE id = ?').get(group_id) as { name: string } | undefined;

    const relayMsg: RelayMessage = {
      id: nanoid(), group_id, sender_id: userId, sender_username: sender.username,
      sender_ai: sender_ai || undefined, type: (type as any) || 'text',
      content: clean, metadata: metadata || undefined, timestamp: new Date().toISOString(),
    };

    // Publish to NATS (fire-and-forget for speed)
    publishToGroup(group_id, relayMsg);

    // Deliver to online users (fire-and-forget)
    deliverToGroupMembers(group_id, relayMsg, userId).catch(() => {});

    // Audit log (fire-and-forget)
    logMessage({ group_id, group_name: groupInfo?.name || group_id, sender: sender.username, sender_ai, type: type || 'text', content: clean, timestamp: relayMsg.timestamp });
    logFullMessage({ group_id, group_name: groupInfo?.name || group_id, sender_id: userId, sender_username: sender.username, sender_ai, type: type || 'text', content: clean, metadata, timestamp: relayMsg.timestamp });

    return reply.send({ id: relayMsg.id, status: 'routed' });
  });

  // ─── Inbox (flush JetStream pending) ───
  app.get('/messages/inbox', async (req: FastifyRequest<{ Querystring: { group_id?: string; limit?: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const groups = db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(userId) as { group_id: string }[];
    if (groups.length === 0) return reply.send({ messages: [], count: 0 });

    const groupIds = groups.map(g => g.group_id);
    let messages: RelayMessage[];

    if (req.query.group_id) {
      if (!groupIds.includes(req.query.group_id)) return reply.code(403).send({ error: 'NOT_A_MEMBER' });
      messages = await getPendingMessages(userId, req.query.group_id);
    } else {
      messages = await getAllPendingMessages(userId, groupIds);
    }

    return reply.send({ messages: messages.slice(0, limit), count: Math.min(messages.length, limit) });
  });

  // ─── Group History ───
  app.get('/messages/:groupId', async (req: FastifyRequest<{ Params: { groupId: string }; Querystring: { limit?: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const member = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?').get(req.params.groupId, userId);
    if (!member) return reply.code(403).send({ error: 'NOT_A_MEMBER' });

    await ensureConsumer(req.params.groupId, userId);
    const messages = await getPendingMessages(userId, req.params.groupId);
    return reply.send({ messages, count: messages.length });
  });

  // ─── WebSocket (first-message auth — no token in URL) ───
  app.get('/ws', { websocket: true }, (socket, req) => {
    let userId: string | null = null;
    let authenticated = false;
    const socketId = nanoid();
    const authTimeout = setTimeout(() => {
      if (!authenticated) socket.close(4008, 'Auth timeout');
    }, 10000); // 10 seconds to authenticate

    function onFirstMessage(data: any) {
      try {
        const msg = JSON.parse(data.toString());

        // First message must be auth
        if (msg.type !== 'auth' || !msg.token) {
          socket.close(4001, 'First message must be { type: "auth", token: "***" }');
          return;
        }

        userId = authenticate({ headers: { authorization: `Bearer ${msg.token}` } } as any);
        if (!userId) {
          socket.close(4003, 'Invalid token');
          return;
        }

        // Fix: Limit WS connections per user
        if (!wsConnections.has(userId!)) wsConnections.set(userId!, new Set());
        const userSockets = wsConnections.get(userId!)!;
        if (userSockets.size >= MAX_WS_PER_USER) {
          socket.close(4029, 'Too many connections');
          return;
        }

        authenticated = true;
        clearTimeout(authTimeout);
        userSockets.add(socket as any);
        wsRateLimits.set(socketId, { count: 0, resetAt: Date.now() + 60000 });

        // Remove this handler, add normal message handler
        socket.removeListener('message', onFirstMessage);
        setupAuthenticatedSocket(socket, userId!, socketId);

        // Send welcome
        socket.send(JSON.stringify({ type: 'authenticated', payload: { message: 'Connected to AI Mesh relay' }, timestamp: new Date().toISOString() }));
      } catch {
        socket.close(4002, 'Invalid message format');
      }
    }

    socket.on('message', onFirstMessage);

    socket.on('close', () => {
      clearTimeout(authTimeout);
      wsRateLimits.delete(socketId);
    });

    socket.on('error', () => {
      clearTimeout(authTimeout);
      wsRateLimits.delete(socketId);
    });
  });

  function setupAuthenticatedSocket(
    socket: { readyState: number; send: (d: string) => void; close?: (c?: number, r?: string) => void; on: (e: string, cb: any) => void },
    userId: string,
    socketId: string
  ) {
    // Subscribe to events
    if (!userSubscriptions.has(userId)) {
      try {
        const sub = subscribeToUser(userId, (event) => {
          deliverToUser(userId, { type: event.type, payload: event.payload, timestamp: event.timestamp });
        });
        userSubscriptions.set(userId, sub);
      } catch { /* NATS down */ }
    }

    // Subscribe to groups
    const groups = db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(userId) as { group_id: string }[];
    for (const g of groups) {
      ensureGroupSubscription(g.group_id);
      ensureConsumer(g.group_id, userId).catch(() => {});
    }

    // Flush pending
    flushPendingToUser(userId, groups.map(g => g.group_id));

    // Handle messages with rate limiting
    socket.on('message', (data: any) => {
      const rl = wsRateLimits.get(socketId);
      if (rl) {
        if (Date.now() > rl.resetAt) {
          rl.count = 0;
          rl.resetAt = Date.now() + 60000;
        }
        rl.count++;
        if (rl.count > WS_RATE_LIMIT) {
          socket.send(JSON.stringify({ type: 'error', payload: { message: 'Rate limited' } }));
          return;
        }
      }

      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'subscribe_group' && typeof msg.group_id === 'string') {
          const membership = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(msg.group_id, userId);
          if (membership) { ensureGroupSubscription(msg.group_id); ensureConsumer(msg.group_id, userId).catch(() => {}); }
        }
        if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
      } catch { /* ignore malformed */ }
    });

    socket.on('close', () => {
      wsConnections.get(userId)?.delete(socket as any);
      wsRateLimits.delete(socketId);
      if (wsConnections.get(userId)?.size === 0) {
        wsConnections.delete(userId);
        const sub = userSubscriptions.get(userId);
        if (sub) { try { sub.unsubscribe(); } catch {} userSubscriptions.delete(userId); }
      }
    });

    socket.on('error', () => {
      wsConnections.get(userId)?.delete(socket as any);
      wsRateLimits.delete(socketId);
    });
  }

  // ─── Purge ───
  app.post('/messages/purge', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });
    return reply.send({ status: 'ok' });
  });
}

// ─── Helpers ───

async function flushPendingToUser(userId: string, groupIds: string[]) {
  try {
    const messages = await getAllPendingMessages(userId, groupIds);
    for (const msg of messages) {
      deliverToUser(userId, { type: 'message', payload: msg, group_id: msg.group_id, timestamp: msg.timestamp });
    }
  } catch { /* NATS down */ }
}

function ensureGroupSubscription(groupId: string) {
  if (groupSubscriptions.has(groupId)) return;
  const sub = subscribeToGroup(groupId, async (msg) => {
    await deliverToGroupMembers(groupId, msg, msg.sender_id);
  });
  groupSubscriptions.set(groupId, sub);
}

export function cleanupSubscriptions() {
  for (const [, sub] of groupSubscriptions) { try { sub.unsubscribe(); } catch {} }
  groupSubscriptions.clear();
  for (const [, sub] of userSubscriptions) { try { sub.unsubscribe(); } catch {} }
  userSubscriptions.clear();
  wsConnections.clear();
}
