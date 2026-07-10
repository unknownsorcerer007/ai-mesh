#!/usr/bin/env node
// AI Mesh — Terminal UI (TUI)
// Full interactive UI right in the terminal
// Like vim/htop — no browser needed
//
// Usage:
//   ai-mesh                    # Open TUI
//   ai-mesh --token <token>    # Open with token
//
// Commands inside TUI:
//   /help          Show all commands
//   /groups        List groups
//   /use <id>      Select group
//   /send <msg>    Send message
//   /inbox         Check messages
//   /create <name> Create group
//   /join <code>   Join group
//   /search <q>    Search messages
//   /approval      View pending approvals
//   /react <emoji> React to last message
//   /thread        Reply in thread
//   /notify        View notifications
//   /clear         Clear screen
//   /quit          Exit

import WebSocket from 'ws';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

// ─── Types ───
interface ChatMessage {
  id: string;
  group_id: string;
  sender: string;
  sender_ai?: string;
  type: string;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

interface ChatState {
  connected: boolean;
  username: string | null;
  token: string | undefined;
  groups: Array<{ id: string; name: string; member_count: number; role: string }>;
  messages: ChatMessage[];
  activeGroup: string | null;
  activeGroupName: string | null;
  notifications: Array<{ title: string; body: string; timestamp: string }>;
  approvals: Array<{ id: string; action: string; requester: string; status: string }>;
}

const STATE_FILE = resolve(process.env.HOME || '~', '.ai-mesh-tui.json');
const SERVER_URL = process.env.AI_MESH_SERVER || 'http://localhost:3737';

// ─── State Management ───
function loadState(): ChatState {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {}
  return { connected: false, username: null, token: undefined, groups: [], messages: [], activeGroup: null, activeGroupName: null, notifications: [], approvals: [] };
}

function saveState(state: ChatState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Colors ───
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgCyan: '\x1b[46m',
  bgBlue: '\x1b[44m',
};

// ─── Render ───
function render(state: ChatState) {
  console.clear();

  // Header
  const status = state.connected ? `${C.green}● Connected${C.reset}` : `${C.red}● Disconnected${C.reset}`;
  const user = state.username ? `@${state.username}` : 'Not logged in';
  const group = state.activeGroupName ? ` | ${C.yellow}${state.activeGroupName}${C.reset}` : '';

  console.log(`${C.cyan}╔═══════════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.cyan}║${C.reset}  ${C.bold}💬 AI Mesh${C.reset}  ${status}  ${C.dim}│${C.reset}  ${user}${group}  ${C.cyan}║${C.reset}`);
  console.log(`${C.cyan}╠═══════════════════════════════════════════════════════════╣${C.reset}`);

  // Groups sidebar
  console.log(`${C.cyan}║${C.reset}  ${C.bold}Groups:${C.reset}`);
  if (state.groups.length === 0) {
    console.log(`${C.cyan}║${C.reset}    ${C.dim}No groups. Type /create <name> or /join <code>${C.reset}`);
  } else {
    for (const g of state.groups) {
      const active = g.id === state.activeGroup ? `${C.green}●${C.reset}` : `${C.dim}○${C.reset}`;
      const role = g.role === 'admin' ? `${C.yellow}★${C.reset}` : '';
      console.log(`${C.cyan}║${C.reset}    ${active} ${C.bold}${g.name}${C.reset} ${role} ${C.dim}(${g.member_count} members)${C.reset}`);
    }
  }

  console.log(`${C.cyan}║${C.reset}`);
  console.log(`${C.cyan}║${C.reset}  ${C.bold}Messages:${C.reset}`);

  // Messages
  if (state.messages.length === 0) {
    console.log(`${C.cyan}║${C.reset}    ${C.dim}No messages. Select a group: /use <id>${C.reset}`);
  } else {
    const msgs = state.messages.slice(-15); // Last 15 messages
    for (const m of msgs) {
      const time = new Date(m.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      const icon = m.type === 'code' ? '💻' : m.type === 'alert' ? '⚠️' : m.type === 'system' ? '🔧' : '💬';
      const sender = m.sender_ai ? `${C.magenta}${m.sender_ai}${C.reset}` : `${C.blue}${m.sender}${C.reset}`;
      const content = m.content.length > 60 ? m.content.slice(0, 60) + '...' : m.content;
      console.log(`${C.cyan}║${C.reset}    ${C.dim}${time}${C.reset} ${icon} ${sender}: ${content}`);
    }
  }

  // Notifications
  if (state.notifications.length > 0) {
    console.log(`${C.cyan}║${C.reset}`);
    console.log(`${C.cyan}║${C.reset}  ${C.bold}📬 Notifications:${C.reset} ${C.yellow}${state.notifications.length} new${C.reset}`);
  }

  // Pending approvals
  if (state.approvals.length > 0) {
    console.log(`${C.cyan}║${C.reset}`);
    console.log(`${C.cyan}║${C.reset}  ${C.bold}⏳ Pending Approvals:${C.reset} ${C.red}${state.approvals.length}${C.reset}`);
  }

  console.log(`${C.cyan}╠═══════════════════════════════════════════════════════════╣${C.reset}`);
  console.log(`${C.cyan}║${C.reset}  ${C.dim}Type message or /help for commands${C.reset}`);
  console.log(`${C.cyan}╚═══════════════════════════════════════════════════════════╝${C.reset}`);
  console.log('');
}

// ─── WebSocket (first-message auth) ───
let ws: WebSocket | null = null;

function connectWs(state: ChatState) {
  if (!state.token) return;

  const wsUrl = SERVER_URL.replace(/^http/, 'ws') + '/ws';
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    // First message: authenticate
    ws!.send(JSON.stringify({ type: 'auth', token: state.token }));
  });

  ws.on('message', (data) => {
    try {
      const event = JSON.parse(data.toString());

      if (event.type === 'authenticated') {
        state.connected = true;
        saveState(state);
        render(state);
      }

      if (event.type === 'message' && event.payload) {
        state.messages.push(event.payload);
        if (state.messages.length > 200) state.messages = state.messages.slice(-100);
        saveState(state);

        // Terminal bell for new message
        process.stderr.write('\x07');
        render(state);
      }

      if (event.type === 'join_request') {
        state.notifications.push({
          title: 'Join Request',
          body: `${event.payload.group_name} - ${event.payload.request_id}`,
          timestamp: new Date().toISOString(),
        });
        saveState(state);
        render(state);
      }
    } catch {}
  });

  ws.on('close', () => {
    state.connected = false;
    saveState(state);
    render(state);
    // Reconnect after 3s
    setTimeout(() => connectWs(state), 3000);
  });

  ws.on('error', () => {
    state.connected = false;
  });
}

// ─── API Helpers ───
async function api(path: string, options: RequestInit = {}, state: ChatState): Promise<any> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.token}`,
      ...options.headers,
    },
  });
  return res.json();
}

// ─── Command Handler ───
async function handleCommand(cmd: string, state: ChatState): Promise<void> {
  const parts = cmd.trim().split(/\s+/);
  const command = parts[0].toLowerCase();

  switch (command) {
    case '/help':
    case '/h':
      console.log(`
${C.bold}AI Mesh Commands:${C.reset}

  ${C.cyan}Navigation:${C.reset}
    /groups, /g        List your groups
    /use <id>          Select active group
    /inbox, /i         Check pending messages
    /notify, /n        View notifications
    /clear             Clear screen

  ${C.cyan}Messaging:${C.reset}
    /send <msg>        Send message to active group
    /react <emoji>     React to last message
    /thread <msg>      Reply in thread

  ${C.cyan}Groups:${C.reset}
    /create <name>     Create a new group
    /join <code>       Join group via invite code
    /leave             Leave current group

  ${C.cyan}Search:${C.reset}
    /search <query>    Search messages
    /search @user      Search by sender

  ${C.cyan}Approvals:${C.reset}
    /approval          View pending approvals
    /approve <id>      Approve action
    /reject <id>       Reject action

  ${C.cyan}System:${C.reset}
    /status            Show connection status
    /refresh, /r       Refresh display
    /quit, /q          Exit

  ${C.dim}Tip: Just type a message to send it to the active group${C.reset}
      `);
      break;

    case '/groups':
    case '/g':
      try {
        state.groups = await api('/groups', {}, state);
        saveState(state);
        render(state);
      } catch (err) {
        console.log(`${C.red}Failed to fetch groups${C.reset}`);
      }
      break;

    case '/use': {
      const groupId = parts[1];
      if (!groupId) {
        // Show group list with numbers
        if (state.groups.length === 0) {
          console.log(`${C.dim}No groups. Type /create <name>${C.reset}`);
        } else {
          console.log(`${C.bold}Groups:${C.reset}`);
          state.groups.forEach((g, i) => {
            console.log(`  ${C.cyan}${i + 1}${C.reset}. ${g.name} (${g.id})`);
          });
          console.log(`${C.dim}Type /use <id> to select${C.reset}`);
        }
        break;
      }

      // Find by id or name
      const group = state.groups.find(g => g.id === groupId || g.name.toLowerCase() === groupId.toLowerCase());
      if (!group) {
        console.log(`${C.red}Group not found: ${groupId}${C.reset}`);
        break;
      }

      state.activeGroup = group.id;
      state.activeGroupName = group.name;

      // Load messages
      try {
        const data = await api(`/messages/${group.id}?limit=30`, {}, state);
        state.messages = data.messages || [];
      } catch {}

      saveState(state);
      render(state);
      break;
    }

    case '/send':
    case '/s': {
      if (!state.activeGroup) {
        console.log(`${C.red}Select a group first: /use <id>${C.reset}`);
        break;
      }
      const message = parts.slice(1).join(' ');
      if (!message) {
        console.log(`${C.red}Usage: /send <message>${C.reset}`);
        break;
      }

      try {
        await api('/messages', {
          method: 'POST',
          body: JSON.stringify({ group_id: state.activeGroup, message, type: 'text' }),
        }, state);
        console.log(`${C.green}✓ Sent${C.reset}`);
      } catch {
        console.log(`${C.red}Failed to send${C.reset}`);
      }
      break;
    }

    case '/inbox':
    case '/i':
      try {
        const data = await api('/messages/inbox', {}, state);
        if (data.messages?.length > 0) {
          state.messages = data.messages;
          console.log(`${C.green}📥 ${data.messages.length} messages received${C.reset}`);
        } else {
          console.log(`${C.dim}No pending messages${C.reset}`);
        }
        saveState(state);
        render(state);
      } catch {
        console.log(`${C.red}Failed to fetch inbox${C.reset}`);
      }
      break;

    case '/create': {
      const name = parts.slice(1).join(' ');
      if (!name) {
        console.log(`${C.red}Usage: /create <group-name>${C.reset}`);
        break;
      }

      try {
        const data = await api('/groups', {
          method: 'POST',
          body: JSON.stringify({ name }),
        }, state);
        console.log(`${C.green}✓ Group "${name}" created!${C.reset}`);
        console.log(`${C.dim}Invite code: ${data.invite_code}${C.reset}`);
        // Refresh groups
        state.groups = await api('/groups', {}, state);
        saveState(state);
      } catch {
        console.log(`${C.red}Failed to create group${C.reset}`);
      }
      break;
    }

    case '/join': {
      const code = parts[1];
      if (!code) {
        console.log(`${C.red}Usage: /join <invite-code>${C.reset}`);
        break;
      }

      try {
        const data = await api('/groups/join', {
          method: 'POST',
          body: JSON.stringify({ invite_code: code }),
        }, state);
        console.log(`${C.yellow}${data.message || data.status}${C.reset}`);
      } catch {
        console.log(`${C.red}Failed to join group${C.reset}`);
      }
      break;
    }

    case '/search':
    case '/find': {
      const query = parts.slice(1).join(' ');
      if (!query) {
        console.log(`${C.red}Usage: /search <query>${C.reset}`);
        break;
      }

      try {
        const data = await api(`/search?q=${encodeURIComponent(query)}`, {}, state);
        if (data.results?.length > 0) {
          console.log(`${C.bold}Found ${data.count} results:${C.reset}`);
          for (const r of data.results.slice(0, 10)) {
            const time = new Date(r.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            console.log(`  ${C.dim}${time}${C.reset} ${C.blue}${r.sender_username}${C.reset}: ${r.content.slice(0, 60)}`);
          }
        } else {
          console.log(`${C.dim}No results for "${query}"${C.reset}`);
        }
      } catch {
        console.log(`${C.red}Search failed${C.reset}`);
      }
      break;
    }

    case '/approval': {
      try {
        const data = await api('/approval/pending', {}, state);
        if (data.approvals?.length > 0) {
          state.approvals = data.approvals;
          console.log(`${C.bold}⏳ Pending Approvals:${C.reset}`);
          for (const a of data.approvals) {
            console.log(`  ${C.yellow}${a.id}${C.reset}: ${a.action} (by ${a.requester_name})`);
          }
          console.log(`${C.dim}Type /approve <id> or /reject <id>${C.reset}`);
        } else {
          console.log(`${C.dim}No pending approvals${C.reset}`);
        }
        saveState(state);
      } catch {
        console.log(`${C.red}Failed to fetch approvals${C.reset}`);
      }
      break;
    }

    case '/approve': {
      const approvalId = parts[1];
      if (!approvalId) {
        console.log(`${C.red}Usage: /approve <approval-id>${C.reset}`);
        break;
      }
      try {
        await api('/approval/respond', {
          method: 'POST',
          body: JSON.stringify({ approval_id: approvalId, approve: true }),
        }, state);
        console.log(`${C.green}✅ Approved${C.reset}`);
      } catch {
        console.log(`${C.red}Failed to approve${C.reset}`);
      }
      break;
    }

    case '/reject': {
      const approvalId = parts[1];
      if (!approvalId) {
        console.log(`${C.red}Usage: /reject <approval-id>${C.reset}`);
        break;
      }
      try {
        await api('/approval/respond', {
          method: 'POST',
          body: JSON.stringify({ approval_id: approvalId, approve: false, reason: parts.slice(2).join(' ') }),
        }, state);
        console.log(`${C.red}❌ Rejected${C.reset}`);
      } catch {
        console.log(`${C.red}Failed to reject${C.reset}`);
      }
      break;
    }

    case '/notify':
    case '/n':
      try {
        const data = await api('/notifications?limit=10', {}, state);
        if (data.notifications?.length > 0) {
          console.log(`${C.bold}📬 Notifications:${C.reset}`);
          for (const n of data.notifications) {
            console.log(`  ${C.dim}${n.timestamp}${C.reset} ${n.title}: ${n.body}`);
          }
        } else {
          console.log(`${C.dim}No notifications${C.reset}`);
        }
      } catch {
        console.log(`${C.red}Failed to fetch notifications${C.reset}`);
      }
      break;

    case '/status':
      console.log(`
${C.bold}Status:${C.reset}
  Server: ${SERVER_URL}
  Connected: ${state.connected ? `${C.green}Yes${C.reset}` : `${C.red}No${C.reset}`}
  User: ${state.username || 'Not logged in'}
  Active Group: ${state.activeGroupName || 'None'}
  Groups: ${state.groups.length}
  Messages: ${state.messages.length}
      `);
      break;

    case '/clear':
      render(state);
      break;

    case '/quit':
    case '/q':
      ws?.close();
      console.log(`${C.dim}Bye! 👋${C.reset}`);
      process.exit(0);

    default:
      if (cmd.startsWith('/')) {
        console.log(`${C.red}Unknown command: ${command}. Type /help${C.reset}`);
      } else if (cmd.trim() && state.activeGroup) {
        // Treat as message
        await handleCommand(`/send ${cmd}`, state);
      } else if (cmd.trim()) {
        console.log(`${C.dim}Select a group first: /use <id>${C.reset}`);
      }
  }
}

// ─── Main ───
async function main() {
  const state = loadState();

  // Check for token in args or env
  const args = process.argv.slice(2);
  let token = process.env.AI_MESH_TOKEN;

  if (args.includes('--token')) {
    token = args[args.indexOf('--token') + 1];
  }

  if (!token) {
    // Try to load from state
    token = state.token || undefined;
  }

  if (!token) {
    console.log(`${C.bold}AI Mesh TUI${C.reset}`);
    console.log(`${C.dim}No token found. Login first:${C.reset}`);
    console.log(`  1. Open: ${C.cyan}${SERVER_URL}${C.reset}`);
    console.log(`  2. Login with GitHub`);
    console.log(`  3. Copy your token`);
    console.log(`  4. Run: ${C.cyan}ai-mesh --token <your-token>${C.reset}`);
    console.log(`\n${C.dim}Or set AI_MESH_TOKEN environment variable${C.reset}`);
    process.exit(1);
  }

  state.token = token || undefined;

  // Fetch user info
  try {
    const user = await api('/auth/me', {}, state);
    state.username = user.username;
  } catch {
    console.log(`${C.red}Invalid token or server unreachable${C.reset}`);
    process.exit(1);
  }

  // Fetch groups
  try {
    state.groups = await api('/groups', {}, state);
  } catch {}

  // Fetch notifications
  try {
    const data = await api('/notifications?limit=5', {}, state);
    state.notifications = data.notifications || [];
  } catch {}

  // Fetch pending approvals
  try {
    const data = await api('/approval/pending', {}, state);
    state.approvals = data.approvals || [];
  } catch {}

  saveState(state);

  // Connect WebSocket
  connectWs(state);

  // Initial render
  render(state);

  // Setup readline
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.cyan}❯ ${C.reset}`,
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const cmd = line.trim();
    if (cmd) {
      await handleCommand(cmd, state);
    }
    rl.prompt();
  });

  rl.on('close', () => {
    ws?.close();
    process.exit(0);
  });
}

main().catch(console.error);
