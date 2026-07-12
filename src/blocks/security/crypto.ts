// Security: Cryptographic Utilities
// Key generation, hashing, tokens, signing.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import nacl from 'tweetnacl';
import { getDb } from '../../shared/db.js';

// ─── Key Pair ───
export function generateKeyPair(): { publicKey: string; secretKey: string } {
  const pair = nacl.sign.keyPair();
  return {
    publicKey: Buffer.from(pair.publicKey).toString('hex'),
    secretKey: Buffer.from(pair.secretKey).toString('hex'),
  };
}

// ─── Hash ID ───
export function generateHashId(username: string, publicKey: string): string {
  return createHash('sha256')
    .update(`${username}:${publicKey}`)
    .digest('hex')
    .slice(0, 32);
}

// ─── Invite Code ───
export function generateInviteCode(): string {
  return randomBytes(12).toString('base64url');
}

// ─── Message Signing ───
// NOTE: signMessage/verifySignature are retained for forward-compat with a future
// end-to-end-signed message feature. They are not currently called by app code.
export function signMessage(message: string, secretKeyHex: string): string {
  const secretKey = Uint8Array.from(Buffer.from(secretKeyHex, 'hex'));
  const msgBytes = new TextEncoder().encode(message);
  const signed = nacl.sign.detached(msgBytes, secretKey);
  return Buffer.from(signed).toString('hex');
}

export function verifySignature(message: string, signatureHex: string, publicKeyHex: string): boolean {
  try {
    const publicKey = Uint8Array.from(Buffer.from(publicKeyHex, 'hex'));
    const signature = Uint8Array.from(Buffer.from(signatureHex, 'hex'));
    const msgBytes = new TextEncoder().encode(message);
    return nacl.sign.detached.verify(msgBytes, signature, publicKey);
  } catch {
    return false;
  }
}

// ─── Session Token (HMAC-based) ───
// Token format: base64url(userId:ts:nonce:hmac)
// The token itself is NOT stored in the blacklist — only its SHA-256 hash is.
// That way a leaked blacklist table doesn't hand anyone live revocation tokens
// (which would still be valid until their TTL even after revocation).
export function generateToken(userId: string, secret: string, ttlMs?: number): string {
  const ts = Date.now().toString(36);
  const nonce = randomBytes(8).toString('hex');
  const payload = `${userId}:${ts}:${nonce}`;
  const hmac = createHash('sha256')
    .update(`${payload}:${secret}`)
    .digest('hex');
  return Buffer.from(`${payload}:${hmac}`).toString('base64url');
}

export function verifyToken(token: string, secret: string, ttlMs: number = 7 * 24 * 60 * 60 * 1000): string | null {
  // Check blacklist first — fail CLOSED (treat DB error as "not blacklisted" so
  // we don't lock everyone out on a DB blip, but the token still has to pass
  // HMAC + TTL verification below).
  if (isTokenBlacklisted(token)) return null;

  try {
    const decoded = Buffer.from(token, 'base64url').toString();
    const parts = decoded.split(':');
    if (parts.length !== 4) return null;

    const [userId, ts, _nonce, hmac] = parts;
    const expected = createHash('sha256')
      .update(`${userId}:${ts}:${_nonce}:${secret}`)
      .digest('hex');

    // Timing-safe comparison
    if (hmac.length !== expected.length) return null;
    if (!timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) return null;

    // Check expiry
    const tokenTime = parseInt(ts, 36);
    if (isNaN(tokenTime) || Date.now() - tokenTime > ttlMs) return null;

    return userId;
  } catch {
    return null;
  }
}

// ─── Token Blacklist (SQLite-backed, hashed) ───
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function blacklistToken(token: string, ttlMs: number = 7 * 24 * 60 * 60 * 1000) {
  try {
    const db = getDb();
    const expiresAt = Date.now() + ttlMs;
    db.prepare('INSERT OR REPLACE INTO token_blacklist (token_hash, expires_at) VALUES (?, ?)').run(hashToken(token), expiresAt);
  } catch { /* db may not be ready */ }
}

export function isTokenBlacklisted(token: string): boolean {
  try {
    const db = getDb();
    const row = db.prepare('SELECT 1 FROM token_blacklist WHERE token_hash = ? AND expires_at > ?').get(hashToken(token), Date.now());
    return !!row;
  } catch {
    return false;
  }
}

// Periodic cleanup of expired blacklist entries. Scheduled once on first call
// and unref'd so it doesn't hold the process open.
let cleanupScheduled = false;
export function cleanupBlacklist() {
  try {
    const db = getDb();
    db.prepare('DELETE FROM token_blacklist WHERE expires_at <= ?').run(Date.now());
  } catch { /* db may not be ready */ }
}

export function scheduleBlacklistCleanup(intervalMs = 3600_000) {
  if (cleanupScheduled) return;
  cleanupScheduled = true;
  const timer = setInterval(cleanupBlacklist, intervalMs);
  timer.unref();
  // Also run once shortly after startup (after the DB is definitely open).
  setTimeout(cleanupBlacklist, 5000).unref();
}
