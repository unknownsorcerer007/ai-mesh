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
import { setupSchema, closeDb, getDb } from './shared/db.js';
import { checkRateLimit } from './blocks/security/rate-limit.js';

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
  // F-03 fix: trustProxy lets Fastify consistently parse X-Forwarded-For when
  // running behind a reverse proxy (nginx, Cloudflare, Railway, etc.). Without
  // this, req.ip falls back to the proxy's IP for EVERY request, defeating
  // per-IP rate limits.
  //
  // M1 fix: previously this was `true` in production by default, which trusts
  // ALL proxies unconditionally. If the server is deployed directly on the
  // internet (no reverse proxy), an attacker can spoof X-Forwarded-For to
  // bypass every per-IP rate limit. Now trustProxy is opt-in: the deployer
  // sets TRUST_PROXY=true explicitly when they know they're behind a proxy.
  // For multi-hop chains, set TRUST_PROXY_HOPS=N to trust exactly N hops.
  const trustProxy = process.env.TRUST_PROXY === 'true'
    ? (process.env.TRUST_PROXY_HOPS ? Number(process.env.TRUST_PROXY_HOPS) : true)
    : false;
  const app = Fastify({
    logger: {
      level: config.server.nodeEnv === 'production' ? 'info' : 'debug',
    },
    bodyLimit: 1048576, // 1MB max body size
    trustProxy,
  });

  // ─── Error Handler ───
  registerErrorHandler(app);

  // ─── Plugins ───
  await app.register(cors, {
    origin: config.server.corsOrigin.length > 0 ? config.server.corsOrigin : (config.server.nodeEnv === 'production' ? false : true),
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
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https: data:");
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
  // Prefer root public/ (Docker copies this). Fall back to src/public/ for dev.
  const htmlPath = resolve(process.cwd(), 'public', 'index.html');
  const fallbackPath = new URL('../public/index.html', import.meta.url);
  const usedPath = existsSync(htmlPath) ? htmlPath : fallbackPath;
  const indexHtml = readFileSync(usedPath, 'utf-8');
  app.log.info(`Serving landing from: ${usedPath.toString()}`);

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
  // F-09 mitigation: route enumeration is acceptable for a dev-friendly API,
  // but the response should not be cached by intermediate proxies (it leaks
  // the route map to anyone who can read cache logs). no-store ensures the
  // response is fresh per request and never persisted by shared caches.
  app.get('/api', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return {
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
    };
  });

  // ─── Email Signup (public — no auth) ───
  // Stores email for newsletter / waitlist. Rate-limited per-IP.
  // ponytail: inline route — too small for a dedicated block.
  app.post('/api/email-signup', async (req, reply) => {
    const { email } = req.body as { email?: string } ?? {};
    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply.code(400).send({ error: 'INVALID_EMAIL', message: 'A valid email is required' });
    }
    if (email.length > 254) {
      return reply.code(400).send({ error: 'EMAIL_TOO_LONG', message: 'Email must be 254 characters or less' });
    }
    const rl = checkRateLimit(`email-signup:${req.ip}`, 3600_000, 5);
    if (!rl.allowed) {
      return reply.code(429).send({ error: 'RATE_LIMITED', message: 'Too many signups from this IP' });
    }
    try {
      const { nanoid } = await import('nanoid');
      const db = getDb();
      db.prepare('INSERT INTO email_signups (id, email) VALUES (?, ?)').run(nanoid(), email.toLowerCase().trim());
      return reply.code(201).send({ status: 'subscribed', email: email.toLowerCase().trim() });
    } catch (err: any) {
      if (err.message?.includes('UNIQUE') || err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return reply.send({ status: 'already_subscribed', message: 'You\'re already on the list!' });
      }
      app.log.error({ err }, 'Email signup failed');
      return reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Failed to save email' });
    }
  });

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
