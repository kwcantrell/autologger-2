## Why

The owner stated the SDLC's purpose (2026-08-09): it exists **exclusively for AI agents**, following
it should produce **high-quality code**, and it should enable (1) a human to state a feature with as
little context as possible, (2) the receiving agent — that feature's orchestrator — to compare the
feature against current repo state and work with the human to resolve conflicts, and (3) the
orchestrator to flesh the feature out with the human first.

**All three clauses live pre-proposal. Roughly 96% of CLAUDE.md's SDLC section governs
post-proposal work.** Two panels — eight reviewers — converged on the same diagnosis:

- **Purpose 2 has zero encoded lines.** Nothing obliges an orchestrator to check a request's
  premises against the tree, or to route a feature-vs-repo conflict to the human. The fact-check
  pass verifies *stated* claims; an unstated framing premise passes untouched. **Seven** archived changes
  carry a false repo-state premise (derivation: seven Class-A instances independently derived and
  each verified against its primary `design.md`; an earlier draft said ten, which no source
  supported), and "web split" propagated through **five** changes' artifacts,
  **five panels and five gates** untested — because nobody ever asserted it. It was load-bearing in
  `router-directory-decomposition` E2 ("only step 5 can determine"); step 5 declined the split, and
  `clientAggregates.ts` sits orphaned today with its pinning test still reaching into `packages/`.
- **The propose skill actively opposes purpose 3.** `openspec-propose/SKILL.md:123` instructs
  *"prefer making reasonable decisions to keep momentum"* — at the exact moment purpose 3 says to
  flesh the feature out **with** the human.
- **Claims about the repo keep entering artifacts unverified.** In one change: a false motivating
  defect, a false precedent citation, four wrong counts from four different instruments, a
  characterization relayed from a subagent into a commit message, and a capability claim corrected
  three times and still incomplete.

The failures are **routing and timing**, not volume. Every one is a rule that existed but did not
reach the agent at the moment it acted, or a check that ran too late to be cheap.

## What Changes

Three edits to the encodings. One adds, one deletes, one re-times an existing check. No new artifacts
and no new capability. **One** spec requirement — a placement principle carrying no rule content
(see Capabilities).

- **Premise-checking becomes an obligation at propose time.** Before drafting `proposal.md`'s Why,
  the orchestrator measures the request's stated premises against the tree — bounded to the nouns
  the framing names and any inherited deferral pointers it relies on — records a
  `Current state, measured on <branch> @ <sha>` block, and routes any contradiction to the human as
  a numbered decision with at least two priced options. Three consecutive designs already open with
  such a block; this codifies converged practice rather than inventing work.
- **`openspec-propose/SKILL.md:123` is deleted.** "Prefer making reasonable decisions to keep
  momentum" is a one-line instruction to do the opposite of purpose 3.
- **The fact-check enumeration widens** by three classes — **precedent citations** ("X is precedent
  for Y" requires showing X is live and load-bearing), **capability/coverage claims** (what a guard
  catches is checkable), and **characterizations relayed from subagents** — plus: any count entering
  an artifact carries its derivation inline.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `sdlc-process`: gains **one** requirement — a **placement principle**: a rule lands on the
  encoding the acting agent loads at the moment it applies, judged by **reach** rather than topical
  fit. This is governance, consistent with that capability's architecture, and it explicitly carries
  no rule content. It is the durable form of this change's central finding (design D1): the three
  encodings have materially different reach, and every routing failure observed was a rule sitting
  on a surface its actor never loaded.

  The three edits themselves land in the encodings and carry no spec requirement — they are content,
  and the encodings remain the normative record of content. The change runs the full
  panel-and-gate pipeline as `sdlc-process` requires of process-rule changes.

**One honest note.** Edit (b) touches `openspec-propose/SKILL.md`, which is **not** one of the three
encodings. That surface already carries repo process rules today, so the enumeration is already
inaccurate — but this change only *removes* content there, which strictly improves compliance rather
than worsening it. Correcting the enumeration is left to a change that can evaluate it properly.

## Impact

**Contract impact: none.** No HTTP route, JSON shape, status code, export body, header/range
semantic, or WebSocket message shape or emission semantic is touched. **No runtime code at all** —
no file under `web/`, `server/`, `packages/`, `companion/`, or `e2e/`.

| target | change | net |
|---|---|---|
| `CLAUDE.md` — `opsx:propose` ordering paragraph | premise check + conflict routing | +4 lines |
| `CLAUDE.md` — fact-check enumeration | +3 claim classes, counts carry derivation | +2 lines |
| `.claude/skills/openspec-propose/SKILL.md` | delete the momentum clause | −1 line |
| `openspec/specs/sdlc-process/` (delta) | one placement-principle requirement | +~20 lines |

**Gates skipped, declared not assumed:** no runtime surface is touched, so `npm run e2e` and
`npm run e2e:visual` are not run. `npm run typecheck`, `npm test`, `npm run lint`, and
`npm run docs:check` are still run.

**Machine-parsed governance files:** no task edits `openspec/config.yaml` or skill frontmatter. Edit
(b) removes a body line only — the task states this explicitly and verifies the skill still loads.

## Non-Goals

- **The `sdlc-retro-loop` proposal this replaces.** It proposed a rule-inclusion test, a tracked
  per-change `retro.md`, an index, and three governance requirements — ~125 lines. Eight reviewers
  across two panels blocked it: three of its six rules failed its own inclusion test, its accretion
  diagnosis was contradicted by the evidence (the variable is **reach**, not length — `CLAUDE.md`
  auto-loads for every agent, the apply skill reaches only the orchestrator, `openspec/specs/`
  reaches nobody by default), its filter did not produce its own selection, and its central artifact
  had **no reader anywhere in the change**. The null option was judged better than that draft for
  the whole governance tier, and is adopted here.
- **A rule-inclusion test.** Its only trial *added* two gate questions rather than removing
  thirteen.
- **Tracked retro evidence.** No agent reads it; the evidence-survival loss is real and separable.
- **Cutting existing text.** Reviewers named `CLAUDE.md:292-304` ("Research artifacts feed specs")
  as 13 lines that have never fired — "OKF" appears nowhere else in the repo and zero of 39 archived
  designs record either mandated review shape — plus eight `(decided …)` stamps carrying
  archived-design rationale on the highest-cost surface. Cutting is a separate change with its own
  evidence burden; bundling deletions with additions would make both harder to review.
- **Escalation discipline (filtering + priced options).** Drafted, approved by the owner
  (2026-08-09), then **removed at the owner's instruction (2026-08-09)** once the fact-check
  established its headline evidence was a grep artifact: the claimed 0-2-then-4/5/6/10 escalation
  trend does not exist (14 of 39 changes sit in the 0-2 bucket; 25 carry 3-6 across the whole
  history). What survives is one confirmed instance — `ai-runtime-package`'s E9 and E10, both
  answered verbatim by CLAUDE.md. One instance plus principle was judged insufficient. Deferred
  with that instance recorded, so a later change can re-derive it against real evidence.
- **Any runtime code change.**
