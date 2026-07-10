// Relay: NATS Connection Management
// Auto-reconnect, status monitoring, health check

import { connect, type NatsConnection, type JetStreamClient, type JetStreamManager } from 'nats';
import { getConfig } from '../../core/config.js';
import { registerHealthCheck, type BlockHealth } from '../../core/health.js';
import { setupStreams } from './streams.js';

let nc: NatsConnection | null = null;
let js: JetStreamClient | null = null;
let jsm: JetStreamManager | null = null;

export async function connectRelay(): Promise<NatsConnection> {
  if (nc && !nc.isClosed()) return nc;

  const config = getConfig();

  nc = await connect({
    servers: config.nats.url,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2000,
    pingInterval: 30000,
    timeout: 10000,
  });

  // Status monitoring
  (async () => {
    for await (const status of nc!.status()) {
      switch (status.type) {
        case 'disconnect':
          console.warn('[relay] NATS disconnected');
          break;
        case 'reconnect':
          console.info('[relay] NATS reconnected:', status.data);
          break;
        case 'error':
          console.error('[relay] NATS error:', status.data);
          break;
      }
    }
  })();

  js = nc.jetstream();
  jsm = await nc.jetstreamManager();
  await setupStreams(jsm);

  // Register health check
  registerHealthCheck('relay', async (): Promise<BlockHealth> => {
    if (!nc || nc.isClosed()) {
      return { status: 'unhealthy', message: 'Not connected', lastCheck: '' };
    }
    return { status: 'healthy', message: `Connected to ${nc.getServer()}`, lastCheck: '' };
  });

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

export function getJetStreamManager(): JetStreamManager {
  if (!jsm) throw new Error('JetStream manager not initialized');
  return jsm;
}

export function isRelayConnected(): boolean {
  return !!nc && !nc.isClosed();
}

export async function disconnectRelay() {
  if (nc && !nc.isClosed()) {
    await nc.drain();
    nc = null;
    js = null;
    jsm = null;
  }
}
