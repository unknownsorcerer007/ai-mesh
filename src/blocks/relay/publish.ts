// Relay: Publish Functions

import { StringCodec } from 'nats';
import { getRelay } from './connection.js';
import type { RelayMessage, RelayEvent } from '../../shared/types.js';

const sc = StringCodec();

export function publishToGroup(groupId: string, message: RelayMessage): void {
  const relay = getRelay();
  relay.publish(`mesh.msg.${groupId}`, sc.encode(JSON.stringify(message)));
}

export function publishToUser(userId: string, event: RelayEvent): void {
  const relay = getRelay();
  relay.publish(`mesh.event.${userId}`, sc.encode(JSON.stringify(event)));
}
