// Relay: JetStream Durable Consumers (offline delivery)

import { DeliverPolicy, AckPolicy, StringCodec } from 'nats';
import { getJetStreamManager } from './connection.js';
import type { RelayMessage } from '../../shared/types.js';

const sc = StringCodec();

// Track created consumers for cleanup
const activeConsumers = new Map<string, { groupId: string; userId: string; createdAt: number }>();
const CONSUMER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function ensureConsumer(groupId: string, userId: string): Promise<string> {
  const jsm = getJetStreamManager();
  const durable = `mesh_${userId}_${groupId}`;

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
    // Already exists — track it
    if (!activeConsumers.has(durable)) {
      activeConsumers.set(durable, { groupId, userId, createdAt: Date.now() });
    }
  }

  return durable;
}

// Fix: Clean up consumer when user leaves group
export async function removeConsumer(groupId: string, userId: string): Promise<void> {
  const jsm = getJetStreamManager();
  const durable = `mesh_${userId}_${groupId}`;

  try {
    await jsm.consumers.delete('MESH_MESSAGES', durable);
    activeConsumers.delete(durable);
  } catch {
    // Consumer may not exist
  }
}

// Fix: Clean up all consumers for a user
export async function removeUserConsumers(userId: string): Promise<void> {
  const jsm = getJetStreamManager();

  for (const [durable, info] of activeConsumers) {
    if (info.userId === userId) {
      try {
        await jsm.consumers.delete('MESH_MESSAGES', durable);
      } catch { /* may not exist */ }
      activeConsumers.delete(durable);
    }
  }
}

// Fix: Clean up expired consumers (run periodically)
export async function cleanupExpiredConsumers(): Promise<number> {
  const jsm = getJetStreamManager();
  const now = Date.now();
  let cleaned = 0;

  for (const [durable, info] of activeConsumers) {
    if (now - info.createdAt > CONSUMER_MAX_AGE_MS) {
      try {
        await jsm.consumers.delete('MESH_MESSAGES', durable);
        activeConsumers.delete(durable);
        cleaned++;
      } catch { /* may not exist */ }
    }
  }

  return cleaned;
}

// Fix: Get consumer stats
export function getConsumerStats(): { active: number; byGroup: Record<string, number> } {
  const byGroup: Record<string, number> = {};
  for (const [, info] of activeConsumers) {
    byGroup[info.groupId] = (byGroup[info.groupId] || 0) + 1;
  }
  return { active: activeConsumers.size, byGroup };
}

export async function getPendingMessages(userId: string, groupId: string): Promise<RelayMessage[]> {
  const { getJetStream } = await import('./connection.js');
  const jetstream = getJetStream();
  const durable = `mesh_${userId}_${groupId}`;
  const messages: RelayMessage[] = [];

  try {
    const consumer = await jetstream.consumers.get('MESH_MESSAGES', durable);
    // Use short timeout for fast response
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
  // Fix: Parallel fetch instead of sequential
  const results = await Promise.allSettled(
    groupIds.map(gid => getPendingMessages(userId, gid))
  );

  const all: RelayMessage[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      all.push(...result.value);
    }
  }

  all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return all;
}
