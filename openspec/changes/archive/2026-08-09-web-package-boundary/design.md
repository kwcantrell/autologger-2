## Context

**Current state, measured on `main` @ `b6a0ba3`.** Bounded to the nouns this change's framing names
and the deferral pointers it inherits, per the propose-time premise check landed in
`sdlc-orchestrator-obligations`.

```
clientAggregates.ts (web)          254 lines   consumer: useAiV2WidgetData.ts
aggregates.ts (packages/ai-runtime) 241 lines   consumer: mcpTools.ts
shared exports                     8           computeSessionDuration, computeTalkTimeBySpeaker,
                                               computeUtteranceStats, computeFillerStats,
                                               computeTopicTimeline, computeEventCounts,
                                               computeEventDensity, FILLER_WORDS
web-only export                    1           computeTranscriptExcerpt (no server counterpart)
pinning test                       11 tests passing, 2 files

EVERY web/src -> packages/ reach in the tree:
  clientAggregates.pinning.test.ts:20   await import('../../../../../../packages/ai-runtime/src/aggregates.ts')
  clientAggregates.pinning.test.ts:114  the same path inside a describe() string
  → zero production reaches. "Exactly one candidate consumer" confirmed.

Guard coverage for a planted production web/src -> packages/domain import:
  webBoundaries.repo.test.ts     PASS  (0 mentions of "packages")
  packageBoundaries.repo.test.ts PASS  (covers package -> web only)
  tsc --noEmit -p web            PASS
  → the direction is covered by nothing. Probe reverted; tree clean.

Vite fs.allow justification:  node_modules/@autologger/ai-runtime -> ../../packages/ai-runtime
                              → symlink resolution; the stated reason is dead.
```

**Deferral pointers inherited, and their status:**

| pointer | status |
|---|---|
| step 1: "may `web/` share server-side types" | never decided |
| step 1: "web keeps hand-written `api/types.ts`" | **no durable home** — archived design only, not in any baseline |
| step 3 E2: "only step 5 can determine" | step 5 declined the split; the decision was never made |
| step 4b: re-pointing the pin is "non-precedential" | holds; still true |
| residual: "web's cross-workspace reach is covered by no check at all" | **confirmed by probe** |

## Goals / Non-Goals

**Goals:** close a five-change-old open question by ruling; close a demonstrated guard hole; stop the
stale header re-opening a settled decision.

**Non-Goals:** retiring the mirror; a narrower L0-only rule; step 1's `api/types.ts` ruling; any
runtime code change.

## Decisions

### D1 — Rule rather than refactor

Two ways to close the question. Priced:

| | rule (adopted) | refactor (declined) |
|---|---|---|
| work | one guard rule + a comment + one MODIFIED requirement | split 3 L1 files into DTO/store halves; move `aggregates.ts` a 2nd time; delete mirror + 2 tests; new boundary rules for a newly-permitted direction; `web-docs` edge regeneration |
| buys | closes the question; closes the guard hole | −254 LOC already guarded by a passing test |
| risk | none — forbids what nothing does | L1 surgery; re-opens the package-graph question before closing it |

The duplication is not what has cost anything. **The open question is** — it resurfaced in every
change that touched `web/`, and each time an agent re-derived the same analysis. Ruling ends that
for ~15 lines. Refactoring also ends it, at roughly ten times the cost, and only after re-opening it.

`aggregates.ts` having been moved once already (step 4b priced a double move as the honest cost of
sequencing) argues against a second move on its own.

### D2 — The rule is flat, not "L0 only"

`@autologger/domain` is genuinely dependency-free, so an "L0 only" rule would be defensible on
safety grounds. It is not adopted, because a permission needs a consumer to justify it and there is
exactly one candidate — measured above as zero production reaches.

A flat rule is also cheaper to enforce and cheaper to read: "no production import from `packages/`"
needs no layer knowledge at the call site. The reversal condition in the proposal is the escape
hatch if a real L0 consumer appears.

### D3 — The rule lands in `web-coordination-seam`, correcting this change's own framing

The recommendation that opened this change said to record the rule in the `package-architecture`
baseline. Measurement showed that is wrong: every requirement there governs what **packages** may do
(line 28: "no package SHALL import from `server/src` or `web/src`"). The subject here is what
**web** may do.

`web-coordination-seam` already carries **"The web app's internal import direction is mechanically
enforced"**, added 2026-08-08, backed by `webBoundaries.repo.test.ts`. Extending it keeps one
requirement owning one subject and one guard enforcing it, rather than splitting web's import rules
across two capabilities.

Recorded rather than silently fixed because it is exactly what the premise check exists to surface:
a framing premise ("this belongs in `package-architecture`") that no artifact had asserted and no
check would have caught.

### D4 — Production-scoped, because the pinning test must keep working

The rule binds **production** files only. The pinning test's `await import()` is the mechanism that
keeps the mirror honest — forbidding it would destroy the guarantee the rule relies on to make the
duplication acceptable.

This mirrors the carve-out `webBoundaries.repo.test.ts` already applies to type-only edges, and its
AST implementation already distinguishes production from test files.

## Risks / Trade-offs

- [The rule forbids something nothing does, so it never fires] → that is the intended steady state;
  it is a ratchet against future drift, and the mutation pair proves it fires when violated.
- [A future legitimate L0 consumer is blocked] → the reversal condition is stated in the proposal
  rather than left implicit; unblocking is one change.
- [The mirror drifts anyway] → the pinning test is the guard, and it passes today (11 tests). The
  rule makes it permanent policy, which is what justifies relying on it.
- [`clientAggregates.ts` has a web-only export with no server counterpart] → `computeTranscriptExcerpt`
  is new client-only derivation, not a mirror, and its own header already says so. It is unaffected.

## Migration Plan

One guard rule, one comment, one MODIFIED requirement. No data migration, no deployment step, no
runtime surface. Rollback is reverting the branch.

## Open Questions

None. Applying the escalation judgment: the remaining choices — exact rule wording, where in the
guard file it sits, comment phrasing — are the agent's, and the encodings settle them.

## Invariants a future reader must not "helpfully" undo

- **The rule is production-scoped.** The pinning test's cross-workspace dynamic import is the
  mechanism that makes the duplication acceptable; forbidding it removes the guarantee (D4).
- **The mirror is permanent policy, not a workaround.** Its header says so after this change; a
  future reader finding "temporary" language has found stale text, not a plan.
- **The rule is flat by choice, not oversight** (D2). An "L0 only" variant needs a real consumer
  first.
- **Web import rules live in `web-coordination-seam`, not `package-architecture`** (D3). The latter
  governs packages; splitting web's import rules across both is how the next reader loses one.
