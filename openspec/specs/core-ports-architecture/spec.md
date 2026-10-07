# core-ports-architecture

## Purpose

The normative contract for the domain core and its adapter boundaries: the port ledger
(the true ports SessionRuntime, Clock, IdentityVerifier; CatalogStore as a
reshape-not-swap seam) and the concrete-only edges (BlobStore, KvStore,
PresenceRegistry); an asynchronous, per-session serialized session hub (ADR 0021 slice 7a), with asynchronous
catalog, key/value and presence ports (ADR 0021 slice 3) and no Cloudflare-shaped APIs; the composition-root
Ports/Config split; and the auth split (authentication in middleware, authorization
consolidated behind `requireSession`). Established by the `de-cloudflare-strong-core`
change (archived 2026-07-14), which retired the departed Cloudflare platform's names and
API shapes. The port ledger's types now live in the standalone `@autologger/ports`
package, with domain modules split into `@autologger/domain` and `@autologger/contract`,
established by the `package-split-foundation` change (archived 2026-08-07). The
`persistence-package-extraction` change (archived 2026-08-07) established the
`@autologger/session-core` and `@autologger/catalog` persistence facades and their
`createCatalog` factory, and retired the former `appEnv.ts` allowance to name the
concrete `SessionHubRegistry`/`Catalog` classes. The `router-directory-decomposition`
change (archived 2026-08-07) strengthened the interface-only enforcement to defeat
deep-subpath specifiers, `export … from` re-exports, and wildcard clauses (including
type-wildcards), with synthetic-tree mutation coverage, and recorded its remaining
textual-scan bypasses explicitly.

## Requirements

### Requirement: Domain core is free of departed-platform references

The domain core and its adapters SHALL NOT reference Cloudflare Workers concepts in
directory names, file names, type names, identifiers, or comments. Names SHALL describe
the role a unit plays, not the platform it was ported from. Persisted schema tokens that
would require a data migration to rename (notably the `r2_key` column) are **grandfathered**
and exempt — the "no cloud" invariant forbids the migration, so the token is documented as
a legacy name rather than changed.

#### Scenario: No Cloudflare nouns in the source tree
- **WHEN** the server source **and the workspace packages under `packages/`** are inspected for `durable`, `SessionDO`, `d1`, `SESSION_DO`, `stub` (as a DO-RPC handle), `wrangler`, `R2`, or "the Worker"/"the DO" as live references
- **THEN** none remain except (a) historical migration docs under `docs/superpowers/` and (b) the grandfathered `r2_key` persisted column, which is annotated as a legacy schema token

#### Scenario: Session directory renamed
- **WHEN** the per-session spine is located
- **THEN** it lives in `@autologger/session-core` (`packages/session-core/src/`, not a `durable/` directory) and the catalog facade is `catalog.ts` in `@autologger/catalog` (not `d1.ts`)

### Requirement: Catalog persistence is asynchronous with no Cloudflare-shaped API

The catalog persistence seam SHALL be the asynchronous `CatalogDb` port: promise-returning
`all()`, `first()`, `run()` and `tx()`, under the catalog transaction contract. It SHALL NOT
expose D1's `prepare().bind().all()/first()/run()` shape. `run()` SHALL return an affected-row
count (`{ changes }`) for callers that detect changes.

Every catalog store method that reaches the database SHALL return a promise, and every internal
call SHALL await it. The studio registry's memory-only getters (`studioNamesDict`,
`studioOrderTuple`, `isKnownStudio`, `listStudiosBrief`, `listStudiosBriefAllowed`) SHALL stay
synchronous, and are correct only after the catalog's `init()` has been awaited.

A store method or route that reads and then writes, or writes several rows, SHALL do so inside
one `tx()`. Its body SHALL run on stores bound to the transaction handle, so a store transaction
inside a route transaction joins it.

#### Scenario: No async costume in catalog stores
- **WHEN** the catalog stores in `@autologger/catalog` (`packages/catalog/src/`) are inspected
- **THEN** they reach the database only through the promise-returning `CatalogDb` port, never wrap a synchronous call in `async` themselves, expose `all()/first()/run()/tx()` rather than `prepare().bind()`, and no synchronous catalog adapter remains in production code

#### Scenario: Change-detecting callers still work
- **WHEN** a catalog operation that detects modification (removed membership, archived session) runs
- **THEN** it reads the affected-row count from `run()` and behaves identically to before

#### Scenario: Atomic multi-statement writes use tx()
- **WHEN** a catalog operation performs multiple writes atomically, or writes based on what it just read
- **THEN** it runs them inside a single `tx()`, with all-or-nothing semantics preserved under a mid-write failure

#### Scenario: A store transaction composes inside a route transaction
- **WHEN** a route's catalog transaction calls a store method that has its own transaction, and the route body then fails
- **THEN** the store method's writes are rolled back with the route's

#### Scenario: Concurrent first reads do not collide
- **WHEN** two calls that create a row only if it is missing (a user's preferences row, a new team) run interleaved
- **THEN** both complete without a constraint error, and exactly one row exists

### Requirement: Catalog facade exposes only role-scoped stores

The `Catalog` type SHALL expose its domain stores (`shows`, `studios`, `auth`,
`sessions`, `profile`) as its API surface, plus two lifecycle members: `init()`, which loads the
studio registry, and `tx()`, which runs a body on a `Catalog` bound to one catalog transaction,
and three binding members (core-ports-architecture "Every catalog and session call is bound to a caller"):
`forUser(userId)`, which returns a catalog whose statements run for that signed-in user,
`system(reason)`, which returns a catalog whose statements run for the named system task, and
`unbound()`, which returns a catalog whose every statement is refused. Each binding member SHALL
return a catalog that carries this catalog's studio-registry snapshot without a query. A catalog
from `tx()` SHALL keep the binding of the catalog it was called on. The flat delegate methods that
forward to those stores SHALL be removed, and callers SHALL reach behavior through the store
fields.

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
key/value TTL expiry (login sessions, OAuth CSRF), Companion presence freshness, the
identity JWKS cache TTL, the log-import job store's expiries, finished-at stamping and
heartbeat staleness (ADR 0021 slice 9b), the AI v2 pending-question deadline, the AI chat
resume binding's expiry, and the AI runtime's process-group kill-ladder deadline. The lease **alarm
scheduler and the clock SHALL share one time base**, so an alarm scheduled from clock time
and an expiry check reading clock time cannot diverge (no real-`setTimeout`-vs-fake-clock
skew).

A time read that falls **outside every class enumerated above**, and on which no control
flow, expiry decision, ordering, or persisted state depends, is not a decision-making read
and **need not** be converted to the port. Such a value MAY be rendered in a message or
serialized into a response field. Establishing that a read is of this kind SHALL require
reading every consumer of the value, not only its producer, and each such read SHALL be
**named in the delta of the change that establishes it** — recording the reasoning only in a
design document does not survive archive. This exemption never narrows the enumeration
above: a read that serves live-timecode derivation, lease or TTL expiry, freshness, or alarm
scheduling remains covered even where its computed result is only serialized.

`transcriptGenerationLock.tryAcquire`'s `startedAtMs` (one entry per session since
run-status-and-sweeper D3) is such a read: the in-process entry never expires by time and is
cleared in a `finally`, nothing branches on the value, and it is only rendered in the same-process
`409` detail. A run lease's `started_at_ms` is not such a read: it orders the runs that
`GET /api/transcript-generation/status` chooses between, so a run-lease claim SHALL take it from
the Clock port, as it takes the lease's expiry (run-status-and-sweeper D4).

**One** `Date.now()` site is a known standing exception: `SessionHub`'s `DEFAULT_CLOCK`
fallback in package production code, which never fires on the production path and is
deliberately local so the hub does not depend on the composition root. The AI runtime's
process-group kill ladder — previously recorded here as a second standing exception, owned by
the change that packages the AI runtime — is **discharged by that change** and is no longer an
exception.

**A `Clock` injected into a path that must not throw SHALL be a required parameter, not an
optional field on an options object.** The kill ladder's entry point is documented as never
throwing, and it is awaited inside `finally` blocks whose *remaining* statements release a
concurrency slot, abandon pending questions, dispose an MCP turn token, and delete a directory
holding copied operator credentials. A throw there leaks a slot for the process lifetime,
leaves a turn token valid, orphans a process group, and escapes as a `500` on an otherwise
successful request. An optional clock makes a missed construction site typecheck; a required
one makes it a compile error. The entry point SHALL remain total.

Where a `Clock` is injected into a loop that also **sleeps**, the sleep SHALL be controlled by
the same test-time mechanism as the clock. `Clock` exposes `now()` only, so a polling loop
whose deadline reads an injected clock while its sleep uses a real timer will, under a fake
clock that never advances, spin forever rather than fail — converting a would-be assertion
failure into a hung suite, in **existing** tests as well as new ones. Injecting a clock into
such a loop without also controlling its sleep is half a seam and SHALL NOT be described as
complete.

#### Scenario: A named exemption is recorded where it survives
- **WHEN** a change declines to convert a time read on the grounds above
- **THEN** the delta spec names the read and the property that exempts it, so a later reader inspecting the durable baseline can distinguish an examined exemption from an overlooked violation

#### Scenario: Lease expiry is deterministic through the hub
- **WHEN** a test claims a lease, advances a fake clock past the stale threshold, and triggers expiry through the hub
- **THEN** the lease is freed without any real time passing, and the alarm neither busy-refires nor fails to fire

#### Scenario: TTL and freshness are testable without real elapsed time
- **WHEN** a test advances a fake clock past a KV entry's TTL (or the presence freshness window, or the JWKS cache TTL)
- **THEN** the entry is treated as expired/stale without any real time passing

#### Scenario: No decision-making Date.now() remains
- **WHEN** the server source **and the workspace packages under `packages/`** are inspected for direct `Date.now()` calls in staleness, TTL, expiry, freshness, alarm-scheduling, live-timecode, or process-kill-deadline logic
- **THEN** none remain; those paths read the injected `Clock` (the `systemClock` implementation, which lives with the composition root, is the sole sanctioned `Date.now()` site **for decision-making reads**; `SessionHub`'s `DEFAULT_CLOCK` is the only other)

#### Scenario: The kill ladder's deadline is deterministic and its sleep is controlled
- **WHEN** a test drives the process-group kill ladder against a group that does not exit, with both the injected clock and the poll's sleep under test control
- **THEN** the SIGTERM→SIGKILL escalation occurs exactly when the injected clock passes the grace deadline, without real elapsed time, and the test terminates rather than hanging

#### Scenario: Existing ladder tests survive the injection
- **WHEN** the pre-existing kill-ladder tests that drive a genuinely live process group are run after the clock is injected
- **THEN** each terminates and asserts the same escalation behavior as before — a mechanical substitution of a frozen fake clock that leaves the poll's real timer in place is not an acceptable conversion, and any test-scoped timer control is scoped so that helpers awaited *before* the code under test are not themselves stalled

#### Scenario: The kill ladder entry point remains total
- **WHEN** the process-group kill entry point and its callers are inspected after the clock is threaded
- **THEN** the clock is a required parameter at every level rather than an optional options field, the entry point has gained no path that throws, and the `finally` blocks that await it still run their remaining cleanup statements

#### Scenario: Job lifecycle expiry is testable without real elapsed time
- **WHEN** a test creates log-import jobs through the injected clock, drives some to a terminal status, advances the clock past the terminal-job TTL, and then reads a job back
- **THEN** the expired terminal jobs are pruned and the jobs that are still queued or running survive, without any real time passing

#### Scenario: Size-cap eviction is unchanged and reads no time
- **WHEN** many log-import jobs exist (the in-memory store and its size cap were removed in ADR
  0021 slice 9b; jobs live in the key-value store)
- **THEN** no job is evicted by count: a job leaves only when its key-value expiry passes, judged
  by the Clock port

#### Scenario: Job status observed through the app is unchanged
- **WHEN** a log-import job is created, progresses, and reaches a terminal status through the real app after the clock is injected
- **THEN** the status endpoint's JSON shape, status codes, and creator-scoping behavior are identical to before the change, and no job time value is observable on the wire (`systemClock` reads the same source the direct call did)

#### Scenario: A stale job is judged by the Clock port
- **WHEN** a test starts a log-import job through the injected clock, stops its heartbeat, and
  advances the clock 61 s
- **THEN** a read of the job reports it `failed` with error `The server running this import stopped.`

### Requirement: Identity verification is a port with no hidden global state

Google ID-token verification and OAuth code exchange SHALL be provided through an
`IdentityVerifier` port whose implementation holds its JWKS cache as instance state and
reads TTL from the injected `Clock`. No module-level mutable singleton SHALL back the verifier.

#### Scenario: JWKS cache is instance state
- **WHEN** the identity verifier is inspected
- **THEN** the JWKS cache lives on an instance (no module-level `let`), and a test can supply a fake verifier without network access

### Requirement: Authentication and authorization are distinct, single seams

Request **authentication** (resolving identity from session cookie or `API_TOKEN`) SHALL be
performed once in middleware; `API_TOKEN` SHALL be honoured only on paths under
`/api/companion/` (see `api-contract-freeze` "API_TOKEN authenticates only the Companion
surface"). The middleware's path decisions (login required, `API_TOKEN` scope) SHALL use the same
percent-decoded path the router matches, so a request that reaches an `/api/*` handler is always
judged as an `/api/*` request. Resource **authorization** (existence + show access + admin-token checks; show access is the
team-management "Member content access" rule: the owner or an admin of the show's team, or a
member holding a grant for the show) SHALL be consolidated behind `requireSession` and its
show-level sibling rather than re-deriving the login decision; no session-scoped route SHALL
check access any other way. The login-required check SHALL NOT be duplicated between
middleware and per-route helpers. Route helpers MAY assert that a principal is present; a
missing principal behind the middleware is an internal error (500), not a second login
decision. The consolidation SHALL preserve these exact behaviors,
each locked by a scenario below. (Replacing the `apiRequestRequiresLogin` URL-prefix matcher
with an explicit per-route policy is **deferred** — see the archived change's design D6 —
so its default-deny requirements are out of scope for this capability.)

#### Scenario: Login check is not duplicated
- **WHEN** a session-scoped route is exercised
- **THEN** the unauthenticated-401 decision is made exactly once, in the middleware, and `requireSession` performs only resolve + authorize (at most asserting that a principal is present, which is never a `401`)

#### Scenario: API_TOKEN machine clients bypass studio membership
- **WHEN** a request authenticated by `API_TOKEN` (no user) on a path under `/api/companion/` resolves a session in any studio
- **THEN** it is allowed after an existence check, with no membership scoping applied — the Companion machine path is unchanged

#### Scenario: API_TOKEN is not an identity outside the Companion surface
- **WHEN** a request bearing only a valid `API_TOKEN` accesses a session-scoped route outside `/api/companion/`
- **THEN** it is rejected by the single middleware login decision with `401`, and `requireSession` is never reached

#### Scenario: Percent-encoded API prefix is gated like the literal one
- **WHEN** `GET /%61pi/sessions` or `GET /%61pi/companion/state` is sent with no session cookie and no `API_TOKEN`
- **THEN** the response is `401` `{"detail": "Login required."}`, exactly as for `/api/sessions` and `/api/companion/state`, and no handler runs

#### Scenario: Cross-studio access is masked as 404, not 403
- **WHEN** an authenticated user who is not a member of a session's studio requests that session
- **THEN** the response is `404` "Session not found" (not `403`), identical before and after

#### Scenario: Admin token distinguishes unset from wrong
- **WHEN** an `/api/admin/*` route is called with `ADMIN_TOKEN` unset versus with an invalid token
- **THEN** it returns `503` (unset) versus `401` (invalid) respectively, and a session cookie alone grants no admin access

#### Scenario: A member without a grant is masked as 404, not 403
- **WHEN** an authenticated member of a session's studio who holds no grant for the session's show
  requests that session through any session-scoped route
- **THEN** the response is `404` "Session not found" (not `403`), identical to the cross-studio
  response

#### Scenario: Every session-scoped route goes through the one gate
- **WHEN** the registered route table is enumerated
- **THEN** every route whose path names a session id, and the show-scoped log import, denies a
  member without a grant with the masked `404` before reading its body, and a route added later
  without the gate fails that check

### Requirement: Untested seams gain characterization tests before reshaping

The **`api-contract-freeze`** capability is the single normative definition of the frozen
HTTP/WS surface (the README endpoint table is the normative route inventory; `AUTH-API.md`
is descriptive documentation, not the freeze anchor). This capability adds the refactoring
discipline that protects it: when a unit lacking covering tests is about to be reshaped,
a **characterization test** capturing its current observable output (status codes, JSON
shapes, broadcast emission) SHALL exist and pass before the reshape lands. "Existing
suites pass" alone SHALL NOT be treated as sufficient parity evidence for an untested
seam.

#### Scenario: Reshaped-but-untested seams are pinned first
- **WHEN** a seam without covering tests is about to be reshaped
- **THEN** a characterization test capturing its current observable output exists and passes before the reshape lands

#### Scenario: Existing suites pass unchanged
- **WHEN** the server unit and integration test suites run against the refactored core
- **THEN** they pass without changes to expected responses, and the `503` null-adapter routes still return their clean `503`

### Requirement: Port types are interfaces in a dedicated package with app-level composition

The injectable port types (`Clock`, `IdentityVerifier`, `BlobStore`, `KvStore`,
`PresenceRegistry`, `CatalogDb`, and `CatalogRoot`, the unbound catalog adapter that hands out
bound `CatalogDb` handles) and the `Config` type SHALL live in
`@autologger/ports` as **interfaces/types only** — the package SHALL contain no runtime
implementations (`systemClock` lives with the composition root) and SHALL NOT import
from `server/src`, directly or transitively. Concrete implementations SHALL declare
conformance (`implements`) against the package interfaces from their own homes.

The app-env composition (`Ports`, `Variables`, and `AppEnv`) SHALL live in a single
app-level module (`server/src/appEnv.ts`) that composes the packages' types. The former
allowance for that module to name the concrete `SessionHubRegistry` and `Catalog`
classes is **retired**: `appEnv.ts` SHALL name no concrete persistence class —
`Ports.sessions` SHALL be typed as the session-core package's registry facade interface
and `Variables.catalog` as the catalog package's facade interface (the server-wide
concrete-naming and construction rules live in the "Persistence facades are consumed
through package-exported interfaces" requirement). The former `server/src/types.ts`
barrel SHALL remain removed with no permanent re-export shim. The per-request in-place
`env`-mutation identity contract (`@hono/node-ws` upgrade handshake) SHALL be
preserved.

#### Scenario: Ports package is interface-only and closed
- **WHEN** `@autologger/ports` is inspected
- **THEN** it contains no runtime implementations and no import that resolves into `server/src`, and each of the seven port types is an interface or type declaration

#### Scenario: God-barrel stays retired and the concrete-class allowance is gone
- **WHEN** the server source is searched for imports of `server/src/types` and `appEnv.ts` is inspected
- **THEN** no `types.ts` import remains, `server/src/types.ts` does not exist, and `appEnv.ts` names no concrete class — its persistence types are the facade interfaces exported by `@autologger/session-core` and `@autologger/catalog`

#### Scenario: Implementations conform to the package interfaces
- **WHEN** the concrete `BlobStore`, `KvStore`, `PresenceRegistry`, `CatalogRoot` and bound `CatalogDb` classes are inspected
- **THEN** each declares `implements` against its `@autologger/ports` interface, and `auth/identity.ts` imports the `KvStore` interface from the package (not from `node/`)

#### Scenario: WebSocket upgrades still complete after the type move
- **WHEN** a real WebSocket upgrade is driven end-to-end after the change
- **THEN** the upgrade completes and messages are delivered, confirming the env-identity contract survived

### Requirement: Persistence facades are consumed through package-exported interfaces

`@autologger/session-core` SHALL export explicit facade interfaces for the session hub
RPC surface and the hub registry, and `@autologger/catalog` SHALL export a facade
interface for `Catalog` and interfaces for its five stores (`shows`, `studios`, `auth`,
`sessions`, `profile`). Facade membership is determined by consumption, not
convenience: a public member is on a facade **iff** it is reached through
`Ports.sessions` / `Variables.catalog` by at least one consumer outside the package
(production call sites, plus the established integration-test paths — e.g. `evictIdle`
via `env.ports.sessions`). The registry facade surface is exactly `get(sessionId)`
(returning a promise that resolves to the opened hub facade), `evictIdle`, and `startSweeper`,
plus the synchronous `closeUserSockets`; the hub facade's storage members return promises and
its socket members stay synchronous; coordination internals
(`lastTouchedMs`, `close`, `hasArmedAlarm`, `socketCount` on the hub; `closeAll` and
the hub map/sweeper internals on the registry) SHALL stay off the facades. Facade
interface members SHALL be authored as **property-style function types**
(`m: (args) => R`), not method syntax, so `strictFunctionTypes` checks parameters
contravariantly and drift between class and interface fails `tsc --noEmit`.

Concrete classes SHALL declare `implements` against their facade interfaces. Because
`Catalog` is constructed **per request** (in `middleware/auth.ts`, with `init()`
refreshing the studio registry once per request before registry reads),
`@autologger/catalog` SHALL export a factory (`createCatalog(root: CatalogRoot)` returning
the facade type, unbound until `forUser` or `system` binds it) as the sanctioned construction
path outside the composition root; the per-request construct-then-`init()` lifecycle SHALL be
preserved, with `init()` run on the request's system-bound catalog before the caller is resolved. Outside the
persistence packages themselves, production code SHALL otherwise reference the facade
interfaces only: the composition root (`server/src/node/config.ts`) is the sole production
module that names the concrete classes.

**The enforcing check's walked root SHALL follow the code it governs.** Scoping the walk to
`server/src` alone means that relocating a consumer into a service package **discharges its
obligation by the act of moving** — silently, with no gate objecting and no requirement left
to violate. The walk SHALL therefore cover the service packages' production sources as well as
`server/src`, so a package that consumes persistence is held to the same interface-only rule
it was held to before it became a package. A change that moves a persistence consumer into a
package SHALL widen the walk in the same unit rather than assert the property in a scenario
with no mechanism behind it.

The repo-invariant check that enforces the interface-only rule SHALL defeat the three
bypass classes named here. It SHALL match the package by **specifier prefix**, so a
deep-subpath import that resolves through the packages' `"./*"` export map (e.g.
`@autologger/session-core/SessionHub`) is caught exactly as the bare specifier is. It
SHALL scan **`export … from` re-export clauses as well as `import` clauses**, so a module
cannot launder a concrete identifier by re-exporting it. And it SHALL reject **wildcard
clauses** against those packages outright — `import * as sc from '@autologger/session-core'`
(followed by `sc.SessionHub`) and `export * from '@autologger/session-core'` name no
identifier in the clause at all, so an identifier-matching scan cannot see them, and the
packages' barrels re-export the concrete classes as values; a namespace or star import of
a concrete-bearing persistence package has no legitimate use in consuming production code.

The check is a **textual scan, and its limits SHALL be stated rather than papered over**:
it does not see dynamic `import()` of these packages, `createRequire` loads, laundering
through `server/src/test/**` or through a third package that re-exports, or production
code outside the walked roots. These SHALL be recorded as known residual
bypasses, not implied to be covered. Claiming shape-independent detection that a regex
scan cannot deliver would itself be the failure mode this requirement guards against —
a baseline that the next change inherits as false ground truth.

Because this check is itself being reshaped, and because an assertion that passes on a
clean tree passes equally when the check has become vacuous, it SHALL carry
**synthetic-tree mutation coverage** proving it fires on each rejected shape and does not
fire on compliant code.

#### Scenario: Routers and middleware see interfaces only
- **WHEN** production modules under `server/src/` other than the composition root are searched for imports of the concrete persistence classes (`SessionHub`, `SessionHubRegistry`, `Catalog`, and the five catalog store classes) as values or types
- **THEN** none remain — they import the package-exported facade interfaces (and `middleware/auth.ts` the `createCatalog` factory), and only `server/src/node/config.ts` names the concrete classes

#### Scenario: Interface-only consumption is continuously enforced
- **WHEN** a production file under `server/src/` other than `node/config.ts` imports one of the concrete persistence class identifiers from `@autologger/session-core` or `@autologger/catalog` (tests exempt) and the boundary repo test runs
- **THEN** the test fails — the retirement is enforced by the repo-invariant test, not by one-time inspection

#### Scenario: A service package consuming persistence is held to the same rule
- **WHEN** a production file in a service package imports one of the concrete persistence class identifiers, by bare specifier, deep subpath, re-export clause, or wildcard clause, and the boundary repo test runs
- **THEN** the test fails exactly as it would for a file under `server/src/`, and the walked-root widening is demonstrated by confirming the check reports the violation from the package location — proving the rule was not discharged by the relocation

#### Scenario: Deep-subpath imports do not bypass the enforcement
- **WHEN** a production file under `server/src/` other than `node/config.ts` imports a concrete persistence identifier through a package subpath specifier (e.g. `@autologger/session-core/SessionHub`) rather than the package's bare specifier, and the boundary repo test runs
- **THEN** the test fails, and this negative case is demonstrated once during implementation and recorded in the apply ledger

#### Scenario: Re-export clauses do not bypass the enforcement
- **WHEN** a production file under `server/src/` other than `node/config.ts` re-exports a concrete persistence identifier (`export { SessionHub } from '@autologger/session-core'`) rather than importing it, and the boundary repo test runs
- **THEN** the test fails, and this negative case is demonstrated once during implementation and recorded in the apply ledger

#### Scenario: Wildcard clauses do not bypass the enforcement
- **WHEN** a production file under `server/src/` other than `node/config.ts` uses a wildcard clause against one of those packages — `import * as sc from '@autologger/session-core'` (reaching the class as `sc.SessionHub`) or `export * from '@autologger/session-core'` — and the boundary repo test runs
- **THEN** the test fails on the clause itself, without needing to see the concrete identifier, because a namespace or star import of a concrete-bearing persistence package is a violation by construction

#### Scenario: The check is mutation-covered, not merely green
- **WHEN** the enforcing check is exercised against synthetic file trees rather than only against the live repository
- **THEN** it returns no violation for compliant code (including facade imports such as `SessionHubFacade` and `export type` clauses), and returns a violation for each rejected shape — bare, deep-subpath, `export … from`, and wildcard — so a refactor that renders the check vacuous fails instead of passing silently; no permanent violation fixture is added to the real tree

#### Scenario: Per-request catalog lifecycle preserved
- **WHEN** requests are served after the factory change
- **THEN** each request constructs a fresh catalog facade via `createCatalog` and runs `init()` before registry reads, and the user-bound (or unbound) catalog the routes receive carries that snapshot — request-scoped studio-registry snapshot isolation is unchanged

#### Scenario: Facade conformance is compiler-checked
- **WHEN** a concrete class member drifts from its facade signature — including a **narrowed parameter type** on a facade member
- **THEN** `tsc --noEmit` fails: the facades' property-style function-type members are checked contravariantly under `strictFunctionTypes` (method-syntax bivariance is the reason method syntax is not used)

#### Scenario: Narrowing excludes coordination internals
- **WHEN** the hub and registry facade interfaces are inspected, and a `Ports.sessions`-typed expression references an excluded member
- **THEN** the hub facade excludes at minimum `lastTouchedMs`, `close`, `hasArmedAlarm`, and `socketCount`, the registry facade excludes `closeAll` and internals, and the excluded-member reference fails `tsc --noEmit`

#### Scenario: No passthrough on the facades
- **WHEN** the facade interfaces' member declarations are inspected
- **THEN** no member's declared parameter or return type names a concrete persistence class, a store class, the registry, or `better-sqlite3`'s `Database` — the facades cannot hand out concrete handles

#### Scenario: Behavior reachable through the app is unchanged
- **WHEN** the full server test suite and the frozen-surface conformance fixtures run after the interface narrowing and factory introduction
- **THEN** they pass unchanged — no HTTP/WS-observable behavior differs

### Requirement: Pure domain modules live in the domain package

`studio.ts`, `timecode.ts`, and the shared row types formerly in `db/shared.ts` SHALL
live in `@autologger/domain`, and `schemas.ts` plus the dashboard catalog SHALL live in
`@autologger/contract`, with all former `server/src` import paths rewritten to the
packages and no permanent re-export shims left behind.

#### Scenario: Old paths are gone
- **WHEN** the server source is searched for imports of `../studio`, `../timecode`, `../schemas`, `./aiV2/catalog`, `../clock`, or `db/shared` relative paths
- **THEN** none remain; consumers import `@autologger/domain`, `@autologger/contract`, and `@autologger/ports`

### Requirement: Host-environment discovery belongs to the composition root

A service package SHALL **receive** its deployment configuration rather than discover it from
the host environment. Translating a host environment into configuration values — probing
`PATH` for an executable, or resolving a path under the operating user's home directory —
is the composition root's defining job, SHALL be performed in the composition root's binding
construction, and the resolved value SHALL be carried on `Config` and passed to the service.
The composition root decides *where*; the service decides *what to do with it*.

Accordingly, the AI runtime's design-turn credential seeding SHALL receive the credential
source path as a parameter rather than computing it from the operating user's home directory.
That path SHALL be a **required** `Config` field and SHALL have **no environment override**.
Both constraints are load-bearing rather than stylistic: an override would turn the field into
an arbitrary-file-read primitive, since the value names a file copied into a subprocess's
configuration directory; and an optional field invites a defensive early return that silently
disables the login-credential fallback, degrading a working design turn into a scrubbed
authentication error with nothing to notice it.

This requirement is **declaration of intent for new and relocated code, not a sweep**, and
the reads it does not close SHALL be named here rather than left to be rediscovered as
violations. Two residual classes stand, covering three reads:

- **Child-process environment builders** that accept an injected process-environment map and
  fall back to the ambient one — `@autologger/ai-runtime`'s AI-chat and Agent-SDK spawn paths,
  and `@autologger/media-import`'s yt-dlp path. The fallback survives because the whitelist
  these builders compute is derived from the **raw host environment**: closing it means either
  plumbing that raw map from the composition root through the app — relocating the read rather
  than removing it — or moving whitelist computation from per-turn to boot, which changes when
  the environment is sampled. Neither buys the property this requirement is about.
- **Scratch-directory allocation** derived from the platform temporary directory, in
  `@autologger/ai-runtime`'s AI-chat working-directory root and its design-turn working and
  configuration directories. The platform temporary directory is environment-derived, so it
  falls inside this requirement's forbidden class as stated; it is nonetheless a residual
  rather than a violation to close, because what is being located is **ephemeral scratch space
  the service itself creates and deletes**, not a fact about where the deployment keeps its
  data. Naming it is required precisely because the distinction is arguable.

A change that adds or relocates a host-environment read into a service package SHALL either
close it or add it to this list.

#### Scenario: The credential source path arrives as a required parameter

- **WHEN** the production sources of `@autologger/ai-runtime` are inspected for reads of the operating user's home directory
- **THEN** none remains; the credential-seeding function takes the source path as a parameter, the composition root resolves it into a required `Config` field with no environment override, and the router passes it at the single call site

#### Scenario: A login-fallback design turn still finds operator credentials

- **WHEN** a design turn runs through the real app with no workspace API key configured, on a loopback bind, with an operator credential file present at the composition-root-resolved path
- **THEN** the credential file is copied into the turn's isolated configuration directory exactly as before, and a turn with a configured key still copies nothing — characterized through the router before the seam is reshaped, because this path has no test coverage today and an optional-field regression would be silent

#### Scenario: Named residuals are legible from the baseline

- **WHEN** a change leaves a host-environment read inside a service package
- **THEN** its delta names the read and the property that prevents closing it, and the read appears in this requirement's residual list — so a later reader can distinguish an examined residual from an overlooked violation without consulting a design document

### Requirement: AI tool bodies consume the session facade directly; no tool port is interposed

The AI runtime's MCP tool bodies SHALL obtain session data through
`@autologger/session-core`'s exported `SessionHubRegistryFacade`, resolving the hub **at call
time**, inside the tool body, and never from a reference captured when the turn was registered.
Within one tool invocation the body MAY use the hub it resolved across that hub's own awaited
operations; it SHALL NOT keep the reference beyond the invocation. No intermediate "session tool
port" SHALL be interposed between the tool bodies and that facade.

This is a decision, not an omission. An earlier change deferred such a port so its surface
could be cut against a real consumer rather than speculatively, and named the change that
packages the AI runtime as its owner. That consumer was removed as superseded before this
change ran, and none replaced it; the reason to defer is therefore stronger, not weaker. A
service package importing an L1 persistence facade is an ordinary allowed edge, so extraction
never required the port. The deferral is recorded **here**, in the durable baseline, because
its previous home was a design document that does not survive archive — leaving a promise
whose named owner had come and gone.

Should a future change interpose such a port, the binding study recorded in the
`package-split-foundation` change's design SHALL be **re-derived against the code as it then
stands** rather than adopted as written. Freezing a study's conclusions as durable law for a
seam nobody has built is how a baseline goes stale silently; the study's value is its
reasoning, not its conclusions.

The facade-consumption half of this requirement is enforced by the interface-only-consumption
check, whose walked root covers the service packages. The call-time-resolution half is **not
machine-checked** and is verified by review.

#### Scenario: Tool bodies resolve the hub at call time through the facade

- **WHEN** the AI runtime's MCP tool bodies are inspected
- **THEN** each obtains its hub by awaiting the injected registry facade's getter inside the tool body, uses that reference only for the invocation's own hub operations, and none keeps a hub reference from the turn's registration or from an earlier invocation

#### Scenario: The deferral is legible from the baseline alone

- **WHEN** a reader inspects the durable baseline for whether a session tool port exists
- **THEN** the absence is stated as a decision with its reason and its re-derivation requirement, rather than being inferable only from the absence of a requirement

### Requirement: Key/value and presence ports are asynchronous

The `KvStore` and `PresenceRegistry` port operations SHALL return promises, so a networked
backend can replace the embedded one without changing call sites. Every caller SHALL await them,
including the adapters' own internal calls.

The `KvStore` port SHALL offer `take(key)`, which removes and returns a live entry in one atomic
step and returns nothing for a missing or expired one. A one-shot credential, such as the OAuth
CSRF state, SHALL be consumed with `take`, so of several concurrent consumers exactly one succeeds.

The startup purge of expired key/value entries SHALL be attempted before the server accepts
connections. A failed purge SHALL be logged and SHALL NOT prevent boot, because reads still
treat expired entries as absent.

#### Scenario: Startup purge precedes listening
- **WHEN** the server boots
- **THEN** expired key/value entries are purged, and the purge completes before the server begins listening

#### Scenario: A failed purge does not block boot
- **WHEN** the startup purge fails
- **THEN** a warning is logged and the server still starts, and an expired entry still reads as absent

#### Scenario: Expired entries read as absent
- **WHEN** a key/value entry's expiry has passed and it is read
- **THEN** the read returns no value and the entry is removed

#### Scenario: Concurrent takes of one entry
- **WHEN** two callers take the same live key/value entry concurrently
- **THEN** exactly one receives its value, the other receives nothing, and the entry is gone

#### Scenario: A replayed OAuth state is refused under concurrency
- **WHEN** two OAuth callbacks carrying the same valid state arrive concurrently
- **THEN** at most one proceeds to sign-in and the other is redirected with `login_error=state_invalid`

### Requirement: Server code never drops or misuses a promise

Production code under `server/src`, `packages/catalog/src`, `packages/session-core/src`, and the
hub-calling packages `packages/log-import/src`, `packages/transcription/src` and
`packages/ai-runtime/src` SHALL NOT leave a promise unconsumed. Every promise-returning
call SHALL be awaited, returned, or explicitly discarded with `void`.

No code SHALL:
- use a promise as a condition, negate it, or compare it with `===`, `!==`, `==` or `!=`;
- serialise it into a response, whether as the body itself or as a field, shorthand field
  included;
- pass a promise-returning function where the parameter expects a function that returns no
  value. Such a callback's work would silently escape the caller's control, for example a write
  running after the transaction it was meant to be inside.
- return a promise without `await` from inside a `try` block that has a `catch` or `finally`.
  The `finally` (or the catch's protection) would run before the promise settles, for example
  releasing a lock before the write it guards has committed.

A server or session-core test SHALL NOT pass a promise to an assertion except through
`.resolves` or `.rejects`, so a missed `await` cannot make an assertion pass vacuously.

A documented await-free window (a section of a request handler that relies on no other request
interleaving) SHALL contain no storage call. Data the window needs from storage SHALL be read
before it opens.

#### Scenario: A dropped or misused promise fails the build
- **WHEN** production code in any of the scanned roots drops a promise-returning call, including one made through a port interface, the session hub facade or a local alias, or uses a promise as a condition, a comparison operand or a response value
- **THEN** a repository test fails and names the file and line

#### Scenario: An async callback where no value is expected fails the build
- **WHEN** production code in any of the scanned roots passes an async function to a parameter typed as a function returning no value, such as a mutation run inside a catalog transaction
- **THEN** a repository test fails and names the file and line

#### Scenario: Event-generation word snapshot stays await-free
- **WHEN** `POST /api/sessions/{id}/events/generate` takes its transcript word snapshot
- **THEN** once the snapshot read has resolved, no storage call or other `await` occurs before the per-session AI slot is acquired, and the show's categories were read before the snapshot

#### Scenario: Companion command is stored before it is broadcast
- **WHEN** `POST /api/companion/command` is accepted
- **THEN** the command is recorded as the last command before it is broadcast to the session's sockets, so an acknowledgement can always find it

#### Scenario: In-flight transcript redaction checks the named holder
- **WHEN** transcript generation is refused with `409` because another session holds the generation lock
- **THEN** the requester sees the holder's identifiers only if they may view the session those identifiers name, even if the lock changed hands while the refusal was built

#### Scenario: Responses are unchanged
- **WHEN** the existing route and WebSocket test suites run after this change
- **THEN** they pass with no change to expected status codes, bodies, headers or frames

#### Scenario: A test asserting on an unawaited promise fails the build
- **WHEN** a server or session-core test passes a promise-typed value to `expect()` without `.resolves` or `.rejects`
- **THEN** a repository test fails and names the file and line

#### Scenario: Every scanned root is actually scanned
- **WHEN** the promise-hygiene repository test runs
- **THEN** it fails unless its scanned files include the session hub, the session core, the log-import runner, the transcript generator and the AI runtime's MCP server

#### Scenario: A promise returned from inside try without await fails the build
- **WHEN** production code in any of the scanned roots writes `return somePromise` inside a `try` block that has a `catch` or `finally`
- **THEN** a repository test fails and names the file and line, and `return await somePromise` passes

### Requirement: The catalog transaction contract

The asynchronous catalog port SHALL expose promise-returning `all()`, `first()` and `run()`, and
a `tx()` that passes its body a handle scoped to that transaction, with the same interface. A
`tx()` called on that handle SHALL join the enclosing transaction.

A transaction SHALL be all-or-nothing. Any error inside it SHALL fail the whole transaction, even
if the body catches it: a statement error, a joined body's error, or the body's own error. A
failed transaction SHALL roll back and reject with the first error, which no later error,
rollback error or misuse error replaces.

Misuse SHALL reject the caller's promise instead of deadlocking, escaping the transaction or
leaking writes:
- the root handle used while the caller's transaction is open;
- a handle used after its transaction ended;
- a body that returns while a joined body is still running.

#### Scenario: A failed transaction leaves no writes
- **WHEN** a transaction body writes and then throws
- **THEN** none of its writes persist and the caller receives the body's error

#### Scenario: A caught statement error still fails the transaction
- **WHEN** a transaction body catches a failed statement and goes on writing
- **THEN** the transaction rolls back, none of its writes persist, and the caller receives the statement's error

#### Scenario: A joined transaction shares the outcome
- **WHEN** a body calls `tx()` on its handle and the joined body throws
- **THEN** the whole transaction rolls back, including writes made before the joined call

#### Scenario: Using the root handle inside a transaction is refused
- **WHEN** a transaction body issues a statement or transaction on the root handle
- **THEN** that call rejects with an error naming the transaction handle, promptly and without a deadlock

#### Scenario: A domain error survives a still-running joined body
- **WHEN** one of two parallel joined bodies throws while the other is still running
- **THEN** the transaction rolls back and the caller receives the thrown error, not a misuse error

#### Scenario: A handle outlives its transaction
- **WHEN** a transaction handle is used after its transaction has ended
- **THEN** the call rejects, and nothing is written

#### Scenario: A body returns before its joined work
- **WHEN** a body returns while a `tx()` it started on its handle is still running
- **THEN** the transaction rolls back, the caller's promise rejects, and the unfinished body's later writes are refused

### Requirement: The Postgres catalog adapter

A Postgres implementation of the catalog port SHALL meet "The catalog transaction contract",
proven by the catalog transaction contract test suite. That suite SHALL include a
statement the body starts without awaiting: if it fails, the transaction fails.

Bindings (ADR 0021 slice 6b-1):
- the adapter itself SHALL offer no statement or transaction method; it SHALL hand out handles
  bound to a user (`catalog_user`, with that user's id) or to a named system task
  (`catalog_system`, with no user id), which share its connections;
- binding to an empty or non-string user id, or to a reason that is not a short lowercase
  identifier (`[a-z][a-z0-9-]*`), SHALL throw at once;
- every transaction of a bound handle SHALL, right after it begins and before the body's first
  statement, switch to the handle's role and set its user id (or clear it) for that transaction
  only, and SHALL do so again on every run after a retry;
- the role and user id SHALL be sent pipelined with the transaction's begin, without waiting for
  the begin's reply, so a binding adds no round trip;
- the adapter SHALL NOT change the role or the user id for longer than one transaction, and a
  connection SHALL serve another call only after its transaction was confirmed committed or
  rolled back, so no role or user id carries over to the next caller;
- a permission error from the database (`42501`) SHALL reach the caller as a distinct forbidden
  error that names the table and the binding's kind and reason (never the user id), is never
  retried, and fails a transaction it occurs in.

Statements:
- it SHALL accept the `?` placeholders the catalog stores use, and leave quoted text and comments
  unchanged;
- it SHALL return 64-bit integer values as numbers;
- `run()` SHALL return the affected-row count;
- a statement with a text parameter containing U+0000 (NUL) SHALL be refused with a distinct
  invalid-text error before it is sent; inside a transaction, that refusal fails the transaction.

Transactions:
- every transaction started with `tx()` SHALL run at the `SERIALIZABLE` isolation level (a
  statement outside one runs as a short `READ COMMITTED` transaction, core-ports-architecture
  "Root catalog statements are time-bounded");
- a transaction that fails on a serialization failure or a deadlock SHALL roll back and run its
  body again, at most five runs in total. The caller SHALL then receive the last serialization
  error;
- before running the body again after its `n`th run, the adapter SHALL wait a random delay of at
  least 0 and less than `20 × 2^(n−1)` milliseconds, holding no connection while it waits and
  never waiting past the transaction's deadline. If the deadline has passed when a run would
  start, the caller SHALL receive the timeout error, with no statement sent;
- no other failure SHALL be retried;
- because a body may run more than once, a transaction body SHALL have no effect outside the
  catalog database;
- a transaction SHALL resolve only when the server confirms its commit;
- when a commit's reply never arrives, the caller SHALL receive a distinct "outcome unknown"
  error, and the adapter SHALL NOT retry or roll back after it.

Time:
- one deadline SHALL cover the whole transaction: waiting for a connection, every run, and the
  commit;
- when the deadline passes, any statement in flight SHALL be cancelled, the transaction SHALL end
  on the server, and the caller SHALL receive a timeout error;
- no step SHALL wait on the server without a bound.

Connections:
- transactions and root statements SHALL each run on adapter-owned single-connection clients
  (the transaction connections and the root connections), never on a connection lent out by a
  shared pool;
- a connection SHALL serve another transaction only after its previous transaction was confirmed
  committed or rolled back, with no cancel pending;
- any other connection SHALL be closed and replaced;
- after a transaction's connection is lost, no statement of that transaction SHALL be sent
  anywhere, and the process SHALL keep running.

Sharing:
- in the server, the catalog stores and the key/value store SHALL share one instance of this
  adapter, and a key/value call SHALL never join a catalog transaction.

Closing:
- the adapter SHALL have an asynchronous `close()`;
- after `close()`, waiting and new calls SHALL reject, no connection SHALL be opened, and
  `close()` SHALL resolve once the adapter's connections have closed.

#### Scenario: The shared contract holds on Postgres
- **WHEN** the catalog transaction contract suite runs against a user-bound and against a system-bound handle of the Postgres adapter, logged in as the app's least-privilege role
- **THEN** every case passes

#### Scenario: A dropped failing statement fails the transaction
- **WHEN** a transaction body starts a write that violates a unique key without awaiting it, and returns
- **THEN** the caller receives the unique-violation error, and no write persists

#### Scenario: Concurrent read-modify-write transactions both commit
- **WHEN** two transactions read the same row, both wait until each has read it, and then each increments it
- **THEN** both calls resolve, the row has been incremented twice, and the bodies ran three times in total

#### Scenario: Retries are bounded and selective
- **WHEN** a body hits a serialization failure on every run, or a deadlock on its first run only, or a unique violation
- **THEN** its body runs exactly five times and the caller receives the serialization failure; or runs twice and commits; or runs once and the caller receives the unique violation

#### Scenario: Contending writers back off and all commit
- **WHEN** eight transactions concurrently read and then increment the same row
- **THEN** all eight commit and the row has been incremented eight times

#### Scenario: A backoff that reaches the deadline times out without another run
- **WHEN** a transaction's backoff wait ends at or after its deadline
- **THEN** the caller receives the timeout error, no statement of a new run is sent, and no connection is taken or opened for it

#### Scenario: A stalled statement is cancelled at the deadline
- **WHEN** a transaction's statement is still running at the deadline
- **THEN** the caller receives a timeout error promptly, the server session running it ends within seconds, none of the transaction's writes persist, and the next transaction commits

#### Scenario: A queued transaction times out cleanly
- **WHEN** every transaction connection is busy and a waiting transaction reaches its deadline
- **THEN** it receives a timeout error, and once the busy transactions end, as many new transactions as there are connections all commit

#### Scenario: A lost connection leaks nothing
- **WHEN** a transaction's server connection is terminated while its body is awaiting, and the body then issues another write
- **THEN** that write is refused without being sent, the transaction rejects, no write of the transaction persists, the process keeps running, and later transactions, more than the adapter's concurrent-transaction limit, all commit

#### Scenario: A commit with no reply is reported as unknown
- **WHEN** the connection is lost, or the time bound passes, after the commit was sent and before its reply
- **THEN** the caller receives the outcome-unknown error, no rollback or retry is attempted, and that connection is replaced

#### Scenario: An unconfirmed rollback retires the connection
- **WHEN** a rollback on a transaction's connection fails
- **THEN** that connection is closed and replaced, and the next transaction runs on the replacement

#### Scenario: Closing with work in flight
- **WHEN** `close()` is called while one transaction runs and another waits for a connection
- **THEN** the running one settles, the waiting one rejects, and no connection of the adapter remains on the server once `close()` resolves

#### Scenario: Placeholders and integers
- **WHEN** a statement contains a `?` inside a quoted string and one outside it, and selects a row count
- **THEN** only the outer `?` is bound, and the count is a number

#### Scenario: NUL text is refused before it is sent
- **WHEN** a statement binds a string containing NUL, at the root or inside a transaction
- **THEN** the call rejects with the invalid-text error, no statement is sent for it, and a transaction it was part of writes nothing

#### Scenario: A bound handle runs as its role
- **WHEN** a handle bound to user `u-1` and a handle bound to the system task `test` each select
  `current_user` and `catalog.app_user_id()`, once outside a transaction and once inside one
- **THEN** the user handle reads `catalog_user` and `u-1` both times, and the system handle reads
  `catalog_system` and null both times

#### Scenario: A retry re-applies the role
- **WHEN** a user-bound transaction hits a serialization failure on its first run and commits on
  its second
- **THEN** the second run also reads `catalog_user` and the user's id

#### Scenario: No role carries over to the next caller
- **WHEN** user-bound and system-bound transactions and statements commit, roll back and fail on
  the adapter's connections, and then each connection is inspected directly
- **THEN** every connection reports `current_user` `autologger_app` and no user id

#### Scenario: A permission error is a distinct error
- **WHEN** a bound statement is refused by the database with `42501`
- **THEN** the caller receives the forbidden error naming the table and the binding's kind and
  reason, not the user id, and a transaction it was part of rolls back without a retry

#### Scenario: A malformed binding is refused
- **WHEN** a handle is bound to an empty user id, or to the reason `Not A Reason`
- **THEN** the binding throws, and no connection is used

### Requirement: Key/value compare-and-set
The key/value port SHALL offer `replaceIf(key, expected, next)`. In one statement, it replaces the
value of an unexpired key only if the stored value equals `expected`, keeps its expiry, and reports
whether it replaced.

#### Scenario: A newer value wins
- **WHEN** a value is read, another writer then stores a different value, and the reader calls `replaceIf` with what it read
- **THEN** `replaceIf` reports false and the other writer's value remains

### Requirement: Root catalog statements are time-bounded
A catalog statement outside a transaction SHALL run as its own short transaction at the
`READ COMMITTED` isolation level, on one of the adapter's root connections (single-connection
clients it owns, separate from the transaction connections): it begins, switches to the
handle's role and user id (core-ports-architecture "The Postgres catalog adapter", Bindings),
runs the one statement, and commits, or rolls back if the statement fails. The begin, the role
and user id, the statement and the commit SHALL be sent pipelined, without waiting for a reply in
between. It SHALL NOT be retried, and it SHALL NOT be run at `SERIALIZABLE`.

It SHALL resolve only after the server confirms the commit. A commit that fails (a deferred
constraint, for example) SHALL reject the call with that error, and none of its write persists.

It SHALL reject with a timeout error when it hasn't completed within the adapter's root deadline
(5 seconds by default), including any time spent waiting for a root connection. Each root
connection SHALL carry one such transaction at a time.
- A statement that times out before its transaction was sent SHALL be withdrawn and SHALL never
  run.
- For one already sent, the adapter SHALL NOT send a cancel; the role's statement and
  idle-in-transaction timeouts end it on the server. Such a write may still apply after the
  caller's timeout, so its outcome is unknown, and the adapter SHALL NOT retry it.
- The timeout error SHALL expose when the statement's transaction has ended on the server (or its
  connection was closed), so a caller that orders its writes can wait for it.
- A root connection SHALL serve another call only after its transaction was confirmed committed
  or rolled back. When its connection is lost, or its commit's reply does not arrive within
  the adapter's bound (the root deadline, or for a call already timed out, the role's timeouts
  plus a grace), the call SHALL reject, nothing more SHALL be sent on that connection, the connection
  SHALL be closed and replaced, and the process SHALL keep running.

#### Scenario: A paused database
- **WHEN** a root statement is sent while the database does not answer
- **THEN** the caller receives the timeout error within about the root deadline, and later statements succeed once the database answers

#### Scenario: A root statement is one short transaction
- **WHEN** a bound handle runs one statement outside a transaction, once successfully and once
  with a statement that fails with a unique violation
- **THEN** each runs inside its own `READ COMMITTED` transaction under the handle's role, the
  first commits, the second rolls back and rejects with the unique violation after one run, and
  neither is retried

#### Scenario: A root statement resolves only after its commit
- **WHEN** a bound handle runs, outside a transaction, an insert whose deferred foreign key fails
  at commit
- **THEN** the call rejects with the foreign-key violation, and the row does not exist

#### Scenario: A lost root connection is replaced
- **WHEN** the server connection of a root statement's transaction is terminated while the
  statement runs, and another root statement follows
- **THEN** the first call rejects, the process keeps running, the connection is replaced, and the
  second call succeeds on a fresh connection outside any transaction

#### Scenario: A root commit with no confirmation never reaches another caller
- **WHEN** a root statement's commit fails, or its reply never arrives, and later root statements
  run
- **THEN** the first call rejects, its connection is closed and replaced, and no later statement
  runs inside its transaction or under its role

### Requirement: Policy outcomes keep each route's status
Row-level policies (catalog-database "User policies enforce the team permission model") SHALL
NOT change any status, body or message a route returns for a request that a serial order of
requests can produce. The app's gates decide first. Where a policy can hide a row or refuse a
write, the route SHALL answer as follows.

**Existence probes.** A route whose status distinguishes a missing entity from another team's
entity SHALL ask an existence check that sees every row, not a user-scoped read:
- `POST /api/shows` SHALL answer `404 Unknown studio id.` for a team that exists but in which the
  caller has no membership. It SHALL answer `400 Unknown studio id.` for a team that does not
  exist. That includes a team whose deletion commits while the create is in flight.
- `POST /api/sessions` SHALL answer `400 Show does not belong to the active team.` for a show
  that exists in a team other than the caller's active team, member or not. It SHALL answer
  `400 Unknown show_id.` for a show that does not exist.

**Writes refused in a race.** A write whose access is revoked after the route's early gate and
before the write SHALL be answered with the status the route already gives for missing access,
and SHALL leave the row unchanged:
- `PUT /api/sessions/:id`, `POST /api/sessions/:id/archive`, `POST …/restore` and
  `DELETE /api/sessions/:id` SHALL answer `404 Session not found` when the write changed no row.
- `PUT /api/profile` with team settings or show updates SHALL re-check the caller's role, with
  the membership row locked `FOR SHARE`, in the same transaction as those writes and before the
  first of them. A caller who is no longer `owner` or `admin` there SHALL get
  `403 Admin role required.` with nothing written, prefs and names included. Outcomes for
  requests no demotion races stay as before, including the `400` for a show entry outside the
  selected team after the earlier entries were saved.
- The ownership transfer SHALL answer `404 Member not found` when the target's user row cannot be
  read.

**Session hub calls refused in a race.** A session hub call made for a user whose access to the
session's show (a membership or a grant) is lost after the route's gate (`requireSession`) SHALL be
refused before it reads or writes any session content, with an error that names missing access,
distinct from the error for a session that does not exist, and whose message names neither the
session nor the user. The route SHALL answer it with the status it already gives for missing
access, SHALL send no broadcast for the refused call, and SHALL leave none of its own writes: a
write the same request made before the refusal SHALL be removed by the route's existing undo steps,
which run as the reviewed system task `session-undo` and remove only what that request wrote (or,
for an event regenerate, the snapshot it is replacing):
- every route under `/api/sessions/:id` SHALL answer `404 Session not found`, including a route
  whose other failures are wrapped into a different status (the YouTube import's `502`);
- with a session cookie, `GET /api/companion/state` SHALL answer `200` as when the caller cannot
  see the active session (`active_session_id: null`, `session: null`, `last_command: null` when it
  names that session, `connected_clients` unchanged), and `GET /api/companion/categories`,
  `POST /api/companion/log`, `POST /api/companion/transport` and `POST /api/companion/command` SHALL
  answer the `409` with the no-active-session detail and change nothing;
- work a request started and that outlives it SHALL report the refusal through its existing
  failure path: an AI tool call returns its tool error and creates nothing; a log-import sheet is
  reported failed, and the job's per-sheet access re-check stops it before the next sheet.

No new status, body or message SHALL be introduced for these refusals.

**A refusal after an in-transaction gate is a bug.** Where the route checked the caller's role or
access inside the same transaction, with the rows read `FOR SHARE`, a `42501` cannot come from a
concurrent change. These routes are:
- the team writes;
- `PUT /api/profile`'s settings and show writes;
- `POST /api/shows`;
- `POST /api/sessions`;
- the grant writes.

On any of them, a `42501` SHALL stay the generic `500` `{"detail": "Internal Server Error"}`, with
a log line naming `CatalogForbiddenError`, its table and its binding. Elsewhere, an unmapped
`42501` SHALL be answered the same way.

**Multi-statement writes run in an order the policies admit.** A store method that removes a
team SHALL delete the team's memberships last, after its invites, definition and settings. While
the caller is still a member, each of those deletes passes the member-team rules.

#### Scenario: A foreign team stays 404 on show create
- **WHEN** a signed-in user who is not a member of existing team U sends `POST /api/shows` with
  `studio_id` U
- **THEN** the response is `404` `{"detail": "Unknown studio id."}`, as before row-level policies

#### Scenario: A team deleted during show create stays 400
- **WHEN** a show create for team T has passed its existence read, and the deletion of T commits
  before the show is inserted
- **THEN** the create gets `400 Unknown studio id.`, and no show references T

#### Scenario: Another team's show on session create stays the team error
- **WHEN** a signed-in user sends `POST /api/sessions` for a show of a team they are not a member
  of, and separately for a show id that does not exist
- **THEN** the first gets `400 Show does not belong to the active team.` and the second
  `400 Unknown show_id.`

#### Scenario: A session update racing a revoke changes nothing
- **WHEN** a granted member's `PUT /api/sessions/:id` has passed `requireSession`, and the
  revocation of the member's grant commits before the update runs
- **THEN** the response is `404 Session not found` and the session row is unchanged

#### Scenario: A session content write racing a revoke changes nothing
- **WHEN** a granted member's `POST /api/sessions/:id/events`, a transport start, a transcript
  word edit and a dashboard save have each passed `requireSession`, and the revocation of the
  member's grant commits before the hub call runs
- **THEN** each response is `404 Session not found`, the session's events, transport, transcript,
  dashboards and live projection are unchanged, and no `*.changed` frame is sent

#### Scenario: A session content read racing a revoke is masked
- **WHEN** a granted member's `GET /api/sessions/:id/events` has passed `requireSession`, and the
  revocation of the member's grant commits before the hub read runs
- **THEN** the response is `404 Session not found`, not an empty list

#### Scenario: A Companion call with a cookie racing a revoke stays the no-active-session answer
- **WHEN** a granted member's `POST /api/companion/log` and `GET /api/companion/state` with a
  session cookie have passed their access check, and the revocation commits before the hub call
  runs
- **THEN** the log answers `409` with the no-active-session detail and no event is stored, and the
  state answers `200` with `active_session_id: null` and `session: null`

#### Scenario: An import refused in a race is undone and answers 404
- **WHEN** a granted member's local audio import and YouTube import have stored their segment and
  blob, and the revocation commits before their anchor runs
- **THEN** each response is `404 Session not found` (not `502`), and the segment and its blob are
  removed by the route's undo, run as `session-undo`

#### Scenario: Background writes after a revoke are refused
- **WHEN** user A's AI turn calls `create_event` after A's grant on the session's show is revoked,
  and A's log-import job reaches a session's hub write after the same revoke
- **THEN** the tool call returns a tool error whose text names neither the session nor the user
  and creates no event, and the job stores no event in that session and reports the sheet failed

#### Scenario: A settings save racing a demotion is refused
- **WHEN** an admin's `PUT /api/profile` with team settings and a show update has passed its
  early role check, and the admin's demotion to member commits before the request's transaction
- **THEN** the response is `403 Admin role required.`, and the stored settings, the show, the
  admin's prefs and names are unchanged

#### Scenario: A team delete removes every row under policies
- **WHEN** the owner of a team with no shows deletes it through `DELETE /api/teams/:id`
- **THEN** the response is `200`, and the team's invites, definition, settings and memberships
  are all gone

#### Scenario: A forbidden error after an in-transaction gate is a 500
- **WHEN** a statement in a team write's transaction is refused with `42501` after the caller's
  role was read `FOR SHARE`
- **THEN** the response is `500` `{"detail": "Internal Server Error"}`, and the log line names
  `CatalogForbiddenError`, the table and the binding `user`, but not the user id

### Requirement: Session runtime is an asynchronous, per-session serialized port on Postgres

The session spine SHALL depend on a `SessionRuntime` port exposing the session's id, its storage,
socket fan-out, an alarm/scheduler, and a clock — as an **interface**, so tests can supply a
runtime whose storage is wrapped (one that yields between statements or injects a failure)
without touching `SessionCore`. The port's normative home is `@autologger/session-core`
(alongside `SessionCore`), not `@autologger/ports` — it is the session package's internal
substitution seam, consumed by the package's stores and by test wrappers. Its storage is supplied
by the composition root (the Postgres session adapter, "The Postgres session adapter"); the
session package SHALL NOT open a database itself.

The storage seam SHALL be asynchronous and scoped to one session, and every call SHALL name its
session caller (core-ports-architecture "Every catalog and session call is bound to a caller"),
whose binding its statements run under:
- `tx(caller, fn)` runs a write transaction: the session's catalog row is locked under the
  caller's binding before `fn` runs, so writes to one session are serialized across every
  connection and process; a session with no catalog row SHALL reject with an error naming the
  missing session, and a session the caller has no access to SHALL reject with a distinct error
  naming missing access, both before `fn` runs;
- `snapshot(caller, fn)` runs a read: every statement in `fn` sees one committed state, and a
  write inside it fails; for a user caller without access to the session it SHALL reject with the
  missing-access error before `fn` runs, rather than read the session as empty;
- `fn` receives a handle with promise-returning `all(sql, ...binds)` (rows) and
  `run(sql, ...binds)` (`{ changes }`, the affected-row count), and `tx` on that handle joins the
  enclosing transaction or snapshot.

A transaction SHALL be all-or-nothing: any error inside it — a statement error, a joined body's
error, or the body's own error, even one the body catches — SHALL roll it back and reject with the
first error. A handle used after its transaction ended SHALL reject. A transaction body MAY run
more than once (a deadlock is retried), so it SHALL have only database effects: the broadcasts it
issues and the alarm it sets SHALL take effect once, for the run that committed.

Every statement the session spine sends SHALL be scoped to its session: a statement SHALL NOT
read, change or delete another session's rows.

The hub's storage operations SHALL return promises and SHALL be reached only through a view of
the hub bound to a session caller; views for different callers SHALL share the hub's one
serialization, broadcasts and alarm. Its socket operations (attach, detach, relay a command,
close a user's sockets) SHALL need no caller; relaying a command and closing a user's sockets
SHALL reach the sockets of every server process sharing the database (ADR 0021 slice 9a, "Session
frames reach every process in commit order"). Whatever the mechanism, the session hub
SHALL guarantee these observables:
- **No dirty or lost reads:** no read SHALL observe a write that is not yet committed or that
  later rolls back, and a read that runs several statements SHALL see one committed state.
- **Atomic mutations:** every mutating operation SHALL run in one transaction, and every
  read-then-write sequence whose outcome depends on what it read (an anchored insert, a recording
  ordinal and the segment that uses it, a take toggle, an event update that merges the stored
  metadata, a transcript replace remapped against the session's recording anchors, a
  duplicate-checked imported event, an imported take anchored only while the transport is not
  rolling) SHALL be one hub operation, so concurrent requests produce a
  result some serial order of them would produce — including requests served by different
  server processes.
- **Broadcast order:** a session's `*.changed` broadcasts SHALL be sent only after the
  transaction that issued them commits, in the order the session's transactions committed and,
  within one transaction, in the order issued; a transaction that fails SHALL send none of them.
  This order SHALL hold on every socket of the session in every server process sharing the
  database, whichever processes made the writes.
  A broadcast issued outside the session's transaction (a relayed Companion command) SHALL be sent
  at once and SHALL NOT be held or dropped by a transaction it does not belong to.
- **No self-deadlock:** a storage operation of any session's hub called from inside an open hub
  transaction SHALL reject promptly instead of waiting; a call on the same session's hub SHALL
  leave the open transaction usable, and a call on another session's hub SHALL fail the open
  transaction (production code never nests hub calls).
- **No stuck session:** a transaction that does not finish within its deadline SHALL end with a
  timeout error, and later operations on that session SHALL run.
- **No obscure failure on a closed hub:** an operation on a hub that has been closed SHALL reject
  with an error naming the closed hub, which the routes answer with their existing generic server
  error.

#### Scenario: Storage seam exposes transactions and snapshots, not a cursor API
- **WHEN** the session storage seam is inspected
- **THEN** it exposes promise-returning `tx(caller, fn)` and `snapshot(caller, fn)` whose handles offer `all(sql, ...binds)` returning rows, `run(sql, ...binds)` returning `{ changes }` and a joining `tx`, and it exposes neither a multi-statement DDL path nor the `exec() → { toArray(), rowsWritten }` cursor shape

#### Scenario: Writes from two processes equal a serial order
- **WHEN** two server processes toggle one session's take concurrently, many times
- **THEN** the transport ends as that many serial toggles leave it, with no toggle lost

#### Scenario: A multi-statement read sees one state
- **WHEN** an event list read (page, counts and revision) runs while another connection commits a new event between its statements
- **THEN** the page, the counts and the revision all describe the same committed state

#### Scenario: Sessions are isolated
- **WHEN** every mutating hub operation runs on session A while session B has rows in every session table
- **THEN** session B's rows are unchanged, and no read on session A returns a row of session B

#### Scenario: A write to an unknown session is refused
- **WHEN** a hub is opened, or a write runs, for a session id with no catalog row
- **THEN** it rejects with an error naming the missing session and stores nothing

#### Scenario: No access is told apart from no session
- **WHEN** a user caller without access to an existing session writes to it or reads it, and the
  same caller writes to a session id with no catalog row
- **THEN** the first two reject with the missing-access error and the third with the
  missing-session error; no body runs and nothing is stored

#### Scenario: Callers on one hub interleave under one serialization
- **WHEN** two user callers with access, and the lease alarm, call storage operations of one
  session's hub concurrently
- **THEN** the calls run one at a time in arrival order, each under its own binding, and the
  broadcasts follow commit order as for a single caller

#### Scenario: A retried transaction announces once
- **WHEN** a hub write's first run fails with a deadlock after issuing a broadcast and setting the alarm, and its second run commits
- **THEN** the caller receives one result, each broadcast of the committed run is sent once, none of the first run's is sent, and the alarm is armed once

#### Scenario: A take started before an import's anchor is not clobbered
- **WHEN** a take starts after a local or YouTube import's rolling check and before its imported take is anchored
- **THEN** the anchor writes nothing, the route answers its existing `409` rolling detail with the imported segment rolled back as that route's rolling refusal does, and the transport is still rolling with its take unchanged

#### Scenario: A hung transaction does not lock the session
- **WHEN** a hub transaction does not finish within its deadline
- **THEN** it rejects with a timeout error, the session's row is unlocked, and the next operation on the session completes

#### Scenario: Responses and frames are unchanged for serial requests
- **WHEN** the existing route, WebSocket and companion test suites run on the Postgres session storage
- **THEN** they pass with no change to expected status codes, bodies, headers or frames, apart from the failure paths the slice's contract deltas name, and apart from what the 7c-1 deltas add: the `version` field on event, transcript word and topic bodies, and revision values that advance once per session write (api-contract-freeze "Session content rows carry their version" and "The session revision advances once per session write")

#### Scenario: A read never sees an open or rolled-back write
- **WHEN** a read on a session is called while a write on that session is open, and the write then commits or rolls back
- **THEN** the read returns either the state before the write or its committed state, and never the write's uncommitted rows

#### Scenario: Broadcasts follow commit order
- **WHEN** two mutating operations on one session run concurrently and both commit
- **THEN** every broadcast of the transaction that committed first is sent before any broadcast of the other

#### Scenario: A failed write leaves no rows and no broadcasts
- **WHEN** a mutating operation's body awaits a statement and then throws, or catches a failed statement and goes on writing
- **THEN** none of its writes persist, none of its broadcasts are sent, and the caller receives the first error

#### Scenario: A nested transaction joins the outer one
- **WHEN** a hub transaction body runs a nested transaction on its transaction handle and the nested body fails
- **THEN** the whole transaction rolls back, including writes made before the nested call

#### Scenario: Calling the hub from inside its own transaction is refused
- **WHEN** a hub transaction body calls a storage operation of the same session's hub
- **THEN** that call rejects promptly, with no deadlock, and the body's own writes can still commit

#### Scenario: Calling another session's hub from inside a transaction is refused
- **WHEN** a hub transaction body calls a storage operation of another session's hub
- **THEN** that call rejects promptly with a misuse error, with no deadlock, and the open transaction rolls back

#### Scenario: A relayed command is not held by a transaction
- **WHEN** a Companion command is relayed over a session's socket while a transaction on that session is open, and the transaction then rolls back
- **THEN** the command frame is sent at once and is not withdrawn

#### Scenario: Concurrent take toggles equal a serial order
- **WHEN** two Companion transport toggles on one session run concurrently from a stopped transport
- **THEN** the transport ends stopped after exactly one start and one stop, as two serial toggles leave it

#### Scenario: Concurrent event edits keep both metadata merges serial
- **WHEN** two updates of one event run concurrently, each merging the stored metadata with its own category snapshot
- **THEN** the stored event equals the result of applying the two updates in some serial order

#### Scenario: Concurrent imports never share a recording ordinal
- **WHEN** two local audio imports into one session run concurrently
- **THEN** their segments, and their `Recording N` events, carry two different consecutive ordinals

#### Scenario: A transcript replace sees one set of recording anchors
- **WHEN** a transcript generation's replace runs concurrently with an imported take that adds recording anchors
- **THEN** the stored words are remapped against the anchors either before or after the take, never a mixture

#### Scenario: Concurrent log imports skip duplicates
- **WHEN** two sheet log imports of the same rows into one session run concurrently
- **THEN** each row is stored once, and the two imports' created counts sum to the number of distinct rows

#### Scenario: A closed hub rejects instead of failing obscurely
- **WHEN** an operation is called on a hub that has been closed
- **THEN** it rejects with an error naming the closed hub, and the route answers with its existing generic server error

#### Scenario: Lease expiry is ordered with the session's operations
- **WHEN** the recording lease alarm fires while an operation on that session is in flight
- **THEN** the expiry neither observes nor interrupts that operation's open transaction, and still frees a stale lease and announces `lease.changed`

#### Scenario: run() preserves change-detection for its readers
- **WHEN** `setAudioSegmentWaveform`, `deleteTopic`, or `deleteTranscriptWord` runs against a non-existent id
- **THEN** it observes zero affected rows and returns the "not found" result, so the routers still respond `404` and no `audio.changed` broadcast fires on a no-op write

### Requirement: The Postgres session adapter

A Postgres implementation of the session storage seam SHALL meet "Session runtime is an
asynchronous, per-session serialized port on Postgres", proven by a session storage contract test
suite that runs against the pinned Postgres image.

It SHALL run on the catalog adapter's own connections and machinery ("The Postgres catalog
adapter"): one adapter instance per server process serves the catalog stores, the key/value store
and the session hubs, with the same connection set, deadline, bindings, statement rules (`?`
placeholders, 64-bit integers as numbers, the affected-row count, NUL refused before sending),
connection-loss and unconfirmed-end rules and `close()`. Session transactions and snapshots SHALL
run on a separate, smaller set of the adapter's single-connection clients (the session
connections), with their own wait queue, so that session work never occupies a connection the
catalog's transactions or root statements need: heavy session traffic can slow only session calls.
The root, transaction and session connections, together with the frame bus's listener and
publisher connections, SHALL stay within a per-process budget of 14, so that three server
processes fit the app role's connection limit (catalog-database "The app connects as a
least-privilege role"). Each session transaction and snapshot SHALL run under the binding of the
caller the call names (core-ports-architecture "Every catalog and session call is bound to a
caller"), chosen per call: a user caller as `catalog_user` with the user's id, a system caller as
`catalog_system` with its reason.

Transactions:
- a session write transaction SHALL run at the `READ COMMITTED` isolation level and SHALL lock
  the session's `catalog.sessions` row (`FOR UPDATE`) before its body runs, the lock sent with the
  transaction's begin and binding so it adds no round trip;
- when the lock returns no row, the transaction SHALL roll back and reject, with no retry and
  without running its body: under a system binding with the missing-session error; under a user
  binding with the missing-access error when the session exists (asked through a definer
  function that sees every session, catalog-database "Policy helpers are reviewed definer
  functions") and with the missing-session error when it does not;
- a session write transaction that fails on a deadlock SHALL roll back and run its body again,
  with the catalog's backoff, at most five runs in total; no other failure SHALL be retried;
- a snapshot SHALL run as one `REPEATABLE READ READ ONLY` transaction and SHALL NOT be retried;
  under a user binding it SHALL first check, with a statement sent with its begin and binding,
  that the caller has access to the session, and SHALL reject as a refused lock does when not;
- one deadline SHALL cover a session transaction or snapshot as it covers a catalog transaction:
  the wait for a connection, the row-lock wait, every run and the commit.

Values:
- a `double precision` value SHALL read back exactly as it was written.

#### Scenario: The session contract holds on Postgres
- **WHEN** the session storage contract suite runs against the adapter on the pinned image
- **THEN** commit, rollback (including a caught statement error), joins, misuse, the row lock before the body, the missing-session refusal, the missing-access refusal of writes and snapshots, one-state snapshots, a refused write in a snapshot, the deadlock re-run, the deadline, NUL refusal and exact float round trips all hold

#### Scenario: A user binding sees only accessible content
- **WHEN** a snapshot for the owner of a session's team and one for a member without a grant read
  the session's events, and a write transaction for each inserts an event
- **THEN** the owner's snapshot returns the events and its write commits; the member's snapshot and
  write both reject with the missing-access error before their bodies run

#### Scenario: The lock is held before the body runs
- **WHEN** one connection holds a session write transaction open and another starts a session write transaction for the same session
- **THEN** the second body does not run until the first transaction ends

#### Scenario: An unconfirmed end retires the connection
- **WHEN** a session transaction's rollback is not confirmed by the server
- **THEN** the call rejects, the connection is closed and replaced, and the next session call succeeds

#### Scenario: Saturated session connections do not delay the catalog
- **WHEN** every session connection is held by a slow session snapshot and a signed-in user updates their profile
- **THEN** the profile update completes promptly, and a further session call waits for a session connection, then completes once one frees or fails with the timeout error at its deadline

#### Scenario: The connection count stays within the role's limit
- **WHEN** the server runs with session hubs open
- **THEN** it holds at most 14 database connections (its root, transaction and session connections plus the frame bus's listener and publisher), so three such processes stay within the app role's limit of 45

### Requirement: Every catalog and session call is bound to a caller

Every catalog statement the server sends SHALL run for a caller: a signed-in user (the user
binding) or a named system task (the system binding). A catalog with neither SHALL refuse every
statement and transaction, including `init()`, with a distinct unbound-catalog error, before
anything is sent; reaching it is a programming error, which the server answers with its generic
`500` and an error log line naming the error. The database refuses the app's login role on every
catalog table (catalog-database "The app connects as a least-privilege role"), so a path that
bypasses the adapter's bindings fails closed too.

**Request binding.** The authentication middleware SHALL resolve the caller (the session lookup
and the user read) and load the request's studio registry on a catalog bound to the system task
`auth-resolve`. After resolution, the catalog the routes receive SHALL be bound to the signed-in
user, or unbound when there is none, and SHALL carry the registry snapshot loaded during
resolution. A route that serves a request with no user and needs the catalog SHALL ask for a
system binding explicitly.

**One binding per transaction.** A transaction SHALL run under the binding of the catalog that
started it, and a body SHALL NOT switch bindings: a statement or transaction on any other handle
while a transaction is open is refused (core-ports-architecture "The catalog transaction
contract").

**Session hub calls carry their caller.** Every session hub storage call (every read and write
of session content, the row lock and the live projection included) SHALL run under the binding
of the caller that made it, chosen per call, not per hub: one hub serves every caller of its
session. A hub resolved from the registry SHALL expose its storage operations only through a view
bound to a session caller; there SHALL be no unbound path to them. A session caller SHALL be
either:
- a user: the signed-in user of the request that makes the call, or, for work a request started
  and that outlives it (an AI turn's tool calls, a log-import job), the user who started it; or
- a named system task, for calls no user makes: opening a hub (its seed rows and stale-lease
  cleanup), the recording lease alarm, token-only Companion calls (for any session id, until the
  Companion has its own credential), operator scripts, and a request's undo steps, which remove
  only what that same request wrote or the snapshot it is replacing, after one of its later steps
  failed or was refused.

Socket fan-out (attach, detach, relayed commands, closing a user's sockets) and broadcasts need no
caller. The frame bus (ADR 0021 slice 9a) sends its `pg_notify` statements either inside the
write or revoke transaction that issued them, under that transaction's binding, or on its own
publisher and listener connections, which run no catalog or session statement and read no row.

**System reasons are reviewed.** Every system binding and every system session caller in
production code SHALL name its reason as a string literal. A repository test SHALL list every
system binding and system session caller in the production sources of `server/src`,
`server/scripts` and the packages with its file and reason, and SHALL fail when the list differs
from a reviewed allowlist in either direction (a new call site, a new reason, a reason moved to
another file, or an allowlist entry no longer used), or when a reason is not a string literal. The
catalog's user binding SHALL be created only by the authentication middleware, and a user session
caller only in the reviewed files that take it from the request's signed-in user or from the user
recorded on a job the request started, and the session storage only in the composition root and
the operator scripts; the repository test SHALL fail on either elsewhere, and on a caller written as
an object literal outside the modules that implement the bindings. Tests are exempt.

The allowlisted reasons in this slice are: `auth-resolve`, `boot-wait`, `kv` (login sessions,
OAuth state, the Companion's last command and the expiry purges), `session-open` (a hub's open:
its seed rows and stale-lease cleanup, after a gate or in work a gated request started),
`session-lease-alarm` (the recording lease alarm), `session-undo` (a request's undo steps),
`merge-audio-script` (the operator's audio merge script),
`log-import-job` (the job's catalog reads and its per-sheet re-check; its hub calls run as its
creator), `oauth-callback`, `bootstrap-claim`, `support-plane` (`/api/admin/*`),
`companion-token` (token-only Companion calls, catalog and hub), `access-loss-check`,
`team-invite` and `team-create`. The `session-mirror` reason was retired with the mirror (ADR 0021
slice 7b-1) and the `session-hub` reason with the per-call caller (slice 7b-2).

#### Scenario: A signed-in request runs as its user
- **WHEN** a signed-in user loads `GET /api/profile`
- **THEN** the session lookup and the user read run under the system binding (`kv`,
  `auth-resolve`), and every statement the route itself sends runs as `catalog_user` with that
  user's id

#### Scenario: A request with no user fails closed
- **WHEN** a request with no signed-in user reaches a handler that queries the request catalog
  without asking for a system binding
- **THEN** the response is `500` `{"detail": "Internal Server Error"}`, the log names the
  unbound-catalog error, and no statement reaches the database

#### Scenario: Unchanged behaviour
- **WHEN** the server's unit, integration and `pg` suites run after the bindings are introduced
- **THEN** they pass with no change to any HTTP status, body or WebSocket message they assert

#### Scenario: A new system call site needs review
- **WHEN** a production file gains a system binding whose file and reason are not on the
  allowlist, or uses a reason held in a variable
- **THEN** the repository test fails and names the file and the reason

#### Scenario: A stale allowlist entry fails
- **WHEN** an allowlisted system binding is removed from the code but not from the allowlist
- **THEN** the repository test fails and names the stale entry

#### Scenario: A system handle inside a user transaction is refused
- **WHEN** a body of a user-bound transaction issues a statement through a system-bound catalog
- **THEN** the call rejects with the misuse error and the transaction rolls back

#### Scenario: Session hub statements run as their caller
- **WHEN** a signed-in user logs an event in a session whose hub is already open
- **THEN** the route's own catalog reads and every statement of the hub's write, the row lock and
  the projection update included, run as `catalog_user` with that user's id

#### Scenario: Two users on one hub keep their own bindings
- **WHEN** two signed-in users with access to one session write to it concurrently through the
  same open hub
- **THEN** each write's statements run as `catalog_user` with its own user's id, and the writes
  are serialized in one order

#### Scenario: Calls no user makes run as their reviewed system task
- **WHEN** a hub is opened for a session, its lease alarm fires, a token-only Companion call logs
  an event, and an audio upload whose blob write failed removes its segment row
- **THEN** the open runs as `catalog_system` under `session-open`, the alarm under
  `session-lease-alarm`, the Companion write under `companion-token`, and the removal under
  `session-undo`

#### Scenario: Background work runs as the user who started it
- **WHEN** an AI turn started by user A calls a tool that creates an event, and a log-import job
  started by user A writes events
- **THEN** each of those hub statements runs as `catalog_user` with A's id

#### Scenario: A user session caller outside the reviewed files fails the scan
- **WHEN** a production file other than the reviewed ones makes a user session caller or builds
  the session storage, a caller is written as an object literal outside the implementing modules,
  or a system session caller's reason is not a literal or not on the allowlist
- **THEN** the repository test fails and names the file

### Requirement: Version checks are atomic with the session write
The session hub's update and delete operations for events, transcript words and topics SHALL take
an optional expected version and an overwrite flag (ADR 0021 slice 7c-1). When an expected version
is given, the operation SHALL read the row's version and either write or refuse inside one hub
write transaction, after the session's row lock is held. A refusal SHALL be a result, not an
error: it SHALL carry the row as stored and SHALL write nothing, advance nothing and broadcast
nothing. A missing row SHALL keep each operation's existing not-found result. An operation without
an expected version SHALL behave exactly as before, apart from advancing the row's version.

An overwrite that passes the check SHALL write its audit row in the same transaction, bound to the
same user caller. The overwrite flag SHALL be accepted only from a user caller; a system caller
with an overwrite flag SHALL be refused with a misuse error before any statement runs.

The session's revision SHALL be advanced by the hub's write path, not by each store: once per
write transaction, by the first store statement of the transaction that changes a session row
(the hub-open seed and the event list's relink bookkeeping do not count), and every
frame and result of that transaction that names the revision SHALL carry the advanced value. A
transaction body that runs more than once (a retried deadlock) SHALL advance it once, for the run
that committed.

#### Scenario: Concurrent same-version edits from two processes
- **WHEN** two server processes update one event concurrently, many times, each with the version it
  last read
- **THEN** every update either commits and advances the version by one or is refused with the
  stored row, and the final version equals one plus the number of committed updates

#### Scenario: A refusal writes nothing
- **WHEN** a versioned topic update is refused
- **THEN** the topic, the session's revision and the overwrite table are unchanged, and no frame is
  sent

#### Scenario: A system caller cannot overwrite
- **WHEN** a hub view bound to a system caller calls an update with the overwrite flag
- **THEN** it rejects with a misuse error and runs no statement

#### Scenario: One revision per transaction
- **WHEN** one hub write transaction inserts two events and changes the transport
- **THEN** the session's revision advances by one, and both `event.changed` frames it sends carry
  that value

#### Scenario: A retried transaction advances the revision once
- **WHEN** a hub write's first run advances the revision and fails with a deadlock, and its second
  run commits
- **THEN** the session's revision is one more than before the write

### Requirement: Recording leases are correct across processes
The recording lease SHALL be correct when several server processes share one database, without
relying on any one process's memory or timer (ADR 0021 slice 8a).

- **The stored expiry is the authority.** Every read of the lease and every claim SHALL judge it by
  its stored expiry against the Clock port, so a lease that no process has freed already reads as
  not alive and can be claimed.
- **Claims decide in the database.** A claim SHALL be one conditional statement, so two claims
  racing from different processes produce exactly one holder, even without the session row lock.
- **Any process frees an expired lease.** Its lease alarm, opening the session, a takeover
  claim, or the lease sweeper SHALL free it. Freeing SHALL happen once across processes: one row deleted, the revision
  advanced by one, and `lease.changed` broadcast by the process that freed it.
- **The sweeper bounds how long an expired lease stays.** A lease no process is looking at MAY
  stay stored after it expires, and still reads as not alive, until a lease sweeper tick in any
  process frees it, within about one sweep interval of its expiry (run-status-and-sweeper D6; see
  Expired leases are swept by every process).

#### Scenario: Two processes claiming give one holder
- **WHEN** two processes' hubs claim one session's lease at the same moment for different users,
  for 200 rounds, the winner releasing after each round
- **THEN** each round has exactly one successful claim, and the revision advances by exactly two
  per round

#### Scenario: A lease whose process stopped is freed by another
- **WHEN** process A claims the lease and stops without releasing it, the lease expires, a client
  reads the status through process B, and another user then claims through B
- **THEN** the status reports the lease not alive, and the claim succeeds and replaces the stored
  lease in one write

#### Scenario: Two alarms free a lease once
- **WHEN** both processes have their lease alarm armed for the same expiry and both fire
- **THEN** the lease row is deleted once, the revision advances by one, and one `lease.changed` is
  sent in total

#### Scenario: Heartbeats through another process keep the lease
- **WHEN** process A heartbeats every 8 s while process B's alarm fires repeatedly with B's clock
  500 ms ahead
- **THEN** B never frees the lease

#### Scenario: A crashed recorder's lease is freed without anyone opening the session
- **WHEN** process A claims the lease and stops without releasing it, no process opens the session,
  a client's socket on process B watches the session, and the lease expires
- **THEN** within one sweep interval after the expiry a sweeper tick frees it, the revision advances
  by one, and B's socket receives `lease.changed`

### Requirement: Run single-flight slots are correct across processes
The per-session single-flight checks of the shared AI turn slot (AI chat, AI v2 design, topic
generation, event generation), transcript generation and YouTube import SHALL each be a session
lease, of kind `ai-turn`, `transcript-generation` and `youtube-import` respectively (ADR 0021
slice 8b), so two processes sharing one database never run two of the same kind for one session.

- **Claims decide in the database.** A run lease claim SHALL be one conditional statement that wins
  only on a free or expired row, so two claims racing from different processes produce exactly one
  holder.
- **The start time.** A run lease claim SHALL set `started_at_ms` to the claim's Clock time when
  it inserts the row or takes over another holder's row, and SHALL keep it when the same holder
  renews (run-status-and-sweeper D4).
- **The holder.** A run lease SHALL be held by the user the request runs as (the job's creator for a
  sheets log-import transcript run) and by a server run id, `srv:<boot id>:<uuid>`, unique per run.
- **The holding process renews it.** A run lease SHALL live 40 s from its claim or last renewal.
  The process that holds it SHALL renew it every 10 s until the run releases it, by re-claiming it
  as the same holder, so a holder whose lease lapsed and was not taken gets it back. A renewal
  refused because another holder has a live lease SHALL be logged, SHALL stop the renewals and
  SHALL NOT stop the run. A failed renewal (an error) SHALL be logged and retried on the next tick.
- **Released on every path, before the response.** Every path that releases the in-process slot
  SHALL first release the lease and then the slot, and a request's response SHALL complete only
  after its lease release. The release SHALL be conditional on the holder, so a lost lease is never
  deleted by its former holder.
- **Silent.** Run leases SHALL be written without advancing the session revision, without
  broadcasting `lease.changed` and without arming the lease alarm. An expired run lease is
  overwritten by the next claim, or deleted silently by the lease sweeper, whichever comes first
  (run-status-and-sweeper D6).
- **The in-process checks stay, in front of the lease.** The shared AI turn registry
  (`aiChatTurns`), the YouTube import guard and transcript generation's run registry
  (`transcriptGenerationLock`) SHALL each be an in-process per-session set with no count and no
  ceiling (run-status-and-sweeper D2, D3). They SHALL stay in process memory and SHALL be checked
  first, synchronously, so every single-process session-busy `409` detail and the event-generation
  await-free window are unchanged. The lease SHALL be claimed after them. A refused claim SHALL
  free the in-process slot and respond `409`: with the feature's session-busy detail for the AI
  turn and YouTube import, and for transcript generation with the holder-named detail carrying the
  live lease's `started_at_ms`, or the generic in-flight detail when that lease is no longer live
  or has no start time. A claim that fails with an error SHALL free the in-process slot.
- **No run ceiling on `claude_cli`.** On `AI_PROVIDER=claude_cli` no process-wide or
  deployment-wide ceiling SHALL bound any run kind. A future deployment-wide ceiling SHALL be a
  count of the kind's live run leases, taken under a per-kind transaction advisory lock on a new
  claim and skipped on renewal; it is deferred to the change that adds other providers.

#### Scenario: Two processes start an AI turn for one session
- **WHEN** two processes' hubs claim one session's `ai-turn` lease at the same moment for different
  users, for 200 rounds, the winner releasing after each round
- **THEN** each round has exactly one successful claim, and the session revision never changes

#### Scenario: A turn held by another process is refused before any spawn
- **WHEN** another process holds a live `ai-turn` lease for the session and a client sends an AI
  chat, an AI v2 design, a topic generation or an event generation request for that session
- **THEN** each responds `409` with that feature's session-busy detail, and no subprocess is spawned

#### Scenario: A crashed holder's lease is taken over after expiry
- **WHEN** process A claims a session's `youtube-import` lease and stops without releasing it, and
  process B claims it for another user 41 s later
- **THEN** B's claim replaces the stored lease in one write

#### Scenario: A long run keeps its lease
- **WHEN** a run lease is held for 180 s of clock time with renewals every 10 s, and another holder
  claims the same session and kind throughout
- **THEN** the lease is renewed 18 times, is alive throughout, and every competing claim is refused

#### Scenario: A lapsed lease is re-taken by its holder
- **WHEN** a holder's renewals fail with errors for more than 40 s, nobody else claims the lease,
  and a renewal then succeeds
- **THEN** the holder holds the lease again

#### Scenario: A lost lease is not released by its former holder
- **WHEN** a run's renewal is refused because another holder took the expired lease, and the run
  then finishes
- **THEN** the run logs the refusal once and completes, and its release leaves the new holder's
  lease in place

#### Scenario: Back-to-back runs on one session are not refused
- **WHEN** a topic generation run on a session completes, and the client immediately sends another
- **THEN** the second request is not refused with `409`

#### Scenario: Runs of one kind on different sessions are not capped
- **WHEN** `AI_PROVIDER` is `claude_cli` and five processes sharing one database each start an AI
  turn, a YouTube import and a transcript generation run on their own distinct sessions at once
- **THEN** every run claims its lease and none is refused with `409`

#### Scenario: A renewal keeps the run's start time
- **WHEN** a run lease is claimed at clock time T, renewed by its holder six times, then expires and
  is taken over by another holder at clock time U
- **THEN** its `started_at_ms` is T through every renewal, and U after the takeover

### Requirement: Session frames reach every process in commit order
Every frame a session's write transaction issues (`event.changed`, `transport.changed`,
`audio.changed`, `lease.changed`) SHALL reach every `/api/sessions/:id/ws` socket attached to that
session in any server process sharing the database (ADR 0021 slice 9a), through a Postgres
`NOTIFY` channel that every process listens on.

- **Published with the commit.** A transaction's frames SHALL be published inside the
  transaction, so a transaction that rolls back, or an attempt that is retried, publishes nothing.
  Every process, including the one that made the write, SHALL deliver frames only from the channel,
  so each socket receives a session's frames in commit order and, within one transaction, in issue
  order. Each published message SHALL carry a sequence number unique within its transaction, so
  Postgres never folds two equal frames into one.
- **Signed.** Every message SHALL carry an HMAC-SHA256 over its content, keyed by the server-only
  `FRAME_BUS_SECRET`. A receiver SHALL drop, and log, a message whose signature does not verify,
  whose version is unknown, whose frame type is not one of the five session frame types, or whose
  command is not a contract command. Each message SHALL also carry its sending bus's id and send
  time under the signature. A receiver SHALL drop a message sent before its own listener first
  started, a message other than a close sent more than 30 s before or after its own clock, and a
  message whose bus id and sequence number it already accepted in the last 60 s; it SHALL log each
  drop, with the clock skew for a stale one. A database role without the secret therefore cannot
  inject a frame, a command or a close, and cannot replay a captured frame or command. The server
  processes SHALL keep their clocks within a few seconds of each other (NTP).
- **Commands.** A relayed command SHALL be checked against the contract's command values before it
  is published, at most 10 per second per socket (excess dropped), and published on the bus's own
  publisher connection, never on a catalog or session connection.
- **Access-loss closes.** The close for a user who lost access SHALL be published inside the
  transaction that removes the access, split across as many messages as the payload limit needs.
  A revoke whose close cannot be published SHALL fail and change nothing.
- **The frames are unchanged.** Shapes, types, revisions, and where each frame is emitted are as
  before.

The Postgres bus is used by the server's production entry point. Test harnesses and a registry
built without a bus deliver in process, after commit, as before this change.

#### Scenario: A write through one process reaches a socket on another
- **WHEN** a browser has a socket on session S through process B and a client logs an event through
  process A
- **THEN** the socket on B receives that write's `event.changed` with its revision, exactly once

#### Scenario: Interleaved writes arrive in commit order everywhere
- **WHEN** processes A and B each log 100 events on session S concurrently, and sockets on S are
  attached through both
- **THEN** every socket receives 200 `event.changed` frames whose revisions strictly increase

#### Scenario: A rolled-back write publishes nothing
- **WHEN** a write transaction on S issues a frame and then fails
- **THEN** no socket in any process receives that frame

#### Scenario: A command reaches a browser on another process
- **WHEN** a socket on session S through process A sends `{type:"command", command:"record-start"}`
  while another browser socket on S is attached through process B
- **THEN** the socket on B receives the `command` frame

#### Scenario: A forged message is dropped
- **WHEN** a database role without the secret calls `pg_notify` on the channel with a well-formed
  command frame for session S
- **THEN** no socket in any process receives it, and the receiving processes log the drop

#### Scenario: A replayed message is dropped
- **WHEN** a database role captures a signed command message from the channel and calls
  `pg_notify` with the same payload, once right away and again 31 s later
- **THEN** no socket in any process receives either copy, and the receiving processes log both
  drops

#### Scenario: A large team's revoke still closes every socket
- **WHEN** a member of a team with 300 sessions is removed through process A while they hold a
  socket on one of those sessions through process B
- **THEN** that socket closes with code `4403`

### Requirement: Expired leases are swept by every process
Every server process SHALL run a lease sweeper that removes expired session leases
(run-status-and-sweeper D6). It SHALL be idempotent across processes, with no election, like the
key-value purge.

- **Schedule.** The sweeper SHALL tick every 60 s on an unref'd timer, started after the server
  binds its other periodic tasks and cleared on shutdown. Its first tick SHALL come one interval
  after start, so it never delays `listen()`. Ticks SHALL never overlap.
- **Run kinds.** Each tick SHALL delete every expired run lease (the kinds `ai-turn`, `transcript-generation` and `youtube-import`, named in an allow-list, so a kind added later is never swept by default) in one
  system-role statement. The deletion SHALL be silent: no revision change, no frame.
- **Recording leases.** Each tick SHALL then list up to 100 sessions with an expired `recording`
  lease, oldest expiry first, and free each one in turn by opening the session as a system caller
  and running the lease's expiry check through the session hub's write path, so the revision
  advances once and `lease.changed` reaches every process. The rest wait for later ticks.
- **Warn-only.** A failure on one session SHALL be logged as a warning and SHALL NOT stop the tick;
  a failed tick SHALL be logged as one warning and SHALL NOT stop the timer.
- **Reads through a port.** The sweeper and `GET /api/transcript-generation/status` SHALL reach
  `catalog.session_leases` across sessions through a `LeaseDirectory` port bound to the catalog's
  system role, so row-level security does not hide any team's rows.

#### Scenario: Two processes sweep the same rows
- **WHEN** processes A and B tick at the same moment over the same expired run leases and the same
  expired recording lease
- **THEN** each expired run row is deleted once, the recording lease is freed once, the session's
  revision advances by one, and one `lease.changed` is sent in total

#### Scenario: Live leases are untouched
- **WHEN** a tick runs while a session holds a live run lease and a live recording lease
- **THEN** both rows are unchanged

#### Scenario: One failing session does not stop the tick
- **WHEN** freeing the expired recording lease of the first of two listed sessions fails
- **THEN** the sweeper logs a warning naming that session and still frees the second session's lease

#### Scenario: Ticks never overlap
- **WHEN** a tick is still running when the next interval elapses
- **THEN** no second tick starts until the first finishes
