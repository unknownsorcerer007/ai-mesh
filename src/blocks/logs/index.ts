// Block: Logging (Audit)
// Monthly log files, downloadable via API.
//
// CRITICAL fix: the original endpoint returned the FULL log file to any
// authenticated user — so a user in Group A could download Group B's entire
// message history. Now the content is filtered server-side: a user only sees
// log entries for groups where they are an admin. (Members can see their own
// group's messages via the normal message endpoints; raw audit logs are an
// admin-only surface.)
//
// Also removed: the dead `filename.includes('..')` check. The regex below is
// the actual guard; the `..` check was misleading dead code that gave false
// confidence.

import { appendFile, readFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { registerHealthCheck, type BlockHealth } from '../../core/health.js';
import { authenticate } from '../auth/index.js';
import { getDb } from '../../shared/db.js';

const appendFileAsync = promisify(appendFile);

const LOG_DIR = resolve(process.env.HOME || process.env.USERPROFILE || '/tmp', '.ai-mesh', 'chat-logs');
const MAX_LOG_FILE_SIZE = 50 * 1024 * 1024; // 50MB per file
const MAX_LOG_FILES = 12; // Keep 12 months max
mkdirSync(LOG_DIR, { recursive: true });

function checkLogSize(filePath: string): boolean {
  try {
    if (existsSync(filePath)) {
      const stat = statSync(filePath);
      return stat.size < MAX_LOG_FILE_SIZE;
    }
  } catch { /* file may not exist */ }
  return true;
}

function cleanOldLogs() {
  try {
    const files = readdirSync(LOG_DIR).filter(f => f.endsWith('.log') || f.endsWith('.jsonl')).sort();
    while (files.length > MAX_LOG_FILES * 2) {
      const oldest = files.shift();
      if (oldest) {
        try { unlinkSync(resolve(LOG_DIR, oldest)); } catch { /* may be locked */ }
      }
    }
  } catch { /* dir may not exist */ }
}

cleanOldLogs();

export function logMessage(params: {
  group_id: string; group_name: string; sender: string; sender_ai?: string;
  type: string; content: string; timestamp: string;
}) {
  const month = params.timestamp.slice(0, 7);
  const logFile = resolve(LOG_DIR, `${month}.log`);
  if (!checkLogSize(logFile)) return;
  const line = `[${params.timestamp}] [group:${params.group_name}] [group_id:${params.group_id}] [${params.sender_ai ? `ai:${params.sender_ai}` : `user:${params.sender}`}] [${params.type}] ${params.content}\n`;
  appendFileAsync(logFile, line).catch(() => {});
}

export function logFullMessage(params: {
  group_id: string; group_name: string; sender_id: string; sender_username: string;
  sender_ai?: string; type: string; content: string; metadata?: Record<string, unknown>;
  timestamp: string;
}) {
  const month = params.timestamp.slice(0, 7);
  const logFile = resolve(LOG_DIR, `${month}-full.jsonl`);
  if (!checkLogSize(logFile)) return;
  appendFileAsync(logFile, JSON.stringify({ ...params, logged_at: new Date().toISOString() }) + '\n').catch(() => {});
}

// ─── Authorization helper ───
// Returns the set of group_ids this user administers. Log entries are filtered
// to this set before being returned. Empty set → empty result (a non-admin
// gets nothing, which is the correct default).
function adminnedGroupIds(userId: string): Set<string> {
  const rows = getDb().prepare('SELECT id FROM groups WHERE admin_id = ?').all(userId) as { id: string }[];
  return new Set(rows.map(r => r.id));
}

// Strict filename validation — the ONLY guard against path traversal.
// Matches YYYY-MM.log or YYYY-MM-full.jsonl. No `..`, no slashes, no shell metachars.
const LOG_FILENAME_RE = /^\d{4}-\d{2}(-full)?\.(log|jsonl)$/;

export function registerLogRoutes(app: any) {
  registerHealthCheck('logs', async (): Promise<BlockHealth> => {
    return { status: 'healthy', message: `Log dir: ${LOG_DIR}`, lastCheck: '' };
  });

  // ─── List log files (metadata only — safe for any authenticated user) ───
  app.get('/logs', async (req: any, reply: any) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    try {
      const files = readdirSync(LOG_DIR)
        .filter(f => LOG_FILENAME_RE.test(f))
        .map(f => {
          const stat = statSync(resolve(LOG_DIR, f));
          return { name: f, size: stat.size, month: f.replace(/(-full)?\.(log|jsonl)$/, ''), type: f.includes('-full') ? 'json' : 'text' };
        })
        .sort((a, b) => b.month.localeCompare(a.month));
      return reply.send({ logs: files });
    } catch {
      return reply.send({ logs: [] });
    }
  });

  // ─── Download log file (FILTERED to groups the user administers) ───
  app.get('/logs/:filename', async (req: any, reply: any) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const filename = req.params.filename;
    // Strict regex — the `..` check from the original was dead code; this is
    // the actual guard.
    if (!LOG_FILENAME_RE.test(filename)) {
      return reply.code(400).send({ error: 'INVALID_FILENAME' });
    }

    const filePath = resolve(LOG_DIR, filename);
    if (!existsSync(filePath)) return reply.code(404).send({ error: 'NOT_FOUND' });

    const allowedGroups = adminnedGroupIds(userId);
    if (allowedGroups.size === 0) {
      // Non-admin gets nothing — not even a hint that logs exist for other groups.
      return reply.code(403).send({ error: 'FORBIDDEN', message: 'Admin access required to view logs' });
    }

    const content = readFileSync(filePath, 'utf-8');
    const isJson = filename.endsWith('.jsonl');

    reply.header('Content-Type', isJson ? 'application/json' : 'text/plain');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);

    if (isJson) {
      // JSONL — filter by group_id field
      const lines = content.split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean) as Array<Record<string, unknown>>;
      const filtered = lines.filter(l => l.group_id && allowedGroups.has(l.group_id as string));
      return reply.send(filtered);
    }

    // Text log — filter by [group_id:ID] marker (we added it in logMessage).
    // Lines without a group_id marker are system lines and are excluded too
    // (they could leak cross-group metadata).
    const filteredLines = content.split('\n').filter(line => {
      const m = line.match(/\[group_id:([^\]]+)\]/);
      return m && allowedGroups.has(m[1]);
    });
    return reply.send(filteredLines.join('\n'));
  });
}
