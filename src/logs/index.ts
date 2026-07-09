// AI Mesh — Monthly Chat Log System
// Saves complete chat logs per month, downloadable as a single file

import { writeFileSync, appendFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate } from '../auth/github.js';
import db from '../db/index.js';

const LOG_DIR = resolve(process.env.HOME || '~', '.ai-mesh', 'chat-logs');

// ─── Ensure log directory ───
mkdirSync(LOG_DIR, { recursive: true });

// ─── Log a message to monthly file ───

export function logMessage(params: {
  group_id: string;
  group_name: string;
  sender: string;
  sender_ai?: string;
  type: string;
  content: string;
  timestamp: string;
}) {
  const month = params.timestamp.slice(0, 7); // YYYY-MM
  const logFile = resolve(LOG_DIR, `${month}.log`);

  const line = [
    `[${params.timestamp}]`,
    `[group:${params.group_name}]`,
    `[${params.sender_ai ? `ai:${params.sender_ai}` : `user:${params.sender}`}]`,
    `[${params.type}]`,
    params.content,
  ].join(' ') + '\n';

  appendFileSync(logFile, line);
}

// ─── Log full message with metadata ───

export function logFullMessage(params: {
  group_id: string;
  group_name: string;
  sender_id: string;
  sender_username: string;
  sender_ai?: string;
  type: string;
  content: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}) {
  const month = params.timestamp.slice(0, 7);
  const logFile = resolve(LOG_DIR, `${month}-full.jsonl`);

  const entry = JSON.stringify({
    ...params,
    logged_at: new Date().toISOString(),
  });

  appendFileSync(logFile, entry + '\n');
}

// ─── API: Download monthly log ───

export function registerLogRoutes(app: FastifyInstance) {

  // Get list of available log files
  app.get('/logs', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    try {
      const files = readdirSync(LOG_DIR)
        .filter(f => f.endsWith('.log') || f.endsWith('.jsonl'))
        .map(f => {
          const path = resolve(LOG_DIR, f);
          const stat = require('fs').statSync(path);
          return {
            name: f,
            size: stat.size,
            month: f.replace(/(-full)?\.(log|jsonl)$/, ''),
            type: f.includes('-full') ? 'json' : 'text',
          };
        })
        .sort((a, b) => b.month.localeCompare(a.month));

      return reply.send({ logs: files, directory: LOG_DIR });
    } catch {
      return reply.send({ logs: [] });
    }
  });

  // Download a specific log file
  app.get('/logs/:filename', async (req: FastifyRequest<{ Params: { filename: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const filename = req.params.filename;
    // Security: only allow log files, no path traversal
    if (filename.includes('..') || !/^[\w-]+\.(log|jsonl)$/.test(filename)) {
      return reply.code(400).send({ error: 'Invalid filename' });
    }

    const filePath = resolve(LOG_DIR, filename);
    if (!existsSync(filePath)) return reply.code(404).send({ error: 'Log file not found' });

    const content = readFileSync(filePath, 'utf-8');
    const isJson = filename.endsWith('.jsonl');

    reply.header('Content-Type', isJson ? 'application/json' : 'text/plain');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);

    if (isJson) {
      // Parse JSONL and return as JSON array
      const lines = content.trim().split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      return reply.send(lines);
    }

    return reply.send(content);
  });

  // Get stats
  app.get('/logs/stats', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    try {
      const files = readdirSync(LOG_DIR).filter(f => f.endsWith('.log'));
      const stats = files.map(f => {
        const content = readFileSync(resolve(LOG_DIR, f), 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        return {
          month: f.replace('.log', ''),
          message_count: lines.length,
          file_size: Buffer.byteLength(content),
        };
      });

      return reply.send({ stats, total_months: stats.length });
    } catch {
      return reply.send({ stats: [], total_months: 0 });
    }
  });
}
