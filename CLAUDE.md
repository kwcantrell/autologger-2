# CLAUDE.md — autologger

Guidance for Claude Code in this repo. Read at the start of every session.
For deep architecture, the endpoint inventory, and storage layout see **`README.md`** —
this file stays short and points there rather than duplicating it.

## Project overview

Portable TypeScript/Node backend for AutoLogger — originally a faithful port of the Python
AutoLogger backend; this repo is now the canonical implementation, serving the **frozen JSON
shapes** the React frontend expects. The repo is **npm workspaces**: `server/` (Node backend)
+ `web/` (React frontend, canonical copy) + `companion/` (Bitfocus Companion module) +
`packages/*` (`domain`/`contract`/`ports` — source-only L0 packages shared by server, no
build step), plus `e2e/` (Playwright smoke, not a workspace). **Hono** routing + **Zod**
validation + **jose** for Google ID-token verify, on:

- **better-sqlite3** — catalog DB (`DATA_DIR/catalog.db`: users/studios/shows/prefs, login
  sessions, OAuth CSRF, Companion presence, sessions index) + one DB file per session
  (`DATA_DIR/sessions/<id>.db`).
- **Filesystem blobs** (`DATA_DIR/blobs/audio/…`) — audio bytes, replacing R2.
- **In-process SessionHub per session** — live spine: events, transport, audio metadata,
  recording lease (timer-driven auto-expiry), transcript words, topics, WebSocket fan-out.
  Replaces the Durable Object.
- **`@hono/node-ws`** for WebSocket upgrades, served by **`@hono/node-server`**.

**Runs anywhere Node 22 runs.** No cloud account, no login, no remote provisioning — a single
Node process, state on local disk under `DATA_DIR`. Transcript generation
(`…/transcript-words/generate`) is configuration-gated: `503` unless `DEEPGRAM_API_KEY` is
set, in which case it sends recorded session audio to DeepGram's cloud STT API (see README
"Transcript generation (DeepGram)" — audio egress + spend disclosure). YouTube import
(`…/youtube-import`) is likewise configuration-gated: `503` unless an operator-provided
`yt-dlp` binary is configured or resolvable on `PATH`, in which case it downloads a video's
audio to local disk and attaches it to the session (see README "YouTube audio import" —
egress disclosure + open-network refusal). `topics/generate` is likewise configuration-gated
(`503` unless `CLAUDE_CLI_PATH` is set): configured, it reuses the AI chat's CLI/MCP/gate/
registry machinery to run a single non-conversational turn and returns `200 {topics}` — a
crash-safe replace-all of the session's topics, never touching the prior set until the fresh
one exists (see README "AI chat (Claude CLI)"). `events/generate` shares that
`CLAUDE_CLI_PATH` gate (`503` unconfigured): configured, it runs a single orchestrator CLI
turn over user-authored per-button `auto_instruction`s, appends transcript-derived events,
and returns `200 {created, cap_hit}` — append-only, capped per run, each row marked
`auto_generated` (see README "Event
auto-generation (AUTO GENERATE)"). `transcribe.csv` stays intentionally `503`
(no external integration wired up). `restart_supported` stays `false` (gate decision E2).

## Setup & commands

```bash
npm install
cp server/.env.example server/.env             # fill GOOGLE_CLIENT_ID/SECRET for real OAuth

npm run dev                                    # server :8787 + Vite :5173 (concurrently)
npm run build && npm run start                 # production: server serves web/dist
npm run typecheck                              # server + web + e2e
npm test                                       # server vitest (unit + integration)
npm run e2e                                    # Playwright smoke (hermetic server on :8791)
npm run lint                                   # biome: web src/, e2e/, playwright.config.ts, companion/src, server/src
```

- Two vitest tiers (`test.projects` in `server/vitest.config.ts`): **unit** (`*.test.ts`, node, no bindings) and
  **integration** (`*.int.test.ts`, node, real SQLite via `server/src/test/setup.int.ts`).

## Invariants (spec)

- **The published HTTP/WS contract is frozen** (capability spec `api-contract-freeze`):
  the endpoint inventory (the README endpoint table is the normative route list), JSON
  response shapes, status codes, non-JSON export bodies (CSV/JSONL), header/range semantics,
  and WebSocket message shapes *and emission semantics*. Any observable change requires an
  OpenSpec change whose delta spec authorizes it — shape/status-code edits are **never**
  "small, obvious fixes". Non-loopholes: surface with no current in-repo caller stays frozen
  (it exists for stale/external clients), and co-mutating `web/`/`companion/` in the same
  change does not exempt the server delta (deployed Companion installs lag the repo).
- **Single Node process** — no clustering, no multi-worker fan-out.
- **SessionHub RPC bodies are synchronous** — zero `await`s inside a hub method; async work
  (fetch, streaming) belongs in the router layer.
- **Hub mutations are transactional** — every mutating RPC runs inside a `better-sqlite3`
  transaction.
- **Idle hubs close their DB handles and reopen lazily** on next access via
  `SessionHubRegistry#get()`.
- **Bindings injection in `server/src/app.ts` (`wireApp`) mutates the per-request `env` object
  in place** rather than replacing it — `@hono/node-ws` upgrade handshakes compare that
  object's identity to decide whether to complete the upgrade. Callers must pass a **fresh env
  per request**; reusing one env across concurrent requests will cross-contaminate bindings.
- **Google ID-token verification** fetches Google's JWKS via global `fetch` +
  `jose`'s `createLocalJWKSet` (10-minute cache, refetch once on an unrecognized `kid`) —
  not `jose`'s `node:https`-based remote-JWKS path.
- **Dev auth is anonymous** (`REQUIRE_LOGIN=0`, loopback); OAuth is verified on the production
  serve path — the Vite proxy cannot round-trip the Google callback.

## Source layout

Server code keeps the module-for-module layout it inherited from its Python origin under
`server/src/`; files ported from Python note their origin in a header comment. `server/src/
routers/` holds HTTP-layer route modules only; the app-level `ApiError` class lives at
`server/src/httpError.ts`, outside it. `server/src/node/` now holds exactly the three files
its documented role has always claimed — `config.ts` (composition-root wiring), `systemClock.ts`,
and `presence.ts` — membership pinned by name and test-enforced (`feature-service-packages`),
not merely documented; `server/src/logImport/`, `server/src/ai-runtime/`, and `server/src/
aiV2/` no longer exist — `server/src/` now holds exactly `node`, `auth`, `middleware`,
`routers`, and `test`. Persistence itself lives in three source-only **L1** sibling packages
under `packages/` (extracted from `server/src/session/` and `server/src/db/` and part of
`server/src/node/` by `persistence-package-extraction`, siblings of each other — no L1→L1
edges): `@autologger/session-core` (the live per-session spine — `SessionHub.ts` + domain
stores), `@autologger/catalog` (the catalog query layer — `catalog.ts` + five stores +
migrations `.sql`, no `better-sqlite3` dependency — it speaks the `CatalogDb` port), and
`@autologger/storage` (the SQLite/filesystem adapters — blob store, kv store, `CatalogDb`
implementation, the directory-generic migrator). Four source-only **L2** service packages sit
above L1 — three extracted from `server/src/node/`'s remaining feature files and the retired
`server/src/logImport/` by `feature-service-packages`, and a fourth from the retired
`server/src/ai-runtime/` and `server/src/aiV2/` pair by `ai-runtime-package` — siblings of
each other — no L2→L2 edges, and a service package may import L0/L1 but never another service
package: `@autologger/transcription` (DeepGram transcription), `@autologger/media-import`
(YouTube audio import — imports no workspace package at all, by role rather than by need),
`@autologger/log-import` (Sheets log import; its cross-service coordinator,
`ensureTimedTranscript`, moved into `routers/logImport.ts` rather than the package, per the
router-membership rule below), and `@autologger/ai-runtime` (the AI runtime — MCP tool
server, Claude-CLI and Agent-SDK subprocess runners, turn orchestration, one-shot
generate-turn drivers, and the session aggregate computations the design-turn toolset
exposes; Hono-free and injection-fed, importing no route module and no `_helpers`). The flat
sibling rule is enforced by four checks in `packageBoundaries.repo.test.ts`: the direct
no-sibling rule, a no-L1-imports-L2 rule (closes a launder route through an L1 re-export),
transitive reachability, and a file walk widened to `.mts`/`.cts`. Three source-only **L0**
packages sit beneath L1: `@autologger/domain` (`studio.ts`, `timecode.ts`, `dbShared.ts` —
pure, dependency-free), `@autologger/contract` (`schemas.ts`, `aiV2Catalog.ts`; `zod`
declared as a peerDependency), and `@autologger/ports` (interface-only port types + `Config`
— no runtime implementations). Each L1 package exports **facade interfaces**
(property-style function-type members, so drift is compiler-checked) instead of its concrete
classes; `server/src/appEnv.ts` composes the app-level `AppEnv` (`Ports`/`Variables`) over
those facade interfaces and **names zero concrete persistence classes** — `server/src/node/
config.ts` (the composition root) is the sole production module that still constructs the
concretes, and `middleware/auth.ts` constructs the per-request `Catalog` via
`@autologger/catalog`'s exported `createCatalog` factory (lifecycle unchanged). Cross-package
import boundaries — including the L1-sibling, L2-sibling, and facade-only-consumer rules
above, and the Hono-freedom split between `server/src/routers/` and the AI runtime's package
— are enforced by a repo test (`server/src/packageBoundaries.repo.test.ts`), not the
compiler. Frontend code lives under `web/src/`; e2e smoke tests live under `e2e/`. The
generated architecture atlas + docs SPA (component model, edge extraction, drift gates,
mermaid site) live in `web-docs/` — see README's web-docs section. Full annotated tree + the
normative endpoint table (with its historical Python-origin column) are in **`README.md`**.

## Conventions

- **Conventional commits**: `type(scope): summary` (e.g. `fix(events): …`), matching history.
- **Commit and push only when asked.** Branch off `main` for PRs.
- **Work on plain git branches in this checkout — never create git worktrees** (no
  `EnterWorktree`, no `git worktree add`; this is the declared isolation preference, so
  don't offer worktrees either). Feature work: `git checkout -b <branch>` off `main`,
  implement, merge back. Rationale: subagents don't inherit a worktree cwd, so worktree
  runs leak stray commits onto the primary checkout's `main`.
- **Changes ship with tests.** Run `npm test` (and `npm run typecheck`) before calling it done.
- **`file:line` anchors in specs/plans/briefs go stale** the moment earlier work inserts code.
  Anchors are for orientation; **locate the quoted code by content before editing**, and say
  so in any prompt you hand a sub-agent.
- **The API contract is frozen.** See Invariants — don't change observable HTTP/WS behavior
  or add API surface without an authorizing OpenSpec delta spec.
- **Origin headers are deliberate past-tense provenance** ("ported from `events.py`") —
  don't strip them, and don't turn them back into present-tense obligations.

## Guardrails

- Never commit secrets. `.env` is gitignored; real tokens never land in tracked files.
- `web/dist/` is a reproducible build artifact (gitignored) — don't hand-edit or commit it.
  Keep the Vite dev server loopback-bound (`server.host` pin in `web/vite.config.ts`); LAN
  testing goes through :8787.

## How we work (SDLC)

Non-trivial work follows the superpowers SDLC, captured as **OpenSpec changes** — **don't
jump straight to code**:

**brainstorm (`opsx:explore`) → propose (`opsx:propose`) → adversarial panel + gate →
implement (`opsx:apply`) → archive (`opsx:archive`).** Small, obvious fixes can skip ahead,
but design-bearing changes get a change proposal first.

**`opsx:apply` executes via subagents, never inline.** The orchestrating session that
carried explore → gate stays lean: one disposable implementer subagent per dispatch unit
— each phase is partitioned at its start into units of 1–3 tasks that share files or
context (TDD pairs always batch into one unit; decided 2026-07-14) — strictly
sequential, on a plain branch **whose first commit is the gated OpenSpec artifacts
themselves** (version-pinning the plan of record before any dispatch; decided
2026-07-14), risk-tiered per-phase review subagents (one reviewer over each phase's
cumulative diff after its last task lands — but only for phases touching the frozen
contract surface, auth/security-sensitive validation, concurrency/caching/transaction
semantics, or destructive data ops; other phases defer to the whole-branch review,
and fix-wave re-reviews scope to the fix diff rather than a cumulative re-read —
decided 2026-07-14, replacing the code-bearing/mechanical threshold), an always-on
whole-branch review at the end that runs as a **layered scoped audit** (its package always
includes contract/seam-relevant diffs of every surface-touching phase, full diffs of
deferred/mechanical phases, diffs of clean phases sharing files/state with deferred ones,
re-reads of phases modified after their review closed, the branch's materialized file
list — `git diff --stat`/`git log --stat` + stray-file scan, tree hygiene answered in
affirmative-evidence form, package integrity verified at build with truncation a build
failure — and all call sites of every declared seam checked against the declared
property (both decided 2026-07-27); it skips only the
internal-quality re-read of non-contract code in full-tier phases that closed clean —
decided 2026-07-14, replacing the cumulative re-read), one change in flight per checkout
(commit spike/side artifacts to their own branch before starting an apply; decided
2026-07-14), and file-based handoffs (reports,
diff files, progress ledger under `openspec/changes/<name>/.apply/`, git-ignored). The gated OpenSpec artifacts are the task
briefs — dispatch prompts point at them rather than pasting context. Full protocol lives in
`.claude/skills/openspec-apply-change/SKILL.md` (steps 6–7); `.claude/skills/openspec-propose/SKILL.md`
carries a matching customization (its Output step stops at the gate instead of prompting
apply); re-apply either customization if the `openspec` CLI regenerates that skill. Process rules live **normatively in the three
operational encodings** — this file, that skill, and `openspec/config.yaml` — with no
parallel process rulebook (gate ruling 2026-07-14, recorded durably as the `sdlc-process`
marker spec); process-rule changes are design-bearing, never "small, obvious fixes".

Artifacts live in `openspec/changes/<name>/`: `proposal.md` (why/what + Non-Goals),
`spec.md` (normative capability requirements — SHALL + WHEN/THEN scenarios), `design.md`
(how + decisions + the **Panel & review log**), and `tasks.md` (**the plan of record** —
the phased, test-gated implementation breakdown; put TDD-step detail in `design.md` when a
change is complex enough to need it). On archive, delta specs sync into the durable
`openspec/specs/` baseline. `openspec validate <name> --strict` is a mechanical pre-gate
check. The legacy `docs/superpowers/specs|plans/` are **frozen historical records** — new
work goes through OpenSpec, not there. Repo conventions are also encoded as
`openspec/config.yaml` `context` + per-artifact `rules`, so generated artifacts inherit them.
**Final gates**: branch completion and archive both run root `npm run docs:check` (the
web-docs architecture atlas' drift gate); a change whose archive adds a new capability to
`openspec/specs/` attaches it in `web-docs/model/components.ts` in that same archive commit
(pending-grace ends when the capability joins the baseline).

**`opsx:propose` ordering — do not skip the gate.** `opsx:propose` drafts *all four*
artifacts at once, and OpenSpec treats a change as apply-ready the moment `tasks.md` exists
— it has **no notion of the gate**. So `tasks.md` is **provisional** until the panel + gate
pass: run the panel on `proposal.md` + `spec.md` + `design.md`, gate it, fold the rulings
back across **all four** artifacts (tasks included), run the consistency read, *then*
`opsx:apply`. (`openspec/changes/de-cloudflare-strong-core` is the reference example.)

### Adversarial review of the spec

Before implementation (`opsx:apply`) — i.e. while `tasks.md` is still provisional — run an
**adversarial panel on the `proposal.md` + `spec.md` + `design.md`** — the earliest,
least-reversible artifacts, where catching a wrong assumption is cheapest. A flawed
spec makes a *perfect* plan build the wrong thing.

**Before the panel, run a light-tier fact-check pass** (decided 2026-07-14): a mechanical
fetch-and-compare reviewer verifies the *stated* checkable claims in
`proposal.md`/`spec.md`/`design.md` against the live repo (symbol existence, caller
counts, wire shapes, "X is dead/unused" claims, file inventories), recording per-claim
method and evidence. An adequate method (decided 2026-07-27): however claims are
enumerated, each states the **property to verify**, never a line to confirm — the pass
answers the property, not the pointer; and CONFIRMED stays reserved for mechanically
checkable facts, which for a claim about what a *function does* means reading the whole
function plus any callee on the claim-relevant path — the log entry then quotes the
claim-relevant code path and says which read was done, so the panel can spot-check the
reasoning rather than inherit the verdict (a single-line read supports only a claim
about that line). Judgment-laden claims stay "unverified" and reach the panel
un-vouched. Corrections land
in the draft; the pass gets a dated Panel & review log entry (claims checked / corrected /
left unverified). The pass is an **aid, never a warrant**: the panel prompt says stated
claims were pre-checked and points at the log, and **explicitly preserves the reviewers'
full skeptical mandate** — reviewers verify anything they doubt and remain the only
mechanism that can surface *implicit* premises the pass structurally cannot enumerate.
Never phrase the panel prompt as "don't re-verify". Claims introduced later, when rulings
are folded back, are covered by the post-gate consistency read.

Fan out (via `dispatching-parallel-agents`) reviewers with **distinct** mandates —
not clones:

- **Requirements** — what could be built into the wrong thing?
- **Assumptions** — what's assumed true but unverified?
- **Failure & abuse** — how does this break or get misused? Threat model?
- **Scope & simpler design** — what's over-built (YAGNI), what simpler approach is skipped?

Calibrate them **skeptical** — default to finding a path to a wrong/broken outcome
before approving (the opposite of the stock "approve unless broken" reviewers).
Then **synthesize** (dedup, resolve conflicts, rank by severity) and feed that into
the user's spec-review gate — the panel *arms* the human gate, it doesn't replace it.

Disposition rule: a finding that conflicts with the user's stated mandate is
**escalated to the gate as an explicit decision, never silently adopted or
dismissed** — the panel doesn't outrank the owner, and the mandate doesn't
grade its own work. Record every disposition in the artifact's dated
**"Panel & review log"** section, in three buckets: blockers/majors *fixed in
place*, findings *escalated to the gate* (with the eventual decision), and
minors *accepted as residual*.

When fanning out sub-agents (here or anywhere), **match model tier to the task**:
light models (haiku/sonnet) for fetch-and-compare verification and mechanical
sweeps; heavyweight models for synthesis and adversarial judgment. Apply-time
implementer subagents default to **mid-tier** — the gated artifacts already carry
the design reasoning — with the top tier an exception that must earn its ledger
justification (decided 2026-07-14).

Keep plan review as-is (single reviewer over `tasks.md`: spec coverage, decomposition,
buildability). Only add a *lighter* adversarial pass on `tasks.md` — scoped to
architecture/decomposition, **not** requirements — if real design decisions leak
downstream into the tasks.

### Research artifacts feed specs — verify them first

Research/knowledge artifacts a spec will consume (OKF bundles, gap analyses,
architecture comparisons) get two review shapes **before** they count as spec
input: an adversarial fact-verification pass (independent skeptics refuting
claims against primary sources / live code) and a final consistency +
completeness review. They're complementary — per-claim refuters can't see
stale copies of corrected claims; a consistency pass can't detect false
facts. Record both as dated entries in the artifact's log; design judgments
stay unverified and go to the spec panel. Mechanics: OpenSpec artifact
instructions (`openspec instructions <artifact> --change <name> --json`) plus
the `openspec/config.yaml` rules.

### Post-gate edits get a consistency read, not a re-panel

The same complementarity applies downstream: when gate decisions or review
fixes are applied as **targeted edits** to an already-reviewed artifact (a
`spec.md`/`design.md` after its gate, `tasks.md` after its review), run one
**light-tier consistency reviewer** over the final document before it feeds the next
stage — stale pre-decision language, contradictions between dispositions and
normative sections, broken cross-references. A full re-panel is warranted
only for **structural rework**; disposition-recording prose is not that.

**The read's outcome is always recorded** (decided 2026-07-14): a dated line in the Panel
& review log — either "clean", naming the documents read, or the findings and their fixes
— so a clean read is distinguishable from a read that never ran. (Evidence: the read found
real fixes in both documented runs, then silently lapsed for three consecutive changes;
one undocumented "clean" run missed a stale line. Recording closes both the accountability
hole and the measurement hole.)

### Docs-only exception

Docs/ledger-only campaigns (audits, triage records, campaign ledgers, memory
bookkeeping) may commit directly to `main` without a feature branch.
Compensating control: `main` is never pushed automatically, and the
whole-campaign review must pass before any push — review findings land as fix
waves on main, not silent history edits. Anything touching code, tests, or CI
still branches.
