# core-ports-architecture — Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
packages, production code SHALL otherwise reference the facade interfaces only: the
composition root (`server/src/node/config.ts`) is the sole production module that
names the concrete classes.

#### Scenario: Routers and middleware see interfaces only
- **WHEN** production modules under `server/src/` other than the composition root are searched for imports of the concrete persistence classes (`SessionHub`, `SessionHubRegistry`, `Catalog`, and the five catalog store classes) as values or types
- **THEN** none remain — they import the package-exported facade interfaces (and `middleware/auth.ts` the `createCatalog` factory), and only `server/src/node/config.ts` names the concrete classes

#### Scenario: Interface-only consumption is continuously enforced
- **WHEN** a production file under `server/src/` other than `node/config.ts` imports one of the concrete persistence class identifiers from `@autologger/session-core` or `@autologger/catalog` (tests exempt) and the boundary repo test runs
- **THEN** the test fails — the retirement is enforced by the repo-invariant test, not by one-time inspection

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
