# Proposal: code-health-tail

> Split from `code-health-consolidation` by that change's gate (2026-07-27, ruling 1):
> this change carries the consolidation tail (former phases 5–8); the head change
> carries the contract deltas + AI process lifecycle and lands FIRST. The 2026-07-27
> fact-check and four-reviewer adversarial panel covered both halves before the split —
> see the head change's `design.md` Panel & review log and this change's own log for
> the inherited entries. Source brief: `docs/reviews/2026-07-27-full-repo-review.md`
> (finding numbers below refer to it).

## Why

The 2026-07-27 full-repo review found roughly a dozen hand-maintained duplications that
have observably begun to drift, plus a spurious-async pattern that hides the server's
real suspension points. Consolidating them in one reviewed change is cheaper than
debugging future divergence — but the gate ruled they must not hold the head change's
correctness fixes hostage, so they land here, second.

## What Changes

- **Server consolidations**: deck-title rule single-sourced (finding 2.4);
  `core.eventCounts()` restoring sessionCore's stated layering (2.10); `guardAiV2Route`
  parameterized by gate set (2.11); store patch-builder/ordinal-seed/`freeLease`/
  mime↔ext helpers (2.12); companion payload typed server-side + row-reuse from
  `requireActiveSession` (2.14, 5.6); the PUT `internal` category branch kept and
  documented with a pinning test (3.8 — the head change's fact-check proved it
  reachable); catalog store cleanups (5.7).
- **De-async sweep** (5.1): `requireSession` and test seed helpers go synchronous; the
  ~45 spurious `await`s on synchronous hub RPCs and both sync `Promise.all` wraps are
  removed.
- **Web consolidations**: shared `useSseTurn` hook + composer (2.1); internal-audio
  message grammar single-sourced (2.3); shared marker-grouping util (2.6);
  `useGatedGenerate` + shared toolbar fragment (2.5); single palette-9
  normalize/default (2.7); query-key factories (2.8); session-card EXTRACTION —
  shared hook/helpers/scaffold, two thin variants (2.9, per panel ruling); the small
  batched web items (5.9 OS subset) including `OkResponse` adoption.
- **Test-infrastructure dedupe** (5.10): shared `parseSse` + seed-chain helper
  (~9–12 int-test files, full breadth per gate ruling 4), `configuredEnv` rename,
  shared fake-core helper, relocated fakeClock suites, shared e2e `createSession`
  helper.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `api-contract-freeze`: one documentation-of-frozen-behavior delta — an ADDED
  requirement pinning the PUT event-update `internal`-category snapshot-stripping edge
  (reachable when a studio profile defines a category id `internal`; nearly deleted as
  "dead code" before the fact-check). **No observable behavior changes** — the delta
  records existing frozen behavior in the baseline so it cannot be "helpfully" removed
  later.

## Impact

- **Contract impact: none.** Every consolidation is behavior-preserving, verified by
  pinning tests and the existing frozen-contract suites; the one delta pins existing
  behavior.
- **Server**: routers `events`/`companion`/`studio`/`aiV2`; `_helpers` + six routers
  (de-async); session stores (helpers); catalog stores; `sessionCore` (eventCounts).
- **Web**: AiChat/AiV2Design + new shared hook/composer; `recording.ts`;
  Timeline/MarkerNav; Transcribe/Topics feeds; HomeSettingsModal/EventButtonsTable;
  query-key factories; RecentSessionsList; small batched items.
- **Tests**: pinning tests per consolidation; int-test and e2e helper dedupe.

## Non-Goals

- Everything in the head change (`code-health-consolidation`): broadcast atomicity,
  416 range fix, kill ladder, shared orchestrator.
- Toast-API and path-encoding convergence — dropped to accepted residual by the gate
  (2026-07-27, ruling 3): no defect class, ~20-file churn not worth the audit surface.
- TranscribeRow/TopicsRow edit-buffer dedupe (finding 2.13) — accepted residual (panel
  de-scope, inherited from the head change).
- `issuedClaudeSessionIds` bounding (finding 1.13) — deferred by the gate (ruling 2);
  roadmap item, not this change.
- No `useZoomRail` structural rewrite; no changes to the deliberate patterns the
  review excluded.
