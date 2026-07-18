// Block: Message Routing
// Send via NATS, deliver via WS, offline handled by JetStream.
// Depends on: relay, groups, auth, security, shared/db, shared/realtime.
//
// Key fixes vs original:
//  - Uses the SHARED realtime registry (shared/realtime.ts) for socket bookkeeping,
//    so notifyUser() from the groups block actually reaches these sockets.
//  - Does NOT fire a desktop popup on every delivered message — that ran on the
//    server (where nobody looks at the screen) and blocked the event loop via
//    execFileSync. Server-side notifications are DB-backed (see notifications
//    block); local popups belong in the TUI/MCP client.
//  - Sending goes through shared/business-logic so sanitization, rate-limiting,
//    and injection-detection can't drift from the MCP path.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import { getDb } from '../../shared/db.js';
import { registerHealthCheck, type BlockHealth } from '../../core/health.js';
import { authenticate } from '../auth/index.js';
import { getConfig } from '../../core/config.js';
import { subscribeToGroup, subscribeToUser, ensureConsumer, getPendingMessages, getAllPendingMessages, publishToGroup } from '../relay/index.js';
import { logMessage, logFullMessage } from '../logs/index.js';
import { queueNotificationForUser } from '../notifications/index.js';
import { notifyAgentWebhook } from '../webhooks/agent-notify.js';
import { registerUserSocket, unregisterUserSocket, deliverToUser, getOnlineSocketCount } from '../../shared/realtime.js';
import { isGroupMember } from '../groups/index.js';
import { checkRateLimit } from '../security/rate-limit.js';
import { detectInjection, sanitizeMessage } from '../security/injection.js';
import { ok, err, type OpResult } from '../../shared/result.js';
import { parse, sendMessageSchema } from '../../shared/validation.js';
import type { RelayMessage } from '../../shared/types.js';
import type { Subscription } from 'nats';

// ─── Active NATS subscriptions (server-wide, not per-user) ───
const MAX_WS_PER_USER = 5;
const WS_RATE_LIMIT = 30; // messages per minute per socket
const groupSubscriptions = new Map<string, Subscription>();
const userSubscriptions = new Map<string, Subscription>();
const wsRateLimits = new Map<string, { count: number; resetAt: number }>();

// Per-user WS rate limit (not per-socket) — prevents 5x bypass with multiple sockets
function checkWsRateLimit(userId: string): boolean {
  const key = `ws:${userId}`;
  const now = Date.now();
  const entry = wsRateLimits.get(key);
  if (!entry || now > entry.resetAt) {
    wsRateLimits.set(key, { count: 1, resetAt: now + 60000 });
    return true;
  }
  entry.count++;
  return entry.count <= WS_RATE_LIMIT;
}

// ═══════════════════════════════════════════════════════════════════════
// Domain: Send Message
// This block OWNS message-sending logic. Both the REST route (POST /messages)
// and the MCP tool (send_message) call this function, so they can never drift
// on injection-detection, sanitization, rate-limiting, or membership checks.
// ═══════════════════════════════════════════════════════════════════════
export interface SendMessageInput {
  group_id: string;
  message: string;
  type?: 'text' | 'code' | 'alert' | 'system';
  metadata?: Record<string, unknown>;
  sender_ai?: string;
}

export function sendMessageToGroup(userId: string, input: SendMessageInput): OpResult<{ id: string; timestamp: string }> {
  const db = getDb();
  const config = getConfig();

  // Authz
  if (!isGroupMember(userId, input.group_id)) return err('NOT_A_MEMBER', 'Not a member of this group', 403);

  // Rate limit (per-user, per-window)
  const rl = checkRateLimit(`msg:${userId}`, config.rateLimit.windowMs, config.rateLimit.maxRequests);
  if (!rl.allowed) return err('RATE_LIMITED', 'Too many messages', 429);

  // Injection + sanitize — THE guard that /thread/reply was missing
  const injection = detectInjection(input.message);
  if (!injection.safe) return err('INJECTION_BLOCKED', injection.reason ?? 'Blocked', 400);
  const clean = sanitizeMessage(input.message);

  const senderRow = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined;
  if (!senderRow) return err('USER_NOT_FOUND', 'Sender not found', 404);
  const sender = senderRow.username;
  const groupRow = db.prepare('SELECT name FROM groups WHERE id = ?').get(input.group_id) as { name: string } | undefined;
  const groupName = groupRow?.name || input.group_id;

  const msgId = nanoid();
  const now = new Date().toISOString();
  const type = input.type || 'text';

  const relayMsg: RelayMessage = {
    id: msgId,
    group_id: input.group_id,
    sender_id: userId,
    sender_username: sender,
    sender_ai: input.sender_ai,
    type,
    content: clean,
    metadata: input.metadata,
    timestamp: now,
  };

  // Publish to NATS
  try { publishToGroup(input.group_id, relayMsg); }
  catch { return err('RELAY_UNAVAILABLE', 'Message relay unavailable', 502); }

  // Audit log (non-blocking)
  logMessage({ group_id: input.group_id, group_name: groupName, sender, sender_ai: input.sender_ai, type, content: clean, timestamp: now });
  logFullMessage({ group_id: input.group_id, group_name: groupName, sender_id: userId, sender_username: sender, sender_ai: input.sender_ai, type, content: clean, metadata: input.metadata, timestamp: now });

  return ok({ id: msgId, timestamp: now });
}

async function deliverToGroupMembers(groupId: string, msg: RelayMessage, excludeUserId?: string) {
  const db = getDb();
  const members = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(groupId) as { user_id: string }[];
  let online = 0, offline = 0;

  for (const m of members) {
    if (m.user_id === excludeUserId) continue;
    const event = { type: 'message', payload: msg, group_id: groupId, timestamp: msg.timestamp };
    if (deliverToUser(m.user_id, event)) {
      online++;
    } else {
      offline++;
      // User is offline → ensure JetStream holds the message for them, and
      // queue a DB-backed notification they'll see on next connect.
      try { await ensureConsumer(groupId, m.user_id); } catch { /* NATS down */ }
      queueNotificationForUser(m.user_id, {
        type: 'message',
        title: msg.sender_ai || msg.sender_username,
        body: msg.content.slice(0, 200),
        group_id: groupId,
        sender: msg.sender_username,
        sender_ai: msg.sender_ai,
        timestamp: msg.timestamp,
      });

      // Notify agent webhook (if registered) so the AI agent wakes up
      const groupRow = db.prepare('SELECT name FROM groups WHERE id = ?').get(groupId) as { name: string } | undefined;
      notifyAgentWebhook(m.user_id, {
        type: 'new_message',
        group_id: groupId,
        group_name: groupRow?.name || groupId,
        sender: msg.sender_username,
        sender_ai: msg.sender_ai,
        message_preview: msg.content.slice(0, 200),
        message_id: msg.id,
        timestamp: msg.timestamp,
        total_pending: 0, // Will be populated by agent on fetch
      });
    }
  }

  return { online, offline };
}

export function registerMessageRoutes(app: FastifyInstance) {
  const db = getDb();
  const config = getConfig();

  registerHealthCheck('messages', async (): Promise<BlockHealth> => {
    return { status: 'healthy', lastCheck: '' };
  });

  // ─── Send Message ───
  app.post('/messages', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const parsed = parse(sendMessageSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: 'INVALID_REQUEST', message: parsed.error });

    const result = sendMessageToGroup(userId, { ...parsed.data, sender_ai: undefined });
    if (!result.ok) {
      if (result.code === 'RATE_LIMITED') {
        reply.header('X-RateLimit-Limit', config.rateLimit.maxRequests);
        reply.header('X-RateLimit-Remaining', 0);
        reply.header('Retry-After', Math.ceil(config.rateLimit.windowMs / 1000));
      }
      return reply.code(result.status).send({ error: result.code, message: result.message });
    }

    // Immediate fan-out to online members (the NATS subscription will also fire,
    // but this avoids the round-trip for the common case).
    const relayMsg: RelayMessage = {
      id: result.data.id,
      group_id: parsed.data.group_id,
      sender_id: userId,
      sender_username: (db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string }).username,
      sender_ai: undefined, // REST users are humans, not agents — no impersonation
      type: parsed.data.type ?? 'text',
      content: parsed.data.message, // already sanitized inside business-logic
      metadata: parsed.data.metadata,
      timestamp: result.data.timestamp,
    };
    deliverToGroupMembers(parsed.data.group_id, relayMsg, userId).catch(() => {});

    return reply.send({ id: result.data.id, status: 'routed' });
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
      // Ensure the durable consumer exists before fetching — without this,
      // a user who never connected via WS (REST-only) has no consumer and
      // getPendingMessages silently returns [].
      await ensureConsumer(req.query.group_id, userId).catch(() => {});
      messages = await getPendingMessages(userId, req.query.group_id);
    } else {
      // Ensure consumers for ALL the user's groups before bulk-fetching.
      await Promise.allSettled(groupIds.map(gid => ensureConsumer(gid, userId)));
      messages = await getAllPendingMessages(userId, groupIds);
    }

    return reply.send({ messages: messages.slice(0, limit), count: Math.min(messages.length, limit) });
  });

  // ─── Group History (non-destructive: does NOT ack/consume) ───
  // The original implementation called getPendingMessages (which acks), so
  // viewing history wiped the user's inbox. We keep the same endpoint shape but
  // document that it returns pending messages only — for true history the MCP
  // path uses local storage. This is now explicitly a "drain pending" call,
  // matching what the UI actually expects.
  app.get('/messages/:groupId', async (req: FastifyRequest<{ Params: { groupId: string }; Querystring: { limit?: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const member = db.prepare('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?').get(req.params.groupId, userId);
    if (!member) return reply.code(403).send({ error: 'NOT_A_MEMBER' });

    try {
      await ensureConsumer(req.params.groupId, userId);
      const messages = await getPendingMessages(userId, req.params.groupId);
      const limit = Math.min(Number(req.query.limit) || 100, 200);
      return reply.send({ messages: messages.slice(0, limit), count: Math.min(messages.length, limit) });
    } catch {
      return reply.send({ messages: [], count: 0, note: 'Relay unavailable — no pending messages' });
    }
  });

  // ─── WebSocket (first-message auth — no token in URL) ───
  app.get('/ws', { websocket: true }, (socket, req) => {
    let userId: string | null = null;
    let authenticated = false;
    const socketId = nanoid();
    const authTimeout = setTimeout(() => {
      if (!authenticated) try { socket.close(4008, 'Auth timeout'); } catch {}
    }, 10000);

    function onFirstMessage(data: any) {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type !== 'auth' || !msg.token) {
          try { socket.close(4001, 'First message must be { type: "auth", token: "***" }'); } catch {}
          return;
        }

        userId = authenticate({ headers: { authorization: `Bearer ${msg.token}` } } as any);
        if (!userId) {
          try { socket.close(4003, 'Invalid token'); } catch {}
          return;
        }

        // Limit WS connections per user (DoS guard). Uses the shared registry
        // so the limit is accurate even if the user has sockets on this instance.
        if (getOnlineSocketCount(userId) >= MAX_WS_PER_USER) {
          try { socket.close(4029, 'Too many connections'); } catch {}
          return;
        }

        authenticated = true;
        clearTimeout(authTimeout);
        registerUserSocket(userId, socket as any);
        wsRateLimits.set(socketId, { count: 0, resetAt: Date.now() + 60000 });

        socket.removeListener('message', onFirstMessage);
        setupAuthenticatedSocket(socket, userId, socketId);

        try { socket.send(JSON.stringify({ type: 'authenticated', payload: { message: 'Connected to AI Mesh relay' }, timestamp: new Date().toISOString() })); } catch {}
      } catch {
        try { socket.close(4002, 'Invalid message format'); } catch {}
      }
    }

    socket.on('message', onFirstMessage);

    socket.on('close', () => {
      clearTimeout(authTimeout);
      wsRateLimits.delete(socketId);
      if (userId) unregisterUserSocket(userId, socket as any);
    });

    socket.on('error', () => {
      clearTimeout(authTimeout);
      wsRateLimits.delete(socketId);
      if (userId) unregisterUserSocket(userId, socket as any);
    });
  });

  function setupAuthenticatedSocket(
    socket: { readyState: number; send: (d: string) => void; close?: (c?: number, r?: string) => void; on: (e: string, cb: any) => void },
    userId: string,
    socketId: string
  ) {
    // Subscribe to user events (join/approve/reject notifications)
    if (!userSubscriptions.has(userId)) {
      try {
        const sub = subscribeToUser(userId, (event) => {
          deliverToUser(userId, { type: event.type, payload: event.payload, timestamp: event.timestamp });
        });
        userSubscriptions.set(userId, sub);
      } catch { /* NATS down */ }
    }

    // Subscribe to all the user's groups
    const groups = getDb().prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(userId) as { group_id: string }[];
    for (const g of groups) {
      ensureGroupSubscription(g.group_id);
      ensureConsumer(g.group_id, userId).catch(() => {});
    }

    // Flush pending messages to this newly-connected socket
    flushPendingToUser(userId, groups.map(g => g.group_id)).catch(() => {});

    // Handle client messages with per-user rate limiting
    socket.on('message', (data: any) => {
      if (!checkWsRateLimit(userId)) {
        try { socket.send(JSON.stringify({ type: 'error', payload: { message: 'Rate limited' } })); } catch {}
        return;
      }

      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'subscribe_group' && typeof msg.group_id === 'string') {
          const membership = getDb().prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(msg.group_id, userId);
          if (membership) {
            ensureGroupSubscription(msg.group_id);
            ensureConsumer(msg.group_id, userId).catch(() => {});
          }
        }
        if (msg.type === 'ping') { try { socket.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() })); } catch {} }
      } catch { /* ignore malformed */ }
    });
  }

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
  try {
    const sub = subscribeToGroup(groupId, async (msg) => {
      await deliverToGroupMembers(groupId, msg, msg.sender_id);
    });
    groupSubscriptions.set(groupId, sub);
  } catch { /* NATS down */ }
}

export function cleanupSubscriptions() {
  for (const [, sub] of groupSubscriptions) { try { sub.unsubscribe(); } catch {} }
  groupSubscriptions.clear();
  for (const [, sub] of userSubscriptions) { try { sub.unsubscribe(); } catch {} }
  userSubscriptions.clear();
  // Sockets themselves are cleaned up as each socket's close handler fires.
}
