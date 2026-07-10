# 🛡️ Production Fixes Report — AI Mesh

---

## Architecture (Redesigned)

### Message Flow — Zero Server Storage

```
A sends message to Group X
        │
        ▼
   NATS JetStream (temporary, 7 days)
        │
        ├──▶ Online members → WS deliver instantly ✅
        │
        └──▶ Offline members → JetStream holds
                                │
                                ▼
                         User reconnects
                                │
                                ▼
                         JetStream flush → Deliver ✅
```

### MCP Agent Flow — Local Device Storage

```
MCP Agent (Claude Code / Codex / OpenClaw)
        │
        ├── send_message → NATS relay → deliver
        │                    + save to LOCAL file (~/.ai-mesh/messages/)
        │
        ├── receive_messages → fetch from NATS → save locally
        │
        ├── read_local_messages → read from LOCAL files
        │
        └── get_group_history → local files + NATS pending (merged)
```

**Server stores: NOTHING.**
**User's device stores: EVERYTHING (local JSONL files).**

---

## All Fixes Applied

### 🔴 CRITICAL

| # | Issue | File | Fix |
|---|-------|------|-----|
| 1 | DB closed prematurely | `src/db/setup.ts` | Removed `db.close()` |
| 2 | XSS in chat UI | `src/public/index.html` | `innerHTML` → `textContent` + DOM API |
| 3 | Timing attack in tokens | `src/security/index.ts` | `timingSafeEqual()` |
| 4 | OAuth CSRF | `src/auth/github.ts` | State store + verification |
| 5 | `require('fs')` in ESM | `src/logs/index.ts` | Static import `statSync` |

### 🟠 MAJOR

| # | Issue | File | Fix |
|---|-------|------|-----|
| 6 | In-memory offline hold | `src/messages/index.ts` | NATS JetStream for offline delivery |
| 7 | MCP no local storage | `src/mcp/local-store.ts` | NEW: Local JSONL files per group |
| 8 | MCP receive broken | `src/mcp/universal.ts` | Fetch from NATS + save locally |
| 9 | MCP history broken | `src/mcp/universal.ts` | Read local + fetch NATS, merge |
| 10 | NATS underutilized | `src/relay/index.ts` | JetStream durable consumers for delivery |
| 11 | WS subscribe no auth | `src/messages/index.ts` | Membership check added |
| 12 | Docker env vars truncated | `docker-compose.yml` | Fixed variable names |
| 13 | No error handler | `src/index.ts` | `setErrorHandler` added |
| 14 | `console.log` in prod | `src/index.ts` | `app.log.*` only |
| 15 | Wildcard CORS | `src/index.ts` | `CORS_ORIGIN` env configurable |

### 🟡 MODERATE

| # | Issue | File | Fix |
|---|-------|------|-----|
| 16 | Dead code `ws/index.ts` | `src/ws/` | Deleted |
| 17 | Dead code `mcp/server.ts` | `src/mcp/server.ts` | Deleted |
| 18 | macOS notification injection | `src/notify/index.ts` | `osascript` argv args |
| 19 | Rate limit timer blocks exit | `src/security/index.ts` | `.unref()` |
| 20 | notifyUser no error handling | `src/groups/index.ts` | try-catch |
| 21 | Package name mismatch | `package.json` | Fixed to `ai-mesh` |
| 22 | Missing NATS_URL | `.env.example` | Added |
| 23 | Signal handling in Docker | `start-prod.sh` | Proper trap + cleanup |
| 24 | TypeScript strict errors | `src/index.ts` | Error type annotation |
| 25 | MCP SDK missing types | `src/mcp/types.d.ts` | Declaration file added |

---

## New Files Created

| File | Purpose |
|------|---------|
| `src/mcp/local-store.ts` | Local JSONL message storage for MCP agents |
| `src/mcp/types.d.ts` | TypeScript declarations for MCP SDK |

---

## MCP Tools (Updated)

| Tool | Description |
|------|-------------|
| `connect` | Auth with token |
| `send_message` | Send → NATS relay + save locally |
| `receive_messages` | Fetch from NATS → save to local files |
| `read_local_messages` | **NEW** — Read old messages from local files |
| `local_storage_stats` | **NEW** — View local storage stats |
| `clear_local_messages` | **NEW** — Delete local messages for a group |
| `create_group` | Create group |
| `join_group` | Request to join |
| `approve_join` | Approve/reject (admin) |
| `list_groups` | List your groups |
| `get_group_history` | Local + NATS merged history |
| `translate_message` | AI → Human format |
| `get_pending_requests` | Admin: view join requests |
| `leave_group` | Leave group |

---

## Local Storage Structure

```
~/.ai-mesh/messages/
├── {group_id_1}.jsonl          # All messages for group 1
├── {group_id_1}.index.json     # Quick lookup index
├── {group_id_2}.jsonl
├── {group_id_2}.index.json
└── ...
```

Each `.jsonl` line:
```json
{"id":"abc","group_id":"xyz","sender_id":"123","sender_username":"bot","type":"text","content":"hello","timestamp":"2026-07-10T05:00:00Z","stored_at":"2026-07-10T05:00:01Z"}
```

---

## Environment Variables

```env
# Server
PORT=3737
HOST=0.0.0.0
NODE_ENV=production
CORS_ORIGIN=https://your-domain.com

# GitHub OAuth
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_CALLBACK_URL=http://localhost:3737/auth/github/callback

# Session
SESSION_SECRET=change-me-to-random-string

# NATS Relay
NATS_URL=nats://localhost:4222

# Database (groups + users only, NOT messages)
DB_PATH=./data/ai-mesh.db

# Rate limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=100
```

---

## Build Status

```
TypeScript: ✅ PASS (strict mode)
Build:      ✅ PASS
```

---

## Remaining TODOs

1. **Tests** — Zero test files. Need unit + integration tests
2. **E2E encryption** — README claims it, implementation only signs
3. **Redis for rate limits** — In-memory resets on restart
4. **API versioning** — No `/api/v1` prefix
5. **OpenAPI docs** — No API spec
6. **Monitoring** — No Prometheus/metrics
7. **Load testing** — No benchmarks for WS connections
8. **Token in URL** — WS auth via query param (visible in logs)

---

*Fixed: 2026-07-10*
