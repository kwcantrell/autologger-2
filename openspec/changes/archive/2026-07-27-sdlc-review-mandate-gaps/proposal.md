# sdlc-review-mandate-gaps — Proposal

## Why

The `feed-row-seek` retro (archived 2026-07-27; 11 phases, 30 tasks, 37 pre-rewrite
commits, ~5,800 added lines, all subagent-dispatched) surfaced four defects the current review pipeline
either missed outright or caught only by luck, plus one architecture question the pipeline
keeps re-encountering without ever dispositioning:

1. **Branch hygiene has no owner.** A 1.3 MB QA screenshot — written as a file literally
   named `-s` when a subagent consumed a flag as a filename — was swept into commit
   `55c0cdc` under a message claiming only checkbox ticks, by what the cleanup commit's
   own message describes as an orchestrator `git add -A` (no independent record of the
   staging command survives). No reviewer ever had it in view: the whole-branch audit
   packages carried no stat sections, the scoped re-reviews were structurally scoped past
   it, and the quality-audit package was built two minutes *after* the cleanup commit had
   already removed it. Worse, panel verification found the deferred-phase audit package
   **ends at its phase-11 header with no content** — phase 11 was never reviewed by
   anyone, and neither the package builder nor the auditor noticed. The user found the
   file by asking what it was, and it had to be rewritten out of history (preserved at
   tag `backup-pre-rewrite`). No rule constrains staging on any committer, no review
   mandate materializes or checks the branch's file list, and nothing verifies audit
   packages contain what their headers claim.
2. **A fact-check item can confirm a misleading answer to a badly-scoped question.** The
   pre-panel pass CONFIRMED "`seekToTimelineSec` returns silently when no playable clip
   covers the target" — true of the one line it was pointed at, false of the function,
   which resolves *forward* to a different recording. Three of four panel reviewers caught
   it independently; it became design.md D6, adjacent to the branch's one Critical.
3. **A caller-supplied parameter is an undeclared seam.** `useTimelineSeek(sessionId,
   events, batchEditMode)` was defined in phase 3 (full-tier, reviewed clean in
   isolation); phases 6/7/8 then each independently chose an `events` source, and the
   choice produced a clip layout different from the player's — the branch's one Critical.
   Every phase was individually correct; the defect lived only in the seam, and nothing in
   the partition or audit rules named that seam as a thing to watch.
4. **A fix for a Critical shipped with its own guarantee untested.** The C1 fix wave
   passed every gate; the scoped re-reviewer then mutated the new provider to
   `{ clips: [] }` and the entire web suite stayed green. The fix failed *safe*, so
   nothing signalled — but the feature would have died silently.

Separately, the retro re-opened (5) whether the deferred review tier is calibrated
correctly, and (6) whether the "three operational encodings, no rulebook" architecture
(gate ruling 2026-07-14, recorded in `sdlc-process`) should itself be revisited — a
question whose current spec wording forecloses more broadly than the ruling behind it
actually did (see design.md D6). Per `sdlc-process`, all of this is design-bearing and
must run the full panel + gate pipeline.

## What Changes

All rule content lands as edits to the three operational encodings — `CLAUDE.md`,
`.claude/skills/openspec-apply-change/SKILL.md`, `openspec/config.yaml` — which remain the
normative process home (per design.md D6, this change evaluates and **declines** replacing
that architecture; the marker spec's wording is corrected to match the actual 2026-07-14
ruling scope).

- **Staging discipline for every committer + a materialized, integrity-checked file list
  for the audit** (finding 1; see design.md D1): orchestrator bookkeeping commits stage
  explicit paths, never `git add -A`/`git add .`, with unexplained paths dispositioned on
  the ledger; implementer dispatch prompts gain the same staging discipline (subagents
  make most of a branch's commits); the audit package build materializes the branch's
  `git diff --stat`/`git log --stat` file list plus a mechanical stray-file scan, verifies
  **package integrity** (every phase section non-empty, stat totals reconciling against
  `main...HEAD`), and the audit answers tree hygiene in affirmative-evidence form
  (counts + "flagged: none"/list), not a one-liner.
- **Fact-check items verify properties, not lines** (finding 2): however claims are
  enumerated, each states the *property* to verify, not a line to confirm; a claim about
  what a function does requires reading the whole function (and its callees on the
  relevant path), and a behavioral CONFIRMED quotes the claim-relevant code path in the
  log entry so the panel can spot-check the reasoning, not just the verdict. Encoded in
  CLAUDE.md's fact-check block, reconciled with its existing "CONFIRMED is reserved for
  mechanically checkable facts" reservation.
- **Caller-supplied parameters are declared seams** (finding 3): at partition time —
  revisited at every subsequent partition — a parameter of a shared interface that later
  phases will satisfy independently is named in the ledger as a **seam declaration**
  (sibling of the shared-helper preassignment), stating the property every call site must
  satisfy (usually agreement with an external consumer — *not* mere inter-caller
  uniformity, which a uniformly-wrong set of callers satisfies); the audit package always
  includes all call sites of every declared seam, read together against the declared
  property, and declared seams are a **floor, not a ceiling** — the audit still questions
  undeclared independently-satisfied parameters it encounters.
- **A Critical's fix ships with a mutation-verified guard** (finding 4): a fix wave
  closing a merge-blocking finding (anchored to consequence — merge-blocking or
  silent-wrong-behavior — not to an undefined severity label) must (a) demonstrate the
  failure before the fix reproducibly (named command/test, not prose), and (b) show its
  covering test is load-bearing by mutating the fixed guarantee and watching the named
  test fail, working-tree-only, never committed. The scoped re-review **re-executes** the
  recorded mutation and remains expected to run one of its own choosing — record-reading
  alone would have missed F4. "Suite green after fix" alone does not close a Critical.
- **Deferred-tier calibration** (finding 5): put to the panel as an open question, not
  proposed as a rule — the evidence cuts both ways (design.md D5). The panel sharpened it:
  the discretionary "quality audit" layer is encoded nowhere, so its post-"all clean"
  findings are escapes from the *designed* pipeline; its status (standing vs
  discretionary) went to the gate alongside the tier question. Gate ruling 2026-07-27:
  tier unchanged, quality audit recorded as discretionary with the residual stated — an
  explicit no-change disposition (design.md D5), no encoding edit.
- **Marker-spec wording correction** (finding 6): `sdlc-process` is amended to record the
  2026-07-14 ruling at its actual scope — it rejected a *parallel, duplicating* rulebook;
  a *replacement* architecture (single normative source, operational surfaces mechanically
  derived) was never put to that gate. This change evaluated replacement on its merits and
  **keeps the three encodings** (design.md D6, ratified at the gate 2026-07-27, with the
  evidence that would reverse it recorded), so the question ends dispositioned rather than
  open a third time.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `sdlc-process`: the single marker requirement is modified to (a) state the
  no-rulebook prohibition at the 2026-07-14 ruling's actual scope — no parallel rulebook
  *duplicating* the encodings — and (b) record that replacing the encodings with a single
  derived source is not pre-foreclosed but is itself design-bearing, was evaluated
  2026-07-27, and was declined. The marker still does not restate any rule content the
  encodings carry.

## Impact

- **Contract impact: none.** No HTTP/WS/JSON surface is touched; this change edits
  process documentation and governance files only.
- **Affected files:** `CLAUDE.md` ("How we work" subsections), 
  `.claude/skills/openspec-apply-change/SKILL.md` (steps 6–7 + Guardrails), and the
  `sdlc-process` delta (→ durable baseline on archive). `openspec/config.yaml` is
  untouched (no rule fires at artifact-generation time — design.md D7; the gate routed
  nothing there).
- **No code, tests, or CI are modified.** `npm run typecheck` + `npm test` prove the diff
  has no runtime surface; the skill file is machine-loaded, so a skill-load check and
  `openspec validate --strict` run after editing (2026-07-14 D11 precedent).
- **Landing path: light** (gate-ratified 2026-07-27; precedent: 2026-07-14
  sdlc-retro-improvements D11). Panel + gate at propose time; edits land on a plain
  branch in one implementer pass; consistency read with recorded outcome; verification
  set; merge. No dispatch-unit partitioning or phase reviewers.
- **Prerequisite**: git tag `backup-pre-rewrite` must survive until this change's
  corrected artifacts land post-gate — it is the only remaining evidence for finding 1
  (its commits are unreachable from `main` and become GC-eligible on deletion).

## Non-Goals

- **No change to the panel's structure** (4 reviewers, skeptical calibration,
  escalation rule) or to TDD pairing, sequential dispatch, or one-change-in-flight — none
  implicated by the retro's findings.
- **No replacement of the three-encodings architecture** — evaluated and declined
  (design.md D6); the reversal conditions are recorded there. A future change may re-open
  it against that record.
- **No rule content in the marker spec.** Findings 1–4 land in the encodings only;
  `sdlc-process` stays a marker.
- **No retroactive editing of archived changes' artifacts** — feed-row-seek's record
  stands as written; this change cites it.
- **No automation/tooling** (pre-commit hooks, size linters) for finding 1 — that touches
  CI/config-as-code and is recorded as a roadmap candidate, not built here.
