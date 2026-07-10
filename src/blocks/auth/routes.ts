// Auth: HTTP Routes
// /auth/github, /auth/github/callback, /auth/username, /auth/me

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { GitHub } from 'arctic';
import { nanoid } from 'nanoid';
import { getDb } from '../../shared/db.js';
import { getConfig } from '../../core/config.js';
import { registerHealthCheck, type BlockHealth } from '../../core/health.js';
import { generateKeyPair, generateHashId, generateToken, blacklistToken } from '../security/index.js';
import { authenticate } from './middleware.js';
import type { User } from '../../shared/types.js';

let github: GitHub | null = null;

// ─── OAuth State Helpers (SQLite-backed) ───
function saveOAuthState(state: string) {
  const db = getDb();
  const expiresAt = Date.now() + 10 * 60 * 1000;
  db.prepare('INSERT OR REPLACE INTO oauth_states (state, expires_at) VALUES (?, ?)').run(state, expiresAt);
}

function consumeOAuthState(state: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT expires_at FROM oauth_states WHERE state = ?').get(state) as { expires_at: number } | undefined;
  if (!row) return false;
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
  return row.expires_at > Date.now();
}

function cleanupExpiredOAuthStates() {
  try {
    const db = getDb();
    db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(Date.now());
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

export function registerAuthRoutes(app: FastifyInstance) {
  const config = getConfig();
  const db = getDb();

  // Cleanup expired OAuth states on startup
  cleanupExpiredOAuthStates();

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
  app.get('/auth/github', async (_req, reply) => {
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
      const uiUrl = new URL('/', `${req.protocol}://${req.hostname}`);
      uiUrl.searchParams.set('token', token);
      uiUrl.searchParams.set('username', user.username);
      return reply.redirect(uiUrl.toString());
    } catch (err: any) {
      return reply.code(500).send({ error: 'OAUTH_FAILED', message: err.message });
    }
  });

  // ─── Change Username ───
  app.post('/auth/username', async (req: FastifyRequest<{ Body: { username: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });

    const { username } = req.body;
    if (!username || username.length < 3 || username.length > 30) {
      return reply.code(400).send({ error: 'INVALID_USERNAME', message: 'Username must be 3-30 characters' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      return reply.code(400).send({ error: 'INVALID_USERNAME', message: 'Alphanumeric, underscore, hyphen only' });
    }

    // Fix: Use DB UNIQUE constraint to prevent race condition (TOCTOU)
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as User;
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
      // Fix: Blacklist the token so it can't be reused
      blacklistToken(token, config.session.tokenTtlMs);
    }
    return reply.send({ status: 'logged_out' });
  });
}
