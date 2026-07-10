// MCP Widget: Terminal UI launcher
// When MCP starts, shows a widget banner
// Click/link → Opens TUI right in terminal (not browser)

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const SERVER_URL = process.env.AI_MESH_SERVER || 'http://localhost:3737';

// ─── Show Widget Banner ───
export function showWidgetBanner() {
  const banner = `
\x1b[1;36m╔═══════════════════════════════════════════════════════╗\x1b[0m
\x1b[1;36m║\x1b[0m  \x1b[1;33m💬 AI Mesh\x1b[0m — AI Agent Communication Platform        \x1b[1;36m║\x1b[0m
\x1b[1;36m╠═══════════════════════════════════════════════════════╣\x1b[0m
\x1b[1;36m║\x1b[0m                                                       \x1b[1;36m║\x1b[0m
\x1b[1;36m║\x1b[0m  \x1b[1mFor AI Agents:\x1b[0m Use MCP tools directly               \x1b[1;36m║\x1b[0m
\x1b[1;36m║\x1b[0m     → send_message, receive_messages, etc.            \x1b[1;36m║\x1b[0m
\x1b[1;36m║\x1b[0m                                                       \x1b[1;36m║\x1b[0m
\x1b[1;36m║\x1b[0m  \x1b[1mFor Humans:\x1b[0m Open TUI (Terminal UI)                  \x1b[1;36m║\x1b[0m
\x1b[1;36m║\x1b[0m     → Run: \x1b[4;34mai-mesh-ui\x1b[0m                              \x1b[1;36m║\x1b[0m
\x1b[1;36m║\x1b[0m     → Or:  \x1b[4;34mnode dist/tui/chat-widget.js\x1b[0m             \x1b[1;36m║\x1b[0m
\x1b[1;36m║\x1b[0m                                                       \x1b[1;36m║\x1b[0m
\x1b[1;36m║\x1b[0m  \x1b[90mTUI opens right in terminal — no browser needed\x1b[0m    \x1b[1;36m║\x1b[0m
\x1b[1;36m║\x1b[0m                                                       \x1b[1;36m║\x1b[0m
\x1b[1;36m╚═══════════════════════════════════════════════════════╝\x1b[0m
`;

  process.stderr.write(banner);
}

// ─── Open TUI in Terminal ───
export function openUI() {
  const tuiPath = resolve(process.cwd(), 'dist/tui/chat-widget.js');

  const child = spawn('node', [tuiPath], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env,
  });

  child.on('exit', (code: number) => {
    process.exit(code || 0);
  });
}

// ─── Show Message Notification ───
export function showMessageWithUILink(sender: string, message: string, groupName?: string) {
  const now = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  process.stderr.write(`
\x1b[1;36m┌─────────────────────────────────────────┐\x1b[0m
\x1b[1;36m│\x1b[0m \x1b[1;33m💬 New Message\x1b[0m                    \x1b[90m${now}\x1b[0m \x1b[1;36m│\x1b[0m
\x1b[1;36m├─────────────────────────────────────────┤\x1b[0m
\x1b[1;36m│\x1b[0m \x1b[35m${sender}\x1b[0m${groupName ? ` in \x1b[33m${groupName}\x1b[0m` : ''}
\x1b[1;36m│\x1b[0m  ${message.slice(0, 38)}
\x1b[1;36m├─────────────────────────────────────────┤\x1b[0m
\x1b[1;36m│\x1b[0m  \x1b[90mOpen TUI:\x1b[0m \x1b[1;34mai-mesh-ui\x1b[0m
\x1b[1;36m└─────────────────────────────────────────┘\x1b[0m
\x1b[0m`);
}
