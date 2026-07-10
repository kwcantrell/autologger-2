# Node port & frontend adoption — design

**Date:** 2026-07-09
**Status:** Draft — pending adversarial panel + user gate
**Scope:** Overall refactor shape + detailed design for sub-project 1 (Node server port).
Sub-projects 2 and 3 get their own specs later; their sections here are direction-setting
summaries, not build contracts.

## Context & goal

This repo is a Cloudflare Worker port of the Python AutoLogger backend: Hono + Zod + jose
on D1 (catalog), KV (`AUTH`), one `SessionDO` Durable Object per session, and R2 (audio
bytes). The React frontend lives outside the repo (`/home/kalen/AutoLog/frontend`, CSS
Modules, no Tailwind) and talks to this API.

**Goal:** remove the Cloudflare constraint entirely and make this repo a self-contained,
host-agnostic package: a portable **Node server** (Hono + SQLite + filesystem) plus the
**React frontend, migrated to Tailwind**, built by **Vite** — one `npm install && npm run
dev` from the root, deployable to any Node host (local/LAN like the Python original, or a
VPS/Docker box) with config via env vars.

Decisions already made with the owner:

- **Architecture:** frontend + portable Node server in one repo (not browser-only local-first,
  not frontend-only against the Python backend).
- **Cloudflare support is removed entirely** — no dual-target abstraction. Wrangler, Miniflare,
  and all D1/KV/DO/R2 code paths and types are deleted.
- **Port strategy: minimal churn** (Approach A). Keep the module structure, the store
  decomposition, and the Python-parity JSON contract; back the existing seams with Node
  equivalents. Re-unifying per-session storage into one database (Approach B, the Python
  original's shape) stays available later as a pure internal refactor.
- **Frontend:** port the existing app as-is first, then migrate its styling to Tailwind.

## Decomposition

Three sequential sub-projects, each independently shippable, each with its own
spec → panel → plan → implement cycle. The app is functional after each one, and Python
parity (JSON shapes, status codes) holds throughout so the frontend runs unmodified until
sub-project 3.

1. **Node server port** — detailed below.
2. **Frontend adoption** — move the React app into this repo, wire dev/prod serving.
3. **Tailwind migration** — CSS Modules → Tailwind v4, visual parity.

## Repo layout

npm workspaces:

```
autologger-cf/
  package.json          # workspaces root: dev / test / typecheck fan-out
  server/               # current src/ moves here (own package.json, tsconfig)
    src/...
  web/                  # sub-project 2: the ported React frontend (Vite)
```

Root scripts: `npm run dev` (server + Vite concurrently), `npm test`, `npm run typecheck`.
Deleted: `wrangler.jsonc`, `worker-configuration.d.ts`, the `workers` vitest tier,
`@cloudflare/vitest-pool-workers`, `wrangler`, and the `cf-typegen` / `migrate:local` /
`deploy` scripts.

## Sub-project 1: Node server port

### Runtime & entry

- `@hono/node-server` serves the existing Hono app; `@hono/node-ws` provides the WebSocket
  upgrade helper.
- `src/index.ts` splits into:
  - `server/src/app.ts` — the Hono app: middleware chain, error mapping, router mounts.
    Unchanged except for bindings types.
  - `server/src/main.ts` — Node entry: read config from env, construct bindings, run
    migrations, start listening.
- Node ≥ 20.6 `--env-file=.env` replaces `.dev.vars` (same gitignore discipline; ship
  `.env.example`).

### Configuration surface

Same names as today's `wrangler.jsonc` vars + `.dev.vars` secrets, plus two new ones:

| Var | Today | Notes |
|---|---|---|
| `PORT` | — (wrangler) | new; default 8787 |
| `DATA_DIR` | — | new; default `./data`; holds catalog.db, session DBs, audio files |
| `PUBLIC_BASE_URL` | wrangler var | unchanged |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | var / secret | unchanged |
| `REQUIRE_LOGIN`, `SESSION_COOKIE`, `SESSION_DAYS`, `NEW_USER_ALL_TEAMS`, `COOKIE_SECURE`, `IP_ALLOWLIST` | wrangler vars | unchanged |
| `API_TOKEN`, `ADMIN_TOKEN` | `.dev.vars` secrets | unchanged |

### Bindings replacement

The generated `Env` type is replaced by a hand-written `Bindings` interface built once at
startup. Each Cloudflare service maps to a narrow local interface with one Node
implementation (no multi-backend abstraction — CF is gone):

| Cloudflare binding | Node replacement |
|---|---|
| `DB` (D1) | `better-sqlite3` over `DATA_DIR/catalog.db`. A thin adapter exposes the few D1 methods `src/db/` actually uses (`prepare().bind().all()/first()/run()`, `batch`) so the store modules stay verbatim; if the call sites are few, they may instead be converted to better-sqlite3 idioms directly — decided at plan time by counting call sites. |
| D1 migrations | Same SQL files in `db/migrations/`, applied at startup by a small migrator (tracked in a `_migrations` table, filename-ordered — mirroring wrangler's behavior). |
| `AUTH` (KV) | `kv` table in catalog.db (`key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER NULL`). Get checks expiry lazily; `list({prefix})` (used by companion presence scans) becomes a `LIKE prefix%` query filtered by expiry; a periodic sweep deletes expired rows. |
| `SESSION_DO` (Durable Object) | In-process **`SessionHub`** — see below. |
| `AUDIO` (R2) | Filesystem blob store under `DATA_DIR/audio/`; existing `r2_key` strings become relative paths unchanged. Interface covers what the audio router uses today: `put`, `get`, `delete`, `list({prefix})` (for `syncAudioFromR2`-style reconciliation). |
| `ASSETS` (Workers Assets) | `serve-static` over the `web/` build output with the same `__API_ROOT__` substitution for the page HTML. Until sub-project 2 lands, this serves the same `public/` artifact the Worker served. |

### SessionHub (replaces SessionDO)

- Same flat RPC surface: routers call `stub.statusLive(ctx)`, `stub.startTake(ctx)`, etc.
  today (`server/src/routers/_helpers.ts` resolves the stub). `getSessionStub` becomes a
  lookup in an in-process `Map<sessionId, SessionHub>` registry with lazy instantiation —
  call sites keep their shape.
- The six store modules (`eventStore`, `transportStore`, `audioStore`, `leaseStore`,
  `transcriptStore`, `topicStore`) and their unit tests survive **verbatim**: they already
  talk to storage only through `SessionCore`'s `db.exec` seam. `SessionCore` gets a
  `better-sqlite3` backing over a per-session file `DATA_DIR/sessions/<id>.db`, preserving
  the DO schema with no `session_id` columns.
- The D1 **projection** contract is unchanged: every hub mutation still returns a
  `projection` block the router writes to the catalog `sessions` row, so cross-session
  listing stays a pure catalog query.
- **WebSocket fan-out:** the hub keeps a plain `Set` of connected sockets (via
  `@hono/node-ws`), replacing hibernatable `ctx.acceptWebSocket`. Message/close/error
  handling logic ports as-is; close codes and companion re-broadcast behavior are pinned by
  the existing companion WS integration tests.
- **Alarm → timer:** the recording lease's +40s `alarm` becomes a `setTimeout` owned by the
  hub. Timers are not durable across process restarts; compensations: (a) lease expiry is
  also checked lazily on every lease read (existing behavior), and (b) a hub re-arms its
  timer on instantiation if a live lease is found in its DB. The lease tests port to cover
  both paths.
- **Eviction:** none. Hubs live for the process lifetime once instantiated (a session's
  working set is tiny). If memory ever matters, an idle-eviction policy is a later,
  isolated change.

### Invariants & restart semantics

- **Single Node process** — same single-writer/single-event-loop assumption the DO gave us.
  Documented in CLAUDE.md/README; no clustering support.
- Durable on disk: catalog.db, per-session DBs, audio files. Rebuilt naturally on restart:
  WS connections, KV-TTL'd presence, lease timers (via the re-arm rule above), login
  sessions (they live in the kv table, so they survive).

### Tests

- **Unit tier** (`*.test.ts`, node): unchanged.
- **Integration tier** (`*.int.test.ts`): re-pointed, not rewritten. Instead of Miniflare's
  `SELF.fetch`, each suite constructs the app with bindings over a temp `DATA_DIR` and
  calls `app.request()`. Assertions — the actual parity contract — stay the same.
  WS integration tests use a real listening server (`@hono/node-server` on an ephemeral
  port) since upgrades need a socket.
- `vitest.workspace.ts` collapses to a single project (or is deleted).
- Definition of done: `npm test` + `npm run typecheck` green; every endpoint the old
  integration suite covered is covered against the Node bindings.

### Removal list

`wrangler`, `@cloudflare/vitest-pool-workers`, `wrangler.jsonc`,
`worker-configuration.d.ts`, `cloudflare:workers` imports (`DurableObject` base class),
`WebSocketPair`, `cf-typegen`/`migrate:local`/`deploy` scripts, README/CLAUDE.md sections
describing the CF architecture (rewritten to describe the Node architecture).

## Sub-project 2: frontend adoption (summary)

Move `/home/kalen/AutoLog/frontend` into `web/` as a workspace. Vite dev server proxies
`/api`, `/auth`, and the session WebSocket to the Node server; production build output is
what the server's static layer serves (replacing the `public/` snapshot artifact, which is
then removed). No component changes; the copy in the Python repo is left untouched and this
repo's copy becomes canonical for this app. Own spec before implementation.

## Sub-project 3: Tailwind migration (summary)

Tailwind v4, CSS-first `@theme` mapping the existing `tokens.css` custom properties so
converted components render identically. Component-by-component conversion of the 23 CSS
Module files (~7,300 lines), keeping `clsx` composition; the shared plain-CSS layer
(`baseline.css`, `chrome.css`, `bgGlow.css`, `glass.module.css`) converts last. Own spec
before implementation.

## Risks

- **Lease/alarm drift:** Node timers aren't durable like DO alarms. Mitigated by lazy
  expiry checks + re-arm on hub instantiation; pinned by ported lease tests.
- **WebSocket parity:** close codes and re-broadcast semantics differ between runtimes.
  The companion WS integration suite is the safety net.
- **D1 adapter fidelity:** subtle differences (e.g., `run()` metadata, null handling)
  between D1 and better-sqlite3. Kept small by only implementing methods the codebase
  actually calls, each covered by the ported integration tests.
- **`better-sqlite3` is a native module:** fine for Node hosts; a constraint if a
  single-binary bundle is ever wanted (noted, not designed for).

## Out of scope

- Transcription and YouTube import remain `503` (they were CF-side stubs; a Node
  implementation is a separate future project).
- Multi-process/cluster deployment.
- Approach B (single-database re-unification) — possible later refactor, not this work.
- Any change to JSON shapes or status codes.

## Panel & review log

_(pending — adversarial panel runs before the user gate; dispositions recorded here)_
