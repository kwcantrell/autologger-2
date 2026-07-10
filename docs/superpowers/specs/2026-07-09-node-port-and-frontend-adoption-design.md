# Node port & frontend adoption — design

**Date:** 2026-07-09
**Status:** Panel-reviewed — pending user gate
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

**Sub-project 1 keeps the current layout** — single package, `src/` in place, one vitest
project. The npm-workspaces conversion (`src/` → `server/src/`, `web/` for the frontend,
root fan-out scripts) happens as a standalone mechanical commit at the **start of
sub-project 2**, when the second package actually arrives. This keeps the riskiest phase
(runtime swap) unentangled from a ~60-file rename, so a phase-1 regression bisects to one
cause. *(Panel: scope #2.)*

Deleted in sub-project 1: `wrangler.jsonc`, `worker-configuration.d.ts`, the `workers`
vitest tier, `@cloudflare/vitest-pool-workers`, `wrangler`, and the `cf-typegen` /
`migrate:local` / `deploy` scripts.

## Sub-project 1: Node server port

### Runtime & entry

- `@hono/node-server` serves the existing Hono app; `@hono/node-ws` provides the WebSocket
  upgrade helper. (Verified: `@hono/node-ws` supports server-initiated `WSContext.send`
  fan-out; `better-sqlite3` engines cover the machine's Node 22.)
- `src/index.ts` splits into:
  - `src/app.ts` — the Hono app: middleware chain, error mapping, router mounts. Unchanged
    except for bindings types.
  - `src/main.ts` — Node entry: read config from env, construct bindings, run migrations,
    start listening.
- Node ≥ 20.6 `--env-file=.env` replaces `.dev.vars` (same gitignore discipline; ship
  `.env.example`).
- **Startup guard:** when the server binds a non-loopback interface with `REQUIRE_LOGIN`
  off and no `IP_ALLOWLIST`, `main.ts` prints a loud, unmissable warning that the API is
  open to the network. *(Whether to go further — refuse to start, or flip the default — is
  escalated to the gate; see Panel log E1.)*

### Configuration surface

Same names as today's `wrangler.jsonc` vars + `.dev.vars` secrets, plus three new ones:

| Var | Today | Notes |
|---|---|---|
| `PORT` | — (wrangler) | new; default 8787 |
| `DATA_DIR` | — | new; default `./data`; holds catalog.db, session DBs, audio files |
| `TRUST_PROXY` | — | new; default off. When on, the first `X-Forwarded-For` hop is the client IP and `X-Forwarded-Proto: https` satisfies cookie-Secure auto-detect. When off, headers are ignored entirely. |
| `PUBLIC_BASE_URL` | wrangler var | unchanged (OAuth redirect URI is built from it, not the request URL) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | var / secret | unchanged |
| `REQUIRE_LOGIN`, `SESSION_COOKIE`, `SESSION_DAYS`, `NEW_USER_ALL_TEAMS`, `IP_ALLOWLIST` | wrangler vars | unchanged semantics (but see client-IP derivation below) |
| `COOKIE_SECURE` | wrangler var | unchanged override; the **auto** mode's `https:` detection only works behind a proxy when `TRUST_PROXY` is on — documented in `.env.example` |
| `API_TOKEN`, `ADMIN_TOKEN` | `.dev.vars` secrets | unchanged |

### Client-IP derivation (security-critical change)

The current middleware reads `CF-Connecting-IP` / `True-Client-IP` / `X-Forwarded-For`
with **no socket fallback** — safe only because Cloudflare's edge set those headers
authoritatively. On Node those headers arrive attacker-controlled, so ported verbatim the
IP allowlist would 403 everyone on a direct deployment and be trivially spoofable behind
none. *(Panel: failure #1 — blocker.)*

New rule, mirroring the Python original's trust posture (`deps.py`): the client IP is the
**socket remote address**. Forwarded headers are honored only when `TRUST_PROXY` is on.
`effectiveClientIp` is rewritten accordingly; the CF header names are deleted.

### Bindings replacement

The generated `Env` type is replaced by hand-written **concrete classes** (no interface
layer — one implementation per service, forever; TypeScript structural typing covers test
fakes). *(Panel: scope #5.)* Constructed once at startup:

| Cloudflare binding | Node replacement |
|---|---|
| `DB` (D1) | `better-sqlite3` over `DATA_DIR/catalog.db` behind a **thin D1-shaped adapter** (~40 lines): `prepare().bind().all()/first()/run()` with `run()` reporting `meta.changes`, plus `batch()` **implemented as a transaction** (D1's `batch` is atomic; `authStore` membership inserts rely on it). Decision closed — 39 call sites across 4 store files make the adapter strictly less churn than conversion. *(Panel: scope #4, assumptions #8.)* |
| D1 migrations | Same SQL files in `src/db/migrations/`, applied at startup by a small migrator (tracked in a `_migrations` table, filename-ordered). No existing Miniflare data is migrated — fresh `DATA_DIR` start. |
| SQLite pragmas (both catalog and session DBs) | `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON` (better-sqlite3 defaults FKs **off**; the catalog schema has `ON DELETE CASCADE` constraints D1 enforces), `busy_timeout` set. *(Panel: assumptions #7, failure #4.)* |
| `AUTH` (KV) — login sessions, OAuth CSRF, `companion:last_command` | `kv` table in catalog.db (`key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER NULL`). Get checks expiry lazily. **No sweep timer** — a single `DELETE … WHERE expires_at < now` at startup is enough for the low-churn rows that remain here (plain get/put/delete only; nothing uses `list`). *(Panel: scope #3.)* |
| KV — **companion presence** | **Not the kv table.** Presence moves to an in-memory `Map<clientId, PresenceMeta>` registry with per-entry TTL — exactly the Python `CompanionHub` shape. Rationale: presence lives in KV *metadata* with cursor-paginated `list()`, which the kv table can't represent without growing a metadata column + cursor emulation for this one caller; it's ephemeral by the spec's own restart semantics; and persisting it means a disk write per heartbeat per tab. The 4-5 call sites in `companion.ts` + test helper switch from KV calls to the registry. This *improves* Python parity. *(Panel: all four reviewers; resolution per scope #1.)* |
| `SESSION_DO` (Durable Object) | In-process **`SessionHub`** — see below. |
| `AUDIO` (R2) | Filesystem blob store under `DATA_DIR/audio/` — see below. |
| `ASSETS` (Workers Assets) | `serve-static` over the frontend build output with the `__API_ROOT__` substitution kept **as a phase-1 transitional mechanism only** (it exists to parameterize a prebuilt artifact; sub-project 2 replaces it with a Vite build-time define and deletes the rewrite path along with `public/`). *(Panel: scope #6.)* |

### Filesystem blob store (replaces R2)

The audio router needs more than get/put/delete/list *(panel: requirements #4,
assumptions #4)*:

- `get(key, {range})` supporting `offset/length` **and** `suffix` forms, returning the
  effective range and total `size`, with a **streamed** body — the router builds 206
  `Content-Range` responses for audio scrubbing from these.
- Range validation the fs layer must now own (R2 rejected garbage server-side): invalid or
  out-of-bounds ranges (`bytes=5-2`, start ≥ size) → 416, not a crashed
  `createReadStream`. *(Panel: failure #13.)*
- `put(key, bytes, {contentType})` — **atomic**: write to a temp file *outside* the listing
  prefix, `fsync`, then `rename`. A crash mid-write must never leave a partial file where
  `list`/reconciliation can see it, because `syncAudioFromR2`-style reconciliation would
  otherwise insert a metadata row for a truncated segment. *(Panel: failure #5.)*
- `delete(key)`, `list({prefix, cursor})` with `truncated`/`cursor` pagination shape
  preserved (may always return everything with `truncated: false`).
- `r2_key` strings become relative paths unchanged (verified server-constructed — session
  ids and segment names are server-generated; no user input reaches the path). A
  belt-and-braces resolve-under-`DATA_DIR` check is still required in the store.

### SessionHub (replaces SessionDO)

- Same flat RPC surface (~26 methods — `statusLive`, `startTake`, lease trio, transcript/
  topic CRUD, `broadcastCommand`, …; the plan enumerates from `SessionDO.ts`, not from
  examples here). Routers already call `stub.method(...)`; `getSessionDO` in
  `src/routers/_helpers.ts` becomes a lookup in an in-process `Map<sessionId, SessionHub>`
  with lazy instantiation. **One call site does not keep its shape:** the WebSocket route
  (`events.ts`) currently forwards the raw request via `stub.fetch()` for the
  `WebSocketPair` upgrade — that route is rewritten around `@hono/node-ws`'s
  `upgradeWebSocket`, preserving the existing middleware ordering (login gate +
  `requireSession` run **before** the upgrade). *(Panel: requirements #5.)*
- The six store modules survive with their logic intact behind a **SqlStorage-shaped shim**
  on `SessionCore` — the seam is wider than `db.exec` alone *(panel: assumptions #2)*: the
  shim provides `exec(sql, ...binds)` returning a cursor-like `{ toArray(), rowsWritten }`
  (three stores read `rowsWritten` for update-detection; better-sqlite3 reports `changes`),
  plus multi-statement exec for `initSchema`. `SessionCore`'s other members (`broadcast`,
  `metaGet/Set/Delete`, `bumpRevision`, `setAlarm`, …) are reimplemented on Node inside
  `SessionCore` itself; the stores don't change.
- **Per-RPC atomicity:** every hub RPC body runs inside a better-sqlite3 transaction. The
  DO's write-coalescing + output gates meant a response was never visible unless all its
  writes persisted; autocommit-per-statement would let a crash land between an event INSERT
  and its `bumpRevision`. *(Panel: failure #4.)*
- **Synchronous-RPC invariant (stated, load-bearing):** hub RPC bodies contain **zero
  `await`s** — better-sqlite3 and WS sends are synchronous, and this is what actually
  replaces the DO's input gates. Anything async (file I/O, network) lives in the router,
  never inside a hub method. This invariant is documented in `SessionHub`'s header and
  CLAUDE.md. *(Panel: failure #7.)*
- **WebSocket fan-out:** the hub keeps its connected sockets with a per-socket **role
  attachment** (the DO used `deserializeAttachment().role` to route broadcasts) via
  `@hono/node-ws`. Message/close/error handling logic ports as-is; close codes and
  companion re-broadcast behavior are pinned by the existing companion WS integration
  tests.
- **Alarm → timer:** single-slot semantics preserved — `setAlarm` **replaces** the pending
  timer (clear before set; lease heartbeats re-arm constantly and must not accumulate stale
  timers). On hub instantiation the hub calls **`expireIfStale()`** (not "re-arm if live"):
  that one call both cleans up a lease that went stale while the process was down and
  re-arms the timer when the lease is still live. *(Panel: assumptions #5, failure #9.)*
- **Idle eviction (for file handles, not memory):** every instantiated hub holds an open
  SQLite handle (+WAL/SHM fds); never evicting means fd exhaustion on default
  `ulimit -n 1024` once ~1k historical sessions are touched. Hubs with no live WebSockets,
  no armed lease timer, and no activity for an idle window close their DB handle and leave
  the registry; everything is on disk and reopens lazily. *(Panel: failure #6.)*

### Companion presence registry

New small module replacing the KV-metadata presence dance: in-memory
`Map<clientId, PresenceMeta & { expiresAt }>`, TTL-checked on read, mirroring the Python
`CompanionHub`. `companion.ts`'s `listPresence` cursor loop collapses to a registry scan.
Presence is ephemeral by design (already the spec's restart semantics); `last_command`
stays in the kv table as today.

### Invariants & restart semantics

- **Single Node process** — same single-writer assumption the DO gave us, now backed by the
  synchronous-RPC invariant above. Documented in CLAUDE.md/README; no clustering support.
- Durable on disk: catalog.db, per-session DBs, audio files. Rebuilt naturally on restart:
  WS connections, in-memory presence, lease timers (via `expireIfStale` on instantiation),
  login sessions (kv table, so they survive).
- **Known parity windows (acknowledged, not fixed here):** the catalog projection
  double-write can be momentarily stale after a crash between hub commit and
  `projectSessionLive` — true on CF today, structurally absent only in Python's single DB;
  do not "fix" it with a cross-DB transaction, it re-heals on the next mutation. Ghost
  metadata rows (segment row whose bytes never landed) have no reaper — same window
  existed on CF; sync-from-disk only *adds* rows for found files. Uploads buffer up to
  50 MB per request in one heap — an operational limit worth a README note, not a redesign.
  *(Panel: failure #10, #11, #12.)*

### Tests

- **Unit tier** (`*.test.ts`, node): unchanged.
- **Integration tier** (`*.int.test.ts`): the **route assertions port; the harness is
  rebuilt** *(panel: assumptions #3 — the earlier "re-pointed, not rewritten" framing
  understated this)*:
  - Fresh bindings over a temp `DATA_DIR` **per test** (Miniflare's `isolatedStorage`
    rolled back state per test; per-suite bindings would make e.g. the global
    `companion:last_command` assertions order-dependent).
  - `fetchMock` (cloudflare:test) → undici `MockAgent` interception for the Google
    token/JWKS fakes in the OAuth suites.
  - `runInDurableObject`/`storage.getAlarm` tests in `SessionDO.int.test.ts` become direct
    `SessionHub` instantiation tests (construct hub over a temp DB, call RPCs, inspect).
  - WS suites swap Workers' fetch-upgrade for a real listening server on an ephemeral port
    + a Node WS client.
- `vitest.workspace.ts` collapses to a single project (or is deleted).
- Definition of done: `npm test` + `npm run typecheck` green; every endpoint the old
  integration suite covered is covered against the Node bindings.

### Removal list

`wrangler`, `@cloudflare/vitest-pool-workers`, `wrangler.jsonc`,
`worker-configuration.d.ts`, `cloudflare:workers` imports (`DurableObject` base class),
`WebSocketPair`, CF client-IP header names, `cf-typegen`/`migrate:local`/`deploy` scripts,
README/CLAUDE.md sections describing the CF architecture (rewritten to describe the Node
architecture).

## Sub-project 2: frontend adoption (summary)

Starts with the mechanical workspace conversion (`src/` → `server/src/`, root fan-out
scripts). Move `/home/kalen/AutoLog/frontend` into `web/` as a workspace. Vite dev server
proxies `/api`, `/auth`, and the session WebSocket to the Node server; production build
output is what the server's static layer serves. `__API_ROOT__` becomes a Vite build-time
define and the serve-time HTML rewrite is deleted along with the `public/` snapshot
artifact. No component changes; the copy in the Python repo is left untouched and this
repo's copy becomes canonical for this app. Own spec before implementation.

## Sub-project 3: Tailwind migration (summary)

Tailwind v4, CSS-first `@theme` mapping the existing `tokens.css` custom properties so
converted components render identically. Component-by-component conversion of the 23 CSS
Module files (~7,300 lines), keeping `clsx` composition; the shared plain-CSS layer
(`baseline.css`, `chrome.css`, `bgGlow.css`, `glass.module.css`) converts last. Own spec
before implementation.

## Risks

- **Lease/alarm drift:** Node timers aren't durable like DO alarms. Mitigated by lazy
  expiry checks + `expireIfStale` on hub instantiation; pinned by ported lease tests.
- **WebSocket parity:** close codes and re-broadcast semantics differ between runtimes.
  The companion WS integration suite is the safety net.
- **Shim fidelity:** two small adapters (D1-shaped for the catalog, SqlStorage-shaped for
  `SessionCore`) each carry semantic edges (`meta.changes` vs `rowsWritten`, batch
  atomicity, multi-statement exec). Kept small by implementing only what call sites use,
  each covered by the ported tests.
- **`better-sqlite3` is a native module:** fine for Node hosts; a constraint if a
  single-binary bundle is ever wanted (noted, not designed for).

## Out of scope

- Transcription and YouTube import remain `503` (they were CF-side stubs; a Node
  implementation is a separate future project).
- Multi-process/cluster deployment.
- Approach B (single-database re-unification) — possible later refactor, not this work.
- Any change to JSON shapes or status codes.

## Panel & review log

### 2026-07-09 — Adversarial panel (4 reviewers: requirements, assumptions, failure & abuse, scope/YAGNI)

All four reviewers independently found the KV-metadata/presence defect — the spec's
original kv-table schema would have shipped a dead companion subsystem.

**Blockers/majors fixed in place:**

1. **KV metadata / companion presence** (all four reviewers) → presence moved to an
   in-memory registry (Python `CompanionHub` parity); kv table keeps only value-based
   get/put/delete rows.
2. **Spoofable/broken client-IP derivation** (failure #1, requirements #2) → socket
   remote address by default, `TRUST_PROXY` knob for forwarded headers.
3. **`COOKIE_SECURE` auto-detect behind TLS proxies** (requirements #3, failure #8) →
   `X-Forwarded-Proto` honored under `TRUST_PROXY`; documented in config table.
4. **R2 interface understated** (requirements #4, assumptions #4) → ranged/streamed `get`
   with `size`, atomic temp+fsync+rename `put`, paginated `list`, 416 range validation
   (failure #13).
5. **Per-RPC write atomicity lost vs. DO write-coalescing** (failure #4) → transaction per
   hub RPC + WAL/`synchronous=NORMAL` pragmas.
6. **`SessionCore` seam wider than `db.exec`** (assumptions #2) → SqlStorage-shaped shim
   named (`toArray()`/`rowsWritten`, multi-statement exec); socket role attachments carried
   into the fan-out design.
7. **Synchronous-RPC invariant unstated** (failure #7) → stated as a documented invariant;
   it is the replacement for DO input gates.
8. **fd exhaustion from never-evicted hubs** (failure #6; also noted by scope in its
   per-session-files probe) → idle eviction
   closing DB handles; reopen lazily.
9. **"Re-pointed, not rewritten" test framing dishonest** (assumptions #3) → reframed:
   assertions port, harness rebuilt (per-test bindings, undici MockAgent, hub-direct tests,
   real WS server).
10. **Lease re-arm rule** (failure #9, assumptions #5) → `expireIfStale()` on
    instantiation; single-slot timer semantics.
11. **FK enforcement / batch atomicity** (assumptions #7, #8) → pragmas row; transactional
    `batch()`.
12. **Workspace move mistimed** (scope #2) → deferred to the start of sub-project 2.
13. **D1-adapter hedge** (scope #4, corroborated by both other code-level reviewers) →
    closed: thin adapter, decision recorded with call-site counts.
14. **kv sweep timer** (scope #3) → dropped for a startup purge.
15. **Interface layer with one implementation** (scope #5) → concrete classes.
16. **`__API_ROOT__` substitution outliving its cause** (scope #6) → marked phase-1
    transitional; deleted in sub-project 2.
17. **Stale helper name** (requirements #5) → spec now says `getSessionDO`; WS route
    explicitly carved out of the "call sites keep their shape" claim.

**Escalated to the gate (owner decisions, not silently adopted):**

- **E1 — `REQUIRE_LOGIN` default on public hosts** (failure #2): spec currently records a
  loud startup warning when binding non-loopback with no auth perimeter. Options: warning
  only (Python-parity default, preserves the LAN-studio workflow), refuse-to-start with an
  explicit override flag, or flip the default. **Decision: _pending._**
- **E2 — `restart_supported: false`** (requirements #6): a Workers-era hardcode; the Python
  original supports `serve --supervise`. Spec keeps `false` for phase 1 (recommendation:
  revisit as a future feature, out of scope here). **Decision: _pending._**

### 2026-07-09 — Post-panel consistency read (light tier)

One reviewer swept the revised document for stale pre-panel language, log/body
contradictions, dangling cross-references, and inter-section conflicts. Result: clean
except one citation-style nit in log item 8, fixed in place. Both escalations correctly
pending in the body.

**Minors accepted as residual:** projection-staleness window, ghost metadata rows, 50 MB
upload buffering (all parity with CF; acknowledged in "Known parity windows" so nobody
"fixes" them with a cross-DB transaction later); KV `list_complete` single-shot shape
(moot after presence moved off KV); DO structured-clone vs. shared references
(assumptions #6 — stores materialize fresh objects per query; noted, not engineered).
