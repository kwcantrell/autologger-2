# CLAUDE.md — autologger-cf

Guidance for Claude Code in this repo. Read at the start of every session.
For deep architecture, endpoint parity, and storage layout see **`README.md`** —
this file stays short and points there rather than duplicating it.

## Project overview

Portable Node server port of the Python AutoLogger backend (`../autologger`) — a faithful
TypeScript reimplementation serving the **same JSON shapes** the existing React frontend
expects. **Hono** routing + **Zod** validation + **jose** for Google ID-token verify, on:

- **better-sqlite3** — catalog DB (`DATA_DIR/catalog.db`: users/studios/shows/prefs, login
  sessions, OAuth CSRF, Companion presence, sessions index) + one DB file per session
  (`DATA_DIR/sessions/<id>.db`).
- **Filesystem blobs** (`DATA_DIR/blobs/audio/…`) — audio bytes, replacing R2.
- **In-process SessionHub per session** — live spine: events, transport, audio metadata,
  recording lease (timer-driven auto-expiry), transcript words, topics, WebSocket fan-out.
  Replaces the Durable Object.
- **`@hono/node-ws`** for WebSocket upgrades, served by **`@hono/node-server`**.

**Runs anywhere Node 22 runs.** No cloud account, no login, no remote provisioning — a single
Node process, state on local disk under `DATA_DIR`. Transcription + YouTube import are
intentionally `503` on this deployment (no external transcription integration wired up).
`restart_supported` stays `false` (gate decision E2).

## Setup & commands

```bash
npm install
cp .env.example .env                           # fill GOOGLE_CLIENT_ID/SECRET for real OAuth

npm run dev                                    # tsx watch → 127.0.0.1:8787
npm run typecheck                              # tsc --noEmit
npm test                                       # vitest run (unit + integration projects)
```

- Two vitest tiers (`vitest.workspace.ts`): **unit** (`*.test.ts`, node, no bindings) and
  **integration** (`*.int.test.ts`, node, real SQLite via `src/test/setup.int.ts`).

## Invariants (spec)

- **Single Node process** — no clustering, no multi-worker fan-out.
- **SessionHub RPC bodies are synchronous** — zero `await`s inside a hub method; async work
  (fetch, streaming) belongs in the router layer.
- **Hub mutations are transactional** — every mutating RPC runs inside a `better-sqlite3`
  transaction.
- **Idle hubs close their DB handles and reopen lazily** on next access via
  `SessionHubRegistry#get()`.
- **Bindings injection in `src/app.ts` (`wireApp`) mutates the per-request `env` object in
  place** rather than replacing it — `@hono/node-ws` upgrade handshakes compare that object's
  identity to decide whether to complete the upgrade. Callers must pass a **fresh env per
  request**; reusing one env across concurrent requests will cross-contaminate bindings.
- **Google ID-token verification** fetches Google's JWKS via global `fetch` +
  `jose`'s `createLocalJWKSet` (10-minute cache, refetch once on an unrecognized `kid`) —
  not `jose`'s `node:https`-based remote-JWKS path.

## Source layout

Mirrors the Python backend module-for-module; each `src/` file notes its Python origin in a
header comment. Router files live in `src/routers/`; the live per-session spine is
`src/durable/SessionHub.ts` (+ domain stores alongside it); the catalog DB layer is
`src/db/d1.ts` with migrations in `src/db/migrations/`; Node-specific infrastructure (config
wiring, migrator, blob store, kv-on-sqlite, presence) lives in `src/node/`. Full annotated
tree + endpoint→Python-parity table are in **`README.md`**.

## Conventions

- **Conventional commits**: `type(scope): summary` (e.g. `fix(events): …`), matching history.
- **Commit and push only when asked.** Branch off `main` for PRs.
- **Changes ship with tests.** Run `npm test` (and `npm run typecheck`) before calling it done.
- **`file:line` anchors in specs/plans/briefs go stale** the moment earlier work inserts code.
  Anchors are for orientation; **locate the quoted code by content before editing**, and say
  so in any prompt you hand a sub-agent.
- **Maintain Python parity.** This is a port — match the existing JSON response shapes and
  status codes the React frontend expects; don't invent new API surface without a spec.

## Guardrails

- Never commit secrets. `.env` is gitignored; real tokens never land in tracked files.
- `public/` is a reproducible build artifact (gitignored) — don't hand-edit or commit it. The
  frontend source still lives in the parent Python repo until sub-project 2 moves it here.

## How we work (SDLC)

Non-trivial work follows the superpowers SDLC — **don't jump straight to code**:

**brainstorm → spec (`docs/superpowers/specs/`) → plan (`docs/superpowers/plans/`) →
implement.** Small, obvious fixes can skip ahead, but design-bearing changes get a
spec first.

### Adversarial review of the spec

Before `spec → plan`, run an **adversarial panel on the spec** — the earliest,
least-reversible artifact, where catching a wrong assumption is cheapest. A flawed
spec makes a *perfect* plan build the wrong thing.

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
sweeps; heavyweight models for synthesis and adversarial judgment.

Keep plan review as-is (single reviewer: spec coverage, decomposition, buildability).
Only add a *lighter* adversarial pass on the plan — scoped to architecture/decomposition,
**not** requirements — if real design decisions leak downstream into the plan.

### Research artifacts feed specs — verify them first

Research/knowledge artifacts a spec will consume (OKF bundles, gap analyses,
architecture comparisons) get two review shapes **before** they count as spec
input: an adversarial fact-verification pass (independent skeptics refuting
claims against primary sources / live code) and a final consistency +
completeness review. They're complementary — per-claim refuters can't see
stale copies of corrected claims; a consistency pass can't detect false
facts. Record both as dated entries in the artifact's log; design judgments
stay unverified and go to the spec panel. Mechanics:
`.agents/skills/agent-sdlc/authoring.md`.

### Post-gate edits get a consistency read, not a re-panel

The same complementarity applies downstream: when gate decisions or review
fixes are applied as **targeted edits** to an already-reviewed artifact (a
spec after its gate, a plan after its review), run one **light-tier
consistency reviewer** over the final document before it feeds the next
stage — stale pre-decision language, contradictions between dispositions and
normative sections, broken cross-references. A full re-panel is warranted
only for **structural rework**; disposition-recording prose is not that.

### Docs-only exception

Docs/ledger-only campaigns (audits, triage records, campaign ledgers, memory
bookkeeping) may commit directly to `main` without a feature branch.
Compensating control: `main` is never pushed automatically, and the
whole-campaign review must pass before any push — review findings land as fix
waves on main, not silent history edits. Anything touching code, tests, or CI
still branches.
