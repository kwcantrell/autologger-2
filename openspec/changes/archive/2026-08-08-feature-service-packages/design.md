## Context

`package-split-foundation` (L0: `domain`, `contract`, `ports`) and
`persistence-package-extraction` (L1: `session-core`, `catalog`, `storage`) built a two-layer
package graph enforced by `server/src/packageBoundaries.repo.test.ts`.
`router-directory-decomposition` then split the AI runtime out of `server/src/routers/` and
made three directory-role rules executable. This change adds the layer above: **service
packages**.

**Current state, established by import-specifier extraction** using the boundary test's own
regex, run against every `.ts` under `server/src`, `web/src`, `e2e`, and `companion`. That
scope was **too narrow** and the pre-panel fact-check caught it: `server/scripts/` was never
scanned and holds a live consumer. Import extraction is also structurally blind to path
literals, which is how a second consumer hid. Both are now in the edit set (proposal Impact);
the lesson is recorded in D4 and the review log, because the same blindness will recur in
step 4b:

```
server/src/node/          11 prod files  2011 LOC
  ├─ config.ts · systemClock.ts · presence.ts          168 LOC  ← what CLAUDE.md says node/ is
  ├─ deepgram · audioMerge · transcriptRemap                    ← transcription
  │  transcriptGenerationLock · generateTranscript    1252 LOC
  └─ ytdlp · youtubeImportGuard · youtubeImportScratch 591 LOC  ← media import

server/src/logImport/      6 prod files   741 LOC              ← Sheets log import
```

Between the three clusters there is **exactly one** production import edge, and it is not
where the ledger expected it:

```
logImport/runSessionLogImport.ts
  ├─ ensureTimedTranscript()   async coordinator: calls generateTranscriptWords,
  │                            classifies TranscriptGenerateError, retries once   ← THE edge
  └─ runSessionLogImport()     the service: takes `transcript` PRE-RESOLVED,
                               imports nothing from transcription

routers/logImport.ts:115-132   already calls the two in sequence, holding every argument
```

Everything else already coordinates in routers: `transcribe.ts` drives transcription *and*
the AI runtime; `sessions.ts` drives media import; `logImport.ts` drives log import. The
router-as-orchestrator pattern is not being introduced here — it is being completed.

**Constraints inherited and verified, not re-derived:** frozen HTTP/WS contract; single Node
process; hub RPCs synchronous and transactional; boundary enforcement lives in
`packageBoundaries.repo.test.ts` (extended, never forked) with deltas landing in the phase
that needs them; facades stay property-style function types; `appEnv.ts` names zero concrete
persistence classes and `node/config.ts` is the sole production namer; L1 siblings never
import each other; `catalog` has no `better-sqlite3`; single-copy gates parse `npm ls` JSON
because exit codes lie; integration tests stay under `server/src/`; packages never import the
app harness; `fakeClock` duplicate-per-package is final policy; `web-docs` is a production
consumer of any module move.

## Goals / Non-Goals

**Goals:**

- Three service packages whose independence is a **test-enforced layer property**, not a
  convention that happens to hold today.
- `server/src/node/` reduced to what its own documentation claims it is.
- The one service→service edge inverted into the router that already sequences it.
- The log-import job store's standing Clock violation closed rather than carried into a
  package, where the baseline spec's scenario explicitly reaches.
- The architecture atlas made true about all three clusters — including the two external-system
  relationships whose `from` endpoint the evidence gate cannot check.

**Non-Goals:**

- `auth` (not a logical service — see proposal Non-Goals), `ai-runtime` (its own change), any
  handler body, `Config` slicing, and `transcriptGenerationLock`'s display-only `Date.now()`.
- Any observable behavior change. This change is a move plus two narrowly-scoped seam fixes.

## Decisions

### D1 — A new L2 "service" layer with a **flat** sibling rule, enforced independently of `ALLOWED_LAYER_EDGES`

A service package may import L0 (`domain`, `contract`, `ports`) and L1 (`session-core`,
`catalog`, `storage`) and **nothing else** — in particular, never another service package.

```
L0   domain      contract    ports
L1   session-core   catalog   storage          siblings: never each other
L2   transcription  media-import  log-import   siblings: never each other
app  server/src/{routers, ai-runtime, middleware, node, aiV2, test} + root
```

Actual edges after the change:

```
@autologger/transcription -> domain, ports, session-core     (NOT contract — verified absent)
@autologger/log-import    -> domain, ports, session-core
@autologger/media-import  -> (none — Node stdlib only)
```

An `ALLOWED_LAYER_EDGES` entry for an edge no file actually has is itself a defect, so this
set is exact rather than permissive.

`media-import` sits at L2 by **role**, not by need: it imports no workspace package at all.
Placing it lower would say something false about what it is, and the layer's meaning is
"a feature the app composes", not "a set of allowed imports it happens to use".

**The layer definition is a gloss on three named members, not a universal quantifier.** The
delta names `transcription`, `media-import`, and `log-import` and describes what makes them
services; it does **not** say "everything service-shaped SHALL be a package". The panel
showed why that distinction is load-bearing: the baseline already requires the AI runtime to
live at `server/src/ai-runtime/` *and* to take its collaborators by injection, so a
universally quantified SHALL would leave the durable baseline — the only artifact that
survives archive — carrying an unsatisfiable pair, and would license "fixing" `auth` too,
since the reasons for excluding it live in a proposal Non-Goal that does not sync.

**Enforcement is four checks, not one.** The panel built and ran the bypass that defeats a
single direct-edge check, so the mechanism is sized to the claim:

1. **Direct sibling rule**, built independently of `ALLOWED_LAYER_EDGES`, mirroring the L1
   construction.
2. **No L1 package imports an L2 package.** This is the one that matters: adding a single
   `@autologger/session-core->@autologger/media-import` entry and re-exporting through
   `session-core` laundered a `transcription → media-import` dependency past check (1) with
   the full boundary test green — observed, not theorized.
3. **Transitive reachability** between service packages, not merely direct edges.
4. **The file walk covers `.mts`/`.cts`.** `walkTsFiles` matches `.ts` only, and those
   extensions are equally invisible to the package `tsconfig` include and to the atlas — a
   cheaper escape than any recorded dynamic-resolution one, and demonstrated green.

The residual the mechanism **cannot** close is stated rather than claimed: a service that
receives another service's function as an **injected parameter** has no import edge at all.
Since the layer definition itself praises injection, this is a real gap, not a pedantic one.
The previous change had to withdraw a "detect by the property, not one textual shape" claim
for exactly this reason; this one does not make it.

*Alternatives:* placing them at L1 (illegal — they import `session-core`, itself L1);
permitting a declared order among service packages (rejected — it costs one function move to
avoid, and it would make "service" stop meaning "independently deployable", which is the
whole point of the layer); one combined `@autologger/features` package (recreates the
god-directory this campaign exists to retire, one level up).

**Three sibling *directories* under `server/src` instead of packages** — the panel's priced
alternative, and the one the draft failed to record. It is cheaper: roughly 65–80 lines in
the existing boundary test (the primitives all exist — `checkAiRuntimePurity` is already
parameterized by directory), and because `server/src/node/deepgram.test.ts →
server/src/transcription/deepgram.test.ts` is a **same-depth** move, the entire fixture
problem (D4), the two `server/scripts/` edits, and the root-manifest wiring all evaporate.
It is rejected on two grounds. First, step 3's gate ruling **E1** already struck this exact
pattern: an intermediate directory on the way to a package is double churn — import rewrite
twice, a `SERVER_SRC_LAYER_DIRS` entry added then deleted, an atlas component added then
converted. Packages are the campaign's declared terminal state, so going straight there is
right. Second, a directory allowlist confines only the dependencies you thought to name,
whereas a manifest check is closed-world: any *new* undeclared dependency fails. That
closed-world property is the one benefit a directory rule cannot replicate, and it is the
one this change is actually buying.

### D2 — `ensureTimedTranscript` moves **into `routers/logImport.ts`**, not into a new coordinator home

The obvious tidy answer — `routers/coordinators/ensureTimedTranscript.ts` — **fails the gate
`router-directory-decomposition` shipped**: its check (2) requires every production module
anywhere under `server/src/routers/` (recursively) to import `hono`/`hono/*`/`@hono/*` or
`appEnv`. A pure async coordinator imports none of those. So "the router orchestrates" means,
under the rules already in force, *inside a Hono-importing module*.

The function body moves unchanged into `routers/logImport.ts`, which imports `Hono` and
already holds `env.config`, `env.ports.audio`, `getHub`, `ctx`, and the `onProgress` closure
at the call site — so no argument has to be threaded to reach it.

**"No new plumbing" was too glib, and the panel was right to say so.** The *call site* needs
nothing new; the *module* does. `ensureTimedTranscript` calls `timedTranscriptTokens` three
times and its signature names `TranscriptToken`, `SessionHubFacade`, `TimecodeCtx`, `Config`,
and the blob-store type — none of which `routers/logImport.ts` imports today. The move adds
roughly eight imports and a new `routers/logImport.ts → @autologger/transcription` edge, and
it forces `timedTranscriptTokens` and `TranscriptToken` onto `@autologger/log-import`'s
public surface. `timedTranscriptTokens` then becomes an export with **no remaining in-package
caller** — its only two uses leave with the coordinator. All of this is legal and none of it
changes behavior, but a reader told "verbatim, no new plumbing" would not expect it, so the
task enumerates it.

**It is an untested seam in the spec's sense.** `ensureTimedTranscript` has no direct test —
it is exercised only through `routers/logImport.int.test.ts`, which does not drive its
retry-once-on-`upstream`/`in_flight` path. `core-ports-architecture`'s "Untested seams gain
characterization tests before reshaping" therefore applies: the retry path is pinned
**before** the move, not after, even though the move itself is verbatim.

*Alternatives:* amending check (2) with a coordinator exemption (reopens a rule three
reviewers had to force into existence, to save one function); a new app-level
`orchestration/` directory (mints a layering directory and a `SERVER_SRC_LAYER_DIRS` entry
for a single function); leaving the edge and permitting L2→L2 (defeats D1 for ~60 lines).

### D3 — `jobStore` takes `Clock` as a leading parameter on exactly three functions

```
createLogImportJob(clock, createdByUserId)      pruneJobs + createdAtMs
getLogImportJob(clock, id)                      pruneJobs
setLogImportStatus(clock, id, status, error?)   finishedAtMs — the TTL's basis
appendLogImportLine(id, line)                   unchanged — no time read
clearLogImportJobs()                            unchanged
```

**Seven** production call sites (`createLogImportJob` ×1, `getLogImportJob` ×1,
`setLogImportStatus` ×5), all in `routers/logImport.ts`, which already holds
`c.env.ports.clock`; `appendLogImportLine`'s 11 further call sites are untouched. The
`globalThis`-keyed map and its `tsx watch` re-eval rationale are
preserved byte-for-byte: the singleton's identity is the thing the
`package-architecture` singleton requirement protects, and nothing about clock injection
touches it.

`jobStore.test.ts`'s ~30 call sites update mechanically and the suite **gains** what it
cannot express today — deterministic control over terminal-TTL pruning and cap eviction.
`@autologger/log-import` gets its own `fakeClock` copy (the fourth), per the final
duplicate-per-package policy. The existing three copies are **functionally identical, not
byte-identical** — each carries its own provenance-comment header, and the fourth
legitimately will too.

*Alternatives:* a constructed `LogImportJobStore` class holding the clock (the `globalThis`
key exists precisely to survive module re-eval, so an instance would need the same treatment
— more surgery, no gain); a module-level `setClock()` (hidden mutable global state, the shape
`core-ports-architecture` forbids for the JWKS cache); leaving `jobStore` in the app (ships a
log-import service without its own job lifecycle, and leaves the violation standing a fourth
time).

### D4 — Fixtures move with the service that owns them, addressed by an exported directory constant

Three fixtures are used on **both** sides of the move, and all four moving tests reach them
by paths that are not depth-invariant:

| fixture | size | moving user | staying user |
|---|---|---|---|
| `test/fixtures/audio/` (10 files) | 868K | `audioMerge.test.ts:23` | `transcribe.int.test.ts:645` |
| `deepgram-enrichment-response.json` | 44K | `deepgram.test.ts:22`, `transcriptRemap.test.ts:25` | `transcribe.int.test.ts:961` |
| `fake-ytdlp.mjs` | 12K | `ytdlp.test.ts:36` | `sessions.youtubeImport.int.test.ts:49` |

A **fourth** reader exists that no import scan can see and no gate covers:
`server/scripts/capture-deepgram-fixture.mjs` regenerates
`deepgram-enrichment-response.json` from `audio/deepgram-enrichment-source.mp3`, addressing
both by `import.meta.dirname`-relative literal. Being `.mjs`, it is outside tsconfig's
`scripts/**/*.ts` include, outside biome's `server/src` scope, and not a component member
type — so a stale path there fails at nobody's gate and surfaces only the next time an
operator regenerates the fixture. It is updated here and verified by execution, and the
general lesson (**path literals are a distinct edit-set class from import specifiers**) is
carried into the task list rather than left to be rediscovered in step 4b.

`audio/` and `deepgram-enrichment-response.json` move to `packages/transcription/fixtures/`;
`fake-ytdlp.mjs` moves to `packages/media-import/fixtures/`. Each package exports a directory
constant, and the staying integration tests import that constant — an **app → package**
reference, the legal direction. This is the `packages/catalog/migrations` pattern (non-TS
assets shipped in a package, addressed by an exported directory const) applied unchanged.
The `fake-claude*.mjs` and `ai-v2-*.mjs` families stay in `server/src/test/fixtures/`; they
belong to the AI runtime and move, if ever, with it.

*Alternatives:* duplicate per package on the `fakeClock` precedent (that precedent is a
30-line source file; here it means 924K of committed binaries, and
`deepgram-enrichment-response.json` is a **captured real DeepGram response** pinning remap
behavior in a unit test and an integration test that must agree — two copies is a live drift
hazard, not a theoretical one); relocate the four unit tests to `server/src/test/` on
step 2's precedent (that precedent is for tests needing the *app harness*; these need none,
and moving them would leave `transcriptRemap.ts`'s 462 LOC with no test inside its own
package, against the "every package covered by root test" requirement); a shared
`@autologger/test-fixtures` package (mints a package for assets when an owning service is
identifiable for each one).

### D5 — Config predicates move on **ownership**, not convenience; the shared network gate stays

All 40 `env.ts` exports were mapped to consumers. Two classes:

- **Forced** — `deepgramConfigured`, `deepgramModel`: read by `generateTranscript.ts` itself.
  They must move or the package escapes to `../env`.
- **Rejected at the gate (E2)** — `resolveYtDlpPath`. The draft moved it on cohesion grounds
  ("PATH probing is media-import's subject") and flagged it as discretionary. The gate ruled
  it **stays**, on a stronger ground than the panel's: `resolveYtDlpPath(procEnv)` probes the
  host's `PATH` with `accessSync` and runs once from `createBindings(procEnv)` at boot. That
  is the composition root's defining job — translating a host environment into configuration.
  A service package should **receive** its configuration, never reach into the deployment
  environment to discover it, so relocating the probe would have inverted the boundary rather
  than tightened it: the composition root decides *where* `yt-dlp` lives, the service decides
  *how* to run what it is handed. The panel's cost findings independently pointed the same
  way — the move would have split a producer/consumer pair whose two halves cross-reference
  each other in `env.ts`'s prose, and given `@autologger/media-import` an export no module in
  that package calls. `env.ts`'s header exception paragraph stays true and stays put.

**Staying:** `youtubeImportOpenNetworkRefused` and `sheetsLogImportOpenNetworkRefused` are
two of the four callers of `env.ts`'s shared `openNetworkRefused()` helper (the others being
`aiChatOpenNetworkRefused` and `aiV2OpenNetworkRefused`). Splitting one cross-cutting policy
across three package manifests would trade a single readable rule for three partial ones.
`ytDlpConfigured` also stays, but for a different reason and **not** as part of that family —
it is `Boolean(env.YTDLP_RESOLVED_PATH)`, a configuration gate with no network semantics,
and it reads the field the composition root populates, so it belongs next to the other
router-consulted `Config` predicates.

*Alternatives considered and rejected:* moving the whole gate family per feature (fragments
one open-network refusal into three partial ones). The alternative of moving nothing
discretionary was not merely considered — it is what the gate **chose**, above.

### D6 — Dependencies follow their **sole** importer; `exceljs` has two, and the rule says so

`undici` → transcription, `mediabunny` → transcription: each imported by exactly one moving
production file, so each leaves `server/package.json` cleanly.

**`exceljs` does not** (gate ruling E1). `routers/logImport.int.test.ts:1` imports it to
build a workbook fixture, and that integration test stays in the app under the standing
"integration tests stay under `server/src/`" invariant. The draft's "nothing else imports
them" was false, and following it would have removed a declaration while a real import
remained — leaving `server/src` resolving `exceljs` purely through workspace hoisting, which
is the failure the package rules exist to prevent, on the one workspace
`checkThirdPartySpecifiers` never scans. So the requirement is scoped to a dependency
imported by **exactly one** service, and `exceljs` is declared by both the package and the
app. The alternatives — rewriting a frozen-surface integration test off ExcelJS for
architectural tidiness, or moving it into the package against the invariant — both cost more
than the rule is worth.

**The confinement claim is narrowed to what is true.** The draft said this makes dependency
confinement "a manifest-level fact the boundary repo test already checks".
`checkThirdPartySpecifiers` walks `packages/*` only; nothing compares `server/package.json`
against the server's own imports, so after this change an app module could still
`import { Agent } from 'undici'` with every gate green. What the rule delivers is
**declaration-side** confinement, and the delta says exactly that rather than the stronger
thing.

The `peerDependency` treatment `zod`, `better-sqlite3`, and `jose` carry exists for
dependencies whose **duplicate installation** would break a nominal `instanceof` across a
boundary. No app code does `instanceof` on any `undici`, `mediabunny`, or `exceljs` type.
Cross-boundary `instanceof` *does* happen on **package-owned** classes —
`routers/transcribe.ts:59,157` checks `TranscriptGenerateError`, which will be defined in
`@autologger/transcription`. That is the pattern `@autologger/storage`'s `InvalidRangeError`
already runs in production (`app.ts:73`, `routers/audio.ts:194`), pinned through the real app
by **`routers/flows.int.test.ts`**'s zero-byte-suffix-Range 416 case — *not* by
`crossPackageErrorIdentity.int.test.ts`, which pins only `ZodError`→422 and
`ValidationError`→400. Single workspace resolution makes the pattern sound; the new pins
follow `flows.int.test.ts`'s shape rather than assuming.

**Every newly cross-boundary class gets a pin, not just the first one.** The draft's single
scenario would have been satisfied by pinning `TranscriptGenerateError` alone. The full set:

```
TranscriptGenerateError   routers/transcribe.ts:59, :157        (existing)
                          routers/logImport.ts ×3               (arrive with D2's coordinator)
YtDlpError                routers/sessions.ts:570               (existing) — its own header
                          says "callers branch on nothing but instanceof YtDlpError"
```

### D7 — The atlas has **three** drift dimensions, and the gate can check none of them

`web-docs/model/components.ts` gains `transcription` and `media-import` components — **two,
not three.** A `log-import` component **already exists** at line 193, globbing
`server/src/logImport/**`; the correct operation is to **re-glob** it to
`packages/log-import/src/**` and revise its description (the coordinator half leaves under
D2), not to add one. `checkCoverage` has neither a duplicate-name check nor an
empty-component check, so an "add" would leave either a duplicate id or a component matching
zero files, silently green. `node-infra`'s globs narrow to the three files that remain, and
its description — which still claims it holds "the blob store, kv-on-sqlite, the migrator",
all of which left for `@autologger/storage` in step 2 — is corrected in the same edit.

Two external-system relationships have evidence files that move, so their **`from` endpoint
must move with the evidence**:

```
node-infra-to-deepgram   evidence server/src/node/deepgram.ts  →  from: 'transcription'
node-infra-to-yt-dlp     evidence server/src/node/ytdlp.ts     →  from: 'media-import'
```

`checkRelationshipEvidence` verifies only that the evidence file exists and contains the
literals — never that it belongs to the `from` component — so re-anchoring alone passes green
while the atlas keeps asserting `node-infra` talks to DeepGram and yt-dlp. This is step 3's
D8 hazard recurring verbatim; the delta pins the `from`-endpoint property because the gate
cannot. `node-infra-to-catalog-database` and `node-infra-to-blob-store` anchor on
`config.ts`, which stays, and are correct unchanged.

**And the third dimension, which step 3 never had to face: `capabilityScopes`.** Three
entries attribute moved features to the composition root:

```
components.ts:765  transcript-generation  ['routers','node-infra','session-core','web-app']
components.ts:790  youtube-audio-import   ['routers','node-infra','web-app']
components.ts:748  sheets-log-import      ['routers','log-import','node-infra','web-app']
                   — with an inline comment "node-infra: reuses the existing DeepGram
                     generate path", which becomes `transcription`
```

`capabilities.ts` validates only that every baseline capability is accounted for exactly once
and that each named component **exists** — never that the named component contains the
implementing code. So all three go false with `docs:check` green. The design congratulated
itself for catching the relationship case and then missed the structurally identical
capability case; the panel caught it. All three are updated in the phases that move the code,
and the delta pins the property for the same reason it pins the `from` endpoint: no gate can.

`edges.snapshot.json` (**not** the git-ignored `atlas.json`) is regenerated and reviewed per
edge with attribution.

### D8 — A module move is **atomic with everything that makes it legal**, not merely preceded by the allow-edge

Boundary-test deltas land **with** the code they govern, never after. The draft applied that
rule to `ALLOWED_LAYER_EDGES` and stopped there; the panel executed the plan against the live
checks and found **three red-gate windows**, each between two tasks the draft had put in
separate units:

1. Moving transcription while `generateTranscript.ts` still imports `../env` and `../appEnv`
   → two `escape` violations plus a hard `tsc` failure, unfixed until three tasks later.
2. Moving any module before its package manifest declares the third-party **and
   `@autologger/*`** dependencies it imports. **No task declared the `@autologger/*`
   dependencies at all** — the draft inherited half of step 2's lesson, which covered layer
   edges but not manifests. `checkPackagesBoundary`'s undeclared-dependency check is separate
   from its layer-edge check, so this was red at two phases and never fixed by the plan.
3. Emptying `server/src/logImport/` two tasks before removing it from
   `SERVER_SRC_LAYER_DIRS` → `enumeratedButEmpty` fires in between.

So the rule is stated more strongly: **the unit that moves a module also lands its manifest
declarations, its specifier rewrites, and its enumeration edits.** A phase may not pass
through a state where the gates are red, because the apply protocol runs `npm test` per
dispatch unit and a knowingly-red unit trains the implementer to ignore failures.

The irony of (3) is worth recording: `server/src/logImport/`'s disappearance is exactly what
step 3's non-vacuity check was built to catch, and the draft scheduled the deletion so the
check would fire as a **false alarm** mid-phase rather than as a backstop. The check keeps
its job; the ordering changes. Its demonstration — temporarily restoring the entry to observe
the failure — is kept as ledger evidence, run after the phase is green rather than during it.

## Risks / Trade-offs

- [A 25-file move diff visually masks a semantic edit] → mechanical `git mv` + specifier
  rewrites land as their own commits, separate from the three narrow semantic edits (Clock
  injection, `ensureTimedTranscript` relocation, `BlobStore` type fix), so review can
  diff-scan the wide commits and read the narrow ones.
- [Fixture path rewrites are invisible to every import-specifier check in the repo] → the
  four affected paths are enumerated in tasks by content, and each package's test run is the
  proof; a path left stale fails loudly at read time rather than passing quietly.
- [The `.mts`/`.cts` walk widening touches a primitive five other checks share] → the
  widening lands with mutation coverage over each affected check, and the existing checks'
  real-repo assertions are re-run to confirm no new violation surfaces from files that were
  previously invisible.
- [Clock injection changes `jobStore`'s public signatures, and its 30-site test rewrite could
  mask a behavior change] → the TTL/eviction behavior is pinned by the existing suite before
  the signature change, and the rewrite is mechanical parameter threading with `systemClock`
  producing identical production values.
- [`ensureTimedTranscript`'s retry path is untested today and moving it could lose behavior]
  → characterized before the move (D2), not after.
- [Successor stalls, leaving a hybrid layout] → this change is self-consistent alone: three
  enforced service packages plus a `node/` that matches its documentation is a strict
  improvement whether or not `ai-runtime` ever follows.
- [The server app's own manifest is unscanned] → the boundary repo test verifies that a
  *package* declares what it imports (third-party specifiers, `ALLOWED_LAYER_EDGES`); it does
  not scan `server/`'s sources against `server/package.json` in either direction — a
  third-party import the server uses without declaring, or (discovered in this change's
  phase-5 fix wave) a workspace package the server imports without declaring in
  `dependencies`, both resolve silently through npm's root-level workspace hoisting rather
  than failing loudly. This change hand-fixed the three missing `@autologger/*` declarations
  (`log-import`, `media-import`, `transcription`) it introduced across phases 3–5; a successor
  could close the gap generally with a server-side manifest check analogous to
  `checkThirdPartySpecifiers`, scoped to `server/src` against `server/package.json`.

## Migration Plan

Pure source restructuring — no data migration, no deployment step, no rollback concern beyond
reverting the branch. `DATA_DIR` layout, the catalog schema, and session DBs are untouched.
The frozen contract is untouched by construction; the always-running integration pins
(fixture conformance chain, 416/422/400 error identity) are the guard.

## Open Questions

- ~~Does `@autologger/transcription` import `@autologger/contract`?~~ **Closed by the
  fact-check pass:** no file in the transcription set imports `contract`
  (`transcriptRemap.ts` → `domain`; `generateTranscript.ts` → `ports` + `session-core`). D1's
  edge set is exact.
- Should the two staying integration tests import the fixture-dir constant, or should the
  packages export the individual file paths? Directory constant is the `catalog/migrations`
  precedent; per-file constants would be more type-safe and more churn. Deferred to the
  phase, as it changes no requirement.

## Invariants a future reader must not "helpfully" undo

- All step 1–3 invariants remain in force: single process; hub RPCs synchronous and
  transactional; `create_event` handler zero-`await`; facades property-style function types;
  `appEnv.ts` names zero concrete persistence classes; `node/config.ts` sole production
  namer; `createCatalog` + `init()` per-request; L1 siblings; `server/src/ai-runtime/`
  Hono-free; `ApiError` at app root; the layering enumeration complete **and** non-vacuous;
  no permanent re-export shims; integration tests stay under `server/src/`.
- **Service packages never import each other** (D1), and the checks enforcing it stay
  independent of `ALLOWED_LAYER_EDGES` — folding them into that set is the exact regression
  the independence exists to prevent. The **no-L1→L2** check is not redundant with the
  sibling check: it closes the only launder route the layer graph permits, and the panel
  observed that route running green without it.
- **`server/src/node/` membership is pinned by name** (D8's companion rule in the MODIFIED
  directory-roles requirement). Restoring that directory's documented role without a
  mechanism would schedule the identical drift — the role went false in the first place
  because nothing checked it, which is this change's own headline grievance.
- **The layer definition stays a gloss on named members**, never a universal quantifier. A
  universally quantified "every service SHALL be a package" contradicts the baseline
  requirement that places the AI runtime under `server/src/` and would license "fixing"
  `auth`, whose exclusion is argued only in a proposal Non-Goal that does not sync.
- **`routers/` membership check (2) is not amended** to admit non-Hono coordinators (D2).
  Cross-service orchestration lives inside Hono-importing modules until a change argues
  otherwise on its own merits.
- **`jobStore`'s `globalThis` key and its `tsx watch` rationale survive the move** (D3). Its
  purpose is single-instance identity across module re-eval; a "cleaner" module-local `Map`
  reintroduces the 404-mid-job bug it was written to fix.
- **The `deepgram`/`yt-dlp` relationships' `from` endpoint must remain the service
  component** (D7) — the evidence gate cannot catch a regression here.
- **`transcriptGenerationLock.tryAcquire`'s `Date.now()` default is deliberate** and was
  examined, not overlooked. The precise property — checked by reading `tryAcquire`,
  `getLock`, `release`, `generationInFlightDetail`, and every consumer of
  `getLock()`/`startedAtMs` — is that **no control flow, expiry decision, eviction ordering,
  or persisted state depends on the value**; the lock never expires by time and is cleared in
  a `finally`. It is *not* true that the value only formats a message:
  `GET /api/transcript-generation/status` serializes it as the **frozen** `started_at` field.
  That makes converting it strictly riskier, not safer — an observable field would be moved
  onto a different time source to satisfy a textual scan no requirement is asking about.
- This change edits **no handler body**, and `env.ts`'s shared open-network refusal stays
  whole (D5).

## Panel & review log

- **2026-08-07 — pre-panel fact-check pass** (light-tier reviewer, against live `main`
  `f8ceaed`). 39 claims enumerated **as properties to verify**, never as lines to confirm:
  **34 CONFIRMED, 1 CORRECTED, 3 FAILED, 1 confirmed-with-caveat**, 0 left
  unverifiable-mechanically. Judgment-laden material — whether services are the right
  decomposition, whether `auth` is correctly excluded, whether the discretionary
  `resolveYtDlpPath` move is warranted (D5), and the D4 fixture-ownership trade — was **not**
  submitted to this pass and reaches the panel **un-vouched**. Method notes: the router-membership
  matcher was verified by **executing** it against three synthetic trees (a non-Hono
  coordinator is flagged; the same file importing `appEnv` or `hono` is clean), not by reading
  it; `fakeClock` copies were compared by **hashing**, not by name; function-level claims were
  answered by reading whole function bodies plus callees on the claim-relevant path.

  **Corrections folded into all four artifacts:**
  - *Call-site count wrong.* The three clock-taking job-store functions have **7** production
    call sites, not 6 (`setLogImportStatus` alone has 5); `appendLogImportLine` has **11**,
    not 12. Fixed in the proposal, D3, and task 5.2.
  - *Wrong grouping.* `ytDlpConfigured` is **not** built on the shared `openNetworkRefused()`
    helper — it is `Boolean(env.YTDLP_RESOLVED_PATH)`, a configuration gate with no network
    semantics. Only `youtubeImportOpenNetworkRefused` and `sheetsLogImportOpenNetworkRefused`
    belong to that family (alongside the two AI ones). D5 rewritten.
  - *Edit set under-counted, and the method claim was overstated.* The scan covered
    `server/src`, `web/src`, `e2e`, `companion` — **not `server/scripts/`**, which holds
    `merge-session-audio.ts`, a live `npm run merge-audio` CLI importing `mergeAudioSegments`.
    Nine files, not eight. This is the third consecutive campaign change in which the edit set
    was under-counted at draft time.
  - *Wrong citation.* `crossPackageErrorIdentity.int.test.ts` pins only `ZodError`→422 and
    `ValidationError`→400; the `InvalidRangeError` cross-package pin actually lives in
    `routers/flows.int.test.ts`. D6 re-pointed.
  - *Over-precise word.* The three `fakeClock` copies are **functionally** identical, not
    byte-identical — each carries its own provenance header. D3 softened.
  - *Open Question closed on evidence rather than left open:* no transcription-set file
    imports `@autologger/contract`, so D1's edge set is exact.

  **Found by the author while verifying the pass's own findings — a tenth edit-set member the
  pass's method could not have found.** `server/scripts/capture-deepgram-fixture.mjs`
  addresses **both** moving transcription fixtures by `import.meta.dirname`-relative path
  literal, and being `.mjs` it sits outside tsconfig's `scripts/**/*.ts` include, outside
  biome's `server/src` lint scope, and outside the component model — **no gate in the repo
  would catch a stale path in it.** Recorded in D4 with the general lesson that path literals
  are a distinct edit-set class from import specifiers, which no import scan can enumerate.

  **Warrant correction.** The pass's `startedAtMs` finding materially changed a normative
  claim rather than merely a number: `GET /api/transcript-generation/status` serializes that
  value as the **frozen** `started_at` field, so the draft's "used solely to format a
  human-readable message" was false. The `core-ports-architecture` carve-out was rewritten to
  state the property that is actually true and checkable — nothing branches, expires, orders,
  or persists on the value — and the invariant now notes that the field is contract-bearing,
  which makes converting it riskier rather than safer. A carve-out written on the original
  wording would have licensed exactly the wrong thing.

- **2026-08-07 — adversarial panel** (4 heavyweight reviewers, distinct mandates —
  requirements / assumptions / failure & abuse / scope & simpler design — skeptical
  calibration, empirical probes run with the repo's own toolchain). **All four returned "do
  not gate as-is."** Unlike step 3, no reviewer found the justification false; the convergent
  root cause was that **the plan's model of the repo's own gates was wrong**, in ways that
  fail *silently*. Nine blockers, all verified by the author against live code before folding.

  **Blockers/majors fixed in place:**
  - *The package test/typecheck enumeration is root `package.json`, not
    `server/vitest.config.ts`* (3 reviewers). That file holds only the server's `unit` and
    `integration` projects over `src/**`; package coverage is `&&`-chained in the root
    manifest, which appeared in **no** artifact. Following the draft, the three packages
    would never be tested or typechecked **while every phase gate reported green** — whole-
    package vacuity, and a breach of the baseline's "every package covered by the root
    commands". Root `package.json` added to the edit set; task rewritten against the real
    mechanism.
  - *`exceljs` cannot leave `server/package.json`* (3 reviewers) — `routers/logImport.int.test.ts`
    imports it and stays. Escalated as E1; see below.
  - *A `log-import` component already exists* (2 reviewers) — two new components plus a
    re-glob, not three new. `checkCoverage` has neither a duplicate-name nor an
    empty-component check, so the draft's "add" would have been silently green. D7 rewritten.
  - *`capabilityScopes` is a third atlas drift dimension* (2 reviewers) — three entries
    attribute transcription, YouTube import, and Sheets log import to `node-infra`, and
    `capabilities.ts` verifies only that a named component *exists*. D7 congratulated itself
    for catching the structurally identical relationship case and missed this one.
  - *The Clock carve-out exempted the canonical session live-timecode read* (requirements).
    `transportStore.ts:19` feeds `core.now()` into `transportTimecode`, serialized into the
    frozen `timecode`/`timecode_total_frames` — nothing branches, expires, orders, or
    persists on it, so the carve-out as written declared it "not a decision-making read"
    while sentence 1 of the same requirement enumerates live-timecode as covered. **A
    loosening that licensed exactly the wrong thing**, in the delta — the artifact that
    syncs. Bounded to reads outside the enumerated classes; "SHALL NOT be converted" softened
    to "need not".
  - *"Eviction ordering" is not a time read* (requirements) — the size-cap sweep walks Map
    insertion order. The draft scenario asked for it to be exercised by advancing a clock,
    which is impossible; it needs 201 jobs. Dropped from the enumeration and given its own
    correct scenario.
  - *The flat rule was unenforceable as specified* (failure & abuse, executed; requirements
    independently). The "survives an edit to the allowed-edge set" scenario was true **by
    construction** — unfalsifiable. And one L1→L2 entry plus a `session-core` re-export
    laundered a sibling dependency past the check with the full boundary test **green**.
    Separately, `.mts`/`.cts` files evade every gate in the repo. Escalated as E5 and ruled:
    four checks, plus the injection-shaped residual stated rather than claimed.
  - *Three red-gate windows in the phase ordering* (failure & abuse, executed) — including
    that **no task ever declared the packages' `@autologger/*` dependencies**. D8 rewritten
    from "enforcement lands with the code" to "the move is atomic with everything that makes
    it legal".
  - *`server/src/node/`'s restored role was a SHALL with no mechanism and no scenario*
    (requirements) — the change's own headline grievance, re-encoded unenforced. Membership
    check + scenario added to the MODIFIED directory-roles requirement.
  - *The "service" definition was universally quantified* (requirements) — it contradicted
    the baseline requirement placing the AI runtime under `server/src/` and would have
    licensed "fixing" `auth`. Demoted to a gloss on three named members.
  - *Four clauses and two scenarios duplicated the baseline* (scope) — a requirement that
    restates an existing one creates two homes for one rule and invites drift, which is this
    change's own argument for adding no new capability. Deleted. A `MODIFIED` block the
    author had written over the nominal-identity requirement was **reverted entirely**: it
    had dropped baseline detail (the class enumeration, the `zod`/`better-sqlite3` peer
    declarations) and invented a universal "peer only where `instanceof`" that the same
    reviewer flagged. Its genuinely new content moved to an `ADDED` requirement.
  - *Edit set under-counted for the fourth time* (4/4 reviewers) — `server/src/env.test.ts`
    asserts the moving predicates. Missed because the scan looked for consumers of *moving
    modules*, and `env.ts` does not move; only its exports do. Recorded as a third edit-set
    class alongside import specifiers and path literals.
  - *Minor corrections folded:* only the first cross-boundary error class was pinned
    (`YtDlpError` and three new `TranscriptGenerateError` sites added); `git mv` + "verify by
    blob hash" is self-contradictory unless the pure move is its own commit; task 5.2 must
    thread the **captured** `env`'s clock, since five of seven call sites run in the detached
    post-response closure; D2's "no new plumbing" understated ~8 added imports and an orphaned
    export; the log-import `fakeClock` needs a `TEST_INFRASTRUCTURE_EXEMPTIONS` entry in the
    same phase; an empty `src/` fails `tsc` at scaffold time.

  **Escalated to the gate, with rulings (2026-08-07):**
  - **E1 — `exceljs`.** RULED: narrow the rule to a dependency imported by **exactly one**
    service; `exceljs` is declared by both the package and the app. Rewriting a frozen-surface
    integration test off ExcelJS, or moving it into the package against the "integration tests
    stay under `server/src/`" invariant, both cost more than the rule is worth.
  - **E2 — `resolveYtDlpPath`.** RULED: **drop the move** — reversing the draft. The panel
    argued cohesion; the gate ruled on a stronger ground, that `PATH` probing from
    `createBindings(procEnv)` is composition-root work, and a service receives its
    configuration rather than discovering it from the host environment.
  - **E3 — root `package.json` in scope.** RULED: yes, forced by the B1 finding.
  - **E4 — mandate.** RULED: **held**, three packages. The panel found no false premise, and
    narrowing to one package would ship the newly-chosen sibling rule in the one configuration
    where it cannot be tested against real code — an empty pair set is the enumerated-but-empty
    vacuity this repo already legislated against. The scope reviewer's "do only the
    corrections" lower bound (~100 LOC) was considered and declined: it leaves the service
    boundaries exactly as enforced as they are today, which is not at all.
  - **E5 — flat-rule enforcement depth.** RULED: add the L1→L2 prohibition and transitive
    reachability, rewrite the unfalsifiable scenario, and state the injection-shaped residual
    honestly.
  - **D1's missing alternative.** RULED: keep packaging, and **record** the three-directories
    alternative with its price (~65–80 lines, and D4's whole fixture problem evaporates) and
    its rejection on step 3's E1 grounds plus the closed-world manifest property.

  **Minors accepted as residual:** `createRequire` / non-literal dynamic `import()` / `eval`
  bypasses (stated, not closed — the standing posture for this family of guard); a hardcoded
  membership constant means a future fourth service package must be added to it by hand
  (mitigated by the non-empty + members-exist assertions, not eliminated); `TranscriptGenerationLock`
  becomes importable package surface via the `"./*"` export map; the retry characterization
  adds real elapsed seconds to the unit tier unless written with fake timers;
  `packages/ports/src/config.ts:88` and `packages/session-core/src/SessionHub.ts:63` carry
  prose naming old paths (cosmetic, in the stale-comment class this campaign tracks).

- **2026-08-07 — post-gate delta-spec review** (heavyweight, scoped to the two delta specs
  only; commissioned because three panel blockers landed *inside* the normative text and its
  repair was real surgery, and only the delta syncs to the baseline). Verdict: **specs need
  fixes**. All eight panel findings confirmed landed — the Clock carve-out is now conjunctive
  and the reviewer could not construct a reading that exempts `transportStore.ts`'s
  live-timecode read; the service definition's demotion to a gloss is airtight; all three
  MODIFIED blocks are strict supersets of their baselines with no scenario dropped, narrowed,
  or reworded. **Nine new defects introduced by the fold-back**, all fixed in place:
  - *The third-party rule re-mandated what gate ruling E1 forbade.* "Imported by **only one
    service package** … SHALL NOT remain declared by the server app" applies on its face to
    `exceljs`, ordering the exact deletion E1 ruled against — in the artifact that syncs.
    The antecedent is now **repository-wide importer count**, never service count, stated
    explicitly to foreclose the reading.
  - *A MODIFIED block re-published "the branch diff over routers is import-only",* which this
    change's own task 5.1 breaks by relocating `ensureTimedTranscript` into
    `routers/logImport.ts` and threading `Clock` through seven call sites. Scenario amended to
    admit coordination relocation and port threading a change's own delta authorizes.
  - *The atlas scenario's disclaimer covered two of four clauses,* implying by contrast that
    empty-glob and distinctness **are** machine-checked. They are not — the coverage gate
    implements only orphan, overlap, and bare-root-glob detection. All four now disclaimed.
  - *`server/src/node/` membership was escapable one directory deeper* — "directly under"
    left `server/src/node/<feature>/` invisible to both that check and the top-level-only
    layering enumeration, so the exact documented drift could recur with green gates, in a
    rule whose entire justification is that its predecessor went false unchecked. Now
    recursive.
  - *The transitive-reachability scenario could not distinguish its check's presence from its
    absence* — every chain it described was already caught by check 1 or check 2. It now
    requires an **L0** intermediate, the only route check 3 uniquely closes.
  - *"These rules SHALL be enforced by the boundary repo test" had been generalized* from the
    baseline's "these three rules" and now scooped up the cross-feature-coordination rule,
    which no scan computes. Enumerated explicitly; the coordination rule's enforcement is
    scoped to couplings that take the form of an import edge.
  - *"Every import specifier from a service package resolves to an L0 or L1 package" is
    literally false* — service packages import `undici`, `mediabunny`, `exceljs`, and `node:*`.
    Scoped to workspace-package specifiers.
  - *The carve-out silently hardened two standing `Date.now()` sites* — `SessionHub`'s
    `DEFAULT_CLOCK` and the AI runtime's kill-ladder deadline, the latter control-flow-bearing
    and therefore **not** exemptible. Both named as known standing exceptions, with the kill
    ladder assigned to the change that packages the AI runtime.
  - *"The reasoning SHALL be recorded" had no home surviving archive.* Exemptions must now be
    named in the delta; `transcriptGenerationLock`'s is named inline, with a scenario.

  **Adopted beyond the fixes:** the reviewer's highest-value optional finding — that the
  baseline requirement describes package coverage as "explicitly enumerated vitest projects",
  which is true of the server's two tiers and **false of packages** (they are `&&`-chained
  workspace invocations in the root manifest) — is the mis-description that produced the
  panel's top blocker in the first place. That requirement is now MODIFIED to describe both
  mechanisms accurately and to forbid adding package projects to the server's vitest config,
  with a scenario requiring a deliberate failing test **and** a deliberate type error to prove
  a new package joined both root chains.

- **2026-08-07 — post-gate consistency read** (light tier, all four artifacts, plus `tasks.md`
  read to verify phase/decision coherence). Verdict: **findings**, four, all stale traces of
  the E2 reversal and all fixed: the proposal said "three of its exports" leave `env.ts` (two)
  and "three package-owned error classes" (two); a Risks bullet still framed
  `resolveYtDlpPath` as "a discretionary move the panel may reject" after the gate had ruled
  it out; and D5's *Alternatives* line still said "move nothing discretionary … is flagged for
  the panel" two paragraphs below the ruling that chose exactly that. The reader's checklist
  confirmed the other eight late decisions consistent across all four documents. One
  out-of-scope observation carried forward for verification during apply: the singleton
  requirement enumerates the "DeepGram shared dispatcher", and `deepgram.ts` moves in this
  change — its single-instance semantics are covered by the relocated-singleton scenario, but
  worth confirming at phase 4 rather than assuming.
