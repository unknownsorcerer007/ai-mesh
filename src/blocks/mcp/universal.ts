// AI Mesh — Universal MCP Server
// Supports: stdio (local), SSE (remote), Streamable HTTP (remote)
// Works with: OpenClaw, Claude Code, Codex, Gemini, any MCP client.
//
// Messages saved locally on the user's device (~/.ai-mesh/messages/).
// Server stores nothing — NATS handles routing + offline delivery.
//
// Fixes vs original:
//  - All mutations go through shared/business-logic.ts, so the MCP path and the
//    REST path can never drift on sanitization, rate-limiting, injection
//    detection, membership checks, or self-approval guards.
//  - sender_ai is the agent's self-reported name (passed via connect), not a
//    hardcoded 'mcp-agent' string that made every agent indistinguishable.
//  - check_messages uses getPendingCount (a true peek — no ack). The original
//    ack'd+destroyed messages it only meant to count.
//  - watch_messages saves ALL fetched messages before filtering, so messages
//    older than `since` are no longer destroyed.
//  - clear_local_messages now checks membership before deleting.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { getDb, setupSchema } from '../../shared/db.js';
import { getConfig } from '../../core/config.js';
import { verifyToken, checkRateLimit, scheduleBlacklistCleanup } from '../security/index.js';
import { connectRelay, disconnectRelay } from '../relay/index.js';
import { toHuman, translateType } from '../../shared/translate.js';
import { getPendingMessages, getAllPendingMessages, ensureConsumer, getPendingCount } from '../relay/index.js';
import { logMessage } from '../logs/index.js';
import {
  saveMessage, saveMessages, readMessages, getLocalGroups, getStorageStats, clearGroup,
  type StoredMessage,
} from './local-store.js';
import { nanoid } from 'nanoid';
import {
  createNewGroup, requestJoinGroup, respondToJoinRequest, leaveGroup, isGroupMember,
} from '../groups/index.js';
import { sendMessageToGroup } from '../messages/index.js';
import { submitApproval, respondToApproval } from '../approval/index.js';
import type { RelayMessage } from '../../shared/types.js';

// ─── Per-server auth context ───
// Each createMcpServer() call gets its own closure — safe for concurrent HTTP
// connections (each /mcp request creates a new McpServer). The agent name is
// set on connect so messages carry the real identity, not a hardcoded string.
function createAuthContext() {
  let currentUserId: string | null = null;
  let currentAgentName: string | null = null;
  return {
    get userId() { return currentUserId; },
    get agentName() { return currentAgentName; },
    set(userId: string, agentName?: string) {
      currentUserId = userId;
      currentAgentName = agentName || null;
    },
    require(): string {
      if (!currentUserId) throw new Error('Not authenticated. Call connect first.');
      return currentUserId;
    },
  };
}

// ─── Helper: Convert RelayMessage to StoredMessage ───
function toStored(msg: RelayMessage): StoredMessage {
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
  const server = new McpServer({ name: 'ai-mesh', version: '1.0.0' });
  const auth = createAuthContext();

  // ─── connect ───
  server.tool('connect', 'Authenticate with AI Mesh', {
    token: z.string().describe('Your auth token'),
    agent_name: z.string().max(64).optional().describe('Name of the AI agent (e.g. "claude-code", "codex"). Used as sender_ai on messages so other agents know who sent them.'),
  }, async ({ token, agent_name }) => {
    const config = getConfig();
    const userId = verifyToken(token, config.session.secret, config.session.tokenTtlMs);
    if (!userId) return { content: [{ type: 'text', text: '❌ Invalid token' }], isError: true };
    auth.set(userId, agent_name);
    const user = getDb().prepare('SELECT username, hash_id FROM users WHERE id = ?').get(userId) as { username: string; hash_id: string } | undefined;
    if (!user) return { content: [{ type: 'text', text: '❌ User not found' }], isError: true };
    const stats = getStorageStats();
    return { content: [{ type: 'text', text: `✅ Connected as @${user.username}${agent_name ? ` (agent: ${agent_name})` : ''}\n📁 Local storage: ${stats.total_messages} messages across ${stats.groups} groups (${stats.disk_path})` }] };
  });

  // ─── send_message ───
  server.tool('send_message', 'Send a message to a group. Routed via NATS, saved locally.', {
    group_id: z.string().describe('Group ID'),
    message: z.string().describe('Message content'),
    type: z.enum(['text', 'code', 'alert', 'system']).optional().default('text'),
    metadata: z.record(z.unknown()).optional().describe('Extra metadata'),
  }, async ({ group_id, message, type, metadata }) => {
    const userId = auth.require();
    const result = sendMessageToGroup(userId, {
      group_id, message, type, metadata,
      sender_ai: auth.agentName || undefined,
    });
    if (!result.ok) return { content: [{ type: 'text', text: `❌ ${result.code}: ${result.message}` }], isError: true };

    // Save to LOCAL file (on this device) for history
    const sender = getDb().prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string };
    try {
      await saveMessage({
        id: result.data.id, group_id, sender_id: userId, sender_username: sender.username,
        sender_ai: auth.agentName || undefined, type, content: message,
        metadata: metadata as Record<string, unknown> | undefined, timestamp: result.data.timestamp,
        stored_at: new Date().toISOString(),
      });
    } catch { /* local save failure is non-critical */ }

    return { content: [{ type: 'text', text: `✅ Sent (id: ${result.data.id}) — saved locally, delivered via relay` }] };
  });

  // ─── receive_messages (consume: fetch + save + ack) ───
  server.tool('receive_messages', 'Receive pending messages. Fetched from NATS relay, saved locally.', {
    group_id: z.string().optional().describe('Filter by group'),
    limit: z.number().max(200).optional().default(50),
  }, async ({ group_id, limit }) => {
    const userId = auth.require();
    const groups = getDb().prepare('SELECT group_id FROM group_members WHERE user_id = ?')
      .all(userId) as { group_id: string }[];
    if (groups.length === 0) return { content: [{ type: 'text', text: 'No groups joined yet.' }] };

    const groupIds = group_id ? [group_id] : groups.map(g => g.group_id);

    let messages: RelayMessage[];
    try {
      if (group_id) {
        if (!isGroupMember(userId, group_id)) return { content: [{ type: 'text', text: '❌ Not a member' }], isError: true };
        await ensureConsumer(group_id, userId);
        messages = await getPendingMessages(userId, group_id);
      } else {
        for (const gid of groupIds) await ensureConsumer(gid, userId).catch(() => {});
        messages = await getAllPendingMessages(userId, groupIds);
      }
    } catch {
      return { content: [{ type: 'text', text: '⚠️ Relay unavailable — cannot fetch messages' }] };
    }

    if (messages.length > 0) {
      try { await saveMessages(messages.map(toStored)); } catch { /* non-critical */ }
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
    const userId = auth.require();
    if (!isGroupMember(userId, group_id)) return { content: [{ type: 'text', text: '❌ Not a member' }], isError: true };
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
    auth.require();
    const stats = getStorageStats();
    const groups = getLocalGroups();
    return {
      content: [{
        type: 'text',
        text: `📁 Local Storage Stats:\nPath: ${stats.disk_path}\nTotal messages: ${stats.total_messages}\nGroups: ${stats.groups}\n\nGroup details:\n${groups.map(g => `  - ${g.group_id}: ${g.message_count} msgs (last: ${g.last_message_at})`).join('\n') || '  (none)'}`,
      }],
    };
  });

  // ─── clear_local_messages (membership-checked) ───
  server.tool('clear_local_messages', 'Delete local messages for a group (you must be a member).', {
    group_id: z.string(),
  }, async ({ group_id }) => {
    const userId = auth.require();
    if (!isGroupMember(userId, group_id)) return { content: [{ type: 'text', text: '❌ Not a member' }], isError: true };
    const cleared = await clearGroup(group_id);
    return { content: [{ type: 'text', text: cleared ? `✅ Local messages cleared for group ${group_id}` : 'No local messages found.' }] };
  });

  // ─── create_group ───
  server.tool('create_group', 'Create a new group', {
    name: z.string().min(1).max(100),
    description: z.string().max(2000).optional(),
    group_type: z.enum(['team', 'project', 'open']).optional().default('team'),
  }, async ({ name, description, group_type }) => {
    const userId = auth.require();
    const result = createNewGroup(userId, { name, description, group_type });
    if (!result.ok) return { content: [{ type: 'text', text: `❌ ${result.code}: ${result.message}` }], isError: true };
    return { content: [{ type: 'text', text: `✅ Group "${name}" created!\nID: ${result.data.id}\nInvite code: ${result.data.invite_code}` }] };
  });

  // ─── join_group ───
  server.tool('join_group', 'Request to join a group via invite code', {
    invite_code: z.string(),
  }, async ({ invite_code }) => {
    const userId = auth.require();
    const result = requestJoinGroup(userId, invite_code);
    if (!result.ok) return { content: [{ type: 'text', text: `❌ ${result.code}: ${result.message}` }], isError: true };
    return { content: [{ type: 'text', text: `📨 Join request sent. Waiting for admin approval.` }] };
  });

  // ─── approve_join (admin only) ───
  server.tool('approve_join', 'Approve or reject join request (admin only)', {
    request_id: z.string(),
    approve: z.boolean(),
  }, async ({ request_id, approve }) => {
    const userId = auth.require();
    const result = respondToJoinRequest(userId, request_id, approve);
    if (!result.ok) return { content: [{ type: 'text', text: `❌ ${result.code}: ${result.message}` }], isError: true };
    return { content: [{ type: 'text', text: approve ? '✅ Approved' : '❌ Rejected' }] };
  });

  // ─── list_groups ───
  server.tool('list_groups', 'List your groups', {}, async () => {
    const userId = auth.require();
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
    const userId = auth.require();
    if (!isGroupMember(userId, group_id)) return { content: [{ type: 'text', text: '❌ Not a member' }], isError: true };

    const localMessages = readMessages(group_id, limit);
    let relayMessages: RelayMessage[] = [];
    try {
      await ensureConsumer(group_id, userId);
      relayMessages = await getPendingMessages(userId, group_id);
      if (relayMessages.length > 0) {
        try { await saveMessages(relayMessages.map(toStored)); } catch { /* non-critical */ }
      }
    } catch { /* relay may be down */ }

    const seen = new Set(localMessages.map(m => m.id));
    const newFromRelay = relayMessages.filter(m => !seen.has(m.id));
    const allMessages = [...localMessages, ...newFromRelay.map(toStored)];
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
    auth.require();
    const translated = toHuman(message, auth.agentName || undefined);
    const typeLabel = translateType(
      (() => { try { return JSON.parse(message).type; } catch { return 'text'; } })(),
      target_lang
    );
    return { content: [{ type: 'text', text: `${translated}\n\n[${target_lang}] Type: ${typeLabel}` }] };
  });

  // ─── get_pending_requests ───
  server.tool('get_pending_requests', 'Get pending join requests (admin)', {}, async () => {
    const userId = auth.require();
    const requests = getDb().prepare(`
      SELECT jr.*, g.name as group_name, u.username, u.hash_id
      FROM join_requests jr JOIN groups g ON g.id = jr.group_id JOIN users u ON u.id = jr.user_id
      WHERE g.admin_id = ? AND jr.status = 'pending'
      ORDER BY jr.created_at ASC
    `).all(userId);
    return { content: [{ type: 'text', text: requests.length ? JSON.stringify(requests, null, 2) : 'No pending requests.' }] };
  });

  // ─── leave_group (cleans up NATS consumer) ───
  server.tool('leave_group', 'Leave a group', {
    group_id: z.string(),
  }, async ({ group_id }) => {
    const userId = auth.require();
    const result = await leaveGroup(userId, group_id);
    if (!result.ok) return { content: [{ type: 'text', text: `❌ ${result.code}: ${result.message}` }], isError: true };
    return { content: [{ type: 'text', text: '✅ Left group' }] };
  });

  // ─── submit_approval ───
  server.tool('submit_approval', 'Submit an action for human approval', {
    group_id: z.string(),
    action: z.string().max(200),
    details: z.string().max(4000).optional(),
  }, async ({ group_id, action, details }) => {
    const userId = auth.require();
    const result = submitApproval(userId, { group_id, action, details });
    if (!result.ok) return { content: [{ type: 'text', text: `❌ ${result.code}: ${result.message}` }], isError: true };
    return { content: [{ type: 'text', text: `⏳ Submitted (id: ${result.data.id}). Waiting for admin approval.` }] };
  });

  // ─── respond_approval (admin only, no self-approval) ───
  server.tool('respond_approval', 'Approve or reject a pending approval (admin only, cannot self-approve)', {
    approval_id: z.string(),
    approve: z.boolean(),
    reason: z.string().max(2000).optional(),
  }, async ({ approval_id, approve, reason }) => {
    const userId = auth.require();
    const result = respondToApproval(userId, approval_id, approve, reason);
    if (!result.ok) return { content: [{ type: 'text', text: `❌ ${result.code}: ${result.message}` }], isError: true };
    return { content: [{ type: 'text', text: approve ? '✅ Approved' : '❌ Rejected' }] };
  });

  // ─── check_messages (PEEK — no ack, no data loss) ───
  // Uses getPendingCount so it doesn't consume messages. The original ack'd
  // everything it fetched, so calling check_messages wiped the inbox.
  server.tool('check_messages', '🔔 CHECK FOR NEW MESSAGES (peek — does not consume). Call this regularly to see if anything new arrived.', {}, async () => {
    const userId = auth.require();
    const groups = getDb().prepare('SELECT group_id FROM group_members WHERE user_id = ?')
      .all(userId) as { group_id: string }[];
    if (groups.length === 0) return { content: [{ type: 'text', text: '📭 No groups joined.' }] };

    let totalNew = 0;
    const summaries: string[] = [];

    for (const { group_id } of groups) {
      try {
        const count = await getPendingCount(userId, group_id);
        if (count > 0) {
          totalNew += count;
          const groupInfo = getDb().prepare('SELECT name FROM groups WHERE id = ?').get(group_id) as { name: string } | undefined;
          summaries.push(`  📬 ${groupInfo?.name || group_id}: ${count} new`);
        }
      } catch { /* skip */ }
    }

    if (totalNew === 0) return { content: [{ type: 'text', text: '📭 No new messages.' }] };
    return {
      content: [{
        type: 'text',
        text: `🔔 ${totalNew} NEW MESSAGES:\n${summaries.join('\n')}\n\nUse 'receive_messages' to read them.`,
      }],
    };
  });

  // ─── watch_messages (consume ALL, save ALL, then filter for response) ───
  // The original fetched+ack'd everything, then filtered by `since` and only
  // saved the filtered set — messages older than `since` were destroyed. Now
  // we save everything we fetch, and filter only the response.
  server.tool('watch_messages', '👁️ WATCH: Get new messages since a timestamp. Use this to track conversations.', {
    since: z.string().describe('ISO timestamp — get messages after this time'),
    group_id: z.string().optional().describe('Filter by group'),
  }, async ({ since, group_id }) => {
    const userId = auth.require();
    const groups = getDb().prepare('SELECT group_id FROM group_members WHERE user_id = ?')
      .all(userId) as { group_id: string }[];

    const targetGroups = group_id ? [group_id] : groups.map(g => g.group_id);
    const fetchedFromRelay: RelayMessage[] = [];

    for (const gid of targetGroups) {
      try {
        await ensureConsumer(gid, userId);
        const messages = await getPendingMessages(userId, gid);
        if (messages.length > 0) fetchedFromRelay.push(...messages);
      } catch { /* skip */ }
    }

    // Save ALL fetched messages (not just the filtered set) so nothing is lost.
    if (fetchedFromRelay.length > 0) {
      try { await saveMessages(fetchedFromRelay.map(toStored)); } catch { /* non-critical */ }
    }

    // Also check local storage
    const localNew = targetGroups.flatMap(gid => {
      try {
        const msgs = readMessages(gid, 100);
        return msgs.filter(m => m.timestamp > since);
      } catch { return []; }
    });

    // Merge and dedupe
    const seen = new Set(localNew.map(m => m.id));
    const relayNew = fetchedFromRelay.filter(m => m.timestamp > since && !seen.has(m.id));
    const allNew = [...localNew, ...relayNew.map(toStored)];
    allNew.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    if (allNew.length === 0) return { content: [{ type: 'text', text: '👁️ No new messages since ' + since }] };
    return {
      content: [{
        type: 'text',
        text: `👁️ ${allNew.length} new messages since ${since}:\n\n${JSON.stringify(allNew, null, 2)}`,
      }],
    };
  });

  return server;
}

// ─── Start: stdio mode ───
// The standalone MCP binary (ai-mesh-mcp / dist/blocks/mcp/entry.js) is the
// thing the README tells Claude Code / OpenClaw / Codex to run. Unlike the HTTP
// server (src/index.ts), this entry point used to skip connectRelay() entirely
// — so every relay-dependent tool (send_message, receive_messages,
// check_messages, watch_messages, get_group_history) failed with
// "Relay unavailable" and the core AI-to-AI chat feature was dead on arrival.
// We now bring up the DB schema + NATS relay here, matching the HTTP server.
export async function startStdio() {
  // 1. DB schema (cheap if already set up; idempotent)
  try { setupSchema(); } catch (e) { process.stderr.write(`[mcp] DB setup failed: ${e}\n`); }

  // 2. Token blacklist cleanup (idempotent; unref'd timer)
  scheduleBlacklistCleanup();

  // 3. NATS relay — REQUIRED for every relay-dependent tool. Best-effort: if
  //    NATS is down the MCP server still starts (tools that don't need the
  //    relay — connect, read_local_messages, local_storage_stats — still work),
  //    but relay tools will return "Relay unavailable" cleanly instead of
  //    crashing on the first getRelay() call.
  try {
    await connectRelay();
    process.stderr.write('[mcp] NATS relay connected\n');
  } catch (e) {
    process.stderr.write(`[mcp] NATS relay unavailable — relay tools will fail: ${e}\n`);
  }

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[mcp] AI Mesh MCP (stdio) running\n');

  // Graceful shutdown — close NATS on exit.
  process.on('SIGTERM', async () => { try { await disconnectRelay(); } catch {} process.exit(0); });
  process.on('SIGINT', async () => { try { await disconnectRelay(); } catch {} process.exit(0); });
}

// ─── Start: HTTP/SSE mode (per-connection server instances for isolation) ───
export async function startHttp(port: number = 3738) {
  // Same wiring as startStdio — DB + relay must be up before serving requests.
  try { setupSchema(); } catch (e) { process.stderr.write(`[mcp] DB setup failed: ${e}\n`); }
  scheduleBlacklistCleanup();
  try {
    await connectRelay();
    process.stderr.write('[mcp] NATS relay connected\n');
  } catch (e) {
    process.stderr.write(`[mcp] NATS relay unavailable — relay tools will fail: ${e}\n`);
  }
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '', `http://localhost:${port}`);

    // CORS: in production set CORS_ORIGIN to the real frontend. '*' is only the
    // dev default.
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
      // Per-connection server — isolates auth context between concurrent clients.
      const mcpServer = createMcpServer();
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
