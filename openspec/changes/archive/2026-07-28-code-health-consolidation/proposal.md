# Proposal: code-health-consolidation

> Source brief: `docs/reviews/2026-07-27-full-repo-review.md` (committed research
> artifact); finding numbers below refer to it. The **QF**-dispositioned findings
> landed via `quick-fixes-2026-07` (merged 2026-07-27). **Split by the 2026-07-27
> gate (ruling 1):** this change is the HEAD — contract deltas + AI process lifecycle
> (it lands first); the consolidation tail (former phases 5–8) moved to the
> `code-health-tail` change, which lands second.

## Why

The 2026-07-27 full-repo review found the codebase structurally sound (all SessionHub
invariants clean, no contract violations) but carrying a cluster of design-bearing debt:
one latent correctness hazard the repo has already diagnosed once and patched narrowly
(broadcasts emitted inside transactions), one proven-elsewhere process-lifecycle bug
retained on the chat path (leader-exit-gated kill ladder), and roughly a dozen
hand-maintained duplications that have observably begun to drift (emit-throw handling
between the two AI turn runners, marker grouping between Timeline and MarkerNav). Each
drift is a future defect with two out-of-sync copies; consolidating now, in one reviewed
change, is cheaper than debugging the divergence later.

## What Changes

- **Post-commit broadcast queue** (finding 1.3): `SessionHub.inTxn` collects store-level
  WS broadcasts and flushes them only after the transaction commits, so a commit-time
  failure can no longer emit `*.changed` for a rolled-back write. The two
  `suppressBroadcast` flags are RETAINED (panel ruling: they own the composite's
  frame-count contract, a different job from the queue's atomicity — see design D1);
  their rationale comments are updated. Success-path emission is byte-identical; the
  observable change is failure-path-only (contract delta).
- **Zero-byte suffix-Range fix** (finding 1.7): a suffix `Range` against a zero-byte blob
  returns the contract-implied `416` instead of crashing into a `500` (contract delta,
  error-path status code only).
- **AI process-lifecycle unification** (findings 1.1, 1.14, 2.2): port the group-liveness
  kill ladder (`process.kill(-pgid, 0)` gating) from the AI-v2 path to the chat/topic
  path, and extract the ~80-line duplicated turn orchestration (`runAiChatTurn` /
  `runDesignTurn`) into one shared orchestrator parameterized by scrubber/cleanup —
  resolving the two already-observed drifts (emit-throw swallowing, terminal-detail
  scrubbing) with one deliberate policy each. Bounding `issuedClaudeSessionIds`
  (finding 1.13) was DEFERRED by the gate (ruling 2): the drafted cap would have broken
  an `ai-topics-chat` SHALL without a delta and FIFO-evicted the most-active
  conversation first; re-dispositioned to accepted residual / roadmap.
- **Everything else from the review's OS bucket** — duplication consolidations,
  de-async sweep, batched consistency items, test-infra dedupe — moved to the
  `code-health-tail` change (gate ruling 1).

## Capabilities

### New Capabilities

_None. This change adds no new externally observable behavior; it consolidates internals
and corrects two failure-path behaviors under existing capabilities._

### Modified Capabilities

- `api-contract-freeze`: two authorized deltas, both failure-path-only —
  (1) WS emission semantics: a mutation whose transaction fails to commit SHALL emit no
  `*.changed` broadcast (today a commit-time failure can broadcast for a rolled-back
  write; success-path emission and ordering are unchanged);
  (2) audio range semantics: a syntactically valid suffix `Range` request against a
  zero-byte blob SHALL yield `416` (today it crashes to a `500`).

## Impact

- **Contract impact**: exactly the two failure-path deltas above; every other observable
  HTTP/WS behavior (shapes, status codes, success-path emission, message ordering) is
  unchanged and verified by the existing frozen-contract test suites.
- **Server**: `SessionHub`/`sessionCore` + the four broadcasting stores (broadcast
  queue); `aiChatRunner`/`aiV2SdkSpawn` (shared outer orchestrator + kill ladder);
  `blobStore` + audio router (range).
- **Web / Companion**: none in this change (all in `code-health-tail`).
- **Tests**: phase-1 pinning tests (broadcast frames, SSE sequences); explicit new
  failure-path tests for both deltas; a kill-ladder leader-exits-member-survives test.

## Non-Goals

- The consolidation tail — duplication consolidations, de-async sweep, batched items,
  test-infra dedupe — split to `code-health-tail` (gate ruling 1, 2026-07-27).
- No `issuedClaudeSessionIds` cap (finding 1.13) — deferred by the gate (ruling 2);
  accepted residual / roadmap.
- No new API surface, endpoints, or capability flags (that is `server-capabilities`,
  queued behind `code-health-tail`).
- No re-fix of anything already landed via `quick-fixes-2026-07` (QF findings).
- No action on accepted residuals (findings 1.16–1.21, 2.13, 3.9, and the toast/
  path-encoding convergence dropped by gate ruling 3).
- No CHANGELOG.md disposition (escalated to the owner separately).
- No behavior changes to the deliberate patterns the review explicitly excluded
  (mounted-hidden latches, 503 latch fallback, scrub chokepoints, provenance headers).
