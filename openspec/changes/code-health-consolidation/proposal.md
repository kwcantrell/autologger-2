# Proposal: code-health-consolidation

> Source brief: `docs/reviews/2026-07-27-full-repo-review.md` (committed research artifact).
> This change implements the findings dispositioned **OS**/**OS-delta** there; finding
> numbers below (1.1, 2.3, …) refer to that document. The **QF**-dispositioned findings
> already landed on branch `quick-fixes-2026-07` and are out of scope here.

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
  (finding 1.13) is ESCALATED to the gate — the drafted cap would break an
  `ai-topics-chat` SHALL without a delta (see design D4 for the options).
- **Duplication consolidations** (findings 2.1, 2.3–2.12, 2.14, 3.8 — 2.13 de-scoped,
  see Non-Goals): single-source the
  hand-duplicated logic pairs — web SSE-turn plumbing + composer (AiChat/AiV2Design),
  internal-audio message grammar (recording.ts/audioClips.ts), server deck-title rule
  (three copies), marker grouping (Timeline/MarkerNav), generate-503-latch
  (Transcribe/Topics feeds), palette-9 normalization, React Query key factories for the
  bare-literal keys, session cards (RecentSessionsList), event-count SQL via a
  `core.eventCounts()` helper (restoring sessionCore's stated no-cross-store-reads
  layering), aiV2 route-guard prologue, store patch-builder/ordinal-seed helpers, lease
  free-path, mime↔ext mapping, and typing the companion state payload the server builds
  (the PUT `internal` category branch is kept and documented — the fact-check
  established it is reachable, not dead — preserving the frozen 400 behavior).
- **Spurious-await cleanup** (finding 5.1): make `requireSession` and the test seed
  helpers synchronous and drop the ~44 misleading `await`s on synchronous hub RPCs,
  making real suspension points visible again.
- **Batched consistency items** (findings 5.6–5.10, 5.9-adjacent): companion router
  row-reuse, catalog store cleanups (upsert patterns, transaction pairing, statement
  reuse decision), path-encoding and `OkResponse`/toast-API convergence, the small
  web perf/markup items, and the test-infrastructure dedupe (shared `parseSse`,
  `seededSession`, e2e create-session helper).

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
- **Server**: `SessionHub`/`sessionCore` + all four broadcasting stores (broadcast queue);
  `aiChatRunner`/`aiV2SdkSpawn` (shared orchestrator + kill ladder); `blobStore` (range);
  routers `events`/`companion`/`studio` (deck title, row reuse, dead branch);
  `_helpers`/six routers (await cleanup); catalog stores (batched cleanups); `ai.ts`
  (session-id map bound).
- **Web**: shared SSE-turn hook + composer; `recording.ts`; MarkerNav/Timeline grouping;
  Transcribe/Topics feeds + rows; HomeSettingsModal/EventButtonsTable palette; query-key
  factories; RecentSessionsList; assorted small items.
- **Companion**: type-only (shared payload typing on the server side; no wire change).
- **Tests**: all consolidations ship with tests proving behavior-preservation; the two
  deltas get explicit new failure-path tests; test-infra dedupe touches int/e2e helpers.

## Non-Goals

- No new API surface, endpoints, or capability flags (that is `server-capabilities`,
  queued separately).
- No re-fix of anything already landed on `quick-fixes-2026-07` (QF findings).
- No action on accepted residuals (findings 1.16–1.21, 3.9) beyond what the review
  records.
- No CHANGELOG.md disposition (escalated to the owner separately).
- No behavior changes to the deliberate patterns the review explicitly excluded
  (mounted-hidden latches, 503 latch fallback, scrub chokepoints, provenance headers).
- No `useZoomRail` structural rewrite (finding 5.9's largest item) — flagged as its own
  future change if wanted; only its dead refs (already QF) and comments were touched.
- No TranscribeRow/TopicsRow edit-buffer dedupe (finding 2.13) — de-scoped by the panel
  (2026-07-27): `[A?]`-verified, low-med, self-annotating in the code; re-dispositioned
  to accepted residual rather than silently left untasked.
