// Relay: Subscribe Functions (real-time)

import { StringCodec, type Subscription } from 'nats';
import { getRelay } from './connection.js';
import type { RelayMessage, RelayEvent } from '../../shared/types.js';

const sc = StringCodec();

export function subscribeToGroup(groupId: string, callback: (msg: RelayMessage) => void): Subscription {
  const sub = getRelay().subscribe(`mesh.msg.${groupId}`);
  (async () => {
    for await (const msg of sub) {
      try {
        callback(JSON.parse(sc.decode(msg.data)) as RelayMessage);
      } catch { /* malformed */ }
    }
  })();
  return sub;
}

export function subscribeToUser(userId: string, callback: (event: RelayEvent) => void): Subscription {
  const sub = getRelay().subscribe(`mesh.event.${userId}`);
  (async () => {
    for await (const msg of sub) {
      try {
        callback(JSON.parse(sc.decode(msg.data)) as RelayEvent);
      } catch { /* malformed */ }
    }
  })();
  return sub;
}
