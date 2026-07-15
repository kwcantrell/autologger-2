## Why

A retrospective across the last five applied changes (`de-cloudflare-strong-core`,
`session-deep-links`, `teams-self-serve`, `teams-settings-nav`, `deepgram-transcription` —
4 with full `.apply` ledgers: 23 phase reviews, 4 whole-branch reviews, ~34 dispatch units
covering 61 tasks, plus panel & gate logs for all 7 archived changes) shows the SDLC's
correctness value is concentrated in specific steps while cost concentrates in others that
caught nothing:

- **Earned decisively:** the adversarial panel (highest-value catch in every change — mostly
  *false factual premises* in the drafts), the human gate (2–7 genuine forks per change,
  zero rubber stamps), full-tier phase reviews (4 real catches in 23 reviews, **all four in
  full-tier categories** — the 2026-07-14 risk-tiering is empirically validated), TDD unit
  gates (zero unexpected failures), orchestrator handoff notes (prevented ≥3 defects in one
  change), and gate-verification tasks (the single best catch of the period — a real
  DeepGram key leaking into "hermetic" e2e servers — came from verifying a gate's *intent*
  in a phase whose review was skipped as mechanical).
- **Zero correctness yield:** the whole-branch review found **0 new correctness bugs in 4/4
  runs** — its actual output was contract-discipline confirmation, batching cleanups already
  pre-flagged in phase carry-notes, and residual cataloguing, paid for with a full cumulative
  re-read (127 KB diff in one change). (Panel caveat, accepted: all 4 runs sat on branches
  whose risky phases were individually reviewed, so the sample understates what the audit
  must carry once more phases defer to it — hence the layered charter below rather than a
  blanket cut.)
- **Proven then silently dropped:** the post-gate consistency read found real fixes in 2/2
  documented runs (undocumented runs exist, so the true base rate is unmeasured — recording
  outcomes, added below, is what fixes that), but the last three changes never ran it, and
  one undocumented "clean" run demonstrably missed a stale line.
- **Recurring waste:** report boilerplate (~28 KB of reports for a change whose production
  diff was ~120 insertions, +26 net lines, identical gate tails repeated 7–8×); a
  frozen-surface concern self-flagged by an implementer that still cost a phase-review FAIL
  + fix wave + spec edits to adjudicate (deepgram 499→400); scope guards *causing* drift
  (`normalizeEmail` duplicated 3× including a factually false "out of scope" comment); and a
  paid-API spike burning a full dispatch on a stale credential.

This change codifies the retro's fixes: cut the cost where yield was zero, harden the steps
that demonstrably carry correctness, and lose nothing that ever caught a bug.

## What Changes

All rules land as edits to the three existing operational encodings — `CLAUDE.md`,
`.claude/skills/openspec-apply-change/SKILL.md`, and `openspec/config.yaml` — which remain
the normative process home (gate ruling 2026-07-14: a proposed parallel process rulebook was
cut as a drift generator; a minimal capability marker records that ruling durably).

- **Whole-branch review becomes a layered scoped audit** (gate ruling: layered compromise).
  It ALWAYS reads: the diffs of deferred/mechanical phases (their sole review), the
  contract/seam-relevant diffs of every phase that touched the observable HTTP/WS surface or
  produced/consumed cross-phase interfaces, the diffs of clean phases that share files or
  state with deferred phases, and a full re-read of any phase whose code was modified after
  its review closed. It skips only the internal-quality re-read of non-contract code in
  full-tier phases that closed clean ("clean" = no open Critical/Important findings;
  accepted minors are carried to its triage list). Plus: contract-surface audit end-to-end,
  ledger carry-note triage, residual/invariant cataloguing for archive.
- **A light-tier fact-check pass runs on `proposal.md` + `spec.md` + `design.md` before the
  adversarial panel** — mechanical verification of *stated* checkable claims against the
  live repo, recording per-claim method and evidence. It is an **aid, never a warrant**: the
  panel prompt says stated claims were pre-checked and points at the log, while explicitly
  preserving the reviewers' full skeptical mandate — especially for *implicit* premises the
  pass structurally cannot enumerate.
- **Frozen-surface concerns escalate to the owner immediately** — a `DONE_WITH_CONCERNS`
  touching the frozen HTTP/WS contract is a gate question resolved before the next dispatch.
  This is a latency fast-path, not the sole guard: units touching frozen-surface-adjacent
  code also add an affirmative self-check line to their report ("emits only statuses/shapes
  in the authorized delta: yes/no + list"), so silence becomes a checked assertion.
- **The post-gate consistency read is reinstated as a required step with a recorded
  outcome** — a dated log line, "clean" (naming documents read) or findings + fixes, so
  clean is distinguishable from uninspected. Claims introduced while folding gate rulings
  back are covered by this read.
- **Shared-helper preassignment:** at each phase partition the orchestrator scans for logic
  shared with already-landed code *and* later planned tasks (tasks.md is known up front) —
  especially auth/correctness-relevant logic — and names the shared home (file + export) at
  the earliest partition where the need is visible, revisiting each phase. Implementers
  extract there instead of duplicating, and never write scope comments that misstate scope.
- **Report diet:** implementer reports keep everything unit-specific (decisions, deviations,
  files changed, RED/GREEN evidence, self-review findings, concerns, interfaces, and a
  one-line per-unit gate assertion); only the *repeated* boilerplate (full suite tails,
  known pre-existing warnings, branch-hygiene recitals) moves to one ledger line per phase.
- **Gate-intent verification guardrail** (gate ruling: adopt): in every phase — including
  mechanical and deferred ones — the implementer verifies each gate's *intent* (the property
  the gate exists to establish, e.g. hermeticity), not just its exit code, and records
  findings. This encodes the period's highest-yield catch.
- **Single controlled diagnosis, with a contest hatch:** a suspected-environmental gate
  failure gets one controlled experiment whose method and conditions are recorded with the
  verdict; later steps cite it rather than re-deriving — but any reviewer may reject a
  verdict whose recorded experiment doesn't meet the identical-conditions bar (re-run once,
  re-record). A verdict is challengeable with concrete cause, never frozen.
- **Paid-API spike pre-flight:** one minimal probe validates credentials before dispatching
  any unit that calls a paid external API — preferring an unmetered auth/reachability
  endpoint, recording only PASS/FAIL + endpoint (never response bodies or credential
  material); re-probe on credential rotation or any auth failure mid-session.
- **Governance files get parse/load verification:** `openspec/config.yaml` and skill
  frontmatter are machine-parsed tooling inputs, not inert prose — after editing them, run
  `openspec validate` against a change and confirm the skill still loads, and record the
  result. "Docs-only" is not verification-exempt.

## Capabilities

### New Capabilities
- `sdlc-process`: a minimal marker capability (single requirement) recording the gate ruling
  that the three operational encodings are the normative SDLC record, that no parallel
  process rulebook may duplicate them, and that process-rule changes are design-bearing
  (panel + gate, never "small, obvious fixes"). It deliberately does **not** restate the
  rules above — they live in the encodings.

### Modified Capabilities

(none — no existing capability's requirements change)

## Impact

- **Contract impact: none.** No HTTP/WS/JSON surface is touched; this change edits process
  documentation and governance files only.
- **Affected files:** `CLAUDE.md`, `.claude/skills/openspec-apply-change/SKILL.md`,
  `openspec/config.yaml`, and the minimal `specs/sdlc-process/spec.md` marker (delta →
  durable baseline on archive).
- **No code, tests, or CI are modified** — but the governance files are machine-parsed, so
  the change verifies parse/load after editing (see What Changes) in addition to
  `npm run typecheck` + `npm test` proving the diff has no runtime surface.
- **Landing path (gate ruling 2026-07-14): light.** Panel + gate ran at propose time (this
  change's Panel & review log); the edits land on a plain branch in one implementer pass,
  followed by a consistency read with recorded outcome and the parse/load checks, then
  merge. No dispatch-unit partitioning, phase reviewers, or whole-branch reviewer — running
  the full apply pipeline on four doc files would enact the over-process this change trims.

## Non-Goals

- **Visual-pipeline determinism** (font/renderer pinning or a `maxDiffPixels` tolerance to
  kill environmental snapshot drift): touches Playwright config — code, not docs. Recorded
  as a follow-up roadmap candidate, not part of this change.
- **No change to the adversarial panel itself** (4 reviewers, skeptical calibration,
  escalation rule): cross-reviewer duplication was observed but independent convergence on
  the biggest blockers is a confidence signal, and the panel is the top-earning step. The
  fact-check pass does add a stage *in front of* the panel — that changes the panel's
  operating context (it receives pre-checked stated claims) but not its structure, mandate,
  or calibration, which this change deliberately leaves untouched.
- **No change to risk-tiering thresholds, TDD pairing, sequential dispatch, or the
  one-change-in-flight rule** — all validated by the retro evidence.
- **No retroactive editing of archived changes' artifacts.**
