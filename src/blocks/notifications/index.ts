// Block: Notifications
// Per-user, SQLite-backed notification queue. Was a global in-memory array — any
// user could read or wipe anyone else's notifications. Now every row is scoped
// to a user_id, persists across restarts, and is shared across instances.

import { registerHealthCheck } from '../../core/health.js';
import { getDb } from '../../shared/db.js';
import { nanoid } from 'nanoid';
import { showTerminalPopup, showDesktopNotification } from './popup.js';

export { showTerminalPopup, showDesktopNotification };

export interface Notification {
  id?: string;
  user_id?: string; // set by queueNotification; not required on input
  type: string;
  title: string;
  body: string;
  group_id?: string;
  group_name?: string;
  sender?: string;
  sender_ai?: string;
  read?: number; // 0/1
  timestamp: string;
}

const MAX_PER_USER = 500;

// Queue a notification for a specific user (NOT a group — the caller resolves
// "who should see this" first). Returns the persisted id.
export function queueNotificationForUser(userId: string, notif: Omit<Notification, 'user_id' | 'id'>): string | null {
  try {
    const db = getDb();
    const id = nanoid();
    db.prepare(
      `INSERT INTO notifications (id, user_id, type, title, body, group_id, sender, sender_ai, read, created_at)
       VALUES (?,?,?,?,?,?,?, ?, 0, ?)`
    ).run(
      id, userId, notif.type, notif.title.slice(0, 500), notif.body.slice(0, 2000),
      notif.group_id ?? null, notif.sender ?? null, notif.sender_ai ?? null, notif.timestamp
    );

    // Trim old notifications for this user so the table doesn't grow unbounded.
    db.prepare(
      `DELETE FROM notifications WHERE user_id = ? AND id NOT IN (
        SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
      )`
    ).run(userId, userId, MAX_PER_USER);

    return id;
  } catch {
    return null;
  }
}

// Queue a notification for every member of a group (except the sender).
// Used by the message-routing path to surface a new message to offline members.
export function queueNotification(groupId: string, notif: Omit<Notification, 'user_id' | 'id'>) {
  try {
    const db = getDb();
    const members = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(groupId) as { user_id: string }[];
    for (const m of members) {
      if (m.user_id === notif.sender) continue;
      queueNotificationForUser(m.user_id, notif);
    }
  } catch { /* db may not be ready */ }
}

export function getNotifications(userId: string, limit = 20): Notification[] {
  try {
    const db = getDb();
    return db.prepare(
      'SELECT id, type, title, body, group_id, sender, sender_ai, read, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?'
    ).all(userId, limit) as Notification[];
  } catch {
    return [];
  }
}

export function getUnreadNotifications(userId: string, limit = 20): Notification[] {
  try {
    const db = getDb();
    return db.prepare(
      'SELECT id, type, title, body, group_id, sender, sender_ai, created_at FROM notifications WHERE user_id = ? AND read = 0 ORDER BY created_at DESC LIMIT ?'
    ).all(userId, limit) as Notification[];
  } catch {
    return [];
  }
}

export function markAllRead(userId: string): number {
  try {
    const db = getDb();
    const info = db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').run(userId);
    return info.changes;
  } catch {
    return 0;
  }
}

export function clearNotifications(userId: string) {
  try {
    getDb().prepare('DELETE FROM notifications WHERE user_id = ?').run(userId);
  } catch { /* db may not be ready */ }
}

export function getUnreadCount(userId: string): number {
  try {
    const row = getDb().prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND read = 0').get(userId) as { c: number };
    return row.c;
  } catch {
    return 0;
  }
}

// Periodic cleanup of ancient read notifications across all users (keeps table
// size bounded over years of operation). unref'd.
const RETENTION_DAYS = 30;
const cleanupTimer = setInterval(() => {
  try {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString();
    getDb().prepare('DELETE FROM notifications WHERE read = 1 AND created_at < ?').run(cutoff);
  } catch { /* db may not be ready */ }
}, 3600_000);
cleanupTimer.unref();

// ─── Desktop / terminal popup ───
// showTerminalPopup and showDesktopNotification are imported from popup.ts.
// The popup layer is async + best-effort — it never blocks request handling.

export function pushPopupNotification(notif: Notification) {
  // Fire and forget — popup.ts uses async execFile so this never blocks the
  // event loop. Called by the messages block ONLY for offline users (see
  // messages/index.ts) so we don't spam a popup on every message.
  showTerminalPopup(notif.title, notif.body, notif.sender);
  showDesktopNotification(notif.title, notif.body);
}

export function registerNotificationHealth() {
  registerHealthCheck('notifications', async () => {
    try {
      const row = getDb().prepare('SELECT COUNT(*) as c FROM notifications').get() as { c: number };
      return { status: 'healthy' as const, message: `${row.c} notifications stored`, lastCheck: '' };
    } catch {
      return { status: 'unhealthy' as const, message: 'DB unavailable', lastCheck: '' };
    }
  });
}
