import type { FastifyInstance } from 'fastify';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyToken } from '../security/index.js';
import { registerUserSocket, unregisterUserSocket } from '../groups/index.js';

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

export function setupWebSocket(app: FastifyInstance) {
  const wss = new WebSocketServer({ server: app.server, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req) => {
    // Auth via query param: ws://host/ws?token=xxx
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (!token) {
      ws.close(4001, 'Missing token');
      return;
    }

    const userId = verifyToken(token, SESSION_SECRET);
    if (!userId) {
      ws.close(4003, 'Invalid token');
      return;
    }

    registerUserSocket(userId, ws);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        // Handle ping/pong for keepalive
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
        }
      } catch {
        // Ignore invalid messages
      }
    });

    ws.on('close', () => {
      unregisterUserSocket(userId, ws);
    });

    ws.on('error', () => {
      unregisterUserSocket(userId, ws);
    });

    // Send welcome
    ws.send(JSON.stringify({
      type: 'connected',
      payload: { message: 'Connected to AI Mesh' },
      timestamp: new Date().toISOString(),
    }));
  });

  return wss;
}
