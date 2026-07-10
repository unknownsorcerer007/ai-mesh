// Notification: Terminal Popup
// Jab message aaye, terminal mein popup dikhta hai
// Koi web kholne ki zaroorat nahi

import { execFileSync } from 'node:child_process';

// ─── Terminal Popup (ANSI-based) ───
export function showTerminalPopup(title: string, message: string, sender?: string) {
  const now = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const senderLine = sender ? `\x1b[35mFrom: ${sender}\x1b[0m` : '';

  // Box drawing characters for pretty popup
  const lines = [
    `\x1b[1;36m┌─────────────────────────────────────────┐\x1b[0m`,
    `\x1b[1;36m│\x1b[0m \x1b[1;33m💬 New Message\x1b[0m                    \x1b[90m${now}\x1b[0m \x1b[1;36m│\x1b[0m`,
    `\x1b[1;36m├─────────────────────────────────────────┤\x1b[0m`,
    `\x1b[1;36m│\x1b[0m \x1b[1m${title}\x1b[0m`.padEnd(42) + `\x1b[1;36m│\x1b[0m`,
  ];

  if (senderLine) {
    lines.push(`\x1b[1;36m│\x1b[0m ${senderLine}`.padEnd(42) + `\x1b[1;36m│\x1b[0m`);
  }

  // Wrap long messages
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

  for (const line of msgLines.slice(0, 5)) { // Max 5 lines
    lines.push(`\x1b[1;36m│\x1b[0m  ${line}`.padEnd(42) + `\x1b[1;36m│\x1b[0m`);
  }

  if (msgLines.length > 5) {
    lines.push(`\x1b[1;36m│\x1b[0m  \x1b[90m... (${msgLines.length - 5} more lines)\x1b[0m`.padEnd(42) + `\x1b[1;36m│\x1b[0m`);
  }

  lines.push(`\x1b[1;36m└─────────────────────────────────────────┘\x1b[0m`);

  // Write to stderr (doesn't interfere with stdout)
  process.stderr.write('\n' + lines.join('\n') + '\n');

  // Terminal bell for attention
  process.stderr.write('\x07');
}

// ─── Desktop Notification (cross-platform) ───
export function showDesktopNotification(title: string, body: string) {
  try {
    const safeTitle = title.replace(/[\x00-\x1F\x7F]/g, '').slice(0, 200);
    const safeBody = body.replace(/[\x00-\x1F\x7F]/g, '').slice(0, 500);

    if (process.platform === 'linux') {
      execFileSync('notify-send', [
        '--urgency=normal',
        '--app-name=AI Mesh',
        safeTitle,
        safeBody,
      ], { timeout: 5000 });
    } else if (process.platform === 'darwin') {
      execFileSync('osascript', [
        '-e', 'on run argv',
        '-e', 'display notification (item 1 of argv) with title (item 2 of argv) sound name "default"',
        '-e', 'end run',
        '--', safeBody, safeTitle,
      ], { timeout: 5000 });
    }
  } catch {
    // Notification system not available
  }
}

// ─── Combined Notification ───
export function notify(title: string, message: string, sender?: string) {
  // Terminal popup (always)
  showTerminalPopup(title, message, sender);

  // Desktop notification (if available)
  showDesktopNotification(title, message);
}
