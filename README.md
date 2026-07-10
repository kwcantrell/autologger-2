# autologger-cf

AutoLogger as a **portable Node server** — runs anywhere Node 22 runs, no cloud platform
required.

This is a faithful TypeScript port of the Python backend (`../autologger`). It authenticates
via Google OAuth, persists the global catalog (users/studios/shows/prefs) plus login sessions
and OAuth CSRF in a **SQLite catalog DB**, holds live per-session data (events, transport,
audio metadata, recording lease, transcript words, topics) in an **in-process SessionHub per
session** (embedded SQLite), keeps audio bytes on the **filesystem**, and pushes live updates
over a **WebSocket** — all with the **same JSON shapes** the existing React frontend expects.

## Stack

- **Hono** — routing + middleware (mirrors `web/app.py` + routers)
- **Zod** — request validation at the route boundary (ports `web/schemas.py`)
- **jose** — Google ID-token verification against Google's JWKS
- **better-sqlite3** — catalog DB + one DB file per session
- **filesystem blobs** — audio bytes (replaces R2)
- **in-process SessionHub per session** — replaces the Durable Object; live spine for events,
  transport, audio metadata, recording lease, transcript words, topics, and WebSocket fan-out
- **`@hono/node-ws`** — WebSocket upgrades, served by **`@hono/node-server`**

> Runs anywhere Node 22 runs. No Cloudflare account, no login, no remote provisioning. A
> single Node process serves HTTP + WebSocket; state lives under `DATA_DIR` on local disk.

## Architecture

- **Catalog DB = global, cross-session, relational, not hot** (`DATA_DIR/catalog.db`). Also
  holds key/value rows (login sessions, OAuth CSRF, replacing KV) and a lightweight
  `sessions` index (metadata + a small live projection) so listing + status + cheap
  rolling-timecode never wake a session's hub.
- **One SessionHub per session** (in-process, keyed by session id) = the live spine: events,
  transport, audio-segment metadata, recording lease (in-hub state + a timer-driven
  auto-expiry), transcript words, topics, and the WebSocket fan-out. Single writer per
  session, so the Python `RLock` and `events_stream_revision` polling machinery disappear —
  the hub broadcasts instead. After each mutation the process mirrors a few live fields back
  to the catalog's sessions index (`projectSessionLive`).
- **Filesystem blobs** = audio bytes under `DATA_DIR/blobs/audio/<session_id>/<ordinal>_<uuid>.<ext>`;
  the hub holds only metadata + relative keys. Download streams bytes back with HTTP range
  support (416 on unsatisfiable ranges).
- **Transcription + YouTube import are unavailable** on this deployment (no external
  transcription box wired up): the `…/generate`, `…/youtube-import`, and `transcribe.csv`
  endpoints return a clean `503 {detail}` the frontend toasts. Manual transcript-word/topic
  CRUD still works.

### Storage map

```
DATA_DIR/
  catalog.db           Catalog + kv (users/studios/shows/prefs, login sessions, OAuth CSRF,
                        Companion presence, sessions index + live projection)
  sessions/<id>.db      One SQLite file per session — events, transport, audio metadata,
                        recording lease, transcript words, topics
  blobs/audio/…         Audio bytes (r2_key-shaped relative paths)
  tmp/                  Atomic-put staging (outside blobs/, so listings never see partials)
```

### Invariants (spec)

- **Single Node process** — no clustering, no multi-worker fan-out.
- **SessionHub RPC bodies are synchronous** — zero `await`s inside a hub method; all async
  work (fetch, streaming, etc.) lives in the router layer, not the hub.
- **Hub mutations are transactional** — every mutating RPC runs inside a
  `better-sqlite3` transaction.
- **Idle hubs close their DB handles and reopen lazily** — a hub with no attached sockets and
  no armed lease timer is evicted after an idle window; `SessionHubRegistry#get()` reopens the
  session's DB file on next access. `expireIfStale()` re-checks the recording lease on reopen.

## Source layout

```
src/
  main.ts                Node entry: env config → bindings → app → listen
  app.ts                 Hono app wiring: middleware chain + router mounts + static (← web/app.py)
  env.ts                 Typed env accessors                           (← auth_identity.py getters)
  schemas.ts             Zod request schemas                           (← web/schemas.py)
  studio.ts              Studios + palette/category + event enrichment (← studio.py)
  timecode.ts            SMPTE timecode math + UTC helpers             (← models.py)
  types.ts               Shared Hono generics (Bindings + Variables)
  node/
    config.ts            Bindings construction from process env (DATA_DIR layout, wiring)
    migrate.ts            Startup migrator for the catalog DB (filename-ordered .sql, transactional)
    d1Adapter.ts          CatalogDb — better-sqlite3-backed catalog query layer
    kvStore.ts            KV replacement (login sessions, OAuth CSRF, Companion presence) on the catalog DB
    blobStore.ts          Filesystem blob store: atomic put, range get, list, traversal guard
    presence.ts           In-memory Companion presence registry
    sqlShim.ts             SqlStorage-shaped shim over better-sqlite3 (the seam SessionCore programs against)
  durable/
    SessionHub.ts          In-process per-session hub: registry, idle eviction, RPC surface (← SessionDO.ts)
    sessionCore.ts          Shared substrate: SQLite handle, WS fan-out, events_stream_revision, lease
    eventStore.ts / transportStore.ts / audioStore.ts / leaseStore.ts / transcriptStore.ts / topicStore.ts
                            Domain stores built on SessionCore                (← storage/db.py)
  db/
    d1.ts                  Catalog query layer + profile + sessions index + admin (← storage/db.py, deps.py)
    authStore.ts / profileAssembler.ts / sessionIndexStore.ts / showsStore.ts / studioRegistry.ts
    migrations/0001_init.sql                  Catalog DDL + seeded built-in shows
    migrations/0002_sessions_live_split.sql   Sessions index metadata + live projection
  auth/
    oauth_google.ts        Authorize URL, code exchange, ID-token verify (← oauth_google.py)
    identity.ts             Login sessions + CSRF, bearer compare, gate rule (← auth_identity.py)
  middleware/
    auth.ts                 Per-request context + REQUIRE_LOGIN gate      (← app.py auth_identity_and_gate)
    ipAllowlist.ts           CIDR allowlist on client IP                   (← app.py ip_allowlist_middleware)
  routers/
    _helpers.ts              ApiError, session access gate, hub lookup, marked-at parsing
    auth.ts                  /auth/google/start|callback, /auth/logout
    profile.ts               GET /api/studio, GET|PUT /api/profile
    shows.ts                 GET|POST /api/shows
    sessions.ts              list/create/update/archive/restore/delete; youtube-import (503)
    events.ts                events CRUD, transport, status, lease, WebSocket upgrade
    audio.ts                 upload/list/range-download, waveform, sync-from-disk
    companion.ts             Companion presence + state + log/transport/command (WS relay)
    transcribe.ts             transcript-words + topics CRUD; generate/csv (503)
    exports.ts                export.csv / export.jsonl (← export.py)
    admin.ts                  ADMIN_TOKEN-gated users + studio-definitions admin
```

## Endpoints

| Route | Python parity |
|-------|---------------|
| `GET /auth/google/start` · `/callback` · `GET\|POST /auth/logout` | `routers/auth.py` |
| `GET /api/studio` · `GET\|PUT /api/profile` · `GET\|POST /api/shows` | `routers/profile.py`, `shows.py` |
| `GET\|POST /api/sessions` · `PUT\|DELETE /api/sessions/{id}` · `…/archive\|restore` | `routers/sessions.py` |
| `GET\|POST /api/sessions/{id}/events` · `PUT\|DELETE …/events/{eid}` | `routers/events.py` |
| `GET …/status` · `POST …/transport/start\|stop` · `GET …/show-categories` | `routers/events.py` |
| `…/audio-recording-lease` (claim/heartbeat/release) · `GET …/ws` | `routers/events.py` |
| `GET\|POST …/audio/segments` · range `GET …/segments/{id}` · `PUT …/waveform` | `routers/audio.py` |
| `GET\|POST\|PATCH\|DELETE …/transcript-words` · `…/topics` | `routers/transcribe.py` |
| `…/transcript-words/generate` · `…/topics/generate` · `transcribe.csv` · `youtube-import` → **503** | (unavailable) |
| `GET …/export.csv` · `…/export.jsonl` | `routers/exports.py` / `export.py` |
| `/api/companion/presence\|state\|log\|transport\|command\|categories\|commands/*` | `routers/companion.py` |
| `/api/admin/users` · `/api/admin/studios` · `…/users/{id}/memberships\|disable\|enable` | `routers/admin.py` |

WebSocket messages broadcast by the SessionHub: `event.changed` · `transport.changed` ·
`audio.changed` · `lease.changed` · `command` (Companion → browser). The frontend consumes
these directly (`frontend/src/api/hooks/useSessionSocket.ts`): the fast status poll, the
`events_stream_revision` watcher, the `EventLogSheet` 3 s poll, and the `/companion/commands/wait`
long-poll are deleted. A single slow status poll (~1.2 s) runs **only while rolling/recording**
to advance the live timecode; the WS drives every discrete change. The `commands/wait` endpoint
still returns an immediate empty list so any stale client degrades to a slow poll instead of a
tight loop.

## Security notes

- **Client IP** is the raw socket address unless `TRUST_PROXY=1`, in which case the first hop
  of `X-Forwarded-For` (and `X-Forwarded-Proto` for cookie-secure decisions) is trusted
  instead — there is no cloud edge to pre-validate those headers, so leave `TRUST_PROXY=0`
  unless this process sits behind a proxy you control.
- **`REQUIRE_LOGIN` defaults ON** (gate decision E1) — every `/api` route requires a session
  or bearer token unless you explicitly set `REQUIRE_LOGIN=0`.
- **Startup warning on open binds** — if the process binds to a non-loopback host with
  `REQUIRE_LOGIN=0` and no `IP_ALLOWLIST`, `main.ts` prints a loud warning: every `/api` route
  is reachable from the network.
- **Google ID-token verification** fetches Google's JWKS via the global `fetch` and
  `jose`'s `createLocalJWKSet` (10-minute in-memory cache, one refetch on an unrecognized
  `kid` to ride out key rotation) — `jose`'s `node:https`-based remote-JWKS helper is not
  used, since this process may run without direct outbound HTTPS in some sandboxes and the
  manual fetch+cache path is uniform across environments.
- **Per-request bindings injection is a mutation, not a copy.** `wireApp()` in `src/app.ts`
  mutates the Hono context's `env` object in place rather than replacing it, because
  `@hono/node-ws`'s upgrade handshake stashes internal state on that exact object and later
  compares object identity to decide whether to complete the upgrade. Callers (including test
  harnesses) must pass a **fresh env per request** — reusing one env object across concurrent
  requests will cross-contaminate bindings.

## Known parity windows (spec)

These are accepted operational tradeoffs, not bugs to "fix" with a cross-DB transaction:

- The catalog's sessions-index projection can be **momentarily stale** after a crash between
  a session mutation and its `projectSessionLive` mirror write — the session DB itself is
  always authoritative; the index just lags until the next mutation.
- **Ghost metadata rows** are possible: an audio-segment metadata row can exist whose blob
  bytes never landed (crash between the DB insert and the blob write, or vice versa). There is
  no background reaper for these.
- **Uploads buffer the full request body in one heap allocation**, up to 50 MB per request —
  there is no request-body streaming and no connection cap. This is an operational limit for
  single-box deployments, not a hardened multi-tenant upload path.

## Quick start (local)

```bash
npm install
cp .env.example .env               # fill GOOGLE_CLIENT_ID/SECRET for real OAuth

npm run typecheck                  # tsc --noEmit
npm run dev                        # tsx watch → http://127.0.0.1:8787
npm test                           # vitest (unit + integration projects)
```

### Verify parity

```bash
B=http://127.0.0.1:8787

# Login gate (REQUIRE_LOGIN defaults to 1 — see .env.example):
curl -o /dev/null -w '%{http_code}\n' $B/api/sessions                    # 401
curl -o /dev/null -w '%{http_code}\n' $B/api/profile                     # 200 (always anonymous-safe)
curl -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer <API_TOKEN>' $B/api/sessions   # 200

# Anonymous parity (set REQUIRE_LOGIN=0 in .env): profile + shows both answer.
curl $B/api/profile
curl $B/api/shows

# OAuth round-trip needs real Google creds (GOOGLE_CLIENT_ID/SECRET in .env) and
# PUBLIC_BASE_URL registered as an authorized callback URI.
```

## Serving the SPA

The Node process serves the SPA itself from the `public/` directory. The frontend's build
emits into that directory:

```bash
cd ../autologger/frontend && AUTOLOGGER_CF_BUILD=1 npm run build   # → ../../autologger-cf/public
cp ../src/autologger/web/static/logo-autologger-{transparent,app}.png \
   ../../autologger-cf/public/static/                              # logos live outside react-dist
```

`public/` is gitignored — it is a reproducible build artifact until sub-project 2 moves the
frontend into this repo; the frontend source currently still lives in the parent Python repo.

`src/app.ts` routes HTML explicitly (there is no client-side router): `GET /` and
`GET /admin/users` read their built HTML from `public/`, substitute `__API_ROOT__` → `/api`
(the same transitional substitution Python's `_render_html` does), and return it; a static
mount serves hashed `/assets/*` + `/static/*`. The `/api` + `/auth` routers are mounted first,
so the API is never shadowed.
