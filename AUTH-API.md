# Auth model & API map — autologger-cf

Reference for the HTTP/WS surface and how each route is authenticated.
Source of truth: `server/src/middleware/auth.ts`, `server/src/middleware/ipAllowlist.ts`,
`server/src/auth/identity.ts` (`apiRequestRequiresLogin`), and the per-router guards
in `server/src/routers/`. Regenerate if those change.

## Auth tiers

| Tier | Meaning | Credential | Enforced when |
|------|---------|------------|---------------|
| 🔓 **Public** | No auth | — | always open |
| 🍪 **User** | Logged-in user **or** machine client | Google session cookie **or** `API_TOKEN` bearer | only when `REQUIRE_LOGIN=1` (production serve path) |
| 🔑 **Admin** | Admin-only | `ADMIN_TOKEN` bearer | **always** (independent of `REQUIRE_LOGIN`) |

Notes:
- **IP allowlist** (`ipAllowlistMiddleware`) wraps *every* route as the outermost gate, before auth.
- In **dev** (`REQUIRE_LOGIN=0`, loopback) the 🍪 tier is effectively open — the IP allowlist is the only guard in front of it.
- **Admin is orthogonal**: `/api/admin/*` is *exempt* from the login gate but requires its own `ADMIN_TOKEN` — checked even in dev (returns `503` until the token is set, `401` if wrong). A session cookie grants **no** admin access.
- The **Companion** module authenticates machine-to-machine with `Authorization: Bearer <API_TOKEN>`, which satisfies the 🍪 tier. There is no separate "companion token."

## Request flow (middleware chain)

```mermaid
flowchart TD
    REQ([Incoming request]) --> IP{IP allowlisted?}
    IP -- no --> R403[403 Forbidden]
    IP -- yes --> AUTHCTX[authContext:<br/>resolve session cookie → user<br/>check API_TOKEN bearer]

    AUTHCTX --> GATE{REQUIRE_LOGIN = 1?}
    GATE -- no / dev --> ROUTE
    GATE -- yes --> RULE{apiRequestRequiresLogin path, method}

    RULE -- "GET /api/profile" --> ROUTE
    RULE -- "/api/admin/*" --> ROUTE
    RULE -- "not /api/*<br/>(/auth, static, SPA)" --> ROUTE
    RULE -- "other /api/*" --> HASCRED{session cookie<br/>OR API_TOKEN?}

    HASCRED -- no --> R401[401 Login required]
    HASCRED -- yes --> ROUTE

    ROUTE[Router handler] --> ADMIN{path starts<br/>/api/admin/ ?}
    ADMIN -- no --> OK([Response])
    ADMIN -- yes --> ADMTOK{ADMIN_TOKEN set<br/>AND bearer valid?}
    ADMTOK -- "not set" --> R503[503 Set ADMIN_TOKEN]
    ADMTOK -- "invalid" --> R401B[401 Invalid admin token]
    ADMTOK -- yes --> OK
```

## Login gate rule (`apiRequestRequiresLogin`)

```mermaid
flowchart LR
    P[path, method] --> A{GET /api/profile?}
    A -- yes --> PUB[🔓 no login]
    A -- no --> B{/api/admin/* ?}
    B -- yes --> ADM[🔑 admin token instead]
    B -- no --> C{starts with /api/ ?}
    C -- yes --> USR[🍪 login required]
    C -- no --> PUB2[🔓 no login]
```

## API surface by tier

```mermaid
flowchart TD
    subgraph PUBLIC["🔓 Public"]
        A1["GET /auth/google/start"]
        A2["GET /auth/google/callback"]
        A3["GET·POST /auth/logout"]
        A4["GET /api/profile"]
        A5["GET / · /admin/users · * (SPA/static)"]
    end

    subgraph USER["🍪 User (cookie or API_TOKEN)"]
        subgraph CATALOG["Catalog"]
            U1["GET /api/studio"]
            U2["PUT /api/profile"]
            U3["GET·POST /api/shows"]
            U4["GET·POST /api/sessions"]
            U5["PUT·DELETE /api/sessions/:id"]
            U6["POST /api/sessions/:id/archive·restore·youtube-import"]
        end
        subgraph SPINE["Session spine (:id)"]
            S1["GET show-categories · status · events"]
            S2["POST·PUT·DELETE events[/:eventId]"]
            S3["POST transport/start·stop"]
            S4["POST audio-recording-lease[/heartbeat|/release]"]
            S5["GET·POST audio/segments[...]"]
            S6["PUT audio/segments/:sid/waveform"]
            S7["transcript-words · topics (GET/POST/PATCH/DELETE + /generate)"]
            S8["GET transcribe.csv · export.csv · export.jsonl"]
            S9["GET (upgrade) /api/sessions/:id/ws"]
        end
        subgraph COMP["Companion"]
            C1["POST presence · log · transport · command"]
            C2["GET state · categories · commands/wait"]
            C3["POST commands/:commandId/ack"]
        end
    end

    subgraph ADMIN["🔑 Admin (ADMIN_TOKEN)"]
        D1["GET /api/admin/users"]
        D2["POST·DELETE /api/admin/studios[/:id]"]
        D3["POST·DELETE /api/admin/users/:id/memberships[/:studioId]"]
        D4["POST /api/admin/users/:id/disable·enable"]
    end
```

## Full route table

### 🔓 Public
| Method | Path | Notes |
|--------|------|-------|
| GET | `/auth/google/start` | OAuth entry |
| GET | `/auth/google/callback` | OAuth callback (production serve path only) |
| GET·POST | `/auth/logout` | |
| GET | `/api/profile` | the one `/api/` public exception |
| GET | `/` · `/admin/users` · `*` | SPA / static fallback |

### 🍪 User — Profile / Shows / Sessions
| Method | Path |
|--------|------|
| GET | `/api/studio` |
| PUT | `/api/profile` |
| GET·POST | `/api/shows` |
| GET·POST | `/api/sessions` |
| PUT·DELETE | `/api/sessions/:sessionId` |
| POST | `/api/sessions/:sessionId/archive` · `/restore` · `/youtube-import` *(503)* |

### 🍪 User — Session spine (`/api/sessions/:sessionId/…`)
| Method | Path |
|--------|------|
| GET | `show-categories` · `status` · `events` |
| POST | `events` |
| PUT·DELETE | `events/:eventId` |
| POST | `transport/start` · `transport/stop` |
| POST | `audio-recording-lease` · `/heartbeat` · `/release` |
| GET·POST | `audio/segments` |
| POST | `audio/segments/sync-from-disk` |
| GET | `audio/segments/:segmentId` |
| PUT | `audio/segments/:segmentId/waveform` |
| GET | `transcript-words` · `topics` · `transcribe.csv` |
| POST | `transcript-words` · `topics` · `transcript-words/generate` *(503)* · `topics/generate` *(503)* |
| PATCH·DELETE | `transcript-words/:wordId` · `topics/:topicId` |
| GET | `export.csv` · `export.jsonl` |
| GET (upgrade) | `ws` — live SessionHub fan-out |

### 🍪 User — Companion (`/api/companion/…`)
| Method | Path |
|--------|------|
| POST | `presence` · `log` · `transport` · `command` |
| GET | `state` · `categories` · `commands/wait` *(long-poll)* |
| POST | `commands/:commandId/ack` |

### 🔑 Admin (`/api/admin/…`)
| Method | Path |
|--------|------|
| GET | `users` |
| POST·DELETE | `studios` · `studios/:studioId` |
| POST·DELETE | `users/:userId/memberships` · `memberships/:studioId` |
| POST | `users/:userId/disable` · `enable` |

---
_~55 HTTP routes across 10 routers + 1 WebSocket endpoint. `(503)` marks endpoints intentionally
disabled on this Node deployment (transcription / YouTube import not wired up)._
