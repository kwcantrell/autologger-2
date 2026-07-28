# Tasks: code-health-consolidation

> Gated 2026-07-27 (panel + gate passed; split ruling made this the HEAD change — the
> consolidation tail is `code-health-tail`). Finding numbers reference
> `docs/reviews/2026-07-27-full-repo-review.md`; design decisions reference design.md.
> Anchors are orientation only — locate code by content before editing. Every task's
> commit is gated by `npm run typecheck` + `npm test`.

## 1. Preconditions and behavior-pinning tests

- [x] 1.1 `quick-fixes-2026-07` merged to `main` 2026-07-27 (`721fc00`) — verify at
      apply start; re-locate this change's touch points against the merged tree and
      note any moved anchors in `.apply/` notes
- [x] 1.2 Pin current success-path broadcast behavior: int tests asserting the exact
      broadcast types/payload shapes/relative order for one representative mutation per
      broadcasting store (events, transport, audio, lease) and for the ONE composite
      RPC (`anchorImportedTake` — the two `suppressBroadcast` flags are store-method
      parameters it alone consumes)
- [x] 1.3 Pin both AI paths' observable SSE sequences: tests capturing the full
      event-frame sequence for a chat turn and a design turn (success, timeout, abort,
      error) against the current implementations

## 2. Broadcast atomicity (contract-surface phase — per-phase review required)

- [x] 2.1 Implement the core broadcast queue per D1 (enqueue-in-txn, flush-on-outermost-
      commit, discard-on-rollback; zero `await`s) with unit tests incl. nested-txn and
      mid-txn-throw cases
- [x] 2.2 New failure-path test: a throw escaping the transaction after a
      broadcast-enqueueing store call emits no broadcast (delta scenario 1 — an
      equivalent, hook-free proxy for a commit-step failure at the queue seam; do NOT
      add failure-injection hooks to production `inTxn`); success-path pins from 1.2
      stay green unchanged
- [x] 2.3 RETAIN the `suppressBroadcast` flags and `anchorImportedTake`'s manual
      post-commit emission per D1 (panel blocker: the queue provides atomicity, not
      suppression); update their rationale comments to describe the division of labor;
      composite pin from 1.2 stays green byte-identical

## 3. Zero-byte suffix range (contract-surface phase — per-phase review required)

- [x] 3.1 Blob-store range computation raises `InvalidRangeError` for suffix ranges on
      zero-byte blobs per D7; unit test + int test asserting `416` end-to-end (delta
      spec scenarios); existing satisfiable-range tests unchanged

## 4. AI process lifecycle (concurrency-sensitive phase — per-phase review required)

- [x] 4.1 Extract the v2 group-liveness kill ladder into a shared module per D2; unit
      test for the leader-exits-member-survives case; both paths consume it; delete the
      chat-path leader-exit ladder
- [x] 4.2 Extract the shared OUTER turn orchestrator per D3 (five hooks max:
      `runRelay` [owns drain policy], `terminate` [owns v2's abort calls], `scrub`
      [applied by the shared guard to every event; chat's is identity], `timeoutMs`,
      `onFinally` [every exit path; carries v2's release + abandonPendingQuestions];
      chat slot release stays ROUTER-owned after id registration); SSE pins from 1.3
      stay green for both paths
(Task 4.3, the `issuedClaudeSessionIds` cap, was STRUCK by gate ruling 2 — finding
1.13 deferred to accepted residual / roadmap.)

## 5. Final gates

- [x] 5.1 Whole-branch layered scoped audit per sdlc-process (contract/seam diffs of
      phases 2–4 — all three are review-tier phases, so the audit package includes
      their contract/seam-relevant diffs; materialized file list + stray-file scan,
      seam call-site checks, package integrity)
- [x] 5.2 `npm run e2e` (chromium + login-gate) and `npm run e2e:visual` — visual
      baselines last re-blessed 2026-07-26 (feed-row-seek; panel corrected the stale
      2026-07-14 date); this change intends zero visual change, so any diff is a
      defect, not a re-bless
- [x] 5.3 Full `npm test` + `npm run typecheck` + `npm run lint` across workspaces;
      update README/CLAUDE.md only if this change moved a documented seam
