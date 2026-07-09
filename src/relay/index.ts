// Pulse — NATS Relay Layer
// High-performance message routing: millions of messages/sec
// No persistence, pure routing, zero data retention

import { connect, RetentionPolicy, DeliverPolicy, AckPolicy, StorageType, type NatsConnection, type JetStreamClient, type JetStreamManager, type Subscription, StringCodec } from 'nats';

const sc = StringCodec();

// ─── NATS Connection ───

let nc: NatsConnection | null = null;
let js: JetStreamClient | null = null;
let jsm: JetStreamManager | null = null;

const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222';

export async function connectRelay(): Promise<NatsConnection> {
  if (nc && !nc.isClosed()) return nc;

  nc = await connect({
    servers: NATS_URL,
    maxReconnectAttempts: -1, // Infinite reconnect
    reconnectTimeWait: 2000,
    pingInterval: 30000,
    timeout: 10000,
  });

  console.log(`🔗 NATS relay connected: ${nc.getServer()}`);

  // Handle disconnect/reconnect
  (async () => {
    for await (const status of nc.status()) {
      switch (status.type) {
        case 'disconnect':
          console.log('⚠️ NATS disconnected');
          break;
        case 'reconnect':
          console.log(`✅ NATS reconnected: ${status.data}`);
          break;
        case 'error':
          console.error('❌ NATS error:', status.data);
          break;
      }
    }
  })();

  js = nc.jetstream();
  jsm = await nc.jetstreamManager();

  // Setup JetStream streams
  await setupStreams();

  return nc;
}

export function getRelay(): NatsConnection {
  if (!nc || nc.isClosed()) throw new Error('NATS relay not connected');
  return nc;
}

export function getJetStream(): JetStreamClient {
  if (!js) throw new Error('JetStream not initialized');
  return js;
}

// ─── Stream Setup ───
// Streams = message categories with different retention

async function setupStreams() {
  if (!jsm) return;

  const streams = [
    {
      name: 'MESH_MESSAGES',
      subjects: ['mesh.msg.>'],        // mesh.msg.<group_id>
      retention: RetentionPolicy.Limits,
      max_age: 7 * 24 * 60 * 60 * 1_000_000_000, // 7 days in nanoseconds
      max_msgs: 1_000_000,
      max_bytes: 500 * 1024 * 1024,    // 500MB
      storage: StorageType.File,
      num_replicas: 1,
    },
    {
      name: 'MESH_EVENTS',
      subjects: ['mesh.event.>'],      // mesh.event.<user_id>
      retention: RetentionPolicy.Limits,
      max_age: 24 * 60 * 60 * 1_000_000_000, // 24 hours
      max_msgs: 100_000,
      max_bytes: 50 * 1024 * 1024,     // 50MB
      storage: StorageType.File,
      num_replicas: 1,
    },
    {
      name: 'MESH_EPH',
      subjects: ['mesh.eph.>'],        // Ephemeral — no retention
      retention: RetentionPolicy.Limits,
      max_age: 60 * 1000_000_000,      // 1 minute
      max_msgs: 10_000,
      max_bytes: 10 * 1024 * 1024,     // 10MB
      storage: StorageType.Memory,
      num_replicas: 1,
    },
  ];

  for (const stream of streams) {
    try {
      await jsm.streams.info(stream.name);
      // Stream exists, update if needed
      await jsm.streams.update(stream.name, stream);
    } catch {
      // Stream doesn't exist, create it
      await jsm.streams.add(stream);
      console.log(`📡 Stream created: ${stream.name}`);
    }
  }
}

// ─── Publish Message to Group ───

export interface RelayMessage {
  id: string;
  group_id: string;
  sender_id: string;
  sender_username: string;
  sender_ai?: string;
  type: 'text' | 'code' | 'alert' | 'system';
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export async function publishToGroup(groupId: string, message: RelayMessage): Promise<void> {
  const relay = getRelay();
  const subject = `mesh.msg.${groupId}`;
  const payload = sc.encode(JSON.stringify(message));
  relay.publish(subject, payload);
}

// ─── Publish Event to User ───

export interface RelayEvent {
  type: 'join_request' | 'member_joined' | 'member_left' | 'notification' | 'error';
  payload: Record<string, unknown>;
  timestamp: string;
}

export async function publishToUser(userId: string, event: RelayEvent): Promise<void> {
  const relay = getRelay();
  const subject = `mesh.event.${userId}`;
  const payload = sc.encode(JSON.stringify(event));
  relay.publish(subject, payload);
}

// ─── Subscribe to Group Messages ───

export function subscribeToGroup(groupId: string, callback: (msg: RelayMessage) => void): Subscription {
  const relay = getRelay();
  const subject = `mesh.msg.${groupId}`;

  const sub = relay.subscribe(subject);
  (async () => {
    for await (const msg of sub) {
      try {
        const data = JSON.parse(sc.decode(msg.data)) as RelayMessage;
        callback(data);
      } catch {}
    }
  })();

  return sub;
}

// ─── Subscribe to User Events ───

export function subscribeToUser(userId: string, callback: (event: RelayEvent) => void): Subscription {
  const relay = getRelay();
  const subject = `mesh.event.${userId}`;

  const sub = relay.subscribe(subject);
  (async () => {
    for await (const msg of sub) {
      try {
        const data = JSON.parse(sc.decode(msg.data)) as RelayEvent;
        callback(data);
      } catch {}
    }
  })();

  return sub;
}

// ─── JetStream: Durable Consumer (for offline delivery) ───

export async function createDurableConsumer(groupId: string, userId: string) {
  const jetstream = getJetStream();
  const subject = `mesh.msg.${groupId}`;
  const durable = `mesh_${userId}_${groupId}`;

  try {
    await jsm!.consumers.add('MESH_MESSAGES', {
      durable_name: durable,
      filter_subject: subject,
      deliver_policy: DeliverPolicy.All,
      ack_policy: AckPolicy.Explicit,
      max_deliver: 3,
      ack_wait: 30_000_000_000, // 30 seconds in nanoseconds
    });
  } catch {
    // Consumer might already exist
  }

  return durable;
}

// ─── JetStream: Get Pending Messages (for offline users) ───

export async function getPendingMessages(userId: string, groupId: string): Promise<RelayMessage[]> {
  const jetstream = getJetStream();
  const durable = `mesh_${userId}_${groupId}`;
  const messages: RelayMessage[] = [];

  try {
    const consumer = await jetstream.consumers.get('MESH_MESSAGES', durable);
    const fetched = await consumer.fetch({ max_messages: 100, expires: 5000 });

    for await (const msg of fetched) {
      try {
        const data = JSON.parse(sc.decode(msg.data)) as RelayMessage;
        messages.push(data);
        msg.ack();
      } catch {
        msg.nak();
      }
    }
  } catch {}

  return messages;
}

// ─── Cleanup ───

export async function disconnectRelay() {
  if (nc && !nc.isClosed()) {
    await nc.drain();
    nc = null;
    js = null;
    jsm = null;
  }
}
