// Notification: Terminal Popup + Desktop Notification
//
// Both paths are now ASYNC (execFile, not execFileSync) — the previous sync call
// blocked the event loop on every message delivery, which under load froze the
// whole server for the duration of `notify-send` / `osascript` startup.
//
// Title/body are also sanitised for Pango markup on Linux (notify-send interprets
// it), and shell-escaped for osascript on macOS.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Escape Pango markup characters so a title like `<b>hi</b>` renders literally
// instead of as bold. Also strips any residual control characters.
function escapeForNotifySend(s: string): string {
  return s
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .slice(0, 200);
}

// For osascript we pass args via execFile's argv (no shell), so shell injection
// isn't the threat — but we still strip control chars and cap length.
function escapeForOsa(s: string): string {
  return s.replace(/[\x00-\x1F\x7F]/g, '').slice(0, 500);
}

// ─── Terminal Popup (ANSI-based, sync write to stderr is fine — it's a few KB) ───
export function showTerminalPopup(title: string, message: string, sender?: string) {
  const now = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const senderLine = sender ? `\x1b[35mFrom: ${sender}\x1b[0m` : '';

  const lines = [
    `\x1b[1;36m┌─────────────────────────────────────────┐\x1b[0m`,
    `\x1b[1;36m│\x1b[0m \x1b[1;33m💬 New Message\x1b[0m                    \x1b[90m${now}\x1b[0m \x1b[1;36m│\x1b[0m`,
    `\x1b[1;36m├─────────────────────────────────────────┤\x1b[0m`,
    `\x1b[1;36m│\x1b[0m \x1b[1m${title.slice(0, 38)}\x1b[0m`.padEnd(42) + `\x1b[1;36m│\x1b[0m`,
  ];

  if (senderLine) {
    lines.push(`\x1b[1;36m│\x1b[0m ${senderLine}`.padEnd(42) + `\x1b[1;36m│\x1b[0m`);
  }

  const maxLen = 38;
  const msgLines: string[] = [];
  const words = message.split(' ');
  let currentLine = '';
  for (const word of words) {
    if ((currentLine + ' ' + word).trim().length > maxLen) {
      if (currentLine) msgLines.push(currentLine.trim());
      currentLine = word;
    } else {
      currentLine = currentLine ? currentLine + ' ' + word : word;
    }
  }
  if (currentLine) msgLines.push(currentLine.trim());

  for (const line of msgLines.slice(0, 5)) {
    lines.push(`\x1b[1;36m│\x1b[0m  ${line}`.padEnd(42) + `\x1b[1;36m│\x1b[0m`);
  }
  if (msgLines.length > 5) {
    lines.push(`\x1b[1;36m│\x1b[0m  \x1b[90m... (${msgLines.length - 5} more lines)\x1b[0m`.padEnd(42) + `\x1b[1;36m│\x1b[0m`);
  }
  lines.push(`\x1b[1;36m└─────────────────────────────────────────┘\x1b[0m`);

  process.stderr.write('\n' + lines.join('\n') + '\n');
  process.stderr.write('\x07'); // terminal bell
}

// ─── Desktop Notification (async, cross-platform) ───
export function showDesktopNotification(title: string, body: string) {
  const safeTitle = title.replace(/[\x00-\x1F\x7F]/g, '').slice(0, 200);
  const safeBody = body.replace(/[\x00-\x1F\x7F]/g, '').slice(0, 500);

  // Fire and forget — never awaited by caller. Errors are swallowed because a
  // missing notification daemon must never crash the server.
  if (process.platform === 'linux') {
    execFileAsync('notify-send', [
      '--urgency=normal',
      '--app-name=AI Mesh',
      '--', // end of options — title/body are positional, not flags
      escapeForNotifySend(safeTitle),
      escapeForNotifySend(safeBody),
    ], { timeout: 5000 }).catch(() => {});
  } else if (process.platform === 'darwin') {
    // osascript: pass title and body as argv to avoid shell interpolation.
    execFileAsync('osascript', [
      '-e', 'on run argv',
      '-e', 'display notification (item 1 of argv) with title (item 2 of argv) sound name "default"',
      '-e', 'end run',
      '--', escapeForOsa(safeBody), escapeForOsa(safeTitle),
    ], { timeout: 5000 }).catch(() => {});
  }
  // Windows: intentionally no-op (no built-in toast CLI). Future: node-notifier.
}

// ─── Combined ───
export function notify(title: string, message: string, sender?: string) {
  showTerminalPopup(title, message, sender);
  showDesktopNotification(title, message);
}
