# package-architecture

## Purpose

The normative workspace-package layout and layering rules for the modular-monolith
decomposition of the server: which internal packages exist under `packages/`, the
acyclic down-only dependency graph between them and the `server`/`web` apps, and the
toolchain and singleton-identity guarantees that keep a source-only package split from
silently regressing into a build step, a duplicated dependency, or a duplicated
process-wide singleton. Established by the `package-split-foundation` change (archived
2026-08-07), which carved out layer 0 (`@autologger/domain`, `@autologger/contract`,
`@autologger/ports`) as the foundation of the broader decomposition campaign. Layer 1
(`@autologger/session-core`, `@autologger/catalog`, `@autologger/storage`) was
established by the `persistence-package-extraction` change (archived 2026-08-07). The
`router-directory-decomposition` change (archived 2026-08-07) added the server-app
module-layout requirement — `server/src/routers/` holds HTTP-layer modules only, the AI
runtime lives in `server/src/ai-runtime/` (Hono-free, injection-fed), the app-level HTTP
error class lives at app level, and the layering-directory enumeration must be complete
and non-vacuous — all enforced by the boundary repo test.

## Requirements

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

### Requirement: The server app's module directories have declared, test-enforced roles

The `server/src` app is decomposed into role-named directories, and a module's directory
SHALL state what the module is. `server/src/routers/` SHALL hold **HTTP-layer modules
only** — modules that construct a `Hono` instance or register routes on one, plus the
helpers those modules share. Every production module anywhere under `server/src/routers/`
SHALL import `hono` (or a `hono/*` subpath, or a `@hono/*` scoped package) or the app's
`AppEnv` type.

The **AI runtime** — the MCP tool server, the Claude-CLI and Agent-SDK subprocess runners
and their process-group kill ladder, the turn orchestrator and relay, the shared
per-session AI turn registry, the one-shot turn drivers, and the generation prompt builder
— SHALL live in `server/src/ai-runtime/`. It SHALL take its collaborators by injection
(the session registry and hub facades from `@autologger/session-core`, CLI path and
budget/timeout values as parameters) and SHALL NOT import `hono`, a `hono/*` subpath, a
`@hono/*` scoped package, `appEnv`, or any module under `server/src/routers/`.

The app-level HTTP error class (`ApiError`, the class `app.onError` maps to a `{detail}`
response) SHALL live at app level (`server/src/httpError.ts`), not inside
`server/src/routers/`, so the composition root's error mapper does not import upward into
the router layer.

These three rules SHALL be enforced by the boundary repo test, not by one-time
inspection. An architectural rule that no mechanism checks regresses silently; this
capability's own history records a directory-layer enumeration being hand-pruned because
nothing failed when it went stale.

The boundary repo test's server-directory layering enumeration SHALL be **complete and
non-vacuous**: every directory under `server/src` containing production `.ts` files SHALL
be either enumerated as a layering directory or named on an explicit exemption list, and
every enumerated directory SHALL contain at least one production file. Enumeration alone
is insufficient — an enumerated directory that has been renamed or emptied contributes no
files and no edges, so every assertion over it passes vacuously.

Module moves under this requirement SHALL leave **no permanent re-export shim** behind,
SHALL be reflected in the architecture model so no component attributes the moved files
to their former home, and SHALL NOT change any observable HTTP/WS behavior.

#### Scenario: Routers directory holds only HTTP-layer modules

- **WHEN** the boundary repo test inspects the production modules anywhere under `server/src/routers/`
- **THEN** it fails if any of them imports neither `hono`/`hono/*`/`@hono/*` nor `appEnv`, and none of the AI runtime modules (`aiMcpServer`, `aiV2SdkSpawn`, `aiChatRunner`, `aiV2PendingQuestions`, `aiTurnOrchestrator`, `aiTurn`, `aiChatRelay`, `topicGenerate`, `aiChatRegistry`, `eventGeneratePrompt`, `processGroupKill`) is among them

#### Scenario: AI runtime Hono-freedom is continuously enforced

- **WHEN** a production file under `server/src/ai-runtime/` imports `hono`, a `hono/*` subpath, a `@hono/*` scoped package, `appEnv`, or a module under `server/src/routers/`, and the boundary repo test runs
- **THEN** the test fails, and this negative case is demonstrated once during implementation and recorded in the apply ledger — a `Context` parameter added to a runtime function for convenience cannot land with green gates

#### Scenario: The error mapper does not import upward into routers

- **WHEN** the boundary repo test inspects `server/src/httpError.ts`, `server/src/app.ts`, the modules that throw `ApiError`, and every production module under `server/src/routers/`
- **THEN** it fails if `server/src/httpError.ts` does not declare a class named `ApiError`, or if any production file under `server/src/routers/` declares a class named `ApiError`, or if any `ApiError` import specifier from a `server/src` production file resolves into `server/src/routers/`

#### Scenario: The layering enumeration matches the filesystem and is non-vacuous

- **WHEN** the boundary repo test compares its server-directory layering enumeration against the directories actually present under `server/src`
- **THEN** it fails if any directory containing production `.ts` files is neither enumerated nor explicitly exempted, and fails if any enumerated directory contains no production files — so a new, renamed, or emptied directory cannot silently fall outside the guard

#### Scenario: The new directory joins the acyclicity guard with the expected edges

- **WHEN** the server-directory import graph is built after the move
- **THEN** `ai-runtime` is among the enumerated directories, the graph is acyclic, and the edges **incident to `ai-runtime`** are exactly `routers → ai-runtime` and `ai-runtime → aiV2`, with no edge from `ai-runtime` back into `routers` (pre-existing edges elsewhere, including `routers → aiV2`, are unaffected)

#### Scenario: The architecture model stops attributing the runtime to routers

- **WHEN** the architecture model is inspected after the move
- **THEN** a distinct component covers `server/src/ai-runtime/**`, no component glob attributes those files to the `routers` component, every declared relationship whose evidence resolves to a file under `server/src/ai-runtime/` names that component as its endpoint rather than `routers`, and every production file under `server/src` — including new root-level files — belongs to some component

#### Scenario: The branch diff over routers is import-only

- **WHEN** the branch diff over `server/src/routers/` is inspected
- **THEN** the only changed lines in route modules are import specifiers, the `ApiError`/`TimecodeCtx` consolidation edits, and the authorized stale-path comment re-points that follow the AI-runtime move (a prose comment's path reference updated to its new location) — no handler body, route registration, status code, or response construction is modified

#### Scenario: The move leaves no shim and no behavior change

- **WHEN** the repository is searched for re-export shims at the moved modules' former paths, and the full server test suite plus the frozen-surface conformance fixtures run after the move
- **THEN** no shim exists at any former path, and every suite and fixture passes with **no changed expectations** — no HTTP status code, JSON shape, export body, header, or WebSocket message or emission differs (test files themselves move and have their import specifiers rewritten; no assertion changes)

#### Scenario: TimecodeCtx has a single declaration

- **WHEN** the repository is searched for declarations of the `TimecodeCtx` type
- **THEN** exactly one exists, in `@autologger/session-core`; the server's `timecodeCtx(row)` derivation (which takes a catalog `Row` and therefore stays in the app) imports that type rather than redeclaring or re-exporting it
