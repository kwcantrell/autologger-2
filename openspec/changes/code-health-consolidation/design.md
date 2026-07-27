# Design: code-health-consolidation

## Context

Source brief: `docs/reviews/2026-07-27-full-repo-review.md` — finding numbers below refer
to it. The review's verification legend applies: `[V]` findings were orchestrator-verified;
`[A]`/`[A?]` findings are agent-reported and MUST be re-verified by this change's
pre-panel fact-check pass before the panel treats them as fact.

The change is internal consolidation plus two failure-path contract deltas (see
`specs/api-contract-freeze/spec.md`). The quick-fix track (`quick-fixes-2026-07`) already
landed the mechanical findings; this change assumes that branch is merged first and its
shared exports (e.g. `WORKSPACE_EVENTS_LIMIT`, exported `loopbackHostname`) exist.

**Invariants a future reader must not "helpfully" undo** (all preserved by this design):

- SessionHub RPC bodies stay synchronous — the broadcast queue introduces zero `await`s;
  flushing is a synchronous fan-out exactly like today's `ws.send` calls.
- Every mutating hub RPC stays inside one `better-sqlite3` transaction.
- Single Node process; no clustering.
- The frozen contract: success-path emission semantics, shapes, and status codes are
  byte-identical after every consolidation in this change. Only the two delta-authorized
  failure paths change.
- Deliberate patterns excluded by the review (mounted-hidden latches, 503-latch fallback,
  scrub chokepoints, provenance headers) are untouched.

## Goals / Non-Goals

**Goals:**

- Make broadcast emission atomic with the owning transaction (finding 1.3) and delete the
  `suppressBroadcast` mechanism it replaces.
- Eliminate the orphan-process hazard on the chat/topic path and the turn-orchestration
  drift class (1.1, 1.14, 2.2, 1.13).
- Single-source every duplicated-logic pair the review confirmed (2.1, 2.3–2.14, 3.8),
  each with behavior-preservation tests.
- Return `416` for suffix ranges on zero-byte blobs (1.7).
- Remove the spurious-await pattern (5.1) and land the batched consistency items
  (5.6–5.10).

**Non-Goals:** everything in the proposal's Non-Goals list; additionally no refactor of
`useZoomRail`'s internal structure and no cross-workspace shared-types package (the
`api/types.ts` mirroring convention stays as documented).

## Decisions

**D1 — Broadcast queue lives in `sessionCore`, flushed by `inTxn` after commit.**
`core.broadcast()` enqueues while a transaction is open and sends immediately otherwise;
`inTxn` flushes the queue (in enqueue order) after the transaction function returns and
better-sqlite3 commits, and discards it on throw/rollback. Nested `inTxn` (savepoint)
calls flush only at the outermost commit. Store code is unchanged at call sites — they
keep calling `core.broadcast(...)`. The two `suppressBroadcast` flags and their
compensating comments are deleted; the composite RPCs they protected get the same
atomicity from the queue itself.
*Alternatives:* (a) keep extending `suppressBroadcast` per-composite — rejected: the
review shows the flag approach already missed every other store; (b) queue in
`SessionHub` rather than core — rejected: core owns `broadcast` today and stores call it
directly, so the seam is core. *Consequence check:* success-path broadcasts still fire
before the RPC returns (flush is inside the same synchronous call), so no observable
ordering change relative to HTTP responses or WS delivery.

**D2 — One shared process-group kill ladder.** Extract the AI-v2 group-liveness ladder
(`designTurnGroupAlive` / `process.kill(-pgid, 0)` gating, SIGTERM → grace → SIGKILL)
into a shared module used by both `aiChatRunner.killAiChatProcessGroup` and the v2 path.
The chat path's leader-exit-gated wait is deleted.
*Alternatives:* port the gate into the chat copy and keep two ladders — rejected: two
copies of lifecycle-critical code is the root cause the review flagged; the v2
implementation is the proven one (spike 0.5).

**D3 — One shared turn orchestrator, parameterized where the paths genuinely differ.**
Extract the duplicated timeout/abort/`Promise.race`/cleanup orchestration of
`runAiChatTurn` and `runDesignTurn` into one function taking `{spawn, emitGuard, scrub,
cleanup, timeoutMs}`-style hooks. The two observed drifts are resolved deliberately:
emit-throw policy adopts the v2 behavior (guarded emit swallows transport throws) for
both paths — the chat path's current propagation pierces `driveAiTurn`'s documented
"never throws" contract, so this is convergence toward the stated design, and it is not
observable on the wire (a throwing SSE write means the client is already gone);
terminal-detail scrubbing remains a per-path parameter so each path's observable SSE
output stays byte-identical.
*Alternatives:* unify only the kill ladder and leave the orchestrators — rejected: the
orchestrators are where the drift already happened twice.

**D4 — `issuedClaudeSessionIds` becomes size-capped.** Replace the unbounded `Map` with
insertion-order eviction at a fixed cap (Map preserves insertion order; evict oldest on
insert past the cap). No TTL, no new dependency, no behavior change for live sessions at
any realistic scale.
*Alternatives:* per-session keying with deletion on session delete — rejected as larger
surface for the same effect; TTL — rejected: adds a clock dependency for no added safety.

**D5 — Web SSE consolidation: one `useSseTurn` hook + one composer component.** The hook
owns fetch/reader/decoder/`parseSseFrames` buffering, delta-append, abort-vs-lost
classification, and the notConfigured-503 branch, parameterized by an event-vocabulary
handler map; AiChat and AiV2Design keep their own vocabularies and rendering. The
Stop/Send textarea footer becomes a shared component with slots.
*Alternatives:* leave duplicated with lint-guard comments — rejected: ~150 lines of
already-observed drift surface.

**D6 — Query keys: extend the existing factory modules.** Add `sessionStatusKeys` and
`audioSegmentsKeys` factories beside the existing `eventsKeys`/`sessionKeys` and replace
every bare literal. Key *arrays are unchanged* (same strings, same shapes), so no cache
invalidation behavior changes — this is compile-time coupling only.

**D7 — Zero-byte suffix range maps to the existing unsatisfiable-range path.** In the
blob-store range computation, a suffix range against `size === 0` raises
`InvalidRangeError` (the type the router already maps to `416`) instead of constructing
an invalid stream window. Covered by a new unit + integration test.

**D8 — De-async `requireSession` and drop spurious awaits.** `requireSession` becomes
synchronous (its body already is); the ~44 `await`s on hub RPCs and the two `Promise.all`
wraps over sync calls are removed; test seed helpers likewise. Handlers stay `async`
where Hono requires a Promise return.
*Consequence check:* removing `await`s removes microtask yields inside handlers, which is
not observable at the HTTP layer; the frozen-contract int suites pin responses.

**D9 — PUT `internal` category dead branch (3.8): delete the branch, keep the 400.**
PUT's category validation (400 for categories outside the profile) is frozen and stays;
the unreachable `stripCategoryUiSnapshots` branch is deleted with a comment recording
why PUT cannot see `internal` (POST admits it explicitly; PUT rejects non-profile
categories first).
*Alternative:* align PUT to POST's admit-internal rule — rejected: that is an observable
contract change with no consumer need.

**D10 — `core.eventCounts()` owns the event-count SQL.** The duplicated count queries
(including the `lower(trim(category)) != 'internal'` filter) move to one core helper;
`TransportStore.statusLive` calls it, restoring sessionCore's stated "stores never read
each other's tables" layering.

**D11 — Companion payload typed server-side only.** Declare the state-payload type next
to the companion router and type the builder against it; companion keeps its own copy
(documented mirroring, same as `web/src/api/types.ts`). No shared package, no wire
change.
*Alternative:* a shared workspace types package — rejected: new coupling surface for a
frozen wire shape; mirroring with per-field provenance is the repo's established pattern.

**D12 — Remaining consolidations follow the obvious single-source direction** (each with
a behavior-pinning test first where one doesn't exist): deck title → existing
`sessionDeckDisplayTitle`; marker grouping → one shared util consumed by Timeline +
MarkerNav; generate-latch → `useGatedGenerate` + shared toolbar fragment; palette-9 →
one exported normalize + default; session cards → one card component with a menu-items
slot; aiV2 guard prologue → `guardAiV2Route` helper; store patch-builder/ordinal-seed →
shared private helpers module; lease free-path → private `freeLease()`; mime↔ext → one
bidirectional table; internal-audio grammar → recording.ts imports from audioClips.ts;
existence checks → `SELECT 1` convention; catalog cleanups per finding 5.7 (upsert for
`authSetPrefs`, `tx()` for the read-modify-write pairs, `resetToDefault()` local in
`getStudioSettingsBlob`, single `listShowsForStudio` per profile assembly). Test-infra
dedupe (5.10): shared `parseSse` and `seededSession` in `server/src/test/helpers`,
shared e2e `createSession` helper, `configuredEnv` rename, shared fake-core test helper.

## Risks / Trade-offs

- [Broadcast queue changes emission *timing* within an RPC (mid-txn → post-commit)] →
  not externally observable (same synchronous call, before return), but WS int tests
  that accidentally depend on intra-RPC interleaving could surface; fix tests only if
  they asserted unpublished timing, never by re-suppressing.
- [Shared turn orchestrator could subtly change SSE output] → pin both paths' observable
  SSE sequences with tests *before* extracting; scrubbing stays per-path.
- [De-async sweep touches ~6 routers mechanically] → tsc catches missed call sites
  (sync function, no floating promises); frozen-contract suites pin behavior.
- [Kill-ladder swap on the chat path regresses some edge] → the ladder being adopted is
  the spike-proven v2 one; add a unit test for the leader-exits-member-survives case
  (the exact scenario the old ladder failed).
- [Wide file touch surface risks collision with `server-capabilities`] → sequencing:
  this change lands before `server-capabilities` starts (one change in flight).

## Migration Plan

Internal-only: no data migration, no deploy steps beyond normal release. Rollback is
`git revert` of the branch merge. The two contract deltas are failure-path-only and
require no client updates.

## Open Questions

- None blocking. The catalog statement-cache idea (finding 5.7's `CatalogDb` re-prepare
  note) is intentionally NOT included — perf-only at current scale; revisit if profiling
  ever says otherwise.

## Panel & review log

> Protocol: pre-panel fact-check pass → adversarial panel (requirements / assumptions /
> failure & abuse / scope) → gate → fold-back → post-gate consistency read. `tasks.md`
> is provisional until the gate passes.

- **Pre-panel fact-check** — PENDING. Must re-verify every `[A]`/`[A?]` finding this
  change consumes (1.3, 1.7, 1.13, 1.14, 2.1–2.14, 3.8, 5.1, 5.6–5.10) against the live
  repo per the sdlc-process property-verification rules, and re-verify the `[V]` findings'
  anchors still hold after the `quick-fixes-2026-07` merge.
- **Panel** — PENDING.
- **Gate** — PENDING.
- **Post-gate consistency read** — PENDING.
