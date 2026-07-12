# AI Mesh — Block Architecture

## Design Principles

1. **Independent Blocks** — One block failing doesn't affect others
2. **Clean Interfaces** — Blocks communicate only through APIs
3. **Fault Isolation** — One block's error doesn't crash others
4. **Independent Update** — Update one block without server downtime
5. **Health Checks** — Every block reports its own status

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    AI Mesh Server                        │
│                  (src/index.ts)                          │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │                Core Layer                        │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐        │   │
│  │  │  Config   │ │  Errors  │ │  Health  │        │   │
│  │  └──────────┘ └──────────┘ └──────────┘        │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │              Shared Layer                        │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐        │   │
│  │  │ Database  │ │  Types   │ │ Translate│        │   │
│  │  └──────────┘ └──────────┘ └──────────┘        │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │              Block Layer (Independent)            │   │
│  │                                                  │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐      │   │
│  │  │  Auth    │  │  Groups  │  │ Messages │      │   │
│  │  │  Block   │  │  Block   │  │  Block   │      │   │
│  │  └──────────┘  └──────────┘  └──────────┘      │   │
│  │                                                  │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐      │   │
│  │  │  Relay   │  │ Security │  │   MCP    │      │   │
│  │  │  Block   │  │  Block   │  │  Block   │      │   │
│  │  └──────────┘  └──────────┘  └──────────┘      │   │
│  │                                                  │   │
│  │  ┌──────────┐  ┌──────────┐                     │   │
│  │  │  Logs    │  │  Notifs  │                     │   │
│  │  │  Block   │  │  Block   │                     │   │
│  │  └──────────┘  └──────────┘                     │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## Block Dependency Map

```
                    ┌──────────┐
                    │  Config  │ (Core)
                    └────┬─────┘
                         │
                    ┌────┴─────┐
                    │ Database │ (Shared)
                    └────┬─────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
    ┌────┴────┐    ┌─────┴────┐    ┌─────┴────┐
    │ Security│    │   Auth   │    │  Relay   │
    └────┬────┘    └─────┬────┘    └─────┬────┘
         │               │               │
         └───────┬───────┘               │
                 │                       │
           ┌─────┴────┐           ┌─────┴────┐
           │  Groups  │           │ Messages │
           └──────────┘           └──────────┘
```

---

## Block Details

### Core Layer (`src/core/`)

| Module | File | Purpose |
|--------|------|---------|
| Config | `config.ts` | Env vars, validation, single source of truth |
| Errors | `errors.ts` | Standardized error types, Fastify error handler |
| Health | `health.ts` | Health check registry, aggregation |

### Shared Layer (`src/shared/`)

| Module | File | Purpose |
|--------|------|---------|
| Database | `db.ts` | SQLite connection, schema setup |
| Types | `types.ts` | Shared TypeScript interfaces |
| Translate | `translate.ts` | AI ↔ Human message translation |

### Block Layer (`src/blocks/`)

#### Auth Block (`src/blocks/auth/`)
- **Purpose:** GitHub OAuth, token management, user CRUD
- **Depends on:** security, shared/db
- **Exports:** `registerAuthRoutes`, `authenticate`
- **Routes:** `/auth/github`, `/auth/github/callback`, `/auth/username`, `/auth/me`
- **Health:** Checks DB connectivity

#### Groups Block (`src/blocks/groups/`)
- **Purpose:** Group CRUD, membership, join requests
- **Depends on:** auth, security, shared/db
- **Exports:** `registerGroupRoutes`, `notifyUser`, `notifyGroup`
- **Routes:** `/groups`, `/groups/:id`, `/groups/join`, `/groups/join/respond`
- **Health:** Checks DB connectivity

#### Messages Block (`src/blocks/messages/`)
- **Purpose:** Message routing, WebSocket, offline delivery
- **Depends on:** relay, auth, security, logs, shared/db
- **Exports:** `registerMessageRoutes`, `cleanupSubscriptions`
- **Routes:** `/messages`, `/messages/inbox`, `/messages/:groupId`, `/ws`
- **Health:** Checks NATS connectivity

#### Relay Block (`src/blocks/relay/`)
- **Purpose:** NATS JetStream connection, pub/sub, offline consumers
- **Depends on:** core/config
- **Exports:** `connectRelay`, `publishToGroup`, `subscribeToGroup`, `ensureConsumer`, `getPendingMessages`
- **Health:** Checks NATS connection status

#### Security Block (`src/blocks/security/`)
- **Purpose:** Rate limiting, injection detection, crypto utilities
- **Depends on:** Nothing (pure utility)
- **Exports:** `checkRateLimit`, `detectInjection`, `generateToken`, `verifyToken`, etc.
- **Health:** Always healthy (stateless)

#### MCP Block (`src/blocks/mcp/`)
- **Purpose:** MCP server for AI agents, local message storage
- **Depends on:** security, relay, shared/db
- **Exports:** `createMcpServer`, `startStdio`, `startHttp`
- **Tools:** `connect`, `send_message`, `receive_messages`, `read_local_messages`, etc.
- **Health:** Checks local storage accessibility

#### Logs Block (`src/blocks/logs/`)
- **Purpose:** Audit logging, monthly log files
- **Depends on:** Nothing (writes to filesystem)
- **Exports:** `logMessage`, `logFullMessage`, `registerLogRoutes`
- **Routes:** `/logs`, `/logs/:filename`
- **Health:** Checks log directory accessibility

#### Notifications Block (`src/blocks/notifications/`)
- **Purpose:** Desktop notifications, webhook callbacks
- **Depends on:** Nothing (independent)
- **Exports:** `sendDesktopNotification`, `sendWebhookNotification`
- **Health:** Always healthy

---

## How to Update a Single Block

```bash
# 1. Edit the block (e.g., messages)
vim src/blocks/messages/index.ts

# 2. Build only that block (TypeScript compiles all, but errors are per-file)
npm run build

# 3. Restart server (other blocks are unaffected)
# The server restarts in <1 second
```

---

## How to Add a New Block

1. Create directory: `src/blocks/my-block/`
2. Create `index.ts` with public API
3. Register health check: `registerHealthCheck('my-block', ...)`
4. Register routes in `src/index.ts`
5. That's it — other blocks are unaffected

---

## Error Handling

Each block handles its own errors. If a block crashes:
- Other blocks continue working
- Health check reports the block as `unhealthy`
- Server stays up

```
GET /health

{
  "status": "degraded",
  "blocks": {
    "auth": { "status": "healthy" },
    "groups": { "status": "healthy" },
    "messages": { "status": "healthy" },
    "relay": { "status": "unhealthy", "message": "NATS not connected" },
    "security": { "status": "healthy" },
    "logs": { "status": "healthy" }
  }
}
```

---

## Message Flow (Ephemeral)

```
A sends message → Messages Block
        │
        ├── 1. Security Block: injection check, rate limit
        ├── 2. Relay Block: publish to NATS JetStream
        ├── 3. Messages Block: deliver to online users via WS
        ├── 4. JetStream: hold for offline users (7 days)
        └── 5. Logs Block: audit log (file only, no DB)

B comes online → Messages Block
        │
        ├── 1. JetStream flush → deliver pending messages
        └── 2. MCP: save to local file (~/.ai-mesh/messages/)
```

---

## Files Summary

```
src/
├── core/           (3 files)  — Config, Errors, Health
├── shared/         (3 files)  — Database, Types, Translate
├── blocks/
│   ├── auth/       (3 files)  — OAuth, Token, Routes
│   ├── groups/     (1 file)   — Group CRUD
│   ├── messages/   (1 file)   — Message routing + WS
│   ├── relay/      (6 files)  — NATS JetStream
│   ├── security/   (4 files)  — Rate limit, Injection, Crypto
│   ├── mcp/        (5 files)  — MCP server + Local storage
│   ├── logs/       (1 file)   — Audit logging
│   └── notifs/     (1 file)   — Desktop/Webhook
├── tui/            (1 file)   — Terminal chat widget
└── index.ts        (1 file)   — Orchestrator

Total: ~28 files (vs previous 16 files)
```

---

*Architecture redesigned: 2026-07-10*
