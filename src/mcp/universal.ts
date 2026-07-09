// Pulse — Universal MCP Server
// Supports: stdio (local), SSE (remote), Streamable HTTP (remote)
// Works with: OpenClaw, Claude Code, Codex, Gemini, any MCP client

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import db from '../db/index.js';
import { detectInjection, sanitizeMessage, checkRateLimit, generateInviteCode } from '../security/index.js';
import { toHuman, translateType } from '../translate/index.js';
import { nanoid } from 'nanoid';
import type { Group } from '../types/index.js';

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
  return !!db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId);
}

// ─── Create MCP Server with all tools ───

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'pulse',
    version: '1.0.0',
  });

  // ─── connect ───
  server.tool('connect', 'Authenticate with Pulse', {
    token: z.string().describe('Your auth token'),
  }, async ({ token }) => {
    const { verifyToken } = await import('../security/index.js');
    const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret';
    const userId = verifyToken(token, SESSION_SECRET);
    if (!userId) return { content: [{ type: 'text', text: '❌ Invalid token' }], isError: true };
    currentUserId = userId;
    const user = db.prepare('SELECT username, hash_id FROM users WHERE id = ?').get(userId) as any;
    return { content: [{ type: 'text', text: `✅ Connected as @${user.username}` }] };
  });

  // ─── send_message ───
  server.tool('send_message', 'Send a message to a group', {
    group_id: z.string(),
    message: z.string(),
    type: z.enum(['text', 'code', 'alert', 'system']).optional().default('text'),
    metadata: z.record(z.unknown()).optional(),
  }, async ({ group_id, message, type, metadata }) => {
    const userId = requireUser();
    if (!isGroupMember(userId, group_id)) return { content: [{ type: 'text', text: '❌ Not a member' }], isError: true };

    const rate = checkRateLimit(`mcp:msg:${userId}`, 60_000, 120);
    if (!rate.allowed) return { content: [{ type: 'text', text: '❌ Rate limit' }], isError: true };

    const injection = detectInjection(message);
    if (!injection.safe) return { content: [{ type: 'text', text: `❌ ${injection.reason}` }], isError: true };

    const clean = sanitizeMessage(message);
    const sender = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as any;
    const msgId = nanoid();

    // Publish via relay
    const { publishToGroup } = await import('../relay/index.js');
    await publishToGroup(group_id, {
      id: msgId, group_id, sender_id: userId, sender_username: sender.username,
      type, content: clean, metadata: metadata as any, timestamp: new Date().toISOString(),
    });

    // Log
    const { logMessage } = await import('../logs/index.js');
    const groupInfo = db.prepare('SELECT name FROM groups WHERE id = ?').get(group_id) as any;
    logMessage({ group_id, group_name: groupInfo?.name || group_id, sender: sender.username, type, content: clean, timestamp: new Date().toISOString() });

    return { content: [{ type: 'text', text: `✅ Sent (id: ${msgId})` }] };
  });

  // ─── receive_messages ───
  server.tool('receive_messages', 'Get pending messages', {
    group_id: z.string().optional(),
    limit: z.number().max(200).optional().default(50),
  }, async ({ group_id, limit }) => {
    const userId = requireUser();
    const { getPendingMessages } = await import('../relay/index.js');

    if (group_id) {
      const msgs = await getPendingMessages(userId, group_id);
      return { content: [{ type: 'text', text: msgs.length ? JSON.stringify(msgs.slice(0, limit), null, 2) : 'No pending messages.' }] };
    }

    const groups = db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(userId) as any[];
    const all: any[] = [];
    for (const g of groups) {
      const msgs = await getPendingMessages(userId, g.group_id);
      all.push(...msgs);
    }
    return { content: [{ type: 'text', text: all.length ? JSON.stringify(all.slice(0, limit), null, 2) : 'No pending messages.' }] };
  });

  // ─── create_group ───
  server.tool('create_group', 'Create a new group', {
    name: z.string().min(1).max(100),
    description: z.string().optional(),
    group_type: z.enum(['team', 'project', 'open']).optional().default('team'),
  }, async ({ name, description, group_type }) => {
    const userId = requireUser();
    const groupId = nanoid();
    const inviteCode = generateInviteCode();

    db.prepare('INSERT INTO groups (id, name, description, invite_code, admin_id, group_type) VALUES (?,?,?,?,?,?)')
      .run(groupId, name, description || null, inviteCode, userId, group_type);
    db.prepare('INSERT INTO group_members (id, group_id, user_id, role) VALUES (?,?,?,?)')
      .run(nanoid(), groupId, userId, 'admin');

    return { content: [{ type: 'text', text: `✅ Group "${name}" created!\nID: ${groupId}\nInvite code: ${inviteCode}` }] };
  });

  // ─── join_group ───
  server.tool('join_group', 'Request to join a group via invite code', {
    invite_code: z.string(),
  }, async ({ invite_code }) => {
    const userId = requireUser();
    const group = db.prepare('SELECT * FROM groups WHERE invite_code = ?').get(invite_code) as Group | undefined;
    if (!group) return { content: [{ type: 'text', text: '❌ Invalid invite code' }], isError: true };

    if (db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(group.id, userId)) {
      return { content: [{ type: 'text', text: '⚠️ Already a member' }] };
    }

    db.prepare('INSERT INTO join_requests (id, group_id, user_id, status) VALUES (?,?,?,?)')
      .run(nanoid(), group.id, userId, 'pending');

    return { content: [{ type: 'text', text: `📨 Join request sent to "${group.name}". Waiting for admin approval.` }] };
  });

  // ─── approve_join ───
  server.tool('approve_join', 'Approve or reject join request (admin only)', {
    request_id: z.string(),
    approve: z.boolean(),
  }, async ({ request_id, approve }) => {
    const userId = requireUser();
    const joinReq = db.prepare('SELECT * FROM join_requests WHERE id = ?').get(request_id) as any;
    if (!joinReq || joinReq.status !== 'pending') return { content: [{ type: 'text', text: '❌ Not found' }], isError: true };

    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(joinReq.group_id) as Group;
    if (group.admin_id !== userId) return { content: [{ type: 'text', text: '❌ Admin only' }], isError: true };

    if (approve) {
      db.prepare("UPDATE join_requests SET status = 'approved' WHERE id = ?").run(request_id);
      db.prepare('INSERT INTO group_members (id, group_id, user_id, role) VALUES (?,?,?,?)').run(nanoid(), joinReq.group_id, joinReq.user_id, 'member');
      return { content: [{ type: 'text', text: '✅ Approved' }] };
    } else {
      db.prepare("UPDATE join_requests SET status = 'rejected' WHERE id = ?").run(request_id);
      return { content: [{ type: 'text', text: '❌ Rejected' }] };
    }
  });

  // ─── list_groups ───
  server.tool('list_groups', 'List your groups', {}, async () => {
    const userId = requireUser();
    const groups = db.prepare(`
      SELECT g.*, gm.role, (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
      FROM groups g JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
    `).all(userId);
    return { content: [{ type: 'text', text: groups.length ? JSON.stringify(groups, null, 2) : 'No groups yet.' }] };
  });

  // ─── get_group_history ───
  server.tool('get_group_history', 'Get recent messages for a group', {
    group_id: z.string(),
    limit: z.number().max(200).optional().default(50),
  }, async ({ group_id, limit }) => {
    const userId = requireUser();
    if (!isGroupMember(userId, group_id)) return { content: [{ type: 'text', text: '❌ Not a member' }], isError: true };
    return { content: [{ type: 'text', text: 'Use WebSocket for real-time history. Relay stores messages temporarily.' }] };
  });

  // ─── translate_message ───
  server.tool('translate_message', 'Translate AI message to human readable', {
    message: z.string(),
    target_lang: z.enum(['en', 'hi']).optional().default('en'),
  }, async ({ message, target_lang }) => {
    const translated = toHuman(message, 'AI Agent');
    return { content: [{ type: 'text', text: translated }] };
  });

  // ─── get_pending_requests ───
  server.tool('get_pending_requests', 'Get pending join requests (admin)', {}, async () => {
    const userId = requireUser();
    const requests = db.prepare(`
      SELECT jr.*, g.name as group_name, u.username
      FROM join_requests jr JOIN groups g ON g.id = jr.group_id JOIN users u ON u.id = jr.user_id
      WHERE g.admin_id = ? AND jr.status = 'pending'
    `).all(userId);
    return { content: [{ type: 'text', text: requests.length ? JSON.stringify(requests, null, 2) : 'No pending requests.' }] };
  });

  // ─── leave_group ───
  server.tool('leave_group', 'Leave a group', {
    group_id: z.string(),
  }, async ({ group_id }) => {
    const userId = requireUser();
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(group_id) as Group | undefined;
    if (!group) return { content: [{ type: 'text', text: '❌ Not found' }], isError: true };
    if (group.admin_id === userId) return { content: [{ type: 'text', text: '❌ Admin cannot leave' }], isError: true };
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(group_id, userId);
    return { content: [{ type: 'text', text: '✅ Left group' }] };
  });

  return server;
}

// ─── Start: stdio mode ───
export async function startStdio() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('🤖 Pulse MCP (stdio) running');
}

// ─── Start: HTTP/SSE mode ───
export async function startHttp(port: number = 3738) {
  const mcpServer = createMcpServer();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '', `http://localhost:${port}`);

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', transport: 'sse', version: '1.0.0' }));
      return;
    }

    // SSE endpoint (GET = establish stream, POST = send messages)
    if (url.pathname === '/mcp') {
      if (req.method === 'GET') {
        // SSE connection
        const transport = new SSEServerTransport('/mcp', res);
        await mcpServer.connect(transport);
        return;
      }

      if (req.method === 'POST') {
        // Message from client — need to route to existing SSE transport
        // For simplicity, create a new streamable HTTP transport
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }
    }

    // Info
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: 'Pulse MCP Server',
      transport: 'sse',
      endpoints: { mcp: '/mcp', health: '/health' },
    }));
  });

  httpServer.listen(port, () => {
    console.log(`🤖 Pulse MCP (HTTP/SSE) running on :${port}`);
    console.log(`   SSE endpoint: http://localhost:${port}/mcp`);
  });
}
