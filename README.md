# autologger-cf

AutoLogger as a **portable Node server** — runs anywhere Node 22 runs, no cloud platform
required.

Originally a faithful TypeScript port of the Python AutoLogger backend — this repo is now
the canonical implementation. It authenticates
via Google OAuth, persists the global catalog (users/studios/shows/prefs) plus login sessions
and OAuth CSRF in a **SQLite catalog DB**, holds live per-session data (events, transport,
audio metadata, recording lease, transcript words, topics) in an **in-process SessionHub per
session** (embedded SQLite), keeps audio bytes on the **filesystem**, and pushes live updates
over a **WebSocket** — all with the **frozen JSON shapes** the React frontend and Companion
module consume (see Endpoints below; the contract is frozen).

## Stack

- **Hono** — routing + middleware (ported from `web/app.py` + routers)
- **Zod** — request validation at the route boundary (ported from `web/schemas.py`)
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
server/src/
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

This surface is **frozen** (capability spec `api-contract-freeze`): the route column below
is the normative inventory, and every route's observable behavior — JSON response shapes,
status codes, export bodies (CSV/JSONL), header/range semantics, and the WebSocket messages
listed after the table (their shapes *and* when they fire) — changes only with an
authorizing OpenSpec delta spec. The origin column records which Python module each route
was ported from: historical provenance, not a live parity claim.

| Route | Origin (historical) |
|-------|---------------------|
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
- **Per-request bindings injection is a mutation, not a copy.** `wireApp()` in `server/src/app.ts`
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
cp server/.env.example server/.env # fill GOOGLE_CLIENT_ID/SECRET for real OAuth
# upgrading an existing checkout? your state moved: mv .env data server/

npm run typecheck                  # server + web + e2e
npm run dev                        # server (tsx watch, :8787) + Vite (:5173), concurrently
npm test                           # server vitest (unit + integration projects)
```

### Verify the contract

```bash
B=http://127.0.0.1:8787

# Login gate (REQUIRE_LOGIN defaults to 1 — see server/.env.example):
curl -o /dev/null -w '%{http_code}\n' $B/api/sessions                    # 401
curl -o /dev/null -w '%{http_code}\n' $B/api/profile                     # 200 (always anonymous-safe)
curl -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer <API_TOKEN>' $B/api/sessions   # 200

# Anonymous parity (set REQUIRE_LOGIN=0 in server/.env): profile + shows both answer.
curl $B/api/profile
curl $B/api/shows

# OAuth round-trip needs real Google creds (GOOGLE_CLIENT_ID/SECRET in server/.env) and
# PUBLIC_BASE_URL registered as an authorized callback URI.
```

## Frontend (web/ workspace)

The React frontend lives in `web/` (Vite 8 + React 19, Tailwind v4) and is canonical for
this app. `npm run build` emits `web/dist/`; the server serves it directly — `GET /` and
`GET /admin/users` return the built page HTML verbatim (no serve-time rewriting; the API
root is hardcoded same-origin `/api`), and a static catch-all serves hashed `/assets/*`
plus `/static/*` (favicon logos ship from `web/public/static/`).

### Styling (Tailwind v4)

All styling lives in one entry, `web/src/shared/theme/tailwind.css`, side-effect imported
from each page's `main.tsx`. No CSS Modules, no per-component `*.css` files. Layers,
declared in order:

- **`theme`** — two `@theme` blocks emit the design-token scale. `@theme inline` holds
  tokens whose only job is generating utilities (`--color-*`, `--radius-*`); `@theme
  static` unconditionally emits a few tokens (`--color-text`, `--color-accent`,
  `--font-mono`, …) into `:root` because TSX inline styles and arbitrary-value utilities
  (`font-[family-name:var(--font-mono)]`) read them as raw `var()` strings the Tailwind
  scanner can't see as utility candidates otherwise.
- **non-namespace `:root` block** — tokens with no Tailwind theme category (the `--v4-*`
  pixel-matched layout values, `--z-*` z-index scale, compound gradient/shadow stacks,
  alpha-composited colors used only as gradient ingredients) plus **preserved legacy
  names** (`--bg`, `--accent`, `--v5-primary`, …) kept byte-identical so the handful of
  TSX inline-style `var()` consumers (Timeline, TimelineMarkers, NewSessionModal,
  EventLogRow) keep resolving without a rename sweep through JSX.
- **`base`** — body baseline, fonts, resets (formerly `baseline.css`).
- **`components`** — chrome families ported as named `@utility` / `@layer components`
  rules (`.btn`, `.field`, `.glass-panel`, …), multi-consumer classes, exotic-selector
  rules Tailwind can't express inline (`::-webkit-scrollbar`, keyframes), and
  `perfDebug`'s cross-component `body.perf-dbg--*` escape hatches.
- **`utilities`** — Tailwind's generated utility set, used inline in JSX composed with
  `clsx` at the existing call sites (exclusive branches per state, not toggled overrides).

Two conventions worth knowing before touching component styles:

- **`hover-always`** — a `@custom-variant hover-always (&:hover)` for the repo's dominant
  hover flavor (fires on touch-tap too). Tailwind's stock `hover:` is gated behind
  `@media (hover: hover)` in v4, which only three chrome `.btn` hovers actually want.
- **Ancestor-scoped overrides** convert as arbitrary variants keyed off ancestor DOM,
  e.g. `[#v4-log-session_&]:...`, rather than living in the ancestor's own file — this
  keeps a component's look-changing rules with the component they change.

Stable ID/data-attribute hooks (`#v4-log-sheet`, `tr[data-event-id]`, `#v3-session-grid`,
`#btn-ctl-*`, `[data-category-id]`, `body[data-v4-transport]`, …) are untouched by the
migration — e2e and Companion selectors keep working. `body[data-v4-transport]` is set
dynamically at runtime (`SessionWorkspace.tsx`), so its `@layer components` block in
`tailwind.css` is live styling, not dead code — the file carries a parity comment at that
rule.

Fonts (Inter/Oswald/Roboto/Poppins/League Gothic/Chivo Mono) and `animate.css` are
vendored locally under `web/src/assets/` — no CDN requests at runtime, and the visual
harness (below) is network-independent as a result.

### Dev flow

```bash
npm run dev        # concurrently: server (tsx watch, :8787) + Vite (:5173)
```

Browse `http://127.0.0.1:5173/src/pages/index/index.html`. Vite proxies `/api` (incl. the
session WebSocket) and `/auth` to :8787.

**Dev auth is anonymous by design**: set `REQUIRE_LOGIN=0` and `HOST=127.0.0.1` in
`server/.env`. Google OAuth cannot round-trip through the Vite proxy (the callback
redirects to `PUBLIC_BASE_URL` on :8787 and the cookie lands on that origin) — verify
OAuth against the production serve path instead:

```bash
npm run build && npm run start   # everything on :8787
```

If dev auth is misconfigured (login required but no session), the first symptom is an
opaque WebSocket drop — the 401 fires before the upgrade, so the browser sees a bare
close with no status.

**Keep Vite on loopback.** `server.host` is pinned to `127.0.0.1` in `web/vite.config.ts`;
exposing Vite to the LAN would let peers reach the API *as* 127.0.0.1, bypassing
`IP_ALLOWLIST`. Test LAN devices against :8787.

### e2e smoke

```bash
npx playwright install chromium   # one-time
npm run e2e                       # builds web/, boots a hermetic server on :8791
```

The Playwright `webServer` runs with `REQUIRE_LOGIN=0`, loopback bind, a wiped
`e2e/.data/` DATA_DIR, and explicitly blanked OAuth/token env — your real `server/.env`
never leaks into the suite. The wipe happens in the `webServer.command` itself, in the
same shell invocation that starts the server, so it always runs before boot.

### Visual regression harness

```bash
npm run e2e:visual          # 44 screenshots, two viewports (desktop 1280×720, mobile 390×844)
npm run e2e:visual:update   # re-capture baselines after a reviewed, intentional UI change
```

`e2e/visual.spec.ts` is a separate Playwright **project**, excluded from default
`npm run e2e` (gate decision E-1 from the Tailwind migration) — it's a standing opt-in
safety net against pixel drift, not a per-PR gate. Baselines are committed PNGs, chromium
only, masked for time-driven regions (playhead, rolling shimmer) and autoplaying video.
**Re-baseline policy:** the "frozen for the whole campaign" rule was migration-specific
and no longer applies — re-capture the affected shots freely for any legitimate UI
change, with a human-reviewed before/after diff confirming only the intended change
moved. A future Playwright/Chromium version bump will shift anti-aliasing across most
shots and likely needs a full re-capture; that's expected and no longer gated behind an
exact-pin policy (`@playwright/test` is back to a caret range).

## Companion module (`companion/`)

A Bitfocus Companion (Stream Deck) module — an npm workspace that controls the active
AutoLogger session over the existing `/api/companion/*` HTTP endpoints (log events,
roll/stop takes, record/play), with live feedbacks and variables.

```bash
npm run build -w companion      # check base-version pin + tsc -> companion/dist/
npm run test -w companion       # vitest unit tests
npm run package -w companion    # produce a distributable .tgz module package
```

**Loading in Companion 4.3.x:** you must load the **packaged** module, not the raw `tsc`
output — under Companion's per-module Node permission sandbox the plain `companion/dist/`
build cannot read the workspace-hoisted dependencies and fails to start. Run
`npm run package -w companion` to produce `autologger-0.1.0.tgz` (a self-contained,
dependency-free esbuild bundle with a correct `runtime.apiVersion`), then either import it
via Companion's **"Import module package"**, or extract it into a directory you pass to
`--extra-module-path`. Configure the connection with the **Server URL**
(e.g. `http://127.0.0.1:8787`) and, only if the server runs with the `API_TOKEN` env var set
(`REQUIRE_LOGIN=1`), the **API token**.

> `@companion-module/base` is pinned to `~1.14.0` (stable 1.x). Companion 4.3.4 rejects the
> newer 2.1.x line, and its 2.0.x alpha removed the `runEntrypoint` API this module uses. A
> root `package.json` `overrides` keeps `@companion-module/tools` on the same 1.14.x base so
> the packaged manifest's `apiVersion` is correct.

The headless-Companion Playwright project is binary-gated and excluded from the default
`npm run e2e` run. To run it where a Companion install is present, use
`npm run e2e -- --project=companion --workers=1` (it must not share workers with the
`chromium` project — resource contention makes a shared multi-worker run flaky).
