# package-architecture — Delta Spec

## ADDED Requirements

### Requirement: Workspace packages form an acyclic, down-only layer graph enforced by a repo test

Internal packages SHALL live under top-level `packages/` as npm workspaces, and the
package dependency graph SHALL be acyclic with imports pointing only from higher layers
to lower layers. A package SHALL import from another package only when its manifest
declares that dependency; no package SHALL import from `server/src` or `web/src` app
internals, directly or via bare workspace specifiers. Because the compiler does not
enforce this (npm workspace hoisting resolves undeclared imports and `tsc` does not read
manifest dependencies), the boundary SHALL be enforced by a repo-invariant test that
parses each package's import specifiers and asserts (a) every cross-package import is
declared in that package's manifest, (b) no package resolves into app internals, and
(c) the declared layer order holds. This change establishes layer 0:
`@autologger/domain` (pure domain logic, no internal deps), `@autologger/contract`
(shared wire schemas and dashboard catalog/validator; may depend on `domain`), and
`@autologger/ports` (port interfaces and the `Config` type; may depend on `domain` and
`contract` if a signature requires it). Allowed edges are permissions, not mandates —
a package declares an edge only when an import needs it.

#### Scenario: Boundary test fails on a violation
- **WHEN** a deliberate violation is introduced (an undeclared cross-package import, or a package importing `server/src`) and the boundary repo test runs
- **THEN** the test fails, and this negative case is demonstrated once during implementation and recorded in the apply ledger

#### Scenario: L0 packages do not reach upward
- **WHEN** the import specifiers of `packages/domain`, `packages/contract`, and `packages/ports` are inspected
- **THEN** none references `server/src`, `web/src`, or a higher-layer package, and the only inter-package edges are among `contract → domain`, `ports → domain`, and `ports → contract`

#### Scenario: The repo stays cycle-free
- **WHEN** the package and `server/src` directory import graphs are computed after the change
- **THEN** they contain no cycles — in particular both former directory cycles no longer exist: `session ⇄ aiV2` (`session/dashboardStore → aiV2/catalog` / `aiV2/aggregates → session/*`) and `auth ⇄ node` (`auth/identity → node/kvStore` / `node/config → auth/oauth_google`)

### Requirement: Packages are source-only with full toolchain coverage

Internal packages SHALL export TypeScript source directly (`"exports"` pointing at
`./src/*.ts`) with no build step required to run, test, or typecheck the repository, and
no committed build artifacts. Every package SHALL be covered by the root typecheck
command (per-project `tsc --noEmit`), the root test command (explicitly enumerated
vitest projects — the server's two-tier unit/integration project setup, including its
integration `setupFiles`, SHALL be preserved verbatim), and the root lint command
(`biome.json` includes `packages/**`).

#### Scenario: No build artifacts
- **WHEN** the repository is inspected after `npm run typecheck` and `npm test`
- **THEN** no committed `packages/*/dist` or emitted declaration output exists and no package defines a build script required for consumption

#### Scenario: Package tests provably execute
- **WHEN** a deliberately failing test is placed in each package (and in the server's unit and integration tiers) during test-wiring implementation
- **THEN** the root test command fails for each, proving no project is silently skipped; the check is recorded in the apply ledger

#### Scenario: Integration tier keeps its setup
- **WHEN** the server's `*.int.test.ts` suite runs under the new test wiring
- **THEN** the integration setup file still executes for that tier, and the `--project` selection used by the fixture-capture script still works

#### Scenario: Dev loop runs unchanged
- **WHEN** `npm run dev` is run at the repo root
- **THEN** the server boots resolving package source via tsx with no additional build or watch command

### Requirement: Runtime dependencies checked by nominal identity are never duplicated

Where the app maps behavior by `instanceof` against a class owned by a package or a
shared third-party dependency (the `ZodError` → 422 and `ValidationError` → 400
mappings), the dependency SHALL resolve to exactly one copy in the install tree.
`@autologger/contract` SHALL declare `zod` as a peerDependency so it can never install a
private copy.

#### Scenario: One zod in the tree
- **WHEN** `npm ls zod` runs after install
- **THEN** exactly one resolved copy exists

#### Scenario: Cross-package error identity preserved
- **WHEN** a request fails a contract-package schema, and a request triggers a domain-package `ValidationError`, each exercised through the real app
- **THEN** the responses are `422` and `400` respectively, exactly as before the split

### Requirement: Every process-wide singleton has exactly one package home

Each process-wide mutable singleton (among them the AI chat turn registry, the MCP
listener singleton, the transcript-generation lock, the YouTube import guard, and the
DeepGram shared dispatcher) SHALL be owned by exactly one module in exactly one package
or app, and SHALL NOT be duplicated or re-homed such that two module instances could
coexist in one process. A package move that touches a singleton's module SHALL preserve
single-instance semantics.

#### Scenario: Singleton modules resolve uniquely
- **WHEN** the module graph of a running server is inspected for the singleton-bearing modules
- **THEN** each loads exactly once, from exactly one package or app location

### Requirement: The contract package is the single home of wire schemas and dashboard validation

Zod request schemas for the HTTP surface and the dashboard widget catalog/validator
(`validateDashboardConfig`) SHALL live in `@autologger/contract`, and consumers (request
validation, the session dashboard store, MCP tools) SHALL import them from there rather
than defining parallel copies. Pure value-logic domain validation that depends on
neither zod nor wire shapes (e.g. `studio.ts`'s category/palette/settings validation)
lives in `@autologger/domain`; the discriminator is zod/wire-shape dependence.

#### Scenario: One dashboard validator
- **WHEN** the callers of dashboard-config validation are inspected (the persistence write path, the session dashboard store, and `propose_dashboard`)
- **THEN** all resolve the same `validateDashboardConfig` from `@autologger/contract`, and no second implementation exists

### Requirement: Package moves preserve the cross-workspace fixture chain

The API-response fixture capture (server integration test writing
`fixtures/api-responses/`) and the web conformance tests that import those fixtures
SHALL survive every package restructuring: the capture path, the fixture directory, and
the conformance tests' ability to run SHALL be unchanged unless a delta spec authorizes
otherwise.

#### Scenario: Conformance chain green after restructuring
- **WHEN** the server fixture-capture test and the web conformance tests run after this change
- **THEN** both pass with the fixture directory in its established location and no fixture regenerated with different content
