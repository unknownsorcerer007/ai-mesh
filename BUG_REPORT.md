# AI Mesh — Deep Code Review & Bug Report

**Reviewer:** Ponytail-style audit
**Date:** 2026-07-11
**Scope:** Every source file in `src/`

---

## 🔴 CRITICAL BUGS (will crash or cause data loss in production)

### 1. ESM/CJS mismatch — `require()` in ES module project
**File:** `src/blocks/security/crypto.ts` (lines ~75, ~85, ~93)
**Bug:** `blacklistToken()`, `isTokenBlacklisted()`, and `cleanupBlacklist()` all use `require('../../shared/db.js')`. The project is `"type": "module"` in package.json. **`require()` is not available in ESM** — this will throw `ReferenceError: require is not defined` at runtime.

```ts
// BUG: require() in ESM
export function blacklistToken(token: string, ttlMs: number = 7 * 24 * 60 * 60 * 1000) {
  try {
    const { getDb } = require('../../shared/db.js');  // ← CRASH
```

**Fix:** Use dynamic `import()` or, better, import `getDb` at the top of the file like every other module does.

---

### 2. Global mutable user session in MCP — all clients share one identity
**File:** `src/blocks/mcp/universal.ts` (line ~22)
**Bug:** `currentUserId` is a **module-level variable**. If multiple MCP clients connect (e.g., two Claude Code instances), they all share the same `currentUserId`. Client A authenticates, then Client B sends a message — it goes out as Client A.

```ts
let currentUserId: string | null = null;  // ← shared across ALL connections
```

**Fix:** Per-session context. Store userId on the transport/session object, not a global.

---

### 3. Hardcoded session secret bypasses production validation
**File:** `src/blocks/mcp/universal.ts` (line ~17)
**Bug:** `SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me'`. This bypasses the production check in `config.ts` that throws if the secret isn't changed. An MCP server started without `SESSION_SECRET` will silently use the insecure default.

```ts
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';  // ← bypasses config validation
```

**Fix:** Use `getConfig().session.secret` instead of re-reading env.

---

### 4. Token TTL mismatch — MCP ignores configured TTL
**File:** `src/blocks/mcp/universal.ts` (line ~55)
**Bug:** `verifyToken(token, SESSION_SECRET)` is called **without** `ttlMs`. It defaults to 7 days. If the admin configures a shorter TTL, MCP still accepts 7-day-old tokens.

**Fix:** `verifyToken(token, SESSION_SECRET, getConfig().session.tokenTtlMs)`

---

### 5. Missing `return` after `reply.send()` in Fastify hook — requests continue after response
**File:** `src/index.ts` (line ~60)
**Bug:** The Content-Type validation hook sends a 415 response but **does not return**. Fastify continues executing subsequent hooks and the route handler. The client gets two responses (415 + whatever the route sends), and the second one overwrites the first.

```ts
app.addHook('preHandler', async (req, reply) => {
  // ...
  if (contentType && !contentType.includes('application/json') && ...) {
    reply.code(415).send({ error: 'UNSUPPORTED_MEDIA_TYPE', ... });
    // ← MISSING: return reply; or just return;
  }
});
```

**Fix:** Add `return reply;` after the send.

---

### 6. Missing `return` in Fastify error handler — double response
**File:** `src/core/errors.ts` (line ~75)
**Bug:** Same pattern. The Fastify validation error branch sends a response but doesn't return.

```ts
if ('validation' in error) {
  reply.code(400).send({ error: 'VALIDATION_ERROR', message: error.message });
  return;  // ← this one is fine, BUT...
}
```

Actually the `AppError` branch **does** return. But the final fallback for unknown errors does NOT check if a reply was already sent. If a previous hook already sent a response, this will throw `Reply was already sent`.

---

### 7. Dockerfile DB path mismatch
**File:** `Dockerfile` (line ~34) vs `src/core/config.ts`
**Bug:** Dockerfile sets `DB_PATH=/app/data/pulse.db` but config defaults to `./data/ai-mesh.db`. The Docker container will use `pulse.db` while local dev uses `ai-mesh.db`. Also the project is called "ai-mesh" but the Dockerfile references "pulse" — leftover from a rename.

---

### 8. GitHub webhook signature not verified — spoofable webhooks
**File:** `src/blocks/webhooks/index.ts`
**Bug:** The webhook endpoint accepts any POST with a valid token but **never verifies** `X-Hub-Signature-256` (GitHub) or `X-Gitlab-Token` headers. Anyone who intercepts or guesses the webhook URL can send fake events. This is a security vulnerability, not just a bug.

---

## 🟠 HIGH SEVERITY (security issues, data integrity)

### 9. Token leaked in URL query parameters
**File:** `src/blocks/auth/routes.ts` (line ~80)
**Bug:** After OAuth callback, the token is placed in the URL: `uiUrl.searchParams.set('token', token)`. URLs are logged in browser history, server access logs, CDN logs, and Referer headers. Tokens should be in headers or POST body.

---

### 10. Log download allows path-adjacent traversal
**File:** `src/blocks/logs/index.ts` (line ~90)
**Bug:** The check `filename.includes('..')` is a weak guard. A filename like `....//....//etc/passwd` doesn't contain literal `..` as a path component but still traverses. The regex `/^[\w-]+\.(log|jsonl)$/` does block this, but the `..` check is misleading dead code that gives false confidence.

---

### 11. Desktop notification command injection
**File:** `src/blocks/notifications/popup.ts` (line ~45)
**Bug:** `execFileSync('notify-send', [..., safeTitle, safeBody])` — the sanitization only strips control characters. On Linux, `notify-send` interprets Pango markup. A message like `<b>bold</b>` will render as bold. A malicious `<span foreground="red">` could inject formatting. More critically, on macOS, the `osascript` path passes user input as shell arguments.

```ts
const safeTitle = title.replace(/[\x00-\x1F\x7F]/g, '').slice(0, 200);
// ← Does NOT escape shell metacharacters for osascript
```

---

### 12. XSS via `X-XSS-Protection` header
**File:** `src/index.ts` (line ~55)
**Bug:** `X-XSS-Protection: 1; mode=block` is deprecated and can actually **introduce** XSS in older IE versions. Modern best practice is to remove it entirely and rely on CSP.

---

### 13. Token blacklist uses `require()` — never actually works
**File:** `src/blocks/security/crypto.ts`
**Bug:** Because of Bug #1, `blacklistToken()` silently fails (the catch swallows the error). Token revocation on logout **does nothing**. A stolen token remains valid until expiry.

```ts
export function blacklistToken(token: string, ttlMs: number) {
  try {
    const { getDb } = require('../../shared/db.js');  // ← throws
    // ...never runs
  } catch { /* db may not be ready */ }  // ← silently swallowed
}
```

---

### 14. Rate limiting is per-process, not shared
**File:** `src/blocks/security/rate-limit.ts`
**Bug:** In-memory `Map` store. If you run 2 instances behind a load balancer, each instance has its own counter. A user can send 120 req/min to instance A and 120 to instance B = 240 total. Rate limiting is effectively bypassed.

---

### 15. WebSocket connection map has no upper bound
**File:** `src/blocks/groups/index.ts` (line ~6)
**Bug:** `userSockets` is a `Map<string, Set<...>>` with no max size. A malicious user could open thousands of connections (despite `MAX_WS_PER_USER = 5` in messages, this map in groups has no limit check). Memory grows unbounded.

---

## 🟡 MEDIUM SEVERITY (logic bugs, dead code, inconsistencies)

### 16. Dead endpoint: `/messages/purge` does nothing
**File:** `src/blocks/messages/index.ts` (line ~170)
```ts
app.post('/messages/purge', async (req, reply) => {
  const userId = authenticate(req);
  if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED' });
  return reply.send({ status: 'ok' });  // ← literally nothing happens
});
```

---

### 17. Thread reply fetching is O(n) — fetches ALL messages then filters
**File:** `src/blocks/threading/index.ts` (line ~90)
**Bug:** `getPendingMessages(userId, thread.group_id)` fetches **all** pending messages for the group, then filters client-side by `parent_message_id`. For large groups, this is extremely wasteful. Should filter at the NATS/JetStream level or use a dedicated subject.

---

### 18. OAuth state cleanup only runs once at startup
**File:** `src/blocks/auth/routes.ts` (line ~30)
**Bug:** `cleanupExpiredOAuthStates()` is called once in `registerAuthRoutes`. Expired states accumulate in SQLite forever (or until restart). Should run periodically or on each auth request.

---

### 19. `@hono/node-server` dependency — unused
**File:** `package.json`
**Bug:** `@hono/node-server` is listed as a dependency and has a `postinstall` hack, but no source file imports Hono. The `postinstall` script copies `.js` to `.mjs` — this is a workaround for a bug that doesn't exist in this codebase. Dead dependency.

---

### 20. TUI stores auth token in plaintext
**File:** `src/tui/chat-widget.ts` (line ~40)
```ts
const STATE_FILE = resolve(process.env.HOME || '~', '.ai-mesh-tui.json');
// Token stored as: { "token": "eyJ...", ... }
```
**Bug:** Token is written to disk in plaintext JSON. Any process on the machine can read it. Should use OS keychain or at minimum file permissions (0600).

---

### 21. `notifyUser` on rejection sends wrong event type
**File:** `src/blocks/groups/index.ts` (line ~80)
```ts
// When rejecting:
notifyUser(joinReq.user_id, {
  type: 'member_joined',  // ← WRONG: should be 'member_rejected' or 'join_rejected'
  payload: { group_id: joinReq.group_id, status: 'rejected' },
});
```

---

### 22. `sendMessage` in MCP doesn't pass `sender_ai`
**File:** `src/blocks/mcp/universal.ts` (line ~90)
**Bug:** The `relayMsg` object doesn't include `sender_ai`. All MCP-sent messages appear as regular user messages, losing the AI agent identity.

```ts
const relayMsg = {
  id: msgId, group_id, sender_id: userId, sender_username: sender.username,
  type, content: clean, metadata, timestamp: now,
  // ← missing: sender_ai
};
```

---

### 23. Search reads 1000 messages per group — no pagination
**File:** `src/blocks/search/index.ts` (line ~40)
**Bug:** `readMessages(gid, 1000, before)` reads up to 1000 messages into memory for every group the user is in. If a user is in 50 groups, that's 50,000 messages loaded into RAM for a single search.

---

### 24. WebSocket `close` event handler uses wrong variable
**File:** `src/blocks/messages/index.ts` (line ~140)
```ts
socket.on('close', () => {
  wsConnections.get(userId)?.delete(socket as any);
  wsRateLimits.delete(socketId);
});
// userId is captured from the closure but might be null if auth failed
// Also, the close handler in the outer scope also deletes from wsRateLimits
```

---

### 25. `getConfig()` caches config but `resetConfig()` is exported
**File:** `src/core/config.ts`
**Bug:** `getConfig()` caches on first call. If env vars change at runtime (common in containers with configmaps), the old config is used forever. `resetConfig()` is exported but never called.

---

## 🔵 LOW SEVERITY (style, minor issues, ponytail opportunities)

### 26. Duplicate `authenticate` import in webhooks
**File:** `src/blocks/webhooks/index.ts`
**Bug:** `authenticate` is imported via `await import('../auth/index.js')` inside each route handler. This dynamic import runs on every request. Should be a static import at the top.

---

### 27. `any` type abuse
**Files:** Multiple (groups, threading, approval, webhooks, logs)
**Bug:** Widespread `as any` casts. Examples: `const group = db.prepare(...) as any;`. These defeat TypeScript's purpose.

---

### 28. `appendFileSync` for logging — blocks event loop
**File:** `src/blocks/logs/index.ts`
**Bug:** Synchronous file I/O (`appendFileSync`) on every message. Under load, this blocks the event loop. Should use `appendFile` (async) or a write stream.

---

### 29. Health check returns empty `lastCheck` string
**File:** Multiple blocks
**Bug:** Most health checks return `lastCheck: ''`. The `getSystemHealth()` function sets `lastCheck` to `new Date().toISOString()` after the check runs, but the initial value is meaningless.

---

### 30. `Hono` postinstall script is a hack
**File:** `package.json`
```json
"postinstall": "node -e \"const fs=require('fs');const p='node_modules/@hono/node-server/dist/index.js';...\""
```
**Bug:** This copies `.js` to `.mjs` for a dependency that isn't even used. Should be removed entirely.

---

### 31. Missing `sender_ai` in thread metadata
**File:** `src/blocks/threading/index.ts`
**Bug:** Thread reply messages don't include `sender_ai` in the RelayMessage. AI agent replies in threads lose their identity.

---

### 32. `execFileSync` import unused in notifications/index.ts
**File:** `src/blocks/notifications/index.ts` (line 3)
```ts
import { execFileSync } from 'node:child_process';
```
This import is unused — `execFileSync` is only used in `popup.ts`.

---

## Summary

| Severity | Count |
|----------|-------|
| 🔴 Critical | 8 |
| 🟠 High | 7 |
| 🟡 Medium | 10 |
| 🔵 Low | 7 |
| **Total** | **32** |

### Top 3 Ponytail Fixes (highest impact, smallest diff)

1. **Bug #1 + #13:** Replace `require()` with `import { getDb } from '../../shared/db.js'` at the top of `crypto.ts`. One import line fixes both the crash AND the broken token blacklist.

2. **Bug #5:** Add `return reply;` in the preHandler hook. One word fix.

3. **Bug #3 + #4:** Replace hardcoded `SESSION_SECRET` in `universal.ts` with `getConfig().session.secret` and pass TTL. Two line changes.
