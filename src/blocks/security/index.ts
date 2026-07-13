// Block: Security
// Rate limiting, injection detection, message sanitization, crypto utilities
// Zero dependencies on other blocks — pure utility

export {
  checkRateLimit,
  getRateLimitStatus,
  // F-01 + F-05: auth-specific limiter with per-IP + per-account + exp backoff
  checkAuthRateLimit,
  recordAuthFailure,
  recordAuthSuccess,
  scheduleAuthRateLimitCleanup,
} from './rate-limit.js';
export { detectInjection, sanitizeMessage } from './injection.js';
export {
  generateKeyPair, generateHashId, generateInviteCode,
  generateToken, verifyToken, blacklistToken, isTokenBlacklisted, cleanupBlacklist, scheduleBlacklistCleanup,
  signMessage, verifySignature,
} from './crypto.js';
