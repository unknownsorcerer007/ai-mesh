// Auth: HTTP Routes
// /auth/github, /auth/github/callback, /auth/username, /auth/me, /auth/logout, /auth/pat
//
// Security notes:
//  - Post-OAuth redirect uses the configured UI_URL, NEVER the Host header.
//    Host is attacker-controlled; redirecting to it would leak the auth token.
//  - OAuth state consume is a single atomic DELETE ... RETURNING — no TOCTOU.
//  - /auth/github, /auth/github/callback, and /auth/pat use checkAuthRateLimit:
//    per-IP + per-account + exponential backoff (F-01 fix). The per-account
//    dimension is keyed on a hash of the submitted PAT (for /auth/pat) or the
//    OAuth code (for /auth/github/callback). /auth/username uses per-userId
//    limiting (F-05 fix) to blunt username enumeration via 409 vs 200.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { GitHub } from 'arctic';
import { nanoid } from 'nanoid';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../../shared/db.js';
import { getConfig } from '../../core/config.js';
import { registerHealthCheck, type BlockHealth } from '../../core/health.js';
import { generateKeyPair, generateHashId, generateToken, blacklistToken, scheduleBlacklistCleanup } from '../security/index.js';
import {
  checkRateLimit,
  checkAuthRateLimit,
  recordAuthFailure,
  recordAuthSuccess,
  scheduleAuthRateLimitCleanup,
} from '../security/rate-limit.js';
import { authenticate } from './middleware.js';
import { parse, changeUsernameSchema } from '../../shared/validation.js';
import type { User } from '../../shared/types.js';

let github: GitHub | null = null;

// F-04 fix: GitHub PAT format is ghp_ followed by 36 chars of [A-Za-z0-9].
// Classic PATs are exactly 40 chars (ghp_ + 36). Fine-grained PATs use the
// github_pat_ prefix and are longer, but this route only accepts classic PATs
// (documented behaviour). Reject anything that doesn't match the exact format
// BEFORE it reaches the GitHub API — saves a network round-trip and prevents
// the route from being used as a free validation oracle for malformed tokens.
const patSchema = z.string().regex(
  /^ghp_[A-Za-z0-9]{36}$/,
  'Provide a valid GitHub Personal Access Token (ghp_ followed by 36 alphanumeric characters)',
);

// Helper: hash a PAT/code for use as an account-key in the rate limiter.
// We never store the raw token — only its SHA-256 hash. Even if the
// auth_failures table leaks, attackers can't reverse it back to a live token.
function hashAccountKey(raw: string): string {
  return 'acct:' + createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

// Standard auth rate-limit profile for login endpoints.
// Tunable via env in a future iteration; these defaults are conservative.
const AUTH_RL_PROFILE = {
  windowMs: 60_000,           // 1 minute
  ipMaxRequests: 20,          // 20 req/min per IP (soft cap)
  accountMaxRequests: 10,     // 10 req/min per account
  maxFailures: 5,             // 5 failures before backoff kicks in
  backoffBaseMs: 1_000,       // first backoff tier: 1 second
  maxBackoffMs: 15 * 60_000,  // cap at 15 minutes
};

// ─── OAuth State Helpers (SQLite-backed, atomic consume) ───
function saveOAuthState(state: string) {
  const db = getDb();
  const expiresAt = Date.now() + 10 * 60 * 1000;
  db.prepare('INSERT OR REPLACE INTO oauth_states (state, expires_at) VALUES (?, ?)').run(state, expiresAt);
}

// Atomic consume: a single DELETE that only succeeds if the row exists and is
// not expired. Two concurrent requests with the same state can't both succeed —
// the first DELETE removes the row, the second affects 0 rows.
function consumeOAuthState(state: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM oauth_states WHERE state = ? AND expires_at > ?').run(state, Date.now());
  return result.changes > 0;
}

function cleanupExpiredOAuthStates() {
  try {
    getDb().prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(Date.now());
  } catch { /* db may not be ready */ }
}

function getGitHub(): GitHub {
  if (!github) {
    const config = getConfig();
    if (!config.github.clientId || !config.github.clientSecret) {
      throw new Error('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET required');
    }
    github = new GitHub(config.github.clientId, config.github.clientSecret, config.github.callbackUrl);
  }
  return github;
}

// Per-IP rate limit key (best effort — uses x-forwarded-for if present, else remoteAddress)
function ipKey(req: FastifyRequest): string {
  const xff = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim() || req.ip;
  return `ip:${ip}`;
}

export function registerAuthRoutes(app: FastifyInstance) {
  const config = getConfig();
  const db = getDb();

  // Schedule blacklist cleanup (idempotent — safe to call from multiple blocks)
  scheduleBlacklistCleanup();
  // F-01 fix: schedule cleanup for the new auth_failures + auth_backoff tables.
  // Idempotent — safe to call from multiple blocks.
  scheduleAuthRateLimitCleanup();

  // Cleanup expired OAuth states on startup + periodically
  cleanupExpiredOAuthStates();
  const oauthCleanupTimer = setInterval(cleanupExpiredOAuthStates, 600_000);
  oauthCleanupTimer.unref();

  // Health check
  registerHealthCheck('auth', async (): Promise<BlockHealth> => {
    try {
      db.prepare('SELECT COUNT(*) FROM users').get();
      return { status: 'healthy', lastCheck: '' };
    } catch (err) {
      return { status: 'unhealthy', message: String(err), lastCheck: '' };
    }
  });

  // ─── GitHub OAuth: Start ───
  app.get('/auth/github', async (req, reply) => {
    // F-01 fix: per-IP + exponential backoff. No per-account dimension here
    // because the user's identity isn't known yet (they haven't authenticated).
    // The IP soft cap blunts state-table bloat / DoS; the backoff tier kicks in
    // if the same IP keeps hitting this endpoint.
    const rl = checkAuthRateLimit({
      ipKey: ipKey(req),
      routePrefix: 'oauth:start',
      ...AUTH_RL_PROFILE,
      accountMaxRequests: AUTH_RL_PROFILE.ipMaxRequests, // no per-account dim — set equal to IP
    });
    if (!rl.allowed) {
      reply.header('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
      return reply.code(429).send({ error: 'RATE_LIMITED', message: 'Too many login attempts', retry_after_ms: rl.retryAfterMs });
    }

    try {
      const gh = getGitHub();
      const state = nanoid();
      saveOAuthState(state);
      const url = gh.createAuthorizationURL(state, ['read:user']);
      reply.redirect(url.toString());
    } catch (err: any) {
      // F-02 fix: previously this sent err.message straight to the client,
      // leaking Arctic library internals, fetch URLs, and config error strings.
      // Now we log the full error server-side (with the request id) and send a
      // generic message to the client. In development we still surface the
      // message for easier debugging; production gets a masked string.
      req.log.error({ err }, 'oauth start failed');
      const message = config.server.nodeEnv === 'production'
        ? 'Authentication backend unavailable'
        : err.message;
      reply.code(500).send({ error: 'GITHUB_NOT_CONFIGURED', message });
    }
  });

  // ─── GitHub OAuth: Callback ───
  app.get('/auth/github/callback', async (req: FastifyRequest<{ Querystring: { code?: string; state?: string } }>, reply) => {
    // F-01 fix: per-IP + per-account + exponential backoff. The per-account
    // dimension is keyed on the OAuth code (hashed) — same code = same account
    // attempt. This stops an attacker from replaying the same code from
    // different IPs to bypass the IP limit.
    const { code: codeFromQuery } = req.query;
    const accountKey = codeFromQuery ? hashAccountKey(codeFromQuery) : undefined;
    const rl = checkAuthRateLimit({
      ipKey: ipKey(req),
      routePrefix: 'oauth:cb',
      accountKey,
      ...AUTH_RL_PROFILE,
      ipMaxRequests: 30, // callback is hit once per legitimate login; allow a bit more
    });
    if (!rl.allowed) {
      reply.header('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
      return reply.code(429).send({ error: 'RATE_LIMITED', message: 'Too many callback attempts', retry_after_ms: rl.retryAfterMs });
    }

    const { code, state } = req.query;
    if (!code) {
      // F-01: record the failure so repeated empty-callback hits trigger backoff.
      recordAuthFailure({ ipKey: ipKey(req), accountKey, ...AUTH_RL_PROFILE });
      return reply.code(400).send({ error: 'MISSING_CODE', message: 'Missing code' });
    }
    if (!state || !consumeOAuthState(state)) {
      recordAuthFailure({ ipKey: ipKey(req), accountKey, ...AUTH_RL_PROFILE });
      return reply.code(400).send({ error: 'INVALID_STATE', message: 'Invalid or expired OAuth state' });
    }

    try {
      const gh = getGitHub();
      const tokens = await gh.validateAuthorizationCode(code);
      const userRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${tokens.accessToken()}`, 'User-Agent': 'ai-mesh' },
      });
      const ghUser = await userRes.json() as { id: number; login: string };

      if (!ghUser.id || !ghUser.login) {
        recordAuthFailure({ ipKey: ipKey(req), accountKey, ...AUTH_RL_PROFILE });
        return reply.code(401).send({ error: 'GITHUB_FETCH_FAILED', message: 'Failed to fetch GitHub user' });
      }

      let user = db.prepare('SELECT * FROM users WHERE github_id = ?').get(String(ghUser.id)) as User | undefined;

      if (!user) {
        let username = ghUser.login;
        const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
        if (existing) username = `${ghUser.login}_${nanoid(6)}`;

        const newId = nanoid();
        const { publicKey } = generateKeyPair();
        const hashId = generateHashId(username, publicKey);

        db.prepare('INSERT INTO users (id, username, hash_id, public_key, github_id, github_username) VALUES (?,?,?,?,?,?)')
          .run(newId, username, hashId, publicKey, String(ghUser.id), ghUser.login);

        user = db.prepare('SELECT * FROM users WHERE id = ?').get(newId) as User;
      }

      const token = generateToken(user.id, config.session.secret, config.session.tokenTtlMs);
      // F-01: successful auth — clear the failure/backoff counter for this accountKey.
      recordAuthSuccess(accountKey);

      // SECURITY: redirect to the configured UI_URL, not to a URL built from the
      // Host header. Host is attacker-controlled — redirecting to `host/#token=…`
      // would hand the auth token to an attacker who sets Host: evil.com.
      const uiUrl = new URL(config.server.uiUrl);
      uiUrl.hash = `token=${token}&username=${encodeURIComponent(user.username)}`;
      return reply.redirect(uiUrl.toString());
    } catch (err: any) {
      // F-02 fix: see note above. OAuth exchange failures can include the
      // upstream GitHub URL, the HTTP status, and library stack frames — none
      // of which the client needs. Log full detail, send generic message.
      req.log.error({ err }, 'oauth callback failed');
      // F-01: record the failure for backoff tracking.
      recordAuthFailure({ ipKey: ipKey(req), accountKey, ...AUTH_RL_PROFILE });
      const message = config.server.nodeEnv === 'production'
        ? 'Authentication exchange failed'
        : err.message;
      return reply.code(500).send({ error: 'OAUTH_FAILED', message });
    }
  });

  // ─── Change Username ───
  // F-05 fix: this route is an enumeration oracle — a 409 USERNAME_TAKEN vs a
  // 200 success tells an authenticated attacker whether a given username exists.
  // Without a per-userId limit, an attacker could brute-force the entire
  // username space at line rate. We now cap at 5 attempts per hour per user,
  // which is generous for legitimate use (a user rarely changes their username
  // more than once a week) but kills brute-force at scale.
  app.post('/auth/username', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    // Per-userId rate limit (5 changes/hour). Uses the original checkRateLimit
    // — this isn't a login endpoint, so exponential backoff doesn't apply.
    const rl = checkRateLimit(`username:${userId}`, 3600_000, 5);
    if (!rl.allowed) {
      reply.header('Retry-After', Math.ceil((rl.resetAt - Date.now()) / 1000));
      return reply.code(429).send({ error: 'RATE_LIMITED', message: 'Too many username changes — try again later' });
    }

    const parsed = parse(changeUsernameSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: 'INVALID_USERNAME', message: parsed.error });
    const { username } = parsed.data;

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as User | undefined;
    if (!user) return reply.code(404).send({ error: 'USER_NOT_FOUND' });
    const newHash = generateHashId(username, user.public_key);

    try {
      db.prepare("UPDATE users SET username = ?, hash_id = ?, updated_at = datetime('now') WHERE id = ?")
        .run(username, newHash, userId);
    } catch (err: any) {
      if (err.message?.includes('UNIQUE') || err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return reply.code(409).send({ error: 'USERNAME_TAKEN' });
      }
      throw err;
    }

    return reply.send({ username, hash_id: newHash });
  });

  // ─── Get Current User ───
  app.get('/auth/me', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });
    const user = db.prepare('SELECT id, username, hash_id, github_username, created_at FROM users WHERE id = ?').get(userId);
    if (!user) return reply.code(404).send({ error: 'USER_NOT_FOUND' });
    return reply.send(user);
  });

  // ─── Logout (token revocation) ───
  app.post('/auth/logout', async (req, reply) => {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const token = auth.slice(7);
      blacklistToken(token, config.session.tokenTtlMs);
    }
    return reply.send({ status: 'logged_out' });
  });

  // ─── Register with username + password ───
  // Creates account in DB. Username must be unique (DB UNIQUE constraint).
  // Password is hashed with scrypt (stdlib). Returns session token.
  // Rate-limited per-IP to blunt mass account creation.
  app.post('/auth/register', async (req: FastifyRequest<{ Body: { username: string; password: string } }>, reply) => {
    const rl = checkRateLimit(`register:${ipKey(req)}`, 3600_000, 10); // 10/hour per IP
    if (!rl.allowed) {
      reply.header('Retry-After', Math.ceil((rl.resetAt - Date.now()) / 1000));
      return reply.code(429).send({ error: 'RATE_LIMITED', message: 'Too many registrations from this IP' });
    }

    const { username, password } = req.body ?? {};
    if (!username || !password) {
      return reply.code(400).send({ error: 'INVALID_REQUEST', message: 'username and password are required' });
    }

    const { registerUser } = await import('./username-auth.js');
    const result = registerUser({ username, password });
    if (!result.ok) return reply.code(result.status).send({ error: result.code, message: result.message });

    return reply.code(201).send({
      token: result.data.token,
      user_id: result.data.user_id,
      username: result.data.username,
    });
  });

  // ─── Login with username + password ───
  // Verifies credentials against DB. Rate-limited per-account (10/min).
  app.post('/auth/login', async (req: FastifyRequest<{ Body: { username: string; password: string } }>, reply) => {
    const { username, password } = req.body ?? {};
    if (!username || !password) {
      return reply.code(400).send({ error: 'INVALID_REQUEST', message: 'username and password are required' });
    }

    const { loginUser } = await import('./username-auth.js');
    const result = loginUser({ username, password });
    if (!result.ok) return reply.code(result.status).send({ error: result.code, message: result.message });

    return reply.send({
      token: result.data.token,
      user_id: result.data.user_id,
      username: result.data.username,
    });
  });

  // ─── Login with GitHub PAT ───
  // Documented as a fallback for environments where the OAuth flow can't run
  // (headless servers, CI). F-01 + F-04 fix: per-IP + per-account (hashed PAT)
  // + exponential backoff, AND strict PAT format validation so malformed tokens
  // are rejected before reaching the GitHub API.
  app.post('/auth/pat', async (req: FastifyRequest<{ Body: { pat: string } }>, reply) => {
    const { pat: rawPat } = req.body ?? {};

    // F-04: strict format check BEFORE rate-limiting or hitting GitHub.
    // Rejects "ghp_x" (5 chars), "ghp_", "not_a_token", null, etc. The previous
    // `pat.startsWith('ghp_')` check let any string starting with ghp_ through,
    // turning the route into a free validation oracle.
    const patResult = patSchema.safeParse(rawPat);
    if (!patResult.success) {
      return reply.code(400).send({ error: 'INVALID_PAT', message: patResult.error.issues[0]?.message || 'Invalid PAT format' });
    }
    const pat = patResult.data;

    // F-01: per-IP + per-account + exponential backoff. The account key is the
    // SHA-256 hash of the PAT — same PAT = same account, even from different IPs.
    const accountKey = hashAccountKey(pat);
    const rl = checkAuthRateLimit({
      ipKey: ipKey(req),
      routePrefix: 'pat',
      accountKey,
      ...AUTH_RL_PROFILE,
      ipMaxRequests: 10, // PAT login is rarer than OAuth; tighter IP cap
    });
    if (!rl.allowed) {
      reply.header('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
      return reply.code(429).send({ error: 'RATE_LIMITED', message: 'Too many PAT login attempts', retry_after_ms: rl.retryAfterMs });
    }

    try {
      const userRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${pat}`, 'User-Agent': 'ai-mesh' },
      });
      const ghUser = await userRes.json() as { id: number; login: string };

      if (!ghUser.id || !ghUser.login) {
        // F-01: record the failure — same PAT failing repeatedly triggers backoff.
        recordAuthFailure({ ipKey: ipKey(req), accountKey, ...AUTH_RL_PROFILE });
        return reply.code(401).send({ error: 'INVALID_PAT', message: 'GitHub PAT is invalid or expired' });
      }

      let user = db.prepare('SELECT * FROM users WHERE github_id = ?').get(String(ghUser.id)) as User | undefined;

      if (!user) {
        let username = ghUser.login;
        const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
        if (existing) username = `${ghUser.login}_${nanoid(6)}`;

        const newId = nanoid();
        const { publicKey } = generateKeyPair();
        const hashId = generateHashId(username, publicKey);

        db.prepare('INSERT INTO users (id, username, hash_id, public_key, github_id, github_username) VALUES (?,?,?,?,?,?)')
          .run(newId, username, hashId, publicKey, String(ghUser.id), ghUser.login);

        user = db.prepare('SELECT * FROM users WHERE id = ?').get(newId) as User;
      }

      const token = generateToken(user.id, config.session.secret, config.session.tokenTtlMs);
      // F-01: successful auth — clear the failure/backoff counter for this PAT hash.
      recordAuthSuccess(accountKey);
      return reply.send({ token, username: user.username, user_id: user.id });
    } catch (err: any) {
      // F-02 fix: GitHub API call failures (network, DNS, 5xx) leak fetch
      // internals here. Mask in production; preserve in dev for debugging.
      req.log.error({ err }, 'pat login failed');
      // F-01: record the failure for backoff tracking.
      recordAuthFailure({ ipKey: ipKey(req), accountKey, ...AUTH_RL_PROFILE });
      const message = config.server.nodeEnv === 'production'
        ? 'GitHub authentication failed'
        : err.message;
      return reply.code(500).send({ error: 'PAT_LOGIN_FAILED', message });
    }
  });
}
