## ADDED Requirements

### Requirement: Domain core is free of departed-platform references

The domain core and its adapters SHALL NOT reference Cloudflare Workers concepts in
directory names, file names, type names, identifiers, or comments. Names SHALL describe
the role a unit plays, not the platform it was ported from. Persisted schema tokens that
would require a data migration to rename (notably the `r2_key` column) are **grandfathered**
and exempt — the "no cloud" invariant forbids the migration, so the token is documented as
a legacy name rather than changed.

#### Scenario: No Cloudflare nouns in the source tree
- **WHEN** the server source is inspected for `durable`, `SessionDO`, `d1`, `SESSION_DO`, `stub` (as a DO-RPC handle), `wrangler`, `R2`, or "the Worker"/"the DO" as live references
- **THEN** none remain except (a) historical migration docs under `docs/superpowers/` and (b) the grandfathered `r2_key` persisted column, which is annotated as a legacy schema token

#### Scenario: Session directory renamed
- **WHEN** the per-session spine is located
- **THEN** it lives under `server/src/session/` (not `durable/`) and the catalog facade is `catalog.ts` (not `d1.ts`)

### Requirement: Session runtime is a synchronous, substitutable port

The session spine SHALL depend on a `SessionRuntime` port exposing SQL, socket fan-out,
an alarm/scheduler, and a clock — as an **interface**, so a fake runtime can be supplied in
tests without touching `SessionCore`. The port SHALL be synchronous so that `SessionHub`
RPC bodies remain zero-`await`, and it SHALL abstract over embedded stores only.

#### Scenario: Hub methods contain no awaits
- **WHEN** any `SessionHub`/domain-store mutating or reading RPC body is inspected
- **THEN** it contains zero `await` expressions and runs inside a single synchronous transaction

#### Scenario: SQL seam exposes a domain shape, not the Durable Object cursor API
- **WHEN** the session SQL seam is inspected
- **THEN** it exposes `all(sql, ...binds)` returning rows and `run(sql, ...binds)` returning an affected-row count (`{ changes }`), and does not expose the `exec() → { toArray(), rowsWritten }` cursor shape

#### Scenario: run() preserves change-detection for its readers
- **WHEN** `setAudioSegmentWaveform`, `deleteTopic`, or `deleteTranscriptWord` runs against a non-existent id
- **THEN** it observes zero affected rows and returns the "not found" result, so the routers still respond `404` and no `audio.changed` broadcast fires on a no-op write

#### Scenario: Schema init retains a multi-statement path
- **WHEN** `initSchema` executes multi-statement DDL
- **THEN** a distinct `void`-returning multi-statement `exec` path serves it, separate from the `all`/`run` seam

#### Scenario: SessionCore is testable with a fake runtime
- **WHEN** a test constructs `SessionCore` with an in-memory SQL + fake sockets + fake clock
- **THEN** it exercises the domain stores without a real database, socket, or wall-clock

### Requirement: Catalog persistence is synchronous with no Cloudflare-shaped API

The catalog persistence seam SHALL expose a synchronous `all()` / `run()` / `tx()` surface
and SHALL NOT expose D1's `prepare().bind().all()/first()/run()` shape. Catalog store
methods SHALL NOT declare `async`/return promises for persistence that is synchronous.
`run()` SHALL return an affected-row count (`{ changes }`) for callers that detect changes.

#### Scenario: No async costume in catalog stores
- **WHEN** the catalog stores under `server/src/db/` are inspected
- **THEN** they contain no `await` on synchronous persistence, expose `all()/run()/tx()` rather than `prepare().bind()`, and their methods are synchronous

#### Scenario: Change-detecting callers still work
- **WHEN** a catalog operation that detects modification (removed membership, archived session) runs
- **THEN** it reads the affected-row count from `run()` and behaves identically to before

#### Scenario: Atomic multi-statement writes use tx()
- **WHEN** a catalog operation performs multiple writes atomically (formerly `batch()`)
- **THEN** it runs them inside a single `tx()` implemented via `better-sqlite3`'s `db.transaction()` (not raw `BEGIN/COMMIT`), with all-or-nothing semantics preserved under a mid-write failure

### Requirement: Catalog facade exposes only role-scoped stores

The `Catalog` type SHALL expose its domain stores (`shows`, `studios`, `auth`,
`sessions`, `profile`) as the sole API surface. The flat delegate methods that forward to
those stores SHALL be removed, and callers SHALL reach behavior through the store fields.

#### Scenario: Delegate shim removed
- **WHEN** the catalog facade is inspected
- **THEN** it contains no flat delegate methods (e.g. `getShowRow`, `authGetUserById`) and callers use `catalog.shows.getShowRow(...)` etc.

### Requirement: Composition root separates ports from configuration

The composition root SHALL produce a **Ports** object holding constructed services and a
distinct **Config** object holding plain configuration values, with role-named service keys
and no Cloudflare binding names (`DB`, `AUTH`, `SESSION_DO`, `AUDIO`) or `Env = Bindings`
alias. The split SHALL preserve the per-request in-place `env`-mutation identity contract
that the `@hono/node-ws` upgrade handshake depends on (the injected object's identity must
not be replaced or spread per request).

#### Scenario: Ports and config are separate
- **WHEN** the composition root is inspected
- **THEN** services and config strings are returned as separate objects, with role-named service keys and no `Env` alias

#### Scenario: WebSocket upgrades still complete after the split
- **WHEN** a real WebSocket upgrade is driven end-to-end (the Companion WS integration path)
- **THEN** the upgrade completes and messages are delivered, confirming the per-request env-identity contract survived the Ports/Config split

### Requirement: Wall-clock time is read through a single Clock port

Every decision-making time read SHALL obtain the current time from a single injected
synchronous `Clock` port rather than calling `Date.now()` directly — covering
recording-lease staleness/expiry and alarm scheduling, session live-timecode derivation,
key/value TTL expiry (login sessions, OAuth CSRF), Companion presence freshness, and the
identity JWKS cache TTL. The lease **alarm scheduler and the clock SHALL share one time
base**, so an alarm scheduled from clock time and an expiry check reading clock time cannot
diverge (no real-`setTimeout`-vs-fake-clock skew).

#### Scenario: Lease expiry is deterministic through the hub
- **WHEN** a test claims a lease, advances a fake clock past the stale threshold, and triggers expiry through the hub
- **THEN** the lease is freed without any real time passing, and the alarm neither busy-refires nor fails to fire

#### Scenario: TTL and freshness are testable without real elapsed time
- **WHEN** a test advances a fake clock past a KV entry's TTL (or the presence freshness window, or the JWKS cache TTL)
- **THEN** the entry is treated as expired/stale without any real time passing

#### Scenario: No decision-making Date.now() remains
- **WHEN** the server source is inspected for direct `Date.now()` calls in staleness, TTL, expiry, freshness, alarm-scheduling, or live-timecode logic
- **THEN** none remain; those paths read the injected `Clock`

### Requirement: Identity verification is a port with no hidden global state

Google ID-token verification and OAuth code exchange SHALL be provided through an
`IdentityVerifier` port whose implementation holds its JWKS cache as instance state and
reads TTL from the injected `Clock`. No module-level mutable singleton SHALL back the verifier.

#### Scenario: JWKS cache is instance state
- **WHEN** the identity verifier is inspected
- **THEN** the JWKS cache lives on an instance (no module-level `let`), and a test can supply a fake verifier without network access

### Requirement: Authentication and authorization are distinct, single seams

Request **authentication** (resolving identity from session cookie or `API_TOKEN`) SHALL be
performed once in middleware. Resource **authorization** (existence + studio-membership +
admin-token checks) SHALL be consolidated behind `requireSession`/`authorize` rather than
re-deriving the login decision. The login-required check SHALL NOT be duplicated between
middleware and per-route helpers. The consolidation SHALL preserve these exact behaviors,
each locked by a scenario below. (Replacing the `apiRequestRequiresLogin` URL-prefix matcher
with an explicit per-route policy is **deferred** — see design D6 — so its default-deny
requirements are out of scope for this change.)

#### Scenario: Login check is not duplicated
- **WHEN** a session-scoped route is exercised under `REQUIRE_LOGIN=1`
- **THEN** the unauthenticated-401 decision is made exactly once, and `requireSession` performs only resolve + authorize

#### Scenario: API_TOKEN machine clients bypass studio membership
- **WHEN** a request authenticated by `API_TOKEN` (no user) accesses a session in any studio under `REQUIRE_LOGIN=1`
- **THEN** it is allowed after an existence check, with no membership scoping applied — the Companion machine path is unchanged

#### Scenario: Cross-studio access is masked as 404, not 403
- **WHEN** an authenticated user who is not a member of a session's studio requests that session
- **THEN** the response is `404` "Session not found" (not `403`), identical before and after

#### Scenario: Admin token distinguishes unset from wrong
- **WHEN** an `/api/admin/*` route is called with `ADMIN_TOKEN` unset versus with an invalid token
- **THEN** it returns `503` (unset) versus `401` (invalid) respectively, and a session cookie alone grants no admin access

### Requirement: HTTP/WS surface parity is preserved and verified

This change SHALL NOT alter the observable HTTP/WebSocket surface — every route, method,
status code, and JSON response shape in `AUTH-API.md` SHALL be identical before and after.
Because existing test coverage is absent on several reshaped units (`requireSession`,
`authContext`, the session SQL seam, enrichment), any seam lacking covering tests SHALL
gain a **characterization test** (byte-identical JSON/status on a representative session,
plus the `API_TOKEN` cross-studio path and a `tx()` rollback) **before** it is reshaped.
"Existing suites pass" alone SHALL NOT be treated as sufficient parity evidence for an
untested seam.

#### Scenario: Reshaped-but-untested seams are pinned first
- **WHEN** a seam without covering tests is about to be reshaped
- **THEN** a characterization test capturing its current observable output exists and passes before the reshape lands

#### Scenario: Existing suites pass unchanged
- **WHEN** the server unit and integration test suites run against the refactored core
- **THEN** they pass without changes to expected responses, and the `503` null-adapter routes still return their clean `503`
