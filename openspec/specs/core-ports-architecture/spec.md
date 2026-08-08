# core-ports-architecture

## Purpose

The normative contract for the domain core and its adapter boundaries: the port ledger
(the true ports SessionRuntime, Clock, IdentityVerifier; CatalogStore as a
reshape-not-swap seam) and the concrete-only edges (BlobStore, KvStore,
PresenceRegistry); the deliberate synchronous-hub / synchronous-catalog posture
(embedded-only, no Cloudflare-shaped or async-costume APIs); the composition-root
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

### Requirement: Session runtime is a synchronous, substitutable port

The session spine SHALL depend on a `SessionRuntime` port exposing SQL, socket fan-out,
an alarm/scheduler, and a clock — as an **interface**, so a fake runtime can be supplied in
tests without touching `SessionCore`. The port SHALL be synchronous so that `SessionHub`
RPC bodies remain zero-`await`, and it SHALL abstract over embedded stores only. The
port's normative home is `@autologger/session-core` (alongside `SessionCore`), not
`@autologger/ports` — it is the session package's internal substitution seam, consumed
by the package's stores and by test fakes, and moving it to L0 would drag
session-internal types into the ports package for no consumer benefit.

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
- **WHEN** the catalog stores in `@autologger/catalog` (`packages/catalog/src/`) are inspected
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
key/value TTL expiry (login sessions, OAuth CSRF), Companion presence freshness, the
identity JWKS cache TTL, the log-import job store's terminal-job TTL and finished-at
stamping, and the AI runtime's process-group kill-ladder deadline. The lease **alarm
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

`transcriptGenerationLock.tryAcquire`'s `startedAtMs` is such a read: the lock never expires
by time and is cleared in a `finally`, nothing branches on the value, and it is serialized
as the frozen `started_at` field — which makes converting it a contract risk taken for no
requirement.

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
- **WHEN** the job store exceeds its size cap
- **THEN** eviction removes terminal jobs in map insertion order and never a queued or running job — behavior that depends on no time value and is exercised by exceeding the cap rather than by advancing a clock

#### Scenario: Job status observed through the app is unchanged
- **WHEN** a log-import job is created, progresses, and reaches a terminal status through the real app after the clock is injected
- **THEN** the status endpoint's JSON shape, status codes, and creator-scoping behavior are identical to before the change, and no job time value is observable on the wire (`systemClock` reads the same source the direct call did)

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
with an explicit per-route policy is **deferred** — see the archived change's design D6 —
so its default-deny requirements are out of scope for this capability.)

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
`PresenceRegistry`, `CatalogDb`) and the `Config` type SHALL live in
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
- **THEN** it contains no runtime implementations and no import that resolves into `server/src`, and each of the six port types is an interface or type declaration

#### Scenario: God-barrel stays retired and the concrete-class allowance is gone
- **WHEN** the server source is searched for imports of `server/src/types` and `appEnv.ts` is inspected
- **THEN** no `types.ts` import remains, `server/src/types.ts` does not exist, and `appEnv.ts` names no concrete class — its persistence types are the facade interfaces exported by `@autologger/session-core` and `@autologger/catalog`

#### Scenario: Implementations conform to the package interfaces
- **WHEN** the concrete `BlobStore`, `KvStore`, `PresenceRegistry`, and `CatalogDb` classes are inspected
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
(returning the hub facade), `evictIdle`, and `startSweeper`; coordination internals
(`lastTouchedMs`, `close`, `hasArmedAlarm`, `socketCount` on the hub; `closeAll` and
the hub map/sweeper internals on the registry) SHALL stay off the facades. Facade
interface members SHALL be authored as **property-style function types**
(`m: (args) => R`), not method syntax, so `strictFunctionTypes` checks parameters
contravariantly and drift between class and interface fails `tsc --noEmit`.

Concrete classes SHALL declare `implements` against their facade interfaces. Because
`Catalog` is constructed **per request** (in `middleware/auth.ts`, with `init()`
refreshing the studio registry once per request before registry reads),
`@autologger/catalog` SHALL export a factory (`createCatalog(db: CatalogDb)` returning
the facade type) as the sanctioned construction path outside the composition root; the
per-request construct-then-`init()` lifecycle SHALL be preserved exactly. Outside the
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
- **THEN** each request constructs a fresh catalog facade via `createCatalog` and runs `init()` before registry reads, exactly as `new Catalog(db)` + `init()` did — request-scoped studio-registry snapshot isolation is unchanged

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
time** rather than holding it across an `await`. No intermediate "session tool port" SHALL be
interposed between the tool bodies and that facade.

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
- **THEN** each obtains its hub by calling the injected registry facade's getter inside the tool body, and none holds a hub reference across an `await`

#### Scenario: The deferral is legible from the baseline alone

- **WHEN** a reader inspects the durable baseline for whether a session tool port exists
- **THEN** the absence is stated as a decision with its reason and its re-derivation requirement, rather than being inferable only from the absence of a requirement
