# Design: web-docs-architecture-viz

## Context

The repo is npm workspaces (`server/`, `web/`, `companion/`, plus non-workspace `e2e/`).
Architecture knowledge lives in prose (README, CLAUDE.md, spec Purposes) and drifts. The
code is the source of truth for topology; OpenSpec is the source of truth for *why* the
code changes (non-trivial changes are gated through it — CLAUDE.md's "small, obvious
fixes" lane exists, so the annotation layer is strong but not literally exhaustive), so
spec capabilities and active changes are a trustworthy annotation layer over a
code-derived map. Structured raw material already in-repo: TypeScript sources with
resolvable imports; catalog migrations (`server/src/db/migrations/*.sql`) and the
session-DB `initSchema` DDL; regular markdown in `openspec/specs/*/spec.md`
(`### Requirement:` / `#### Scenario:` headings); active changes under
`openspec/changes/` (archive excluded); the normative README endpoint table.

Exploration settled the shape — **authored grouping, derived edges, drift fails the
build** — and the adversarial panel (2026-08-07, four reviewers; see Panel & review log)
reshaped its mechanics: derived edges are checked against a *committed, reviewed
snapshot* rather than a self-comparing "equality" gate; the live-repo gates run at
branch-final `docs:check` rather than inside every root `npm test`; new capabilities get
pending-grace; and node/edge kinds keep tooling and test scaffolding from drowning the
runtime map.

## Goals / Non-Goals

**Goals:**

- A static `web-docs/` site with three drill-down levels: L0 system architecture → L1
  per-component module graphs → L2 detail diagrams (ER, state, requirement browser).
- Diagrams that cannot silently lie: every mechanical fact re-derived at gate time, every
  authored fact verified against the code at gate time, drift a hard error surfaced in
  the diff that causes it (via the edge snapshot) or at branch-final `docs:check`.
- Zero impact on the server, the frozen HTTP/WS contract, or the other workspaces' code.
- Deterministic builds: no LLM, no network, no reliance on local-only artifacts.

**Non-Goals:**

- Not a replacement for `openspec` CLI workflows or the README endpoint table (which
  stays normative); the site links the endpoint table rather than re-rendering it (a
  per-component endpoint view is a possible follow-up).
- No runtime call-graph or trace visualization; mechanical edges are static import edges
  (labeled as such) plus declared, evidence-checked relationships.
- No hosting/publishing pipeline; output is a local static build.
- No visualization of archived changes (timeline views are a possible follow-up).
- No authored transcript-generation diagram in v1 (deferred until
  `transcript-gen-lock-status` lands; see D7).

## Decisions

### D1 — Fully static site; extraction at build time, rendering client-side

A two-stage pipeline: (1) an **extraction step** (Node script in `web-docs/`, executed
with `tsx` — the same runner `server/` already uses — so it can import server `.ts`
modules with their extensionless specifiers) reads the repo and emits a single generated,
git-ignored artifact `atlas.json` (component graph, module graphs, mermaid diagram
sources, mermaid client config, spec tree, overlay data); (2) a **Vite + React SPA**
renders pages from `atlas.json`, with mermaid running client-side under
`securityLevel: 'strict'`, `htmlLabels: false`, navigation via post-render DOM handlers
(mermaid `click` directives would force `'loose'` and open an XSS path from disk-derived
strings — spec headings, change names — into a page that can reach the anonymous
loopback API). *Alternatives*: serving from the server (rejected — frozen contract, and
the server must stay untouched); a runtime SPA reading the repo via an API (rejected —
needs a server and is non-deterministic); an SSG framework like Astro/eleventy (rejected
— new framework for little gain; Vite + React matches `web/` idioms and the existing
toolchain). The split keeps extraction unit-testable without a browser and rendering
dumb. The dev server binds loopback on a non-colliding port (5175), matching the
`web/vite.config.ts` guardrail.

### D2 — Edge derivation via the TypeScript compiler API; program from the mapped-file list

The extractor builds its `ts.Program` from the mapped-file list itself, using each
workspace's `compilerOptions` **for resolution only** — never each tsconfig's
`include`/`exclude` (companion's tsconfig excludes its own test files, which the
coverage gate must still see). It resolves import/export declarations plus literal
dynamic `import()` across the four real resolution regimes: server (`Bundler`,
`scripts/` included), web (`bundler` + `paths` aliases + `allowImportingTsExtensions`),
companion (`NodeNext` with `.js`-specifiers for `.ts` files), e2e (which `include`s the
root `playwright.config.ts`). Unresolvable non-TS specifiers (CSS, images, bundler-only
assets) are ignored; non-literal dynamic imports are surfaced as warnings with call
sites; an import resolving to an in-repo file outside every component and the exclusion
list is a gate error. *Alternatives*: querying `.codegraph/codegraph.db` (rejected —
gitignored local artifact, private schema; fresh clones can't count on it);
`dependency-cruiser`/`madge` (rejected — a second resolution config to keep in sync with
four tsconfigs; note the honest rationale is *avoiding a parallel resolution config*,
not dependency-count purity — mermaid alone is a ~150 MB install).

### D3 — Component model: typed TS module with node kinds, capability scopes, exclusions

`web-docs/model/components.ts` exports a typed model: components with `kind`
(`runtime` | `datastore` | `external` | `tooling` | `test-harness`), description, source
globs, attached capabilities, attached authored diagrams; declared non-import
relationships with evidence rules; capability scope declarations
(`component` | `cross-cutting` + set | `process`); and an explicit exclusion list (with
reasons, rendered on the About page) for tracked `.ts` files that are genuinely
tooling-config (workspace `vite.config.ts`/`vitest.config.ts`, root
`playwright.config.ts`, `scripts/`). Coverage enumerates from `git ls-files` — the root
set is not hand-listed config that can drift. `fixtures/api-responses/` becomes a real
component (the contract-fixture corpus both server and web assert against — one of the
most load-bearing shared nodes in the repo, previously invisible). Datastores (catalog
DB, session DBs, blob store) and gated externals (DeepGram, Claude CLI, yt-dlp, Google
JWKS) are `datastore`/`external` nodes with declared, evidence-checked edges — without
them L0 is a TypeScript-module diagram, not the system diagram the proposal promises.
Per-module test files map to the same component as their subject; `server/src/test/` is
a `test-harness` component whose edges are `test`-kind (hidden by default). Type-checked
by `tsc`, structurally validated by the extractor. *Alternatives*: YAML/JSON (rejected —
parser + no type checking); living in `openspec/` (rejected — CLI-managed normative
space; the gates, not the location, bind the model to reality).

### D4 — Drift gates: derived edges vs. a reviewed snapshot; branch-final execution

The panel killed the drafted "observed edges must equal drawn edges" gate: with derived
edges it compares a set to itself (can never fail); with authored edges it is a ~60-edge
hand-maintained inventory where deleting code reddens the build. **Gate ruling: derived
+ snapshot.** Edges are derived and classified (`production`/`test`); the derived set is
diffed against a committed, reviewed `web-docs/model/edges.snapshot.json`; any new or
vanished edge fails until the snapshot is regenerated (one command) and reviewed in the
same diff. That restores the real property the equality gate reached for — *a new
architectural dependency is loud in code review* — without hand-maintaining edges. A
renderer assertion separately guarantees L0 draws every snapshot `production` edge and
declared relationship (no silent elision).

The gate battery (all hard errors when run): **coverage** (git-tracked files → exactly
one component or visible exclusion), **snapshot conformance**, **relationship evidence**
(per-relationship mechanical checks — web client module with `fetch`/WS call sites,
companion client with base-URL `fetch`, `serveStatic` site for server→web, e2e spawn
sites, datastore/external call sites), **capability accounting** (baseline capabilities
attached / cross-cutting / process; pending-grace for active-change deltas), and
**diagram validity** (DOM-shimmed parse + structural checks + navigation-id resolution +
size budgets).

**Where they run (gate ruling): branch-final, not every `npm test`.** Root `npm test`
runs web-docs' fixture-based unit tests only; the live-repo gates run in
`npm run build -w web-docs` and a root `npm run docs:check`, invoked at branch
completion (whole-branch review checklist) and before archive. Rationale: every other
change's apply loop runs root `npm test` dozens of times mid-phase; an innocent new
`server/src` directory would red-build an unrelated implementer subagent with zero
web-docs context. Cost accepted at the gate: drift is caught at branch boundaries, and
with no CI the checklist is the enforcement — mitigated by encoding `docs:check` into
the operational SDLC encodings (CLAUDE.md final-gates + archive skill checklist; see
D10). Failure messages are part of the contract: each names the offending file/edge, the
nearest component, and the one-line remedy.

Deliberate invariants a future reader must not "helpfully" undo: the gates stay hard
errors (no warning downgrade, no cached extraction, no per-file exemption beyond the
visible exclusion list); no component glob may be a bare workspace root (a
four-component model satisfies every gate and produces a useless map); the snapshot is
regenerated only alongside review, never automatically in the build.

### D5 — ER diagrams by schema introspection, not SQL parsing

The extractor builds the catalog schema by running the real migration files, in order,
via the server's exported `applyMigrations(db, dir)` against a bare in-memory
`better-sqlite3` database (no WAL pragma — meaningless on `:memory:`), and the session
schema by constructing the server's exported `SessionCore` over a second in-memory
handle — wrapped with the exported `sqliteSessionSql` adapter, with inert
clock/sockets/alarm stubs, the exact pattern `server/src/test/fakeCore.ts` already uses
— and calling its `initSchema()` method (an instance method on `SessionCore`, not a
standalone function); it then introspects (`sqlite_master`, `pragma table_info` /
`foreign_key_list`) and emits `erDiagram` sources, excluding `sqlite_%` internals and
the migrator's `_migrations` bookkeeping table, capturing schema only (never rows —
`_migrations` rows carry timestamps that would break determinism). *Alternative*:
parsing DDL text (rejected — fragile; introspection cannot disagree with reality).
Honest expectation, set in the UI: the current schema declares few foreign keys (3 in
catalog, 0 in session), so these are table-detail diagrams more than relationship webs.
This couples the docs build to three server internals (`applyMigrations`,
`SessionCore`, `sqliteSessionSql`) — recorded in Risks.

### D6 — Overlay from tracked artifacts; scope-aware tinting

Active changes are enumerated from git-tracked files: a change is a directory under
`openspec/changes/` (archive excluded) with a tracked `proposal.md`; partial or
untracked directories (interrupted scaffolds, `.apply/`-only remnants — both observed in
this repo) are skipped with a warning. Touched capabilities come from delta-spec
directories; **component-scoped** capabilities tint their components,
**cross-cutting** capabilities (e.g. `api-contract-freeze` — the delta of 3 of 6 current
delta-bearing changes) are listed on the change without tinting (tinting through them
would flood the map into noise), and **new** capabilities render as pending
(pending-grace, D4). *Alternative*: parsing `tasks.md`/`proposal.md` prose for file
paths (rejected — prose parsing is the unreliability this design avoids).

### D7 — Authored state diagrams: two in v1, derived from code reads

Authored mermaid `stateDiagram-v2` files live in `web-docs/diagrams/`, attached via the
model, labeled "authored" in the UI, and gate-checked for parse validity *and*
structural non-emptiness (mermaid's parser accepts near-garbage state diagrams —
measured — so parse alone is a weak gate). v1 ships **two**, authored from a read of the
current code, not from prose: the recording-lease lifecycle (grant → heartbeat →
stale-holder **takeover** → expiry, with the alarm re-arm path — `leaseStore.ts`) and
the SessionHub **registry** lifecycle (constructed → active → **evicted-and-
reconstructed** under the triple idle guard — the hub is not "reopened"; CLAUDE.md's
"reopen lazily" prose is looser than the code). The transcript-generation diagram was
cut from v1: the panel found the drafted "job lifecycle" doesn't exist (generation runs
inline in the request under a process-global single-slot lock), and the surface is under
concurrent revision by the in-flight `transcript-gen-lock-status` change — authoring it
now would freeze a lifecycle that is actively changing. Follow-up after that change
archives.

### D8 — Root wiring

Root `package.json`: add `web-docs` to `workspaces`; the root `typecheck`/`lint`/`test`
chains gain `-w web-docs` legs where **`test` runs the workspace's unit tests only**;
a new root **`docs:check`** script runs the full extraction + gates against the live
tree (D4). Lint follows the existing `web/` pattern — `web-docs/biome.json` +
`npm run lint -w web-docs` — because root `biome.json` has a hard `files.includes` list
and appending a bare path to the root `biome check` invocation exits 1 (verified
empirically by the panel). Root `dev`/`build`/`start` are untouched. Dependencies:
`mermaid` and `typescript` exact-pinned in `web-docs` (a floating TS minor can change
the observed edge set; a mermaid minor can change what the validator accepts);
`better-sqlite3` reuses `server/`'s exact specifier (`^12.11.1`) so npm hoists one copy
and one native build; jsdom and `tsx` are devDeps (the extractor and the mermaid
validator need them — task 1.1 carries the full list). After install, the branch asserts
via lockfile diff that no entry outside `web-docs`' own subtree changed (the frozen
contract's consumers must not have their resolved versions moved by this workspace).

### D9 — Rendering safety and budgets

All disk-derived strings are escaped for mermaid label syntax before interpolation;
requirement/spec text renders as text nodes, never HTML. Every generated diagram carries
per-diagram node/edge budgets enforced at gate time — mermaid's *render* caps differ
from its *parse* behavior, so budgets (plus the same config object shared between
validator and client via `atlas.json`) keep "validated at build, blank at render" from
happening. Full in-browser render smoke is out of v1 (mermaid `render()` needs
`CSSStyleSheet`, absent under jsdom — measured); residual risk accepted and recorded.

### D10 — Process obligations live in the operational encodings, not a parallel spec

Two obligations fall out of the gate rulings: archiving a change that introduces a new
capability must attach it in the web-docs model in the same archive commit
(pending-grace ends when the capability joins the baseline), and branch completion /
archive must run `docs:check`. Per the `sdlc-process` capability, process rules live in
the three operational encodings and **must not** be restated in a parallel spec — so
these land as: a line in CLAUDE.md's SDLC section, a step in
`.claude/skills/openspec-archive-change/SKILL.md`'s checklist, and this change's panel +
gate satisfies the "process-rule changes are design-bearing" scenario. The skill edit is
a machine-parsed governance file, so the tasks include a parse/load verification step
(config.yaml rule). `sdlc-process` itself needs no delta — its requirements are
unchanged; this is amendment of encoding content through the pipeline it mandates.

## Risks / Trade-offs

- **Branch-final gates mean drift windows** (a mid-branch orphan file is caught at
  `docs:check`, not the next `npm test`) → accepted at the gate; enforcement is encoded
  in CLAUDE.md final-gates + the archive skill checklist (D10). No-CI reality: the
  checklist *is* the mechanism, as it already is for e2e.
- **Model maintenance on refactors** (moved files, new dirs, new/removed cross-component
  imports all require a model or snapshot touch in the same diff) → globs at directory
  granularity; failure messages name the file, nearest component, and the one-line
  remedy; snapshot regeneration is one command. This friction is the feature working.
- **Docs build coupled to server internals** (`applyMigrations`, `SessionCore`,
  `sqliteSessionSql`, and `tsx`-compatible import shapes) → a server refactor renaming
  these breaks `docs:check`, not root `npm test`; the coupling is narrow, read-only, and
  named here so the panel's whole-branch review checks call sites when those seams move.
- **Import extraction blind spots** (non-literal dynamic imports, `require`, bundler
  magic) → program-from-file-list + per-workspace `compilerOptions`; non-literal dynamic
  imports warn with call sites. Current production sources contain no `require()` and
  two literal dynamic `import()`s — one in-workspace (`BatchImportModal.tsx`), one
  **cross-workspace test-only** (`clientAggregates.pinning.test.ts` → `server/src/aiV2/
  aggregates.ts`), which lands in the snapshot as a `test` edge, rendered only under the
  test toggle — the edge-kind machinery exists precisely so this edge is recorded
  without being drawn as a runtime dependency the code explicitly disclaims.
- **Authored diagrams can drift semantically** (structural checks catch emptiness, not
  truth) → two only, labeled "authored", derived from code reads (D7), reviewed under
  the normal SDLC.
- **Mermaid render limits at scale** → per-diagram budgets enforced at gate time;
  subdirectory grouping keeps L1 under budget; no in-browser render smoke in v1
  (jsdom can parse but not render — residual).
- **ER diagrams are sparse** (3 catalog FKs, 0 session) → presented as table-detail
  diagrams; inferred-relationship rendering deliberately excluded (would be authored
  claims dressed as mechanical facts).
- **Native dep + lockfile blast radius** → exact pins (D8) + post-install lockfile diff
  assertion; `better-sqlite3` specifier matches server's exactly.

## Migration Plan

Additive: new workspace + root `package.json` edit + CLAUDE.md/README/archive-skill doc
edits (D10). Rollback = delete `web-docs/`, revert the root manifest and doc edits;
nothing else references it.

## Open Questions

- None blocking. The L1 subdirectory-grouping threshold, exact size budgets, and tint
  palette are implementation-time choices inside the gated design.

## Panel & review log

**2026-08-07 — Pre-panel fact-check pass** (light-tier fetch-and-compare reviewer over
proposal/design/spec vs. the live repo; per-claim method + evidence in the reviewer's
report, summarized here):

- *Claims checked and CONFIRMED* (each by reading the whole claim-relevant code path):
  workspaces/scripts shape and `typescript` root devDep; migrations are 4 plain `.sql`
  files applied in lexical order by `applyMigrations` (`server/src/node/migrate.ts`);
  `better-sqlite3 ^12.11.1` in `server/`; all 17 spec files use exactly
  `### Requirement:`/`#### Scenario:` headings; 17 capability dirs; active changes
  include delta-less ones; no `require()` in any workspace source; recording-lease timer
  expiry, registry idle-close, DEEPGRAM 503 gating (code paths quoted in report); web
  relative-path `fetch`/WebSocket call sites; README §Endpoints normative-inventory
  language; `.codegraph/` fully gitignored; mermaid not currently a dependency; routers
  = 27 non-test modules / 64 files.
- *Claims CORRECTED in place*: (1) `initSchema` is an instance method on `SessionCore`
  requiring a `SessionRuntime`, not a standalone export (D5/spec/tasks reworded to the
  `sqliteSessionSql` + stubs construction). (2) "static ESM imports throughout" was
  false (one literal dynamic `import()` in production). (3) The uniform "relative API
  paths" seam heuristic cannot evidence companion→server (absolute configured URLs) —
  per-seam heuristics adopted. (4) Tasks 2.2's cluster list missed `logImport/`,
  `middleware/`, `test/`, and 12 loose top-level `server/src` files. Also: stray empty
  scaffold `openspec/changes/web-docs-openspec-viz/` deleted.
- *Left UNVERIFIED*: mermaid capabilities (external, to-be-added) and the prospective
  extraction pipeline — both subsequently attacked by the panel.

**2026-08-07 — Adversarial panel** (four opus reviewers — requirements, assumptions,
failure & abuse, scope/simpler-design — all calibrated skeptical; unanimous verdict:
not gate-ready as drafted). Dispositions:

*Blockers/majors fixed in place:*

- Edge-conformance gate was vacuous-or-contradictory (all four reviewers; the model had
  no edge field) → replaced by derived edges + committed reviewed snapshot + edge kinds
  + renderer assertion (D4; gate decision below).
- Coverage roots were hand-listed, unpoliced config with real tracked files outside them
  (`fixtures/api-responses/` — 15 contract-fixture `.ts` modules imported by both server
  and web — plus config files, `server/scripts/`) → coverage enumerates from
  `git ls-files`; fixtures become a component; visible exclusion list; imports into
  unmapped in-repo files are gate errors (D3, spec).
- Capability gate broke the SDLC lifecycle (4 of 6 delta-bearing active changes name
  capabilities that exist only on archive; archiving would red-build; cross-cutting
  capabilities forced onto arbitrary components) → pending-grace + capability scopes
  (component/cross-cutting/process) + scope-aware tinting (D4/D6; gate decisions below).
- Headless mermaid parse throws in plain Node and, DOM-shimmed, accepts garbage state
  diagrams (measured, mermaid 11.16.1); mermaid `click` requires `securityLevel:
  'loose'` → XSS from disk-derived strings into a page reaching the anonymous loopback
  API → jsdom bootstrap named; structural checks + nav-id resolution + size budgets;
  strict mode + `htmlLabels: false` + post-render DOM navigation + escaping (D1/D9,
  spec).
- Root `npm run lint` would exit 1 (root `biome.json` hard include list — verified
  empirically) → `web-docs/biome.json` + workspace lint leg, the existing `web/` pattern
  (D8).
- Extractor had no runner (no `tsx`/jsdom in deps; server uses extensionless `.ts`
  specifiers) and four tsconfig resolution regimes were unaddressed (companion excludes
  its own tests; NodeNext `.js`→`.ts`; web `paths`) → `tsx` runner; program built from
  the mapped-file list with per-workspace `compilerOptions` only (D1/D2).
- Two of three authored lifecycles were wrong (hub "lazy reopen" is
  evict-and-reconstruct; transcript "job lifecycle" doesn't exist and is under
  concurrent revision by `transcript-gen-lock-status`) → v1 ships two diagrams derived
  from code reads; transcript deferred (D7).
- A live cross-workspace test-only import (`web → server/src/aiV2/aggregates.ts`) would
  have forced a runtime-looking L0 arrow the code disclaims → edge kinds; `test` edges
  recorded in the snapshot but rendered only under a toggle (D3/D4).
- Non-import relationships were undrawable (server serves `web/dist`; e2e spawns all
  three workspaces; datastores/externals from the proposal's own Why) → declared
  relationships with mechanical evidence rules; datastore/external/tooling node kinds
  (D3, spec).
- Anti-neutering guidance lived only in archived-on-completion design prose → normative
  gate-hardness requirement in the spec (errors-not-warnings, no caching/exemptions, no
  bare-workspace-root globs); L1 completeness requirement (every mapped file visible or
  in a named group, elided counts shown); parser count-equality gate; overlay from
  tracked files with defined partial-directory behavior; determinism made
  mechanism-level (sorted iteration, repo-relative paths, no absolute paths/hostnames);
  browser-downloading deps prohibited by name; `atlas.json` gitignored; loopback dev
  server; exact pins + lockfile-diff assertion; scope trims (seam heuristics → per-
  relationship evidence one-liners; React component-test tier cut to extraction tests +
  a mermaid-stubbed routing smoke; redundant final e2e run cut in favor of the
  `git diff --stat` proof).

*Escalated to the gate (owner decisions, 2026-08-07):*

1. Edge gate mechanics → **derived + reviewed snapshot** (over authored edge list, over
   cutting the gate).
2. Gate placement → **branch-final `docs:check`** (over every-`npm test`); root `npm
   test` carries unit tests only.
3. New-capability handling → **pending-grace**, with the attach-on-archive and
   `docs:check` obligations recorded in the operational encodings (CLAUDE.md + archive
   skill) per `sdlc-process` — not as a parallel spec delta (the panel option's
   "sdlc-process delta" framing was corrected against the marker spec's
   no-parallel-rulebook ruling; proposal "Modified Capabilities: None" stands, with the
   process edits disclosed in Impact).
4. Requirement/scenario browser → **kept in-site** (over counts + links).

*Minors accepted as residual:*

- No in-browser render smoke in v1 (mermaid `render()` needs `CSSStyleSheet`, absent
  under jsdom — measured); budgets + shared config mitigate; full render verification is
  manual.
- ER diagrams are sparse (3 catalog FKs, 0 session) — presented honestly as
  table-detail diagrams; no inferred relationships.
- Relationship evidence stays call-site-level, not per-endpoint reconciliation against
  the README table (labeled in the UI; natural follow-up).
- Authored diagrams' semantic truth rests on review, not mechanics (structural checks
  only).
- Cross-cutting capabilities (e.g. `core-ports-architecture`, `api-contract-freeze`) and
  the process-scoped `sdlc-process` don't tint the map — listed textually instead.

**2026-08-07 — Post-gate consistency read** (light-tier, over the final proposal.md,
design.md, specs/web-docs-site/spec.md, tasks.md): one finding — a residual-minors
bullet in this log labeled `sdlc-process` "cross-cutting" instead of its `process`
scope, contradicting the D3/D4/D6/D10 taxonomy; fixed in place. All ten gate
rulings/mechanics otherwise verified uniform across the four documents and against the
live repo (snapshot filename, docs:check wiring, port, capability names/counts,
dependency lists, root lint chain).
