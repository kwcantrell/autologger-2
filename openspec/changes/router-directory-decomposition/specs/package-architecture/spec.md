## ADDED Requirements

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
