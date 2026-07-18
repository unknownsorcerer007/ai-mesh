// Sidebar Daemon — Persistent Background Notification Process
//
// Runs as a background process alongside the AI agent. Maintains a WebSocket
// connection to the AI Mesh server and shows notification badges in the terminal
// when new messages arrive. User can run `ai-mesh sidebar` to start it.
//
// Flow:
//   1. Start → connect to server via WS
//   2. Authenticate with token
//   3. Poll notifications every 15s
//   4. On new message → show terminal badge (ANSI)
//   5. User types `open` → launch TUI
//   6. Graceful shutdown on SIGINT/SIGTERM
//
// The daemon writes its PID to ~/.ai-mesh/sidebar.pid so only one instance
// runs at a time. It also writes a small state file for the launcher to read.

import WebSocket from 'ws';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

// ─── Types ───
interface DaemonState {
  connected: boolean;
  username: string | null;
  unreadCount: number;
  lastNotifId: string | null;
  groups: Array<{ id: string; name: string }>;
  pid: number;
  startedAt: string;
}

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  group_id?: string;
  sender?: string;
  sender_ai?: string;
  read: number;
  created_at: string;
}

// ─── Config ───
const SERVER_URL = process.env.AI_MESH_SERVER || 'http://localhost:3737';
const TOKEN = process.env.AI_MESH_TOKEN || '';
const POLL_INTERVAL_MS = 15_000;
const STATE_DIR = resolve(process.env.HOME || '~', '.ai-mesh');
const PID_FILE = resolve(STATE_DIR, 'sidebar.pid');
const STATE_FILE = resolve(STATE_DIR, 'sidebar-state.json');
const TUI_PATH = resolve(process.cwd(), 'dist/tui/chat-widget.js');

// ─── ANSI Colors ───
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
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgCyan: '\x1b[46m',
};

// ─── State ───
let state: DaemonState = {
  connected: false,
  username: null,
  unreadCount: 0,
  lastNotifId: null,
  groups: [],
  pid: process.pid,
  startedAt: new Date().toISOString(),
};
let ws: WebSocket | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30_000;

// ─── Helpers ───
function ensureDir() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

function saveState() {
  try {
    ensureDir();
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch { /* non-critical */ }
}

function savePid() {
  try {
    ensureDir();
    writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 });
  } catch { /* non-critical */ }
}

function cleanupPid() {
  try { if (existsSync(PID_FILE)) unlinkSync(PID_FILE); } catch {}
}

function isAlreadyRunning(): boolean {
  if (!existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    // Check if process is still alive
    process.kill(pid, 0);
    return true;
  } catch {
    // Process not running or PID file stale
    return false;
  }
}

// ─── Terminal Badge Rendering ───
function renderBadge() {
  const now = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const status = state.connected
    ? `${C.green}●${C.reset}`
    : `${C.red}●${C.reset}`;
  const user = state.username ? `@${state.username}` : '...';
  const unread = state.unreadCount > 0
    ? ` ${C.bgRed}${C.white}${C.bold} ${state.unreadCount} new ${C.reset}`
    : '';

  // Clear current line and write badge
  process.stderr.write('\r\x1b[K');
  process.stderr.write(
    `${C.cyan}┌${'─'.repeat(44)}┐${C.reset}\n` +
    `${C.cyan}│${C.reset} ${status} ${C.bold}AI Mesh${C.reset} ${C.dim}│${C.reset} ${user}${unread}  ${C.dim}${now}${C.reset} ${C.cyan}│${C.reset}\n` +
    `${C.cyan}└${'─'.repeat(44)}┘${C.reset}\n`
  );
}

function renderNotification(notif: Notification) {
  const now = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const sender = notif.sender_ai
    ? `${C.magenta}${notif.sender_ai}${C.reset}`
    : `${C.blue}${notif.sender || 'Unknown'}${C.reset}`;
  const body = notif.body.length > 50 ? notif.body.slice(0, 50) + '...' : notif.body;

  process.stderr.write('\n');
  process.stderr.write(`${C.cyan}┌─────────────────────────────────────────────┐${C.reset}\n`);
  process.stderr.write(`${C.cyan}│${C.reset} ${C.yellow}💬 New Message${C.reset}                       ${C.dim}${now}${C.reset} ${C.cyan}│${C.reset}\n`);
  process.stderr.write(`${C.cyan}├─────────────────────────────────────────────┤${C.reset}\n`);
  process.stderr.write(`${C.cyan}│${C.reset} ${sender}: ${body}${C.reset}\n`);
  process.stderr.write(`${C.cyan}│${C.reset} ${C.dim}Type 'open' to view | 'dismiss' to clear${C.reset} ${C.cyan}│${C.reset}\n`);
  process.stderr.write(`${C.cyan}└─────────────────────────────────────────────┘${C.reset}\n`);
  process.stderr.write('\x07'); // Terminal bell
}

// ─── API Helpers ───
async function api(path: string, options: RequestInit = {}): Promise<any> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || body.message || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─── Fetch Notifications ───
async function fetchNotifications(): Promise<void> {
  try {
    const data = await api('/notifications?unread=1&limit=20');
    const unread = data.unread || 0;

    if (unread > state.unreadCount && data.notifications?.length > 0) {
      // New notifications since last check
      const newNotifs = data.notifications.filter(
        (n: Notification) => !state.lastNotifId || n.id > state.lastNotifId!
      );
      for (const notif of newNotifs) {
        renderNotification(notif);
      }
      if (newNotifs.length > 0) {
        state.lastNotifId = newNotifs[0].id;
      }
    }

    state.unreadCount = unread;
    saveState();
    renderBadge();
  } catch (err) {
    // Server might be down — don't crash, just retry next interval
  }
}

// ─── Fetch Groups ───
async function fetchGroups(): Promise<void> {
  try {
    const groups = await api('/groups');
    state.groups = groups.map((g: any) => ({ id: g.id, name: g.name }));
    saveState();
  } catch { /* non-critical */ }
}

// ─── WebSocket Connection ───
function connectWs() {
  if (!TOKEN) return;

  const wsUrl = SERVER_URL.replace(/^http/, 'ws') + '/ws';
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    ws!.send(JSON.stringify({ type: 'auth', token: TOKEN }));
    reconnectAttempts = 0;
  });

  ws.on('message', (data) => {
    try {
      const event = JSON.parse(data.toString());

      if (event.type === 'authenticated') {
        state.connected = true;
        saveState();
        renderBadge();
      }

      if (event.type === 'message' && event.payload) {
        state.unreadCount++;
        saveState();
        renderBadge();

        // Show notification popup
        const msg = event.payload;
        renderNotification({
          id: msg.id || 'ws',
          type: 'message',
          title: msg.sender_ai || msg.sender_username || 'Agent',
          body: msg.content || '',
          group_id: msg.group_id,
          sender: msg.sender_username,
          sender_ai: msg.sender_ai,
          read: 0,
          created_at: msg.timestamp || new Date().toISOString(),
        });
      }

      if (event.type === 'join_request') {
        state.unreadCount++;
        saveState();
        renderBadge();
        renderNotification({
          id: 'join-' + Date.now(),
          type: 'join_request',
          title: 'Join Request',
          body: `${event.payload?.username || 'Someone'} wants to join ${event.payload?.group_name || 'a group'}`,
          read: 0,
          created_at: new Date().toISOString(),
        });
      }
    } catch {}
  });

  ws.on('close', () => {
    state.connected = false;
    saveState();
    renderBadge();
    scheduleReconnect();
  });

  ws.on('error', () => {
    state.connected = false;
    saveState();
    renderBadge();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => connectWs(), delay);
}

// ─── Launch TUI ───
function launchTui() {
  const child = spawn('node', [TUI_PATH], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: { ...process.env, AI_MESH_TOKEN: TOKEN },
  });

  child.on('exit', () => {
    // After TUI exits, re-render badge
    renderBadge();
  });
}

// ─── Mark Notifications Read ───
async function markAllRead(): Promise<void> {
  try {
    await api('/notifications/read', { method: 'POST' });
    state.unreadCount = 0;
    saveState();
    renderBadge();
  } catch { /* non-critical */ }
}

// ─── Main ───
async function main() {
  // Check for existing instance
  if (isAlreadyRunning()) {
    console.error(`${C.yellow}Sidebar daemon already running (PID in ${PID_FILE})${C.reset}`);
    console.error(`${C.dim}Kill it first: kill $(cat ${PID_FILE})${C.reset}`);
    process.exit(1);
  }

  if (!TOKEN) {
    console.error(`${C.red}No token found.${C.reset}`);
    console.error(`${C.dim}Set AI_MESH_TOKEN environment variable.${C.reset}`);
    console.error(`${C.dim}Get token from: ${SERVER_URL} (login with GitHub)${C.reset}`);
    process.exit(1);
  }

  // Save PID
  savePid();

  // Fetch initial data
  try {
    const user = await api('/auth/me');
    state.username = user.username;
  } catch (err: any) {
    const msg = err?.message || '';
    if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED')) {
      console.error(`${C.red}Server unreachable at ${SERVER_URL}${C.reset}`);
      console.error(`${C.dim}Start server first: cd ai-mesh && ./start.sh${C.reset}`);
    } else {
      console.error(`${C.red}Invalid token: ${msg}${C.reset}`);
    }
    cleanupPid();
    process.exit(1);
  }

  await fetchGroups();
  await fetchNotifications();
  saveState();

  // Show initial badge
  console.clear();
  console.log(`${C.cyan}${C.bold}AI Mesh Sidebar Daemon${C.reset} ${C.dim}— running in background${C.reset}`);
  console.log(`${C.dim}PID: ${process.pid} | Server: ${SERVER_URL}${C.reset}`);
  console.log(`${C.dim}Commands: open | dismiss | status | quit${C.reset}\n`);
  renderBadge();

  // Connect WebSocket (real-time notifications)
  connectWs();

  // Poll notifications every 15s (backup for WS gaps)
  pollTimer = setInterval(fetchNotifications, POLL_INTERVAL_MS);

  // Interactive commands
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.cyan}sidebar❯ ${C.reset}`,
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const cmd = line.trim().toLowerCase();

    switch (cmd) {
      case 'open':
      case 'o':
        launchTui();
        break;

      case 'dismiss':
      case 'd':
        await markAllRead();
        console.log(`${C.green}Notifications cleared${C.reset}`);
        break;

      case 'status':
      case 's':
        console.log(`
${C.bold}Status:${C.reset}
  Server: ${SERVER_URL}
  Connected: ${state.connected ? `${C.green}Yes${C.reset}` : `${C.red}No${C.reset}`}
  User: ${state.username || 'Unknown'}
  Unread: ${state.unreadCount}
  Groups: ${state.groups.map(g => g.name).join(', ') || 'None'}
  PID: ${process.pid}
        `);
        break;

      case 'quit':
      case 'q':
        shutdown('manual');
        break;

      default:
        if (cmd) {
          console.log(`${C.dim}Commands: open | dismiss | status | quit${C.reset}`);
        }
    }
    rl.prompt();
  });

  rl.on('close', () => shutdown('stdin closed'));
}

// ─── Graceful Shutdown ───
function shutdown(reason: string) {
  console.log(`\n${C.dim}Shutting down sidebar (${reason})...${C.reset}`);
  if (pollTimer) clearInterval(pollTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) try { ws.close(); } catch {}
  cleanupPid();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error(`${C.red}Fatal: ${err.message}${C.reset}`);
  cleanupPid();
  process.exit(1);
});
