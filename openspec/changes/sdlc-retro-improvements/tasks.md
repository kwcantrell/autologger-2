# Tasks — sdlc-retro-improvements

Docs-only change, landing via the **light path** (gate ruling 2026-07-14, design D11):
plain branch off `main`, one implementer pass over the four files, consistency read with
recorded outcome, verification set, merge. No dispatch-unit partitioning, phase reviewers,
or whole-branch reviewer. Per-task verification is `openspec validate
sdlc-retro-improvements --strict` plus targeted greps; the final set adds parse/load checks
(config.yaml and skill frontmatter are machine-parsed — panel finding) and
`npm run typecheck` + `npm test` to prove the diff has no runtime surface. `npm run e2e` /
`npm run e2e:visual` are deliberately skipped — no runtime or UI surface to exercise
(stated per the proportionality rule this change adds in 3.1). file:line anchors are
orientation only — locate quoted prose by content before editing.

Panel + gate completed 2026-07-14 (design.md Panel & review log) — this plan is the
post-gate plan of record.

## 1. CLAUDE.md — propose-side process rules

- [x] 1.1 In "Adversarial review of the spec", add the pre-panel fact-check pass per D2:
  light-tier fetch-and-compare over stated checkable claims in proposal/spec/design,
  per-claim method + evidence recorded, CONFIRMED restricted to mechanically checkable
  facts, corrections folded into the draft, dated Panel & review log entry. The panel
  prompt says stated claims were pre-checked and points at the log, **and explicitly
  preserves the reviewers' full skeptical mandate including implicit-premise hunting** —
  aid, never warrant. Never phrase it as "not re-verification".
- [x] 1.2 In "Post-gate edits get a consistency read, not a re-panel", make outcome
  recording mandatory per D4: a dated log line, "clean" (naming documents read) or findings
  + fixes; note that claims introduced during fold-back are covered by this read.
- [x] 1.3 In the "How we work (SDLC)" summary paragraph, replace "an always-on whole-branch
  review at the end" with the layered scoped-audit phrasing (D1, one sentence) and note
  that process rules live normatively in the three encodings (D9), with the `sdlc-process`
  marker spec recording that ruling.

## 2. Apply skill — execution-side process rules

- [x] 2.1 In `.claude/skills/openspec-apply-change/SKILL.md` step 6d, add the frozen-surface
  fast-path per D3: a `DONE_WITH_CONCERNS` concern touching the frozen HTTP/WS contract is
  escalated to the owner and resolved before the next dispatch — never parked for the phase
  review (decided 2026-07-14; deepgram-499 evidence, one parenthetical). In step 6c's
  dispatch-prompt requirements, add the affirmative self-check line for units touching
  frozen-surface-adjacent code ("emits only statuses/shapes/headers in the authorized
  delta: yes/no + list").
- [x] 2.2 In step 6 "Per phase — partition first", add shared-helper preassignment per D5:
  at each partition, scan for nontrivial logic shared with already-landed code AND later
  planned tasks (especially auth/correctness-relevant); name the shared home (file +
  export) in the ledger and affected dispatch prompts at the earliest partition where
  visible; revisit each phase; implementers extract there instead of duplicating and never
  write scope comments that misstate scope.
- [x] 2.3 In step 6c (report contents) and 6f (ledger bookkeeping), encode the report diet
  per D6: reports keep everything unit-specific — decisions, deviations, files changed,
  RED/GREEN evidence, self-review findings, concerns, interfaces, and a one-line per-unit
  gate assertion — while repeated boilerplate (full suite tails, known pre-existing
  warnings, branch-hygiene recitals) becomes one ledger line per phase, reports saying
  "gates green (see ledger)" beyond their assertion line.
- [x] 2.4 Rewrite step 7 as the layered scoped audit per D1. The audit package ALWAYS
  includes: full diffs of deferred/mechanical phases; contract/seam-relevant diffs of every
  phase touching the observable surface or cross-phase interfaces (regardless of tier or
  outcome); full diffs of clean phases sharing files/state with deferred phases; full
  re-read of any phase modified after its review closed. Reports + reviewer notes stand in
  ONLY for the internal-quality re-read of non-contract code in full-tier phases closed
  clean ("clean" = no open Critical/Important; accepted minors carry to the triage list).
  Replace the single `branch-diff.txt` packaging command with per-scope packaging from the
  ledger's recorded PHASE_BASE SHAs, with the explicit rule that exclusion may never drop
  contract- or seam-touching hunks. Keep: always-on, most-capable model, contract-delta
  audit end-to-end, ledger triage, residual/invariant cataloguing, single fix subagent,
  Orchestrator notes.
- [x] 2.5 Add the verification-discipline rules to step 6/setup per D7 + D8 + D10:
  (a) single controlled diagnosis — one experiment, verdict + method + conditions recorded
  in the ledger, later steps cite it; reviewers may reject an unsound experiment (one
  re-run, re-record); (b) paid-API spike pre-flight — one minimal probe (unmetered
  endpoint preferred) before dispatch, ledger records PASS/FAIL + endpoint only (never
  response bodies or credential material), re-probe on rotation or any auth failure;
  (c) gate-intent verification — in every phase including mechanical/deferred, the
  implementer verifies each gate's intent (the property it exists to establish), not just
  its exit code, and records findings.
- [x] 2.6 Update the Guardrails list to mirror 2.1–2.5, keeping it consistent with the
  step bodies.

## 3. config.yaml — generated-artifact rules

- [x] 3.1 In `openspec/config.yaml`: add to the `design` rules that the Panel & review log
  also records the pre-panel fact-check entry (per-claim method/evidence) and the
  consistency-read outcome line. Add to the `tasks` rules that docs-only changes state
  which final gates are skipped and why (no runtime surface), and that changes editing
  machine-parsed governance files (config.yaml, skill frontmatter) include a parse/load
  verification step.

## 4. Coherence + final gates

- [x] 4.1 Consistency read (light tier) of the full edited set — CLAUDE.md, SKILL.md,
  config.yaml, the marker spec, and this change's artifacts: no stale pre-gate language
  (especially remnants of the cut rulebook or the old audit charter), no contradiction
  between D1–D11 and the encoding edits, cross-references resolve. Record the outcome as a
  dated line in design.md's Panel & review log per D4.
- [x] 4.2 Final verification set (D11): `openspec validate sdlc-retro-improvements
  --strict` passes; config.yaml still parses and injects rules (run `openspec instructions
  proposal --change sdlc-retro-improvements --json` and confirm the rules appear); the
  apply skill still loads (frontmatter intact); `npm run typecheck` + `npm test` green
  (diff has no runtime surface); `git diff --stat main...HEAD` shows only the expected
  doc/governance paths. e2e/e2e:visual skipped per header note.
