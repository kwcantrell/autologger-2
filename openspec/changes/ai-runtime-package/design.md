## Context

Four campaign steps have built a three-layer package graph enforced by
`server/src/packageBoundaries.repo.test.ts`: L0 (`domain`, `contract`, `ports`), L1
(`session-core`, `catalog`, `storage`), and L2 service packages (`transcription`,
`media-import`, `log-import`). `router-directory-decomposition` separately lifted the AI
runtime out of `server/src/routers/` into `server/src/ai-runtime/` and made three
directory-role rules executable. This change adds the fourth service package and empties the
last two feature-bearing directories under `server/src`.

**Current state, established by import-specifier extraction over the whole repository**
(`server/src`, `server/scripts`, `web/src`, `web-docs`, `companion/src`, `e2e`, `packages`,
root config), by path-literal search, and by moved-symbol search — the three instruments the
campaign learned to run together after its edit set was under-counted four times, each by a
different one's blind spot. This change's panel found a **fourth** blind spot: normative prose
in `README.md`/`CLAUDE.md`, which no gate reads and no code instrument sees.

```
server/src/ai-runtime/   11 prod files  3463 LOC   13 test files  6299 LOC
  aiMcpServer · aiChatRunner · aiChatRelay · aiChatRegistry · aiTurn ·
  aiTurnOrchestrator · aiV2SdkSpawn · aiV2PendingQuestions · topicGenerate ·
  eventGeneratePrompt · processGroupKill

server/src/aiV2/          2 prod files   585 LOC    2 test files   707 LOC
  mcpTools.ts   — AI-runtime code misfiled under a feature codename
  aggregates.ts — pure computation, type-only imports
                         ─────────────────────────────────────────────────
                         13 prod / 4048 LOC        15 test / 7006 LOC
```

The cluster's outbound edges **as they will be after this change** — the pre-change snapshot
is not the right inventory, because D3's Clock threading adds an edge the current tree does
not have, and an earlier draft priced the manifest off the snapshot and was wrong:

```
workspace   @autologger/session-core (L1) · @autologger/domain (L0) · @autologger/contract (L0)
            @autologger/ports (L0)   ← ADDED BY D3: `import type { Clock }` in 5 moving modules
3rd-party   @anthropic-ai/claude-agent-sdk · @modelcontextprotocol/sdk · zod
node:       child_process · path · os · fs · crypto · readline · net · http
app         ai-runtime/aiV2SdkSpawn.ts:52  →  aiV2/mcpTools.ts   ← the ONLY one
```

That last edge imports **one string**: `AGGREGATE_MCP_SERVER_NAME = 'autologger-aggregates'`,
used at `aiV2SdkSpawn.ts:231` to key the SDK's `mcpServers` map and at `:253` to build the tool
wire prefix. It is a **value** import, and two moving *test* files carry it too — which is why
the two directories cannot move in separate dispatch units (D8).

**No production module in either directory imports `server/src/env.ts`.** The only `../env`
import in the whole cluster is in `topicGenerate.real.test.ts:37`. The AI runtime is already
injection-fed to the letter of the requirement that says it must be; what it lacks is a
mechanism that keeps it that way — and, as the panel found, moving it *removes* one mechanism
it currently has (D9).

**Constraints inherited and verified, not re-derived:** frozen HTTP/WS contract; single Node
process; hub RPCs synchronous and transactional; `create_event`'s handler zero-`await`;
boundary enforcement lives in `packageBoundaries.repo.test.ts` (extended, never forked) with
deltas landing in the phase that needs them; the flat service rule needs all four of its
checks; the service-layer definition is a gloss, never a universal quantifier;
`server/src/node/` membership is pinned by name, recursively; facades stay property-style
function types; L1 and L2 siblings never import each other; integration tests stay under
`server/src/`; packages never import the app harness; `fakeClock` duplicate-per-package is
final policy and each copy needs a `TEST_INFRASTRUCTURE_EXEMPTIONS` entry landed **ahead of**
the file; fixture constants live in their own `fixturesDir.ts` re-exported from the barrel and
every reader uses it including in-package tests; single-copy gates parse `npm ls --json`
because exit codes lie; the package test and typecheck enumeration is **root `package.json`**,
not `server/vitest.config.ts`; `web-docs` is a production drift consumer of any module move,
and an unenrolled package's edges vanish from it silently with `docs:check` green.

## Goals / Non-Goals

**Goals:**

- `@autologger/ai-runtime` as a fourth L2 service package, bound by the same four-check flat
  rule as its three siblings, with its independence a test-enforced property.
- `server/src` reduced to `node`, `auth`, `middleware`, `routers`, `test`, with the two
  emptied directories barred from re-creation rather than merely vacated.
- The baseline's named, non-exemptible `Date.now()` exception discharged — without making
  `killProcessGroup` throwable, which would be a real lifecycle regression (D3).
- The facade-only obligation preserved across the move rather than discharged by it (D9).
- Two cheap, unambiguous gate holes closed, both directly exercised by this change (D7).
- The service-layer gloss preserved through the removal of the example it rests on, by
  re-anchoring it on a **definition** rather than a substitute example (D6).

**Non-Goals:**

- `SessionToolPort` (D5), the welded route handlers, the web split, `aggregates.ts`'s eventual
  shared home, `Config` slicing beyond one field, and any handler body beyond the five
  authorized threading edits.
- An empty-component check in `web-docs` — dropped at the gate (D7).
- `opts.procEnv ?? process.env` and the `os.tmpdir()` scratch directories (D4).
- Any observable behavior change.

## Decisions

### D1 — One package for both directories; `server/src/aiV2/` does not survive

`@autologger/ai-runtime` takes all 13 production modules.

**Why L2 is not a matter of taste.** `aiTurn.ts`, `aiMcpServer.ts`, `topicGenerate.ts`,
`mcpTools.ts`, and `aggregates.ts` all import `@autologger/session-core`. L0 is therefore
illegal, and the L1-sibling rule forbids L1. **L2 is the only legal placement.** This is a
different situation from `media-import`, which sits at L2 "by role" precisely because it has
no workspace edges at all; citing that precedent here would obscure a forced conclusion as a
judgment call.

**Why one package and not two.** Splitting the analytics/tool surface (`mcpTools`,
`aggregates`) from the subprocess runners is not merely worse, it is **foreclosed by the rule
this change is joining**: `aiV2SdkSpawn → mcpTools` would become an L2→L2 edge. Recovering
would require either injection surgery (below) or demoting the analytics package, which its
`session-core` import forbids at L0 and the sibling rule forbids at L1.

Alternatives priced:

**Move only the 11, break the edge by relocating the constant.** Smallest possible change.
Rejected because it **inverts the constant's ownership** — the name is declared by the module
that builds the server it names, and its doc-comment exists to contrast it with
`aiMcpServer.ts`'s `'autologger'` — in order to leave behind a misfiling the previous change
already diagnosed.

**Split the pair — `mcpTools` in, `aggregates.ts` left in the app.** Illegal: the package would
import the app. Recoverable only by injecting the six aggregate functions into
`buildAggregateMcpServer`, which converts a visible import edge into exactly the
injection-shaped coupling D1 of the previous change had to state as unclosable. Worse on both
axes.

**`aggregates.ts` to a new shared L0 package** (with or without `web/` importing it).
Technically clean — its dependencies are three pure row DTOs and `EventRpc`. Rejected here
because `aggregates.ts` has **exactly one production consumer**, `mcpTools.ts`, and `web/`'s
`clientAggregates.ts` is a hand-written *mirror* — a duplication, not a dependency; and
because whether `web/` may depend on the package graph belongs to the web-split step.
`web-docs`' own `@autologger/*` imports are **not** precedent: it visualizes the architecture,
it does not participate in it. **The honest cost of this deferral, which the draft omitted:
`aggregates.ts` may be moved twice and its `web/` path pin re-pointed twice.**

**Do not package at all — add the missing checks where the code already lives.** The
proposal's own Why sets this up ("what is missing is not decoupling — it is a mechanism"), and
the previous change's gate ruled that a missing alternative must be *recorded with its price*.
Priced:

| | checks-only | this change |
|---|---|---|
| files moved | 4 (`aiV2/*` → `ai-runtime/`, to kill the app-internal edge) | 28 + 4 fixtures |
| new test code | ~35–50 lines reusing existing primitives | scaffold + membership + completeness + mutation |
| package scaffold | none | manifest, tsconfig, barrel, `fixturesDir.ts`, fakeClock + exemption |
| root manifest | none | test + typecheck chains |
| fixture split (D2) | evaporates | 4 moves + constant + staying-side readers + playwright |
| `web-docs` | one glob edit | component delete, re-glob, relationship endpoint, regime, snapshot |
| modified capabilities | 1 | 2 |

**Not adopted.** A directory allowlist confines only the dependencies you thought to name; a
manifest is closed-world, and closed-world is the one property this change actually buys. Step
3's gate ruling E1 separately struck intermediate directories as double churn, and packages are
the campaign's declared terminal state. Recorded here because the gate before this one required
it, not because it is close.

Consequences that must be scheduled, not discovered:

- Two directories leave `SERVER_SRC_LAYER_DIRS`, each with an `enumeratedButEmpty` ordering
  trap. Removal lands in the unit that empties the directory.
- Because the enumeration is a **permission list**, removing an entry does not prevent
  re-creation. The delta adds an explicit non-recreation rule, mirroring the baseline's
  `server/src/logImport/` "SHALL cease to exist" sentence — which an earlier draft of this
  delta deleted without replacement.
- `checkAiRuntimePurity` and `AI_RUNTIME_MOVED_BASENAMES` lose their subject directory. They
  are re-pointed, not retired: a `hono` import inside a package that declared `hono` would
  satisfy every package-boundary rule while defeating this one. Re-pointing is a **body edit** —
  the function takes only `repoRoot` and hardcodes `srcRoot = repoRoot/server/src` before
  joining `AI_RUNTIME_DIR_REL`. Honest scope note: once the runtime is a package, the `appEnv`
  and `server/src/routers/` arms are *also* covered by `checkPackagesBoundary`'s escape rule;
  only the `hono`/`@hono/*` arm is strictly non-redundant. Keeping all three is right, but "its
  property did not change" was an overstatement.
- The purity check moves out of the one region with a non-vacuity guard into one with none:
  `walkTsFiles` swallows `ENOENT`, and after the move no `enumeratedButEmpty` analogue covers
  `packages/`. A **permanent** non-vacuity assertion lands with the re-point (D8).

### D2 — Fixtures split by reader, not by family

Ten `.mjs` fixtures live in `server/src/test/fixtures/`. Sorted by who reads them:

| fixture | in-package readers (moving) | app/e2e readers (staying) | disposition |
|---|---|---|---|
| `fake-claude.mjs` | `aiChatRelay`, `aiChatRunner`, `topicGenerate` | 4 int tests (one reads it at 2 sites) + `playwright.config.ts` | **move** + const |
| `fake-claude-error.mjs` | `topicGenerate` | — | **move** |
| `fake-claude-exit-before-stdin.mjs` | `aiChatRunner` | — | **move** |
| `ai-v2-sdk-spawn-recorder.mjs` | `aiV2SdkSpawn` | — | **move** |
| `fake-claude-events-{success,paused,partial-fail}.mjs` | — | `events.generate.int` | stay |
| `fake-claude-topics-{success,partial-fail}.mjs` | — | `transcribe.int` | stay |
| `ai-v2-fake-agent.mjs` | — | `e2e` via `playwright.config.ts` | stay |

The previous change's D4 established the pattern for fixtures read from **both** sides: single
home in the owning package, addressed by an exported directory constant, staying tests
importing it (app→package, the legal direction). Every case it faced was of that kind. It is
**silent on fixtures with no moving reader**, and the answer for those is that they stay where
their only readers are: a package should not ship assets nothing in or reachable from it
consumes.

**Exactly one fixture is genuinely shared** — `fake-claude.mjs`. The draft also listed
`fake-claude-error.mjs` as shared with `transcribe.int.test.ts`, but that file names it only in
a **comment**, contrasting it with the fixtures it actually binds. The irony is worth keeping:
the draft conflated "a comment mentions it" with "a test reads it" inside the one table whose
entire purpose is that classification — the same distinction the path-literal instrument exists
to draw. Every fixture-to-fixture cross-reference is likewise comment-only, verified by reading
the referencing lines rather than grepping filenames.

*Alternatives:* move all ten (ships six app-integration fixtures inside a package that never
reads them); duplicate the shared one (D4 rejected duplication on live-drift grounds, and
`fake-claude.mjs` is a behavioral fake whose modes one unit test and four integration tests
must agree on); relocate the moving unit tests to `server/src/test/` instead (step 2's
precedent is for tests needing the **app harness**; these need none, and it would leave a
4,048-LOC package with no in-package test, against the "every package covered by the root
commands" requirement).

`playwright.config.ts:20`'s `join(...)` literal must be re-pointed. It is the one edit in this
change whose staleness survives the entire per-unit gate discipline — it fails at no gate in
`npm test`, `typecheck`, `lint`, or `docs:check`, only in `npm run e2e`. Named as an edit-set
member; no gate is proposed for it.

### D3 — `Clock` is a **required leading** parameter, and `killProcessGroup` stays total

`processGroupKill.ts:35,37` reads `Date.now()` twice to bound a polling deadline.
`core-ports-architecture` names this site as a standing exception that is
**control-flow-bearing and therefore not exemptible**, assigned to this change. The thread:

```
killProcessGroup(clock, pgid, graceMs?)                    processGroupKill.ts
  ← killAiChatProcessGroup(clock, child, graceMs?)         aiChatRunner.ts:333
      ← RunAiChatTurnOptions gains clock                   aiChatRunner.ts:393 (terminate closure)
      ← driveAiTurn gains clock                            aiTurn.ts:180 (finally), :144
          ← routers/ai.ts:158
          ← routers/events.ts:570
          ← generateTopicsTurn / GenerateTopicsTurnOptions topicGenerate.ts:108  ← in-package
              ← routers/transcribe.ts:271
  ← createDesignTurnSpawner(clock).terminate               aiV2SdkSpawn.ts:323,341
          ← routers/aiV2.ts:285
```

**Six** in-package signatures and **four** router call sites. The fourth is the one the draft
missed: `topics/generate` reaches the same kill ladder through an *in-package* intermediary, so
a pass stopping at the three visibly AI-shaped routers leaves it uninjected while looking done.

**`clock` is non-optional at every level, and passed positionally-leading — a gate ruling, not
a phase decision.** The draft deferred "direct parameter vs. options field" to the phase. The
panel showed that is a lifecycle-safety question, not a style one. `killProcessGroup` is
documented *"Never throws"*, and `aiTurnOrchestrator.ts` records that a previous violation of
that contract "pierced `driveAiTurn`'s 'never throws' contract and could orphan the child."
A `clock.now()` on an `undefined` clock would make it throwable inside two `finally` blocks
whose *remaining* statements are load-bearing:

- `aiTurnOrchestrator`'s `await terminateOnce(); opts.onFinally?.()` — a throw skips
  `onFinally`, which for the v2 design turn releases the concurrency slot, runs
  `abandonPendingQuestions` (documented as an every-exit-path guarantee), and deletes the
  config directory **holding the copied operator credentials**. A leaked slot never recovers
  for the process lifetime, eventually locking out every AI feature.
- `aiTurn.ts:180`'s `finally` — a throw skips MCP turn disposal (**the turn token stays
  valid**) and config cleanup, orphans the process group, and escapes `driveAiTurn` to the
  router as a 500 on an otherwise-succeeding request. That would be an observable contract
  change under a "contract impact: none" claim.

An optional `clock?` on an options object is the locally idiomatic shape (`RunAiChatTurnOptions`
already carries optional `killGraceMs?`/`abortSignal?`), which means a missed construction site
would **typecheck**. Required-and-leading makes every missed site a compile error.

**Two mechanical hazards the tasks must carry.** First, inserting a leading parameter shifts
positionals past an **optional** `graceMs`; five call sites pass explicit grace values, and
dropping one during the rewrite typechecks and silently reverts to the 3000 ms default.
Second — demonstrated by the panel — `Clock` is `now()`-only while `waitUntilGroupGone` polls
with a real `setTimeout(50)`, so a frozen fake clock spins forever rather than failing. This
is not a hazard for *new* tests only: `aiChatRunner.test.ts` already holds a
`SIGTERM→SIGKILL ladder, no orphans` block whose three cases drive the real loop, and handing
them the repo's standard `makeFakeClock()` hangs the suite in three places. The remedy also
collides with the same file's `waitForPidFile` helper, which polls with a real `setTimeout(10)`
and is awaited *before* the ladder call — so `vi.useFakeTimers()` at describe scope hangs the
test before it reaches the code under test. Fake timers must be scoped to the ladder call, or a
sleep seam injected. The delta makes sleep control a SHALL, so this is not optional polish.

*Alternatives:* a module-level `setClock()` (hidden mutable global — the shape
`core-ports-architecture` forbids for the JWKS cache); adding `sleep()` to the `Clock` port
(widens an L0 interface eleven consumers depend on, to serve one loop); claiming the exemption
(foreclosed in terms by the baseline).

### D4 — `homedir()` is closed at the composition root; three residuals are named, not one

**`prepareDesignTurnCredentials` computes `join(homedir(), '.claude', '.credentials.json')`.**
That is **step 4's** gate ruling E2's shape exactly: a service reaching into the deployment
environment to *discover* a path. Its remedy transfers — the composition root decides *where*,
the service decides *what to do with it*. `createBindings` resolves the path into `Config` and
`routers/aiV2.ts:288` (the only production caller) passes it.

Two constraints the panel forced, both security- or regression-relevant:

- **No environment override.** `createBindings` computes `join(homedir(), '.claude',
  '.credentials.json')` and nothing else. An operator-supplied env var pointing at this would
  become an arbitrary-file-read primitive that copies any readable file into a subprocess's
  `CLAUDE_CONFIG_DIR` — strictly wider than today's constant.
- **The `Config` field is required, not optional.** The cited precedent
  (`YTDLP_RESOLVED_PATH?: string | null`) is optional to spare existing full-object `Config`
  literals. Following it here would let an undefined value plus a defensive early return
  *silently disable the login fallback* — a working design turn degrading to a scrubbed auth
  error, with no test anywhere to notice, because `prepareDesignTurnCredentials` has **zero**
  test coverage today. Hence the characterization task in the seam-reshaping phase (tasks 2.1
  and 2.5), driven through the router rather than at unit level.

**Three residuals are named, where the draft named one.** The draft's requirement forbade
"reading process environment variables to decide where something lives" and then claimed to
have named its only exception. Two reviewers independently found it false on arrival:

- `opts.procEnv ?? process.env` (`aiChatRunner.ts:282`, `aiV2SdkSpawn.ts:181`) — the parameter
  is already injected; the fallback exists because `buildAiChatChildEnv` needs the **raw host
  environment** to compute a child-process whitelist. Closing it means plumbing that raw map
  from the composition root through the app (relocating the read, not removing it) or moving
  whitelist computation from per-turn to boot (behavior-adjacent). Neither buys the property.
- `os.tmpdir()`-derived scratch directories — `aiChatRunner.ts:180`'s module-load
  `join(tmpdir(), …)` and `aiV2SdkSpawn.ts:578-579`'s two `mkdtempSync(join(tmpdir(), …))`.
  `os.tmpdir()` reads `TMPDIR`/`TMP`/`TEMP`, so it is literally in the forbidden class as the
  draft worded it. These are **scratch-space allocation, not configuration** — nothing about
  *where the deployment keeps its data* is being discovered — but that is an argument for
  naming them as a reasoned residual, not for pretending the sentence does not reach them.
- `@autologger/media-import`'s `ytdlp.ts` carries the identical `procEnv ?? process.env`
  shape. The requirement's first sentence is universally quantified over service packages, so
  a sibling package violates it the moment it syncs unless the residual is package-agnostic.

The asymmetry between closing `homedir()` and keeping the rest is deliberate and was
challenged in both directions at the gate. It survives because `homedir()` is *discovery of
where the deployment keeps a credential*, while the others are scratch-space allocation and an
injected parameter's fallback.

### D5 — `SessionToolPort` is re-deferred, and the re-deferral is written where it survives

Step 1's D5 deferred the port so it could be cut against a real consumer. That consumer,
`ai-session-analyst`, was deleted as superseded on 2026-08-07 and nothing replaced it; the
reason to defer is *stronger* now. Extraction does not need it: `mcpTools.ts:46` and
`aiMcpServer.ts:60` import `SessionHubRegistryFacade` from `@autologger/session-core`, an
ordinary L2→L1 edge.

What must not happen is silent expiry. The pointer "deferred to the AI-runtime change" lives
**only in an archived `design.md`** — `SessionToolPort` appears nowhere in either durable
baseline — and design documents do not sync. So the delta records the decision and its reason.

**It does not freeze the original study's conclusions as law.** The draft restated four
binding constraints for a port nobody has built, including an atomicity claim that is really
`auto-event-generation`/`api-contract-freeze`'s law. Specifying a hypothetical's constraints in
a durable baseline is how a baseline goes stale silently. The delta points at the study and
requires it be **re-derived against the code as it then stands**.

### D6 — The gloss is re-anchored on a **definition**, not on a substitute example

`package-architecture:213-214` currently argues the layer definition is a **gloss on named
members** by pointing at the AI runtime: another requirement in the same capability places it
at `server/src/ai-runtime/` under an injection rule, so a universally quantified "every service
SHALL be a package" would leave the baseline carrying an unsatisfiable pair. This change
destroys its own supporting example.

The draft re-anchored on `auth`. The panel showed why that is weaker than what it replaces:
**the baseline's guard works by contradiction** — you cannot promote the gloss without
producing a visible self-contradiction — while an `auth` anchor works by **assertion**, and a
later reader who simply disagrees ("auth *is* a coherent feature, and it already takes
`KvStore` by injection") produces no contradiction at all. `server/src/auth/` is 397 LOC of
OAuth exchange, JWKS-cached verification, and session lifecycle; the one genuinely
non-composable thing in it is `apiRequestRequiresLogin`'s URL-prefix policy, a single function
that could move to `middleware/` in an afternoon, at which point the anchor evaporates.

Worse, the draft patched this with a new SHALL — "`server/src/auth/`, which SHALL remain where
it is" — a permanent, unargued prohibition on ever packaging auth, decided as a side effect of
an AI-runtime change. This design refuses to settle `aggregates.ts`'s home on exactly that
ground; the same standard applies.

**Ruling: anchor on the definition.** Membership in the service layer is **by enumeration
only** — a module joins when a change adds it to the list, and no property of a module (being
service-shaped, injection-fed, owning a coherent feature) makes it a member. `auth` stays as
the standing *illustration*, with its reasons, and whether it should ever become a package is
explicitly left **open**. A definitional anchor cannot be eroded by disagreement about any
particular module.

**A related strain the draft never acknowledged.** The gloss says a service package "owns a
coherent feature the app composes." `@autologger/ai-runtime` is machinery shared by four
capabilities, described by an eight-item enumeration that reads like a directory listing, and
at 4,048 production LOC it would be the largest L2 package in the repo. It is admitted at L2
because L2 is the only legal placement (D1), not because it exemplifies the gloss. Saying so
in writing is better than letting the enumeration imply a fit that is not there.

### D7 — One rider dropped, two cheap holes closed, and the difference between them stated

The draft proposed adding an **empty-component check** to `web-docs`' coverage gate and made
`web-docs-site` a third modified capability. **Dropped at the gate**, on evidence from three
reviewers:

- It is **ill-defined as specified**. `datastoreComponent`/`externalComponent` construct seven
  live components with `globs: []` by definition; the delta's literal wording fires on all
  seven, and task 2.2's "confirm it passes with no allowance entries" was empirically false.
- The only implementable form is **defeated by the disposal route it targets**. Scoping to
  glob-bearing components means a lazy mover can "remove" the `aiV2` component by clearing its
  globs — demonstrated green — and that route *also* silences `checkCapabilityAccounting`'s
  existing `dangling-component` check, which fires only when a scope names a component that
  does not exist. The proposed gate is net-neutral against a determined mover and net-negative
  against a careless one.
- Its only in-change beneficiary is a mistake the plan **already prevents by hand**: the
  component is deleted in the same unit that empties its directory, and the re-glob mistake is
  already caught by the orphan check.
- Decisively: the property is **already normative** in `package-architecture`'s
  "architecture model attributes each service to its own component" scenario, which states
  "no component retains a glob matching zero files" and explicitly discloses that **none of its
  four properties is machine-checked**. The baseline already assigns this to review at the
  change that moves the code. This change discharges it that way and records the demonstrated
  bypass for whichever change builds the gate properly — which must handle `globs: []` and
  globs-matching-nothing as *distinct* defects.

**Two holes are closed, and the distinction is the point.** A check earns inclusion when it is
unambiguous, cheap, reuses existing primitives, and is directly exercised by this change:

- **The server app's manifest is scanned against its `@autologger/*` imports.** ~20 lines. The
  previous change shipped three undeclared workspace dependencies through this exact hole,
  hand-fixed during apply; this change re-exposes it by hand-adding one. Verified green against
  the nine workspace packages the server declares on `main` today, and against the tenth once
  this change adds it. A change whose thesis is "an architectural rule
  with no mechanism goes false silently" cannot decline the one hole that has demonstrably
  failed while re-opening it.
- **`SERVICE_PACKAGES` gains a completeness assertion.** Demonstrated: with `ai-runtime`
  present in `ALLOWED_LAYER_EDGES` but omitted from `SERVICE_PACKAGES`, a real
  service-to-service violation passes **all four** checks and `checkPackagesBoundary` green.
  The spec requires the constant be non-empty and name only existing packages — one direction
  only. Every `packages/*` that is not L0/L1 must be in the set or on a named exemption list.

**The dead `ALLOWED_LAYER_EDGES` entries stay, and the reason is narrower than the draft
claimed.** The residual register wants an assertion that every declared edge is realized,
deleting `contract->domain`, `ports->domain`, and `ports->contract`. The draft rejected this on
the grounds that `package-architecture` states the opposite rule twice ("permissions, not
mandates"), so closing it would overturn a normative baseline sentence. **On re-reading after
the panel, that was overstated**, and the correction is recorded rather than quietly dropped:

- The baseline sentence is two clauses pulling opposite ways — *"permissions, not mandates"*
  (an existing entry does not oblige a package to use it) and *"a package declares an edge only
  when an import needs it"* (an unneeded entry should not exist). The **second clause agrees**
  with the boundary test's comment that "adding an edge no file actually has would itself be a
  defect." The tension is inside one baseline sentence, not between the spec and the code.
- The three entries are deader than the register claims: `contract` and `ports` declare **no
  `@autologger/*` dependency at all**, so these permit edges that `checkPackagesBoundary` would
  independently reject as `undeclared-dependency` if any file used them.
- The real obstacle is operational, and visible in the constant's own comments: prior changes
  **deliberately pre-added** edges ahead of the module moves that would use them ("added ahead
  of the task 4.3 module move … so the move commit's gate is green from the first file it
  lands, not red until the last one"). A realization assertion outlaws that pattern. It is
  compatible with D8's "edges land in the unit that needs them", but that means the assertion
  constrains *when* an entry may be added — which is a rule about move atomicity, not a tidy-up.

**Still not closed here, and the reason is now the panel's rather than the draft's.** Three
reviewers touched this; **none argued for closing it**, and two endorsed deferring in terms.
The re-reading above is post-panel reasoning, so folding it in would land normative baseline
rewording that no reviewer has seen, in the one artifact that syncs — and it fails E7's own
"unambiguous" clause, since the obstacle proved ambiguous enough to be mis-stated once. What
this change **does** owe, per the requirements reviewer, is to *name* the defect where it
survives archive: the delta now records both undetected drift directions and the three standing
entries in the layer-graph requirement. The draft asserted that naming had happened while the
delta contained no mention of it — caught only by re-checking design's claims against the
delta, which is the same "true only in design.md" failure this campaign keeps hitting.

Note also that the live defect is the **opposite** direction: D3 requires *adding*
`ai-runtime->ports`, and nothing detects a *missing* needed edge either until it fires.

### D8 — A module move is atomic with everything that makes it legal — and the panel found four states where the draft was not

Boundary-test deltas land **with** the code they govern. The draft applied that to the
enumeration entries and missed four:

1. **`@autologger/ports` was in neither the manifest nor the allowed-edge set.** D3's Clock
   threading gives five moving modules `import type { Clock } from '@autologger/ports'`. The
   draft priced the manifest off a snapshot of `main` — an accurate statement that the change
   itself falsifies. Demonstrated: `checkPackagesBoundary` raises both
   `undeclared-dependency` and `disallowed-layer-edge`. This is the class of implicit premise a
   fact-check pass structurally cannot catch, because the claim was checked against the tree
   rather than against the change's own effect.
2. **Splitting the two directories across phases 5 and 6 left the gates red for a whole
   phase.** `aiV2SdkSpawn.ts` and two moving test files carry a **value** import of
   `../aiV2/mcpTools`; once in the package it resolves into `server/src/aiV2/`, which
   `checkPackagesBoundary` reports as `escape`. Demonstrated. **The two directories move in one
   dispatch unit.**
3. **The scaffold turned `docs:check` red for two phases.** A non-empty `src/` committed before
   the atlas component is re-globbed is an orphan tracked file — demonstrated against the live
   `checkCoverage`. The component gains `packages/ai-runtime/src/**` **in the scaffold unit**,
   alongside the old glob (no overlap), narrowing later.
4. **The "inverted canary" was a deliberate two-phase red window.** The draft landed a test
   asserting the known-bad state so it would go red when the move landed — flatly contradicting
   the same file's no-knowingly-red rule. The hazard it addressed is real (`walkTsFiles`
   returns `[]` on a missing directory, so a mis-pointed purity check passes vacuously), but
   the repo's own idiom for it is a **non-vacuity assertion**, used twice in this very file. It
   costs no red window and survives after the branch, whereas a canary is deleted and protects
   nothing thereafter.

The rule stated more strongly: **the unit that moves a module also lands its manifest
declarations, its allowed edges, its specifier rewrites, its enumeration edits, and its atlas
globs** — and no unit may be knowingly red.

### D9 — The move would silently discharge the facade-only rule; the check's walk follows the code

`checkInterfaceOnlyConsumption` hardcodes `srcRoot = repoRoot/server/src`, and the baseline
requirement it implements is scoped "**Outside the packages**, production code SHALL otherwise
reference the facade interfaces only." So the moment the runtime becomes a package, its
obligation to import `SessionHubRegistryFacade` rather than concrete `SessionHub`/`Catalog`
classes **stops being enforced and stops being required** — by the act of moving, with no gate
objecting.

An earlier draft made this worse by asserting the property in a new scenario with no mechanism:
a SHALL authored by the change that deleted the mechanism, which is structurally identical to
the hole D7 congratulated itself for closing.

**Ruling: widen the walk.** ~10 lines plus a mutation case. Verified green today —
`transcription` and `log-import` already import only `SessionHubFacade` as a type, and the
moving modules import only `SessionHubRegistryFacade`. The delta states that the check's walked
root includes the service packages, precisely because the `server/src` scoping would otherwise
be discharged by the move itself.

## Risks / Trade-offs

- [Two directories empty in one change, each with an ordering trap] → both removals land in the
  unit that empties them; both directories are additionally barred from re-creation by name.
- [A 28-file move diff visually masks a semantic edit] → mechanical `git mv` + specifier
  rewrites commit separately from the semantic edits, hash-verified against the **phase base**.
  Caveat recorded: where a unit both moves and rewrites specifiers, hash verification does not
  apply to the rewritten files, and `npm run lint` runs `biome check --write` with
  `organizeImports` on — so "lint green" is not evidence about import ordering.
- [Required leading `Clock` shifts positionals past an optional `graceMs`] → five call sites
  pass explicit grace values; the rewrite is verified site-by-site, not by compiler alone.
- [Fake clock plus real sleep hangs the suite] → D3; three *existing* tests are affected, and
  the fake-timer remedy collides with a helper awaited before the code under test.
- [`web-docs` enrollment forgotten] → this bit the previous change twice; regime enrollment and
  the component glob both land in the scaffold unit.
- [`zod` installed twice, breaking schema identity where `mcpTools` hands zod schemas to the
  agent SDK's `tool()`] → declared as a `peerDependency`. The error-mapping ground is
  **disproven** and not claimed (Open Questions). Implementer note: `npm ls zod --json` already
  reports `zod@3.25.76` as `invalid` against the SDK's `^4.0.0` peer range **on `main`** — the
  "unrelated peer-range warning" the baseline's scenario carves out. The gate reads
  resolved-copy count, not validity.
- [Removing the AI runtime's placement requirement loosens the gloss] → D6's definitional
  anchor, and a post-gate delta-spec review commissioned for exactly this class of edit.
- [Four integration suites spy on module namespaces] → routers and their int tests must use
  **identical** specifiers; subpath imports are ruled (Open Questions), and this would be the
  repo's first `@autologger/*` subpath consumer.
- [The server manifest gap] → **closed** for `@autologger/*` by D7. The third-party direction
  (`server/src` importing an undeclared third-party specifier) remains open and is re-stated
  rather than claimed fixed.
- [Successor stalls, leaving a hybrid layout] → self-consistent alone.

## Migration Plan

Pure source restructuring — no data migration, no deployment step, no rollback concern beyond
reverting the branch. `DATA_DIR` layout, the catalog schema, and session DBs are untouched.
The frozen contract is untouched by construction; the always-running integration pins (fixture
conformance chain, 416/422/400 error identity, the AI chat and design-turn suites) are the
guard.

## Open Questions

- ~~Does a `ZodError` from an AI-runtime tool body reach `app.onError`?~~ **Closed: no**, at two
  independent points. Every zod parse in the moving set uses `safeParse`, and the MCP SDK's
  `CallToolRequestSchema` handler converts validation failures into `{content, isError: true}`
  tool results rather than exceptions. The `peerDependency` rests on schema identity alone.
- ~~`Clock` as a direct parameter or on the options objects?~~ **Closed at the gate: required,
  leading, direct** — see D3. Deferring it was wrong; it is a lifecycle-safety decision.
- ~~Barrel or subpath imports?~~ **Closed at the gate: subpath**
  (`@autologger/ai-runtime/<module>`), with routers and their integration tests using the
  **identical** specifier. Four int suites `vi.spyOn` a module namespace, which depends on both
  sides resolving the same module record; a re-export barrel makes that fragile. This would be
  the repo's first `@autologger/*` subpath consumer, so the phase verifies resolution
  explicitly rather than assuming.
- **Escalated and left open:** should the three unrealized `ALLOWED_LAYER_EDGES` entries be
  removed and a no-dead-entries assertion added, given that this requires overturning the
  baseline's twice-stated "permissions, not mandates" rule? Not adopted here (D7).

## Invariants a future reader must not "helpfully" undo

- All step 1–4 invariants remain in force: single process; hub RPCs synchronous and
  transactional; `create_event`'s handler zero-`await`; facades property-style function types;
  `appEnv.ts` names zero concrete persistence classes; `node/config.ts` sole production namer;
  `createCatalog` + `init()` per-request; L1 siblings never import each other; `ApiError` at app
  root; the layering enumeration complete **and** non-vacuous; no permanent re-export shims;
  integration tests stay under `server/src/`.
- **The flat service rule keeps all four checks**, independent of `ALLOWED_LAYER_EDGES`, and
  now a **completeness** assertion on its membership constant — without which a package omitted
  from the set is silently outside all four (demonstrated). The injection-shaped residual, and
  the four bypasses the baseline already names, stay **stated, not claimed closed**.
- **`killProcessGroup` stays total.** Its "never throws" contract guards two `finally` blocks
  that release a concurrency slot, abandon pending questions, dispose an MCP turn token, and
  delete a directory holding copied operator credentials. `clock` is required and leading so a
  missed site is a compile error rather than a runtime throw.
- **The credential source path has no environment override and its `Config` field is
  required.** An override is an arbitrary-file-read primitive; an optional field silently
  disables the login fallback.
- **The service-layer definition stays a gloss, anchored on enumeration-only membership** (D6).
  `auth`'s exclusion is an illustration, not a permanent prohibition — whether it ever becomes
  a package is open.
- **The AI runtime's Hono-freedom check survives the move**, re-pointed at the package with a
  **permanent non-vacuity assertion**, because `walkTsFiles` returns `[]` on a missing directory
  and no `enumeratedButEmpty` analogue covers `packages/`.
- **`checkInterfaceOnlyConsumption`'s walk includes the service packages** (D9). Narrowing it
  back to `server/src` re-discharges the facade rule by relocation.
- **`AGGREGATE_MCP_SERVER_NAME` stays declared by the module that builds the server it names.**
- **`server/src/ai-runtime/` and `server/src/aiV2/` must not be re-created.** The layering
  enumeration is a permission list; removal alone does not bar re-creation.
- **`aggregates.ts`'s move does not settle where it ultimately belongs**, and `web/`'s mirror
  and its path-pinning test are deliberately left standing. Re-pointing that pin onto
  `packages/` is a **deliberate, non-precedential relocation** of a test-only reader — not a
  ruling that `web/` may depend on the package graph.
- **`web-docs` is a drift consumer, never an import-rule precedent.**

## Panel & review log

- **2026-08-08 — pre-panel fact-check pass** (light-tier reviewer, against live `main`
  `c0baad5`, clean tree). 40 claims enumerated **as properties to verify**, never as lines to
  confirm: **35 CONFIRMED, 3 CORRECTED, 0 FAILED, 0 left unverifiable-mechanically.**
  Judgment-laden material was **not** submitted and reached the panel **un-vouched**: whether
  the AI runtime is the right thing to package, D2's split-by-reader, D4's asymmetry, D6's
  re-anchoring, whether D7's check belonged here, and the sequencing.

  Method notes: gate mechanics were answered by executing or by reading the implementing
  function in full — `checkCoverage`'s three issue kinds were established by reading the whole
  file, and the reviewer confirmed it iterates files→components only, which is *why* it cannot
  see an empty component; unenrolled-package behavior was confirmed at `extractImports.ts:344`'s
  `if (!regime) continue` rather than from the doc comment asserting it; the
  realized/unrealized allowed-edge split was **computed**; and the ZodError question was settled
  by de-minifying the agent SDK's `tool()` and `createSdkMcpServer()` bodies with `node -e`
  rather than trusting their `.d.ts`.

  **Corrections folded into all four artifacts:**
  - *The Clock threading undercounted its router sites.* `topics/generate` reaches the kill
    ladder through an **in-package** intermediary, making it six in-package signatures and four
    router call sites, not four and three.
  - *A fixture was classified as shared on the strength of a comment.* `fake-claude-error.mjs`
    has exactly one executable reader — the moving `topicGenerate.test.ts`. The draft conflated
    "a comment mentions it" with "a test reads it" inside the one table whose purpose is that
    distinction.
  - *"Re-pointed at the package" understated the edit.* `checkAiRuntimePurity` hardcodes its
    `srcRoot`; the root computation must change, not just a constant.

  **Open Question closed on evidence:** no `ZodError` can reach `app.onError`.

  **Carried as implementer awareness, not a defect:** `npm ls zod --json` already reports
  `zod@3.25.76` as `invalid` against the agent SDK's `^4.0.0` peer range on `main` today.

- **2026-08-08 — adversarial panel** (4 heavyweight reviewers, distinct mandates —
  requirements / assumptions / failure & abuse / scope & simpler design — skeptical
  calibration, empirical probes run with the repo's own toolchain against exported production
  check functions). **All four returned "do not gate as-is."** As with the previous change, no
  reviewer found the justification false; the convergent root cause was again that **the plan's
  model of the repo's own gates was wrong**, and this time in a new direction: three defects
  arose from pricing the change against a **snapshot of `main` rather than against the change's
  own effect**.

  **Blockers/majors fixed in place:**
  - *`@autologger/ports` appeared in neither the manifest nor the allowed-edge set* (2
    reviewers, both demonstrated). D3's Clock threading gives five moving modules an
    `import type { Clock }`; the edge inventory was a true statement about `main` that D3
    falsifies. `checkPackagesBoundary` raises both `undeclared-dependency` and
    `disallowed-layer-edge`. **The fact-check pass had CONFIRMED the inventory — correctly —
    which is exactly why a fact-check cannot substitute for a panel.**
  - *Splitting the two directories across phases left `npm test` red for a whole phase* (2
    reviewers, both demonstrated). The one app-internal edge is a **value** import carried by
    `aiV2SdkSpawn.ts` and two moving test files; `checkPackagesBoundary` walks test files too.
    The directories now move in one dispatch unit.
  - *The scaffold turned `docs:check` red for two phases* (2 reviewers, demonstrated against
    live `checkCoverage`). The atlas glob now lands in the scaffold unit.
  - *The move silently discharges the facade-only rule* (2 reviewers). `checkInterfaceOnlyConsumption`
    walks `server/src` only, and the draft asserted the property in a new scenario with no
    mechanism — a SHALL authored by the change that removed its enforcement. Walk widened (D9).
  - *The MODIFIED "Feature services" block was not a superset* (requirements). All six baseline
    scenario names were replaced; three real content losses — the downward-reach scenario with
    its literally-false-universal guard, the **Stated residual bypasses** paragraph naming four
    further holes, and the architecture-model scenario with its "none of these four properties
    is machine-checked" disclosure — plus the `logImport` cease-to-exist sentence. All restored
    verbatim, with new scenarios added rather than substituted. The predecessor's own
    scenario-name set-difference check is now a pre-gate step.
  - *Nothing barred `server/src/ai-runtime/` from being re-created* (requirements). Every
    post-change check was traced against a re-created directory: all green, because the layering
    enumeration is a permission list. Non-recreation rule added.
  - *The AI-runtime rule had two homes, the primary one in a requirement whose title stops
    applying* (2 reviewers). The placement/injection/Hono-freedom paragraph moved into the
    service-package requirement; the duplicate injection scenario deleted.
  - *The host-environment requirement was false on arrival in three places, two of them inside
    the package it names* (2 reviewers). `os.tmpdir()` at three sites reads `TMPDIR`/`TMP`/`TEMP`;
    `@autologger/media-import` carries the same `procEnv` fallback the requirement claimed was
    the sole exception. Residuals restated as three, package-agnostic.
  - *Three unfalsifiable scenarios* (requirements) — two asserting that the text you are reading
    contains the text you are reading, and one whose second disjunct is vacuously true. Deleted
    or generalized into obligations on future changes.
  - *`README.md` and `CLAUDE.md` were missing from the edit set entirely* (assumptions). Both
    assert the runtime lives at `server/src/ai-runtime/`; the previous change edited them by 116
    lines; no gate reads either. A **fourth** edit-set instrument class, alongside import
    specifiers, path literals, and moved symbols.
  - *`npm run test:real -w server` would silently stop covering `eventGenerate.real.test.ts`*
    (assumptions) — it is a server-workspace-scoped path-substring filter, and one of the two
    real tests moves out of its reach. Resolved by relocating both real tests to
    `server/src/test/`.
  - *The Clock threading makes the kill ladder newly throwable inside two `finally` blocks*
    (failure & abuse) whose remaining statements release a concurrency slot, abandon pending
    questions, dispose an MCP turn token, and delete the copied-credentials directory. Ruled at
    the gate rather than deferred (E3).
  - *Three **existing** kill-ladder tests hang under a frozen fake clock* (failure & abuse,
    demonstrated), and the fake-timer remedy collides with a helper polling on a real timer
    awaited before the code under test. The draft framed the seam as under-covered; it is well
    covered, and that coverage is the hazard.
  - *`SERVICE_PACKAGES` has no completeness check* (failure & abuse, demonstrated): with
    `ai-runtime` omitted from the constant, a real service-to-service violation passes all four
    checks and the boundary check green.
  - *The package-local `fakeClock` needs a `TEST_INFRASTRUCTURE_EXEMPTIONS` entry landed ahead
    of the file, and the manifest omitted `vitest`/`typescript` devDependencies* (failure &
    abuse, demonstrated).
  - *The proposal's "routers: import specifiers only" was false* (2 reviewers) — five handler-body
    threading edits. Corrected, and explicitly authorized in the delta rather than in prose.
  - *The phase-1 characterization and the phase-4 reshape are a TDD pair split across two
    phases* (scope), against CLAUDE.md's "TDD pairs always batch into one unit". Merged.
  - *The "inverted canary" was a deliberate two-phase red window* (2 reviewers) — replaced with
    the repo's own non-vacuity idiom, which costs no red window and survives the branch.
  - *Task 7.1's stale-prose list was wrong in both directions* (2 reviewers) — two listed items
    were not stale, ten stale references were unlisted. Replaced by `git grep` output.
  - *The extraction confines zero dependencies* (scope) — stated as fact but never concluded.
    The proposal now says the manifest buy is entirely prospective.
  - *Minor corrections folded:* `Config` field required vs optional and its silent-disable
    failure mode; the positional shift past an optional `graceMs`; `AI_RUNTIME_MOVED_BASENAMES`
    growing 11→13 with no task; `transcribe.int.test.ts` reading `fake-claude.mjs` at two sites;
    `edges.test.ts:148` being a comment, not a test to re-point; the proposal double-booking
    `topicGenerate.real.test.ts`; `Config` gaining a field while `Config` slicing is a Non-Goal;
    the `"./*"` export map exposing test-only seams; hash-verification not applying to files a
    unit also rewrites, and `biome --write` making "lint green" no evidence about import order.

  **Escalated to the gate, with rulings (2026-08-08):**
  - **E1 — the empty-component check.** RULED: **dropped**, and `web-docs-site` ceases to be a
    modified capability. Three reviewers demonstrated it fires on seven live zero-glob
    components; the failure reviewer demonstrated the only implementable form is defeated by
    zero-globbing — which *also* silences the existing dangling-component check, making the
    proposed gate net-negative against a careless mover. Decisively, the property is **already
    normative and review-verified** in the baseline, which explicitly discloses that none of its
    four architecture-model properties is machine-checked. This change discharges it by review
    as the baseline requires, and records the demonstrated bypass for whichever change builds
    the gate properly. The scope reviewer's YAGNI argument (an allowance mechanism plus About-page
    rendering built for a set the change itself proves empty) is accepted as a supporting ground.
  - **E2 — the don't-package alternative.** RULED: **not adopted, but recorded with its price**
    in D1, per the previous gate's standing requirement that a missing alternative be priced
    rather than omitted. The rejection grounds already exist in the record: a directory allowlist
    confines only what you thought to name, and step 3's E1 struck intermediate directories.
  - **E3 — `Clock` shape.** RULED: **required, leading, direct** at every level, closing an Open
    Question the draft had deferred to the phase. An optional options field is locally idiomatic,
    which is precisely the danger — a missed site would typecheck. `killProcessGroup` stays total.
  - **E4 — barrel vs. subpath.** RULED: **subpath**, with routers and their integration tests
    using identical specifiers. Four suites `vi.spyOn` module namespaces, which depends on both
    sides resolving one module record. The repo has no existing `@autologger/*` subpath consumer,
    so the phase verifies resolution rather than assuming it.
  - **E5 — the two `*.real.test.ts` files.** RULED: **both relocate to `server/src/test/`**, so
    `npm run test:real -w server`'s path-substring filter keeps covering both. Splitting them
    would have left the operator-facing escape hatch silently covering half of what it did.
  - **E6 — the credential path.** RULED: **no environment override; required `Config` field.**
    An override is an arbitrary-file-read primitive; an optional field silently disables the
    login fallback in code with zero test coverage.
  - **E7 — which gate holes this change closes.** RULED: close the **server-manifest scan** and
    the **`SERVICE_PACKAGES` completeness** assertion; drop the empty-component check (E1). The
    distinguishing test, stated so a successor can apply it: a check earns inclusion when it is
    unambiguous, cheap, reuses existing primitives, and is **directly exercised by this change**.
    The manifest hole has demonstrably shipped a defect and this change re-opens it by hand; the
    membership hole is demonstrated against this change's own new member. The empty-component
    check failed the "unambiguous" test under demonstration.
  - **E8 — the gloss anchor.** RULED: **anchor on enumeration-only membership**, keep `auth` as
    illustration, and **drop the draft's new "auth SHALL remain where it is"**. The baseline's
    guard worked by contradiction; an example-based anchor works by assertion and erodes the
    moment a reader disagrees. The draft's patch would also have settled auth's fate permanently
    as a side effect of an AI-runtime change — the exact standard this design applies to
    `aggregates.ts`.
  - **E9 — phase partition.** RULED: the two directories move in **one dispatch unit**; the
    atlas glob and the manifest/edge declarations land in the units that need them; no unit is
    knowingly red. Two reviewers independently demonstrated three separate red windows in the
    draft, which had stated the no-red rule at the top of the same file.
  - **E10 — TDD pairing.** RULED: characterization merges into the phase that reshapes the seam.

  **Minors accepted as residual:** `checkCoverage` still has no duplicate-name check (E1's
  scope); an `npm:`-protocol dependency alias defeats all four service checks (demonstrated —
  low realism, added to the stated-residual list rather than closed);
  `checkThirdPartySpecifiers` skips `.test.ts` but not `.test.mts`/`.test.cts` (pre-existing);
  the server-manifest scan closes the `@autologger/*` direction only, leaving the third-party
  direction open; `AI_RUNTIME_MOVED_BASENAMES` gaining `aggregates` would forbid an unrelated
  future `server/src/routers/aggregates.ts`; `playwright.config.ts`'s literal fails at no gate
  inside `npm test`; the `web/` pinning test's relocation onto `packages/` is recorded as
  deliberate and non-precedential; `aggregates.ts` may be moved twice as the price of
  sequencing 4b before the web split.

- **2026-08-08 — scenario-name set-difference over every MODIFIED block** (run by the author
  after folding the rulings, using the predecessor's own method, both directions; re-run after
  the post-read follow-up below added a seventh MODIFIED requirement). Six of the seven MODIFIED
  requirements are **strict supersets** — five in `package-architecture`, two in
  `core-ports-architecture`, which additionally carries two ADDED requirements that this check
  does not cover. The seventh, "The server app's module
  directories have declared, test-enforced roles", shows three departures, **all deliberate
  supersessions with a named successor** — recorded here so a later run of the same check is
  not misread as a silent drop:
  - *"AI runtime Hono-freedom is continuously enforced"* → **relocated**, not deleted, to
    "AI runtime Hono-freedom is enforced in its package home" under the service-package
    requirement. The rule now has one home (E8's companion finding); a set-difference scoped
    per-requirement structurally cannot see a cross-requirement move.
  - *"The architecture model stops attributing the runtime to routers"* → superseded by
    "…to a server directory", which keeps every clause including the general "every production
    file under `server/src` belongs to some component". The draft had dropped that clause
    outright; the check caught it.
  - *"The new directory joins the acyclicity guard with the expected edges"* → superseded by
    "The directory graph loses both endpoints and stays acyclic". The original asserted edges
    incident to `ai-runtime` were exactly `routers → ai-runtime` and `ai-runtime → aiV2`; this
    change removes both endpoints, so the scenario is obsolete rather than violated — but
    dropping it silently would have left server-directory acyclicity resting only on an
    unmodified scenario in a different requirement, which the panel flagged.

- **2026-08-08 — post-gate consistency read** (light tier, all four artifacts read in full plus
  the two delta specs, after the E1–E10 rulings were folded back). Verdict: **findings**, six,
  all fixed in place. Confirmed first that `specs/web-docs-site/spec.md` no longer exists, that
  no artifact still treats the empty-component check as in scope, and that the proposal's
  Modified Capabilities list matches exactly the two spec files present.
  - *The set-difference log entry miscounted its own subject* — "six of the seven MODIFIED
    requirements" against an actual six (four in `package-architecture`, two in
    `core-ports-architecture`; the other two core-ports requirements are ADDED, not MODIFIED).
    The artifact's own final self-check misstating the size of the set it certifies is the
    worst kind of small error. Corrected to five of six.
  - *Bare "gate ruling E1"/"E2" citations collided with this change's own E1/E2.* The proposal
    and D4 cited **step 4's** rulings — the `exceljs` importer-count rule and the
    `resolveYtDlpPath` reversal — by bare label, while this change defines its own E1 (drop the
    empty-component check) and E2 (record but do not adopt the don't-package alternative) 500
    lines later in the same document. The reviewer noted the document was already careful about
    this for step 3's E1 and had left only these two bare. All now prefixed.
  - *Test-file count off by one* — the proposal said 14 moved test files where the design's own
    inventory, the task list, the live tree, and D1's pricing table all say 15 (13 + 2).
  - *Dangling cross-reference* — D4 pointed at "D8's first phase" for the credential
    characterization; D8 is about move atomicity and has no phases. Re-pointed at tasks 2.1/2.5.
  - *"Three stand:" introduced two bullets* — defensible as three *reads* across two classes,
    but a reader counting bullets finds two. Reworded.
  - *"all ten packages the server imports"* — nine on `main` today; the tenth is added by this
    change's own phase 1. Made sequential rather than ambiguous.

  The reader explicitly confirmed as consistent: all ten rulings correctly reflected in the
  deltas with E1's rider fully excised; every D1–D9 citation resolving as claimed (aside from
  the D8 slip above); Open Questions and Decisions in agreement, with the one still-open item
  (the `ALLOWED_LAYER_EDGES` escalation) never contradicted by a "decided" statement elsewhere;
  E8's struck "auth SHALL remain where it is" absent from the spec; fixture counts (4 move / 6
  stay); the Clock figures (five modules gaining the `ports` import, six signatures, four router
  sites); and `AI_RUNTIME_MOVED_BASENAMES` 11→13.

- **2026-08-08 — post-read follow-up, found while answering a question about D7.** A **seventh**
  inconsistency of exactly the class the consistency read was scoped to catch, and did not:
  D7 asserted "that contradiction is named in the delta by this change," and **the delta
  contained no mention of it.** The claim was true only in `design.md`, which does not sync —
  the campaign's signature failure mode, in the paragraph explaining why a residual was left
  open. Fixed by MODIFYING the layer-graph requirement to name both undetected drift directions
  and the three standing unrealized entries, with a scenario making the defect legible from the
  baseline alone.

  Re-reading the underlying question also **corrected D7's stated reason**. The draft said
  closing the residual would overturn a baseline sentence stated twice; in fact that sentence's
  two clauses disagree with *each other*, and its second clause agrees with the boundary test's
  comment. The real obstacle is that a realization assertion constrains *when* an allowed edge
  may be added relative to the code needing it — visible in the constant's own comments, where
  prior changes deliberately pre-added edges ahead of their module moves. The decision not to
  close is **unchanged**, but its ground is now the panel's (three reviewers touched it, none
  argued for closing) rather than the draft's mis-stated one; folding in post-panel reasoning
  would put un-reviewed normative rewording into the only artifact that syncs.
