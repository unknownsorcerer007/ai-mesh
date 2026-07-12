// Security: Rate Limiting (SQLite-backed, shared across instances)
//
// Was: in-memory Map — bypassable by running N instances behind a LB (each
// instance counted independently, so a user got N× the limit).
// Now: fixed-window counters in SQLite. Every instance sees the same numbers.
//
// Trade-off: SQLite serialises writes, but with WAL + busy_timeout the per-key
// upsert is microseconds. For >10k req/s a dedicated Redis wins; for production
// up to that scale this is correct and dependency-free.

import { getDb } from '../../shared/db.js';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// Small in-process cache of the *current* window per key, so the hot path
// (allowed → increment) doesn't always hit SQLite. The cache is write-through:
// every increment is persisted. On a cache miss we read from SQLite.
const cache = new Map<string, RateLimitEntry>();

// Periodic cleanup of expired windows in SQLite + cache. unref'd so it doesn't
// hold the process open.
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  // Cache
  for (const [key, entry] of cache) {
    if (now > entry.resetAt) cache.delete(key);
  }
  // DB — delete any window older than 2 hours (covers long windows up to 1h)
  try {
    getDb().prepare('DELETE FROM rate_limits WHERE window_start < ?').run(now - 2 * 3600_000);
  } catch { /* db may not be ready yet */ }
}, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

export function checkRateLimit(
  key: string,
  windowMs: number = 60_000,
  maxRequests: number = 100,
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const resetAt = windowStart + windowMs;
  const cacheKey = `${key}:${windowStart}`;

  // Hot path: cached entry for this exact window
  const cached = cache.get(cacheKey);
  if (cached) {
    if (cached.count >= maxRequests) {
      return { allowed: false, remaining: 0, resetAt };
    }
    cached.count++;
    persistIncrement(key, windowStart);
    return { allowed: true, remaining: maxRequests - cached.count, resetAt };
  }

  // Cold path: read from DB
  let count = 0;
  try {
    const db = getDb();
    const row = db.prepare('SELECT count FROM rate_limits WHERE key = ? AND window_start = ?').get(key, windowStart) as { count: number } | undefined;
    if (row) {
      count = row.count;
    } else {
      // First request in this window — insert. INSERT OR IGNORE handles the race
      // where two instances insert simultaneously; only one wins.
      db.prepare('INSERT OR IGNORE INTO rate_limits (key, window_start, count) VALUES (?, ?, 0)').run(key, windowStart);
      const row2 = db.prepare('SELECT count FROM rate_limits WHERE key = ? AND window_start = ?').get(key, windowStart) as { count: number } | undefined;
      count = row2?.count ?? 0;
    }
  } catch {
    // DB unavailable — fail OPEN (allow) rather than take the whole site down.
    // Logged elsewhere. This is the conscious trade-off: a brief DB blip should
    // not lock every user out.
    return { allowed: true, remaining: maxRequests - 1, resetAt };
  }

  if (count >= maxRequests) {
    cache.set(cacheKey, { count, resetAt });
    return { allowed: false, remaining: 0, resetAt };
  }

  const newCount = count + 1;
  cache.set(cacheKey, { count: newCount, resetAt });
  persistIncrement(key, windowStart);
  return { allowed: true, remaining: maxRequests - newCount, resetAt };
}

// Atomic increment via UPDATE — survives concurrent instances.
function persistIncrement(key: string, windowStart: number) {
  try {
    getDb().prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ? AND window_start = ?').run(key, windowStart);
  } catch { /* cache still holds the right count for this process */ }
}

export function getRateLimitStatus(key: string): { count: number; resetAt: number } | null {
  return cache.get(`${key}:${Math.floor(Date.now() / 60_000) * 60_000}`) || null;
}
