# sdlc-review-mandate-gaps — Design

## Context

The evidence base is the `feed-row-seek` apply record (archived
`openspec/changes/archive/2026-07-27-feed-row-seek/`; its git-ignored `.apply/` scratch dir
survives on disk — `ledger.md` is the spine, plus ~15 per-unit and per-review reports).
Scale: 11 phases, 30 tasks, 37 pre-rewrite commits (36 survive on `main`), ~5,800 added
lines (5,830 insertions / 414 deletions across 56 files), all subagent-dispatched.
Review layers that ran: pre-panel fact-check, 4-reviewer adversarial panel, 2 consistency
reads, 2 focused reviewers, 3 full-tier phase reviews, 1 whole-branch layered audit, 2
scoped re-reviews, 1 quality audit — which together produced 1 Critical, 7 Important
(3 whole-branch audit, 2 first scoped re-review, 2 quality audit), and ~20 Minor
findings, and still missed finding 1 entirely.

Per-finding evidence, verified against the live repo and git 2026-07-27:

- **F1 (stray binary):** `git log --oneline main..backup-pre-rewrite -- ':(literal)-s'`
  shows `55c0cdc docs(openspec): tick tasks 5.1-5.2, 10.1-10.2, 11.1-11.6` adding a
  1,368,484-byte binary named `-s` (a subagent QA screenshot; the flag was consumed as a
  filename), removed only by `28bac9a`. The commit message claimed checkbox ticks; the
  sweep vector was, per the cleanup commit's own account, an orchestrator `git add -A`
  (no independent record of the staging command survives — ledger, reports, and reflog
  are silent on it). Three review layers ran after the sweep and none flagged it — but
  panel verification corrected the mechanism: **no reviewer ever had the file in view.**
  The whole-branch audit packages contained no stat sections (raw per-phase diffs only);
  the scoped re-reviews diffed fix ranges that structurally excluded it; the quality-audit
  package — the only one with a STAT section — was built at 00:24:57, two minutes after
  cleanup commit `28bac9a` (00:22:35) had removed the file. And the package build itself
  silently failed: `audit-package-deferred.txt` ends at its `--- Phase 11 … ---` header
  with no content, so **phase 11 was never reviewed by anyone** and neither builder nor
  auditor noticed. (Plausible, unproven mechanism: a repo-root file named `-s` reaching a
  git invocation parses as the suppress-output flag — the stray file may have concealed
  itself. The empty section is fact regardless.) History was rewritten to drop the blob;
  tag `backup-pre-rewrite` preserves the pre-rewrite tip and **must survive until this
  change's corrected artifacts land post-gate**.
- **F2 (misleading CONFIRMED):** feed-row-seek `design.md`, Panel & review log, fact-check
  entry: the pass confirmed "`seekToTimelineSec` returns silently when no playable clip
  covers the target" — true of the pointed-at line, false of the function
  (`resolvePlayPosition` resolves forward to the next playable clip). 3/4 panel reviewers
  caught it; it became D6, the design correction adjacent to the branch's one Critical.
- **F3 (undeclared seam):** feed-row-seek whole-branch audit, Critical C1: phase 3
  (full-tier, reviewed clean) defined `useTimelineSeek(sessionId, events, batchEditMode)`;
  phases 6/7/8 each independently chose an `events` source; two chose `useEvents(limit
  200)` while the player used `useEvents(limit 2000)` — different query keys, different
  clip layouts, coverage answering against a layout the player didn't have, wrong-take
  playback. The audit's own record: "Every phase was individually correct. The defect
  lived entirely in the seam between them."
- **F4 (untested fix guarantee):** feed-row-seek fix wave 1 closed C1 and passed every
  gate; the scoped re-reviewer then mutated the new provider to `{ clips: [] }` and the
  whole web suite stayed green — the parity test asserted against a hand-written mirror,
  not the real workspace. Failed safe (feature silently dead), so nothing signalled.
- **F5 (tier calibration):** 7 of 11 phases tiered `deferred` plus 1 `mechanical` — 8
  phases whose sole reviewer was the whole-branch audit, which is where the Critical
  surfaced and where most quality-audit findings traced. Panel additions to the record:
  the "quality audit" layer is encoded in none of the three encodings (it was
  discretionary, run after the designed pipeline recorded "apply complete, all reviews
  clean"), and phase 11's audit-package section was empty (above), so one nominally
  audit-covered phase was in fact reviewed by no one.
- **F6 (three-encodings architecture):** assembling the apply protocol takes 5+
  operations across 3 files at every apply-session start; `SKILL.md` is a generated file
  the `openspec` CLI can overwrite (CLAUDE.md itself says "re-apply that customization");
  `config.yaml` rules surface only during artifact generation; a process-rule change is a
  3-encoding edit plus a delta. Against that: each encoding auto-loads at its point of
  use, and the feed-row-seek apply ran 11 phases correctly off them — its failures
  (F1–F4) were rule-*content* gaps, not failures to find or sync rules.

## Goals / Non-Goals

**Goals:** give the four demonstrated gaps owners (a rule, a mandate, or both — chosen per
failure mode); disposition the deferred-tier question and the three-encodings question with
recorded reasoning either way; keep the marker spec a marker.

**Non-Goals:** see `proposal.md`. Load-bearing here: no automation/tooling for F1 (roadmap
candidate); no panel-structure change; no retroactive edits to feed-row-seek's artifacts.

## Decisions

### D1 — Finding 1: staging discipline for every committer; a materialized, integrity-checked file list for the audit

**Decision:** three edits (revised by the panel — the draft proposed two, resting on a
false account of what reviewers saw; see Context F1 for the corrected mechanism).

1. *Staging rule (prevention), all committers:* orchestrator bookkeeping commits —
   checkbox ticks, ledger updates, artifact disposition edits — stage **explicit paths**,
   never `git add -A`, `git add .`, or `commit -a`; the orchestrator reads `git status
   --porcelain` before each commit, and every unexplained path gets a **ledger
   disposition line** (path, origin if known, deleted / committed-under-task-N), with
   delete-unless-claimed the default — a silent "looks fine, proceed" reproduces F1's
   evidentiary hole. Implementer dispatch prompts (skill step 6c) carry the same
   discipline: stage explicit paths; report any unexplained tree entry rather than
   sweeping it. (Subagents author most of a branch's commits — feed-row-seek: ~30 of 37 —
   so binding only the orchestrator leaves the majority population unbound.)
2. *Materialized file list + mechanical scan (package build):* the audit package always
   includes the branch's `git diff --stat main...HEAD` and `git log --stat` output, plus
   a mechanical stray-file scan performed at package-build time, flagging — illustratively,
   not exhaustively; the load-bearing test is "accounted for by tasks/ledger" — binaries,
   files over ~100 KB, and names shaped like command-line artifacts (`-s`, `--flag`).
   This is mechanical work and stays at build time; the audit *reviews* the scan rather
   than performing it, protecting the most-capable-model attention budget.
3. *Package integrity + audit mandate (detection):* the package build verifies every
   phase section is **non-empty** and that per-phase diffs reconcile against the
   `main...HEAD` totals — a silent truncation is a build failure to fix, never a quieter
   audit (the demonstrated escape route: phase 11's section was empty and nobody
   noticed). The audit charter gains tree hygiene answered in **affirmative-evidence
   form** — file count plus "flagged: none" or the list with dispositions, the
   frozen-surface self-check's "yes/no + list" pattern — so a one-liner cannot satisfy it.

**Why all three:** the rule alone is the unenforced-rule class the 2026-07-14 retro showed
lapses; the mandate alone detects after N commits, which means history rewrite (what
actually happened); and both together still fail if the package silently omits a phase —
which is not a hypothetical but F1's demonstrated escape route. Escalated; the gate
adopted all three (ruling 1, 2026-07-27).

**Alternatives considered:**
- *Rule only* — rejected: the sweep was itself a violation of the general "commits match
  their message" norm; norms without a detector demonstrably lapsed here.
- *Mandate only* — rejected: detection after 37 commits means history rewrite (cost far
  exceeds prevention).
- *Pre-commit hook / size linter* — deferred (Non-Goal): touches config-as-code; roadmap
  candidate. **Owned honestly:** without it the rules narrow but do not close the lapse
  class — the roadmap candidate carries real weight, not parking.

**Invariant a future reader might undo:** the skill's "one change in flight per checkout"
setup rule exists partly so `git add -A` is *never necessary*; do not "simplify" the
explicit-path rule away on the grounds that the tree is supposed to be clean — F1's tree
was supposed to be clean too.

### D2 — Fact-check items verify properties; function-level claims require whole-function reads

**Decision:** added to CLAUDE.md's fact-check block, reconciled with its existing
"CONFIRMED is reserved for mechanically checkable facts" reservation rather than layered
beside it:

1. However claims are enumerated (dispatch prompt, the pass's own listing — no standing
   "checklist" artifact exists), each is phrased as the **property to verify** ("jumping
   to an uncovered second must not start audio anywhere") — never as a line to confirm
   ("line N returns early"). The pass answers the property, not the pointer.
2. A claim about **what a function does** is CONFIRMED only after reading the whole
   function and any callee on the claim-relevant path, and a behavioral CONFIRMED
   **quotes the claim-relevant code path in the log entry** — so panel reviewers can
   spot-check the reasoning rather than inherit the verdict's authority, and a
   whole-function read cannot *increase* unearned confidence. A single-line read supports
   only a claim about that line, and the log entry must say which was done.

**Why:** F2 was not a lazy fact-checker — the pass answered the question it was given,
faithfully. The defect was in question *scoping*, which the current encoding doesn't
address at all. The fix targets the question author (usually the proposer) and the pass's
evidence bar symmetrically. Honesty notes: (a) F2's CONFIRMED of a behavioral claim was
arguably already outside the existing "mechanically checkable facts" reservation — partly
a rule-*following* failure, not purely a content gap (this nuance is carried into D6's
evidence weighing); (b) the generalization from one instance is a bet — the rule is kept
because it is cheap, not because the class is demonstrated; (c) item 1 is prophylactic
question-hygiene rather than a fix for F2's literal shape (the claim *was* function-scoped;
the pass under-read it — item 2 is the closure).

**Alternatives considered:**
- *Drop CONFIRMED for behavioral claims entirely (facts-of-existence only)* — rejected:
  the pass's demonstrated value (5 corrections in 2026-07-14, 1 in feed-row-seek) includes
  behavioral claims; the aid-not-warrant framing already caps the damage — the panel
  caught F2. This tightens the aid rather than amputating it.
- *Have the panel own all behavioral verification* — rejected: that is the status quo that
  made F2 cost three top-tier reviewers to catch what one whole-function read prevents.

### D3 — A caller-supplied parameter satisfied independently by later phases is a declared seam

**Decision:** two edits, mirroring the shared-helper preassignment machinery (skill step 6
partition block + step 7 audit package):

1. *Partition-time seam declaration:* when a phase defines an interface with a parameter
   that later phases will supply **independently** (each call site chooses its own
   source/value), the orchestrator records a **seam declaration** in the ledger at the
   earliest partition where this is visible, **revisiting at every subsequent partition**
   (the sibling shared-helper rule's clause, adopted for the same reason: a seam may only
   become visible when its second caller's phase partitions) — naming the parameter, the
   property every call site must satisfy, and the phases that will call it. The property
   is stated against the seam's **external consumer** where one exists ("every caller
   passes the clip layout *the player consumes*") — not as inter-caller uniformity, which
   a uniformly-wrong set of callers satisfies (in F3, had all three feeds used
   `limit 200`, they would have been mutually consistent and the Critical fully intact).
   Declare-when guidance, so declarations stay signal rather than blanket: declare data
   whose correctness depends on agreeing with another consumer; do not declare per-caller
   mode flags (`batchEditMode`) or identity params (`sessionId`). Dispatch prompts for
   the calling phases carry the declaration, and the ledger partition entry is the
   cross-check that they did.
2. *Audit package rule:* the whole-branch audit package **always includes all call sites
   of every declared seam, packaged together** — regardless of the calling phases' tiers
   or review outcomes — and the charter checks every call site **against the declared
   property**, not merely against each other. Declared seams are a **floor, not a
   ceiling**: the audit still questions any undeclared caller-supplied parameter it finds
   independently satisfied — the declaration mechanism must not let breadth atrophy into
   "declared means owned, undeclared means out-of-charter". A declaration may also name
   the wrong property (the F3-era ledger did not record the player's `limit 2000` source,
   so a real declaration might have missed it) — the unconditional call-site packaging is
   the backstop that keeps this rule additive even then.

**Why this shape:** F3's defect was invisible at every per-phase granularity by
construction — phase 3's reviewer saw a well-typed parameter; phases 6/7/8's work each
made a locally reasonable choice. The only granularity where it exists is "all call sites
at once", which is exactly what the declaration names and the package materializes. The
feed-row-seek audit *did* catch it — but by luck of reading broadly, not because anything
required the call sites to be read together; the fix makes the catch structural. The
declaration also gives implementers the consistency property up front, which plausibly
prevents the defect rather than merely detecting it (the ledger's existing preassignment
notes demonstrably steered implementers).

**Alternatives considered:**
- *Forbid caller-supplied parameters on shared interfaces (make the definer bind the
  source)* — rejected as a blanket rule: sometimes per-caller variation is the point
  (`batchEditMode` in the same hook was correctly per-caller). The C1 *fix* did bind the
  source structurally (context provider) — the right call there, made by design judgment,
  which the declaration prompts ("what must stay consistent?") rather than mandates.
- *Full-tier every phase consuming a shared interface* — rejected: phases 6/7/8 were
  individually correct; per-phase review at any tier cannot see a cross-phase property.
  Wrong tool, real cost.
- *Rely on the audit's existing "cross-phase interface" package rule* — rejected as
  sufficient: that rule already included these phases' diffs (it did fire), yet the
  consistency question was never posed; C1 was found via the defect's symptom, not the
  seam. One near-miss is enough.

### D4 — A fix closing a Critical ships with a demonstrated failure and a mutation-verified guard

**Decision:** skill fix-wave rule (step 6e/7) + guardrail. The obligation is anchored to
**consequence, not label** — it binds any finding the review marks merge-blocking or
whose consequence is silent wrong behavior (the skill nowhere defines "Critical", and a
label-keyed rule invites costless, invisible deflation one label down). Such a fix wave
must record, in the fix report: (a) the failure demonstrated on the pre-fix code
**reproducibly** — a named failing test or a named command with its wrong output; prose
"observed the bug" does not qualify — and (b) a **mutation check** on the fix's central
guarantee: re-introduce the defect (or null out the guard, e.g. provider →
`{ clips: [] }`), name the specific test(s) that fail, revert, show green —
**working-tree-only, never committed** (an interrupted red-green-red must not leave
residue for D1's porcelain check to catch by accident). "Full suite green after fix"
alone does not close such a finding. The scoped re-review **re-executes the recorded
mutation** (observe red, revert, observe green) and remains expected — as before — to
run a mutation of its own choosing: the record supplements the independent adversarial
check that actually caught F4; it must never replace it, and the fix author choosing the
only mutation would convert the control into author-graded homework.

**Why merge-blocking-only (for now):** the cost is one deliberate red-green-red cycle per
qualifying finding — rare by construction (2 review-tier Criticals across the 11 applied
changes with `.apply` ledgers to date). F4 is direct evidence the gap is real at exactly
this severity: a fail-safe defect gave every gate a green light while the guarantee was
untested, and only re-reviewer initiative caught it. Extending to Important-tier findings
roughly 4×–10×es the frequency on thinner evidence — escalated to the gate as an explicit
question; the gate ruled merge-blocking-only (ruling 2, 2026-07-27; revisit at the next
retro if an Important-tier fix ships untested).

**Alternatives considered:**
- *Status quo (re-reviewer discretion)* — rejected: the catch was initiative, not
  mandate; initiative is exactly what doesn't survive personnel/model/context changes.
- *Require mutation testing for every fix wave* — rejected: most fixes are Minors where
  the covering test is the diff itself; blanket cost without matching evidence.

### D5 — Deferred-tier calibration: presented to the panel as an open question

**Decision:** no tier change was proposed. The question went to the panel with the
evidence cut both ways, and the gate's outcome — an explicit no-change with reasons — is
recorded in the decision block below.

*The case that the tier is too permissive:* 7 of 11 phases deferred (plus 1 mechanical —
8 with the audit as sole reviewer); the Critical's call sites sat in deferred phases
6/7/8 (though the seam-defining phase 3 was full-tier and reviewed clean — see the
counter-case below), and most quality-audit findings traced to deferred/mechanical-phase
code; the quality audit found 2 Important + 6 Minor after the layered audit had already
passed the branch.

*The case that the tier is calibrated and the audit did its job:* the Critical was a
cross-phase seam defect — phase 3, the *full-tier* phase that defined the seam, reviewed
clean, and no per-phase reviewer at any tier could have seen it (the audit's own record
says so); it is addressed structurally by D3, not by tiering. The deferred phases' own
correctness findings (I1–I3, minors) were caught by the audit — the designed control for
exactly that code — and the 2026-07-14 evidence base (every Important+ phase finding in a
full-tier category, 23-review sample) stands unrefuted: feed-row-seek's full-tier phases
again reviewed clean.

*Corrections the panel forced on the draft's framing (the draft claimed "latency, not
escaped defects" — refuted):* the quality audit is **encoded in none of the three
encodings**; the designed pipeline recorded "apply complete, all reviews clean" before it
ran, so its 2 Important + 6 Minor are **escapes from the designed pipeline**, caught by a
discretionary layer that nothing mandates. F1 itself was found by the *user* after every
review — an escape on any plain reading (tree-hygiene rather than code, but the exclusion
must be stated, not assumed). And phase 11's empty package section means one entire phase
escaped review *silently* — though that indicts package integrity (fixed in D1(3)), not
the tier rule.

**Decision (gate 2026-07-27):** **(a)** the deferred-tier rule is unchanged — every
demonstrated escape traces to audit *mechanism* (package integrity, charter breadth, an
un-encoded layer) rather than to tiering, and D1(2)/(3) + D3(2) fix mechanism. **(b)**
the quality audit is **discretionary** — run at the owner's option, not encoded as a
standing stage — with the residual stated plainly: the designed pipeline guarantees
correctness coverage, not quality-audit coverage, so quality-tier escapes of the
feed-row-seek kind (2 Importants, 6 Minors, no correctness finding) are accepted; if
subsequent applies keep surfacing Important-tier quality escapes, that is the evidence to
promote it. No encoding edit results from D5 — this recorded no-change is the
disposition. Audit-charter growth remains the standing risk: each retro widens one
context window's charter (this change adds tree hygiene + seam consistency), the single
point of failure is the auditor's attention — mechanical work belongs at package-build
time (D1(2)), and future charter additions should be budgeted against this.

### D6 — The three-encodings architecture stays; the marker spec's wording is corrected to the ruling's actual scope

This is the change's largest question and was worked under an explicit instruction not to
treat the existing rule as settled *or* assume a rulebook is better.

**Step 1 — what the 2026-07-14 gate actually rejected (verified 2026-07-27 against the
archived change).** The rejected artifact was a nine-requirement `sdlc-process` spec
*restating* the rules — a fourth normative surface **duplicating** rule content alongside
the encodings. The gate's escalated alternatives were "cut vs keep-slimmed vs as-drafted"
— all duplication variants. The panel findings driving D9 (fourth sync surface,
self-admitted drift risk, deliberately partial baseline, categorical oddity in
`openspec/specs/`) all attack duplication. Nothing in that change's `proposal.md`,
`design.md` D9, or its Panel & review log considers a **replacement** architecture —
single normative source, operational surfaces derived from it. The current spec sentence
("No parallel process rulebook SHALL duplicate their content") matches the ruling, but the
2026-07-14 proposal's gloss and this repo's operating habit have read it as foreclosing
any rulebook in any relation to the encodings. That is broader than what was gated.
**Consequence regardless of the architecture outcome:** the marker spec is amended to
record the scope precisely and to say replacement is evaluable (delta in this change).

**Step 2 — the replacement question on its merits.**

*For consolidating:* protocol assembly costs 5+ operations across 3 files at every apply
start (CLAUDE.md → "steps 6–7" pointer → two ranges of a 413-line generated file →
`openspec instructions` for config rules); `SKILL.md` is CLI-generated and the
customization survives only by a "re-apply if regenerated" plea; `config.yaml` rules are
invisible outside artifact generation; a process-rule change fans out to 3 encodings + a
delta — itself a drift surface of the kind the 2026-07-14 ruling feared.

*Against consolidating:* the encodings are **operational**, though the panel forced
precision on how: `CLAUDE.md` genuinely auto-loads every session; `config.yaml` rules
auto-inject at artifact generation (and only there); but the apply skill's steps 6–7 are
in practice reached by the orchestrator *reading* `SKILL.md` off CLAUDE.md's pointer —
the `/opsx:apply` command invokes a separate stock plugin skill, so the customized file
behaves partly like a referenced document, not a pure auto-loading surface (a task in
this change records which skill actually loads at apply time). So "auto-loads at the
point of use" is cleanly true for one encoding, conditionally for the second, and
pointer-mediated for the third — weaker than the draft claimed, and honestly weighed as
such. The 2026-07-14 ruling still has direct observed evidence (a duplicate home
drifted). And the decisive datum survives the correction: feed-row-seek's 11-phase apply
**executed the process correctly** off the three encodings — the failures this change
addresses were gaps in what the rules *said* (F1, F3, F4) or at most a rule-*following*
lapse inside an existing rule's boundary (F2's behavioral CONFIRMED, see D2), not
failures to find, load, or sync rules. The architecture is not what broke.

*The hybrid (single source, surfaces mechanically derived) — feasibility, assessed
concretely:*
- `CLAUDE.md` "How we work": consumed by Claude Code as a file at a fixed path; a
  generator would have to splice a derived section into a hand-maintained file on every
  rule change. No such tooling exists in-repo; building it is code (out of scope for a
  docs change) and the splice step is manual-triggered — a stale-output failure mode with
  no detector.
- `SKILL.md` steps 6–7: worst case. The file is already the merge of two authors (openspec
  CLI scaffold + hand customization); a derivation script would have to re-patch after
  every CLI regeneration, i.e. it *inherits* the exact durability problem it is meant to
  solve, plus its own.
- `config.yaml` `rules`: mechanically trivial to generate (~15 one-liner strings) — and
  correspondingly near-zero benefit.
- Net: for two of three surfaces derivation is not practical without building and
  *enforcing* tooling (a checker in CI, which this repo's process changes deliberately
  don't touch). An unenforced hybrid is hand-syncing with extra steps — precisely the
  duplication the 2026-07-14 gate rejected. The task brief's own framing anticipated this
  disposition: "an aspirational hybrid that requires hand-syncing is just the duplication
  already rejected."

**Decision:** keep the three encodings as the normative home. Amend the marker spec's
wording to the ruling's actual scope (delta in this change), so the replacement question
is dispositioned on the record — evaluated 2026-07-27, declined — instead of foreclosed by
over-broad wording or left open a third time.

**What would change this (disjunctive — any one suffices; recorded so the disposition is
falsifiable):**
1. A process defect traced to the *architecture* — a rule that existed but failed to load
   at its point of use, or a cross-encoding contradiction that misdirected an apply —
   rather than to rule content.
2. The `openspec` CLI actually regenerating `SKILL.md` and losing the steps 6–7
   customization in practice (the durability plea failing, not merely being fragile).
3. Derivation becoming free — e.g. openspec natively supporting skill-customization
   includes, leaving only the CLAUDE.md splice to solve.

**Mitigation adopted for the real papercut** (assembly cost, without touching the
architecture): none in this change beyond what D7 routes — the cost is real but small,
paid once per apply session, and every candidate mitigation (an assembled protocol digest)
is a fourth surface by another name. Recorded as considered-and-rejected rather than
silently dropped.

### D7 — Routing: which encoding carries which rule

**Decision:**

| Finding | Encoding | Where |
|---|---|---|
| F1 staging rule (all committers) | SKILL.md | step 6c dispatch prompt + 6f bookkeeping + Guardrails |
| F1 package build + integrity + tree-hygiene mandate | SKILL.md + CLAUDE.md | step 7 package build & charter + the CLAUDE.md audit-package parenthetical |
| F2 (property-scoped fact-check) | CLAUDE.md | the fact-check block in "Adversarial review of the spec" |
| F3 declaration (seam at partition) | SKILL.md | partition block, beside shared-helper preassignment + Guardrails |
| F3 package rule (all call sites vs declared property) | SKILL.md + CLAUDE.md | step 7 package list + the CLAUDE.md audit-package parenthetical |
| F4 (merge-blocking-fix mutation) | SKILL.md | step 6e fix-wave text, step 7 fix dispatch + Guardrails |
| F6 (scope correction) | marker spec | delta in this change |

`openspec/config.yaml` gets **no edit**: its `rules` bind artifact *generation* (proposal/
design/specs/tasks authoring), and none of these rules fires at authoring time — F2 is
about running the fact-check pass (a CLAUDE.md-described activity), F1/F3/F4 about apply
execution (the skill's domain). One near-miss the panel caught, resolved explicitly:
config.yaml's design rule already specifies the fact-check log entry's fields ("per-claim
method and evidence"), which D2 extends. Ruling: D2's read-depth and quoted-code-path
requirements are part of the recorded *method* that rule already demands — CLAUDE.md
defines what an adequate method is; config.yaml keeps naming the fields. One home per
rule, no drift seam. Routing a rule into a surface that never loads when the rule applies
would be encoding-theater. CLAUDE.md edits are kept to the summary sentences that already
enumerate the audit package and the fact-check pass, preserving its "stays short, points
at the skill" posture.

**Invariant a future reader might undo:** don't "balance" the encodings by copying these
rules into config.yaml for completeness — a rule lives in the encoding that auto-loads
when the rule fires, and only there. That asymmetry is the design.

### D8 — Landing path: light, on a plain branch

**Decision:** panel + gate at propose time; then one implementer pass on a plain branch
(`docs(sdlc): …` commits), a consistency read with recorded outcome, and the verification
set: `openspec validate sdlc-review-mandate-gaps --strict`, a skill-load check (the
customization header and steps 6–7 present and the skill still invocable), `npm run
typecheck` + `npm test` (no runtime surface), `git diff --stat` confirming only the
expected paths — this last check being itself the D1 rule practiced on the change that
introduces it. Then merge. Precedent: 2026-07-14 sdlc-retro-improvements D11 (same shape,
same rationale — running the full apply pipeline on doc files enacts the over-process the
pipeline exists to prevent). Docs-only direct-to-main is permitted by CLAUDE.md but not
taken, for the same reason as 2026-07-14: a branch costs nothing and keeps the merge
atomic. Per the config.yaml docs-only rule, the skipped final gates are declared in
tasks.md: no `npm run e2e` / `e2e:visual` (no runtime surface to drive).

## Risks / Trade-offs

- **[Rule accretion]** Every retro adds rules; the encodings ratchet longer and each rule
  dilutes attention on the others. Honest count (panel correction): the D7 routing lands
  F1/F3/F4 in roughly a dozen spots across the two files (each rule in 2–3 of step
  6c/6e/6f/7 + Guardrails + CLAUDE.md parentheticals — Guardrails recap duplication is
  the skill's existing idiom); D5 and D6 deliberately add nothing; the no-tooling
  Non-Goals keep the additions prose-cheap. Accepted residual: no rule-retirement
  mechanism exists yet — a future retro that finds a rule with zero fires should propose
  removing it.
- **[D1's stop-and-look slows bookkeeping]** Trivial cost (`git status --porcelain` read)
  against a demonstrated 1.3 MB/history-rewrite failure.
- **[D3 declarations misjudged at partition time]** A seam not declared gets today's
  behavior — protected by the explicit floor-not-ceiling charter line, so audit breadth
  must not atrophy around declarations. Over-declaration is the opposite risk (blanket
  declarations re-inflating the audit toward the cumulative re-read the 2026-07-14
  ruling dismantled) — mitigated by the declare-when guidance; a wrong declared property
  is backstopped by unconditional call-site packaging.
- **[D4 mutation checks prove the wrong thing]** A careless mutation (breaking the test
  setup rather than the guarantee) yields a vacuous pass. Mitigated: the record must name
  the mutated guarantee and the failing test(s); the scoped re-review verifies the record.
- **[D6 declines an architecture fix and the papercut persists]** Accepted openly: the
  5-operation assembly cost continues. The reversal conditions are recorded and specific.
- **[Marker-spec wording change weakens the anti-rulebook guard]** The amended wording
  still rejects duplication outright (now explicitly including "convenience" digests —
  panel addition closing a letter-of-the-rule hole); replacement routes through the full
  pipeline judged against the recorded decline and its reversal conditions, which the
  delta cites rather than restates (panel: inlining criteria into the SHALL both bloated
  the marker and contradicted D6's disjunctive conditions). The guard is narrowed to what
  was actually ruled, not loosened.

## Migration Plan

Docs-only. Rules take effect for the next change proposed after merge. Reverting the docs
commits restores the prior process. The `backup-pre-rewrite` tag may be deleted once this
change's **corrected artifacts have landed post-gate** (panel timing correction: the gate
may order evidence-story rework, and the tag is the only remaining evidence — F1's
commits `55c0cdc`/`28bac9a` are unreachable from `main` and become GC-eligible on
deletion; thereafter the evidence survives only as the recorded SHAs/byte counts in this
document). Recorded as a post-gate step, not a task, since it is the user's tag.

## Open Questions

None — all six gate escalations were dispositioned 2026-07-27; rulings are recorded
inline in the Panel & review log's escalation list.

## Panel & review log

### 2026-07-27 — Pre-panel fact-check pass (light tier, mechanical)

A fetch-and-compare reviewer verified stated checkable claims in `proposal.md` +
`specs/sdlc-process/spec.md` + `design.md` against the live repo, git history (including
tag `backup-pre-rewrite`), and the on-disk archives, with per-claim method and evidence.
**24 sub-claims: 16 confirmed, 4 corrected in place, 3 left unverified**, 1 discarded as
not actually stated in the artifacts.

*Corrected in place:* the `git add -A` sweep vector restated as the cleanup commit's own
account rather than recorded fact (no ledger/report/reflog captures the staging command);
"~4,000 added lines" → ~5,800 (5,830 insertions / 414 deletions, 56 files); "8 of 11
phases deferred" → 7 deferred + 1 mechanical (8 sole-reviewed by the audit); D5's Critical
placement made precise (call sites in deferred 6/7/8, seam-defining phase 3 full-tier and
clean) so both sides of the dialectic agree on the facts; D4's Critical frequency restated
as the measured 2-in-12.

*Notable confirmations:* the full F1 git chain including the exact 1,368,484-byte blob in
`55c0cdc` and its absence from post-rewrite `main`; F2/F3/F4 verbatim against the
feed-row-seek ledger and archived design; and the D6 narrow-reading — the 2026-07-14
record's rejected artifact was a nine-requirement *restating* spec, the gate alternatives
were "cut vs keep-slimmed vs as-drafted", and **no passage in that change considers a
replacement/derivation architecture** (grep for replace/derive/single-source/generat*
across its artifacts: zero hits).

*Left unverified (reach the panel un-vouched):* the "5+ operations across 3 files"
protocol-assembly count (session-anecdotal); the exact Critical-frequency denominator
semantics; all design judgments (D1–D8) — the pass vouches for none of them.

### 2026-07-27 — Adversarial panel (4 reviewers, distinct mandates, skeptical calibration)

Requirements / Assumptions / Failure & abuse / Scope & simpler design, all on the top
model tier. Verdicts as returned: REQUEST-CHANGES ×4 (assumptions and failure & abuse
each carried blocker-level findings; none demanded structural rework). The panel was told
stated claims were pre-checked (pointing at the fact-check entry above) with its full
skeptical mandate preserved — and it used it: the two most consequential findings were
implicit-premise catches the fact-check pass structurally could not have made.

**Convergence:** 4/4 attacked the delta spec's replacement scenario (over-built
spec-as-changelog per scope; conjunctive bar contradicting D6's disjunctive reversal
conditions per requirements M4 / failure&abuse B1 / assumptions M1). 3/4 found D1 binding
only orchestrator commits while implementer subagents author the majority (scope M2,
requirements M1, failure&abuse M1). 3/4 refuted D5's "latency, not escaped defects"
framing via the un-encoded quality-audit layer (scope M3, requirements M5, assumptions
M2).

**Blockers / majors fixed in place (orchestrator verified the two evidentiary blockers
directly against `.apply` and git before adopting):**

- **D1's causal story was fabricated** (assumptions B1): no reviewer ever saw a `-s` stat
  line — the audit packages carried no stat sections, the scoped re-reviews were
  structurally scoped past the file, and the quality-audit package was built two minutes
  *after* the cleanup commit (verified: package mtime 00:24:57 vs commit 00:22:35; zero
  grep hits for `1368484`/`Binary files` across `.apply`). → Context F1, D1, and the
  proposal's finding 1 rewritten around the true mechanism: the file list was never
  materialized for any reviewer.
- **The audit package build silently truncated and nothing owns package integrity**
  (assumptions B2): `audit-package-deferred.txt` ends at its phase-11 header with no
  content (verified: line 3426 is the final line) — phase 11 was never reviewed by
  anyone. → new D1(3): non-empty-section + stat-reconciliation integrity checks at
  package build; folded into D5's evidence.
- **Delta spec rebuilt** (4/4): slimmed to the scope correction + pointer (no inlined
  dated reasons, no "SHALL overcome", no conjunctive criteria); replacement scenario now
  routes to the pipeline judged against the recorded decline *and its recorded reversal
  conditions* (disjunction preserved); duplicate-rulebook scenario extended to
  "convenience" digests (failure&abuse minor).
- **D4 re-review demotion reversed** (failure&abuse B2 + requirements M3): the scoped
  re-review re-executes the recorded mutation and remains expected to run its own; the
  pre-fix demonstration must be reproducible (named test/command), not prose; mutation is
  working-tree-only, never committed.
- **D4 severity anchor** (failure&abuse M4): obligation keyed to consequence
  (merge-blocking / silent-wrong-behavior), not the undefined "Critical" label, closing
  the deflation incentive.
- **D1 extended to all committers** (3/4 convergent): staging discipline into implementer
  dispatch prompts; stop-and-look resolutions land as ledger disposition lines
  (failure&abuse M1); tree-hygiene answer in affirmative-evidence form with the
  mechanical scan at package-build time (failure&abuse M2).
- **D3 property-not-uniformity** (requirements M2): call sites checked against the
  declared property (external consumer), not each other — uniformly-wrong callers satisfy
  mere consistency. Plus floor-not-ceiling charter line, revisit-at-every-partition
  clause, declare-when guidance (failure&abuse M5), ledger cross-check for dispatch
  carriage, and the wrong-property honesty note (assumptions minor).
- **D2 reconciled with the existing CONFIRMED reservation** (failure&abuse M3): behavioral
  CONFIRMED quotes the claim-relevant code path; F2 acknowledged as partly a
  rule-following lapse (nuance carried into D6's evidence weighing); "checklist" phantom
  replaced with "however claims are enumerated" (requirements minor); n=1-bet and
  item-1-attribution honesty notes (assumptions/scope minors).
- **D5 framing corrected** (3/4 convergent): quality audit acknowledged as un-encoded;
  its Importants and user-found F1 counted as escapes from the designed pipeline; phase-11
  datum added; audit-charter-growth risk owned.
- **D6 auto-load premise made precise** (assumptions M3): cleanly true for CLAUDE.md,
  generation-time-only for config.yaml, pointer-mediated for the skill (with the
  `/opsx:apply`-plugin vs customized-skill question recorded and a verification task
  added); decision unchanged — it rests on the alternatives analysis and the
  content-gap-not-architecture evidence, both of which survive.
- **D7 config.yaml near-miss resolved** (failure&abuse M6): D2's additions defined as part
  of the "per-claim method" config.yaml's design rule already demands — one home, no new
  drift seam. Routing table updated; "~10 sentences" estimate replaced with the honest
  ~dozen-spots count (scope minor).
- **Numbers corrected**: applied-ledger denominator 12 → 11 (assumptions minor);
  proposal's "survived the quality audit" claim removed (false — see B1).

**Escalated to the gate (all six dispositioned 2026-07-27 — rulings inline):**

1. **D1 breadth**: adopt all three elements, or trim; pre-commit hook in or out. →
   **ADOPT ALL THREE; hook stays a roadmap candidate** (the three demonstrated failure
   layers each need their own closure; the hook is the only config-as-code piece and gets
   promoted on a second incident, with evidence).
2. **D4 extension**: merge-blocking-only vs Important-tier. → **MERGE-BLOCKING ONLY**
   (4–10× cost on zero direct evidence; the consequence anchor already closes the
   deflation dodge; revisit at the next retro if an Important-tier fix ships untested).
3. **D5(a)**: deferred-tier rule → **UNCHANGED** (every demonstrated escape traced to
   audit mechanism, which this change fixes — not to tiering). **D5(b)**: quality audit →
   **RECORDED AS DISCRETIONARY, residual stated** (one run, 2 quality-tier Importants, no
   correctness finding — insufficient to mandate a standing stage; the designed pipeline
   guarantees correctness coverage, not quality-audit coverage; promote if the next
   applies keep finding Important-tier quality escapes). No encoding edit for D5 — the
   no-change disposition lives here.
4. **D6**: → **RATIFIED as drafted** — keep the three encodings, slimmed marker
   correction, disjunctive reversal conditions recorded; the question is dispositioned,
   not open.
5. **Landing path**: → **LIGHT PATH on a plain branch** (2026-07-14 D11 precedent).
6. **Out-of-band push**: → **PUSH `main` now, before the apply starts** (single-copy
   `.apply/` ledgers and ~40 commits of shipped history otherwise ride one disk);
   post-merge push remains ask-first per the standing rule.

**Gate addendum (2026-07-27):** all subagents in this change's apply run on the top tier
(fable) by explicit owner directive at the gate — recorded here and in the apply ledger
as the tier-justification the skill's mid-tier default requires.

**Minors accepted as residual:**

- The `-s`→`--no-patch` self-concealment mechanism for the empty phase-11 section is
  plausible but unproven from the record (assumptions B2 note) — recorded as such, not as
  fact.
- D3's single-caller variant (one caller mismatching an external consumer with no second
  caller) is left to the declare-when guidance's external-consumer clause rather than a
  dedicated trigger (requirements minor).
- Post-deletion of `backup-pre-rewrite`, F1's evidence survives only as recorded
  SHAs/byte counts in this document (failure&abuse minor) — accepted, with deletion
  timing moved to post-landing (assumptions minor).
- The baseline spec's `## Purpose` narrative still carries only the 2026-07-14 framing;
  a sync-time Purpose touch-up is tasked rather than specced (requirements minor).
- D2 remains an n=1-motivated bet, kept because cheap (assumptions minor).
- Fact-check "5 corrections in 2026-07-14" value claim taken from that change's log
  without re-verification (assumptions minor).

### 2026-07-27 — Post-gate consistency read (recorded outcome)

**Nine findings, all fixed mechanically; no substantive contradiction.** Documents read:
`proposal.md`, `specs/sdlc-process/spec.md`, `design.md`, `tasks.md`. Fixed: stale
pre-gate phrasing in four proposal spots (landing path "gate to confirm", finding 5/6
future tense, conditional config.yaml routing); stale "gate may still trim" in D1 and the
missing ruling tail in D4; future-tense D5 decision framing; the Context finding tally
corrected against the feed-row-seek ledger (1 Critical, 7 Important, ~20 Minor — the
draft's "3 Important, ~15 Minor" counted only the whole-branch audit layer); the D6
reversal-condition list marked disjunctive to match the gate ruling and delta. Verified
clean: no surviving instance of any panel-refuted claim outside the dated historical
record; all six gate rulings match the normative sections; every tasks.md bullet traces
to its design anchor; delta spec and D6 tell the same story.
`openspec validate --strict` re-run after the edits: passes.

### 2026-07-27 — Post-implementation consistency read (task 3.1, recorded outcome)

**Clean.** Documents read: `CLAUDE.md`, `.claude/skills/openspec-apply-change/SKILL.md`,
`proposal.md`, `design.md`, `tasks.md`, `specs/sdlc-process/spec.md`, plus the implementer's
`.apply/task-1-report.md`. Every encoding edit matches its design decision with the
panel-mandated qualifiers intact (D1.1 → 6c/6f/Guardrails; D1.2/D1.3 → step 7 build +
integrity + charter + CLAUDE.md parenthetical; D2 → fact-check block, worded as the
adequate method under the existing per-claim-method rule with the CONFIRMED reservation
rewritten in, not layered beside; D3.1/D3.2 → partition block + step 7 + Guardrails with
external-consumer property, declare-when, revisit clause, floor-not-ceiling; D4 → 6e/7 +
Guardrails, consequence-anchored, working-tree-only, re-execute + own mutation). No live
instruction contradicts another; CLAUDE.md's steps-6–7 pointer and summary parentheticals
claim nothing the skill doesn't carry; SKILL.md step numbering and frontmatter intact;
`openspec/config.yaml` byte-identical to `main` (D7 honored); no stale pre-gate language
outside dated historical records. The implementer's flagged density (6e bullet, fact-check
block) was reviewed for trims: every clause traces to a panel-mandated qualifier — no
zero-loss trim exists; left as written. `openspec validate sdlc-review-mandate-gaps
--strict`: valid. Ledger records task 2.2's skill-load + `/opsx:apply`-plugin observation,
so the D6 auto-load question is closed by observation as tasked.
