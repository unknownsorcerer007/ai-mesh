// Shared: Database Connection
// Single SQLite instance shared across blocks
// WAL mode for concurrent reads, foreign keys enabled

import Database from 'better-sqlite3';
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { getConfig } from '../core/config.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const config = getConfig();
  const dbPath = resolve(config.database.path);

  // Ensure directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  db = new Database(dbPath);

  // Performance + safety
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// ─── Schema Setup ───
export function setupSchema() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      hash_id TEXT UNIQUE NOT NULL,
      public_key TEXT NOT NULL,
      github_id TEXT,
      github_username TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      invite_code TEXT UNIQUE NOT NULL,
      admin_id TEXT NOT NULL,
      max_members INTEGER DEFAULT 0,
      group_type TEXT DEFAULT 'team' CHECK(group_type IN ('team', 'project', 'open')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (admin_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS group_members (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT DEFAULT 'member' CHECK(role IN ('admin', 'member')),
      joined_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS join_requests (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(group_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
    CREATE INDEX IF NOT EXISTS idx_join_requests_group ON join_requests(group_id, status);

    CREATE TABLE IF NOT EXISTS reactions (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(message_id, emoji, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);

    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      parent_message_id TEXT NOT NULL,
      parent_content TEXT DEFAULT '',
      parent_sender TEXT DEFAULT '',
      reply_count INTEGER DEFAULT 0,
      last_reply_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(parent_message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_threads_group ON threads(group_id);

    -- Thread replies persisted here so GET /thread/:id is a simple SQLite query
    -- instead of "fetch+ack ALL pending group messages then filter client-side"
    -- (which destroyed the user's inbox on every thread view).
    CREATE TABLE IF NOT EXISTS thread_replies (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      parent_message_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_username TEXT NOT NULL,
      sender_ai TEXT,
      type TEXT NOT NULL DEFAULT 'text',
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_thread_replies_thread ON thread_replies(thread_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_thread_replies_parent ON thread_replies(parent_message_id, timestamp);

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      requester_id TEXT NOT NULL,
      requester_name TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT DEFAULT '',
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
      resolved_at TEXT,
      resolved_by TEXT,
      reason TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (requester_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_group ON approvals(group_id, status);
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

    CREATE TABLE IF NOT EXISTS webhook_tokens (
      token TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      secret TEXT NOT NULL DEFAULT '',
      name TEXT DEFAULT 'webhook',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_tokens_group ON webhook_tokens(group_id);

    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS token_blacklist (
      token_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_token_blacklist_expires ON token_blacklist(expires_at);

    -- Per-user notifications (was a global in-memory array — any user could read/wipe
    -- everyone's notifications. Now scoped per-user, persists across restarts, and
    -- survives multi-instance deploys because it lives in the shared DB.)
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      group_id TEXT,
      sender TEXT,
      sender_ai TEXT,
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read, created_at DESC);

    -- Shared rate-limit counters (was in-memory per-process — bypassable by running
    -- N instances. Now in SQLite so every instance sees the same counters.)
    -- Fixed-window: (key, window_start) → count. Old windows cleaned periodically.
    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (key, window_start)
    );
    CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);
  `);

  return db;
}
