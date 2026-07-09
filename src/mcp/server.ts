import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import db from '../db/index.js';
import { authenticate } from '../auth/github.js';
import {
  detectInjection,
  sanitizeMessage,
  generateKeyPair,
  generateHashId,
  generateInviteCode,
  checkRateLimit,
} from '../security/index.js';
import { toHuman, toAI, translateType } from '../translate/index.js';
import { nanoid } from 'nanoid';
import type { User, Group, Message } from '../types/index.js';

// ─── Context: who is connected ───
let currentUserId: string | null = null;

export function setCurrentUser(userId: string) {
  currentUserId = userId;
}

function requireUser(): string {
  if (!currentUserId) throw new Error('Not authenticated. Connect first.');
  return currentUserId;
}

function isGroupMember(userId: string, groupId: string): boolean {
  const m = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId);
  return !!m;
}

// ─── Create MCP Server ───

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'pulse',
    version: '1.0.0',
  });

  // ─── Tool: connect ───
  server.tool(
    'connect',
    'Authenticate with Pulse using your token. Must be called first.',
    {
      token: z.string().describe('Your auth token from GitHub OAuth'),
    },
    async ({ token }) => {
      const userId = authenticate({ headers: { authorization: `Bearer ${token}` } } as any);
      if (!userId) return { content: [{ type: 'text', text: '❌ Invalid token' }], isError: true };
      currentUserId = userId;
      const user = db.prepare('SELECT username, hash_id FROM users WHERE id = ?').get(userId) as any;
      return { content: [{ type: 'text', text: `✅ Connected as @${user.username} (${user.hash_id})` }] };
    }
  );

  // ─── Tool: send_message ───
  server.tool(
    'send_message',
    'Send a message to a group. Use structured JSON for AI-native format or plain text.',
    {
      group_id: z.string().describe('Group ID to send to'),
      message: z.string().describe('Message content (plain text or JSON)'),
      type: z.enum(['text', 'code', 'alert', 'system']).optional().default('text'),
      metadata: z.record(z.unknown()).optional().describe('Extra metadata (files, diff, etc)'),
    },
    async ({ group_id, message, type, metadata }) => {
      const userId = requireUser();
      if (!isGroupMember(userId, group_id)) {
        return { content: [{ type: 'text', text: '❌ Not a member of this group' }], isError: true };
      }

      // Rate limit
      const rate = checkRateLimit(`mcp:msg:${userId}`, 60_000, 60);
      if (!rate.allowed) return { content: [{ type: 'text', text: '❌ Rate limit exceeded' }], isError: true };

      // Injection check
      const injection = detectInjection(message);
      if (!injection.safe) return { content: [{ type: 'text', text: `❌ ${injection.reason}` }], isError: true };

      const clean = sanitizeMessage(message);
      const msgId = nanoid();

      db.prepare(`
        INSERT INTO messages (id, group_id, sender_id, sender_ai, message_type, content, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(msgId, group_id, userId, 'mcp-agent', type, clean, metadata ? JSON.stringify(metadata) : null);

      // Queue for offline members
      const members = db.prepare('SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ?')
        .all(group_id, userId) as { user_id: string }[];
      const expiresAt = new Date(Date.now() + 604_800_000).toISOString();
      for (const m of members) {
        db.prepare('INSERT INTO pending_messages (id, message_id, recipient_id, expires_at) VALUES (?, ?, ?, ?)')
          .run(nanoid(), msgId, m.user_id, expiresAt);
      }

      return { content: [{ type: 'text', text: `✅ Message sent (id: ${msgId})` }] };
    }
  );

  // ─── Tool: receive_messages ───
  server.tool(
    'receive_messages',
    'Get your pending messages. Messages are marked as delivered after retrieval.',
    {
      group_id: z.string().optional().describe('Filter by group ID'),
      limit: z.number().max(200).optional().default(50),
    },
    async ({ group_id, limit }) => {
      const userId = requireUser();

      let query = `
        SELECT pm.id as pending_id, m.*, u.username as sender_username
        FROM pending_messages pm
        JOIN messages m ON m.id = pm.message_id
        JOIN users u ON u.id = m.sender_id
        WHERE pm.recipient_id = ? AND pm.status = 'pending'
      `;
      const params: (string | number)[] = [userId];
      if (group_id) { query += ' AND m.group_id = ?'; params.push(group_id); }
      query += ' ORDER BY m.created_at ASC LIMIT ?';
      params.push(limit);

      const messages = db.prepare(query).all(...params) as any[];

      // Mark delivered
      if (messages.length > 0) {
        const ids = messages.map(m => m.pending_id);
        db.prepare(`UPDATE pending_messages SET status = 'delivered' WHERE id IN (${ids.map(() => '?').join(',')})`)
          .run(...ids);
      }

      // Format for AI consumption
      const formatted = messages.map(m => ({
        id: m.id,
        group_id: m.group_id,
        sender: m.sender_username,
        sender_ai: m.sender_ai,
        type: m.message_type,
        content: m.content,
        metadata: m.metadata ? JSON.parse(m.metadata) : null,
        created_at: m.created_at,
      }));

      return {
        content: [{
          type: 'text',
          text: formatted.length > 0
            ? JSON.stringify(formatted, null, 2)
            : 'No pending messages.',
        }],
      };
    }
  );

  // ─── Tool: create_group ───
  server.tool(
    'create_group',
    'Create a new group for AI-to-AI communication.',
    {
      name: z.string().min(1).max(100).describe('Group name'),
      description: z.string().optional(),
      group_type: z.enum(['team', 'project', 'open']).optional().default('team'),
    },
    async ({ name, description, group_type }) => {
      const userId = requireUser();
      const rate = checkRateLimit(`mcp:group:${userId}`, 3600_000, 10);
      if (!rate.allowed) return { content: [{ type: 'text', text: '❌ Rate limit: too many groups' }], isError: true };

      const groupId = nanoid();
      const inviteCode = generateInviteCode();

      db.prepare(`INSERT INTO groups (id, name, description, invite_code, admin_id, group_type) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(groupId, name, description || null, inviteCode, userId, group_type || 'team');
      db.prepare('INSERT INTO group_members (id, group_id, user_id, role) VALUES (?, ?, ?, ?)')
        .run(nanoid(), groupId, userId, 'admin');

      return {
        content: [{
          type: 'text',
          text: `✅ Group created!\nID: ${groupId}\nName: ${name}\nInvite code: ${inviteCode}\nShare this code to invite members.`,
        }],
      };
    }
  );

  // ─── Tool: join_group ───
  server.tool(
    'join_group',
    'Request to join a group using invite code. Requires admin approval.',
    {
      invite_code: z.string().describe('Invite code from group admin'),
    },
    async ({ invite_code }) => {
      const userId = requireUser();

      const group = db.prepare('SELECT * FROM groups WHERE invite_code = ?').get(invite_code) as Group | undefined;
      if (!group) return { content: [{ type: 'text', text: '❌ Invalid invite code' }], isError: true };

      const existing = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(group.id, userId);
      if (existing) return { content: [{ type: 'text', text: '⚠️ Already a member' }] };

      const pendingReq = db.prepare("SELECT 1 FROM join_requests WHERE group_id = ? AND user_id = ? AND status = 'pending'").get(group.id, userId);
      if (pendingReq) return { content: [{ type: 'text', text: '⏳ Join request already pending' }] };

      db.prepare('INSERT INTO join_requests (id, group_id, user_id, status) VALUES (?, ?, ?, ?)')
        .run(nanoid(), group.id, userId, 'pending');

      return {
        content: [{
          type: 'text',
          text: `📨 Join request sent to "${group.name}". Waiting for admin approval.`,
        }],
      };
    }
  );

  // ─── Tool: approve_join ───
  server.tool(
    'approve_join',
    'Approve or reject a pending join request. Admin only.',
    {
      request_id: z.string().describe('Join request ID'),
      approve: z.boolean().describe('true = approve, false = reject'),
    },
    async ({ request_id, approve }) => {
      const userId = requireUser();

      const joinReq = db.prepare('SELECT * FROM join_requests WHERE id = ?').get(request_id) as any;
      if (!joinReq || joinReq.status !== 'pending') {
        return { content: [{ type: 'text', text: '❌ Request not found or already handled' }], isError: true };
      }

      const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(joinReq.group_id) as Group;
      if (group.admin_id !== userId) {
        return { content: [{ type: 'text', text: '❌ Only admin can approve' }], isError: true };
      }

      if (approve) {
        db.prepare("UPDATE join_requests SET status = 'approved' WHERE id = ?").run(request_id);
        db.prepare('INSERT INTO group_members (id, group_id, user_id, role) VALUES (?, ?, ?, ?)')
          .run(nanoid(), joinReq.group_id, joinReq.user_id, 'member');
        return { content: [{ type: 'text', text: '✅ Member approved and added to group' }] };
      } else {
        db.prepare("UPDATE join_requests SET status = 'rejected' WHERE id = ?").run(request_id);
        return { content: [{ type: 'text', text: '❌ Join request rejected' }] };
      }
    }
  );

  // ─── Tool: list_groups ───
  server.tool(
    'list_groups',
    'List all groups you are a member of.',
    {},
    async () => {
      const userId = requireUser();
      const groups = db.prepare(`
        SELECT g.*, gm.role,
          (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
        FROM groups g
        JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
      `).all(userId);

      return {
        content: [{
          type: 'text',
          text: groups.length > 0 ? JSON.stringify(groups, null, 2) : 'No groups yet. Create one with create_group or join with join_group.',
        }],
      };
    }
  );

  // ─── Tool: get_group_history ───
  server.tool(
    'get_group_history',
    'Get recent message history for a group.',
    {
      group_id: z.string(),
      limit: z.number().max(200).optional().default(50),
    },
    async ({ group_id, limit }) => {
      const userId = requireUser();
      if (!isGroupMember(userId, group_id)) {
        return { content: [{ type: 'text', text: '❌ Not a member' }], isError: true };
      }

      const messages = db.prepare(`
        SELECT m.*, u.username as sender_username
        FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE m.group_id = ?
        ORDER BY m.created_at DESC LIMIT ?
      `).all(group_id, limit) as any[];

      return {
        content: [{
          type: 'text',
          text: messages.length > 0 ? JSON.stringify(messages.reverse(), null, 2) : 'No messages in this group.',
        }],
      };
    }
  );

  // ─── Tool: translate_message ───
  server.tool(
    'translate_message',
    'Translate AI structured message to human readable format.',
    {
      message: z.string().describe('Message to translate'),
      target_lang: z.enum(['en', 'hi']).optional().default('en'),
    },
    async ({ message, target_lang }) => {
      const translated = toHuman(message, 'AI Agent');
      const typeLabel = translateType(
        (() => { try { return JSON.parse(message).type; } catch { return 'text'; } })(),
        target_lang
      );

      return {
        content: [{
          type: 'text',
          text: `${translated}\n\n[${target_lang}] Type: ${typeLabel}`,
        }],
      };
    }
  );

  // ─── Tool: get_pending_requests ───
  server.tool(
    'get_pending_requests',
    'Get pending join requests for groups you admin.',
    {},
    async () => {
      const userId = requireUser();
      const requests = db.prepare(`
        SELECT jr.*, g.name as group_name, u.username, u.hash_id
        FROM join_requests jr
        JOIN groups g ON g.id = jr.group_id
        JOIN users u ON u.id = jr.user_id
        WHERE g.admin_id = ? AND jr.status = 'pending'
        ORDER BY jr.created_at ASC
      `).all(userId);

      return {
        content: [{
          type: 'text',
          text: requests.length > 0 ? JSON.stringify(requests, null, 2) : 'No pending requests.',
        }],
      };
    }
  );

  // ─── Tool: leave_group ───
  server.tool(
    'leave_group',
    'Leave a group.',
    {
      group_id: z.string(),
    },
    async ({ group_id }) => {
      const userId = requireUser();
      const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(group_id) as Group | undefined;
      if (!group) return { content: [{ type: 'text', text: '❌ Group not found' }], isError: true };
      if (group.admin_id === userId) return { content: [{ type: 'text', text: '❌ Admin cannot leave. Delete group instead.' }], isError: true };

      db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(group_id, userId);
      return { content: [{ type: 'text', text: '✅ Left the group' }] };
    }
  );

  return server;
}

// ─── Start MCP Server (stdio transport) ───

export async function startMcpServer() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('🤖 Pulse MCP Server running (stdio)');
}
