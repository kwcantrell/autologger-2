# router-directory-decomposition — Design

## Context

Step 3 of the modular-monolith campaign (steps 1 and 2 archived 2026-08-07). Exploration
and the panel mapped the surface against live `main` (`e3790d6`). Load-bearing facts, as
corrected by the fact-check pass and the panel:

- `server/src/routers/` holds **27 production modules, 7,642 LOC**. 14 construct a `Hono`
  instance; `sessionWs.ts` **registers a route** on the app it is handed (`app.get(...)`)
  without constructing one; `_helpers.ts` is shared HTTP-layer support. The remaining
  **11 are the AI runtime** (3,463 LOC): `aiMcpServer` 1131, `aiV2SdkSpawn` 604,
  `aiChatRunner` 399, `aiV2PendingQuestions` 321, `aiTurnOrchestrator` 193, `aiTurn` 184,
  `aiChatRelay` 184, `eventGeneratePrompt` 188, `topicGenerate` 131, `processGroupKill` 70,
  `aiChatRegistry` 58. All 16 staying production modules import `hono` and/or `appEnv`
  (checked individually) — so this change's new `routers/` membership rule is green on the
  commit that lands it.
- **The AI cluster is a closed subgraph.** Its only outbound edges are `@autologger/*`
  packages, node builtins, the MCP SDK, the Anthropic Agent SDK, `zod`, sibling cluster
  modules, and one app-internal edge: `aiV2SdkSpawn → ../aiV2/mcpTools`. It imports no
  route module, no `_helpers`, no `appEnv`, no `hono`. It is already injection-fed
  (`registry: SessionHubRegistryFacade`, `cliPath`/`maxBudgetUsd`/`timeoutMs` as plain
  values) — with the caveat in the residuals that two modules default `procEnv` to
  `process.env` and one reads `homedir()`.
- **Eight staying files import the cluster, not four**: the route modules `ai.ts`,
  `aiV2.ts`, `events.ts`, `transcribe.ts`, **and four `*.int.test.ts` that stay in
  `routers/`** — `ai.int.test.ts`, `aiV2.int.test.ts`, `events.generate.int.test.ts`,
  `transcribe.int.test.ts`. **All four** use namespace-import spying
  (`vi.spyOn(aiTurnModule, 'driveAiTurn')` ×2, `vi.spyOn(aiV2SdkSpawnModule,
  'attemptDesignTurnSpawn')`, `vi.spyOn(topicGenerateModule, 'generateTopicsTurn')`),
  which works only because test and route module resolve the **same module instance**; and
  `aiV2.int.test.ts` carries a documented **import-order-sensitive** property (nothing in
  the `app` import graph may touch `aiV2SdkSpawn.ts` before that test file's own import
  does). Both must survive the repathing.
- **The move is depth-preserving.** `ai-runtime/` and `routers/` are both direct children
  of `server/src`. Only **four `../` import specifiers** exist across the 24 moving files
  (`../aiV2/mcpTools` ×3, `../env` ×1) — but import-specifier extraction is not the whole
  story: the moving tests also carry **seven `import.meta.url`-relative runtime path
  literals** (six `new URL('../test/fixtures/…', import.meta.url)`, plus
  `aiMcpServer.test.ts`'s self-sibling source pin that reads its subject's source text off
  disk for the zero-`await` invariant test). All eleven resolve identically from either
  directory — but they are a **different failure class** (a wrong path is an ENOENT at test
  time, not a `tsc` error), and they are invisible to specifier extraction. The correct
  statement is: no import specifier and no `import.meta.url`-relative literal in the 24
  files changes meaning, because both directories are children of `server/src`.
- **No production module in the cluster resolves anything relative to its own location** —
  zero `import.meta.url` / `__dirname` / `process.cwd()` across all 11. The CLI subprocess
  cwd, MCP config path, and session-resume keying all derive from `tmpdir()`/`homedir()`.
- **Exactly one external reference is machine-checked**: `web-docs/model/components.ts`'s
  `routers-to-claude-cli` evidence anchor. **Eight prose comments** cite a moving module's
  current path and would go stale silently: `aiV2/mcpTools.ts`, `node/ytdlp.ts` ×4,
  `packages/contract/src/schemas.ts`, plus `routers/aiV2.ts` (a *staying* file) and
  `aiV2SdkSpawn.test.ts` (a *moving* file — `git mv` will not fix it). One is a **semantic**
  rewrite, not a path rewrite: `ytdlp.ts` states that "`routers/aiChatRunner.ts` is
  router-layer" as the recorded justification for a deliberate duplication, and this change
  falsifies that sentence. Separately, `web-docs/model/diagramValidity.ts` records an L1
  diagram-budget rationale characterizing `server/src/routers/` as a flat 64-node
  directory, which this change invalidates (budgets are maxima; no gate fires).
- **`atlas.json` is git-ignored** (`.gitignore:26`); the committed drift artifact is
  `web-docs/model/edges.snapshot.json`, written by `npm run snapshot -w web-docs`.
- **The atlas component model matches root-level `server/src` files by exact-path glob
  lists**, not a wildcard — so a new root file such as `httpError.ts` belongs to no
  component and hard-fails `docs:check` with a coverage orphan plus an unmapped-import
  error, while root `npm test`'s web-docs portion is deliberately tolerant of unmapped
  files and stays green.
- **Nothing imports `TimecodeCtx` from `_helpers`** — the type has zero consumers there,
  so the "re-export for existing consumers" plan would have minted a permanent shim
  serving nobody.
- **The three interface-only bypasses are real, unexploited, and the hardening reds
  nothing.** Every package manifest declares `"./*": "./src/*.ts"`, and
  `packages/session-core/src/index.ts` does `export * from './SessionHub'`, so both the
  subpath and the wildcard forms genuinely resolve to the concrete class. The panel ran
  all four matcher configurations over every `server/src` production file: **zero
  violations, zero wildcard clauses** in every configuration.
- `SERVER_SRC_LAYER_DIRS` is `['node','auth','middleware','routers','aiV2','logImport']`,
  hand-maintained, compared against nothing; `walkTsFiles` swallows a missing directory and
  returns empty, so an enumerated directory that is renamed or emptied passes every
  assertion vacuously. The repo has already lived this — the `db`/`session` entries were
  hand-pruned when those directories emptied, because nothing failed.

## Goals / Non-Goals

**Goals:**

- Retire a published architectural falsehood: give the AI runtime a directory that states
  what it is, and make the atlas stop attributing it to `routers`.
- Retire the `app.ts → routers/` upward edge for the app-level HTTP error class.
- Collapse the duplicate `TimecodeCtx` declaration (step-2 residual).
- Make the rules this change establishes **enforced**, not asserted, and close the
  enumeration-vacuity hole in the existing directory guard.
- Close the interface-only check's bypass classes and give it the mutation coverage it has
  never had, while stating its remaining limits honestly.

**Non-Goals:** see the proposal. In particular this change is **not** justified as a step-4
unblock (gate ruling E1) and does **not** move `aiV2/aggregates.ts` (gate ruling E2).

## Decisions

### D1 — One flat `server/src/ai-runtime/`, not a sub-structured tree

All 11 modules land in one flat directory keeping their filenames. Sub-grouping by role is
deferred: it would put a design opinion inside the mechanical move commit, the exact
diff-hygiene failure steps 1 and 2 legislated against.

*Alternatives:* role sub-directories (churns specifiers twice, adds design to a mechanical
commit); splitting across `ai-runtime/` and `node/` (rejected — D2).

### D2 — `processGroupKill.ts` moves with the cluster, not to `node/`

By taxonomy it is generic Node infrastructure. It moves with the cluster anyway because
`server/src/node/` is app-internal: parking it there would create a cross-boundary edge
that no manifest could legalize if the runtime is ever packaged, and its only two
consumers (`aiChatRunner`, `aiV2SdkSpawn`) both move. **Priced honestly:** the module calls
`Date.now()` directly, which this repo's package rules forbid in package code (`kvStore`
lost its `systemClock` default for exactly this reason) — so it carries a Clock-port debt
recorded in the residuals for whoever packages the runtime.

*Alternatives:* `server/src/node/` (creates the cross-boundary edge); promoting it to a
shared package (over-built for 70 lines with two in-cluster callers).

### D3 — `ApiError` to `server/src/httpError.ts` (app root)

The class is app-level plumbing: `app.onError` maps it to `{detail}` with its `status`, and
every thrower is an app module. Root-level `server/src/*.ts` files are deliberately **not**
nodes in the boundary test's directory graph — composition-root/app-shell, not a layer —
which is the right status for a class shared by the mapper and every router. Placing it
there removes the upward edge without inventing a layer for one class. **The atlas
component model must gain a glob covering it in the same phase** (its root-file coverage is
exact-path lists, so a new root file is an uncovered orphan that fails `docs:check`).

*Alternatives:* leaving it in `_helpers.ts` (keeps the composition root importing upward
through a change whose subject is that directory's shape); a new `server/src/http/`
directory (mints a layering directory and edges from nearly everything, for a 10-line
class); `@autologger/ports`/`domain` (L0 ships no runtime values — step-1 invariant).

**Deliberately not decided here:** whether extracted use-case code should throw `ApiError`
at all. That belongs to the welded-handler change; this move does not constrain its answer.

### D4 — `TimecodeCtx` consolidates onto session-core, with **no** re-export

`routers/_helpers.ts` drops its duplicate `interface TimecodeCtx` and imports the type from
`@autologger/session-core` for its own return annotation. The earlier plan to re-export it
"for existing consumers" is **withdrawn**: the panel established that nothing imports the
type from `_helpers`, so a re-export would be a permanent re-export shim serving nobody —
precisely what this change's own no-shim rule and the step-1 invariant forbid. If a
re-export were ever wanted, `server/tsconfig.json`'s `verbatimModuleSyntax` +
`isolatedModules` would require the `export type { … } from` form. The `timecodeCtx(row)`
function stays in `_helpers.ts`: it takes a `@autologger/catalog` `Row`, so moving it into
session-core would mint a forbidden L1→L1 sibling edge.

### D5 — The durable rules land in `package-architecture`, not a new capability

That capability's purpose already covers the server's modular-monolith decomposition, and
its existing cycle-freedom scenario already reasons over the `server/src` **directory**
graph. A new `server-module-layout` capability would split one layering rulebook across two
homes that the remaining campaign steps would each have to choose between, and would incur
the `docs:check` new-baseline-attachment obligation for no analytical gain.

### D6 — The architecture rules are ENFORCED in the boundary test, in the phase that creates them

This is the panel's most convergent finding: the draft declared `routers/` HTTP-only and the
runtime Hono-free while shipping no mechanism, and the design's own invariants section
conceded that a "convenient" `Context` parameter would undo the change "silently and with
green gates". Three checks land in `packageBoundaries.repo.test.ts` (extended, never
forked), reusing its existing `walkTsFiles`/`extractImportSpecifiers` primitives:

1. **Runtime purity** — no production file under `server/src/ai-runtime/` may import
   `hono`, `hono/*`, a `@hono/*` scoped package, `appEnv`, or anything under
   `server/src/routers/`.
2. **Router membership** — every production module ANYWHERE under `server/src/routers/`
   (recursively, not just its direct children — a subdirectory does not exempt a file from
   this check) must import `hono`/`hono/*`/`@hono/*` or `appEnv` (green today for all 16,
   all direct children). A direct assertion also names the 11 moved AI-runtime basenames and
   fails if any is found anywhere under `routers/`, independent of whether that file happens
   to stay Hono-free — the spec scenario's second conjunct, not merely a transitive
   consequence of check (2).
3. **Enumeration completeness and non-vacuity** — `SERVER_SRC_LAYER_DIRS` must match the
   production directories present under `server/src` (modulo a named exemption list), and
   each enumerated directory must be non-empty. Without (3), a later rename leaves a stale
   entry and the whole cluster silently drops out of the acyclicity guard.

Checks 1 and 2 are the enforcement the change owed; check 3 is what makes the requirement's
"forecloses" language true rather than aspirational.

**Residual bypasses (matching D7's posture — stated, not closed).** All three checks are
textual scans over source, same as every other check in this file — not a real TS parser,
not a runtime trace. A module that reaches a forbidden dependency through a dynamic
`require` obtained via `createRequire`, through `eval`/`Function`-constructed code, or by
laundering the import through a third module (one that itself imports the forbidden
specifier and re-exports what it needs) is invisible to a specifier-text scan and is not
caught by these checks. This was demonstrated during the phase-2 review: a probe file
reaching `hono` through `createRequire(import.meta.url)('hono')` passed check (1)
unflagged. The property these checks enforce is therefore "no plain import-syntax path to
the forbidden dependency," not "no possible path at runtime" — the same scope the spec
scenarios describe (they say the boundary repo test fails on an *import*, not on any
reachable dependency). Closing the remaining shapes would mean a real parser or a runtime
trace, which is out of scope for a dependency-free repo-invariant guard.

### D7 — Interface-only hardening: three shapes closed, remaining limits stated

Inside `checkInterfaceOnlyConsumption`: match the package by **specifier prefix**; widen the
clause regex from `\bimport\b` to `\b(?:import|export)\b`; and reject **wildcard clauses**
against the concrete-bearing packages outright. The third was found independently by three
reviewers and matters most: `import * as sc from '@autologger/session-core'` then
`sc.SessionHub` names no identifier in the clause, and it is the form a contributor writes
by *accident* — unlike a deep-subpath import, which nobody writes unintentionally. The
general `extractImportSpecifiers` needs no change (it already matches both keywords and
serves the other four checks) — task 4.2 requires *verifying and recording* that, because
fixing an already-closed hole is its own defect.

The delta no longer claims shape-independent detection. It is a textual scan; dynamic
`import()`, `createRequire`, laundering via `server/src/test/**` or a third re-exporting
package, and code outside the walked root all remain open and are **recorded as residual
bypasses**. Over-claiming here would mint exactly the false-ground-truth baseline the
campaign keeps tripping over.

The check also gains the **synthetic-tree mutation coverage** it has never had — it is the
only check in that file without any, its lone live-tree assertion passes just as happily
when the check has gone vacuous, and this change reshapes it. A concrete vacuum mode: writing
`\b(import|export)\b` (capturing) instead of `(?:…)` shifts the group indices so the
specifier test reads clause text, never matches, and the check silently always passes.

*Alternatives:* eslint/dependency-cruiser (step-1 invariant forbids forking); deferring
again (the file is already open); keeping the property claim (ships a false baseline).

### D8 — Atlas: a new component, and the relationship's **`from` endpoint** moves

`web-docs/model/components.ts` gains an `ai-runtime` component globbing
`server/src/ai-runtime/**`, plus coverage for the new root-level `httpError.ts`. Critically,
the `routers-to-claude-cli` relationship's **`from` must change to `ai-runtime`** (and its
id renamed accordingly) — not merely its evidence anchor. `checkRelationshipEvidence`
verifies only that the evidence file exists and contains the literals, never that it belongs
to the `from` component, so re-anchoring alone passes green while the atlas keeps asserting
that `routers` spawns the Claude CLI — the precise falsehood this change exists to retire.
The delta pins the `from`-endpoint property because the gate cannot.

The regenerated snapshot is `web-docs/model/edges.snapshot.json` (not the git-ignored
`atlas.json`), reviewed **per edge with attribution**. The delta is larger than the two
directory edges: component-level, `ai-runtime` gains edges to `session-core`, `contract`,
and `domain`, plus `test`-kind edges (to `ports` and `server-core`), plus `routers →
ai-runtime` tagged `production`. `projectComponentEdges` emits exactly **one** edge per
`(from, to)` component pair — `production` if any underlying import is production-origin,
else `test` — so a pair never carries both kinds simultaneously; verified by reading the
function directly, not assumed. No `routers → X` package edge vanishes (every one is still
imported by a staying router).

Widening the existing `routers` glob to cover both directories was rejected: it would keep
the atlas asserting the runtime is a router.

## Invariants a future reader must not "helpfully" undo

- All step-1 and step-2 invariants remain in force (single process; hub RPCs synchronous and
  transactional; `create_event` handler zero-`await`; facades property-style function types;
  `appEnv.ts` names zero concrete persistence classes; `node/config.ts` sole production
  namer; `createCatalog` + `init()` per-request; L1 siblings; no permanent re-export shims;
  int tests stay in `server/src/`).
- **`server/src/ai-runtime/` must not acquire a `hono` or `AppEnv` import** — now enforced
  by the boundary test (D6), not merely asserted. Do not weaken that check.
- **The layering enumeration must stay complete and non-vacuous** (D6 check 3). Deleting it
  restores the hole where a renamed directory silently leaves the guard.
- `processGroupKill.ts` stays with the runtime (D2).
- `ApiError` stays at app root and out of `routers/`; `_helpers.ts` must not reacquire a
  declaration of it or of `TimecodeCtx`, or a re-export of either (D4).
- The interface-only check's prefix match, `import|export` scan, and wildcard rejection are
  each load-bearing; its **stated residual bypasses are deliberate honesty**, not a TODO to
  quietly delete (D7).
- The `claude-cli` relationship's `from` endpoint must remain the runtime component (D8) —
  the evidence gate cannot catch a regression here.
- This change edits **no handler body**. A reader looking here for the seam between HTTP
  adaptation and use-case logic will not find it; that is a separate change, and its absence
  is deliberate.

**Not an invariant (gate ruling E3):** the directory *name*. `ai-runtime` is a recorded
naming preference, chosen so a future package extraction needs no rename. It is not
load-bearing — renaming costs a directory move plus eight import lines — and the earlier
draft's "must not rename" invariant defended a cost this change elsewhere treats as trivial.

## Risks / Trade-offs

- [A 24-file move diff visually masks a semantic edit] → mechanical `git mv` + import
  rewrites land as their own commit; semantic edits land narrow and separate.
- [Location-sensitive behavior breaks silently] → **probed and largely retired**: zero
  `import.meta.url`/`__dirname`/`process.cwd()` in all 11 production modules; the eleven
  location-bearing paths in the moving tests are all depth-invariant; no `vi.mock` names a
  relative path to a moving module; tooling (vitest tiers, tsconfig, biome,
  `fixtures:capture`) is filename- or prefix-shaped, never directory-enumerating.
- [Namespace-spy tests detach from their subject after repathing] → task 2.3 re-verifies
  that each spying int test and its route module resolve the identical specifier, and
  re-reads `aiV2.int.test.ts`'s import-order comment for continued truth.
- [`ApiError`/singleton dual-instance] → **structurally foreclosed, verified**: no `paths`
  in `server/tsconfig.json`, no vitest alias, extensionless specifiers under
  `moduleResolution: "Bundler"`, one workspace, and no shim window. The
  `crossPackageErrorIdentity` hazard arises from npm dual-install across a *package*
  boundary, which an intra-`server/src` move cannot reach — so **not** extending that test
  is correct, not an oversight. Same reasoning covers `aiChatTurns`, the MCP listener
  singleton, and `aiV2PendingQuestions`: a missed importer is a compile error, never a
  second copy.
- [`docs:check` red mid-branch] → two ordering defects the panel caught are fixed in the
  plan: the snapshot regenerates **with** the component-model edit (before `docs:check` is
  asserted), and phase 3 carries its own atlas-coverage task and `docs:check` gate for the
  new root-level `httpError.ts`.
- [The hardened check reds a gate on a pre-existing violation] → **empirically retired**:
  four matcher configurations over every `server/src` production file found zero violations
  and zero wildcard clauses. Task 4.1's probe is expected to find nothing; a surprise is a
  finding to fix, never a reason to weaken the check.
- [The widened regex false-positives on prose] → it is a raw-text scan with no
  comment/string stripping, so a comment *documenting the rule* (quoting
  `export { SessionHub } from '@autologger/session-core'`) would red the gate. Never
  document the rule inline in a `server/src` production file; task 2.7 edits comments in
  such files, so this is live.
- **Residuals (new):** `processGroupKill.ts`'s direct `Date.now()` (Clock-port debt for
  whoever packages the runtime); `aiChatRunner`/`aiV2SdkSpawn` default `procEnv` to
  `process.env` and `aiV2SdkSpawn` reads `homedir()` — injection-with-ambient-default, which
  the spec's import-specifier scenario cannot see; `topicGenerate.real.test.ts`'s `../env`
  import would become a package→app escape if the runtime is ever packaged (step-2's
  precedent is relocating such tests to `server/src/test/`); the interface-only check's
  stated residual bypasses (D7); a **component-level cycle this branch introduced**: the
  atlas's `routers → server-bootstrap` edge flips from `test`-kind to `production`-kind
  because the 11 production routers that throw `ApiError` now import `./httpError` (globbed
  into the `server-bootstrap` component), and paired with the pre-existing
  `server-bootstrap → routers` edge (`app.ts` wiring the router modules), the component
  graph now has a production cycle between them. The *file-level* import graph stays acyclic
  — `httpError.ts` imports nothing, so it introduces no file-level edge back into
  `routers` — and no web-docs gate checks component-level acyclicity, so nothing is red. But
  a stated Goal of this change was retiring an upward `routers` edge, so trading a
  router→AI-runtime-cluster falsehood for a new component-level `routers`↔`server-bootstrap`
  cycle is a trade worth stating honestly rather than leaving implicit. The alternative a
  future change could take is re-homing `httpError.ts` out of the `server-bootstrap`
  component glob (into its own atlas component, or one that doesn't already hold an edge
  back into `routers`) — not attempted here; D3 already ruled out inventing a new directory
  for a 10-line class, and this residual doesn't reopen that call, only records its
  component-graph cost; **`checkApiErrorHome`'s stated bypasses** (final-review fix wave,
  matching D6/D7's stated-not-closed posture): a two-step launder — a `routers/` file
  re-exports `ApiError`, and a second file reaches it through a namespace import of that
  re-exporting module (`import * as helpers from './routers/_helpers'; helpers.ApiError`) —
  defeats both halves of the check, since the class is declared once at app level (satisfying
  the positive assertion) and the import clause never names the `ApiError` identifier (only
  the namespace binding). Unlike the sibling `checkInterfaceOnlyConsumption` (D7), which
  closes the analogous hole by rejecting wildcard/namespace clauses outright, that treatment
  is deliberately not mirrored here: D7's targets are two specific concrete-bearing packages
  that legitimate code has no reason to namespace-import at all, while a namespace import of
  an ordinary `server/src` module such as `./routers/_helpers` is plausibly legitimate code in
  this repo, so a blanket rejection risks a false positive on honest code rather than closing
  a real gap. Also unreached: an aliased re-export chain (re-exporting the class under a
  different local name at each hop) and a dynamically-constructed import specifier. And the
  widened class-declaration regex is a raw-text scan with no comment/string stripping, so a
  prose comment in a routers file that spells either declaration form — even while documenting
  this very rule — would red the gate on a false positive, the same hazard class already
  documented for the interface-only check's widened clause regex.
- **Residuals (carried):** the welded handler bodies; `aggregates.ts`'s undecided home;
  `Config`'s 31-field slice; `jobStore.ts` `pruneJobs` `Date.now()`; the facade new-member
  asymmetry; the SDK zod-4 peer `ELSPROBLEMS` environmental fact.

## Migration Plan

Phased within one change, each phase green on `npm run typecheck` + `npm test`:
gated-artifacts commit → AI-runtime move + import rewrites (8 files) + the three new
boundary checks + `SERVER_SRC_LAYER_DIRS` entry + atlas component/`from`-endpoint/snapshot
+ stale-comment sweep → `httpError.ts` (with its atlas coverage) + `TimecodeCtx`
consolidation → interface-only hardening + mutation coverage + demonstrated negative cases
→ docs/full gates. Rollback is `git revert` **at a phase boundary** — intra-phase reverts
are not clean (reverting the move without the atlas edit leaves a missing-evidence failure;
reverting the atlas edit alone leaves coverage orphans).

## Open Questions

- Whether the re-attributed capability entries should name `ai-runtime` **in addition to**
  `routers` or **instead of** it, per capability. Resolve at the atlas task with the current
  attachment list in hand; the spec pins only that no component may attribute the runtime's
  files to `routers`.
- Whether renaming the relationship id `routers-to-claude-cli` → `ai-runtime-to-claude-cli`
  is worth the snapshot/nav churn, or whether moving `from` alone suffices. The id appears
  only in `components.ts` and the generated atlas — no nav-id or authored diagram references
  it — so the rename is safe but optional. Settle at task 2.5.

*(Closed at the gate: the `TimecodeCtx` re-export question — the answer is "no re-export",
since the type has zero consumers in `_helpers`. Folded into D4.)*

## Panel & review log

- **2026-08-07 — pre-panel fact-check pass (light-tier reviewer, against live `main`
  `e3790d6`):** 33 checkable claims enumerated as properties; **32 CONFIRMED**, **1
  CORRECTED**, 0 failed, 9 recorded as judgment-laden and passed to the panel **un-vouched**
  (D1's flat-directory rationale, D2's self-containment trade, D3's `ApiError`
  characterization, D4's `timecodeCtx` characterization, D5's capability-fold, D6/D7's
  framing, the atlas Open Question, the Non-Goals, and the forward-looking "makes step 4 a
  `git mv`" claim). Verified exhaustively via per-file import-specifier extraction **using
  the boundary test's own regex**: the cluster imports no route module, `_helpers`, `appEnv`,
  or `hono`; its only app-internal edge is `aiV2SdkSpawn → ../aiV2/mcpTools`; and only four
  `../` import specifiers exist across the 24 files. Both boundary bypasses confirmed real
  and exploitable; neither exploited on `main`; `extractImportSpecifiers` confirmed already
  correct. The `core-ports-architecture` MODIFIED block was diffed against the baseline —
  header identical, all seven pre-existing scenarios preserved word-for-word.

  **Correction folded:** "exactly one hand-maintained external reference" was too strong for
  its own stated scope; five prose comments also cite moving paths. (The panel later raised
  this to **seven** — itself an undercount, since the sites it enumerated total **eight**;
  the arithmetic slip survived the consistency read and was caught during apply — and found
  one to be a semantic rather than path staleness. See below.)

  **Warrant correction (recorded by the panel):** the pass's exhaustiveness conclusion —
  "depth-preservation holds with no exceptions" — rested on *import-specifier* extraction,
  a method that structurally cannot see `import.meta.url`-relative runtime path literals,
  which are the class of thing a file move most often breaks. Seven such literals exist in
  the moving tests. All are depth-invariant, so the conclusion survives; the *method* did
  not support the breadth claimed, and the design now states the stronger property directly.

- **2026-08-07 — adversarial panel (4 reviewers: requirements / assumptions / failure &
  abuse / scope; heavyweight tier, distinct mandates, skeptical calibration; empirical
  probes run with the repo's own toolchain).** Three of four returned "do not gate as-is",
  converging on one root cause: **the plan was sound and the spec was not** — the change
  declared enforcement it did not ship.

  **Blockers/majors fixed in place:**
  - *Rules asserted, not enforced* (all four reviewers, independently). The ADDED
    requirement said "enforced" and "which is the failure this requirement forecloses" while
    shipping a hand-maintained array and zero checks; the design's own invariants conceded a
    `Context` parameter would undo the change "silently and with green gates" → three
    boundary-test checks added (D6), scenarios rewritten to name the test rather than
    "inspection".
  - *Enumeration vacuity* (assumptions reviewer). `walkTsFiles` swallows a missing
    directory, so an enumerated-but-renamed directory passes every assertion with zero files
    — and the repo already hand-pruned `db`/`session` for exactly this reason → completeness
    + non-vacuity check added (D6 check 3).
  - *A third bypass survives the hardening* (requirements, assumptions, and failure&abuse
    independently; assumptions and failure&abuse each ran the prescribed matcher and
    demonstrated it). `import * as sc from '@autologger/session-core'` → `sc.SessionHub` and
    `export * from …` name no identifier in the clause, and the barrels export the concrete
    classes as values → wildcard rejection added, plus a scenario; and the delta's
    "detect by the property, not one textual shape" claim **withdrawn** in favour of stating
    the shapes defeated and recording the residual bypasses (D7).
  - *No mutation coverage on the one check being reshaped* (failure&abuse). It is the only
    check in the file without a synthetic-tree test, with a concrete vacuum mode (a
    capturing group shifts indices so the specifier test reads clause text and never
    matches) → mutation-coverage requirement and scenario added.
  - *Atlas keeps asserting the falsehood* (requirements, assumptions, failure&abuse).
    `checkRelationshipEvidence` never checks that the evidence file belongs to the `from`
    component, so re-anchoring alone passes green with `from: 'routers'` intact → D8 now
    moves the `from` endpoint; a spec scenario pins it, since the gate cannot.
  - *Two phase-ordering defects* (failure&abuse). Task 2.5 verified `docs:check` before task
    2.6 regenerated the snapshot it diffs against (guaranteed red); and phase 3 introduced
    root-level `httpError.ts` with no atlas coverage — root files are matched by exact-path
    glob lists, so it is an orphan that hard-fails `docs:check`, while root `npm test` is
    tolerant of unmapped files, making the breakage **invisible for two phases** → both
    orderings fixed, phase 3 gains an atlas task and a `docs:check` gate.
  - *Edit set under-counted 2×* (all four). Four staying `*.int.test.ts` import the cluster,
    and the proposal listed int tests under **Unchanged** — which is what the layered audit
    uses to scope its package, so they would have been scoped out by construction. Two hold
    namespace-import spies requiring same-module-instance resolution, and `aiV2.int.test.ts`
    documents an import-order-sensitive property → corrected to eight files everywhere, with
    a re-verification sub-step. (The panel said "two" of the four hold namespace spies; the
    consistency read corrected this to **all four** — an undercount of exactly the kind the
    same finding warns about.)
  - *"Exactly the edges" false* (all four). `routers → aiV2` survives via `routers/aiV2.ts`;
    task 2.4 was unsatisfiable as literally worded → scoped to edges **incident to**
    `ai-runtime`; the design now enumerates the larger component-level snapshot delta that
    task 2.6's blocking rule must attribute.
  - *The central promise was not pinned* (requirements). "The delta pins it" was false — the
    scenario only required suites to pass, which a behavior-preserving handler rewrite
    satisfies → diff-shape scenario added.
  - *`TimecodeCtx` re-export serves nobody* (requirements). Zero modules import it from
    `_helpers`, so the planned re-export would be the permanent shim the change forbids →
    D4 rewritten, Open Question closed.
  - *Stale-comment inventory 5 → 8* (the panel said seven and enumerated eight; the arithmetic slip survived the consistency read and was caught at apply), one of them semantic (`ytdlp.ts`'s "router-layer"
    rationale becomes false, so a path rewrite leaves a wrong sentence); plus
    `diagramValidity.ts`'s directory-characterizing rationale.
  - *Factual corrections:* `sessionWs.ts` **registers a route** (`app.get`) — three artifacts
    said it registered none; `atlas.json` is git-ignored and the committed snapshot is
    `model/edges.snapshot.json`; visual baselines were regenerated **2026-08-07** (`d23e8b9`,
    44 PNGs), not "current as of 2026-07-14".
  - *Risk retired empirically:* four matcher configurations over every `server/src`
    production file → zero violations, zero wildcard clauses. Added instead: the widened
    regex is a raw-text scan, so a comment quoting the forbidden form reds the gate.

  **Escalated to the gate (with decisions, 2026-08-07):**
  - **E1 — the step-4-unblock justification.** The scope reviewer demonstrated ten of eleven
    modules are extractable to a package today straight out of `routers/`, and that an
    intermediate directory *adds* churn a package extraction would undo (double import
    rewrite, a `SERVER_SRC_LAYER_DIRS` entry added-then-deleted, an atlas component
    added-then-converted). **Gate ruling: re-justify on honest grounds** — the published
    atlas falsehood, the upward error-class edge, and the step-2 duplicate. The unblock
    framing is struck from the proposal and the design.
  - **E2 — the `aggregates` Non-Goal's rationale.** Its stated blocker (a six-level relative
    dynamic import) is one line guarded by two gates, so the Non-Goal rested on a
    non-obstacle. **Gate ruling: keep the boundary, replace the rationale** — `aggregates.ts`
    is hand-mirrored into `web/clientAggregates.ts`, so its correct home is a shared package
    only step 5 can determine, and burying it in an AI-runtime directory would prejudge that.
    (Rejected: folding `server/src/aiV2/` into the move, which would zero out the app-internal
    edge but override the change's stated scope.)
  - **E3 — directory naming.** `ai-runtime` would be the only kebab-case directory under
    `server/src`, and naming for a package that may never ship as designed echoes step 1
    deferring `SessionToolPort` for want of a real consumer — whose shaping consumer was
    later deleted. **Gate ruling: keep `ai-runtime`, drop the "must not rename" invariant** —
    it defended a cost the change elsewhere treats as trivial. Recorded as a naming
    preference, not an invariant. (Rejected: renaming to `aiRuntime/` for casing consistency.)
  - **E4 — Phase 4 bundling.** The scope reviewer argued the interface-only hardening is a
    step-2 persistence-facade residual, topically unrelated, costing a second capability
    delta and a full-tier review for unexploited bypasses. **Gate ruling: keep it, re-tier
    the review** — the new enforcement checks (D6) land in the same file, so the bundle is
    now genuinely cohesive; the full-tier review budget moves to **phase 2**, which creates
    the invariant that would otherwise fail silently, while phase 4 defers to the
    whole-branch audit. (Rejected: cutting it to a separate change.)

  **Minors accepted as residual:** `processGroupKill`'s `Date.now()` Clock debt;
  injection-with-ambient-default (`procEnv ?? process.env`, `homedir()`);
  `topicGenerate.real.test.ts`'s `../env` as a future package escape; the interface-only
  check's stated residual bypasses (dynamic `import()`, `createRequire`, `server/src/test/**`
  laundering, third-package re-export, code outside the walked root); `diagramValidity.ts`
  staleness; the delta file's header style differing from archived precedent.

  **Clean bills worth recording** (probed with evidence — phase reviewers need not
  re-litigate): `ApiError` and every moving singleton are structurally single-instance (no
  `paths`, no alias, no shim window; the `crossPackageErrorIdentity` hazard is npm
  dual-install across a package boundary and unreachable here — so not extending that test is
  correct); zero path-derived runtime behavior in all 11 production modules; all eleven
  location-bearing paths in the moving tests are depth-invariant; test discovery cannot drop
  the moved tests (pure globs); `.gitignore` cannot shadow the new directory and
  `forceConsistentCasingInFileNames` covers the case-insensitive-FS hazard; no `vi.mock`
  names a relative path to a moving module; the security lockdown (loopback bind, per-turn
  bearer, principal binding, env whitelist, kill ladder) moves as one unit and no guard is
  separated from what it guards; the `Facade`-suffix word-boundary argument survives
  prefix-matching; diagram budgets have headroom and `slugifyComponentId` already handles
  hyphenated ids; cross-workspace path pins all target staying files; task 2.4's ordering is
  correct on the merits (an unenumerated directory is invisible to the guard, not red); the
  `routers/` HTTP-layer claim is factually true post-move (all 16 stayers checked
  individually); and the two `*.real.test.ts` files skip but are still *collected*, so their
  imports are runtime-verified.

- **2026-08-07 — post-gate consistency read (light-tier reviewer over all five final
  documents — proposal, design, tasks, and both delta specs — cross-checked against both
  baselines and the live repo):** **one finding**, corrected in place: the panel's
  "**two** of those tests hold namespace-import spies" was an undercount — **all four**
  staying `*.int.test.ts` spy on a moving module's namespace (`aiTurnModule` ×2,
  `aiV2SdkSpawnModule`, `topicGenerateModule`), verified against the live files. Fixed in
  `proposal.md` and `design.md`; `tasks.md` was already correct, naming the three spied
  identifiers without a file count.

  Everything else verified consistent: no stale pre-decision language survives (no
  step-4-unblock framing outside the E1 narrative, no path-pin rationale, no "must not
  rename" invariant, no `TimecodeCtx` re-export, no `atlas.json`-as-committed-snapshot, no
  "detect by the property" over-claim); the module arithmetic reconciles (27 − 14
  Hono-constructors − `sessionWs.ts` = 12 registering nothing, of which 11 move); every
  `D1`–`D8` and `E1`–`E4` citation across proposal/specs/tasks resolves to a decision that
  says what the citation implies (D-numbers were renumbered during fold-back); baseline
  fidelity re-confirmed after the post-fact-check edits — header verbatim, all seven
  pre-existing scenarios word-for-word in original order, exactly four deliberate additions;
  bidirectional task/spec coverage holds with no orphans either way; task numbering is
  contiguous; and both repaired ordering defects hold (task 2.7 regenerates the snapshot
  before asserting `docs:check`; task 3.2 adds `httpError.ts` atlas coverage before gate
  3.4 runs it). Spot-checks re-confirmed against the live repo: `sessionWs.ts`'s `app.get`,
  the git-ignored `atlas.json` vs tracked `edges.snapshot.json`, zero `TimecodeCtx`
  consumers in `_helpers`, all 11 moving modules present, `SERVER_SRC_LAYER_DIRS`'s exact
  contents, the three-bypass characterization of `checkInterfaceOnlyConsumption`,
  `extractImportSpecifiers`'s existing `import|export` alternation, all seven stale-comment
  sites (including `ytdlp.ts`'s semantic-not-path rewrite), the `ApiError` importer counts
  and both `instanceof` sites, and the pre-move `from: 'routers'` on the claude-cli
  relationship. Also noted (no inconsistency, worth knowing at apply): four of the 13 moving
  test files are non-obviously named (`aiMcpGenerationRendering`, `aiV2DesignTurnOptions`,
  `aiV2DesignTurnRunner`, `aiV2ErrorScrubbing`), and `aiTurn.ts`, `aiTurnOrchestrator.ts`,
  `aiChatRegistry.ts`, and `processGroupKill.ts` have no dedicated test file.
