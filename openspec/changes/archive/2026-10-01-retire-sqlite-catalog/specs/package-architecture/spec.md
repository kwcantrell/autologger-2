## MODIFIED Requirements

### Requirement: Workspace packages form an acyclic, down-only layer graph enforced by a repo test

Internal packages SHALL live under top-level `packages/` as npm workspaces, and the
package dependency graph SHALL be acyclic with imports pointing only from higher layers
to lower layers. A package SHALL import from another package only when its manifest
declares that dependency; no package SHALL import from `server/src` or `web/src` app
internals, directly or via bare workspace specifiers. Because the compiler does not
enforce this (npm workspace hoisting resolves undeclared imports and `tsc` does not read
manifest dependencies), the boundary SHALL be enforced by a repo-invariant test that
parses each package's import specifiers and asserts (a) every cross-package import is
declared in that package's manifest, (b) no package resolves into app internals, (c) the
declared layer order holds, and (d) every third-party bare specifier imported by a
package's production source is declared in that package's manifest (`dependencies` or
`peerDependencies`) — undeclared imports that only resolve via workspace hoisting SHALL
fail the test. The layer graph comprises layer 0 — `@autologger/domain` (pure domain
logic, no internal deps), `@autologger/contract` (shared wire schemas and dashboard
catalog/validator; may depend on `domain`), and `@autologger/ports` (port interfaces and
the `Config` type; may depend on `domain` and `contract` if a signature requires it) —
and layer 1, established by the `persistence-package-extraction` change:
`@autologger/session-core` (the per-session spine; may depend on `domain`, `contract`,
`ports`), `@autologger/catalog` (the catalog domain stores and facade; may depend on
`domain` and `ports`), and `@autologger/storage` (the persistence adapters:
the Postgres catalog and key/value store, the data-directory lock, and filesystem storage;
may depend on `ports`). Layer-1 packages are siblings: no L1 package SHALL
import another L1 package. Allowed edges are permissions, not mandates — a package
declares an edge only when an import needs it.

**Neither direction of drift in the declared-edge set is detected, and this is recorded as
an open defect rather than left to be rediscovered.** The declared allowed-edge set can drift
from the real import graph two ways, and no check sees either: a **declared-but-unrealized**
entry (three exist today — `contract → domain`, `ports → domain`, and `ports → contract`,
standing since the L0 packages were created and unrealized in *both* the import graph and the
manifests, since neither `contract` nor `ports` declares any `@autologger/*` dependency at
all), and a **needed-but-missing** entry, which surfaces only when the import that needs it
lands and the gate turns red. The sentence above is itself in tension on the first case: an
unexercised permission is harmless under "permissions, not mandates" and is a defect under
"declares an edge only when an import needs it," and the boundary repo test's own comment
takes the second reading ("adding an edge no file actually has would itself be a defect"). The
tension SHALL NOT be resolved by silently deleting entries or by adding a realization
assertion as a side effect of an unrelated change: an assertion also constrains *when* an
entry may be added relative to the code that needs it, which bears on the atomicity rule for
module moves. Resolving it is owned by a change that argues it on its own merits.

#### Scenario: Boundary test fails on a violation
- **WHEN** a deliberate violation is introduced (an undeclared cross-package import, or a package importing `server/src`) and the boundary repo test runs
- **THEN** the test fails, and this negative case is demonstrated once during implementation and recorded in the apply ledger

#### Scenario: Boundary test fails on an undeclared third-party specifier
- **WHEN** a package source file imports a third-party bare specifier (e.g. `better-sqlite3`) that its manifest does not declare, and the boundary repo test runs
- **THEN** the test fails, and this negative case is demonstrated once during implementation and recorded in the apply ledger

#### Scenario: L0 packages do not reach upward
- **WHEN** the import specifiers of `packages/domain`, `packages/contract`, and `packages/ports` are inspected
- **THEN** none references `server/src`, `web/src`, or a higher-layer package, and the only inter-package edges are among `contract → domain`, `ports → domain`, and `ports → contract`

#### Scenario: L1 packages are siblings that reach only L0
- **WHEN** the import specifiers of `packages/session-core`, `packages/catalog`, and `packages/storage` are inspected
- **THEN** none references `server/src`, `web/src`, or another L1 package, and the only inter-package edges are among `session-core → {domain, contract, ports}`, `catalog → {domain, ports}`, and `storage → ports` (permissions, not mandates — an edge exists only where an import needs it)

#### Scenario: The repo stays cycle-free
- **WHEN** the package and `server/src` directory import graphs are computed after the change
- **THEN** they contain no cycles — in particular both former directory cycles no longer exist: `session ⇄ aiV2` (`session/dashboardStore → aiV2/catalog` / `aiV2/aggregates → session/*`) and `auth ⇄ node` (`auth/identity → node/kvStore` / `node/config → auth/oauth_google`)

#### Scenario: The declared-edge drift defect is legible from the baseline

- **WHEN** a reader inspects the durable baseline to learn whether the declared allowed-edge set is kept in step with the real import graph
- **THEN** both undetected drift directions are stated with the three standing unrealized entries named, so a later change can distinguish a known open defect from an oversight — and no check is claimed to detect either

## REMOVED Requirements

### Requirement: The catalog package owns the catalog schema migrations
**Reason**: ADR 0021 slice 4e retires the SQLite catalog, so its `.sql` migrations, the exported migrations directory and the SQLite migrator have no caller left. The catalog schema is the Postgres schema in `supabase/migrations/`, applied by the stack's migrations runner (local-container-environments, "Migrations runner"; catalog-database, "The catalog schema lives in Postgres schema `catalog`").
**Migration**: None for callers. The old SQLite schema (migrations 0001-0006) stays in git history; prod's legacy `catalog.db` was built by `main` with 0001-0005, which the slice 11 import reads as an existing file and does not migrate.
