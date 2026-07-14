## Why

This codebase is a Python → Cloudflare-Workers → portable-Node port. The CF → Node
migration was done carefully, but it kept the departed platform's **names and API
shapes**: `server/src/durable/` holds no Durable Objects, `d1.ts` / `d1Adapter.ts`
touch no D1, the composition root emits a Cloudflare `env` object (`SESSION_DO`, `DB`,
`AUDIO`, `AUTH` bindings + an `Env = Bindings` alias), and the router/hub division of
labor is drawn along the old process boundary (the DO couldn't reach D1, so domain
logic got stranded in routers). The seams themselves are correct ports — they just
wear Cloudflare's uniform, which is friction for every future reader and a drag on
testability. "Single Node process, state on local disk" is now a **permanent** project
invariant, so the Cloudflare chapter is closed and the code should stop referencing it.

## What Changes

Two phases, no observable behavior change — Python/frontend JSON shapes and status
codes are preserved throughout, and every step is test-gated.

**Phase 1 — Strong core (subtraction; no behavior change):**
- Rename `durable/` → `session/`, `d1.ts` → `catalog.ts`, drop the `d1Adapter` naming;
  rename `getSessionDO`/`SESSION_DO`/`stub` → hub, and purge "the Worker" / "the DO"
  comments and CF nouns from identifiers.
- Reshape the **session** persistence seam off the Durable Object cursor API
  (`sql.exec() → {toArray, rowsWritten}`) to `all()` (rows) and `run()` returning an
  affected-row count `{ changes }` — the count is **not** dead (three delete/waveform
  readers drive 404s + the `audio.changed` broadcast). `SqlShim` collapses or folds into
  `SessionHub`, with a distinct `void` multi-statement path kept for `initSchema`. Stays
  **synchronous**.
- Reshape the **catalog** persistence seam off D1's `prepare().bind().all()` API to
  `all()`/`run()`/`tx()`; remove the async costume — the awaits reach no real I/O (all bottom
  out at synchronous SQLite). **Catalog becomes synchronous**; this also drops the `async`
  method signatures and updates ~79 awaited call sites across routers + middleware.
- **DELETE** the `Catalog` facade's ~70 flat delegate methods (already flagged a compat
  shim); routers call `catalog.shows.x()` etc. directly.
- Split the composition root's output (`config.ts createBindings`) into a **Ports**
  object (services) and a **Config** object (plain strings); kill the CF binding names
  and the `Env = Bindings` alias.
- Delete the **duplicated login check** in `requireSession` (the middleware already ran
  it for every `/api/` route).

**Phase 2 — Adopt the ports where they pay** (trimmed at the spec-review gate to the ports a
fake/second impl actually unlocks):
- Introduce a synchronous **Clock** port — app-wide (lease staleness + alarm, session
  live-timecode, KV TTL, presence freshness, JWKS TTL). The alarm scheduler and clock share
  one time base so lease-expiry is deterministic through the hub.
- Extract an **IdentityVerifier** port wrapping the Google JWKS verify + code exchange;
  kill the module-level `jwksCache` singleton (cache → instance state).
- Consolidate authorization: `requireSession` becomes resolve + authorize (existence +
  membership + admin), with the duplicated login check deleted. Preserve exactly the
  `API_TOKEN`-bypasses-membership, cross-studio-404, and admin-503-vs-401 behaviors.

**Cut / deferred at the gate:** **BlobStore** stays concrete (rename-only) — an S3 adapter is
the cloud future the invariant forbids; **the show/enrichment domain service is deferred**
(already in `studio.ts`, no second caller); **retiring `apiRequestRequiresLogin` for an
explicit per-route policy is deferred** (re-architects working auth for no bug — the matcher
stays).

**Explicitly out of scope / left alone:** the `503` null-adapter routes
(`transcribe`/`generate`/`youtube-import` — parity-correct; the transcribe-MCP work was
dropped); `KvStore`, `PresenceRegistry`, and now `BlobStore` stay concrete (rename-only); the
WS + Companion long-poll driving adapters are both legitimate and are not merged.

## Capabilities

### New Capabilities
- `core-ports-architecture`: The normative contract for the domain core and its
  adapter boundaries — the port ledger (the true ports SessionRuntime, Clock,
  IdentityVerifier; CatalogStore as a reshape-not-swap seam) and the concrete-only edges
  (BlobStore, KvStore, PresenceRegistry); the **deliberate synchronous-hub /
  synchronous-catalog** posture (embedded-only, no Cloudflare-shaped or async-costume
  APIs); the composition-root Ports/Config split; and the auth split (authentication in
  middleware, authorization consolidated behind `requireSession`). Extracting a
  show/enrichment domain service is out of scope for this change (deferred — no second
  caller).

### Modified Capabilities
<!-- None modified. openspec/specs/ was empty when this change was drafted; the durable
`api-contract-freeze` baseline has since landed (retire-python-port-framing, archived
2026-07-14) and freezes the same HTTP/WS surface this change's parity requirement
re-asserts. At /opsx:archive, reconcile the change-scoped "HTTP/WS surface parity is
preserved and verified" requirement (anchored on AUTH-API.md) with that baseline during
the sync, so openspec/specs/ doesn't end up with two differently-anchored freeze
definitions (hand-off recorded in
openspec/changes/archive/2026-07-14-retire-python-port-framing/design.md). -->

## Impact

- **Server code, wide but mechanical**: `server/src/durable/**` (→ `session/`),
  `server/src/db/**` (catalog stores + facade), `server/src/node/**` (config, adapters,
  sqlShim, d1Adapter), `server/src/routers/**` (helpers, auth middleware, events),
  `server/src/auth/**` (identity, oauth_google), `server/src/types.ts` (Bindings split).
- **No API/JSON/status-code changes** — the HTTP/WS surface in `AUTH-API.md` is
  unchanged; the frontend and Companion module see identical responses.
- **Tests**: existing unit + integration suites are the parity gate for Phase 1;
  Phase 2's new ports each land with a fake adapter that pays for itself in tests.
- **Docs**: `README.md`, `CLAUDE.md`, and `AUTH-API.md` naming references updated to
  drop CF nouns; repo title `autologger-cf` reconciled with package name `autologger`.
- **No dependency or runtime changes**; `restart_supported` stays `false`.
