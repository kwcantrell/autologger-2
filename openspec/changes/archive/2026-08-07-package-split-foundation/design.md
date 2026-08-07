# package-split-foundation — Design

## Context

Exploration (2026-08-07) mapped both workspaces' coupling exhaustively. The load-bearing
facts this design builds on (fact-checked against live `main` post-PR#4; see Panel &
review log):

- `server/src/types.ts` (133 lines) imports nine names from eight modules purely to name
  `Ports` — six of them concrete classes (`Catalog`, `BlobStore`, `CatalogDb`, `KvStore`,
  `PresenceRegistry`, `SessionHubRegistry`; `Clock` and `IdentityVerifier` are already
  interfaces, `AuthUser` a type alias) — and has 25 production importers: every router
  type-depends on every subsystem. `env.ts` (16 importers) drags the same closure.
- The repo has **zero file-level import cycles** and two directory-level cycles:
  `session ⇄ aiV2` (`session/dashboardStore.ts` → `aiV2/catalog.ts` while
  `aiV2/aggregates.ts` → `session/{topicStore,transcriptStore}`) and `auth ⇄ node`
  (`auth/identity.ts` → `node/kvStore` type import; `node/config.ts` →
  `auth/oauth_google`). D4 breaks the first structurally; D3 breaks the second as a
  designed consequence (auth's only `node/` import is the `KvStore` *type*).
- `studio.ts` and `timecode.ts` have zero imports; `db/shared.ts` is documented
  cycle-free shared types. They are already package-shaped.
- `create_event` performs a read-filter-anchor-insert sequence in
  `routers/aiMcpServer.ts` whose correctness relies on "one synchronous block, never
  held across an await" — comment-enforced today (verified: zero awaits in the handler).
- The server runs `tsx` directly on source (no compile step); web is Vite. Internal
  packages can therefore be source-only.
- **Panel-verified tooling facts (2026-08-07, three independent sandbox replicas with
  the repo's own toolchain):** `tsc -b` project references cannot coexist with no-emit
  packages (TS6310; and a reference makes plain `tsc --noEmit` fail with TS6305 until
  the referenced project builds); plain per-project `tsc --noEmit` with
  `moduleResolution: Bundler` resolves `"exports": "./src/index.ts"` cleanly; npm
  workspace hoisting resolves **undeclared** cross-package imports and `tsc` never reads
  manifest `dependencies`, so the compiler enforces no boundary; a root vitest
  "workspace" **flattens** nested `test.projects` and skips their `setupFiles`;
  `biome.json` enumerates directories and does not cover `packages/**`; the app's error
  handler maps `ZodError` → 422 and `ValidationError` → 400 by `instanceof` (nominal
  identity across package/dependency boundaries).

Campaign decisions (owner, 2026-08-07): fine-grained modular-monolith decomposition;
goals = hard boundaries + future-service seams at transcription / YouTube import / AI
runtime; web keeps hand-written API types (no shared server/web contract package). This
change is step 1 of a ~5-change campaign (foundation → persistence packages → router
surgery → feature packages → web split).

Gate rulings (2026-08-07, recorded in the Panel & review log): SessionToolPort rewiring
deferred to the AI-runtime change; `AppEnv` composed at app level; panel mechanics fixes
adopted.

## Goals / Non-Goals

**Goals:**
- Retire the `types.ts` god-barrel: the injectable ports become interfaces in a
  dedicated L0 package; `AppEnv` is composed at app level with no god-barrel revival.
- Break both directory cycles (`session ⇄ aiV2` via the contract move; `auth ⇄ node`
  via the `KvStore` interface move).
- Establish the workspace-package mechanics — source-only packages, per-project
  typecheck, explicit vitest projects, lint coverage, and **test-enforced** layer
  boundaries — that all successor extractions reuse.
- Upgrade `create_event`'s interleaving invariant from comment-enforced to
  transactional (`SessionHub.createAnchoredEvent`).

**Non-Goals:**
- Any package extraction beyond `domain`/`contract`/`ports` (successor changes).
- SessionToolPort (deferred to the AI-runtime change — see D5).
- Hub/catalog facade interfaces (named residuals — see D3).
- Router surgery, worker processes, web packages, `env.ts` splitting, wire-behavior
  changes of any kind.

## Decisions

### D1 — Source-only workspace packages; per-project `tsc --noEmit`; explicit vitest projects

Packages live in top-level `packages/<name>/` with `"exports"` pointing at `./src/*.ts`,
consumed via npm workspaces. `tsx` (server) and Vite (web, later) resolve TS source
directly. **Typecheck:** per-project `tsc --noEmit` (each package gets a tsconfig; the
root `typecheck` script runs them alongside server/web/companion/e2e). **NOT `tsc -b`
project references** — panel-verified mutually exclusive with no-emit source-only
packages (TS6310/TS6305). **Tests:** the root vitest wiring enumerates projects
explicitly — the server's existing two tiers (unit + integration with
`setup.int.ts`) preserved verbatim, plus one project per package — never a globbing
"workspace" (panel-verified to flatten nested projects and skip `setupFiles`). The
`--project` selectors used by `fixtures:capture` keep working. **Lint:** `biome.json`
`files.includes` and the root lint script gain `packages/**`.

*Alternatives:* compiled packages with declaration emit (adds build-order management and
gitignored artifacts for zero runtime benefit; rejected at gate in favor of dropping
project references); TS path aliases without real packages (no manifests to enforce
against); `tsc -b` (disproven — see Context).

### D2 — Three L0 packages this change: `domain`, `contract`, `ports`

- `@autologger/domain` — `studio.ts`, `timecode.ts`, `db/shared.ts`. Pure logic, zero
  runtime deps.
- `@autologger/contract` — `schemas.ts`, `aiV2/catalog.ts`. May depend on `domain`
  (allowed edge; as implemented it declares no domain dependency — neither module
  references one); `zod` is a **peerDependency** (see D8).
- `@autologger/ports` — interface-only port definitions + the `Config` type. Depends on
  `domain` (and `contract` if a signature needs it). **No runtime implementations**:
  `systemClock` moves to the composition side (`server/src/node/`), so the package stays
  types/interfaces/constants only — no module in it may import from `server/src`,
  transitively.

Allowed inter-package edges: `contract → domain`, `ports → domain`, `ports → contract`.
Nothing in L0 imports from `server/src`.

*Move semantics:* files move (git mv + import rewrites), not re-exported from old paths
long-term. A transitional re-export shim is permitted **within** the change's phases but
must be gone by the final task.

*Alternatives:* one combined `foundation` package (muddies the "contract is the single
home of validation" story; loses domain's zero-runtime-dep property, which is real —
contract carries a zod peer); keeping `systemClock` in ports (sets the precedent that
erodes "interface-only"; panel finding adopted).

### D3 — `types.ts` retired; `AppEnv` composed at app level (gate ruling 2026-08-07)

The five genuinely small port types become interfaces in `@autologger/ports`:
`BlobStore` (~7 methods), `KvStore` (4), `PresenceRegistry` (3), `CatalogDb` (the
existing `all()/run()/tx()` seam), plus the already-interface `Clock` and
`IdentityVerifier`. Concrete classes declare `implements` against them in place.

**What deliberately does NOT move to L0:** `Ports.sessions` typing and
`Variables.catalog`. `SessionHubRegistry.get()` returns the concrete `SessionHub`
(~52 public methods, signatures inferred off L1 stores) and `Variables.catalog` is the
concrete `Catalog` facade (~71 methods over five store classes) — interface-extracting
either is a large migration owned by the session-core and catalog extraction changes
(**named residuals**). Instead, a small `server/src/appEnv.ts` composes the app types:
it extends the package's base ports shape with `sessions: SessionHubRegistry`, declares
`Variables` (`catalog: Catalog`, `user`, `apiTokenAuth`) and `AppEnv`, and is the one
app-level module allowed to name those two concrete types for composition. All former
`types.ts` importers are rewritten (to `@autologger/ports` for port/Config types, to
`appEnv.ts` for `AppEnv`/`Variables`); `server/src/types.ts` is deleted with no
permanent shim. The result: routers no longer type-depend on the blob/kv/presence/
identity implementations; their remaining concrete type edges (hub, catalog) reflect
real request-path usage and are the two named residuals.

The `env`-identity contract (`wireApp` mutates the per-request env in place for
`@hono/node-ws`) is unaffected — only types move; the composition root constructs the
same objects.

Notes:
- `evictIdle` **stays reachable**: tests call it through `env.ports.sessions`
  (`SessionHub.int.test.ts`, `sessions.youtubeImport.int.test.ts` — panel correction of
  an earlier wrong claim), and since `appEnv.ts` types `sessions` as the concrete
  `SessionHubRegistry`, nothing narrows. Interface-narrowing the registry surface is
  part of the session-core residual.
- Moving the `KvStore` interface into the package removes `auth/identity.ts`'s only
  import from `node/`, breaking the `auth ⇄ node` directory cycle (the composition
  root's `node/config.ts → auth/oauth_google` edge remains and is legitimate).

*Alternatives:* keep `types.ts` as a re-export shim (retains the god-barrel);
interface-extract `SessionHub` + `Catalog` now (~123 signatures — rejected at gate as
doubling the change); generic `Ports<THub>` parameterization (ripples through all 25
importers for no boundary gain).

### D4 — `aiV2/catalog.ts` moves to `contract`; the `session ⇄ aiV2` cycle dies structurally

`session/dashboardStore.ts`, `aiV2/mcpTools.ts` (`propose_dashboard`), and `schemas.ts`
all import dashboard validation from `@autologger/contract`. The single-validator
invariant (ai-v2-dashboards) gets a structural home. `aiV2/aggregates.ts` does **not**
move (web's `clientAggregates.pinning.test.ts` imports it by path; moving it is
successor-change work).

### D5 — SessionToolPort: DEFERRED to the AI-runtime change (gate ruling 2026-08-07)

The panel converged on deferral and the gate ruled for it: the first real consumer
(`ai-session-analyst`, gated) normatively requires range/slice parameters on
`get_transcript_words`, paging on `list_events`, and operator-visible category labels
sourced via `enrichEventRpc` + the studio profile — "router-shaped, not hub-shaped" —
so cutting the port interface now, without that consumer, risks shipping the wrong
seam. AI tool bodies keep their direct `SessionHubRegistry` access in this change.

**Recorded as binding input for the AI-runtime change** (this study is carried, not
discarded):
- Session binding must be **factory-minted at the single existing build site**
  (`buildSessionMcpServer`, from the registration the bearer token resolved to) — never
  a pre-bound port crossing `registerTurn`/`driveAiTurn` (a second, uncrosschecked
  source of session identity).
- Any `await` introduced into `create_event`'s handler turns the per-run **cap
  check-then-increment into a race** observable in the frozen `{created, cap_hit}`
  body — cap reservation must move into the synchronous prologue or the transactional
  RPC. (This change pins the zero-await property in the `auto-event-generation` delta
  precisely so that conversion cannot happen silently.)
- Multi-read tool bodies (`utterance_stats`: words + enrichment; `event_stats`: words +
  events) are atomic today and must get **consistent-read-set port methods** (bundled
  reads resolved from one hub handle in one synchronous adapter body), or the torn-read
  behavior must be explicitly specced.
- The port surface must be **pinned by scenario** (exact operation list + a negative
  scenario: no method returns a hub/registry/store handle, no string-dispatch method) —
  otherwise a passthrough satisfies every requirement while defeating the audit-surface
  purpose.
- DTO extraction must include `TranscriptSentimentSegment` (enrichment returns
  paragraphs **and** sentiment).
- Exactly-once/idempotency for remote writes and read chattiness remain residuals
  (R1/R2) owned by that change.

### D6 — `createAnchoredEvent` becomes a `SessionHub` RPC (one transaction)

`create_event`'s read-filter-anchor-insert block moves into a synchronous, transactional
hub method taking `{category, message, metadataJson, timecodeTotalFrames, frameRate,
startOffsetFrames, startedAtUtc, excludeEventIds}` (all plain data; the caller converts
its `ReadonlySet` to an array or the RPC accepts an iterable — either way the signature
is serialization-friendly). The RPC body does `exportEvents → exclude →
timecodeWallAnchors → wallTimeUtcForTimecode → store-level events.addEvent` inside one
`inTxn` block — calling the **store method**, not the self-transactional
`SessionHub.addEvent` delegate, following the codebase's own `anchorImportedTake`
precedent (nesting would be behavior-preserving today but `withBroadcastsHeld` documents
inner-catch-and-continue as unsupported; don't create the trap). Zero awaits; the
hub-RPC-synchronous invariant holds.

The tool body keeps parsing, `internal`-category denial, allowlist, cap enforcement, and
metadata composition, and calls the RPC **synchronously** (`registry.get(sessionId)
.createAnchoredEvent(...)` — a sync hub call, no `await` introduced anywhere in the
handler, so the handler's atomicity is untouched).

Panel-verified safety: `exportEvents` emits nothing; the single `event.changed` from the
store-level insert is enqueued under the hold scope and flushed post-commit — one frame,
same bytes, same ordering. Only one connection per session DB exists in-process, so the
read-first transaction cannot hit `SQLITE_BUSY_SNAPSHOT`. Observable behavior (anchor
math, monotone clamping, regenerate exclusion, broadcast emission, `{created, cap_hit}`)
is unchanged and pinned by characterization tests before the reshape.

*Alternatives:* keep the two-step tool-body form (stays comment-enforced); wrap
`SessionHub.addEvent` (nested transaction trap, above).

### D7 — (removed) DTO extraction

Deferred with D5: the contract-package row DTOs existed solely to feed the port's L0
signatures (`schemas.ts` needs none of them). The AI-runtime change owns DTO extraction,
including `TranscriptSentimentSegment`.

### D8 — Cross-package nominal identity is protected, not assumed

The app's error handler maps `err instanceof ZodError` → 422 and
`err instanceof ValidationError` → 400 (plus seven more router-level `ValidationError`
sites). Two failure paths the package split could open silently: a second `zod` install
under `packages/contract` (range drift → different `ZodError` constructor → 422 becomes
500 at `npm install` time), and dual module instances of `@autologger/domain` during the
transitional-shim window. Protections shipped in this change: `zod` declared as a
**peerDependency** of `contract`; a gate task asserting `npm ls zod` resolves one copy;
integration pins asserting a request failing a contract-package schema still returns
422 and a domain-package `ValidationError` still returns 400, exercised through the real
app. (Panel verified node/vite realpath workspace symlinks to one module instance — the
pins guard the shim window and future dependency drift, not a currently-broken state.)

### D9 — Layering + coverage rules become normative (`package-architecture` capability)

The new capability spec encodes: down-only imports across an acyclic layer graph,
**enforced by a repo-invariant test** (each package's import specifiers ⊆ manifest
dependencies + declared layer order, demonstrated against a deliberate violation —
compiler enforcement was disproven, see Context); source-only mechanics as *properties*
(no build step required to run/test, no committed artifacts, every package covered by
root typecheck/test/lint — with a falsifiable zero-test guard: a deliberately failing
package test must fail the root run); no duplicated runtime dependency where the app
does nominal `instanceof` checks; every process-wide singleton in exactly one package
home; the contract package as single home of wire request schemas + the dashboard
catalog/validator (scoped precisely — pure value-logic validation like `studio.ts`'s
lives in `domain`; the discriminator is zod/wire-shape dependence); the
`fixtures/api-responses/` chain preserved.

## Invariants a future reader must not "helpfully" undo

- **Single Node process** — nothing here (or in successors, absent a new gate ruling)
  runs a second process.
- **Hub RPC bodies stay synchronous** — `createAnchoredEvent` is sync inside the hub.
- **`create_event`'s handler contains zero awaits** — the cap check → insert → counter
  increment sequence is atomic only because of this; the `auto-event-generation` delta
  pins it. Any future async conversion must move cap reservation first (D5 notes).
- **Call-time hub resolution in tool paths** — never hold a hub across an await.
- **Chat turns never get paged words / `create_event`** — registration-carried tool
  sets and snapshots are untouched by this change.
- **No permanent re-export shims** — old paths die; a lingering `types.ts` shim
  rebuilds the god-barrel. `appEnv.ts` is composition, not a barrel: it may name
  `SessionHubRegistry` and `Catalog` only.
- **`@autologger/ports` ships no runtime implementations** — `systemClock` lives with
  the composition root; an adapter "moved in for symmetry" recreates the god-barrel at
  L0.
- **`zod` stays a peerDependency of `contract`** — a local copy silently breaks the
  frozen 422 mapping.
- **Web's hand-written `api/types.ts` stays hand-written** (gate ruling,
  `web-api-response-conformance`).

## Risks / Trade-offs

- [~70-file import rewrite creates a wide, shallow diff that could mask a real change] →
  mechanical rewrites land as their own commits, separate from semantic edits
  (`createAnchoredEvent`, `appEnv.ts`), so review can diff-scan the wide commits and
  read the narrow ones.
- [The boundary repo test is itself convention — someone could edit it] → it lives in
  the same `*.repo.test.ts` guard idiom the repo already treats as normative
  infrastructure, and the `package-architecture` spec names it, so weakening it requires
  a delta.
- [vitest project rewiring breaks the two-tier setup in ways a green run hides] → the
  wiring task includes a deliberately-failing test per project (unit, integration, each
  package) proving each actually executes, plus the `fixtures:capture` `--project`
  selector check.
- [Reshape risk on `createAnchoredEvent`] → characterization tests land before the
  reshape (task order enforced); store-level call avoids the nested-transaction trap.
- [Successor changes stall, leaving a hybrid layout] → this change is self-consistent
  alone: L0 packages + retired god-barrel + test-enforced boundaries are a strict
  improvement even if no successor lands.
- **Residual (named, owned by session-core extraction):** `SessionHub` facade interface
  — until then, routers keep concrete hub typing via `appEnv.ts`.
- **Residual (named, owned by catalog extraction):** `Catalog` facade interface — same
  arrangement.
- **Residual (named, owned by feature-package changes):** `Config` is one 31-field
  interface at L0; slicing it per feature needs a later delta, recorded now so its
  location doesn't read as an endorsement of the coupling shape.
- **Residual (pre-existing, discovered by 6.2's sweep, owned by a future log-import
  cleanup):** `logImport/jobStore.ts`'s `pruneJobs` TTL eviction reads `Date.now()`
  directly — a letter-violation of the `core-ports-architecture` Date.now scenario that
  predates this branch (it arrived with the external PR-3 batch-import contribution).
  Fixing it requires Clock injection across a public API and router call sites —
  behavior-touching surgery outside this change's Non-Goals. Recorded rather than
  silently waved through; the other three non-`systemClock` literal sites were
  adjudicated clean (per-site justifications in the apply ledger).
- **Residuals R1/R2 (carried to the AI-runtime change):** port read chattiness;
  exactly-once/idempotency for remote writes (the idempotency-key spec sentence was cut
  at panel recommendation — an optional parameter on an in-repo interface is
  non-breaking to add later).

## Migration Plan

Phased within the one change (per-phase detail in `tasks.md`): scaffolding + enforcement
test → `domain` → `contract` (+ cycle break, zod peer, error-path pins) → `ports` +
`appEnv.ts` (+ `types.ts` retirement) → `createAnchoredEvent` → sweeps + docs + full
gates. Every phase ends green (`npm test` + `npm run typecheck`); pure refactor, so
rollback at any phase boundary is `git revert` of that phase's commits with no data or
contract consequences.

## Open Questions

- Package scope name: `@autologger/*` assumed; confirm at gate (npm publishing is not
  planned, so the scope is cosmetic but hard to rename later).

## Panel & review log

- **2026-08-07 — pressure test (pre-proposal exploration, main session):** the
  SessionToolPort design was adversarially tested before drafting. Survived: six-method
  completeness (verified `aiTurn.ts` touches only the listener; route orchestration
  enumerated), growth stability at method-count level (checked against
  `ai-session-analyst`'s toolset). Forced into the design: hub-RPC transaction (D6) and
  DTOs-at-L0. Recorded as residuals: R1 (remote chattiness), R2 (exactly-once).
  Implementer trap noted (error-path equivalence). Exploration provenance, not a
  substitute for the fact-check pass or panel. *(The panel later showed the
  growth-stability conclusion held for method count but not shape — see the panel entry;
  the port was deferred at gate.)*

- **2026-08-07 — pre-panel fact-check pass (light-tier reviewer, against live `main`
  post-PR#4):** 24 mechanically checkable claims enumerated as properties across
  proposal/design/specs; 20 CONFIRMED (with quoted claim-relevant code paths for the
  function-behavior claims), 3 CORRECTED, 0 failed, 0 left unverified. Corrections
  folded: (1) `types.ts` imports **6** concrete classes, not eight; (2) a second
  directory-level cycle `auth ⇄ node` exists — recorded, with the `KvStore` interface
  move named as the designed break; (3) task 2.2's importer union is **30** files, not
  ~35. Notes absorbed: `TranscriptParagraph` colocated in `transcriptStore.ts`. (The
  pass's "evictIdle is test-only via the concrete class" note was later corrected by the
  panel — tests reach it via `ports.sessions`.) Full per-claim log retained in the
  session transcript.

- **2026-08-07 — adversarial panel (4 reviewers: requirements / assumptions / failure &
  abuse / scope, heavyweight tier, distinct mandates, skeptical calibration; three
  independently built sandbox replicas with the repo's own toolchain).** Convergent
  findings and dispositions:

  **Blockers/majors fixed in place:**
  - `tsc -b` ⟂ source-only (TS6310/TS6305, reproduced ×3) → D1 rewritten: per-project
    `tsc --noEmit`; spec respecced to properties.
  - Boundary enforcement disproven (undeclared imports compile via workspace hoisting;
    `tsc` ignores manifests — reproduced ×3) → D9/spec rewritten: repo-invariant
    boundary test with a demonstrated negative case.
  - vitest workspace flattens nested `test.projects` + skips `setup.int.ts`
    (reproduced) → D1: explicit project enumeration + falsifiable per-project
    execution proof; `fixtures:capture` selector preserved.
  - `packages/**` invisible to biome → D1 + tasks: `biome.json` and lint script
    updated.
  - Duplicate-zod `instanceof ZodError` → 422-becomes-500 hazard → D8: zod
    peerDependency + `npm ls` gate + cross-package 422/400 pin tests.
  - "Single home of shared schemas and validation" requirement was false on day one
    (studio validation lives in domain) → spec requirement narrowed with an explicit
    discriminator.
  - Missing MODIFIED deltas: baseline sweep scenarios (Cloudflare nouns, `Date.now()`)
    re-scoped to include `packages/**`.
  - D3's `evictIdle` justification was factually wrong (called via `ports.sessions` in
    two int tests) → corrected; app-level compose makes it moot.
  - `createAnchoredEvent` must call store-level `events.addEvent` (nested
    self-transactional delegate trap; `anchorImportedTake` precedent) → D6 fixed.
  - Docs staleness (README annotated tree, CLAUDE.md source layout) → tasks added.
  - Count/wording fixes: ~70 files incl. tests; test-inclusion convention stated;
    `regenerateSnapshotIds` serializability wording; `systemClock` out of ports.

  **Escalated to the gate (with decisions, 2026-08-07):**
  - **Port scope.** Panel consensus: defer the SessionToolPort rewiring — 4 hazards
    cluster there (cap check-then-increment race under await; torn multi-reads in
    `utterance_stats`/`event_stats`; unpinned mint site enabling divergent session
    identity; unpinned surface admitting a passthrough), and `ai-session-analyst`'s
    gated spec contradicts the designed shape (range/slice, paging, router-shaped
    enrichment). **Ruling: defer rewiring to the AI-runtime change; keep
    `createAnchoredEvent`.** The hardening requirements are recorded in D5 as binding
    input to that change; the zero-await handler property is pinned in the
    `auto-event-generation` delta so the conversion cannot happen silently.
  - **AppEnv typing.** `Variables.catalog` (concrete `Catalog`, ~71 methods) and
    `SessionHubRegistry.get()` → concrete `SessionHub` (~52 methods) made "app-env types
    at L0 with no implementation imports" jointly unsatisfiable at this change's size
    (found independently by all four reviewers). **Ruling: app-level compose**
    (`server/src/appEnv.ts`); hub/catalog facade interfaces are named residuals owned
    by the session-core and catalog extraction changes.
  - **Mechanics.** **Ruling: adopt panel fixes** (drop `tsc -b`; boundary repo test;
    explicit vitest projects; biome coverage; zod peer + pins).

  **Minors accepted as residual:**
  - `Config` remains a single 31-field interface at L0 (slicing recorded as a
    feature-package residual).
  - R1/R2 carried to the AI-runtime change; idempotency-key spec sentence cut (adding
    an optional parameter later is non-breaking).
  - Sizing note: `types.ts` has 35 importing files including tests (25 production);
    tasks state counts with the tests-included convention.

  Clean bills worth recording: D6 broadcast/transaction semantics verified safe
  (savepoint nesting, post-commit flush, single connection per session DB); loopback/
  token/tool-set lockdowns untouched by this change's surface; module identity across
  workspace symlinks realpath-verified single-instance; fixture chain location
  independent of cwd; `types.ts` exports types only (runtime-neutral retirement);
  domain/contract as separate packages correctly scoped; Non-Goals drawn in the right
  places; phase gates proportionate.

- **2026-08-07 — post-gate consistency read (light-tier reviewer over all six final
  documents: proposal, design, tasks, and the three delta specs):** the four gate/panel
  decisions (port deferral, app-level AppEnv compose, dropped `tsc -b`, DTO removal)
  verified consistently reflected — no stale pre-decision language, no orphaned phase
  references, no broken capability↔spec cross-references; `openspec validate --strict`
  green. Four internal defects found in design.md and fixed: `SessionRegistry.get()` →
  `SessionHubRegistry.get()` in the panel-log entry (the interface no longer ships in
  this change); `~127` → `~123` combined facade signatures (52 + 71); `(24 production)`
  → `(25 production)` `types.ts` importers (re-grounded by grep: 35 total, 25
  non-test); `30-field` → `31-field` `Config` (re-counted against `types.ts`).
