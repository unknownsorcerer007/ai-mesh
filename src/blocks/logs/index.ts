// Block: Logging (Audit)
// Monthly log files, downloadable via API
// No message content in DB — only file-based logs

import { appendFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { registerHealthCheck, type BlockHealth } from '../../core/health.js';
import { authenticate } from '../auth/index.js';

const LOG_DIR = resolve(process.env.HOME || process.env.USERPROFILE || '/tmp', '.ai-mesh', 'chat-logs');
const MAX_LOG_FILE_SIZE = 50 * 1024 * 1024; // 50MB per file
const MAX_LOG_FILES = 12; // Keep 12 months max
mkdirSync(LOG_DIR, { recursive: true });

// Fix: Check file size before writing
function checkLogSize(filePath: string): boolean {
  try {
    if (existsSync(filePath)) {
      const stat = statSync(filePath);
      return stat.size < MAX_LOG_FILE_SIZE;
    }
  } catch { /* file may not exist */ }
  return true;
}

// Fix: Clean old log files
function cleanOldLogs() {
  try {
    const files = readdirSync(LOG_DIR).filter(f => f.endsWith('.log') || f.endsWith('.jsonl')).sort();
    while (files.length > MAX_LOG_FILES * 2) { // *2 because .log + .jsonl per month
      const oldest = files.shift();
      if (oldest) {
        try { unlinkSync(resolve(LOG_DIR, oldest)); } catch { /* may be locked */ }
      }
    }
  } catch { /* dir may not exist */ }
}

// Run cleanup on startup
cleanOldLogs();

export function logMessage(params: {
  group_id: string; group_name: string; sender: string; sender_ai?: string;
  type: string; content: string; timestamp: string;
}) {
  const month = params.timestamp.slice(0, 7);
  const logFile = resolve(LOG_DIR, `${month}.log`);

  // Fix: Skip if file too large
  if (!checkLogSize(logFile)) return;

  const line = `[${params.timestamp}] [group:${params.group_name}] [${params.sender_ai ? `ai:${params.sender_ai}` : `user:${params.sender}`}] [${params.type}] ${params.content}\n`;
  appendFileSync(logFile, line);
}

export function logFullMessage(params: {
  group_id: string; group_name: string; sender_id: string; sender_username: string;
  sender_ai?: string; type: string; content: string; metadata?: Record<string, unknown>;
  timestamp: string;
}) {
  const month = params.timestamp.slice(0, 7);
  const logFile = resolve(LOG_DIR, `${month}-full.jsonl`);

  // Fix: Skip if file too large
  if (!checkLogSize(logFile)) return;

  appendFileSync(logFile, JSON.stringify({ ...params, logged_at: new Date().toISOString() }) + '\n');
}

export function registerLogRoutes(app: any) {
  registerHealthCheck('logs', async (): Promise<BlockHealth> => {
    return { status: 'healthy', message: `Log dir: ${LOG_DIR}`, lastCheck: '' };
  });

  app.get('/logs', async (req: any, reply: any) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const files = readdirSync(LOG_DIR)
      .filter(f => f.endsWith('.log') || f.endsWith('.jsonl'))
      .map(f => {
        const stat = statSync(resolve(LOG_DIR, f));
        return { name: f, size: stat.size, month: f.replace(/(-full)?\.(log|jsonl)$/, ''), type: f.includes('-full') ? 'json' : 'text' };
      })
      .sort((a, b) => b.month.localeCompare(a.month));

    return reply.send({ logs: files, directory: LOG_DIR });
  });

  app.get('/logs/:filename', async (req: any, reply: any) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const filename = req.params.filename;
    if (filename.includes('..') || !/^[\w-]+\.(log|jsonl)$/.test(filename)) {
      return reply.code(400).send({ error: 'INVALID_FILENAME' });
    }

    const filePath = resolve(LOG_DIR, filename);
    if (!existsSync(filePath)) return reply.code(404).send({ error: 'NOT_FOUND' });

    const content = readFileSync(filePath, 'utf-8');
    const isJson = filename.endsWith('.jsonl');
    reply.header('Content-Type', isJson ? 'application/json' : 'text/plain');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);

    if (isJson) {
      const lines = content.trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      return reply.send(lines);
    }
    return reply.send(content);
  });
}
