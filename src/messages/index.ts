// Pulse — Messages (Relay-powered)
// Messages route through NATS relay, not database
// DB only stores metadata, not message content

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import db from '../db/index.js';
import { authenticate } from '../auth/github.js';
import { detectInjection, sanitizeMessage, checkRateLimit } from '../security/index.js';
import { logMessage, logFullMessage } from '../logs/index.js';
import {
  publishToGroup,
  publishToUser,
  subscribeToGroup,
  subscribeToUser,
  createDurableConsumer,
  getPendingMessages,
  type RelayMessage,
  type RelayEvent,
} from '../relay/index.js';
import type { Subscription } from 'nats';

// ─── Active WebSocket connections ───
const wsConnections = new Map<string, Set<any>>(); // userId -> Set<ws>
const groupSubscriptions = new Map<string, Subscription>(); // groupId -> subscription
const userSubscriptions = new Map<string, Subscription>(); // userId -> subscription

export function registerMessageRoutes(app: FastifyInstance) {

  // ─── Send Message (via relay) ───
  app.post('/messages', async (req: FastifyRequest<{ Body: {
    group_id: string;
    message: string;
    type?: string;
    metadata?: Record<string, unknown>;
    sender_ai?: string;
  } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { group_id, message, type, metadata, sender_ai } = req.body;
    if (!group_id || !message) return reply.code(400).send({ error: 'group_id and message required' });

    // Rate limit
    const rate = checkRateLimit(`msg:${userId}`, 60_000, 120); // 120 msgs/min
    if (!rate.allowed) return reply.code(429).send({ error: 'Rate limit exceeded' });

    // Verify membership
    const member = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(group_id, userId) as any;
    if (!member) return reply.code(403).send({ error: 'Not a member of this group' });

    // Injection check
    const injection = detectInjection(message);
    if (!injection.safe) return reply.code(400).send({ error: injection.reason });

    const clean = sanitizeMessage(message);
    const sender = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as any;
    const groupInfo = db.prepare('SELECT name FROM groups WHERE id = ?').get(group_id) as any;

    // Create relay message
    const relayMsg: RelayMessage = {
      id: nanoid(),
      group_id,
      sender_id: userId,
      sender_username: sender.username,
      sender_ai: sender_ai || undefined,
      type: (type as any) || 'text',
      content: clean,
      metadata: metadata || undefined,
      timestamp: new Date().toISOString(),
    };

    // Publish to NATS relay (millions/sec capable)
    await publishToGroup(group_id, relayMsg);

    // Log to monthly file (fire and forget)
    logMessage({
      group_id,
      group_name: groupInfo?.name || group_id,
      sender: sender.username,
      sender_ai: sender_ai || undefined,
      type: type || 'text',
      content: clean,
      timestamp: relayMsg.timestamp,
    });
    logFullMessage({
      group_id,
      group_name: groupInfo?.name || group_id,
      sender_id: userId,
      sender_username: sender.username,
      sender_ai: sender_ai || undefined,
      type: type || 'text',
      content: clean,
      metadata: metadata || undefined,
      timestamp: relayMsg.timestamp,
    });

    return reply.send({ id: relayMsg.id, status: 'routed' });
  });

  // ─── Receive Messages (pull from relay) ───
  app.get('/messages/inbox', async (req: FastifyRequest<{ Querystring: { group_id?: string; limit?: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const groupId = req.query.group_id;

    if (groupId) {
      // Get pending from specific group
      const messages = await getPendingMessages(userId, groupId);
      return reply.send({ messages, count: messages.length });
    }

    // Get all groups the user is in
    const groups = db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(userId) as any[];
    const allMessages: RelayMessage[] = [];

    for (const g of groups) {
      const msgs = await getPendingMessages(userId, g.group_id);
      allMessages.push(...msgs);
    }

    // Sort by timestamp
    allMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return reply.send({ messages: allMessages, count: allMessages.length });
  });

  // ─── Get Group History (from relay stream) ───
  app.get('/messages/:groupId', async (req: FastifyRequest<{
    Params: { groupId: string };
    Querystring: { limit?: string };
  }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const member = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?')
      .get(req.params.groupId, userId);
    if (!member) return reply.code(403).send({ error: 'Not a member' });

    // For now, return from NATS JetStream
    // In production, you'd use JetStream's ordered consumer
    return reply.send({ messages: [], note: 'Use WebSocket for real-time history' });
  });

  // ─── WebSocket: Real-time connection ───
  app.get('/ws', { websocket: true }, (socket, req) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    if (!token) { socket.close(4001, 'Missing token'); return; }

    const userId = authenticate({ headers: { authorization: `Bearer ${token}` } } as any);
    if (!userId) { socket.close(4003, 'Invalid token'); return; }

    // Register WebSocket
    if (!wsConnections.has(userId)) wsConnections.set(userId, new Set());
    wsConnections.get(userId)!.add(socket);

    // Subscribe to user events
    if (!userSubscriptions.has(userId)) {
      const sub = subscribeToUser(userId, (event) => {
        sendToUser(userId, { type: event.type, payload: event.payload, timestamp: event.timestamp });
      });
      userSubscriptions.set(userId, sub);
    }

    // Subscribe to all user's groups
    const groups = db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(userId) as any[];
    for (const g of groups) {
      ensureGroupSubscription(g.group_id);
    }

    // Handle incoming messages
    socket.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'subscribe_group') {
          ensureGroupSubscription(msg.group_id);
        }
        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
        }
      } catch {}
    });

    socket.on('close', () => {
      wsConnections.get(userId)?.delete(socket);
      if (wsConnections.get(userId)?.size === 0) {
        wsConnections.delete(userId);
        // Cleanup subscription
        userSubscriptions.get(userId)?.unsubscribe();
        userSubscriptions.delete(userId);
      }
    });

    // Welcome message
    socket.send(JSON.stringify({
      type: 'connected',
      payload: { message: 'Connected to Pulse relay' },
      timestamp: new Date().toISOString(),
    }));
  });

  // ─── Purge (cleanup old relay data) ───
  app.post('/messages/purge', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    // NATS handles its own retention, this is for manual cleanup
    return reply.send({ status: 'ok', note: 'NATS relay manages its own retention' });
  });
}

// ─── Helper: Ensure group has NATS subscription ───

function ensureGroupSubscription(groupId: string) {
  if (groupSubscriptions.has(groupId)) return;

  const sub = subscribeToGroup(groupId, (msg) => {
    // Get all members of this group
    const members = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(groupId) as any[];
    for (const m of members) {
      // Don't send back to sender
      if (m.user_id !== msg.sender_id) {
        sendToUser(m.user_id, {
          type: 'message',
          payload: msg,
          group_id: groupId,
          timestamp: msg.timestamp,
        });
      }
    }
  });

  groupSubscriptions.set(groupId, sub);
}

// ─── Helper: Send to user's WebSocket(s) ───

function sendToUser(userId: string, data: unknown) {
  const sockets = wsConnections.get(userId);
  if (!sockets) return;
  const json = JSON.stringify(data);
  for (const ws of sockets) {
    if (ws.readyState === 1) ws.send(json);
  }
}
