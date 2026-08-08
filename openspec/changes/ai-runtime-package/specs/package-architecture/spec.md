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

### Requirement: Feature services are packages in a flat layer above persistence

`@autologger/transcription` (DeepGram transcription), `@autologger/media-import` (YouTube
audio import), `@autologger/log-import` (Sheets log import), and `@autologger/ai-runtime`
(the AI runtime) SHALL be source-only workspace packages forming a **flat layer above the
persistence packages**. Each of these **service packages** MAY import the L0 packages
(`@autologger/domain`, `@autologger/contract`, `@autologger/ports`) and the L1 persistence
packages (`@autologger/session-core`, `@autologger/catalog`, `@autologger/storage`), and
SHALL NOT import another service package.

The layer is characterized, not merely enumerated: a service package owns a coherent
feature the app composes, and takes its collaborators — persistence facades, configuration
values, blob storage — **by injection** rather than discovering its configuration from the
host environment (see `core-ports-architecture`'s host-environment-discovery requirement and
its named residuals). This characterization is a **gloss on the named members**, not a
universally quantified obligation.

**Membership in this layer is by enumeration only.** A module joins it when a change adds it
to the list above, and no property of a module — resembling a service, being injection-fed,
owning a coherent feature — makes it a member. A future change that reads this paragraph as
"every service-shaped module SHALL become a package" has misread it. `server/src/auth/` is the
standing illustration: a port adapter (`GoogleIdentityVerifier`) plus request-path plumbing
carrying HTTP routing policy (`apiRequestRequiresLogin` knows `/api/profile` and
`/api/admin/*`). Whether it should ever become a package is **open**, and this requirement
neither requires nor forbids it. The gloss is anchored on this definition rather than on any
particular counterexample, because an example-based anchor is only as durable as a later
reader's agreement with it.

The **AI runtime** — the MCP tool servers, the Claude-CLI and Agent-SDK subprocess runners
and their process-group kill ladder, the turn orchestrator and relay, the shared per-session
AI turn registry, the one-shot turn drivers, the generation prompt builder, and the session
aggregate computations the design-turn toolset exposes — SHALL live in
`@autologger/ai-runtime`. It SHALL take its collaborators by injection (the session registry
and hub facades from `@autologger/session-core`; CLI path, budget, timeout, clock, and
credential-source values as parameters) and SHALL NOT import `hono`, a `hono/*` subpath, a
`@hono/*` scoped package, `appEnv`, or any module under `server/src/`. It is admitted to this
layer because L2 is the **only legal placement** — five of its modules import
`@autologger/session-core`, which forbids L0, and the L1-sibling rule forbids L1 — not because
it exemplifies the "coherent feature" gloss, which it strains: it is machinery shared by four
capabilities and is the largest package in the repository.

The Hono-freedom check SHALL be evaluated over `@autologger/ai-runtime`'s production sources.
It is **not** subsumed by the package-boundary escape check: a `hono` import inside a package
that declared `hono` as a dependency would satisfy every boundary rule while defeating this
one. Because a file walk over a path that does not exist yields no files and passes vacuously,
the check SHALL additionally assert that its walked root contains at least one production
file — the same non-vacuity property the server-directory enumeration already requires, which
`packages/` otherwise has no analogue for.

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
5. **The service-package membership constant is complete.** Every directory under `packages/`
   that is not an L0 or L1 package SHALL be named in that constant or on an explicit exemption
   list. Checks (1)–(3) are evaluated *against* the constant, so a package omitted from it is
   silently outside all of them — a real service-to-service violation passes every check and
   the boundary check green. The existing non-emptiness and members-exist assertions cover the
   constant being wrong; they do not cover it being **incomplete**.

**Stated residual bypasses.** These checks are textual scans over source, and the property
they enforce is "no plain import-syntax path between service packages," not "no possible
runtime dependency." A service that receives another service's function **as an injected
parameter** has no import edge at all and is not caught by any of them; neither is a
dependency reached through `createRequire`, a non-literal dynamic `import()`, `eval`, code
outside the walked root, or a **dependency alias** (a manifest entry such as
`"x": "npm:@autologger/transcription@*"` imported as `x`, which the third-party specifier
check sees as a declared bare specifier). These are recorded as limits, not as work items —
closing them requires a real parser or a runtime trace.

After the extraction, `server/src/logImport/` SHALL cease to exist rather than remain as an
empty or shim-bearing directory. Likewise, after the AI runtime's extraction,
`server/src/ai-runtime/` and `server/src/aiV2/` SHALL cease to exist and SHALL NOT be
re-created; see the directory-roles requirement, which enforces their non-existence by name.

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

#### Scenario: A package omitted from the membership constant is caught

- **WHEN** a service package exists under `packages/` but is absent from the service-package membership constant, and the boundary repo test runs
- **THEN** the completeness assertion fails naming the package, and this is demonstrated by removing a real member from the constant and observing that a deliberate service-to-service violation stops being reported by all of checks (1)–(3) while the completeness assertion fires — proving the constant's omission is detected by something other than the checks it parameterizes

#### Scenario: Non-`.ts` TypeScript sources cannot evade the walk

- **WHEN** a package's `src/` contains a `.mts` or `.cts` module that imports a sibling service package or an undeclared third-party package
- **THEN** the boundary repo test fails, rather than skipping the file because its extension did not match

#### Scenario: AI runtime Hono-freedom is enforced in its package home

- **WHEN** a production file under `@autologger/ai-runtime`'s sources imports `hono`, a `hono/*` subpath, a `@hono/*` scoped package, `appEnv`, or any module under `server/src/`, and the boundary repo test runs
- **THEN** the test fails, and the negative case is demonstrated during implementation for **each** arm — `hono`, `appEnv`, and a relative reach into `server/src/` — because only the `hono` arm is non-redundant with the package-boundary escape check, and a single-arm demonstration would pass identically against a check that had lost the other two

#### Scenario: The Hono-freedom check cannot pass vacuously

- **WHEN** the Hono-freedom check's walked root is changed to a path that does not exist, and the boundary repo test runs
- **THEN** the test fails on the non-vacuity assertion rather than reporting zero violations, because the file walk yields no files for a missing directory and every assertion over it would otherwise pass

#### Scenario: The architecture model attributes each service to its own component

- **WHEN** the architecture model is inspected after the extraction
- **THEN** a distinct component covers each service package's sources; no component retains a glob matching zero files; every declared relationship whose evidence resolves to a file inside a service package names **that service's component as its `from` endpoint** rather than the composition root; and every capability-to-component mapping that named the composition root for a moved feature names the service's component instead. **None of these four properties is machine-checked** — the coverage gate implements only orphan, overlap, and bare-root-glob detection (no empty-component check, no duplicate-id check, and no distinctness check: one component globbing all three packages would pass), the relationship-evidence gate verifies only that an evidence file exists and contains given literals, and the capability mapping is checked only for component existence. All four are verified by review at the change that moves the code

#### Scenario: A component whose subject moves is deleted, not emptied

- **WHEN** a change removes a component because its subject directory ceased to exist
- **THEN** the component is deleted from the model rather than left with globs that match nothing or with its globs cleared, and the change verifies by review that no component in the model matches zero tracked files — an emptied-but-present component keeps rendering, keeps being nameable as a capability scope and a relationship endpoint, and additionally **defeats** the capability gate's dangling-component check, which fires only when a scope names a component that does not exist

### Requirement: The server app's module directories have declared, test-enforced roles

The `server/src` app is decomposed into role-named directories, and a module's directory
SHALL state what the module is. `server/src/routers/` SHALL hold **HTTP-layer modules
only** — modules that construct a `Hono` instance or register routes on one, plus the
helpers those modules share. Every production module anywhere under `server/src/routers/`
SHALL import `hono` (or a `hono/*` subpath, or a `@hono/*` scoped package) or the app's
`AppEnv` type.

**No directory under `server/src` SHALL hold the AI runtime.** Its home is
`@autologger/ai-runtime`, under the flat service layer, and that requirement carries its
placement, injection, and Hono-freedom rules — this requirement governs `server/src`
directories, and a package is not one. `server/src/ai-runtime/` and `server/src/aiV2/` SHALL
cease to exist rather than remain as empty or shim-bearing directories, and SHALL NOT be
re-created. The boundary repo test SHALL enforce their non-existence **by name**: the layering
enumeration is a permission list, so re-adding an entry would otherwise be the entire cost of
re-creating a directory, and every other post-move check is scoped to `server/src/routers/`,
`server/src/node/`, or the package — none of which would object.

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

The routers-membership, AI-runtime-non-recreation, `ApiError`-home, and
`server/src/node/`-membership rules SHALL be enforced by the boundary repo test, not by
one-time inspection. An architectural rule that no mechanism checks regresses silently; this
capability's own history records a directory-layer enumeration being hand-pruned because
nothing failed when it went stale.

The boundary repo test's server-directory layering enumeration SHALL be **complete and
non-vacuous**: every directory under `server/src` containing production `.ts` files SHALL
be either enumerated as a layering directory or named on an explicit exemption list, and
every enumerated directory SHALL contain at least one production file. Enumeration alone
is insufficient — an enumerated directory that has been renamed or emptied contributes no
files and no edges, so every assertion over it passes vacuously. A change that empties a
directory SHALL remove its enumeration entry **in the same unit that empties it**, so the
repository never passes through a state where the non-vacuity check fires as a false alarm.

Module moves under this requirement SHALL leave **no permanent re-export shim** behind,
SHALL be reflected in the architecture model so no component attributes the moved files
to their former home, and SHALL NOT change any observable HTTP/WS behavior.

#### Scenario: Routers directory holds only HTTP-layer modules

- **WHEN** the boundary repo test inspects the production modules anywhere under `server/src/routers/`
- **THEN** it fails if any of them imports neither `hono`/`hono/*`/`@hono/*` nor `appEnv`, and none of the AI runtime modules (`aiMcpServer`, `aiV2SdkSpawn`, `aiChatRunner`, `aiV2PendingQuestions`, `aiTurnOrchestrator`, `aiTurn`, `aiChatRelay`, `topicGenerate`, `aiChatRegistry`, `eventGeneratePrompt`, `processGroupKill`, `mcpTools`, `aggregates`) is among them

#### Scenario: The emptied directories cannot be re-created

- **WHEN** a production `.ts` file is placed at `server/src/ai-runtime/` or `server/src/aiV2/` and the boundary repo test runs
- **THEN** the test fails naming the directory, and this negative case is demonstrated once during implementation and recorded in the apply ledger — the layering enumeration alone would pass once the directory's entry were re-added, so a by-name prohibition is the only check that objects

#### Scenario: The error mapper does not import upward into routers

- **WHEN** the boundary repo test inspects `server/src/httpError.ts`, `server/src/app.ts`, the modules that throw `ApiError`, and every production module under `server/src/routers/`
- **THEN** it fails if `server/src/httpError.ts` does not declare a class named `ApiError`, or if any production file under `server/src/routers/` declares a class named `ApiError`, or if any `ApiError` import specifier from a `server/src` production file resolves into `server/src/routers/`

#### Scenario: The composition-root directory holds only the composition root

- **WHEN** the boundary repo test inspects the production modules **anywhere under** `server/src/node/`, recursively
- **THEN** it fails if any file other than the composition-root wiring, the system clock, and presence is present — a subdirectory is itself a violation, not an exemption, because the layering enumeration compares only top-level directories and would not see a feature accumulating at `server/src/node/<feature>/`

#### Scenario: The layering enumeration matches the filesystem and is non-vacuous

- **WHEN** the boundary repo test compares its server-directory layering enumeration against the directories actually present under `server/src`
- **THEN** it fails if any directory containing production `.ts` files is neither enumerated nor explicitly exempted, and fails if any enumerated directory contains no production files — so a new, renamed, or emptied directory cannot silently fall outside the guard

#### Scenario: The emptied directories leave the enumeration with the code that empties them

- **WHEN** the branch's commit sequence is inspected for the units that move the AI runtime and aggregate modules out of `server/src/`
- **THEN** each directory's removal from the layering enumeration lands in the same unit that empties it, no intermediate commit leaves an enumerated-but-empty directory, and after the change the enumeration names neither directory while the remaining server directories still satisfy the completeness check

#### Scenario: The branch diff over routers is import-only

- **WHEN** the branch diff over `server/src/routers/` is inspected on a change that moves modules under this requirement
- **THEN** the only changed lines in route modules are import specifiers, the `ApiError`/`TimecodeCtx` consolidation edits, the authorized stale-path comment re-points that follow a module move, and any cross-feature coordination relocation, **port threading, or composition-root-resolved configuration threading** that the change's own delta explicitly authorizes — no handler body, route registration, status code, or response construction is modified except as so authorized. A change relying on this allowance SHALL name the authorized call sites in its delta rather than in prose, and SHALL NOT describe its router diff as import-only. This change's authorized call sites are exactly: `server/src/routers/ai.ts` and `server/src/routers/events.ts` (each passing `c.env.ports.clock` into `driveAiTurn({ clock })`), `server/src/routers/transcribe.ts` (passing `c.env.ports.clock` into `generateTopicsTurn({ clock })`), and `server/src/routers/aiV2.ts` (passing `c.env.ports.clock` into `createDesignTurnSpawner(clock)` and the composition-root-resolved `c.env.config.AI_V2_CREDENTIAL_SOURCE_PATH` into `prepareDesignTurnCredentials(...)`)

#### Scenario: The directory graph loses both endpoints and stays acyclic

- **WHEN** the server-directory import graph is built after the move
- **THEN** neither `ai-runtime` nor `aiV2` is among the enumerated directories, the graph is acyclic, and no enumerated directory has an edge to either — this supersedes the pre-move expectation that the edges incident to `ai-runtime` were exactly `routers → ai-runtime` and `ai-runtime → aiV2`, both of whose endpoints this change removes

#### Scenario: The architecture model stops attributing the runtime to a server directory

- **WHEN** the architecture model is inspected after the move
- **THEN** a component covers `packages/ai-runtime/src/**`, no component glob attributes those files to the `routers` component or to any `server/src` component, every declared relationship whose evidence resolves into that package names that component as its endpoint, no capability scope names a component the move deleted, and every production file under `server/src` — including new root-level files — still belongs to some component

#### Scenario: The move leaves no shim and no behavior change

- **WHEN** the repository is searched for re-export shims at the moved modules' former paths, and the full server test suite plus the frozen-surface conformance fixtures run after the move
- **THEN** no shim exists at any former path, and every suite and fixture passes with **no changed expectations** — no HTTP status code, JSON shape, export body, header, or WebSocket message or emission differs (test files themselves move and have their import specifiers rewritten; no assertion changes)

#### Scenario: TimecodeCtx has a single declaration

- **WHEN** the repository is searched for declarations of the `TimecodeCtx` type
- **THEN** exactly one exists, in `@autologger/session-core`; the server's `timecodeCtx(row)` derivation (which takes a catalog `Row` and therefore stays in the app) imports that type rather than redeclaring or re-exporting it

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
not the first. An extraction whose moving set shares **every** third-party dependency with the
app confines nothing, and SHALL say so rather than implying otherwise — what such an
extraction buys is the prospective, closed-world property that any *new* undeclared dependency
fails, not any present-day confinement.

The confinement this achieves is **declaration-side only**. The boundary repo test SHALL
additionally scan the **server app's own sources against `server/package.json`** for
`@autologger/*` specifiers: a workspace package the server imports without declaring resolves
silently through npm's root-level workspace hoisting rather than failing loudly, and a prior
change shipped three such undeclared dependencies that no gate caught. The **third-party**
direction of the server manifest remains unscanned — an app module can still import a
service's third-party dependency without declaring it — and this requirement records that as
an open gap rather than claiming a general fix.

Where a package move newly causes an error class **owned by a package** to be matched with
`instanceof` in the app, **each** such class SHALL be pinned by an integration test
exercised through the real app rather than by a unit-level import — not only the first one
found. Where a move introduces **no** such newly cross-boundary class, the change SHALL
state that the set is empty rather than leave the obligation unaddressed.

Test fixtures used by **a service package's own tests** SHALL move with that service and be
addressed through a path constant the package exports, so a fixture consumed on both sides of
the boundary exists in exactly one copy and the app's tests depend on the package rather than
the reverse. A fixture that **no test inside the package reads** — one whose only consumers
are the app's integration tests, which stay under `server/src/` by standing invariant, or the
e2e suite — SHALL stay in the app's fixture tree: the criterion is which tests read it, not
which feature it depicts, and a package SHALL NOT ship assets nothing in or reachable from it
consumes. Classifying a fixture SHALL be done by reading the referencing lines, not by
matching filenames: a comment naming a fixture is not a reader, and a change that treats one
as a reader has defeated the instrument the classification depends on. Where a consumer cannot
import that constant — a script run outside the TypeScript toolchain — the exception SHALL be
named and the consumer verified by execution, because no repository gate covers it.

#### Scenario: A dependency imported by one service is declared by that service alone

- **WHEN** the workspace manifests are inspected after an extraction
- **THEN** each third-party dependency whose only importer in the whole repository is one service package is declared by that package and no longer by the server app; each dependency the app also imports — from its sources **or its tests** — remains declared by the app as well; and every relocated dependency resolves to exactly one installed copy, verified by parsing `npm ls --json` rather than by reading its exit code

#### Scenario: The server app declares the workspace packages it imports

- **WHEN** the boundary repo test extracts every `@autologger/*` import specifier from the server app's production sources and compares them against `server/package.json`'s declared dependencies
- **THEN** it fails naming any package the server imports without declaring, and this negative case is demonstrated once during implementation by removing a real declaration and observing the failure

#### Scenario: Every newly cross-boundary error class is pinned

- **WHEN** a change moves modules whose error classes the app matches with `instanceof`
- **THEN** every such class has an integration test driving the real app to throw it and asserting the frozen status code and `{detail}` body; and where the moving set declares no `Error` subclass the app matches, the change states that the set is empty and the existing pins are unaffected

#### Scenario: A shared fixture exists in one copy

- **WHEN** a fixture is read by a test inside a service package and by an integration test that stays in the server app
- **THEN** both resolve to the same file through the package's exported path constant, no copy of it remains under the app's fixture tree, and neither test reaches into the other workspace by a relative path

#### Scenario: A fixture with no in-package reader stays in the app

- **WHEN** a service extraction is inspected for fixtures whose only readers are the app's integration tests or the e2e suite
- **THEN** those fixtures remain under the app's fixture tree, the package exports no constant addressing them, and the split is justified by reader location — established by reading each referencing line rather than by matching filenames — rather than by which feature the fixture depicts

#### Scenario: A fixture consumer outside the toolchain is named and executed

- **WHEN** a script that no gate covers — outside the TypeScript `include`, outside the lint scope, and not a component member — addresses a moved fixture by path literal
- **THEN** it is named as an exception in the change, its paths are updated, and it is verified by running it far enough to prove every path resolves

### Requirement: Runtime dependencies checked by nominal identity are never duplicated

Where the app maps behavior by `instanceof` against a class owned by a package or a
shared third-party dependency (the `ZodError` → 422 and `ValidationError` → 400
mappings, the `InvalidRangeError` → 416 blob-range mapping, and the
`DashboardValidationError`/`DashboardBoundsError` → 422 dashboard-config mapping —
classes moved into `@autologger/storage` and `@autologger/session-core`
respectively), the dependency SHALL resolve to exactly one copy in the install tree and
each such class SHALL have exactly one module instance in the running process (moves
land as same-commit move + import rewrite; no shim window). `@autologger/contract`
SHALL declare `zod` as a peerDependency so it can never install a private copy, and
`@autologger/session-core` and `@autologger/storage` SHALL declare `better-sqlite3` as
a peerDependency (the server workspace remains the installing dependency; `web-docs`'s
devDependency declaration dedupes to the same resolved copy).

`instanceof` mapping is **not** the only ground for single-copy treatment, and this
requirement SHALL NOT be read as licensing a private copy wherever no `instanceof` occurs.
`@autologger/ai-runtime` SHALL likewise declare `zod` as a peerDependency: it hands zod
schema objects to `@anthropic-ai/claude-agent-sdk`'s `tool()`, which carries its own `zod`
peer, so a second resolved copy is a **schema-identity** hazard independent of any error
mapping. No `ZodError` raised inside an AI-runtime tool body can reach the app's error mapper
— every such parse uses `safeParse`, and the MCP SDK converts validation failures into
`{content, isError: true}` tool results rather than exceptions — so the error-mapping ground
is explicitly **not** claimed here. The single-copy property is the requirement; `instanceof`
is one reason to need it.

#### Scenario: One zod in the tree
- **WHEN** `npm ls zod --json` output is inspected after install
- **THEN** exactly one resolved copy exists (the property is the resolved-copy count in the JSON output, not the command's exit code — pre-existing unrelated peer-range warnings from other dependencies, including a resolved `zod` major that does not satisfy a third-party peer range, do not fail this gate), and every package declaring `zod` declares it as a peerDependency

#### Scenario: One better-sqlite3 in the tree
- **WHEN** `npm ls better-sqlite3 --json` output is inspected after install
- **THEN** exactly one resolved copy exists, with the L1 packages resolving to it via peerDependency

#### Scenario: Cross-package error identity preserved
- **WHEN** a request fails a contract-package schema, a request triggers a domain-package `ValidationError`, an audio request with an unsatisfiable range triggers the storage package's `InvalidRangeError`, and a dashboard-config write with an invalid config triggers the session-core package's `DashboardValidationError`, each exercised through the real app
- **THEN** the responses are `422`, `400`, `416`, and `422` respectively, exactly as before the split (the `DashboardBoundsError` arm is wire-unreachable defensive code today and is covered by the single-module-instance property rather than a wire pin)

#### Scenario: The design turn's tool schemas survive the package move
- **WHEN** a design turn runs through the real app after the AI runtime moves into its package, with the aggregate MCP server's zod-schema'd tools registered
- **THEN** the tools are recognized and callable, proving the agent SDK and the package resolve the same `zod` copy
