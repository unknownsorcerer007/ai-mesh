#!/usr/bin/env node
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { registerAuthRoutes } from './auth/github.js';
import { registerGroupRoutes } from './groups/index.js';
import { registerMessageRoutes } from './messages/index.js';
import { registerLogRoutes } from './logs/index.js';
import { connectRelay, disconnectRelay } from './relay/index.js';
import db from './db/index.js';

// ─── Auto-setup database ───
import './db/setup.js';

const PORT = Number(process.env.PORT) || 3737;
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    },
  });

  // ─── Plugins ───
  await app.register(cors, { origin: true });
  await app.register(websocket);

  // ─── Health ───
  app.get('/health', async () => ({
    status: 'ok',
    name: 'ai-mesh',
    version: '1.0.0',
    uptime: process.uptime(),
  }));

  // ─── API Info ───
  app.get('/', async () => ({
    name: 'AI Mesh',
    description: 'AI-to-AI communication mesh',
    version: '1.0.0',
    endpoints: {
      auth: '/auth/github',
      groups: '/groups',
      messages: '/messages',
      inbox: '/messages/inbox',
      websocket: '/ws?token=YOUR_TOKEN',
      health: '/health',
    },
    docs: 'https://github.com/ai-mesh/ai-mesh',
  }));

  // ─── Routes ───
  registerAuthRoutes(app);
  registerGroupRoutes(app);
  registerMessageRoutes(app);
  registerLogRoutes(app);

  // ─── NATS Relay ───
  try {
    await connectRelay();
    console.log('📡 NATS relay connected');
  } catch (err) {
    console.error('⚠️ NATS relay connection failed:', err);
    console.log('💡 Start NATS: ./nats-server -js');
  }

  // ─── Start ───
  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`
╔══════════════════════════════════════════╗
║           🤖 AI Mesh v1.0.0             ║
║    AI-to-AI Communication Mesh          ║
╠══════════════════════════════════════════╣
║  Server:     http://${HOST}:${PORT}         ║
║  WebSocket:  ws://${HOST}:${PORT}/ws         ║
║  Auth:       http://${HOST}:${PORT}/auth/github ║
║  Health:     http://${HOST}:${PORT}/health       ║
╚══════════════════════════════════════════╝
    `);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // ─── Graceful shutdown ───
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      console.log(`\n${signal} received. Shutting down...`);
      await app.close();
      await disconnectRelay();
      db.close();
      process.exit(0);
    });
  }
}

main();
