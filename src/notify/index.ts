// AI Mesh — Notification System
// Supports: terminal bell, desktop notifications, webhook callbacks

import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export interface Notification {
  id: string;
  type: 'message' | 'join_request' | 'member_joined' | 'member_left' | 'system';
  title: string;
  body: string;
  group_id?: string;
  group_name?: string;
  sender?: string;
  timestamp: string;
  read: boolean;
}

// ─── In-memory notification store ───
const notifications: Notification[] = [];
const MAX_NOTIFICATIONS = 100;

export function addNotification(notif: Omit<Notification, 'id' | 'read' | 'timestamp'>) {
  const entry: Notification = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ...notif,
    timestamp: new Date().toISOString(),
    read: false,
  };

  notifications.unshift(entry);
  if (notifications.length > MAX_NOTIFICATIONS) notifications.pop();

  // Terminal bell
  process.stdout.write('\x07');

  // Log to file
  logNotification(entry);

  return entry;
}

export function getNotifications(unreadOnly: boolean = false): Notification[] {
  if (unreadOnly) return notifications.filter(n => !n.read);
  return notifications;
}

export function markRead(id: string): boolean {
  const notif = notifications.find(n => n.id === id);
  if (notif) { notif.read = true; return true; }
  return false;
}

export function markAllRead() {
  for (const n of notifications) n.read = true;
}

export function getUnreadCount(): number {
  return notifications.filter(n => !n.read).length;
}

// ─── Notification Log File ───

const LOG_DIR = resolve(process.env.HOME || '~', '.ai-mesh', 'notifications');

function logNotification(notif: Notification) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const month = notif.timestamp.slice(0, 7); // YYYY-MM
    const logFile = resolve(LOG_DIR, `${month}.log`);
    const line = `[${notif.timestamp}] ${notif.type}: ${notif.title} — ${notif.body}${notif.group_name ? ` [${notif.group_name}]` : ''}\n`;
    appendFileSync(logFile, line);
  } catch {}
}

// ─── Desktop Notification (cross-platform) ───

export function sendDesktopNotification(title: string, body: string) {
  try {
    // Linux
    if (process.platform === 'linux') {
      const { execSync } = require('child_process');
      execSync(`notify-send "${title}" "${body}" 2>/dev/null || true`);
    }
    // macOS
    else if (process.platform === 'darwin') {
      const { execSync } = require('child_process');
      execSync(`osascript -e 'display notification "${body}" with title "${title}"' 2>/dev/null || true`);
    }
    // Windows
    else if (process.platform === 'win32') {
      const { execSync } = require('child_process');
      execSync(`powershell -Command "New-BurntToastNotification -Text '${title}','${body}'" 2>/dev/null || true`);
    }
  } catch {}
}

// ─── Webhook Notification ───

export async function sendWebhookNotification(webhookUrl: string, notif: Notification) {
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `🤖 **${notif.title}**\n${notif.body}`,
        username: 'AI Mesh',
        icon_emoji: ':robot_face:',
      }),
    });
  } catch {}
}
