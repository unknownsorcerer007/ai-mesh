// Block: Notifications
// Desktop notifications, terminal popups, webhook callbacks
// Independent — no dependencies on other blocks

import { execFileSync } from 'node:child_process';
import { registerHealthCheck } from '../../core/health.js';
import { showTerminalPopup, showDesktopNotification } from './popup.js';

export { showTerminalPopup, showDesktopNotification };

export interface Notification {
  type: string;
  title: string;
  body: string;
  group_name?: string;
  sender?: string;
  timestamp: string;
}

// ─── Notification Queue (for MCP agent) ───
const notificationQueue: Notification[] = [];
const MAX_QUEUE_SIZE = 100;

export function pushNotification(notif: Notification) {
  notificationQueue.push(notif);
  if (notificationQueue.length > MAX_QUEUE_SIZE) {
    notificationQueue.shift(); // Remove oldest
  }

  // Show terminal popup
  showTerminalPopup(notif.title, notif.body, notif.sender);

  // Show desktop notification
  showDesktopNotification(notif.title, notif.body);
}

export function getNotifications(limit: number = 20): Notification[] {
  return notificationQueue.slice(-limit);
}

export function clearNotifications() {
  notificationQueue.length = 0;
}

export function getUnreadCount(): number {
  return notificationQueue.length;
}

// ─── Webhook Notification ───
export async function sendWebhookNotification(webhookUrl: string, notif: Notification) {
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `🤖 **${notif.title}**\n${notif.body}`, username: 'AI Mesh' }),
    });
  } catch { /* webhook failed */ }
}

export function registerNotificationHealth() {
  registerHealthCheck('notifications', async () => ({
    status: 'healthy',
    message: `${notificationQueue.length} notifications queued`,
    lastCheck: '',
  }));
}
