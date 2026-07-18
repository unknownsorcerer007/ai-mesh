// Agent Webhook Notification
//
// When a message arrives for an offline user who has registered an agent webhook
// URL, we POST a notification to that URL. The agent's local MCP server receives
// the POST and can wake up to process the message.
//
// Flow:
//   1. Agent starts → calls register_agent_webhook MCP tool
//   2. Tool stores webhook URL in agent_webhooks table (keyed by user_id)
//   3. Message arrives → user is offline → deliverToGroupMembers fires
//   4. We check agent_webhooks for that user_id
//   5. POST notification to the registered URL
//   6. Agent's local server receives POST → calls receive_messages() → done
//
// The webhook payload is lightweight (just metadata), so the agent knows WHICH
// group has new messages without fetching everything.

import { getDb } from '../../shared/db.js';
import { checkRateLimit } from '../security/rate-limit.js';

// ─── Webhook Registration ───

export interface AgentWebhook {
  id: string;
  user_id: string;
  webhook_url: string;
  groups: string | null; // JSON array of group_ids, null = all groups
  active: number; // 0 or 1
  created_at: string;
  last_notified_at: string | null;
  fail_count: number;
}

export interface WebhookPayload {
  type: 'new_message';
  group_id: string;
  group_name: string;
  sender: string;
  sender_ai?: string;
  message_preview: string;
  message_id: string;
  timestamp: string;
  total_pending: number;
}

// Register a webhook URL for an agent
export function registerAgentWebhook(
  userId: string,
  webhookUrl: string,
  groupIds?: string[]
): { ok: boolean; id?: string; error?: string } {
  const db = getDb();

  // Validate URL
  try {
    const url = new URL(webhookUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { ok: false, error: 'URL must use http or https' };
    }
    // Block non-localhost in production (security: don't let agents point webhooks at random servers)
    // In dev, allow any URL for testing
    if (process.env.NODE_ENV === 'production' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      return { ok: false, error: 'In production, webhook URL must be localhost' };
    }
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }

  // Rate limit: max 5 registrations per hour
  const rl = checkRateLimit(`agent-wh:${userId}`, 3600_000, 5);
  if (!rl.allowed) return { ok: false, error: 'Too many registrations. Try later.' };

  const { nanoid } = require('nanoid');
  const id = nanoid();
  const groupsJson = groupIds ? JSON.stringify(groupIds) : null;

  // Upsert: one webhook per user
  db.prepare(
    `INSERT INTO agent_webhooks (id, user_id, webhook_url, groups, active, created_at, fail_count)
     VALUES (?, ?, ?, ?, 1, datetime('now'), 0)
     ON CONFLICT(user_id) DO UPDATE SET webhook_url = ?, groups = ?, active = 1, fail_count = 0, last_notified_at = NULL`
  ).run(id, userId, webhookUrl, groupsJson, webhookUrl, groupsJson);

  return { ok: true, id };
}

// Unregister (deactivate) webhook
export function unregisterAgentWebhook(userId: string): boolean {
  const db = getDb();
  const info = db.prepare('UPDATE agent_webhooks SET active = 0 WHERE user_id = ?').run(userId);
  return info.changes > 0;
}

// Get active webhook for a user
export function getAgentWebhook(userId: string): AgentWebhook | null {
  const db = getDb();
  return db.prepare('SELECT * FROM agent_webhooks WHERE user_id = ? AND active = 1').get(userId) as AgentWebhook | null;
}

// ─── Notification Dispatch ───

// Track recent notifications to avoid spamming the same webhook
// Key: userId:groupId, Value: last notification timestamp
const recentNotifications = new Map<string, number>();
const NOTIFICATION_COOLDOWN_MS = 5_000; // Don't notify same user+group more than once per 5s

/**
 * Notify an agent's webhook that new messages have arrived.
 * Called from messages block when an offline user receives a message.
 *
 * Fire-and-forget: we don't await the response. If it fails, we increment
 * fail_count and deactivate after 10 consecutive failures.
 */
export function notifyAgentWebhook(
  userId: string,
  payload: WebhookPayload
): void {
  const webhook = getAgentWebhook(userId);
  if (!webhook) return;

  // Cooldown check: don't spam
  const cooldownKey = `${userId}:${payload.group_id}`;
  const lastNotified = recentNotifications.get(cooldownKey) || 0;
  if (Date.now() - lastNotified < NOTIFICATION_COOLDOWN_MS) return;

  // Check if this group is in the webhook's filter
  if (webhook.groups) {
    try {
      const allowedGroups = JSON.parse(webhook.groups) as string[];
      if (!allowedGroups.includes(payload.group_id)) return;
    } catch { /* malformed groups JSON — notify all */ }
  }

  recentNotifications.set(cooldownKey, Date.now());

  // Fire-and-forget POST
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  fetch(webhook.webhook_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: controller.signal,
  })
    .then((res) => {
      clearTimeout(timeout);
      if (res.ok) {
        // Reset fail count on success
        const db = getDb();
        db.prepare('UPDATE agent_webhooks SET fail_count = 0, last_notified_at = datetime(\'now\') WHERE user_id = ?').run(userId);
      } else {
        handleWebhookFailure(userId, `HTTP ${res.status}`);
      }
    })
    .catch((err) => {
      clearTimeout(timeout);
      handleWebhookFailure(userId, err.message || 'fetch failed');
    });
}

function handleWebhookFailure(userId: string, reason: string): void {
  const db = getDb();
  const webhook = db.prepare('SELECT fail_count FROM agent_webhooks WHERE user_id = ?').get(userId) as { fail_count: number } | undefined;
  if (!webhook) return;

  const newCount = webhook.fail_count + 1;

  if (newCount >= 10) {
    // Too many failures — deactivate
    db.prepare('UPDATE agent_webhooks SET active = 0, fail_count = ? WHERE user_id = ?').run(newCount, userId);
    console.warn(`[agent-webhook] Deactivated webhook for user ${userId} after ${newCount} failures: ${reason}`);
  } else {
    db.prepare('UPDATE agent_webhooks SET fail_count = ? WHERE user_id = ?').run(newCount, userId);
  }
}

// Cleanup stale cooldown entries every 5 minutes
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of recentNotifications) {
    if (now - ts > 300_000) recentNotifications.delete(key);
  }
}, 300_000);
cleanupTimer.unref();
