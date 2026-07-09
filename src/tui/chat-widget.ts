// Pulse — Terminal Chat Widget
// A small floating chat window for terminal environments
// Works alongside Claude Code, Codex, OpenClaw, or any terminal tool

import WebSocket from 'ws';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

interface ChatMessage {
  id: string;
  group_id: string;
  sender: string;
  sender_ai?: string;
  type: string;
  content: string;
  timestamp: string;
}

interface ChatState {
  connected: boolean;
  username: string | null;
  groups: Array<{ id: string; name: string; member_count: number }>;
  messages: ChatMessage[];
  activeGroup: string | null;
}

const STATE_FILE = resolve(process.env.HOME || '~', '.pulse-chat.json');

// ─── Load/Save State ───

function loadState(): ChatState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {}
  return { connected: false, username: null, groups: [], messages: [], activeGroup: null };
}

function saveState(state: ChatState) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Notification Sound (terminal bell) ───

function notify() {
  process.stdout.write('\x07'); // Terminal bell
}

// ─── Mini TUI Renderer ───

function renderHeader(state: ChatState) {
  const status = state.connected ? '🟢 Connected' : '🔴 Disconnected';
  const user = state.username ? `@${state.username}` : 'Not logged in';
  return `\x1b[1;36m┌─── Pulse ${status} │ ${user} ───\x1b[0m`;
}

function renderGroups(state: ChatState) {
  if (state.groups.length === 0) return '\x1b[90m  No groups. Use /create or /join\x1b[0m';
  return state.groups.map(g => {
    const active = g.id === state.activeGroup ? ' \x1b[32m●\x1b[0m' : '';
    return `  \x1b[33m${g.name}\x1b[0m${active} (${g.member_count} members)`;
  }).join('\n');
}

function renderMessages(state: ChatState, limit: number = 10) {
  const msgs = state.messages.slice(-limit);
  if (msgs.length === 0) return '\x1b[90m  No messages yet\x1b[0m';
  return msgs.map(m => {
    const time = new Date(m.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const sender = m.sender_ai ? `\x1b[35m${m.sender_ai}\x1b[0m` : `\x1b[34m${m.sender}\x1b[0m`;
    const typeIcon = m.type === 'code' ? '💻' : m.type === 'alert' ? '⚠️' : m.type === 'system' ? '🔧' : '💬';
    return `  \x1b[90m${time}\x1b[0m ${typeIcon} ${sender}: ${m.content.slice(0, 80)}`;
  }).join('\n');
}

function renderInput() {
  return '\x1b[1;36m└─> \x1b[0m';
}

function render(state: ChatState) {
  // Clear and redraw (minimal — works in any terminal)
  console.clear();
  console.log(renderHeader(state));
  console.log('\x1b[1;33m Groups:\x1b[0m');
  console.log(renderGroups(state));
  console.log('\x1b[1;33m Messages:\x1b[0m');
  console.log(renderMessages(state));
  console.log(renderInput());
}

// ─── WebSocket Connection ───

let ws: WebSocket | null = null;

function connectWs(serverUrl: string, token: string, state: ChatState) {
  const wsUrl = serverUrl.replace(/^http/, 'ws') + `/ws?token=${token}`;
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    state.connected = true;
    saveState(state);
    render(state);
  });

  ws.on('message', (data) => {
    try {
      const event = JSON.parse(data.toString());
      if (event.type === 'message') {
        state.messages.push(event.payload);
        saveState(state);
        notify(); // 🔔 Terminal bell on new message
        render(state);
      }
    } catch {}
  });

  ws.on('close', () => {
    state.connected = false;
    saveState(state);
    // Reconnect after 5s
    setTimeout(() => connectWs(serverUrl, token, state), 5000);
  });

  ws.on('error', () => {
    state.connected = false;
  });
}

// ─── Command Handler ───

async function handleCommand(cmd: string, serverUrl: string, token: string, state: ChatState) {
  const parts = cmd.trim().split(/\s+/);
  const command = parts[0];

  switch (command) {
    case '/groups':
    case '/g': {
      const res = await fetch(`${serverUrl}/groups`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      state.groups = await res.json();
      saveState(state);
      render(state);
      break;
    }

    case '/send':
    case '/s': {
      if (!state.activeGroup) { console.log('\x1b[31mSelect a group first: /use <group-id>\x1b[0m'); break; }
      const message = parts.slice(1).join(' ');
      if (!message) { console.log('\x1b[31mUsage: /send <message>\x1b[0m'); break; }
      await fetch(`${serverUrl}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ group_id: state.activeGroup, message, type: 'text' }),
      });
      console.log('\x1b[32m✓ Sent\x1b[0m');
      break;
    }

    case '/use': {
      const groupId = parts[1];
      if (!groupId) { console.log('\x1b[31mUsage: /use <group-id>\x1b[0m'); break; }
      state.activeGroup = groupId;
      // Load history
      const res = await fetch(`${serverUrl}/messages/${groupId}?limit=20`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json() as any;
      state.messages = data.messages || [];
      saveState(state);
      render(state);
      break;
    }

    case '/inbox':
    case '/i': {
      const res = await fetch(`${serverUrl}/messages/inbox`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json() as any;
      state.messages = data.messages || [];
      saveState(state);
      notify();
      render(state);
      break;
    }

    case '/create': {
      const name = parts.slice(1).join(' ');
      if (!name) { console.log('\x1b[31mUsage: /create <group-name>\x1b[0m'); break; }
      const res = await fetch(`${serverUrl}/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name }),
      });
      const group = await res.json() as any;
      console.log(`\x1b[32m✓ Group created: ${group.invite_code}\x1b[0m`);
      break;
    }

    case '/join': {
      const code = parts[1];
      if (!code) { console.log('\x1b[31mUsage: /join <invite-code>\x1b[0m'); break; }
      const res = await fetch(`${serverUrl}/groups/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ invite_code: code }),
      });
      const data = await res.json() as any;
      console.log(`\x1b[33m${data.message || JSON.stringify(data)}\x1b[0m`);
      break;
    }

    case '/refresh':
    case '/r':
      render(state);
      break;

    case '/help':
    case '/h':
      console.log(`
\x1b[1;36mPulse Chat Commands:\x1b[0m
  /groups, /g        List your groups
  /use <id>          Select active group & load history
  /send <msg>, /s    Send message to active group
  /inbox, /i         Check pending messages
  /create <name>     Create a new group
  /join <code>       Join group via invite code
  /refresh, /r       Refresh display
  /quit, /q          Exit
  /help, /h          Show this help
      `);
      break;

    case '/quit':
    case '/q':
      ws?.close();
      process.exit(0);

    default:
      if (cmd.startsWith('/')) {
        console.log(`\x1b[31mUnknown command: ${command}. Type /help\x1b[0m`);
      } else if (state.activeGroup && cmd.trim()) {
        // Treat as message
        await handleCommand(`/send ${cmd}`, serverUrl, token, state);
      }
  }
}

// ─── Main ───

export async function startChatWidget(serverUrl: string, token: string) {
  const state = loadState();

  // Fetch user info
  try {
    const res = await fetch(`${serverUrl}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const user = await res.json() as any;
    state.username = user.username;
  } catch {}

  // Fetch groups
  try {
    const res = await fetch(`${serverUrl}/groups`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    state.groups = await res.json() as any;
  } catch {}

  // Connect WebSocket
  connectWs(serverUrl, token, state);

  // Initial render
  render(state);

  // Read stdin for commands
  process.stdin.setEncoding('utf-8');
  process.stdin.resume();
  process.stdin.on('data', (data) => {
    const cmd = data.toString().trim();
    if (cmd) handleCommand(cmd, serverUrl, token, state);
  });
}

// Run if executed directly
if (process.argv[1]?.endsWith('chat-widget.js')) {
  const serverUrl = process.env.AI_MESH_SERVER || 'http://localhost:3737';
  const token = process.env.AI_MESH_TOKEN;
  if (!token) {
    console.error('Set AI_MESH_TOKEN env var');
    process.exit(1);
  }
  startChatWidget(serverUrl, token);
}
