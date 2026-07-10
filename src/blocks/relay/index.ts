// Block: NATS Relay
// High-performance message routing via JetStream
// Handles offline delivery with durable consumers

export { connectRelay, disconnectRelay, isRelayConnected } from './connection.js';
export { publishToGroup, publishToUser } from './publish.js';
export { subscribeToGroup, subscribeToUser } from './subscribe.js';
export { ensureConsumer, removeConsumer, removeUserConsumers, cleanupExpiredConsumers, getConsumerStats, getPendingMessages, getAllPendingMessages } from './consumers.js';
export type { RelayMessage, RelayEvent } from '../../shared/types.js';
