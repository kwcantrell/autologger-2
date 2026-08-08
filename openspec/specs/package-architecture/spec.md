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
command (per-project `tsc --noEmit`), the root test command, and the root lint command
(`biome.json` includes `packages/**`).

The mechanism differs between the app and the packages, and SHALL be described accurately
because a change that wires a new package into the wrong one fails **silently**: the
server's own coverage is explicitly enumerated vitest projects — its two-tier
unit/integration project setup, including its integration `setupFiles`, SHALL be preserved
verbatim, and package projects SHALL NOT be added to it — while each package's coverage is
an entry in the **root manifest's** chained `test` and `typecheck` commands invoking that
workspace. A package absent from those chains is never tested and never typechecked while
every gate reports green.

#### Scenario: No build artifacts
- **WHEN** the repository is inspected after `npm run typecheck` and `npm test`
- **THEN** no committed `packages/*/dist` or emitted declaration output exists and no package defines a build script required for consumption

#### Scenario: Package tests provably execute
- **WHEN** a deliberately failing test is placed in each package (and in the server's unit and integration tiers) during test-wiring implementation
- **THEN** the root test command fails for each, proving no project is silently skipped; the check is recorded in the apply ledger

#### Scenario: A newly added package joins both root chains
- **WHEN** a change adds a package and the root manifest's `test` and `typecheck` chains are inspected
- **THEN** the package appears in both, proven by a deliberately failing test **and** a deliberate type error each failing the corresponding root command — a passing root run is not evidence the package ran

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
listener singleton, the transcript-generation lock, the YouTube import guard, the DeepGram
shared dispatcher, and the log-import job store) SHALL be owned by exactly one module in
exactly one package or app, and SHALL NOT be duplicated or re-homed such that two module
instances could coexist in one process. A package move that touches a singleton's module
SHALL preserve single-instance semantics.

Where a singleton's single-instance identity is established by a key on `globalThis` rather
than by module identity alone — because the module must survive development-time module
re-evaluation — that mechanism SHALL be preserved verbatim across a package move, and SHALL
NOT be replaced by a module-local binding.

#### Scenario: Singleton modules resolve uniquely
- **WHEN** the module graph of a running server is inspected for the singleton-bearing modules
- **THEN** each loads exactly once, from exactly one package or app location

#### Scenario: A relocated singleton keeps its identity mechanism
- **WHEN** a singleton whose identity depends on a `globalThis` key moves into a package, and a job is created through one import path and read back through another after the module is re-evaluated
- **THEN** the same instance is observed, and the key and its rationale are unchanged by the move

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

### Requirement: Feature services are packages in a flat layer above persistence

`@autologger/transcription` (DeepGram transcription), `@autologger/media-import` (YouTube
audio import), and `@autologger/log-import` (Sheets log import) SHALL be source-only
workspace packages forming a **flat layer above the persistence packages**. Each of these
**service packages** MAY import the L0 packages (`@autologger/domain`,
`@autologger/contract`, `@autologger/ports`) and the L1 persistence packages
(`@autologger/session-core`, `@autologger/catalog`, `@autologger/storage`), and SHALL NOT
import another service package.

The layer is characterized, not merely enumerated: a service package owns a coherent
feature the app composes, and takes its collaborators — persistence facades, configuration
values, blob storage — **by injection** rather than reading the host environment or the
app's composition root. This characterization is a **gloss on the three named members**, not
a universally quantified obligation: it does not require any other module that resembles a
service to become a package. In particular the AI runtime, which a separate requirement in
this capability places at `server/src/ai-runtime/` under exactly such an injection rule,
remains where that requirement puts it until a change moves it.

**Enforcement.** All of the following SHALL be checked by the boundary repo test:

1. **No service package imports another service package** — checked independently of the
   declared allowed-edge set, so adding a service-to-service entry to that set does not by
   itself permit the import.
2. **No L1 persistence package imports a service package.** Without this, a single
   allowed-edge entry plus a re-export through an L1 package launders a service-to-service
   dependency past check (1) with every gate green.
3. **No service package is reachable from another service package** through any chain of
   workspace-package imports, not merely a direct edge.
4. **Every TypeScript source file under a package's `src/` is walked.** A check whose file
   walk matches only `.ts` does not see `.mts` or `.cts`, which are equally valid module
   sources and are invisible to the package `tsconfig` include and to the architecture
   model as well — so an unwalked extension is a cheaper escape than any of the recorded
   dynamic-resolution ones.

**Stated residual bypasses.** These checks are textual scans over source, and the property
they enforce is "no plain import-syntax path between service packages," not "no possible
runtime dependency." A service that receives another service's function **as an injected
parameter** has no import edge at all and is not caught by any of them; neither is a
dependency reached through `createRequire`, a non-literal dynamic `import()`, `eval`, or
code outside the walked root. These are recorded as limits, not as work items — closing
them requires a real parser or a runtime trace.

After the extraction, `server/src/logImport/` SHALL cease to exist rather than remain as an
empty or shim-bearing directory.

#### Scenario: Service packages reach only downward

- **WHEN** the boundary repo test builds the inter-package import graph
- **THEN** every **workspace-package** import specifier from a service package resolves to an L0 or L1 package, and the test fails on any specifier that resolves to another service package (third-party and `node:` specifiers are governed by the manifest-declaration rule instead, not by this one)

#### Scenario: The no-sibling rule does not depend on the allowed-edge set

- **WHEN** a service package imports another service package, **and** the corresponding entry has been added to the declared allowed-edge set
- **THEN** the boundary repo test still fails, because the no-sibling check does not consult that set — demonstrated once during implementation against a deliberate violation, with both the pre-entry and post-entry failures recorded in the apply ledger

#### Scenario: A service dependency laundered through a persistence package is caught

- **WHEN** an L1 persistence package imports a service package, or a service package is reachable from another service package through a chain of workspace-package imports rather than a direct edge
- **THEN** the boundary repo test fails, and the transitive case is demonstrated against a chain whose intermediate hop is an **L0** package — a route neither the direct-sibling check nor the no-L1→L2 check flags, so only the reachability check can fail it, and a demonstration using an L1 intermediate would not distinguish the reachability check's presence from its absence

#### Scenario: The service-package checks are mutation-covered against their own constants

- **WHEN** the service-layer checks are exercised on synthetic trees
- **THEN** the synthetic cases invoke the same exported check functions and the same production membership constant the real-repo assertions use — so a typo'd, renamed, or emptied membership constant fails the mutation cases rather than silently passing them — and the test additionally asserts that the membership constant is non-empty and that every member names a package present under `packages/`

#### Scenario: Non-`.ts` TypeScript sources cannot evade the walk

- **WHEN** a package's `src/` contains a `.mts` or `.cts` module that imports a sibling service package or an undeclared third-party package
- **THEN** the boundary repo test fails, rather than skipping the file because its extension did not match

#### Scenario: The architecture model attributes each service to its own component

- **WHEN** the architecture model is inspected after the extraction
- **THEN** a distinct component covers each service package's sources; no component retains a glob matching zero files; every declared relationship whose evidence resolves to a file inside a service package names **that service's component as its `from` endpoint** rather than the composition root; and every capability-to-component mapping that named the composition root for a moved feature names the service's component instead. **None of these four properties is machine-checked** — the coverage gate implements only orphan, overlap, and bare-root-glob detection (no empty-component check, no duplicate-id check, and no distinctness check: one component globbing all three packages would pass), the relationship-evidence gate verifies only that an evidence file exists and contains given literals, and the capability mapping is checked only for component existence. All four are verified by review at the change that moves the code

### Requirement: A service package declares its own dependencies and owns its test fixtures

A third-party dependency **whose only importer anywhere in the repository is** a single
service package SHALL be declared by that package and SHALL NOT remain declared by the
server app — so which feature may reach the network, spawn a process, or parse a workbook is
recorded in a manifest rather than in a convention. A third-party dependency that a service
package imports **and that the app also imports**, including from the app's own tests, SHALL
be declared by both: removing a declaration while an import remains would leave that import
resolving only through workspace hoisting — the precise failure the package boundary rules
exist to prevent. The antecedent is repository-wide importer count, never service count: a
dependency imported by exactly one service **and** by an app test satisfies the second rule,
not the first.

The confinement this achieves is **declaration-side only**, and in **both** directions of the
server/package boundary. The boundary repo test verifies that a *package* declares what it
imports; it does not scan the server app's sources against `server/package.json` — neither
for a third-party specifier the server imports without declaring, nor for a workspace
(`@autologger/*`) package the server imports without declaring. Both classes resolve silently
through npm's root-level workspace hoisting rather than failing loudly, and this change
shipped an instance of the second class (three `@autologger/*` service-package imports the
server used but had not declared, hand-fixed during apply) that no gate caught. Nothing
therefore prevents a future app module from importing a service's third-party dependency, or
a service package itself, without a manifest declaration, and this change does not claim
otherwise.

Where a package move newly causes an error class **owned by a package** to be matched with
`instanceof` in the app, **each** such class SHALL be pinned by an integration test
exercised through the real app rather than by a unit-level import — not only the first one
found.

Test fixtures used by a service's tests SHALL move with that service and be addressed
through a path constant the package exports, so a fixture consumed on both sides of the
boundary exists in exactly one copy and the app's tests depend on the package rather than
the reverse. Where a consumer cannot import that constant — a script run outside the
TypeScript toolchain — the exception SHALL be named and the consumer verified by execution,
because no repository gate covers it.

#### Scenario: A dependency imported by one service is declared by that service alone

- **WHEN** the workspace manifests are inspected after an extraction
- **THEN** each third-party dependency whose only importer in the whole repository is one service package is declared by that package and no longer by the server app; each dependency the app also imports — from its sources **or its tests** — remains declared by the app as well; and every relocated dependency resolves to exactly one installed copy, verified by parsing `npm ls --json` rather than by reading its exit code

#### Scenario: Every newly cross-boundary error class is pinned

- **WHEN** a change moves modules whose error classes the app matches with `instanceof`
- **THEN** every such class has an integration test driving the real app to throw it and asserting the frozen status code and `{detail}` body

#### Scenario: A shared fixture exists in one copy

- **WHEN** a fixture is read by a test inside a service package and by an integration test that stays in the server app
- **THEN** both resolve to the same file through the package's exported path constant, no copy of it remains under the app's fixture tree, and neither test reaches into the other workspace by a relative path

#### Scenario: A fixture consumer outside the toolchain is named and executed

- **WHEN** a script that no gate covers — outside the TypeScript `include`, outside the lint scope, and not a component member — addresses a moved fixture by path literal
- **THEN** it is named as an exception in the change, its paths are updated, and it is verified by running it far enough to prove every path resolves

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

`server/src/node/` SHALL hold **only** the composition root and the Node-specific adapters
it constructs — configuration wiring, the system clock, and presence. Feature
implementations SHALL NOT live there. This directory's role was documented and then went
false, accreting a transcription feature and an audio-import feature that together
outweighed the composition root by an order of magnitude, because nothing checked it;
membership is therefore pinned by name, as the router directory's is.

Cross-feature coordination — a code path that drives one feature and then another — SHALL
live in the app rather than inside a service package. Where such coordination is
asynchronous and belongs to a request, the router-membership rule above means it lives in
a Hono-importing module. This rule is enforced **only insofar as the coupling takes the form
of an import edge**: coordination that receives the other feature's function as an injected
parameter has no import specifier and no scan detects it.

The routers-membership, AI-runtime, `ApiError`-home, and `server/src/node/`-membership rules
SHALL be enforced by the boundary repo test, not by one-time
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

#### Scenario: The composition-root directory holds only the composition root

- **WHEN** the boundary repo test inspects the production modules **anywhere under** `server/src/node/`, recursively
- **THEN** it fails if any file other than the composition-root wiring, the system clock, and presence is present — a subdirectory is itself a violation, not an exemption, because the layering enumeration compares only top-level directories and would not see a feature accumulating at `server/src/node/<feature>/`

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

- **WHEN** the branch diff over `server/src/routers/` is inspected on a change that moves modules under this requirement
- **THEN** the only changed lines in route modules are import specifiers, the `ApiError`/`TimecodeCtx` consolidation edits, the authorized stale-path comment re-points that follow a module move (a prose comment's path reference updated to its new location), and any cross-feature coordination relocation plus port threading that the change's own delta explicitly authorizes — no handler body, route registration, status code, or response construction is modified except as so authorized

#### Scenario: The move leaves no shim and no behavior change

- **WHEN** the repository is searched for re-export shims at the moved modules' former paths, and the full server test suite plus the frozen-surface conformance fixtures run after the move
- **THEN** no shim exists at any former path, and every suite and fixture passes with **no changed expectations** — no HTTP status code, JSON shape, export body, header, or WebSocket message or emission differs (test files themselves move and have their import specifiers rewritten; no assertion changes)

#### Scenario: TimecodeCtx has a single declaration

- **WHEN** the repository is searched for declarations of the `TimecodeCtx` type
- **THEN** exactly one exists, in `@autologger/session-core`; the server's `timecodeCtx(row)` derivation (which takes a catalog `Row` and therefore stays in the app) imports that type rather than redeclaring or re-exporting it
