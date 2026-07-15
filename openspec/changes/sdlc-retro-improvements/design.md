## Context

A five-session retrospective (2026-07-14) mined the process evidence of the last five applied
changes — `de-cloudflare-strong-core`, `session-deep-links`, `teams-self-serve`,
`teams-settings-nav`, `deepgram-transcription` — using the four surviving `.apply` ledgers
(23 phase reviews, 4 whole-branch reviews, ~34 dispatch units covering 61 tasks, every task
report) plus the Panel & review logs of all seven archived changes. Headline findings, with
sources:

- **Panel:** highest-value step in all 7 changes; its dominant demonstrated value was
  catching **false factual premises in the drafts** (dead-`rowsWritten` claim in
  de-cloudflare; "Python repo no longer exists" in retire-python-port-framing; "resolution
  rides `GET /api/sessions`" in session-deep-links S1; label-keyed-wire assumption in
  teams-settings-nav). Zero panel findings later proven wrong at the blocker/major level;
  some reviewer noise (wrong claims costing refutation) and 2–3× cross-reviewer duplication
  per change. Note: several premise-catches required *generating the hypothesis* (nobody
  wrote "rowsWritten is dead" as a checkable claim until an adversary asked who reads it) —
  adversarial judgment, not mechanical lookup.
- **Phase reviews:** 4 real catches in 23 reviews — gcTime staleness and an async
  origination race (session-deep-links phases 4–5), the `enabled_admin_count` contract gap
  (teams-self-serve phase 2), the 499 contract violation (deepgram phase 4). **All four sit
  in full-tier risk categories** (contract / caching / concurrency), validating the
  2026-07-14 risk-tiering decision. Reviews outside those categories yielded endorsements
  and nits only. Also: the gcTime issue had been documented-as-fine by its implementer —
  implementer self-assessment is not reliable on its own.
- **Whole-branch review:** 0 new correctness bugs in 4/4 runs. Actual output: end-to-end
  contract-discipline confirmation, batching of cleanups already pre-flagged in phase
  carry-notes (3 of 5 findings in teams-self-serve), residual cataloguing. Cost: a full
  cumulative re-read (127 KB diff in deepgram). Sample caveat (panel, accepted): all 4
  branches had their risky phases individually reviewed, so the sample understates the
  audit burden of the new regime, which defers more phases to it.
- **Gate-verification tasks:** the single best catch of the period — the real
  `DEEPGRAM_API_KEY` silently inherited by "hermetic" e2e servers (commit `867e555`) — was
  found by *verifying a gate's intent* in a phase whose review was skipped as mechanical.
- **Consistency read:** 2/2 documented runs found real fixes (a stale pre-S1 contract line
  in session-deep-links; a panel miscount in add-login-screen). Silently dropped in the
  last three changes; one undocumented "clean" run (retire-python-port-framing task 5.3)
  missed a stale README line that survives to this day. (2/2 is a survivorship figure —
  clean runs weren't recorded, so the per-run base rate is unmeasured; mandatory outcome
  recording, D4, is what fixes that.)
- **Recurring waste:** report boilerplate (~28 KB of reports for teams-settings-nav, whose
  production diff was ~120 insertions / +26 net lines; identical gate tails repeated 7–8×
  per change); the deepgram 499 concern — self-flagged by the implementer — still costing a
  phase-review FAIL + fix wave + spec edits to adjudicate; per-unit scope guards *causing*
  drift (`normalizeEmail` triplicated, including a factually false "out of scope" comment);
  the deepgram spike burning a full dispatch on a stale credential; the session-deep-links
  visual diffs diagnosed twice (implementer stash-check, then a full rebuild-diagnosis
  subagent) with identical conclusions.

The SDLC's operational encoding lives in `CLAUDE.md` (How we work), the customized
`.claude/skills/openspec-apply-change/SKILL.md`, and `openspec/config.yaml` rules. The gate
(2026-07-14) ruled these three encodings ARE the normative process home — see D9.

## Goals / Non-Goals

**Goals:**
- Remove the cost that produced zero correctness yield (whole-branch cumulative re-reads of
  low-risk code, report boilerplate, duplicate diagnoses) without removing any mechanism
  that ever caught a bug — and without blinding the audit to the code most likely to carry
  a contract violation (panel blocker, addressed by the layered charter in D1).
- Harden the steps the evidence says carry the correctness: panel premises (fact-check
  pass, as an aid not a warrant), owner adjudication latency (immediate frozen-surface
  escalation, as a fast-path with an affirmative self-check backstop), consistency reads
  (required + recorded), and gate-intent verification (the period's highest-yield lesson,
  D10).
- Keep the three operational encodings the single normative home per rule (D9, as gated).

**Non-Goals:**
- Visual-pipeline determinism (Playwright config/renderer pinning) — code change, separate
  follow-up.
- Any change to the panel's structure, mandate, or calibration; risk-tiering thresholds;
  TDD pairing; sequential dispatch; one-change-in-flight — all validated by the evidence.
- A durable normative process rulebook — **rejected at the gate** (D9).
- Retroactive edits to archived changes.

## Decisions

### D1 — Whole-branch review becomes a *layered* scoped audit (gate ruling: layered compromise)
**Decision:** keep the whole-branch review always-on. Its package ALWAYS includes: (1) full
diffs of deferred/mechanical phases — their sole review; (2) the contract/seam-relevant
diffs of every phase that touched the observable HTTP/WS surface or produced/consumed
cross-phase interfaces, regardless of tier or outcome; (3) full diffs of clean phases that
share files or state with deferred phases; (4) a full re-read of any phase whose code was
modified after its review closed. It skips only the internal-quality line-by-line re-read
of non-contract code in full-tier phases that closed clean — where "closed clean" means no
open Critical/Important findings; accepted minors carry to the audit's triage list. The
audit also owns: end-to-end contract-surface delta vs the authorized delta specs, ledger
carry-note triage, and residual/invariant cataloguing for archive.
**Alternatives considered:**
- *Reports-only for all clean full-tier phases (original draft)* — **rejected by the panel
  (blocker, 3 reviewers)**: full-tier phases are by definition the contract/concurrency-
  bearing ones; exempting their diffs blinds the contract audit to exactly the code most
  likely to violate it, leaving an unflagged deviation that a phase reviewer misses with no
  second reader. The 0/4 evidence also came from branches whose risky phases were all
  individually reviewed — a lighter audit burden than the new regime creates.
- *Drop the whole-branch review entirely* — rejected: it is the sole reviewer for deferred
  phases and the only end-to-end contract-delta owner.
- *Keep the full cumulative re-read* — rejected: 0/4 bug yield on the internal-quality
  re-read of full-tier-reviewed code; the fat being cut is that re-read, not the audit's
  inputs.
**Residual accepted (gate 2026-07-14):** internal caching/concurrency logic in full-tier
phases that closed clean and is neither contract- nor seam-relevant has the phase review as
its sole reader. Rationale: phase reviews were 4/4 effective on exactly those categories
when present, and fix-diff-scoped re-reviews keep them engaged through fix waves. Tripwire:
if a merge regression ever traces to code the audit skipped, restore the wider read by a
process change.
**Invariant a future reader might "helpfully" undo:** do not quietly restore the full
cumulative re-read ("to be safe" — its measured yield was zero on the code it would re-add),
and do not let "per-phase diff exclusion" ever exclude contract- or seam-touching hunks from
the audit package — that recreates the panel's blocker.

### D2 — Pre-panel fact-check pass: a separate light-tier step, an aid never a warrant
**Decision:** a mechanical fetch-and-compare reviewer verifies the *stated* checkable claims
in `proposal.md`/`spec.md`/`design.md` against the live repo before the panel is dispatched,
recording per-claim method and evidence (auditable, not bare CONFIRMED verdicts); CONFIRMED
is restricted to mechanically checkable facts — judgment-laden claims stay "unverified" and
reach the panel un-vouched. Corrections land in the draft; the pass is logged. The panel
prompt states that *stated claims* were pre-checked (pointing at the log) **and explicitly
preserves the reviewers' full skeptical mandate** — reviewers verify anything they doubt,
and remain the only mechanism that can surface *implicit* premises the pass structurally
cannot enumerate. New claims introduced when rulings are folded back are covered by the
consistency read (D4).
**Alternatives considered:**
- *Original draft wording ("premises have been fact-checked... not re-verification")* —
  **rejected by the panel (blocker, 3 reviewers)**: it inverts the rigor ordering (a single
  light-tier pass vouching to four heavyweight skeptics) and nudges the panel away from the
  exact hypothesis-generating behavior that caught `rowsWritten`. A wrong CONFIRMED would
  actively launder a false premise.
- *Fold fact-checking into one panel reviewer's mandate* — considered at panel (scope
  reviewer) and not taken: the separate light-tier pass demonstrated its value on this very
  change (5 corrections for one cheap pass) and keeps the panel's four mandates intact; the
  cost difference is small and the stage's log gives the consistency read an anchor.
- *Skip it; the panel catches premises anyway* — rejected: it does, but late and at top
  tier.
**Trade-off accepted:** one extra light-tier pass of latency per change at propose time.

### D3 — Frozen-surface concerns: immediate owner escalation as a fast-path, plus an affirmative self-check
**Decision:** a `DONE_WITH_CONCERNS` touching the frozen contract is a gate question,
resolved before the next dispatch; never parked for the phase review. Because the trigger
keys on the implementer's self-flag — and the evidence shows self-assessment is unreliable
(the gcTime issue was documented-as-fine) — this is framed as a **latency fast-path, not a
guard**: the phase review and the audit's contract feed (D1 item 2) remain the detection
layers. As a backstop that makes silence an assertion rather than an omission, any unit
touching frozen-surface-adjacent code adds one affirmative line to its report: "emits only
statuses/shapes/headers in the authorized delta: yes/no + list".
**Alternatives considered:**
- *Status quo (park for phase review)* — rejected by direct evidence: the deepgram 499 was
  known at commit time, yet took a phase-review FAIL, an owner escalation, a fix-wave
  re-dispatch, and edits to three spec/design artifacts to resolve — four steps for one
  question.
- *Let the orchestrator auto-resolve to the "obvious" authorized status* — rejected: the
  contract delta table is gate-owned by the freeze invariant; an orchestrator ruling on it
  is the exact loophole the CLAUDE.md non-loopholes clause closes.
(The observed frequency is n=1 — the deepgram 499 across ~34 units — so no rarity claim is
load-bearing here; the rule stands on the latency evidence alone.)

### D4 — Consistency read: required after post-gate edits, outcome recorded
**Decision:** reinstate the existing CLAUDE.md consistency-read rule as a hard requirement,
and add the missing half: the outcome (clean — naming documents read — or findings + fixes)
is a dated log line.
**Alternatives considered:**
- *Keep it optional/informal* — rejected: it silently disappeared for three consecutive
  changes despite finding real fixes in both documented runs.
- *Full re-panel after gate edits* — rejected (and already rejected by the standing
  CLAUDE.md rule): disposition-recording prose is not structural rework.
**Why recording matters:** "2/2 documented runs found fixes" is survivorship — clean runs
weren't recorded, so documented-clean is currently indistinguishable from never-ran, and
one such run provably missed a stale line (retire-python README). Recording closes both
gaps: the accountability hole and the measurement hole.

### D5 — Shared-helper preassignment: earliest-visible, cross-phase scan
**Decision:** at each phase partition the orchestrator scans for nontrivial logic shared
with *already-landed code and later planned tasks* (tasks.md is known up front) — especially
auth/correctness-relevant logic — and names the shared home (file + export) in the ledger
and the affected dispatch prompts at the earliest partition where the need is visible,
revisiting at every subsequent partition. Implementers extract there instead of duplicating
and never write scope comments that misstate what was in scope.
**Alternatives considered:**
- *Within-phase-only trigger (original draft)* — rejected by the panel: the actual
  `normalizeEmail` triplication was *cross-phase* (phases 1/2/3); a per-phase-only scan
  misses the motivating case by construction.
- *Relax per-unit scope guards generally* — rejected: scope discipline is load-bearing
  (minimal diffs, reviewable units); the failure mode was the absence of a designated
  shared home, not the guard.
- *Status quo: consolidate at branch review* — rejected: that shipped a factually false
  scope comment on authorization-relevant code and spent a branch-review finding on
  preventable drift.

### D6 — Report diet: unit-specific content stays, only repeated boilerplate moves
**Decision:** reports keep everything unit-specific — decisions, deviations, files changed,
RED/GREEN evidence, self-review findings, concerns, interfaces produced, and a one-line
per-unit gate assertion ("full suite green: N passed, typecheck clean") so per-unit ground
truth survives for phase reviewers, who receive reports rather than the ledger. Only the
*repeated* boilerplate — full suite tails, known pre-existing warnings, branch-hygiene
recitals — moves to one ledger line per phase, with reports saying "gates green (see
ledger)" beyond their one-line assertion.
**Alternatives considered:**
- *Closed "only" list (original draft)* — rejected by the panel: read literally it stripped
  self-review findings and files-changed (both load-bearing in the skill's report contract)
  and collapsed per-unit suite counts a reviewer needs to spot a unit that silently ran a
  subset.
- *Keep verbose reports* — rejected: ~7–8× repetition per change was measured; the retro's
  forensic needs are covered by what stays (RED/GREEN, deviations, self-review) plus the
  ledger.
**Durability note (accepted residual):** the ledger is git-ignored and now carries more
single-copy state; `openspec/changes/**/.apply/` is preserved on disk through archive (the
deepgram-era gitignore rule), and the reports keep their unit-specific content, so loss
requires losing the working tree. A committed per-phase summary at archive was considered
and deferred as scope creep.

### D7 — Single controlled diagnosis, with a contest hatch
**Decision:** a suspected-environmental gate failure gets one controlled experiment; the
ledger records the verdict *with the experiment's method and conditions*; later steps cite
it rather than re-deriving. The bar binds redundant re-derivation of a *sound* experiment
only: any reviewer may reject a verdict whose recorded experiment doesn't meet the
identical-conditions bar or when concrete new evidence contradicts it — then one re-run,
re-record. A verdict is never uncontestable.
**Alternatives considered:**
- *Absolute re-derivation ban (original draft)* — rejected by the panel: it would freeze a
  wrong "environmental" verdict on a genuinely branch-induced regression, overriding the
  standing "visual diffs are branch-induced signal" default with no recovery path.
- *Allow free re-verification* — rejected: session-deep-links proved the same environmental
  conclusion twice at full cost.

### D8 — Paid-API spike pre-flight, with probe hygiene
**Decision:** before dispatching any unit that calls a paid external API, the orchestrator
(or the unit itself as its first recorded step) validates credentials/reachability with one
minimal probe — preferring an unmetered auth/reachability endpoint over a billable inference
call — and records **only PASS/FAIL + endpoint** in the ledger (never response bodies,
tokens, or credential material). Re-probe on credential rotation or any auth failure
mid-session; "validated earlier this session" does not survive a 401.
**Alternative considered:** let the unit discover it — rejected: the deepgram spike burned a
full dispatch cycle (PARTIAL → re-dispatch) on a stale key sitting in `server/.env`.

### D9 — No durable process rulebook; the encodings are the normative home (REVERSED at the gate)
**Decision (gate 2026-07-14):** the original draft's `sdlc-process` capability spec — nine
normative requirements restating the rules — is **cut**. The three operational encodings
(`CLAUDE.md`, the apply skill, `config.yaml`) are the normative process record; the rules
land there and only there. What remains in `specs/sdlc-process/` is a minimal
single-requirement marker recording this ruling (encodings are normative; no parallel
rulebook may re-grow; process-rule changes are design-bearing) — the smallest delta that
satisfies the spec-driven schema without duplicating rule content.
**Panel findings that drove the reversal:** the spec created a fourth sync surface with a
self-admitted drift risk; its consistency-SHALL was the same unenforced-rule class that the
retro proved lapses (the consistency read itself); it was a deliberately partial baseline,
so "single normative home" was never delivered; and a process rulebook sat categorically
oddly among product capabilities in `openspec/specs/`. The scope reviewer's simpler
alternative — CLAUDE.md already points at the skill as the full protocol — was adopted.
**Invariant a future reader might "helpfully" undo:** do not re-grow a parallel normative
process document; amend the encodings directly (the marker spec's second scenario exists to
block exactly that).

### D10 — Gate-intent verification guardrail (gate ruling: adopt)
**Decision:** in every phase — including mechanical and deferred ones — the implementer
verifies each gate's *intent* (the property the gate exists to establish: hermeticity,
isolation, contract byte-identity), not just its exit code, and records findings in the
report. One guardrail line in the apply skill; no new pipeline step.
**Rationale:** the period's single highest-yield catch (the DEEPGRAM key leak, `867e555`)
came from exactly this behavior, in a phase with no reviewer; the original draft encoded
two n=1 papercuts as rules while leaving this lesson un-encoded — a scope inversion the
panel flagged.

### D11 — Landing path: light (gate ruling), with governance-file verification
**Decision:** panel + gate ran at propose time. The edits land on a plain branch in one
implementer pass, then a consistency read with recorded outcome, then the verification set:
`openspec validate` (config.yaml still parses and injects rules), a skill-load check
(frontmatter intact), `npm run typecheck` + `npm test` (diff has no runtime surface),
`git diff --stat` confirming only the expected paths. Then merge. No dispatch-unit
partitioning, phase reviewers, or whole-branch reviewer.
**Alternatives considered:**
- *Full apply pipeline* — rejected at the gate: running the heavyweight pipeline on four
  doc files enacts the over-process this change trims.
- *Docs-only direct-to-main* — considered (CLAUDE.md permits it) and not taken: a branch
  costs nothing and keeps the merge atomic.
**Why verification despite "docs-only":** `config.yaml` and skill frontmatter are
machine-parsed tooling inputs; a malformed edit silently strips freeze-guidance from every
future generated artifact or breaks skill loading — a parse failure, not a docs failure
(panel blocker, assumptions reviewer).

## Risks / Trade-offs

- **[The layered audit still skips some code]** → the skip is confined to non-contract,
  non-seam, internal-quality re-reads of full-tier phases that closed clean — the exact
  slice with 0/4 measured yield; contract/seam/deferred/mutated code always reaches the
  audit. Tripwire recorded in D1.
- **[Fact-check pass gives the panel false confidence]** → aid-not-warrant wording is
  normative in the encodings; per-claim method/evidence makes wrong CONFIRMEDs auditable;
  reviewers' skeptical mandate is stated in the panel prompt itself.
- **[Self-flag-keyed escalation misses unflagged deviations]** → framed as a fast-path;
  detection stays with phase reviews + the audit's contract feed; the affirmative
  self-check line converts silence into a checked assertion.
- **[Encodings drift apart (three homes)]** → unchanged from today's steady state (the
  gate cut the fourth home rather than adding it); process-rule changes are design-bearing
  per the marker spec, so they get panel + consistency read, which is where cross-encoding
  contradictions surface.
- **[Report diet loses forensic detail]** → only repeated boilerplate moves; everything
  unit-specific, including self-review findings and per-unit gate assertions, stays in
  reports.
- **[Ledger as single copy of more state]** → accepted residual (D6 durability note).

## Migration Plan

Docs-only. The rules take effect for the next change proposed after this one merges.
Reverting the docs commits restores the prior process.

## Open Questions

None.

## Panel & review log

### 2026-07-14 — Pre-panel fact-check pass (light tier)

22 checkable claims in `proposal.md` + `design.md` verified against the archived ledgers,
git history, and current governance files (`spec.md` carried no independently checkable
code facts). **17 confirmed, 5 corrected in place:**

- "~60 dispatch units" → **~34 dispatch units covering 61 tasks** (the draft conflated
  units with tasks; ledger unit lines: 14 + 9 + 4 + 7, plus 8 fix-wave/diagnostic
  dispatches).
- "2–4 genuine forks per change" at the gate → **2–7** (deepgram-transcription's gate log
  has 7 numbered decisions).
- teams-settings-nav "~150-line change" → **~120 insertions / +26 net lines** of production
  code across 4 code commits (one of which is e2e/test-only).
- deepgram 499 fix wave touched **three** spec/design artifacts (`design.md`,
  `api-contract-freeze` delta, `transcript-generation` delta), not two.
- Frozen-surface concern frequency → **1 in ~34 dispatch units**, not 1 in ~60.

Notable confirmations: 23 phase reviews with exactly 4 fix-wave-producing catches, all in
full-tier categories; 4/4 whole-branch reviews with zero new correctness bugs; consistency
reads 4/7 ran, 2/2 documented outcomes found real fixes, absent from the last 3 changes;
the retire-python archived README still carries the gate-reversed "in-repo consumers"
wording; `~/AutoLog` exists on disk today. No claim was unverifiable.

### 2026-07-14 — Adversarial panel (4 reviewers: requirements / assumptions / failure & abuse / scope-simpler)

Verdicts as returned: requirements REQUEST-CHANGES (2 blockers), assumptions
REQUEST-CHANGES (2 blockers), failure & abuse BLOCK (1 blocker), scope
CHANGE-WITH-BLOCKERS (1 blocker). The gate was told to treat this change's own fact-check
log as unratified (the mechanism under review was used on the change introducing it) and to
re-verify freely.

**Blockers / majors fixed in place:**

- **Scoped audit blinded to contract-bearing phases** (failure&abuse B1 + requirements
  B2/M1/M2 + assumptions B1, independently convergent): reports-only for all clean
  full-tier phases removed the contract audit's inputs, left "closed clean" undefined,
  ignored post-review mutations, and generalized 0/4 evidence gathered under a lighter
  deferral burden. → D1 rewritten as the layered charter (gate ruling below); "closed
  clean" defined; mutated phases re-read; shared-state adjacency rule added; tasks.md
  packaging instruction rewritten so exclusion can never drop contract/seam hunks.
- **Fact-check pass blunting the panel** (requirements B1 + assumptions M1 + failure&abuse
  M1, independently convergent): "not re-verification" inverted the rigor ordering and
  suppressed hypothesis-generation. → D2 rewritten aid-not-warrant: per-claim
  method/evidence, CONFIRMED restricted to mechanically checkable facts, skeptical mandate
  preserved in the panel prompt, implicit-premise hunting explicitly retained.
- **Docs-only ≠ verification-exempt** (assumptions B2): config.yaml and skill frontmatter
  are machine-parsed; a bad edit silently strips rule injection or breaks skill loading. →
  D11 verification set; proposal Impact updated.
- **Self-flag-keyed escalation over-promised** (assumptions M2 + requirements minor +
  failure&abuse m1): gcTime evidence shows implementers misjudge concerns as fine. → D3
  reframed as latency fast-path + affirmative contract self-check line.
- **Report-diet "only" list stripped load-bearing content** (requirements M4 + assumptions
  m1): self-review findings, files changed, per-unit gate assertions restored; only
  repeated boilerplate moves (D6).
- **Diagnosis verdict unchallengeable** (requirements M5 + failure&abuse M3): absolute
  re-derivation ban froze wrong verdicts against the "branch-induced signal" default. → D7
  contest hatch: method/conditions recorded; unsound experiments rejectable; one re-run.
- **Shared-helper trigger scoped within-phase while the motivating case was cross-phase**
  (requirements M3): → D5 earliest-visible cross-phase scan, revisited each partition.
- **Spike probe hygiene** (failure&abuse m3 + requirements minor): PASS/FAIL + endpoint
  only, unmetered endpoint preferred, re-probe on rotation/401; who-runs clarified (D8).
- **Survivorship/n=1 overclaims** (assumptions m2, m3): "2/2 hit rate" restated honestly
  (Context, D4); "1 in ~34" rarity demoted to a non-load-bearing n=1 note (D3).
- **Non-Goals overclaimed "panel untouched"** (scope M4): reworded — the stage changes the
  panel's operating context, not its structure/mandate/calibration.
- **No-op scenarios** (scope m1): moot for the cut spec; the marker spec's two scenarios
  each discriminate (design-bearing routing; rulebook-regrowth rejection).

**Escalated to the gate (all four dispositioned 2026-07-14):**

1. **Durable `sdlc-process` spec: cut vs keep-slimmed vs as-drafted** (scope B1/M1/m3;
   assumptions M3; requirements M6; failure&abuse M4 all bore on it) → **CUT**. Encodings
   are the normative home; minimal single-requirement marker records the ruling (D9). The
   marker resolves the spec-driven schema's at-least-one-delta requirement without
   duplicating rule content.
2. **Audit charter: layered compromise vs keep-cumulative vs as-drafted** (the convergent
   blocker) → **LAYERED COMPROMISE** (D1), with the internal-quality residual explicitly
   accepted and a tripwire recorded.
3. **Landing path: light vs direct-to-main vs full pipeline** (scope m2) → **LIGHT PATH**
   (D11): plain branch, one implementer pass, consistency read + parse/load verification,
   merge.
4. **Gate-intent verification rule** (scope M3 — the period's highest-yield lesson was
   un-encoded while two n=1 papercuts got requirements) → **ADOPT as skill guardrail**
   (D10). The two n=1 rules (diagnosis, pre-flight) stay, but as skill-level rules rather
   than normative spec requirements — consistent with the spec cut.

**Minors accepted as residual:**

- Ledger concentrates more single-copy state in a git-ignored file (failure&abuse m2) —
  accepted with D6's durability note; committed per-phase archive summaries deferred.
- The bootstrap circularity (failure&abuse m4: the change used its own unratified
  fact-check pass) — disclosed to the gate before rulings; accepted.
- Fact-check pass cannot enumerate implicit premises (assumptions M1 core) — inherent
  limit, mitigated by preserving the panel's mandate rather than claimed away.
- Mechanical-phase audit load lacks its own worked example until the next apply runs the
  new charter (requirements minor) — accepted; the first apply under the new rules is the
  example.

### 2026-07-14 — Post-gate consistency read (light tier)

**CLEAN** — documents read: `proposal.md`, `specs/sdlc-process/spec.md`, `design.md`,
`tasks.md`. Verified: no stale pre-gate language (cut rulebook, old reports-only charter,
full-pipeline landing all appear only as historical data or rejected alternatives); every
tasks.md instruction traces to its design decision (D1→2.4, D2→1.1, D3→2.1, D4→1.2/4.1,
D5→2.2, D6→2.3, D7/D8/D10→2.5, D9→1.3, D11→header/4.2) with matching substance; the marker
spec matches D9 and the proposal's Capabilities section; fact-check-corrected figures are
consistent across artifacts; the four gate dispositions match D9/D1/D11/D10.
`openspec validate --strict` passes.

### 2026-07-14 — Apply-stage consistency read (light tier, task 4.1)

**CLEAN** — documents read: `CLAUDE.md`, `.claude/skills/openspec-apply-change/SKILL.md`,
`openspec/config.yaml`, and this change's four artifacts. Verified: every encoding edit
matches its design decision with equal substance (D1→CLAUDE.md summary + SKILL step 7 +
guardrails; D2→CLAUDE.md fact-check block; D3→SKILL 6d/6c; D4→CLAUDE.md recorded-outcome
rule; D5→SKILL partition block; D6→SKILL 6c/6f/guardrails; D7/D8→SKILL verification
discipline; D9→CLAUDE.md normative-home sentence + marker spec; D10→SKILL 6c +
guardrails); no live instruction still describes the cumulative re-read, single
`branch-diff.txt` packaging, or reports-only draft charter (all remaining mentions are
dated provenance); SKILL.md steps and Guardrails correspond 1:1; config.yaml parses as
YAML with each rule a single-line list item.
