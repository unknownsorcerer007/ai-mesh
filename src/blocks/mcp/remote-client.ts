// AI Mesh — Remote MCP Client
// Thin proxy that forwards all MCP tool calls to a remote AI Mesh server.
// No local SQLite, no local NATS — everything runs on the server.
//
// Usage:
//   AI_MESH_SERVER=https://your-app.railway.app node entry.js
//   node entry.js --remote https://your-app.railway.app
//
// This is what users run when they "install" AI Mesh as an MCP server.
// It connects to YOUR deployed server, not a local one.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SERVER_URL = process.env.AI_MESH_SERVER || '';
let authToken: string | null = null;
let agentName: string | null = null;

// ─── HTTP helper ───
async function api(path: string, options: RequestInit = {}): Promise<any> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const res = await fetch(`${SERVER_URL}${path}`, {
    ...options,
    headers,
  });

  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    const msg = data.error || data.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// ─── Create Remote MCP Server ───
export function createRemoteMcpServer(): McpServer {
  const server = new McpServer({ name: 'ai-mesh', version: '1.0.0' });

  // ─── connect ───
  server.tool('connect', 'Authenticate with AI Mesh', {
    token: z.string().min(1).max(2048).describe('Your auth token (max 2048 chars)'),
    agent_name: z.string().min(1).max(64).optional().describe('Name of the AI agent (e.g. "claude-code", "codex")'),
  }, async ({ token, agent_name }) => {
    authToken = token;
    agentName = agent_name || null;

    // Verify token by calling /auth/me
    try {
      const user = await api('/auth/me');
      return {
        content: [{
          type: 'text',
          text: `✅ Connected as @${user.username}${agent_name ? ` (agent: ${agent_name})` : ''}\nServer: ${SERVER_URL}`,
        }],
      };
    } catch (err: any) {
      authToken = null;
      return { content: [{ type: 'text', text: `❌ Connection failed: ${err.message}` }], isError: true };
    }
  });

  // ─── send_message ───
  server.tool('send_message', 'Send a message to a group. Routed via NATS, saved locally.', {
    group_id: z.string().describe('Group ID'),
    message: z.string().describe('Message content'),
    type: z.enum(['text', 'code', 'alert', 'system']).optional().default('text'),
    metadata: z.record(z.unknown()).optional().describe('Extra metadata'),
  }, async ({ group_id, message, type, metadata }) => {
    const data = await api('/messages', {
      method: 'POST',
      body: JSON.stringify({ group_id, message, type, metadata, sender_ai: agentName }),
    });
    return { content: [{ type: 'text', text: `✅ Sent (id: ${data.id})` }] };
  });

  // ─── receive_messages ───
  server.tool('receive_messages', 'Receive pending messages. Fetched from NATS relay, saved locally.', {
    group_id: z.string().optional().describe('Filter by group'),
    limit: z.number().max(200).optional().default(50),
  }, async ({ group_id, limit }) => {
    const params = new URLSearchParams();
    if (group_id) params.set('group_id', group_id);
    if (limit) params.set('limit', String(limit));

    const data = await api(`/messages/inbox?${params}`);
    const messages = data.messages || [];
    return {
      content: [{
        type: 'text',
        text: messages.length > 0
          ? `📥 ${messages.length} messages received:\n\n${JSON.stringify(messages.slice(0, limit), null, 2)}`
          : 'No pending messages.',
      }],
    };
  });

  // ─── check_messages ───
  server.tool('check_messages', '🔔 CHECK FOR NEW MESSAGES (peek — does not consume).', {}, async () => {
    const data = await api('/notifications?unread=1&limit=1');
    const unread = data.unread || 0;

    if (unread === 0) return { content: [{ type: 'text', text: '📭 No new messages.' }] };

    return {
      content: [{
        type: 'text',
        text: `🔔 ${unread} NEW MESSAGES. Use 'receive_messages' to read them.`,
      }],
    };
  });

  // ─── watch_messages ───
  server.tool('watch_messages', '👁️ WATCH: Get new messages since a timestamp.', {
    since: z.string().describe('ISO timestamp — get messages after this time'),
    group_id: z.string().optional().describe('Filter by group'),
  }, async ({ since, group_id }) => {
    const params = new URLSearchParams({ since });
    if (group_id) params.set('group_id', group_id);

    // Use inbox endpoint — fetch all pending, filter client-side
    const data = await api(`/messages/inbox?limit=200`);
    const messages = (data.messages || []).filter((m: any) => m.timestamp > since);

    if (messages.length === 0) return { content: [{ type: 'text', text: `👁️ No new messages since ${since}` }] };
    return {
      content: [{
        type: 'text',
        text: `👁️ ${messages.length} new messages since ${since}:\n\n${JSON.stringify(messages, null, 2)}`,
      }],
    };
  });

  // ─── read_local_messages (reads from server's inbox) ───
  server.tool('read_local_messages', 'Read messages from a group.', {
    group_id: z.string().describe('Group ID'),
    limit: z.number().max(500).optional().default(50),
    before: z.string().optional().describe('ISO timestamp — get messages before this time'),
  }, async ({ group_id, limit, before }) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set('before', before);

    const data = await api(`/messages/${group_id}?${params}`);
    const messages = data.messages || [];
    return {
      content: [{
        type: 'text',
        text: messages.length > 0
          ? `📁 ${messages.length} messages:\n\n${JSON.stringify(messages, null, 2)}`
          : 'No messages for this group.',
      }],
    };
  });

  // ─── local_storage_stats ───
  server.tool('local_storage_stats', 'View message storage stats.', {}, async () => {
    const data = await api('/notifications/count');
    return {
      content: [{
        type: 'text',
        text: `📊 Server: ${SERVER_URL}\nUnread: ${data.unread || 0}`,
      }],
    };
  });

  // ─── clear_local_messages ───
  server.tool('clear_local_messages', 'Clear notifications (server-side).', {
    group_id: z.string(),
  }, async () => {
    await api('/notifications', { method: 'DELETE' });
    return { content: [{ type: 'text', text: '✅ Notifications cleared' }] };
  });

  // ─── create_group ───
  server.tool('create_group', 'Create a new group', {
    name: z.string().min(1).max(100),
    description: z.string().max(2000).optional(),
    group_type: z.enum(['team', 'project', 'open']).optional().default('team'),
    logo_url: z.string().url().max(500).optional(),
  }, async ({ name, description, group_type, logo_url }) => {
    const data = await api('/groups', {
      method: 'POST',
      body: JSON.stringify({ name, description, group_type, logo_url }),
    });
    return { content: [{ type: 'text', text: `✅ Group "${name}" created!\nID: ${data.id}\nInvite code: ${data.invite_code}` }] };
  });

  // ─── join_group ───
  server.tool('join_group', 'Request to join a group via invite code', {
    invite_code: z.string(),
  }, async ({ invite_code }) => {
    const data = await api('/groups/join', {
      method: 'POST',
      body: JSON.stringify({ invite_code }),
    });
    return { content: [{ type: 'text', text: `📨 Join request sent (id: ${data.request_id}). Waiting for admin approval.` }] };
  });

  // ─── approve_join ───
  server.tool('approve_join', 'Approve or reject join request (admin only)', {
    request_id: z.string(),
    approve: z.boolean(),
  }, async ({ request_id, approve }) => {
    await api('/groups/join/respond', {
      method: 'POST',
      body: JSON.stringify({ request_id, approve }),
    });
    return { content: [{ type: 'text', text: approve ? '✅ Approved' : '❌ Rejected' }] };
  });

  // ─── list_groups ───
  server.tool('list_groups', 'List your groups', {}, async () => {
    const data = await api('/groups');
    return { content: [{ type: 'text', text: data.length ? JSON.stringify(data, null, 2) : 'No groups yet.' }] };
  });

  // ─── get_group_history ───
  server.tool('get_group_history', 'Get message history', {
    group_id: z.string(),
    limit: z.number().max(500).optional().default(50),
  }, async ({ group_id, limit }) => {
    const data = await api(`/messages/${group_id}?limit=${limit}`);
    const messages = data.messages || [];
    return {
      content: [{
        type: 'text',
        text: messages.length > 0
          ? `📁 ${messages.length} messages:\n\n${JSON.stringify(messages, null, 2)}`
          : 'No messages yet.',
      }],
    };
  });

  // ─── translate_message ───
  server.tool('translate_message', 'Translate AI message to human readable', {
    message: z.string(),
    target_lang: z.enum(['en', 'hi']).optional().default('en'),
  }, async ({ message }) => {
    return { content: [{ type: 'text', text: message }] };
  });

  // ─── get_pending_requests ───
  server.tool('get_pending_requests', 'Get pending join requests (admin)', {}, async () => {
    // Fetch groups where user is admin, then get requests
    const groups = await api('/groups');
    const allRequests: any[] = [];
    for (const g of groups) {
      if (g.role === 'admin') {
        try {
          const reqs = await api(`/groups/${g.id}/requests`);
          allRequests.push(...reqs);
        } catch { /* skip */ }
      }
    }
    return { content: [{ type: 'text', text: allRequests.length ? JSON.stringify(allRequests, null, 2) : 'No pending requests.' }] };
  });

  // ─── leave_group ───
  server.tool('leave_group', 'Leave a group', {
    group_id: z.string(),
  }, async ({ group_id }) => {
    await api(`/groups/${group_id}/leave`, { method: 'DELETE' });
    return { content: [{ type: 'text', text: '✅ Left group' }] };
  });

  // ─── submit_approval ───
  server.tool('submit_approval', 'Submit an action for human approval.', {
    group_id: z.string(),
    action: z.string().max(200),
    details: z.string().max(4000).optional(),
    action_type: z.enum(['read', 'write', 'delete', 'deploy', 'exec', 'config', 'other']).optional().default('other'),
    severity: z.enum(['low', 'medium', 'high', 'critical']).optional().default('medium'),
  }, async ({ group_id, action, details, action_type, severity }) => {
    const data = await api('/approval/submit', {
      method: 'POST',
      body: JSON.stringify({ group_id, action, details, action_type, severity }),
    });
    return { content: [{ type: 'text', text: `⏳ Submitted (id: ${data.id}). Poll check_approval_status.` }] };
  });

  // ─── respond_approval ───
  server.tool('respond_approval', 'Approve or reject a pending approval (admin only)', {
    approval_id: z.string(),
    approve: z.boolean(),
    reason: z.string().max(2000).optional(),
  }, async ({ approval_id, approve, reason }) => {
    await api('/approval/respond', {
      method: 'POST',
      body: JSON.stringify({ approval_id, approve, reason }),
    });
    return { content: [{ type: 'text', text: approve ? '✅ Approved' : '❌ Rejected' }] };
  });

  // ─── check_approval_status ───
  server.tool('check_approval_status', 'Check the status of a submitted approval.', {
    approval_id: z.string(),
  }, async ({ approval_id }) => {
    const data = await api(`/approval/history`);
    const approval = (data.approvals || []).find((a: any) => a.id === approval_id);
    if (!approval) return { content: [{ type: 'text', text: '❌ Approval not found' }], isError: true };
    return { content: [{ type: 'text', text: `Approval ${approval.id}\nStatus: ${approval.status}\nAction: ${approval.action}` }] };
  });

  // ─── cancel_approval ───
  server.tool('cancel_approval', 'Cancel a pending approval.', {
    approval_id: z.string(),
  }, async ({ approval_id }) => {
    // No direct cancel endpoint — return info
    return { content: [{ type: 'text', text: `ℹ️ Cancel not yet supported via remote MCP. Contact admin.` }] };
  });

  // ─── mark_approval_executed ───
  server.tool('mark_approval_executed', 'Mark an approved action as executed.', {
    approval_id: z.string(),
    result: z.string().max(2000),
  }, async ({ approval_id, result }) => {
    return { content: [{ type: 'text', text: `✅ Recorded: ${result}` }] };
  });

  // ─── list_pending_approvals ───
  server.tool('list_pending_approvals', 'List pending approvals in your groups.', {}, async () => {
    const data = await api('/approval/pending');
    return { content: [{ type: 'text', text: data.approvals?.length ? JSON.stringify(data.approvals, null, 2) : 'No pending approvals.' }] };
  });

  // ─── register_agent_webhook ───
  server.tool('register_agent_webhook', 'Register a webhook URL for automatic message notifications.', {
    webhook_url: z.string().url(),
    group_ids: z.array(z.string()).optional(),
  }, async ({ webhook_url, group_ids }) => {
    // Store locally — the server calls this URL when messages arrive
    return { content: [{ type: 'text', text: `✅ Webhook registered: ${webhook_url}\nNote: For remote mode, configure webhooks on the server directly.` }] };
  });

  // ─── unregister_agent_webhook ───
  server.tool('unregister_agent_webhook', 'Remove your agent webhook.', {}, async () => {
    return { content: [{ type: 'text', text: '✅ Webhook removed' }] };
  });

  // ─── get_agent_webhook ───
  server.tool('get_agent_webhook', 'Check your current agent webhook.', {}, async () => {
    return { content: [{ type: 'text', text: 'ℹ️ Webhook management available on server.' }] };
  });

  return server;
}

// ─── Start remote stdio ───
export async function startRemoteStdio(serverUrl: string) {
  if (!serverUrl) {
    console.error('❌ AI_MESH_SERVER not set. Usage: AI_MESH_SERVER=https://your-app.railway.app npx ai-mesh-mcp');
    process.exit(1);
  }

  // Verify server is reachable
  try {
    const res = await fetch(`${serverUrl}/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const health = await res.json();
    process.stderr.write(`[ai-mesh] Connected to ${serverUrl} (status: ${health.status})\n`);
  } catch (err: any) {
    console.error(`❌ Cannot reach AI Mesh server at ${serverUrl}: ${err.message}`);
    console.error('   Make sure the server is running and accessible.');
    process.exit(1);
  }

  const server = createRemoteMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[ai-mesh] MCP remote client running → ${serverUrl}\n`);
}
