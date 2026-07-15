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

  // M2 fix: the original connect() threw on initial failure and the caller
  // gave up forever. The nats library's auto-reconnect only fires AFTER the
  // first connect succeeds, so we do a few quick retries ourselves. If all
  // fail, we return null and a background loop keeps trying — server keeps
  // serving routes that don't need the relay, and relay tools come back
  // online the moment NATS does. ponytail: stdlib only, no new dep.
  const ATTEMPTS = 3;
  for (let i = 1; i <= ATTEMPTS; i++) {
    try {
      nc = await connect({
        servers: config.nats.url,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 2000,
        pingInterval: 30000,
        timeout: 10000,
      });
      break;
    } catch (err) {
      if (i === ATTEMPTS) {
        console.warn(`[relay] NATS connect failed after ${ATTEMPTS} attempts — scheduling background retry:`, (err as Error).message);
        scheduleBackgroundReconnect(config.nats.url);
        return null as any; // callers check isRelayConnected(); getRelay() throws if null
      }
      const wait = 1000 * i;
      console.warn(`[relay] NATS connect attempt ${i}/${ATTEMPTS} failed, retry in ${wait}ms:`, (err as Error).message);
      await new Promise(r => setTimeout(r, wait));
    }
  }

  await wireUpConnection();
  return nc!;
}

// Background retry — fires every 5s until NATS comes back. unref'd so it
// doesn't hold the process open on shutdown.
let bgReconnectScheduled = false;
function scheduleBackgroundReconnect(url: string) {
  if (bgReconnectScheduled) return;
  bgReconnectScheduled = true;
  const timer = setInterval(async () => {
    if (nc && !nc.isClosed()) return;
    try {
      console.info('[relay] background reconnect attempt...');
      nc = await connect({
        servers: url,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 2000,
        pingInterval: 30000,
        timeout: 10000,
      });
      await wireUpConnection();
      console.info('[relay] NATS reconnected via background retry');
    } catch (err) {
      // swallow — try again next tick
    }
  }, 5000);
  timer.unref();
}

// Shared post-connect setup: status monitor, js/jsm, streams, consumer sync.
// ponytail: extracted so both code paths (initial connect + background reconnect) share it.
// MUST be awaited — js/jsm setup is async and callers (getJetStream/getJetStreamManager)
// will throw "not initialized" if this hasn't completed.
async function wireUpConnection() {
  if (!nc) return;

  // Status monitoring (fire-and-forget — just logs)
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

  // JetStream setup — MUST be awaited so js/jsm are ready before connectRelay() returns
  try {
    js = nc.jetstream();
    jsm = await nc.jetstreamManager();
    await setupStreams(jsm);

    // Sync the in-memory consumer map from NATS (so a restart doesn't "forget"
    // durable consumers that are still held server-side) and schedule periodic
    // cleanup of expired ones.
    const { syncConsumersFromNats, scheduleConsumerCleanup } = await import('./consumers.js');
    const synced = await syncConsumersFromNats();
    if (synced > 0) console.info(`[relay] Synced ${synced} durable consumers from NATS`);
    scheduleConsumerCleanup();
  } catch (err) {
    console.warn('[relay] Post-connect setup failed:', err);
  }

  // Register health check (idempotent — registerHealthCheck just overwrites)
  registerHealthCheck('relay', async (): Promise<BlockHealth> => {
    if (!nc || nc.isClosed()) {
      return { status: 'unhealthy', message: 'Not connected', lastCheck: '' };
    }
    return { status: 'healthy', message: `Connected to ${nc.getServer()}`, lastCheck: '' };
  });
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
