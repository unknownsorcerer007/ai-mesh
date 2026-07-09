import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { GitHub } from 'arctic';
import { nanoid } from 'nanoid';
import db from '../db/index.js';
import { generateKeyPair, generateHashId, generateToken, verifyToken } from '../security/index.js';
import type { User } from '../types/index.js';

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const CALLBACK_URL = process.env.GITHUB_CALLBACK_URL || 'http://localhost:3737/auth/github/callback';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

let github: GitHub | null = null;

function getGitHub(): GitHub {
  if (!github) {
    if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
      throw new Error('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET required');
    }
    github = new GitHub(GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, CALLBACK_URL);
  }
  return github;
}

export function registerAuthRoutes(app: FastifyInstance) {
  // ─── GitHub OAuth: Start ───
  app.get('/auth/github', async (_req, reply) => {
    try {
      const gh = getGitHub();
      const state = nanoid();
      const url = gh.createAuthorizationURL(state, ['read:user']);
      reply.redirect(url.toString());
    } catch (err: any) {
      reply.code(500).send({ error: 'GitHub OAuth not configured', detail: err.message });
    }
  });

  // ─── GitHub OAuth: Callback ───
  app.get('/auth/github/callback', async (req: FastifyRequest<{ Querystring: { code?: string; state?: string } }>, reply) => {
    const { code } = req.query;
    if (!code) return reply.code(400).send({ error: 'Missing code' });

    try {
      const gh = getGitHub();
      const tokens = await gh.validateAuthorizationCode(code);
      const userRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${tokens.accessToken()}`, 'User-Agent': 'ai-mesh' },
      });
      const ghUser = await userRes.json() as { id: number; login: string };

      if (!ghUser.id || !ghUser.login) {
        return reply.code(401).send({ error: 'Failed to fetch GitHub user' });
      }

      // Check if user exists by github_id
      let user = db.prepare('SELECT * FROM users WHERE github_id = ?').get(String(ghUser.id)) as User | undefined;

      if (!user) {
        // New user — they need to claim a username
        const tempId = nanoid();
        const { publicKey, secretKey } = generateKeyPair();
        const tempHash = generateHashId(ghUser.login, publicKey);

        // Create user with github login as initial username
        db.prepare(`
          INSERT INTO users (id, username, hash_id, public_key, github_id, github_username)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(tempId, ghUser.login, tempHash, publicKey, String(ghUser.id), ghUser.login);

        user = db.prepare('SELECT * FROM users WHERE id = ?').get(tempId) as User;

        // Return the secret key ONCE — user must save it
        const token = generateToken(user.id, SESSION_SECRET);
        return reply.send({
          status: 'new_user',
          user: { id: user.id, username: user.username, hash_id: user.hash_id },
          public_key: user.public_key,
          secret_key: secretKey, // ONLY shown once
          token,
          message: 'Save your secret_key! It cannot be recovered.',
        });
      }

      // Existing user
      const token = generateToken(user.id, SESSION_SECRET);
      return reply.send({
        status: 'existing_user',
        user: { id: user.id, username: user.username, hash_id: user.hash_id },
        token,
      });
    } catch (err: any) {
      return reply.code(500).send({ error: 'OAuth failed', detail: err.message });
    }
  });

  // ─── Claim / Change Username ───
  app.post('/auth/username', async (req: FastifyRequest<{ Body: { username: string } }>, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const { username } = req.body;
    if (!username || username.length < 3 || username.length > 30) {
      return reply.code(400).send({ error: 'Username must be 3-30 characters' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      return reply.code(400).send({ error: 'Username: alphanumeric, underscore, hyphen only' });
    }

    // Check uniqueness
    const existing = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, userId);
    if (existing) return reply.code(409).send({ error: 'Username already taken' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as User;
    const newHash = generateHashId(username, user.public_key);

    db.prepare('UPDATE users SET username = ?, hash_id = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(username, newHash, userId);

    return reply.send({ username, hash_id: newHash });
  });

  // ─── Get current user ───
  app.get('/auth/me', async (req, reply) => {
    const userId = authenticate(req);
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });
    const user = db.prepare('SELECT id, username, hash_id, github_username, created_at FROM users WHERE id = ?').get(userId);
    return reply.send(user);
  });
}

// ─── Auth helper ───
export function authenticate(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  return verifyToken(token, SESSION_SECRET);
}
