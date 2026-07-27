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

**D1 — Broadcast queue lives in `sessionCore`, flushed by `inTxn` after commit; the
`suppressBroadcast` flags STAY.** (Rewritten after the 2026-07-27 panel — all three
technical reviewers independently found the original "queue subsumes the flags" premise
false.) `core.broadcast()` enqueues while a transaction is open and sends immediately
otherwise; `inTxn` flushes the queue (in enqueue order) after the transaction function
returns and better-sqlite3 commits, and discards it on throw/rollback. Store code is
unchanged at call sites.

**Composite reconciliation (the panel blocker):** the queue provides *atomicity*
(no frame for a rolled-back write); it does NOT provide *suppression*. The one composite
RPC, `anchorImportedTake`, today suppresses three store-level frames and manually emits
exactly two post-commit frames (`event.changed` with the final revision, then
`transport.changed`); a naive flush of un-suppressed enqueues would emit three frames
including an intermediate revision no client has ever observed. Therefore the two
`suppressBroadcast` flags and the composite's manual post-commit emission are RETAINED —
their job (frame-count/payload contract of the composite) is distinct from the queue's
job — and only their *rationale comments* are updated to describe the two mechanisms'
division of labor. *Alternative considered:* a queue coalescing policy (keep-last
payload per type at first-enqueue position) — reproduces today's bytes for this
composite but silently dedups any future multi-broadcast RPC; rejected as a
behavior-bearing policy hidden in infrastructure.

Nested `inTxn` (savepoint) semantics: no current caller nests (the composite calls
store methods directly, "so nothing is nested"), and inner-catch-and-continue is
declared UNSUPPORTED — an inner savepoint rollback that the outer transaction survives
is outside the queue's contract; task 2.1's nested test pins flush-at-outermost-commit
and whole-queue discard on an escaping throw, nothing more. Flush preserves
`core.broadcast`'s existing per-socket try/catch isolation — one bad socket MUST NOT
abort delivery of remaining queued frames to healthy sockets. Broadcasts issued outside
any transaction (the composite's manual pair, `broadcastCommand`, presence) send
immediately, exactly as today.
*Alternatives:* (a) extend `suppressBroadcast` per-composite as the *atomicity* fix —
rejected: the review shows the flag approach already missed every other store's
failure-path hazard; (b) queue in `SessionHub` rather than core — rejected: core owns
`broadcast` and stores call it directly, so the seam is core. *Consequence check:*
success-path broadcasts still fire before the RPC returns (flush is inside the same
synchronous call), so no observable ordering change relative to HTTP responses or WS
delivery.

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
`AsyncIterable<SDKMessage>`) and stays per-path. The orchestrator's hook surface is
CAPPED at five injection points (panel: an 8-knob config framework for exactly two
call sites is over-articulation): `{runRelay, terminate, scrub, timeoutMs, onFinally}`.

- `runRelay` owns the per-path relay AND its drain policy: the hook's contract is that
  it returns both the relay promise and how the scaffolding treats it on timeout/abort
  (chat awaits the relay's settle — which also guarantees the child handle is reaped;
  v2 must NOT await, its aborted iterator may never yield). The drain policy is a
  stated part of the hook contract, not an implicit spine behavior. Phase-1 tests pin
  SSE *frames*, never settle/resolve *timing*.
- `terminate` is an injected closure (v2 has no pid; chat wraps the shared kill ladder
  from D2) and additionally owns v2's `abortController.abort()` calls (killing the pgid
  alone does not stop the SDK's iterator; chat's terminate needs no abort — raw stdout).
- `scrub` is applied BY the shared emit guard to EVERY event — the guard/scrub
  composition is structural, preserving v2's confidentiality chokepoint. Chat's scrub
  is the identity function and MUST stay so: its relay emits fixed literals (including
  `'not-logged-in'`) that v2's allow-list would mangle to `internal-error`. The emit
  guard itself is shared logic, not a hook: it swallows transport throws for both paths
  — the chat path's current propagation pierces `driveAiTurn`'s documented "never
  throws" contract (and, verified by the panel, orphans the child when an emit throw
  skips the kill call), so this is convergence toward the stated design and not
  wire-observable.
- `onFinally` runs on EVERY exit path (v2's outer try/finally hardening, adopted for
  both paths) and carries the per-path cleanup closures: for v2, its existing
  `release` + `abandonPendingQuestions` (the every-exit-path abandon guarantee is
  load-bearing — a pending AskUserQuestion must not survive its turn) + config-dir
  cleanup; for chat, nothing beyond terminate.

**Slot release stays ROUTER-OWNED for the chat path** (panel majors): `aiTurn.ts`
documents the deliberate seam "slot acquire/release stays with each router", and chat's
router `finally` releases AFTER registering the issued `claude_session_id` — relocating
release into the orchestrator would (a) wedge the session's slot permanently if setup
fails before orchestrator entry, and (b) open a race where a fast legitimate resume
hits the 422 foreign-id check before registration (an observable status change on a
frozen surface). v2 keeps passing its release closure via `onFinally` as today. The
registry release is idempotent, so the dual-layer arrangement is the intended
defense-in-depth, and the documented seam is NOT reversed.
*Alternatives:* unify only the kill ladder and leave the orchestrators — rejected: the
orchestrators are where the drift already happened twice; unify the relays too —
rejected: the input types differ fundamentally and forcing them under one abstraction
would manufacture complexity, not remove it.

**D4 — `issuedClaudeSessionIds` bounding: ESCALATED TO THE GATE.** The panel found the
drafted approach (insertion-order eviction at an unstated cap) breaks the baseline
`ai-topics-chat` SHALL ("when a request carries a `claude_session_id` that was issued
for the same `:sessionId`, the server SHALL resume") with no authorizing delta: an
evicted-but-legitimate id gets `422` instead of resuming. Worse, `Map.set` on an
existing key does NOT refresh insertion order, and a resumed chat re-issues the same id
each turn — so the drafted eviction is FIFO that evicts the longest-lived, most active
conversation FIRST. Gate options:
(a) **Defer (recommended):** drop the cap from this change; re-disposition review
finding 1.13 to accepted-residual/roadmap. The leak is slow (two short strings per
completed turn) and the change is already large.
(b) **Do it right here:** add a small `ai-topics-chat` delta authorizing bounded
retention (evicted id ⇒ treated as stale/`422`), with touch-refresh on re-issue and
resume (delete-then-set) and a stated cap (e.g. 512) that task 4.3's test asserts.
Not an option: landing any cap without the delta (unauthorized observable change).

**D5 — Web SSE consolidation: one `useSseTurn` hook + one composer component.** The hook
owns fetch/reader/decoder buffering (over the already-shared `parseSseFrames`, which is
not duplicated today — AiV2Design imports it from AiChat), delta-append, abort-vs-lost
classification (per-path `CONNECTION_LOST_DETAIL` string), and the notConfigured-503
branch. Parameterization surface per the fact-check (claim W1): an event-vocabulary
handler map with chat-only `tool`, design-only `question`/`dashboard`, and per-path
`done`/`error` bodies (chat's `done` parses and propagates `claude_session_id`;
design's clears pending-question state, and its `error` clears it before pushing the
message). The Stop/Send textarea footer becomes a shared component with one slot:
a plain `placeholder: string` prop computed by the caller (panel: not a function slot —
same effect, smaller contract; design computes its string from
`messages.length`/`pendingQuestion` at the call site).
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
migration hazard); session cards → EXTRACTION, not unification (panel: W7's six difference axes are
perfectly correlated with archived-vs-active, so a parameterized mega-component is the
wrong direction — instead extract the verbatim ~40 duplicated lines into a shared
delete-confirm hook, a shared meta/runtime derivation helper, and a shared menu/meta-row
scaffold, keeping two thin variant components); aiV2 guard
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

**Explicit residual dispositions for finding 5.9's unlisted leftovers** (panel: record
them so the audit's traceability check has an answer): `aiV2SdkSpawn`'s redundant
`terminateOnce`/`cleaned` ordering — absorbed by D3's rewrite; NewSessionModal inline
styles, `audio.ts` waveform-bound comment mismatch (the [-0.02,1.02] acceptance range
itself is frozen), `app.ts` `as 400` cast — accepted residuals (OBS), not tasked.

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
- **2026-07-27 — Adversarial panel** (four Fable reviewers: requirements, assumptions,
  failure & abuse, scope & simpler-design; skeptical calibration; fact-check presented
  as aid-not-warrant). Dispositions in three buckets:

  **Blockers/majors FIXED IN PLACE:**
  1. Composite-broadcast contradiction (found independently by all three technical
     reviewers): D1's "queue subsumes suppressBroadcast" was false — the queue gives
     atomicity, not suppression; naive flag deletion emits 3 frames incl. an
     intermediate revision vs today's 2. D1 rewritten (flags retained, division of
     labor documented, coalescing considered and rejected), delta spec's mechanism
     mandate replaced with observables-only language, tasks 2.2/2.3 rewritten.
  2. D3 orchestrator majors: slot-release relocation reversed a documented seam
     (`aiTurn.ts` slot-scope decision) and opened a slot-wedge on pre-orchestrator
     setup failure plus a 422-on-legit-resume race; `abandonPendingQuestions`
     every-exit-path guarantee was dropped from the hook list; relay-drain policy was
     inexpressible in the enumerated hooks; emit-guard/scrub composition needed to be
     structural (chat scrub = identity — v2's allow-list would mangle chat's
     `'not-logged-in'`). D3 rewritten: five hooks max, drain owned by `runRelay`,
     abort calls owned by `terminate`, cleanup closures in `onFinally`, chat release
     stays router-owned after id registration.
  3. Scope leaks (two reviewers): finding 5.6 (companion row-reuse) was
     proposal-promised but untasked → added to task 5.5; finding 2.13 (row edit-buffer)
     promised but undesigned/untasked → de-scoped to Non-Goals as accepted residual.
  4. Session-card direction reversed (scope reviewer): extraction of the verbatim ~40
     lines, not a parameterized mega-component (D12 + task 7.7 rewritten).
  5. Factual fixes: task 1.2's phantom second composite RPC (there is one); task 9.2's
     stale baseline date (re-blessed 2026-07-26, not 2026-07-14); task 5.4's `SELECT 1`
     rebilled as a two-site incidental fix; task 2.2's commit-failure test specified as
     a hook-free proxy; D1 gained nested-savepoint semantics (inner-catch unsupported),
     per-socket flush isolation, and outside-txn immediate-send language; the 416 delta
     now names the route and the dual mapping sites; D5's composer slot is a plain
     string prop.

  **ESCALATED TO THE GATE (owner decisions, not panel-resolvable):**
  1. **Split the change?** (scope reviewer, MAJOR) — partition at the phase-4/5
     boundary into A: contract deltas + AI lifecycle (phases 1–4 + gates) and B:
     consolidations (phases 5–8), A first; or keep whole and explicitly accept the
     mega-change cost (lockout of `server-capabilities`, audit size, all-or-nothing
     revert). Panel recommendation: split.
  2. **Finding 1.13 / D4** (requirements BLOCKER as drafted) — defer the
     `issuedClaudeSessionIds` cap (recommended) or authorize it properly via an
     `ai-topics-chat` delta with touch-refresh + stated cap. Drafted FIFO cap is
     stricken either way (breaks resume SHALL; evicts the most-active conversation
     first).
  3. **Toast-API + path-encoding convergence** (scope reviewer) — no defect class,
     ~20-file churn: drop to OBS, or keep (in the tail change if split). `OkResponse`
     stays regardless (tiny, compile-time). Panel recommendation: drop.
  4. **Phase-8 seed-chain migration breadth** (scope reviewer) — full ~9–12-file
     migration vs shared-helper + migrate-only-touched-files. Harmless in a split
     tail; trim if kept whole.

  **Minors accepted as residual:** D2's pgid-reuse probe window (pre-existing v2
  residual, kernel-level, not worsened); chat turns completing `ok` and registering an
  id after the client vanished mid-stream (server-state only); phase-1 pins must pin
  frames-not-timing (folded into D3/task 1.3 language); 5.9 leftovers recorded above
  as OBS.

  Verified-and-held notes from all four reviewers are preserved in the panel transcripts
  (`.apply/`-external; summarized: D1 covers every broadcast path incl. alarm/constructor
  `expireIfStale`; no close/evict or re-entrancy window in the flush; D7 closes the whole
  invalid-window class — the suffix branch was the only crash path; D8's sync-throw is
  indistinguishable at Hono's `onError` incl. the WS middleware; security chokepoints —
  scrub allow-lists, principal binding, closed-world lockdown, dashboard-CRUD gate
  narrowing — are preserved by the rewritten D3/D12).
- **Gate** — PENDING (armed by the panel synthesis above; four escalated decisions).
- **Post-gate consistency read** — PENDING.
