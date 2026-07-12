#!/usr/bin/env node
// AI Mesh — Main Server (Orchestrator)
// Registers all blocks, handles lifecycle, health checks
// Each block is independent — one block failing doesn't crash others

import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';

// Core
import { getConfig } from './core/config.js';
import { registerErrorHandler } from './core/errors.js';
import { getSystemHealth } from './core/health.js';

// Shared
import { setupSchema, closeDb } from './shared/db.js';

// Blocks
import { registerAuthRoutes } from './blocks/auth/index.js';
import { registerGroupRoutes } from './blocks/groups/index.js';
import { registerMessageRoutes, cleanupSubscriptions } from './blocks/messages/index.js';
import { registerLogRoutes } from './blocks/logs/index.js';
import { connectRelay, disconnectRelay, isRelayConnected } from './blocks/relay/index.js';
import { registerWebhookRoutes } from './blocks/webhooks/index.js';
import { registerApprovalRoutes } from './blocks/approval/index.js';
import { registerThreadingRoutes } from './blocks/threading/index.js';
import { registerSearchRoutes } from './blocks/search/index.js';
import { registerReactionRoutes } from './blocks/reactions/index.js';
import { registerNotificationRoutes } from './blocks/notifications/routes.js';
import { registerNotificationHealth } from './blocks/notifications/index.js';

async function main() {
  const config = getConfig();

  // ─── Database Setup ───
  setupSchema();

  // ─── Fastify App ───
  const app = Fastify({
    logger: {
      level: config.server.nodeEnv === 'production' ? 'info' : 'debug',
    },
    bodyLimit: 1048576, // 1MB max body size
  });

  // ─── Error Handler ───
  registerErrorHandler(app);

  // ─── Plugins ───
  await app.register(cors, {
    origin: config.server.corsOrigin.length > 0 ? config.server.corsOrigin : (config.server.nodeEnv === 'production' ? ['https://' + (process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost')] : true),
    credentials: true,
    maxAge: 86400,
  });
  await app.register(websocket);

  // Fix: Content-Type validation for POST/PUT
  app.addHook('preHandler', async (req, reply) => {
    // Security headers
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (config.server.nodeEnv === 'production') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      const contentType = req.headers['content-type'];
      if (contentType && !contentType.includes('application/json') && !contentType.includes('multipart/form-data')) {
        return reply.code(415).send({ error: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json' });
      }
      // Message size limit: 16KB for message content
      if (req.url === '/messages' && req.body) {
        const body = req.body as Record<string, unknown>;
        if (body.message && typeof body.message === 'string' && body.message.length > 16384) {
          return reply.code(413).send({ error: 'MESSAGE_TOO_LARGE', message: 'Message content must be 16KB or less' });
        }
      }
    }
  });

  // ─── Static UI (cached at startup — was readFileSync on every request) ───
  const { readFileSync, existsSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const htmlPath = resolve(process.cwd(), 'public', 'index.html');
  const fallbackPath = new URL('../public/index.html', import.meta.url);
  const indexHtml = existsSync(htmlPath) ? readFileSync(htmlPath, 'utf-8') : readFileSync(fallbackPath, 'utf-8');

  app.get('/', async (_req, reply) => {
    reply.type('text/html').send(indexHtml);
  });

  // ─── Health Endpoint ───
  app.get('/health', async () => {
    const health = await getSystemHealth();
    // Fix: Hide block details in production (info disclosure)
    if (config.server.nodeEnv === 'production') {
      return { status: health.status, version: health.version, uptime: health.uptime };
    }
    return health;
  });

  // ─── API Info ───
  app.get('/api', async () => ({
    name: 'AI Mesh',
    description: 'AI-to-AI communication mesh',
    version: '1.0.0',
    endpoints: {
      auth: '/auth/github',
      groups: '/groups',
      messages: '/messages',
      inbox: '/messages/inbox',
      websocket: '/ws',
      health: '/health',
      logs: '/logs',
    },
  }));

  // ─── Register Block Routes ───
  // Each block registers its own routes + health check
  // If a block fails to register, others still work
  try { registerAuthRoutes(app); } catch (err) { app.log.error({ err }, 'Failed to register auth block'); }
  try { registerGroupRoutes(app); } catch (err) { app.log.error({ err }, 'Failed to register groups block'); }
  try { registerMessageRoutes(app); } catch (err) { app.log.error({ err }, 'Failed to register messages block'); }
  try { registerLogRoutes(app); } catch (err) { app.log.error({ err }, 'Failed to register logs block'); }
  try { registerWebhookRoutes(app); } catch (err) { app.log.error({ err }, 'Failed to register webhooks block'); }
  try { registerApprovalRoutes(app); } catch (err) { app.log.error({ err }, 'Failed to register approval block'); }
  try { registerThreadingRoutes(app); } catch (err) { app.log.error({ err }, 'Failed to register threading block'); }
  try { registerSearchRoutes(app); } catch (err) { app.log.error({ err }, 'Failed to register search block'); }
  try { registerReactionRoutes(app); } catch (err) { app.log.error({ err }, 'Failed to register reactions block'); }
  try { registerNotificationRoutes(app); } catch (err) { app.log.error({ err }, 'Failed to register notifications block'); }
  try { registerNotificationHealth(); } catch (err) { app.log.error({ err }, 'Failed to register notification health'); }

  // ─── NATS Relay (optional — server works without it) ───
  let natsConnected = false;
  try {
    await connectRelay();
    natsConnected = true;
    app.log.info('NATS relay connected');
  } catch (err) {
    app.log.warn({ err }, 'NATS relay not available — running without relay');
  }

  // ─── Start Server ───
  try {
    await app.listen({ port: config.server.port, host: config.server.host });
    app.log.info(`Server listening on http://${config.server.host}:${config.server.port}`);
    if (!natsConnected) {
      app.log.warn('NATS not connected. Start NATS: nats-server -js');
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // ─── Graceful Shutdown ───
  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down...`);
    try {
      cleanupSubscriptions();
      await app.close();
      await disconnectRelay();
      closeDb();
      app.log.info('Shutdown complete');
    } catch (err) {
      app.log.error({ err }, 'Error during shutdown');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
