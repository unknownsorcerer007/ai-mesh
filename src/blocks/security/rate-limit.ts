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

// ═══════════════════════════════════════════════════════════════════════════════
// F-01 + F-05 fix: Auth-specific rate limiter with per-IP + per-account + exp backoff
// ═══════════════════════════════════════════════════════════════════════════════
//
// The original checkRateLimit (above) is a fixed-window counter shared across
// instances. It works for soft caps like "60 messages per user per minute".
// But auth routes need three things it can't do:
//
//   1. Per-IP AND per-account — credential stuffing from a botnet of rotating
//      IPs is unthrottled per-account without the second dimension.
//   2. Exponential backoff — a hard 429 lock means a legitimate user who
//      fat-fingers their password 5 times is locked out as long as a bot that
//      hammers the endpoint 5000 times. The brief specifically asks for
//      exponential backoff: each failure doubles the next wait time.
//   3. Failure-aware tracking — successes should NOT count toward the backoff
//      counter. A user who logs in successfully once shouldn't be one step
//      closer to a lockout.
//
// This new function adds all three. It uses the same SQLite store + cache as
// checkRateLimit (no new dependency), and adds two new tables: auth_failures
// (per-key failure counter with TTL) and auth_backoff (per-key backoff-until
// timestamp). Both are cleaned up periodically.
//
// Design choices:
//   - Per-IP and per-account are checked in OR: whichever fires first triggers
//     the 429. Both counters are independent.
//   - Backoff is per-key (ipKey or accountKey), not per-route. A user who
//     fails login 5 times on /auth/pat will also be backed off on /auth/github.
//   - The backoff formula is: base * 2^(failures - maxFailures), capped at
//     maxBackoffMs. So with base=1s and maxFailures=5, the 6th failure gives
//     1s, the 7th 2s, the 8th 4s, ... capping at e.g. 15 min.
//   - Successful auth (recordAuthSuccess) clears the failure counter for the
//     account key. The IP counter stays — we don't want a single successful
//     login to reset the IP-level defense against a botnet.
//   - The function returns retryAfterMs so the route can set Retry-After.

export interface AuthRateLimitOpts {
  /** Per-IP key, e.g. "ip:1.2.3.4" — required. */
  ipKey: string;
  /** Route-specific prefix, e.g. "pat", "oauth:start". Ensures each auth route
   *  has its OWN IP/account counter — so 10 /auth/pat calls don't lock you out
   *  of /auth/github. The backoff tier is intentionally cross-route (uses the
   *  raw ipKey or accountKey without prefix) so a user who fails on /auth/pat
   *  is also backed off on /auth/github. */
  routePrefix: string;
  /** Per-account key, e.g. "pat:hash(...)" — optional, when identity is known. */
  accountKey?: string;
  /** Base window for the per-IP and per-account counters, in ms. */
  windowMs: number;
  /** Soft cap inside the window for the per-IP counter. */
  ipMaxRequests: number;
  /** Soft cap inside the window for the per-account counter. */
  accountMaxRequests: number;
  /** Failures before exponential backoff kicks in. */
  maxFailures: number;
  /** Base delay for the first backoff tier, in ms. */
  backoffBaseMs: number;
  /** Ceiling for backoff delay, in ms. */
  maxBackoffMs: number;
}

export interface AuthRateLimitResult {
  allowed: boolean;
  /** Milliseconds until the next attempt is allowed (0 if allowed). */
  retryAfterMs: number;
  /** Which dimension fired, for logging. */
  reason?: 'ip' | 'account' | 'backoff';
}

// Helper: compute backoff delay for a given failure count.
// Returns 0 if failures <= maxFailures (still in the "free" tier).
function computeBackoffMs(failures: number, maxFailures: number, baseMs: number, capMs: number): number {
  if (failures <= maxFailures) return 0;
  const exponent = failures - maxFailures;
  // 2^exponent grows fast; cap to avoid pathological waits.
  // Use Math.min with a safe max exponent of 20 (2^20 = ~1M seconds = ~12 days).
  const factor = Math.pow(2, Math.min(exponent, 20));
  return Math.min(capMs, baseMs * factor);
}

export function checkAuthRateLimit(opts: AuthRateLimitOpts): AuthRateLimitResult {
  const now = Date.now();
  // Route-prefixed keys for the soft caps — each route gets its own counter.
  const ipRateKey = `${opts.routePrefix}:${opts.ipKey}`;
  const acctRateKey = opts.accountKey ? `${opts.routePrefix}:${opts.accountKey}` : undefined;

  // ─── 1. Per-IP soft cap (fixed window, per-route) ───
  const ipRl = checkRateLimit(ipRateKey, opts.windowMs, opts.ipMaxRequests);
  if (!ipRl.allowed) {
    return { allowed: false, retryAfterMs: Math.max(0, ipRl.resetAt - now), reason: 'ip' };
  }

  // ─── 2. Per-account soft cap (per-route, only if accountKey provided) ───
  if (acctRateKey) {
    const acctRl = checkRateLimit(acctRateKey, opts.windowMs, opts.accountMaxRequests);
    if (!acctRl.allowed) {
      return { allowed: false, retryAfterMs: Math.max(0, acctRl.resetAt - now), reason: 'account' };
    }
  }

  // ─── 3. Exponential backoff — CROSS-ROUTE (no route prefix) ───
  // The backoff key is the raw accountKey or ipKey (without route prefix).
  // This is intentional: a user who fails login 5× on /auth/pat should also be
  // backed off on /auth/github. The soft caps above are per-route; the backoff
  // tier is the cross-route defense layer.
  const backoffKey = opts.accountKey || opts.ipKey;
  try {
    const db = getDb();
    const row = db.prepare('SELECT backoff_until FROM auth_backoff WHERE key = ?').get(backoffKey) as { backoff_until: number } | undefined;
    if (row && row.backoff_until > now) {
      return { allowed: false, retryAfterMs: row.backoff_until - now, reason: 'backoff' };
    }
  } catch {
    // DB unavailable — fail open (allow). The soft caps above still apply.
  }

  return { allowed: true, retryAfterMs: 0 };
}

// ─── Record a failed auth attempt ───
// Increments the failure counter for the key (accountKey if available, else
// ipKey), then computes and stores the next backoff_until timestamp. Called
// by auth routes after every 401/403 on a login-style endpoint.
export function recordAuthFailure(opts: {
  ipKey: string;
  accountKey?: string;
  maxFailures: number;
  backoffBaseMs: number;
  maxBackoffMs: number;
}): void {
  const key = opts.accountKey || opts.ipKey;
  const now = Date.now();
  const windowMs = 15 * 60_000; // failure counter window: 15 min
  const windowStart = Math.floor(now / windowMs) * windowMs;

  try {
    const db = getDb();
    // Upsert the failure counter for this window. INSERT OR IGNORE handles the
    // race; UPDATE increments atomically.
    db.prepare('INSERT OR IGNORE INTO auth_failures (key, window_start, count) VALUES (?, ?, 0)').run(key, windowStart);
    const result = db.prepare('UPDATE auth_failures SET count = count + 1 WHERE key = ? AND window_start = ?').run(key, windowStart);
    const newCount = (result.changes ?? 0) > 0
      ? (db.prepare('SELECT count FROM auth_failures WHERE key = ? AND window_start = ?').get(key, windowStart) as { count: number } | undefined)?.count ?? 0
      : 0;

    // Compute and store backoff
    const backoffMs = computeBackoffMs(newCount, opts.maxFailures, opts.backoffBaseMs, opts.maxBackoffMs);
    if (backoffMs > 0) {
      const backoffUntil = now + backoffMs;
      db.prepare('INSERT OR REPLACE INTO auth_backoff (key, backoff_until) VALUES (?, ?)').run(key, backoffUntil);
    }
  } catch {
    // DB unavailable — soft fail. The soft caps in checkAuthRateLimit still apply.
  }
}

// ─── Record a successful auth attempt ───
// Clears the failure counter for the account key (the user is legitimate).
// The IP-level counter is NOT cleared — a single successful login from an IP
// shouldn't reset the defense against a botnet running on the same IP.
export function recordAuthSuccess(accountKey?: string): void {
  if (!accountKey) return;
  try {
    const db = getDb();
    db.prepare('DELETE FROM auth_failures WHERE key = ?').run(accountKey);
    db.prepare('DELETE FROM auth_backoff WHERE key = ?').run(accountKey);
  } catch {
    // DB unavailable — soft fail.
  }
}

// ─── Cleanup timer for auth_failures + auth_backoff ───
// Old windows and expired backoffs are deleted periodically.
let authCleanupScheduled = false;
export function scheduleAuthRateLimitCleanup() {
  if (authCleanupScheduled) return;
  authCleanupScheduled = true;
  const timer = setInterval(() => {
    try {
      const db = getDb();
      const now = Date.now();
      // auth_failures: delete any window older than 1 hour
      db.prepare('DELETE FROM auth_failures WHERE window_start < ?').run(now - 3600_000);
      // auth_backoff: delete any expired backoff
      db.prepare('DELETE FROM auth_backoff WHERE backoff_until <= ?').run(now);
    } catch { /* db may not be ready */ }
  }, 5 * 60_000); // every 5 min
  timer.unref();
}
