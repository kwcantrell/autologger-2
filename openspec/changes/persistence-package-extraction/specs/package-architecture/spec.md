# package-architecture — Delta

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
`domain` and `ports`), and `@autologger/storage` (the SQLite/filesystem persistence
adapters; may depend on `ports`). Layer-1 packages are siblings: no L1 package SHALL
import another L1 package. Allowed edges are permissions, not mandates — a package
declares an edge only when an import needs it.

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

### Requirement: Runtime dependencies checked by nominal identity are never duplicated

Where the app maps behavior by `instanceof` against a class owned by a package or a
shared third-party dependency (the `ZodError` → 422 and `ValidationError` → 400
mappings, the `InvalidRangeError` → 416 blob-range mapping, and the
`DashboardValidationError`/`DashboardBoundsError` → 422 dashboard-config mapping —
classes this change moves into `@autologger/storage` and `@autologger/session-core`
respectively), the dependency SHALL resolve to exactly one copy in the install tree and
each such class SHALL have exactly one module instance in the running process (moves
land as same-commit move + import rewrite; no shim window). `@autologger/contract`
SHALL declare `zod` as a peerDependency so it can never install a private copy, and
`@autologger/session-core` and `@autologger/storage` SHALL declare `better-sqlite3` as
a peerDependency (the server workspace remains the installing dependency; `web-docs`'s
devDependency declaration dedupes to the same resolved copy).

#### Scenario: One zod in the tree
- **WHEN** `npm ls zod --json` output is inspected after install
- **THEN** exactly one resolved copy exists (the property is the resolved-copy count in the JSON output, not the command's exit code — pre-existing unrelated peer-range warnings from other dependencies do not fail this gate)

#### Scenario: One better-sqlite3 in the tree
- **WHEN** `npm ls better-sqlite3 --json` output is inspected after install
- **THEN** exactly one resolved copy exists, with the L1 packages resolving to it via peerDependency

#### Scenario: Cross-package error identity preserved
- **WHEN** a request fails a contract-package schema, a request triggers a domain-package `ValidationError`, an audio request with an unsatisfiable range triggers the storage package's `InvalidRangeError`, and a dashboard-config write with an invalid config triggers the session-core package's `DashboardValidationError`, each exercised through the real app
- **THEN** the responses are `422`, `400`, `416`, and `422` respectively, exactly as before the split (the `DashboardBoundsError` arm is wire-unreachable defensive code today and is covered by the single-module-instance property rather than a wire pin)

## ADDED Requirements

### Requirement: The catalog package owns the catalog schema migrations

The catalog schema migration files (`*.sql`, filename-ordered) SHALL live in
`@autologger/catalog`, which SHALL export the resolved migrations directory path for the
composition root to hand to the migrator. The migrator itself (`openCatalogDb` /
`applyMigrations`) SHALL live in `@autologger/storage` and SHALL remain
directory-generic. The migration behavior — filename ordering, `_migrations` tracking,
one transaction per file, full ordered set applied to a fresh database — SHALL be
unchanged by the move.

#### Scenario: Fresh database migrates identically after the move
- **WHEN** the server starts against an empty `DATA_DIR` after the extraction
- **THEN** the full ordered migration set applies from the catalog package's exported directory, recording the same migration **name set and application order** in `_migrations` and producing the same resulting schema as before the move (`applied_at_utc` timestamps naturally differ)

#### Scenario: Already-migrated database is untouched
- **WHEN** the server starts against a `DATA_DIR` whose catalog was migrated before the extraction
- **THEN** no migration re-applies and startup proceeds normally
