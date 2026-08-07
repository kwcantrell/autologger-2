# core-ports-architecture — Delta Spec

## ADDED Requirements

### Requirement: Port types are interfaces in a dedicated package with app-level composition

The injectable port types (`Clock`, `IdentityVerifier`, `BlobStore`, `KvStore`,
`PresenceRegistry`, `CatalogDb`) and the `Config` type SHALL live in
`@autologger/ports` as **interfaces/types only** — the package SHALL contain no runtime
implementations (`systemClock` lives with the composition root) and SHALL NOT import
from `server/src`, directly or transitively. Concrete implementations SHALL declare
conformance (`implements`) against the package interfaces from their own homes.

The app-env composition (`Ports` with `sessions: SessionHubRegistry`, `Variables` with
`catalog: Catalog`, and `AppEnv`) SHALL live in a single app-level module
(`server/src/appEnv.ts`) that extends the package's types; that module is the only
app-level type-composition point permitted to name the concrete `SessionHubRegistry`
and `Catalog` types, which retain concrete typing as **named residuals** owned by the
session-core and catalog extraction changes. The former `server/src/types.ts` barrel
SHALL be removed with no permanent re-export shim. The per-request in-place
`env`-mutation identity contract (`@hono/node-ws` upgrade handshake) SHALL be preserved
by the move.

#### Scenario: Ports package is interface-only and closed
- **WHEN** `@autologger/ports` is inspected
- **THEN** it contains no runtime implementations and no import that resolves into `server/src`, and each of the six port types is an interface or type declaration

#### Scenario: God-barrel retired
- **WHEN** the server source is searched for imports of `server/src/types`
- **THEN** none remain, `server/src/types.ts` does not exist, and `appEnv.ts` names no concrete class other than `SessionHubRegistry` and `Catalog`

#### Scenario: Implementations conform to the package interfaces
- **WHEN** the concrete `BlobStore`, `KvStore`, `PresenceRegistry`, and `CatalogDb` classes are inspected
- **THEN** each declares `implements` against its `@autologger/ports` interface, and `auth/identity.ts` imports the `KvStore` interface from the package (not from `node/`)

#### Scenario: WebSocket upgrades still complete after the type move
- **WHEN** a real WebSocket upgrade is driven end-to-end after the change
- **THEN** the upgrade completes and messages are delivered, confirming the env-identity contract survived

### Requirement: Pure domain modules live in the domain package

`studio.ts`, `timecode.ts`, and the shared row types formerly in `db/shared.ts` SHALL
live in `@autologger/domain`, and `schemas.ts` plus the dashboard catalog SHALL live in
`@autologger/contract`, with all former `server/src` import paths rewritten to the
packages and no permanent re-export shims left behind.

#### Scenario: Old paths are gone
- **WHEN** the server source is searched for imports of `../studio`, `../timecode`, `../schemas`, `./aiV2/catalog`, `../clock`, or `db/shared` relative paths
- **THEN** none remain; consumers import `@autologger/domain`, `@autologger/contract`, and `@autologger/ports`

## MODIFIED Requirements

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
- **THEN** it lives under `server/src/session/` (not `durable/`) and the catalog facade is `catalog.ts` (not `d1.ts`)

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
- **WHEN** the server source **and the workspace packages under `packages/`** are inspected for direct `Date.now()` calls in staleness, TTL, expiry, freshness, alarm-scheduling, or live-timecode logic
- **THEN** none remain; those paths read the injected `Clock` (the `systemClock` implementation, which lives with the composition root, is the sole sanctioned `Date.now()` site)
