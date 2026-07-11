# AI Mesh — Fixes Applied

**Date:** 2026-07-11
**Total changes:** 16 files, +107 lines, -80 lines

---

## Before vs After — Every Fix Explained

### 🔴 CRITICAL FIXES

---

#### 1. ESM/require crash in crypto.ts
**BEFORE:** `blacklistToken()`, `isTokenBlacklisted()`, `cleanupBlacklist()` used `require()` — a CommonJS function. Since the project is `"type": "module"`, these crashed with `ReferenceError: require is not defined` at runtime.

**Impact:** Token blacklist was completely broken. Logout did nothing. Stolen tokens stayed valid until expiry.

**AFTER:** Replaced `require('../../shared/db.js')` with a static `import { getDb } from '../../shared/db.js'` at the top. All three functions now work correctly.

**Diff:** 3 `require()` calls → 1 static import

---

#### 2. Global MCP user identity shared across all clients
**BEFORE:** `let currentUserId` was a module-level variable. If two MCP clients connected (e.g., two Claude Code instances), they shared the same user. Client A authenticates → Client B sends messages as Client A.

**AFTER:** Created `createAuthContext()` factory. Each `createMcpServer()` call gets its own isolated auth context. In HTTP mode, each connection gets a new `McpServer` instance (moved `createMcpServer()` inside the request handler).

**Diff:** Global variable → per-instance closure

---

#### 3. Hardcoded SESSION_SECRET bypasses production validation
**BEFORE:** `const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me'` — this bypassed the config.ts check that throws in production if the secret isn't set.

**AFTER:** Uses `getConfig().session.secret` which enforces the production validation.

---

#### 4. MCP ignored configured token TTL
**BEFORE:** `verifyToken(token, SESSION_SECRET)` — no TTL parameter, defaults to 7 days regardless of config.

**AFTER:** `verifyToken(token, config.session.secret, config.session.tokenTtlMs)` — uses configured TTL.

---

#### 5. Missing `return` after reply.send() in Fastify hook
**BEFORE:** Content-Type validation sent a 415 response but didn't return. Request continued to the route handler. Client got two responses.

**AFTER:** `return reply.code(415).send(...)` — stops request processing immediately.

---

#### 6. Missing `return` in error handler
**BEFORE:** Error handler branches sent responses without returning. Could cause "Reply already sent" crashes.

**AFTER:** All branches use `return reply.code(...).send(...)`.

---

#### 7. Dockerfile used wrong DB name
**BEFORE:** `DB_PATH=/app/data/pulse.db` — leftover from old project name "pulse". Config defaults to `ai-mesh.db`.

**AFTER:** `DB_PATH=/app/data/ai-mesh.db`

---

### 🟠 HIGH SEVERITY FIXES

---

#### 8. Webhook signatures now verified
**BEFORE:** Anyone who knew the webhook URL could send fake events. No signature verification.

**AFTER:**
- Added `secret` column to `webhook_tokens` table
- Token creation generates a 32-char secret and returns it to the user
- Incoming webhooks verify `X-Hub-Signature-256` (GitHub) and `X-Gitlab-Token` (GitLab) using HMAC-SHA256 with timing-safe comparison
- Generic webhooks without signatures still work (backward compatible)

---

#### 9. Token moved from URL to hash fragment
**BEFORE:** `?token=***` in redirect URL — token logged in browser history, server access logs, CDN logs, Referer headers.

**AFTER:** `#token=***&username=xxx` — hash fragment is never sent to the server, not in access logs, not in Referer. Frontend updated to read from `location.hash` instead of `location.search`.

---

#### 10. Deprecated X-XSS-Protection header removed
**BEFORE:** `X-XSS-Protection: 1; mode=block` — this header is deprecated and can actually introduce XSS in older IE versions.

**AFTER:** Header removed. Security relies on `X-Content-Type-Options`, `X-Frame-Options`, and `Referrer-Policy`.

---

### 🟡 MEDIUM FIXES

---

#### 11. Dead `/messages/purge` endpoint removed
**BEFORE:** Endpoint authenticated the user then returned `{ status: 'ok' }` — did literally nothing.

**AFTER:** Endpoint removed entirely. YAGNI.

---

#### 12. Logging switched to async
**BEFORE:** `appendFileSync()` — blocked the event loop on every message. Under load, server froze.

**AFTER:** `appendFileAsync()` (promisified) — non-blocking. Server responds immediately, log writes happen in background.

---

#### 13. Rejection notification type fixed
**BEFORE:** When admin rejected a join request, notification said `type: 'member_joined'` with `status: 'rejected'` — confusing.

**AFTER:** `type: 'join_rejected'` — correct event type.

---

#### 14. OAuth state cleanup now periodic
**BEFORE:** `cleanupExpiredOAuthStates()` ran once at startup. Expired states accumulated forever.

**AFTER:** Runs every 10 minutes via `setInterval`. Timer is `unref()`'d so it doesn't block process exit.

---

#### 15. Unused `@hono/node-server` dependency removed
**BEFORE:** Listed in package.json with a hacky `postinstall` script that copied `.js` to `.mjs`. Never imported anywhere.

**AFTER:** Removed from dependencies. Postinstall replaced with `echo ok`.

---

#### 16. Unused `execFileSync` import removed
**BEFORE:** `import { execFileSync } from 'node:child_process'` in `notifications/index.ts` — unused, only used in `popup.ts`.

**AFTER:** Import removed.

---

#### 17. Thread reply `sender_ai` field added
**BEFORE:** Thread reply messages didn't include `sender_ai` — AI agent replies lost their identity in threads.

**AFTER:** Thread messages now carry the sender's AI identity.

---

#### 18. `as any` casts fixed in critical paths
**BEFORE:** Approval, auth, and threading routes used `as any` for DB results. Null dereference possible if row didn't exist.

**AFTER:** Proper typed interfaces with null checks. Example: `as any` → `as { username: string } | undefined` with early return on undefined.

---

## Summary

| Category | Before | After |
|----------|--------|-------|
| Token blacklist | Broken (require crash) | Working |
| MCP multi-client | Identity leak | Per-instance isolation |
| Session secret | Insecure default possible | Enforced validation |
| Token TTL | Ignored in MCP | Config-aware |
| Request handling | Double responses | Clean returns |
| Webhook security | Spoofable | Signature verified |
| Token exposure | In URL (logs, history) | In hash fragment (server-never-sees) |
| Logging | Blocking (sync) | Non-blocking (async) |
| Dead code | purge endpoint, hono dep | Removed |
| Type safety | `as any` everywhere | Proper types in critical paths |
