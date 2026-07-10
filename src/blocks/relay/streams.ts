// Relay: JetStream Stream Setup

import { RetentionPolicy, StorageType, DiscardPolicy, type JetStreamManager } from 'nats';

export async function setupStreams(jsm: JetStreamManager) {
  const streams = [
    {
      name: 'MESH_MESSAGES',
      subjects: ['mesh.msg.>'],
      retention: RetentionPolicy.Limits,
      max_age: 7 * 24 * 60 * 60 * 1_000_000_000,
      max_msgs: 1_000_000,
      max_bytes: 500 * 1024 * 1024,
      storage: StorageType.File,
      num_replicas: 1,
      discard: DiscardPolicy.Old,
    },
    {
      name: 'MESH_EVENTS',
      subjects: ['mesh.event.>'],
      retention: RetentionPolicy.Limits,
      max_age: 24 * 60 * 60 * 1_000_000_000,
      max_msgs: 100_000,
      max_bytes: 50 * 1024 * 1024,
      storage: StorageType.File,
      num_replicas: 1,
      discard: DiscardPolicy.Old,
    },
  ];

  for (const stream of streams) {
    try {
      await jsm.streams.info(stream.name);
      await jsm.streams.update(stream.name, stream);
    } catch {
      await jsm.streams.add(stream);
    }
  }
}
