# AI Mesh — Full Code Audit Report
## Production Readiness Assessment

**Date:** 2026-07-17
**Auditor:** AI Agent (full source review)
**Codebase:** ~6,700 lines TypeScript across 41 files
**Architecture:** Block-based, Fastify + NATS JetStream + SQLite

---

## 🔴 CRITICAL BUGS (Must fix before production)

### 1. WebSocket Auth Bypass — `messages/index.ts`
**Severity:** CRITICAL
**File:** `src/blocks/messages/index.ts` — `setupAuthenticatedSocket()`

The WS message handler parses JSON but never validates the `sender_ai` field. A client can set `sender_ai` to ANY value, impersonating other AI agents in messages. The `sendMessageToGroup` function uses `sender_ai` from the input, not from the authenticated user.

```typescript
// Bug: sender_ai is client-controlled, not server-enforced
if (msg.type === 'send_message') {
  sendMessageToGroup(userId, {
    group_id: msg.group_id,
    message: msg.message,
    sender_ai: msg.sender_ai, // ← client can claim to be any agent
  });
}
```

**Impact:** Any authenticated user can impersonate any AI agent in messages.
**Fix:** Server should either ignore client-provided `sender_ai` or validate it against a registered agent list.

---

### 2. Race Condition in Group Deletion — `groups/index.ts`
**Severity:** CRITICAL
**File:** `src/blocks/groups/index.ts` — `registerGroupRoutes` / DELETE `/groups/:id`

The `notifyGroup()` call fires BEFORE the `DELETE` query. If a member receives the notification and immediately sends a message to the group, the message succeeds (group still exists) but arrives AFTER the delete notification. The member's message is then orphaned in NATS with no group.

```typescript
notifyGroup(req.params.id, { ... }); // fires first
db.prepare('DELETE FROM groups WHERE id = ?').run(req.params.id); // then deletes
```

**Impact:** Message ordering inconsistency; orphaned NATS messages.
**Fix:** Delete group first, then notify. Or use a transaction.

---

### 3. NATS JetStream Subject Leak — `relay/subscribe.ts`
**Severity:** CRITICAL
**File:** `src/blocks/relay/subscribe.ts`

Every `subscribeToGroup()` call creates a new subscription. The `groupSubscriptions` Map in `messages/index.ts` deduplicates, but the Map is per-server-instance. In a multi-instance deployment, each instance subscribes independently, and messages are delivered to ALL instances — meaning every instance processes every message, causing duplicate delivery to online users.

**Impact:** In multi-instance deployments, online users receive duplicate messages.
**Fix:** Use NATS queue groups for load balancing across instances.

---

### 4. MCP HTTP Session Fix is Incomplete — `mcp/universal.ts`
**Severity:** CRITICAL
**File:** `src/blocks/mcp/universal.ts` — `startHttp()`

The M8 fix for HTTP sessions has a subtle bug: when a NEW session is created, `handleRequest` is called BEFORE the session ID is known, then the session is indexed. But if the first request creates the session and the second request arrives before `realId` is set, both create separate servers — the original bug is back.

```typescript
await mcpServer.connect(transport);
await transport.handleRequest(req, res); // ← response sent here
const realId = (transport as any).sessionId; // ← might be undefined
if (realId) sessions.set(realId, session);
```

**Impact:** Under concurrent load, HTTP MCP sessions can still lose auth state.
**Fix:** Generate session ID upfront, don't rely on post-hoc extraction.

---

## 🟠 MAJOR BUGS (Should fix before production)

### 5. No CSRF Protection on OAuth Callback — `auth/routes.ts`
**Severity:** MAJOR
**File:** `src/blocks/auth/routes.ts`

The OAuth state is consumed atomically (good), but the `state` parameter is a `nanoid()` — it's not bound to the user's session. An attacker can initiate OAuth, capture the state, and trick a victim into completing the callback, logging the attacker into the victim's session.

**Impact:** OAuth session fixation attack possible.
**Fix:** Bind state to a server-side session cookie, or use PKCE.

---

### 6. Token in URL Fragment — `auth/routes.ts`
**Severity:** MAJOR
**File:** `src/blocks/auth/routes.ts`

After OAuth callback, the token is placed in the URL hash fragment:
```typescript
uiUrl.hash = `token=${token}&username=${encodeURIComponent(user.username)}`;
```

The hash fragment is visible in browser history, Referer headers (in some browsers), and can be captured by any JavaScript on the page. Combined with the static landing page, if there's an XSS vulnerability anywhere, the token is immediately stolen.

**Impact:** Token leakage via browser history, Referer, or XSS.
**Fix:** Use HTTP-only cookies for session management, or short-lived auth codes exchanged server-side.

---

### 7. Rate Limit Cache Poisoning — `security/rate-limit.ts`
**Severity:** MAJOR
**File:** `src/blocks/security/rate-limit.ts`

The in-process `cache` Map never validates that the cached entry belongs to the current window. If a cached entry's `resetAt` is in the past but hasn't been cleaned up yet, it still serves the stale count. The hot path checks `cached.count >= maxRequests` but doesn't check if `now > cached.resetAt`.

```typescript
const cached = cache.get(cacheKey);
if (cached) {
  // Bug: doesn't check if this cache entry is for a STALE window
  if (cached.count >= maxRequests) {
    return { allowed: false, remaining: 0, resetAt };
  }
```

**Impact:** After a window expires, stale cache entries can incorrectly block requests.
**Fix:** Add `if (now > cached.resetAt) cache.delete(cacheKey);` before the count check.

---

### 8. Approval Expiry Race — `approval/index.ts`
**Severity:** MAJOR
**File:** `src/blocks/approval/index.ts`

The auto-expiry cleanup runs every hour. Between cleanup runs, an expired approval can still be responded to because `respondToApproval()` only checks `status = 'pending'`, not `expires_at`. An admin could approve an approval that should have been expired.

**Impact:** Expired approvals can be approved if the cleanup hasn't run yet.
**Fix:** Add `AND (expires_at IS NULL OR expires_at > datetime('now'))` to the WHERE clause in `respondToApproval`.

---

### 9. Search Reads Entire File Into Memory — `search/index.ts`
**Severity:** MAJOR
**File:** `src/blocks/search/index.ts`

`readMessages()` reads the entire JSONL file into memory for each group. A user in 50 groups with 1000 messages each = 50,000 messages in RAM per search. The `SCAN_PER_GROUP = 500` cap helps, but `readMessages()` doesn't actually respect it — it reads ALL lines, then slices.

```typescript
export function readMessages(groupId: string, limit?: number, before?: string): StoredMessage[] {
  const content = readFileSync(file, 'utf-8'); // reads ENTIRE file
  const lines = content.split('\n').filter(Boolean);
  // ... then applies limit AFTER parsing all lines
```

**Impact:** OOM risk with large message histories.
**Fix:** Use streaming reads or SQLite-based search instead of file-based.

---

### 10. Webhook Signature Timing Attack — `webhooks/index.ts`
**Severity:** MAJOR
**File:** `src/blocks/webhooks/index.ts`

The `safeEqual` function returns `false` early when lengths differ:
```typescript
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false; // ← timing leak
  return timingSafeEqual(bufA, bufB);
}
```

This leaks the expected signature length via timing. An attacker can determine the exact length of the expected HMAC.

**Impact:** Information disclosure about signature format.
**Fix:** Always compare against a fixed-length buffer, or pad both to the same length.

---

## 🟡 MODERATE BUGS

### 11. Missing Input Sanitization in Thread Replies — `threading/index.ts`
**Severity:** MODERATE

Thread reply content is stored in `thread_replies` table without sanitization. The `sendMessageToGroup` call sanitizes the message for NATS, but the raw `parsed.data.message` is stored directly in `thread_replies`:

```typescript
db.prepare(`INSERT INTO thread_replies ... VALUES (?,?,?,?,?,?,?,?,?,?)`)
  .run(..., parsed.data.message, ...); // ← unsanitized
```

**Impact:** Stored XSS if thread replies are rendered in a web UI.
**Fix:** Use `sanitizeMessage()` before storing.

---

### 12. User Deletion Doesn't Clean Up — `auth/routes.ts`
**Severity:** MODERATE

There's no user deletion endpoint. When a user leaves a group, their messages in NATS are still delivered to the consumer. Their reactions, thread replies, and approvals remain in the database. There's no GDPR-compliant data deletion path.

**Impact:** Data retention violation; zombie data in multiple tables.
**Fix:** Implement user deletion cascade or soft-delete.

---

### 13. Invite Code Rotation Missing — `groups/index.ts`
**Severity:** MODERATE

Invite codes are generated once and never expire. If a code is leaked, anyone can join the group forever. There's no way to rotate or revoke an invite code without deleting the entire group.

**Impact:** Permanent access from leaked invite codes.
**Fix:** Add invite code expiry and rotation endpoint.

---

### 14. No Pagination on Group Members — `groups/index.ts`
**Severity:** MODERATE

`GET /groups/:id` returns ALL members in a single response. For groups with thousands of members, this is a DoS vector.

**Impact:** Memory exhaustion with large groups.
**Fix:** Add pagination with cursor.

---

### 15. Emoji Validation Regex Incomplete — `reactions/index.ts`
**Severity:** MODERATE

The `EMOJI_RE` regex doesn't cover all valid emoji (e.g., keycap sequences `1️⃣`, flag sequences 🇺🇸, some ZWJ sequences). Users may be unable to react with valid emoji.

**Impact:** False rejections on valid emoji.
**Fix:** Use a dedicated emoji validation library or relax the regex.

---

### 16. No Message Deduplication — `relay/consumers.ts`
**Severity:** MODERATE

`getPendingMessages` fetches and acks messages, but there's no deduplication. If a message is fetched but the ack fails (network issue), it will be redelivered. The MCP `receive_messages` tool saves to local storage without checking for duplicates.

**Impact:** Duplicate messages in local storage.
**Fix:** Check message ID before saving.

---

## 🔵 MINOR ISSUES

### 17. Hardcoded NATS Stream Name
All NATS operations use `'MESH_MESSAGES'` hardcoded. Can't run multiple instances with different stream names on the same NATS cluster.

### 18. No Graceful NATS Consumer Cleanup on User Deletion
When a user is removed from a group, `removeConsumer` is called but errors are silently swallowed. If NATS is temporarily down, the consumer lingers forever.

### 19. Log File Rotation is Size-Based, Not Time-Based
`cleanOldLogs()` keeps `MAX_LOG_FILES * 2` files regardless of age. A high-traffic instance could rotate through 24 files in a day, losing older logs.

### 20. Missing `Content-Security-Policy` Header
The landing page serves inline JavaScript without CSP. Any XSS vulnerability is immediately exploitable.

### 21. No Request ID in Error Responses
Error responses don't include a request ID, making it hard to correlate client errors with server logs.

### 22. WebSocket Rate Limit is Per-Socket, Not Per-User
`wsRateLimits` is keyed by `socketId`, not `userId`. A user with 5 sockets gets 5× the rate limit.

### 23. No Message Edit/Delete
Once sent, messages cannot be edited or deleted. This is a significant UX gap for production use.

### 24. Missing CORS Configuration Validation
If `CORS_ORIGIN` is empty in production, the fallback is `['https://' + (process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost')]` — which silently breaks if neither env var is set.

---

## 🟢 PRODUCTION READINESS CHECKLIST

| Category | Status | Notes |
|----------|--------|-------|
| **Auth** | ⚠️ | OAuth state fixation, token in URL fragment |
| **Authorization** | ✅ | Group-based, admin/member roles, self-approval guard |
| **Input Validation** | ⚠️ | Zod schemas good, but thread replies unsanitized |
| **Rate Limiting** | ⚠️ | SQLite-backed (good), but cache bug + WS per-socket |
| **Injection Detection** | ⚠️ | Token-level only, semantic detection missing |
| **Secret Management** | ✅ | HMAC tokens, hashed blacklist, no plaintext secrets |
| **Error Handling** | ✅ | AppError hierarchy, production-safe error messages |
| **Database** | ✅ | WAL mode, foreign keys, busy_timeout, migrations |
| **NATS** | ⚠️ | Auto-reconnect good, but duplicate delivery in multi-instance |
| **Logging** | ✅ | Audit logs, admin-filtered, size-capped |
| **Docker** | ✅ | Non-root, multi-stage, healthcheck |
| **Graceful Shutdown** | ✅ | Signal handlers, resource cleanup |
| **Monitoring** | ✅ | Per-block health checks |
| **CORS** | ⚠️ | Works but fragile fallback |
| **HTTPS** | ❌ | No TLS termination, no cert management |
| **Multi-Instance** | ❌ | Rate limit cache, WS registry, subscription dedup all break |
| **Data Retention** | ❌ | No user deletion, no message TTL, no GDPR compliance |
| **Backup/Restore** | ❌ | No backup strategy for SQLite or NATS |

---

## 📊 SUMMARY

| Severity | Count |
|----------|-------|
| 🔴 Critical | 4 |
| 🟠 Major | 6 |
| 🟡 Moderate | 6 |
| 🔵 Minor | 8 |
| **Total** | **24** |

---

## 🎯 TOP 3 PRIORITIES FOR PRODUCTION

1. **Fix WS impersonation** (Critical #1) — server must enforce `sender_ai`, not trust client
2. **Fix multi-instance message duplication** (Critical #3) — use NATS queue groups
3. **Move session to HTTP-only cookies** (Major #6) — stop leaking tokens in URL fragments

---

## 💡 ARCHITECTURE OBSERVATIONS

**What's Good:**
- Block-based architecture is clean and well-isolated
- Shared business logic prevents REST/MCP drift
- SQLite + WAL is a solid choice for this scale
- Rate limiting is well-thought-out (per-IP + per-account + exponential backoff)
- Approval system is production-grade (atomic transitions, self-approval guard)
- Webhook signature verification is correct (raw body capture)
- MCP local store has proper path traversal protection

**What Needs Work:**
- Multi-instance support is incomplete (several in-memory state maps)
- No TLS/HTTPS termination
- No data retention policies
- Search is file-based (should be SQLite-based)
- No message edit/delete capability
- No backup/restore strategy
