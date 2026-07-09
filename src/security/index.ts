import { createHash, randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';

// ─── Identity ───

export function generateKeyPair(): { publicKey: string; secretKey: string } {
  const pair = nacl.sign.keyPair();
  return {
    publicKey: Buffer.from(pair.publicKey).toString('hex'),
    secretKey: Buffer.from(pair.secretKey).toString('hex'),
  };
}

export function generateHashId(username: string, publicKey: string): string {
  return createHash('sha256')
    .update(`${username}:${publicKey}`)
    .digest('hex')
    .slice(0, 32);
}

// ─── Message Signing ───

export function signMessage(message: string, secretKeyHex: string): string {
  const secretKey = Uint8Array.from(Buffer.from(secretKeyHex, 'hex'));
  const msgBytes = new TextEncoder().encode(message);
  const signed = nacl.sign.detached(msgBytes, secretKey);
  return Buffer.from(signed).toString('hex');
}

export function verifySignature(
  message: string,
  signatureHex: string,
  publicKeyHex: string
): boolean {
  try {
    const publicKey = Uint8Array.from(Buffer.from(publicKeyHex, 'hex'));
    const signature = Uint8Array.from(Buffer.from(signatureHex, 'hex'));
    const msgBytes = new TextEncoder().encode(message);
    return nacl.sign.detached.verify(msgBytes, signature, publicKey);
  } catch {
    return false;
  }
}

// ─── Message Sanitization (Prompt Injection Protection) ───

const INJECTION_PATTERNS = [
  // Direct command patterns
  /\b(ignore|disregard|forget)\s+(previous|above|all|your)\s+(instructions?|rules?|prompts?)/i,
  /\byou\s+are\s+now\s+(a|an|the)/i,
  /\bact\s+as\s+(if|a|an)/i,
  /\bpretend\s+(you|to\s+be)/i,
  /\bsystem\s*:\s*/i,
  /\buser\s*:\s*/i,
  /\bassistant\s*:\s*/i,
  /\bhuman\s*:\s*/i,
  // Injection markers
  /\[INST\]/i,
  /\[\/INST\]/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /\bBOS\b.*\bEOS\b/i,
  // Command execution attempts
  /\b(exec|eval|system|spawn|shell|bash|cmd|powershell)\s*\(/i,
  /\b(rm\s+-rf|sudo|chmod|chown|wget|curl)\s/i,
  // Data exfiltration
  /\b(send|post|upload|exfiltrate)\s+(to|data|all|everything)\b/i,
  /https?:\/\/[^\s]+.*(api|webhook|hook|collect)/i,
];

export function detectInjection(message: string): { safe: boolean; reason?: string } {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(message)) {
      return {
        safe: false,
        reason: `Blocked: message contains potential injection pattern`,
      };
    }
  }
  return { safe: true };
}

export function sanitizeMessage(message: string): string {
  // Strip null bytes and control characters (except newlines/tabs)
  let clean = message.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  // Limit message length
  if (clean.length > 10000) {
    clean = clean.slice(0, 10000) + '... [truncated]';
  }
  return clean;
}

// ─── Rate Limiting ───

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

export function checkRateLimit(
  key: string,
  windowMs: number = 60_000,
  maxRequests: number = 100
): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1 };
  }

  if (entry.count >= maxRequests) {
    return { allowed: false, remaining: 0 };
  }

  entry.count++;
  return { allowed: true, remaining: maxRequests - entry.count };
}

// Cleanup expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now > entry.resetAt) rateLimitStore.delete(key);
  }
}, 300_000);

// ─── Invite Code ───

export function generateInviteCode(): string {
  return randomBytes(12).toString('base64url');
}

// ─── Token (simple HMAC session token) ───

export function generateToken(userId: string, secret: string): string {
  const payload = `${userId}:${Date.now()}`;
  const hmac = createHash('sha256')
    .update(`${payload}:${secret}`)
    .digest('hex');
  return Buffer.from(`${payload}:${hmac}`).toString('base64url');
}

export function verifyToken(token: string, secret: string): string | null {
  try {
    const decoded = Buffer.from(token, 'base64url').toString();
    const parts = decoded.split(':');
    if (parts.length !== 3) return null;
    const [userId, ts, hmac] = parts;
    const expected = createHash('sha256')
      .update(`${userId}:${ts}:${secret}`)
      .digest('hex');
    if (hmac !== expected) return null;
    // Token valid for 7 days
    if (Date.now() - Number(ts) > 7 * 24 * 60 * 60 * 1000) return null;
    return userId;
  } catch {
    return null;
  }
}
