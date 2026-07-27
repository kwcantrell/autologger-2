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

**D3 — One shared turn orchestrator for the OUTER scaffolding only, with the relay
staying per-path.** (Rescoped by the 2026-07-27 fact-check, claim S7.) The genuinely
shared clone is the outer timeout/abort/`Promise.race`/kill/finally scaffolding — the
relay/message-translation is NOT symmetric (chat externalizes it as `relayAiChatTurn`
over a `ChildProcess`'s stdout JSONL; v2 embeds SDK-message translation inline over an
`AsyncIterable<SDKMessage>`) and stays per-path. The orchestrator's hook surface,
per the fact-check's asymmetry inventory: `{runRelay, terminate, emitGuard, scrub,
release, timeoutMs, onTimeoutOrAbort}` — `terminate` is an injected closure (v2 has no
pid; chat wraps the shared kill ladder from D2), `release` becomes an explicit
always-required hook (today only v2 takes it as a parameter; chat releases one layer up
in `ai.ts`), and `onTimeoutOrAbort` carries v2's `abortController.abort()` calls (chat
has none — killing the group suffices for a raw-stdout relay). Both paths adopt v2's
outer `try/finally` hardening (terminate + cleanup on ANY exit path, including an
unexpected throw). Two policies are unified deliberately: emit-throw policy adopts the
v2 behavior (guarded emit swallows transport throws) for both paths — the chat path's
current propagation pierces `driveAiTurn`'s documented "never throws" contract, so this
is convergence toward the stated design and not wire-observable (a throwing SSE write
means the client is already gone); relay-drain policy stays per-path as today (chat
awaits the relay's settle on timeout/abort, v2 does not — unifying it would change
non-happy-path resolve timing for no correctness gain) and is pinned by the phase-1
tests. Terminal-detail scrubbing remains a per-path parameter so each path's observable
SSE output stays byte-identical.
*Alternatives:* unify only the kill ladder and leave the orchestrators — rejected: the
orchestrators are where the drift already happened twice; unify the relays too —
rejected: the input types differ fundamentally and forcing them under one abstraction
would manufacture complexity, not remove it.

**D4 — `issuedClaudeSessionIds` becomes size-capped.** Replace the unbounded `Map` with
insertion-order eviction at a fixed cap (Map preserves insertion order; evict oldest on
insert past the cap). No TTL, no new dependency, no behavior change for live sessions at
any realistic scale.
*Alternatives:* per-session keying with deletion on session delete — rejected as larger
surface for the same effect; TTL — rejected: adds a clock dependency for no added safety.

**D5 — Web SSE consolidation: one `useSseTurn` hook + one composer component.** The hook
owns fetch/reader/decoder buffering (over the already-shared `parseSseFrames`, which is
not duplicated today — AiV2Design imports it from AiChat), delta-append, abort-vs-lost
classification (per-path `CONNECTION_LOST_DETAIL` string), and the notConfigured-503
branch. Parameterization surface per the fact-check (claim W1): an event-vocabulary
handler map with chat-only `tool`, design-only `question`/`dashboard`, and per-path
`done`/`error` bodies (chat's `done` parses and propagates `claude_session_id`;
design's clears pending-question state, and its `error` clears it before pushing the
message). The Stop/Send textarea footer becomes a shared component with one slot:
`placeholder` (static for chat; a function of `messages.length`/`pendingQuestion` for
design).
*Alternatives:* leave duplicated with lint-guard comments — rejected: ~150 lines of
already-observed drift surface.

**D6 — Query keys: extend the existing factory modules.** Add `sessionStatusKeys` and
`audioSegmentsKeys` factories (neither exists today — fact-check W6) beside the existing
`eventsKeys`/`sessionKeys`/`teamKeys`/`topicsQueryKey` and replace every bare literal.
Sweep inventory (W6): `session-status` in `useSessionSocket.ts` (×3), `useTransport.ts`,
`useSessionStatus.ts`, `useAudio.ts`, PLUS the prefix-only literal
`['session-status']` in `HomeSettingsModal.tsx` (needs an `.all`-style factory entry)
and two test files; `audio-segments` in `useSessionSocket.ts`, `useSessions.ts`,
`useAudio.ts`. Key *arrays are unchanged* (same strings, same shapes), so no cache
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

**D9 — PUT `internal` category branch (3.8): KEEP the branch — it is reachable, not
dead.** (Reversed by the 2026-07-27 fact-check, claim S12.) `validateCategoriesList`
(`server/src/studio.ts`) accepts any non-empty trimmed string as a category id with no
reserved-id list, so a studio profile CAN define a category with id `internal`; for such
a profile, PUT's `stripCategoryUiSnapshots` branch fires and is load-bearing observable
behavior. Deleting it (the review's original disposition option) would be an
unauthorized contract change on that edge. Instead: keep the branch and add a comment
documenting its reachability condition and the deliberate PUT-vs-POST asymmetry (POST
admits `internal` explicitly even when absent from the profile; PUT requires it to be a
profile category first — both frozen).
*Alternatives:* delete as dead code — rejected: refuted by the validator read; align
PUT to POST's admit-internal rule — rejected: observable contract change with no
consumer need.

**D10 — `core.eventCounts()` owns the event-count SQL.** The duplicated count queries
(including the `lower(trim(category)) != 'internal'` filter) move to one core helper;
`TransportStore.statusLive` calls it, restoring sessionCore's stated "stores never read
each other's tables" layering.

**D11 — Companion payload typed server-side only.** Declare the state-payload type next
to the companion router and type the builder against it; companion keeps its own copy
(documented mirroring, same as `web/src/api/types.ts`). The server-side type MUST
describe what the server actually sends — including the two `last_command` fields
(`session_id`, `created_at_utc`) that companion's `LastCommand` interface under-declares
today (fact-check S18); companion's type is NOT changed (frozen wire; excess fields are
benign to a structural TS consumer). No shared package, no wire change.
*Alternative:* a shared workspace types package — rejected: new coupling surface for a
frozen wire shape; mirroring with per-field provenance is the repo's established pattern.

**D12 — Remaining consolidations follow the obvious single-source direction** (each with
a behavior-pinning test first where one doesn't exist), with fact-check refinements:
deck title → existing `sessionDeckDisplayTitle` (three copies verified behaviorally
identical, no import cycle); marker grouping → one shared util consumed by Timeline +
MarkerNav (implementations verified outcome-equivalent, phrasing-different); generate-
latch → `useGatedGenerate` + shared toolbar fragment (note W3: near-verbatim holds
against the post-`quick-fixes-2026-07` baseline — verify against the merged tree, and
the Transcribe reason-span carries an inline `<code>` element the shared fragment must
slot); palette-9 → single exported `normalizePalette9` + module-level `DEFAULT_PALETTE`
in EventButtonsTable's shape (W5: neither name is exported anywhere today, so no
migration hazard); session cards → one card component parameterized by MORE than menu
items (W7: outer-container selectability handlers, title as button-vs-span, rename-modal
ownership, `data-start-offset` + hidden a11y markers are per-variant); aiV2 guard
prologue → `guardAiV2Route` helper parameterized by WHICH 503 gates apply (S10: the
dashboard-CRUD routes deliberately gate only on `aiV2Configured` — documented in-file —
so the helper takes a gate set, it does not assume all five routes are identical);
store patch-builder/ordinal-seed → shared private helpers module; lease free-path →
private `freeLease()`; mime↔ext → one bidirectional table; internal-audio grammar →
recording.ts imports from audioClips.ts (W2: also reconcile the `?? ''` vs `|| ''`
character and decide export visibility — audioClips' `sortAudioInternalByOrdinalThenTime`
is module-private today while recording.ts exports it); existence checks → `SELECT 1`
convention; companion row-reuse (S14 nuance: only 2 of the 3 re-fetch sites cast — the
third null-checks — returning the row from `requireActiveSession` removes all three
re-fetches regardless); catalog cleanups per finding 5.7 (upsert for `authSetPrefs` —
currently 2–3 statements depending on row existence, S15 — `tx()` for the two
read-modify-write pairs, `resetToDefault()` local in `getStudioSettingsBlob`, single
`listShowsForStudio` per profile assembly). Test-infra dedupe (5.10, corrected counts
S16/W11): shared `parseSse` (2 files) and a shared seed-chain helper (the duplication
spans ~9–12 int-test files, not ~8), shared e2e `createSession` helper (8 sites / 5 spec
files, promoting visual.spec's private helper), `configuredEnv` rename, shared
fake-core test helper (2 of the 3 fakes use `as unknown as` casts; `sessionCore.test.ts`'s
satisfies `SessionRuntime` structurally).

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

- **2026-07-27 — Pre-panel fact-check (two light-tier fetch-and-compare reviewers:
  server claims S1–S18, web claims W1–W12; orchestrator closed the two open sub-parts).**
  30 claims checked. Verdicts: 23 CONFIRMED (several with the difference inventories D3/
  D5/D6/D12 now carry), 7 CORRECTED (folded into D3, D5, D6, D9, D11, D12 and tasks
  4.2/5.3/5.6/7.4/7.6/7.7/8.1/8.2), 0 REFUTED as review findings — but one design
  disposition was REVERSED: S12 established the PUT `internal` branch is reachable
  (`validateCategoriesList` has no reserved-id list), so D9 changed from delete-dead-
  branch to keep-and-document (deleting it would have been an unauthorized observable
  change). Highest-value additive finding: S7's six-item asymmetry inventory between
  `runAiChatTurn`/`runDesignTurn`, which rescoped D3 to outer-scaffolding-only with the
  relay per-path. Sub-parts closed by the orchestrator directly: baseline
  `api-contract-freeze` spec language (read in-session: emission + range semantics are
  frozen exactly as the delta assumes); `studio.ts` validator reachability read (S12).
  Method note: per-claim logs (property verified, read performed — whole-function/file/
  grep — and quoted evidence) were produced by both reviewers; judgment-laden review
  items were not in scope and reach the panel un-vouched. Claims verified against
  `main`; files also touched by `quick-fixes-2026-07` carry overlap flags (materially:
  W3's TranscribeFeed `errorRef` divergence disappears once that branch merges —
  consolidation premises should be re-anchored on the merged tree at apply task 1.1).
- **Panel** — PENDING. Stated claims above were pre-checked as an aid, never a warrant:
  reviewers retain the full skeptical mandate — verify anything doubted; implicit
  premises the fact-check structurally cannot enumerate are the panel's to surface.
- **Gate** — PENDING.
- **Post-gate consistency read** — PENDING.
