// Auth: Username + Password registration and login
//
// Uses scrypt from node:crypto (stdlib) — no bcrypt dependency.
// Password is REQUIRED (not optional) — production-grade.
// Username is unique (DB UNIQUE constraint + pre-check).
// After register/login, returns a session token (same HMAC format as OAuth).

import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { nanoid } from 'nanoid';
import { getDb } from '../../shared/db.js';
import { generateKeyPair, generateHashId, generateToken } from '../security/index.js';
import { getConfig } from '../../core/config.js';
import { ok, err, type OpResult } from '../../shared/result.js';
import { checkRateLimit } from '../security/rate-limit.js';

const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_LEN = 16;
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,30}$/;
const PASSWORD_MIN_LEN = 8;
const PASSWORD_MAX_LEN = 1000;

function hashPassword(password: string): string {
  const salt = randomBytes(SCRYPT_SALT_LEN).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  try {
    const sep = stored.indexOf(':');
    if (sep < 0) return false;
    const salt = stored.slice(0, sep);
    const hash = stored.slice(sep + 1);
    const hashBuf = Buffer.from(hash, 'hex');
    const testBuf = scryptSync(password, salt, SCRYPT_KEYLEN);
    if (hashBuf.length !== testBuf.length) return false;
    return timingSafeEqual(hashBuf, testBuf);
  } catch {
    return false;
  }
}

export interface RegisterInput {
  username: string;
  password: string;
}

export function registerUser(input: RegisterInput): OpResult<{ user_id: string; username: string; token: string }> {
  const db = getDb();
  const config = getConfig();

  // Validate username
  if (!input.username || !USERNAME_RE.test(input.username)) {
    return err('INVALID_USERNAME', 'Username must be 3-30 chars: letters, digits, underscore, hyphen only', 400);
  }

  // Validate password (REQUIRED)
  if (!input.password || input.password.length < PASSWORD_MIN_LEN) {
    return err('WEAK_PASSWORD', `Password must be at least ${PASSWORD_MIN_LEN} characters`, 400);
  }
  if (input.password.length > PASSWORD_MAX_LEN) {
    return err('PASSWORD_TOO_LONG', `Password must be ${PASSWORD_MAX_LEN} characters or less`, 400);
  }

  // Check uniqueness (race-safe: UNIQUE constraint will catch concurrent inserts)
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(input.username);
  if (existing) return err('USERNAME_TAKEN', 'Username already taken', 409);

  const id = nanoid();
  const { publicKey } = generateKeyPair();
  const hashId = generateHashId(input.username, publicKey);
  const passwordHash = hashPassword(input.password);

  try {
    db.prepare('INSERT INTO users (id, username, hash_id, public_key, password_hash) VALUES (?,?,?,?,?)')
      .run(id, input.username, hashId, publicKey, passwordHash);
  } catch (e: any) {
    if (e.message?.includes('UNIQUE') || e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return err('USERNAME_TAKEN', 'Username already taken', 409);
    }
    throw e;
  }

  const token = generateToken(id, config.session.secret, config.session.tokenTtlMs);
  return ok({ user_id: id, username: input.username, token });
}

export function loginUser(input: { username: string; password: string }): OpResult<{ user_id: string; username: string; token: string }> {
  const db = getDb();
  const config = getConfig();

  // Per-account rate limit on login attempts (blunts brute-force)
  const rl = checkRateLimit(`login:${input.username}`, 60_000, 10);
  if (!rl.allowed) return err('RATE_LIMITED', 'Too many login attempts — try again later', 429);

  const user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
    .get(input.username) as { id: string; username: string; password_hash: string | null } | undefined;
  if (!user) return err('INVALID_CREDENTIALS', 'Invalid username or password', 401);

  // All accounts have password (REQUIRED at registration)
  if (!user.password_hash || !input.password) {
    return err('INVALID_CREDENTIALS', 'Invalid username or password', 401);
  }
  if (!verifyPassword(input.password, user.password_hash)) {
    return err('INVALID_CREDENTIALS', 'Invalid username or password', 401);
  }

  const token = generateToken(user.id, config.session.secret, config.session.tokenTtlMs);
  return ok({ user_id: user.id, username: user.username, token });
}
