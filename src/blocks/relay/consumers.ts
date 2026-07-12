// Relay: JetStream Durable Consumers (offline delivery)
//
// Fixes vs original:
//  - activeConsumers Map is synced from NATS on startup (was in-memory only,
//    so a restart "forgot" about every durable consumer that NATS still held).
//  - cleanupExpiredConsumers + removeUserConsumers are now actually scheduled
//    and called (were defined, exported, and never invoked).
//  - getPendingCount added — a true peek (no ack) for the MCP check_messages
//    tool, which previously ack'd+destroyed messages it only meant to count.

import { DeliverPolicy, AckPolicy, StringCodec } from 'nats';
import { getJetStreamManager, getJetStream } from './connection.js';
import type { RelayMessage } from '../../shared/types.js';

const sc = StringCodec();

// Track created consumers for cleanup. On startup we sync this from NATS so a
// restart doesn't "forget" durable consumers that are still held server-side.
const activeConsumers = new Map<string, { groupId: string; userId: string; createdAt: number }>();
const CONSUMER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function durableName(userId: string, groupId: string): string {
  return `mesh_${userId}_${groupId}`;
}

export async function ensureConsumer(groupId: string, userId: string): Promise<string> {
  const jsm = getJetStreamManager();
  const durable = durableName(userId, groupId);

  try {
    await jsm.consumers.add('MESH_MESSAGES', {
      durable_name: durable,
      filter_subject: `mesh.msg.${groupId}`,
      deliver_policy: DeliverPolicy.All,
      ack_policy: AckPolicy.Explicit,
      max_deliver: 3,
      ack_wait: 30_000_000_000,
    });
    activeConsumers.set(durable, { groupId, userId, createdAt: Date.now() });
  } catch {
    if (!activeConsumers.has(durable)) {
      activeConsumers.set(durable, { groupId, userId, createdAt: Date.now() });
    }
  }

  return durable;
}

// Sync the in-memory activeConsumers map from NATS on startup. Called once
// during relay connect. Without this, a restart would "forget" every durable
// consumer and cleanupExpiredConsumers would never find them.
export async function syncConsumersFromNats(): Promise<number> {
  try {
    const jsm = getJetStreamManager();
    const lister = await jsm.consumers.list('MESH_MESSAGES');
    let count = 0;
    // The nats Lister is async-iterable directly.
    for await (const info of lister) {
      const durable = info.name;
      // Durable name format: mesh_{userId}_{groupId}
      const m = durable.match(/^mesh_(.+)_(.+)$/);
      if (m) {
        const created = info.created ? new Date(info.created).getTime() : Date.now();
        activeConsumers.set(durable, { groupId: m[2], userId: m[1], createdAt: created });
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

export async function removeConsumer(groupId: string, userId: string): Promise<void> {
  const jsm = getJetStreamManager();
  const durable = durableName(userId, groupId);
  try {
    await jsm.consumers.delete('MESH_MESSAGES', durable);
  } catch { /* may not exist */ }
  activeConsumers.delete(durable);
}

export async function removeUserConsumers(userId: string): Promise<void> {
  const jsm = getJetStreamManager();
  for (const [durable, info] of activeConsumers) {
    if (info.userId === userId) {
      try { await jsm.consumers.delete('MESH_MESSAGES', durable); } catch { /* may not exist */ }
      activeConsumers.delete(durable);
    }
  }
}

export async function cleanupExpiredConsumers(): Promise<number> {
  const jsm = getJetStreamManager();
  const now = Date.now();
  let cleaned = 0;
  for (const [durable, info] of activeConsumers) {
    if (now - info.createdAt > CONSUMER_MAX_AGE_MS) {
      try { await jsm.consumers.delete('MESH_MESSAGES', durable); } catch { /* may not exist */ }
      activeConsumers.delete(durable);
      cleaned++;
    }
  }
  return cleaned;
}

// Schedule periodic cleanup. Idempotent + unref'd.
let cleanupScheduled = false;
export function scheduleConsumerCleanup(intervalMs = 6 * 3600_000) {
  if (cleanupScheduled) return;
  cleanupScheduled = true;
  const timer = setInterval(() => { cleanupExpiredConsumers().catch(() => {}); }, intervalMs);
  timer.unref();
  setTimeout(() => cleanupExpiredConsumers().catch(() => {}), 60_000).unref();
}

export function getConsumerStats(): { active: number; byGroup: Record<string, number> } {
  const byGroup: Record<string, number> = {};
  for (const [, info] of activeConsumers) {
    byGroup[info.groupId] = (byGroup[info.groupId] || 0) + 1;
  }
  return { active: activeConsumers.size, byGroup };
}

// ─── Peek: count pending without consuming ───
// Returns the number of undelivered messages for this user×group, without
// fetching or acking them. Used by MCP check_messages so it stops destroying
// messages it only meant to count.
export async function getPendingCount(userId: string, groupId: string): Promise<number> {
  try {
    const jetstream = getJetStream();
    const durable = durableName(userId, groupId);
    const consumer = await jetstream.consumers.get('MESH_MESSAGES', durable);
    const info = await consumer.info();
    return info.num_pending ?? 0;
  } catch {
    return 0;
  }
}

// ─── Fetch + ack (consume) ───
export async function getPendingMessages(userId: string, groupId: string): Promise<RelayMessage[]> {
  const jetstream = getJetStream();
  const durable = durableName(userId, groupId);
  const messages: RelayMessage[] = [];

  try {
    const consumer = await jetstream.consumers.get('MESH_MESSAGES', durable);
    const fetched = await consumer.fetch({ max_messages: 100, expires: 500 });

    for await (const msg of fetched) {
      try {
        messages.push(JSON.parse(sc.decode(msg.data)) as RelayMessage);
        msg.ack();
      } catch {
        msg.nak();
      }
    }
  } catch {
    // Consumer doesn't exist
  }

  return messages;
}

export async function getAllPendingMessages(userId: string, groupIds: string[]): Promise<RelayMessage[]> {
  const results = await Promise.allSettled(
    groupIds.map(gid => getPendingMessages(userId, gid))
  );
  const all: RelayMessage[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') all.push(...result.value);
  }
  all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return all;
}
