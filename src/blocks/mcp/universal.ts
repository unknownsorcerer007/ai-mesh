// Pulse — Universal MCP Server
// Supports: stdio (local), SSE (remote), Streamable HTTP (remote)
// Works with: OpenClaw, Claude Code, Codex, Gemini, any MCP client
//
// Messages saved locally on user's device (~/.ai-mesh/messages/)
// Server stores nothing — NATS handles routing + offline delivery

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { getDb } from '../../shared/db.js';
import { detectInjection, sanitizeMessage, checkRateLimit, generateInviteCode, verifyToken } from '../security/index.js';
import { toHuman, translateType } from '../../shared/translate.js';
import { publishToGroup, getPendingMessages, getAllPendingMessages, ensureConsumer } from '../relay/index.js';
import { logMessage } from '../logs/index.js';
import { saveMessage, saveMessages, readMessages, getLocalGroups, getStorageStats, clearGroup, type StoredMessage } from './local-store.js';
import { nanoid } from 'nanoid';
import type { Group } from '../../shared/types.js';

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

// ─── Auth context ───
let currentUserId: string | null = null;

export function setCurrentUser(userId: string) {
  currentUserId = userId;
}

function requireUser(): string {
  if (!currentUserId) throw new Error('Not authenticated. Call connect first.');
  return currentUserId;
}

function isGroupMember(userId: string, groupId: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId);
}

// ─── Helper: Convert RelayMessage to StoredMessage ───
function toStored(msg: {
  id: string; group_id: string; sender_id: string; sender_username: string;
  sender_ai?: string; type: string; content: string; metadata?: Record<string, unknown>;
  timestamp: string;
}): StoredMessage {
  return {
    id: msg.id,
    group_id: msg.group_id,
    sender_id: msg.sender_id,
    sender_username: msg.sender_username,
    sender_ai: msg.sender_ai,
    type: msg.type,
    content: msg.content,
    metadata: msg.metadata,
    timestamp: msg.timestamp,
    stored_at: new Date().toISOString(),
  };
}

// ─── Create MCP Server ───

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'ai-mesh',
    version: '1.0.0',
  });

  // ─── connect ───
  server.tool('connect', 'Authenticate with AI Mesh', {
    token: z.string().describe('Your auth token'),
  }, async ({ token }) => {
    const userId = verifyToken(token, SESSION_SECRET);
    if (!userId) return { content: [{ type: 'text', text: '❌ Invalid token' }], isError: true };
    currentUserId = userId;
    const user = getDb().prepare('SELECT username, hash_id FROM users WHERE id = ?').get(userId) as { username: string; hash_id: string } | undefined;
    if (!user) return { content: [{ type: 'text', text: '❌ User not found' }], isError: true };

    // Initialize local storage for this user
    const stats = getStorageStats();
    return { content: [{ type: 'text', text: `✅ Connected as @${user.username}\n📁 Local storage: ${stats.total_messages} messages across ${stats.groups} groups (${stats.disk_path})` }] };
  });

  // ─── send_message ───
  server.tool('send_message', 'Send a message to a group. No server storage — routed via NATS.', {
    group_id: z.string().describe('Group ID'),
    message: z.string().describe('Message content'),
    type: z.enum(['text', 'code', 'alert', 'system']).optional().default('text'),
    metadata: z.record(z.unknown()).optional().describe('Extra metadata'),
  }, async ({ group_id, message, type, metadata }) => {
    const userId = requireUser();
    if (!isGroupMember(userId, group_id)) return { content: [{ type: 'text', text: '❌ Not a member' }], isError: true };

    const rate = checkRateLimit(`mcp:msg:${userId}`, 60_000, 120);
    if (!rate.allowed) return { content: [{ type: 'text', text: '❌ Rate limit' }], isError: true };

    const injection = detectInjection(message);
    if (!injection.safe) return { content: [{ type: 'text', text: `❌ ${injection.reason}` }], isError: true };

    const clean = sanitizeMessage(message);
    const sender = getDb().prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string };
    const msgId = nanoid();
    const now = new Date().toISOString();

    const relayMsg = {
      id: msgId, group_id, sender_id: userId, sender_username: sender.username,
      type, content: clean, metadata: metadata as Record<string, unknown> | undefined, timestamp: now,
    };

    // Publish via NATS relay — server stores nothing
    try {
      await publishToGroup(group_id, relayMsg);
    } catch {
      return { content: [{ type: 'text', text: '❌ Relay unavailable — message not delivered' }], isError: true };
    }

    // Save to LOCAL file (on this device)
    saveMessage(toStored(relayMsg));

    // Audit log (non-blocking)
    try {
      const groupInfo = getDb().prepare('SELECT name FROM groups WHERE id = ?').get(group_id) as { name: string } | undefined;
      logMessage({ group_id, group_name: groupInfo?.name || group_id, sender: sender.username, type, content: clean, timestamp: now });
    } catch { /* non-critical */ }

    return { content: [{ type: 'text', text: `✅ Sent (id: ${msgId}) — saved locally, delivered via relay` }] };
  });

  // ─── receive_messages ───
  server.tool('receive_messages', 'Receive pending messages. Fetched from NATS relay, saved locally.', {
    group_id: z.string().optional().describe('Filter by group'),
    limit: z.number().max(200).optional().default(50),
  }, async ({ group_id, limit }) => {
    const userId = requireUser();

    // Get user's groups
    const groups = getDb().prepare('SELECT group_id FROM group_members WHERE user_id = ?')
      .all(userId) as { group_id: string }[];
    if (groups.length === 0) {
      return { content: [{ type: 'text', text: 'No groups joined yet.' }] };
    }

    const groupIds = group_id ? [group_id] : groups.map(g => g.group_id);

    // Fetch pending messages from NATS JetStream
    let messages;
    try {
      if (group_id) {
        if (!isGroupMember(userId, group_id)) {
          return { content: [{ type: 'text', text: '❌ Not a member' }], isError: true };
        }
        await ensureConsumer(group_id, userId);
        messages = await getPendingMessages(userId, group_id);
      } else {
        // Ensure consumers for all groups
        for (const gid of groupIds) {
          await ensureConsumer(gid, userId).catch(() => {});
        }
        messages = await getAllPendingMessages(userId, groupIds);
      }
    } catch {
      return { content: [{ type: 'text', text: '⚠️ Relay unavailable — cannot fetch messages' }] };
    }

    // Save to local files
    if (messages.length > 0) {
      saveMessages(messages.map(toStored));
    }

    const limited = messages.slice(0, limit);
    return {
      content: [{
        type: 'text',
        text: limited.length > 0
          ? `📥 ${limited.length} messages received and saved locally:\n\n${JSON.stringify(limited, null, 2)}`
          : 'No pending messages.',
      }],
    };
  });

  // ─── read_local_messages ───
  server.tool('read_local_messages', 'Read old messages from local storage (your device).', {
    group_id: z.string().describe('Group ID'),
    limit: z.number().max(500).optional().default(50),
    before: z.string().optional().describe('ISO timestamp — get messages before this time'),
  }, async ({ group_id, limit, before }) => {
    const userId = requireUser();
    if (!isGroupMember(userId, group_id)) {
      return { content: [{ type: 'text', text: '❌ Not a member' }], isError: true };
    }

    const messages = readMessages(group_id, limit, before);
    return {
      content: [{
        type: 'text',
        text: messages.length > 0
          ? `📁 ${messages.length} messages from local storage:\n\n${JSON.stringify(messages, null, 2)}`
          : 'No local messages for this group. Use receive_messages to fetch from relay first.',
      }],
    };
  });

  // ─── local_storage_stats ───
  server.tool('local_storage_stats', 'View local message storage stats.', {}, async () => {
    requireUser();
    const stats = getStorageStats();
    const groups = getLocalGroups();

    return {
      content: [{
        type: 'text',
        text: `📁 Local Storage Stats:\nPath: ${stats.disk_path}\nTotal messages: ${stats.total_messages}\nGroups: ${stats.groups}\n\nGroup details:\n${groups.map(g => `  - ${g.group_id}: ${g.message_count} msgs (last: ${g.last_message_at})`).join('\n') || '  (none)'}`,
      }],
    };
  });

  // ─── clear_local_messages ───
  server.tool('clear_local_messages', 'Delete local messages for a group.', {
    group_id: z.string(),
  }, async ({ group_id }) => {
    requireUser();
    const cleared = clearGroup(group_id);
    return { content: [{ type: 'text', text: cleared ? `✅ Local messages cleared for group ${group_id}` : 'No local messages found.' }] };
  });

  // ─── create_group ───
  server.tool('create_group', 'Create a new group', {
    name: z.string().min(1).max(100),
    description: z.string().optional(),
    group_type: z.enum(['team', 'project', 'open']).optional().default('team'),
  }, async ({ name, description, group_type }) => {
    const userId = requireUser();
    const rate = checkRateLimit(`mcp:group:${userId}`, 3600_000, 10);
    if (!rate.allowed) return { content: [{ type: 'text', text: '❌ Rate limit: too many groups' }], isError: true };

    const groupId = nanoid();
    const inviteCode = generateInviteCode();

    getDb().prepare('INSERT INTO groups (id, name, description, invite_code, admin_id, group_type) VALUES (?,?,?,?,?,?)')
      .run(groupId, name, description || null, inviteCode, userId, group_type);
    getDb().prepare('INSERT INTO group_members (id, group_id, user_id, role) VALUES (?,?,?,?)')
      .run(nanoid(), groupId, userId, 'admin');

    return { content: [{ type: 'text', text: `✅ Group "${name}" created!\nID: ${groupId}\nInvite code: ${inviteCode}` }] };
  });

  // ─── join_group ───
  server.tool('join_group', 'Request to join a group via invite code', {
    invite_code: z.string(),
  }, async ({ invite_code }) => {
    const userId = requireUser();
    const group = getDb().prepare('SELECT * FROM groups WHERE invite_code = ?').get(invite_code) as Group | undefined;
    if (!group) return { content: [{ type: 'text', text: '❌ Invalid invite code' }], isError: true };

    if (getDb().prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(group.id, userId)) {
      return { content: [{ type: 'text', text: '⚠️ Already a member' }] };
    }

    const pending = getDb().prepare("SELECT 1 FROM join_requests WHERE group_id = ? AND user_id = ? AND status = 'pending'").get(group.id, userId);
    if (pending) return { content: [{ type: 'text', text: '⏳ Join request already pending' }] };

    getDb().prepare('INSERT INTO join_requests (id, group_id, user_id, status) VALUES (?,?,?,?)')
      .run(nanoid(), group.id, userId, 'pending');

    return { content: [{ type: 'text', text: `📨 Join request sent to "${group.name}". Waiting for admin approval.` }] };
  });

  // ─── approve_join ───
  server.tool('approve_join', 'Approve or reject join request (admin only)', {
    request_id: z.string(),
    approve: z.boolean(),
  }, async ({ request_id, approve }) => {
    const userId = requireUser();
    const joinReq = getDb().prepare('SELECT * FROM join_requests WHERE id = ?').get(request_id) as any;
    if (!joinReq || joinReq.status !== 'pending') return { content: [{ type: 'text', text: '❌ Not found' }], isError: true };

    const group = getDb().prepare('SELECT * FROM groups WHERE id = ?').get(joinReq.group_id) as Group;
    if (group.admin_id !== userId) return { content: [{ type: 'text', text: '❌ Admin only' }], isError: true };

    if (approve) {
      getDb().prepare("UPDATE join_requests SET status = 'approved' WHERE id = ?").run(request_id);
      getDb().prepare('INSERT INTO group_members (id, group_id, user_id, role) VALUES (?,?,?,?)').run(nanoid(), joinReq.group_id, joinReq.user_id, 'member');
      return { content: [{ type: 'text', text: '✅ Approved' }] };
    } else {
      getDb().prepare("UPDATE join_requests SET status = 'rejected' WHERE id = ?").run(request_id);
      return { content: [{ type: 'text', text: '❌ Rejected' }] };
    }
  });

  // ─── list_groups ───
  server.tool('list_groups', 'List your groups', {}, async () => {
    const userId = requireUser();
    const groups = getDb().prepare(`
      SELECT g.*, gm.role, (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
      FROM groups g JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
    `).all(userId);
    return { content: [{ type: 'text', text: groups.length ? JSON.stringify(groups, null, 2) : 'No groups yet.' }] };
  });

  // ─── get_group_history ───
  server.tool('get_group_history', 'Get message history (local storage + pending from relay)', {
    group_id: z.string(),
    limit: z.number().max(500).optional().default(50),
  }, async ({ group_id, limit }) => {
    const userId = requireUser();
    if (!isGroupMember(userId, group_id)) return { content: [{ type: 'text', text: '❌ Not a member' }], isError: true };

    // 1. Read from local storage first
    const localMessages = readMessages(group_id, limit);

    // 2. Also try to fetch pending from relay
    let relayMessages: any[] = [];
    try {
      await ensureConsumer(group_id, userId);
      relayMessages = await getPendingMessages(userId, group_id);
      if (relayMessages.length > 0) {
        // Save new relay messages locally
        saveMessages(relayMessages.map(toStored));
      }
    } catch { /* relay may be down */ }

    // Merge: local + new relay messages (dedupe by id)
    const seen = new Set(localMessages.map(m => m.id));
    const newFromRelay = relayMessages.filter(m => !seen.has(m.id));
    const allMessages = [...localMessages, ...newFromRelay.map(toStored)];

    // Sort by timestamp, apply limit
    allMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const limited = allMessages.slice(-limit);

    return {
      content: [{
        type: 'text',
        text: limited.length > 0
          ? `📁 ${limited.length} messages (${localMessages.length} local, ${newFromRelay.length} new from relay):\n\n${JSON.stringify(limited, null, 2)}`
          : 'No messages yet.',
      }],
    };
  });

  // ─── translate_message ───
  server.tool('translate_message', 'Translate AI message to human readable', {
    message: z.string(),
    target_lang: z.enum(['en', 'hi']).optional().default('en'),
  }, async ({ message, target_lang }) => {
    const translated = toHuman(message, 'AI Agent');
    const typeLabel = translateType(
      (() => { try { return JSON.parse(message).type; } catch { return 'text'; } })(),
      target_lang
    );
    return { content: [{ type: 'text', text: `${translated}\n\n[${target_lang}] Type: ${typeLabel}` }] };
  });

  // ─── get_pending_requests ───
  server.tool('get_pending_requests', 'Get pending join requests (admin)', {}, async () => {
    const userId = requireUser();
    const requests = getDb().prepare(`
      SELECT jr.*, g.name as group_name, u.username, u.hash_id
      FROM join_requests jr JOIN groups g ON g.id = jr.group_id JOIN users u ON u.id = jr.user_id
      WHERE g.admin_id = ? AND jr.status = 'pending'
      ORDER BY jr.created_at ASC
    `).all(userId);
    return { content: [{ type: 'text', text: requests.length ? JSON.stringify(requests, null, 2) : 'No pending requests.' }] };
  });

  // ─── leave_group ───
  server.tool('leave_group', 'Leave a group', {
    group_id: z.string(),
  }, async ({ group_id }) => {
    const userId = requireUser();
    const group = getDb().prepare('SELECT * FROM groups WHERE id = ?').get(group_id) as Group | undefined;
    if (!group) return { content: [{ type: 'text', text: '❌ Not found' }], isError: true };
    if (group.admin_id === userId) return { content: [{ type: 'text', text: '❌ Admin cannot leave' }], isError: true };
    getDb().prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(group_id, userId);
    return { content: [{ type: 'text', text: '✅ Left group' }] };
  });

  return server;
}

// ─── Start: stdio mode ───
export async function startStdio() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[mcp] AI Mesh MCP (stdio) running\n');
}

// ─── Start: HTTP/SSE mode ───
export async function startHttp(port: number = 3738) {
  const mcpServer = createMcpServer();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '', `http://localhost:${port}`);

    const origin = process.env.CORS_ORIGIN || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', transport: 'sse', version: '1.0.0' }));
      return;
    }

    if (url.pathname === '/mcp') {
      try {
        if (req.method === 'GET') {
          const transport = new SSEServerTransport('/mcp', res);
          await mcpServer.connect(transport);
          return;
        }
        if (req.method === 'POST') {
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          await mcpServer.connect(transport);
          await transport.handleRequest(req, res);
          return;
        }
      } catch (err) {
        process.stderr.write(`[mcp] Error: ${err}\n`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
        return;
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: 'AI Mesh MCP Server',
      transport: 'sse',
      endpoints: { mcp: '/mcp', health: '/health' },
    }));
  });

  httpServer.listen(port, () => {
    process.stderr.write(`[mcp] AI Mesh MCP (HTTP/SSE) running on :${port}\n`);
  });

  process.on('SIGTERM', () => httpServer.close());
  process.on('SIGINT', () => httpServer.close());
}
