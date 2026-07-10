// Security: Cryptographic Utilities
// Key generation, hashing, tokens, signing

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import nacl from 'tweetnacl';

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
  // Fix: Check blacklist first
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

// ─── Token Blacklist (in-memory, per-instance) ───
const tokenBlacklist = new Set<string>();
const blacklistExpiry = new Map<string, number>();

export function blacklistToken(token: string, ttlMs: number = 7 * 24 * 60 * 60 * 1000) {
  tokenBlacklist.add(token);
  blacklistExpiry.set(token, Date.now() + ttlMs);
}

export function isTokenBlacklisted(token: string): boolean {
  return tokenBlacklist.has(token);
}

// Cleanup expired blacklist entries
const blacklistCleanup = setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of blacklistExpiry) {
    if (now > expiry) {
      tokenBlacklist.delete(token);
      blacklistExpiry.delete(token);
    }
  }
}, 300_000);
blacklistCleanup.unref();
