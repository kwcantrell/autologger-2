## Why

The modular-monolith campaign has extracted three L0 packages, three L1 persistence packages,
and three L2 service packages. The AI runtime is the one feature-sized cluster left inside
`server/src` — 13 production modules and 4,048 LOC across two directories — and it is the
cluster the campaign named from the beginning.

It is also the cluster that is *already* built to the rule the package boundary would enforce.
The baseline requires the AI runtime to be Hono-free and injection-fed, and it is: **no
production module under `server/src/ai-runtime/` or `server/src/aiV2/` imports
`server/src/env.ts`, `appEnv`, or anything under `routers/`.** Its entire coupling to the rest
of the app is one import of one string constant. What is missing is not decoupling — it is a
mechanism. Nothing today stops `server/src/ai-runtime/` from importing
`@autologger/transcription`, or from acquiring an undeclared third-party dependency that
resolves through workspace hoisting. The package's buy is **closed-world and prospective**:
any *new* undeclared dependency fails, and the L2 sibling rule becomes enforceable over the
runtime for the first time.

That prospective framing is the honest one, and the artifacts say so rather than overclaiming.
This extraction confines **zero** dependencies today: `@anthropic-ai/claude-agent-sdk`,
`@modelcontextprotocol/sdk`, and `zod` each retain an importer in `server/src` outside the
moving set, so under **step 4's** gate ruling E1 (the repository-wide importer test) all three
stay declared by the server app as well. The baseline's stated rationale for the dependency rule — recording
which feature may reach the network or spawn a process in a manifest rather than a convention
— is achieved here to no degree at all. Only the forward property is bought.

Two standing debts also come due, both named in the durable baselines rather than invented
here. `core-ports-architecture` records the AI runtime's process-group kill ladder as a
**control-flow-bearing `Date.now()` that is explicitly not exemptible**, "owned by the change
that packages the AI runtime, which must give it a Clock port before it can ship in a package."
And `package-architecture`'s interface-only-consumption check walks `server/src` alone — so
moving 13 modules out of it would *silently discharge* the AI runtime's obligation to consume
persistence through facade interfaces rather than concrete classes, unless the check's walk
follows them.

## What Changes

- **New source-only workspace package `@autologger/ai-runtime`** — a fourth L2 service
  package, sibling of `transcription`, `media-import`, and `log-import`, bound by the same
  test-enforced flat rule. It takes the 11 production modules of `server/src/ai-runtime/`
  (3,463 LOC) plus the 2 production modules of `server/src/aiV2/` (`mcpTools.ts`,
  `aggregates.ts`, 585 LOC).
- **`server/src/ai-runtime/` and `server/src/aiV2/` both cease to exist and SHALL NOT be
  re-created**, and both leave the boundary test's server-directory layering enumeration.
  `server/src` is left with `node`, `auth`, `middleware`, `routers`, and `test`. The
  non-recreation half matters: the enumeration is a permission list, so re-adding an entry is
  otherwise the entire cost of re-creating a directory.
- **The cluster's one app-internal production edge is retired by the move.**
  `ai-runtime/aiV2SdkSpawn.ts` imports `AGGREGATE_MCP_SERVER_NAME` — a single string — from
  `aiV2/mcpTools.ts`; both modules land in the same package, in the same dispatch unit.
- **`killProcessGroup` takes a required leading `Clock`**, closing the baseline's named
  standing exception. `killProcessGroup` stays **total** — it must not become throwable.
- **`prepareDesignTurnCredentials` stops calling `homedir()`**; the composition root resolves
  the credential source path into a **required** `Config` field with **no environment
  override**, and the service receives it — mirroring **step 4's** gate ruling E2 on
  `resolveYtDlpPath`.
- **The interface-only-consumption check's walk widens to the service packages**, so the
  facade-only obligation survives the move instead of being discharged by it.
- **Two cheap, unambiguous gate holes are closed**: the server app's own manifest is scanned
  against its `@autologger/*` imports (the hole that already shipped a defect one change ago,
  and which this change re-exposes by hand-adding a dependency), and the service-package
  membership constant gains a **completeness** assertion (today a package omitted from it is
  silently outside all four service checks — demonstrated).
- **Four of the ten AI `.mjs` test fixtures move into the package**, addressed through an
  exported directory constant. Six stay in `server/src/test/fixtures/`, where their only
  readers are.
- **Architecture model updated**: the `aiV2` component is deleted and its files merge into
  `ai-runtime`, whose glob re-points to the package; the `ai-runtime-to-claude-cli`
  relationship's `from` endpoint follows its evidence file; `capabilityScopes` drops `aiV2`.
- **`README.md` and `CLAUDE.md` are updated in the implementation branch**, following the
  immediately-preceding change's precedent. Both currently assert the AI runtime lives at
  `server/src/ai-runtime/`; no gate in the repository reads either file.

**Contract impact: none.** No status code, JSON shape, export body, header semantics, or
WebSocket message or emission changes. The change does, however, edit **router handler
bodies** at five call sites — four supplying `c.env.ports.clock` and one supplying the
credential path. That is port and configuration threading, which the baseline's
"branch diff over routers is import-only" scenario permits only where a change's own delta
explicitly authorizes it; this change's delta does so explicitly rather than relying on
prose. An earlier draft claimed the router diff was import-only, which was false.

## Capabilities

### New Capabilities

None. The AI runtime's behavior is already specified by `ai-topics-chat`,
`ai-v2-dashboards`, `topic-generation`, and `auto-event-generation`; this change alters
where its code lives, not what it does.

### Modified Capabilities

- `package-architecture`: `@autologger/ai-runtime` joins the service-package requirement as a
  fourth named member, and the AI runtime's placement, injection, and Hono-freedom rules move
  **into** that requirement — out of the server-directory-roles requirement, whose title stops
  applying to a package. The service-layer gloss is re-anchored on **membership by enumeration**
  rather than on the AI runtime's former placement. The layering enumeration gains a
  non-recreation rule for the two emptied directories. The interface-only-consumption and
  server-manifest checks are extended, and the layer-graph requirement records both undetected
  directions of declared-edge drift as a named open defect.
- `core-ports-architecture`: the Clock requirement's standing exception for the process-group
  kill ladder is **discharged and removed**, with the injected-clock/real-sleep hang hazard
  stated normatively; host-environment discovery is stated as composition-root work and
  applied to the credential path, with **three** reasoned residuals named rather than one; and
  the `SessionToolPort` re-deferral is recorded where it survives archive.

**Considered and deliberately not included** (see design D7 and the Panel & review log):

- Removing the three unrealized `ALLOWED_LAYER_EDGES` entries and asserting that every declared
  edge is realized. Three panel reviewers touched this and none argued for closing it. The
  delta **names the defect** — both undetected drift directions, and the three standing
  entries — in the layer-graph requirement, so it survives archive as a known open item rather
  than as an oversight; it does not resolve it. Resolving it constrains *when* an allowed edge
  may be added relative to the code that needs it, which is a rule about move atomicity and
  deserves a change that argues it.
- Adding an **empty-component check** to `web-docs`' coverage gate. An earlier draft included
  it and made `web-docs-site` a third modified capability. Three of four panel reviewers
  independently demonstrated it is ill-defined as specified — it fires on seven live
  components that declare no globs by construction — and the failure reviewer demonstrated
  that the only implementable form is *defeated by zero-globbing a component*, which is also
  the route that silences the existing dangling-component check. The property is **already
  normative and review-verified** in the baseline; this change discharges it by review, as the
  baseline requires, and records the demonstrated bypass for whichever change builds the gate.

## Impact

**Moved (13 production modules + 15 test files):** all of `server/src/ai-runtime/` and
`server/src/aiV2/` → `packages/ai-runtime/src/`. Two `*.real.test.ts` files relocate to
`server/src/test/` instead.

**Edited in place:**
- `server/src/routers/{ai,aiV2,events,transcribe}.ts` — import specifiers, plus the five
  authorized port/config threading edits.
- `server/src/routers/{ai,aiV2,events.generate,transcribe}.int.test.ts` — import specifiers
  (which must match the routers' specifiers exactly; four suites spy on module namespaces) and
  the fixture directory constant where a moved fixture is read.
- `server/src/packageBoundaries.repo.test.ts` — service-package membership and its new
  completeness assertion, layering enumeration and non-recreation, allowed-edge deltas, the
  widened interface-only walk, the new server-manifest check, the re-pointed AI-runtime purity
  check, and mutation coverage over the production check functions and production constants.
- `server/src/node/config.ts` and `packages/ports/src/config.ts` — the resolved credential
  source path, as a required field.
- Root `package.json` — the package joins both `&&`-chained test and typecheck runs. This is
  the enumeration whose mis-description produced the previous change's top panel blocker.
- `server/package.json` — a `@autologger/ai-runtime` dependency declaration.
- `web-docs/model/components.ts`, `web-docs/src/lib/extractImports.ts` (`WORKSPACE_REGIMES`),
  and `web-docs/model/edges.snapshot.json`.
- `web/src/pages/index/components/aiV2/clientAggregates.pinning.test.ts` — one path literal.
  The 254-line hand-written mirror itself is untouched.
- `playwright.config.ts` — one path literal, for the one moving fixture e2e reads.
- `README.md` and `CLAUDE.md` — the source-layout narratives.
- Stale path prose across ~10 further files, enumerated by `git grep` rather than by hand.

**Dependencies:** none leaves `server/package.json` (see Why). `@autologger/ai-runtime`
declares `@autologger/{domain,contract,session-core,ports}` — **`ports` included**, because
D3's Clock threading gives five moving modules an `import type { Clock } from
'@autologger/ports'` that the pre-change edge inventory does not show. `zod` is declared as a
`peerDependency`; `vitest` and `typescript` as devDependencies, with the package's `fakeClock`
copy needing a `TEST_INFRASTRUCTURE_EXEMPTIONS` entry landed **ahead of** the file it governs.

**Not affected:** `DATA_DIR` layout, the catalog schema, session DBs, and every published
HTTP/WS surface.

## Non-Goals

- **The `SessionToolPort` interface.** Deferred by step 1's gate ruling D5 to "the AI-runtime
  change" so it could be cut against a real consumer; that consumer (`ai-session-analyst`) was
  deleted as superseded on 2026-08-07 and nothing replaced it. Package extraction does not
  need it — an L2 package importing `session-core`'s facade is a legal L1 edge. This change
  **records the re-deferral in its delta**, because the existing pointer goes false the moment
  this change ships and lives only in an archived `design.md`.
- **The welded route handlers** — `events/generate` (~195 lines), `youtube-import` (~145),
  `topics/generate` (~100), `local-audio-import` (~65), all bound to `Context<AppEnv>` and all
  left undone since step 3's option B. The runtime's coupling to routers is entirely *inbound*,
  so none blocks packaging. Their own change.
- **Moving `aggregates.ts` to a shared L0 home, and retiring `web/`'s 254-line
  `clientAggregates.ts` mirror.** Whether `web/` may depend on the package graph belongs to the
  web-split step. The honest cost of going first: `aggregates.ts` may be moved twice, and its
  `web/` path pin re-pointed twice.
- **An empty-component check in `web-docs`** — dropped at the gate; see Capabilities.
- **`opts.procEnv ?? process.env`** and the `os.tmpdir()`-derived scratch directories.
  Recorded as reasoned residuals rather than closed — see design D4.
- **The `window.AutoLogger_*` bus refactor**, the web split itself, `Config` slicing beyond the
  one credential field, and any handler body beyond the five authorized threading edits.
