## MODIFIED Requirements

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
it constructs — configuration wiring and the system clock. Companion presence moved to the
storage package's Postgres implementation (core-ports-architecture "Companion presence is shared
by every process", ADR 0021 slice 9d), so no presence module SHALL remain there. Feature
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
- **THEN** it fails if any file other than the composition-root wiring and the system clock is present — a subdirectory is itself a violation, not an exemption, because the layering enumeration compares only top-level directories and would not see a feature accumulating at `server/src/node/<feature>/`

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
