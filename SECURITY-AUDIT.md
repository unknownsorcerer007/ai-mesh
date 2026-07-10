# 🔴 Security & Scaling Audit — AI Mesh

Deep analysis of all endpoints. Every vulnerability found, organized by severity.

---

## CRITICAL — Scaling Time Par Khatarnak

### 1. Race Condition: Username Change (TOCTOU)
**File:** `src/blocks/auth/routes.ts` (line ~120)
**Attack:** Do concurrent requests to claim same username

```typescript
// CHECK
const existing = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, userId);
if (existing) return reply.code(409);
// ⚠️ GAP — another request sneaks in here
// UPDATE
db.prepare('UPDATE users SET username = ? ...').run(username, ...);
```

**Impact:** Two users can get the same username. Data corruption.
**Scaling risk:** High concurrency = higher chance of collision.

**Fix:** Use UNIQUE constraint + catch error:
```typescript
try {
  db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, userId);
} catch (err) {
  if (err.message.includes('UNIQUE')) return reply.code(409).send({ error: 'USERNAME_TAKEN' });
  throw err;
}
```

---

### 2. Race Condition: Group Join Request
**File:** `src/blocks/groups/index.ts` (line ~130)
**Attack:** Concurrent join requests = duplicate entries

```typescript
const pendingReq = db.prepare("SELECT ... WHERE status = 'pending'").get(...);
if (pendingReq) return reply.code(409);
// ⚠️ GAP — another request creates duplicate
db.prepare('INSERT INTO join_requests ...').run(...);
```

**Impact:** Duplicate join requests in DB. Admin sees same request twice.
**Fix:** Add UNIQUE constraint on `(group_id, user_id)` in `join_requests` table (already exists in schema, but application code doesn't handle the error).

---

### 3. WebSocket: No Connection Limit Per User
**File:** `src/blocks/messages/index.ts` (line ~147)
**Attack:** Open 10,000 WebSocket connections from one account

```typescript
if (!wsConnections.has(userId)) wsConnections.set(userId, new Set());
wsConnections.get(userId)!.add(socket); // No limit!
```

**Impact:** Memory exhaustion. Server crash.
**Scaling risk:** 1000 users × 100 connections = 100,000 sockets in memory.

**Fix:**
```typescript
const MAX_WS_PER_USER = 5;
const sockets = wsConnections.get(userId);
if (sockets && sockets.size >= MAX_WS_PER_USER) {
  socket.close(4029, 'Too many connections');
  return;
}
```

---

### 4. WebSocket: No Message Rate Limiting
**File:** `src/blocks/messages/index.ts` (line ~170)
**Attack:** Flood WebSocket with 10,000 messages/second

```typescript
socket.on('message', (data) => {
  // No rate limit check!
  const msg = JSON.parse(data.toString());
  // ...
});
```

**Impact:** CPU exhaustion, NATS flood.
**Fix:** Add per-socket rate limiter.

---

### 5. NATS Consumer Leak
**File:** `src/blocks/relay/consumers.ts`
**Problem:** `ensureConsumer` creates durable consumers but NEVER deletes them

```typescript
export async function ensureConsumer(groupId: string, userId: string): Promise<string> {
  const durable = `mesh_${userId}_${groupId}`;
  await jsm.consumers.add('MESH_MESSAGES', { durable_name: durable, ... });
  // Never cleaned up!
}
```

**Impact:** Every user×group combination creates a permanent consumer. 1000 users × 100 groups = 100,000 consumers. NATS memory exhaustion.

**Fix:** Add cleanup on group leave / user deletion. Add consumer count monitoring.

---

### 6. In-Memory Maps Don't Survive Restart
**Files:** Multiple blocks

| Map | File | Impact on Restart |
|-----|------|-------------------|
| `wsConnections` | messages | All WS connections lost |
| `groupSubscriptions` | messages | All NATS subscriptions lost |
| `userSubscriptions` | messages | All user subscriptions lost |
| `oauthStates` | auth | Pending OAuth flows broken |
| `rateLimitStore` | security | Rate limits reset (attack window) |
| `userSockets` | groups | Notification delivery broken |

**Scaling risk:** Multiple instances = independent maps = no coordination.

**Fix:** Use Redis for shared state, or accept single-instance limitation.

---

### 7. SQLite Write Contention
**File:** `src/shared/db.ts`
**Problem:** SQLite = single writer. All writes serialized.

Under high load:
- 100 concurrent `INSERT INTO group_members` → 99 blocked
- 100 concurrent `UPDATE users SET username` → 99 blocked
- WAL mode helps reads but writes are still serialized

**Impact:** API latency spikes under load. Timeouts.
**Scaling risk:** Cannot horizontally scale (SQLite is file-based).

**Fix:** Switch to PostgreSQL for production. Or accept single-writer limitation.

---

## HIGH — Security Vulnerabilities

### 8. Token in URL (WebSocket Auth)
**File:** `src/blocks/messages/index.ts` (line ~150)
**Attack:** Token leaks via logs, history, referrer

```
ws://host/ws?token=eyJhbGciOi...
```

**Where token appears:**
- Server access logs
- Browser history
- `Referer` header on subsequent requests
- Proxy/CDN logs
- Browser extensions

**Fix:** Use first-message auth:
```typescript
socket.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'auth') {
    const userId = verifyToken(msg.token, secret);
    if (!userId) { socket.close(4003); return; }
    // Now authenticated
  }
});
```

---

### 9. No Request Body Size Limit
**Files:** All POST endpoints
**Attack:** Send 100MB JSON body

```typescript
app.post('/messages', async (req, reply) => {
  const { message } = req.body; // No size check!
});
```

**Impact:** Memory exhaustion, OOM crash.

**Fix:** Add Fastify body limit:
```typescript
const app = Fastify({
  bodyLimit: 1048576, // 1MB
});
```

---

### 10. Health Endpoint Leaks Internal State
**File:** `src/index.ts` (line ~59)
**Attack:** GET /health reveals architecture

```json
{
  "blocks": {
    "relay": { "status": "unhealthy", "message": "NATS not connected" },
    "auth": { "status": "healthy" }
  }
}
```

**Impact:** Attacker knows which components are down, can target weak points.

**Fix:** In production, return simplified status:
```typescript
app.get('/health', async () => {
  const health = await getSystemHealth();
  if (config.server.nodeEnv === 'production') {
    return { status: health.status }; // No block details
  }
  return health;
});
```

---

### 11. Token Never Invalidated
**File:** `src/blocks/security/crypto.ts`
**Problem:** Token valid for 7 days, no revocation

**Impact:** Stolen token = 7 days of access. No logout. No revoke.

**Fix:** Add token blacklist (Redis) or short-lived tokens + refresh tokens.

---

### 12. Invite Code Brute Force
**File:** `src/blocks/groups/index.ts` (line ~117)
**Attack:** Try random invite codes

```typescript
app.post('/groups/join', async (req, reply) => {
  const { invite_code } = req.body;
  // Rate limit is per-user, not per-IP
  // Attacker creates new accounts and tries codes
});
```

**Impact:** Attacker can find valid invite codes by brute force.

**Fix:** Add per-IP rate limiting. Add account creation rate limiting.

---

### 13. WebSocket Authentication Bypass Risk
**File:** `src/blocks/messages/index.ts` (line ~152)
**Problem:** Fake request object bypasses Fastify hooks

```typescript
const userId = authenticate({ headers: { authorization: `Bearer ${token}` } } as any);
```

**Impact:** Any Fastify preValidation/preHandler hooks are bypassed.

---

### 14. Log File Disk Exhaustion
**File:** `src/blocks/logs/index.ts`
**Attack:** Send millions of messages, fill disk

```typescript
export function logMessage(params) {
  appendFileSync(logFile, line); // No size check!
}
```

**Impact:** Disk full = server crash.

**Fix:** Add log rotation. Monitor disk usage.

---

## MEDIUM — Design Issues

### 15. No Message Deduplication
**File:** `src/blocks/messages/index.ts`
**Problem:** If NATS publish succeeds but server crashes before WS delivery, message is re-delivered on reconnect. No deduplication.

**Impact:** Users see duplicate messages.

**Fix:** Use message ID for deduplication on client side.

---

### 16. `getAllPendingMessages` is O(n) Sequential
**File:** `src/blocks/relay/consumers.ts`
**Problem:** Fetches from NATS sequentially per group

```typescript
for (const gid of groupIds) {
  const msgs = await getPendingMessages(userId, gid); // Sequential!
  all.push(...msgs);
}
```

**Impact:** User in 100 groups = 100 sequential NATS fetches = slow inbox.

**Fix:** Use `Promise.all` for parallel fetch.

---

### 17. No CORS Preflight Caching
**File:** `src/index.ts`
**Problem:** No `Access-Control-Max-Age` header

**Impact:** Every cross-origin request sends OPTIONS preflight = 2x requests.

---

### 18. No Content-Type Validation
**Files:** All POST endpoints
**Problem:** Accepts any Content-Type

**Fix:** Add `Content-Type: application/json` check.

---

### 19. Missing Group Deletion
**File:** `src/blocks/groups/index.ts`
**Problem:** No endpoint to delete a group

**Impact:** Compromised group can't be deleted. Orphaned data.

---

### 20. Thundering Herd on Reconnect
**File:** `src/blocks/messages/index.ts`
**Problem:** Server restart → all clients reconnect simultaneously

**Impact:** Connection spike overwhelms server.

**Fix:** Client-side jitter on reconnect:
```javascript
const delay = Math.random() * 5000 + 1000; // 1-6 seconds
setTimeout(connectWs, delay);
```

---

## LOW — Minor Issues

### 21. `group_type` Not Validated at App Level
DB CHECK constraint handles it, but error message may leak DB internals.

### 22. No `X-Content-Type-Options: nosniff` Header
Static responses don't set security headers.

### 23. Error Messages Leak Internals
`err.message` in catch blocks may contain stack traces in development.

### 24. No Database Migrations
Schema changes require manual intervention. No versioning.

### 25. No Monitoring/Metrics
No Prometheus endpoint. No request duration tracking. No alerting.

---

## Scaling Roadmap

| Problem | Current | Fix |
|---------|---------|-----|
| Rate limiting | In-memory per process | Redis |
| WebSocket state | In-memory per process | Redis Pub/Sub |
| Database | SQLite (single writer) | PostgreSQL |
| NATS consumers | Never cleaned | TTL + cleanup job |
| OAuth state | In-memory | Redis with TTL |
| Log files | Unlimited | Log rotation + size limit |
| Token revocation | None | Redis blacklist |
| Horizontal scaling | Impossible | Redis + PostgreSQL |

---

## Priority Fix Order

1. **Race conditions** (TOCTOU) — Data corruption risk
2. **WS connection limit** — DoS risk
3. **Body size limit** — OOM risk
4. **NATS consumer leak** — Resource exhaustion
5. **Token in URL** — Credential leak
6. **Health endpoint** — Info disclosure
7. **Log rotation** — Disk exhaustion
8. **Rate limiting per IP** — Brute force protection
9. **PostgreSQL migration** — Scaling foundation
10. **Redis for shared state** — Horizontal scaling

---

*Audit: 2026-07-10*
