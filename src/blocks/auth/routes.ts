// Auth: HTTP Routes
// /auth/github, /auth/github/callback, /auth/username, /auth/me, /auth/logout, /auth/pat
//
// Security notes:
//  - Post-OAuth redirect uses the configured UI_URL, NEVER the Host header.
//    Host is attacker-controlled; redirecting to it would leak the auth token.
//  - OAuth state consume is a single atomic DELETE ... RETURNING — no TOCTOU.
//  - /auth/github and /auth/pat are rate-limited per-IP to blunt OAuth oracle abuse.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { GitHub } from 'arctic';
import { nanoid } from 'nanoid';
import { getDb } from '../../shared/db.js';
import { getConfig } from '../../core/config.js';
import { registerHealthCheck, type BlockHealth } from '../../core/health.js';
import { generateKeyPair, generateHashId, generateToken, blacklistToken, scheduleBlacklistCleanup } from '../security/index.js';
import { checkRateLimit } from '../security/rate-limit.js';
import { authenticate } from './middleware.js';
import { parse, changeUsernameSchema } from '../../shared/validation.js';
import type { User } from '../../shared/types.js';

let github: GitHub | null = null;

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
    // Rate limit per-IP to blunt OAuth-start spam (state-table bloat / DoS).
    const rl = checkRateLimit(`oauth:start:${ipKey(req)}`, 60_000, 20);
    if (!rl.allowed) return reply.code(429).send({ error: 'RATE_LIMITED', message: 'Too many login attempts' });

    try {
      const gh = getGitHub();
      const state = nanoid();
      saveOAuthState(state);
      const url = gh.createAuthorizationURL(state, ['read:user']);
      reply.redirect(url.toString());
    } catch (err: any) {
      reply.code(500).send({ error: 'GITHUB_NOT_CONFIGURED', message: err.message });
    }
  });

  // ─── GitHub OAuth: Callback ───
  app.get('/auth/github/callback', async (req: FastifyRequest<{ Querystring: { code?: string; state?: string } }>, reply) => {
    // Rate limit the callback too — it's the oracle for "is this code valid".
    const rl = checkRateLimit(`oauth:cb:${ipKey(req)}`, 60_000, 30);
    if (!rl.allowed) return reply.code(429).send({ error: 'RATE_LIMITED', message: 'Too many callback attempts' });

    const { code, state } = req.query;
    if (!code) return reply.code(400).send({ error: 'MISSING_CODE', message: 'Missing code' });
    if (!state || !consumeOAuthState(state)) {
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

      // SECURITY: redirect to the configured UI_URL, not to a URL built from the
      // Host header. Host is attacker-controlled — redirecting to `host/#token=…`
      // would hand the auth token to an attacker who sets Host: evil.com.
      const uiUrl = new URL(config.server.uiUrl);
      uiUrl.hash = `token=${token}&username=${encodeURIComponent(user.username)}`;
      return reply.redirect(uiUrl.toString());
    } catch (err: any) {
      return reply.code(500).send({ error: 'OAUTH_FAILED', message: err.message });
    }
  });

  // ─── Change Username ───
  app.post('/auth/username', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

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

  // ─── Login with GitHub PAT ───
  // Documented as a fallback for environments where the OAuth flow can't run
  // (headless servers, CI). Rate-limited per-IP so it can't be abused as a PAT
  // validation oracle at scale.
  app.post('/auth/pat', async (req: FastifyRequest<{ Body: { pat: string } }>, reply) => {
    const rl = checkRateLimit(`pat:${ipKey(req)}`, 60_000, 10);
    if (!rl.allowed) return reply.code(429).send({ error: 'RATE_LIMITED', message: 'Too many PAT login attempts' });

    const { pat } = req.body ?? {};
    if (!pat || !pat.startsWith('ghp_')) {
      return reply.code(400).send({ error: 'INVALID_PAT', message: 'Provide a valid GitHub Personal Access Token (ghp_...)' });
    }

    try {
      const userRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${pat}`, 'User-Agent': 'ai-mesh' },
      });
      const ghUser = await userRes.json() as { id: number; login: string };

      if (!ghUser.id || !ghUser.login) {
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
      return reply.send({ token, username: user.username, user_id: user.id });
    } catch (err: any) {
      return reply.code(500).send({ error: 'PAT_LOGIN_FAILED', message: err.message });
    }
  });
}
