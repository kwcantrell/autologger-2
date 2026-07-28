# Design: code-health-consolidation

## Context

Source brief: `docs/reviews/2026-07-27-full-repo-review.md` — finding numbers below refer
to it. The review's verification legend applies: `[V]` findings were orchestrator-verified;
`[A]`/`[A?]` findings are agent-reported and MUST be re-verified by this change's
pre-panel fact-check pass before the panel treats them as fact.

**Split by the 2026-07-27 gate (ruling 1):** this change is the HEAD — the two
failure-path contract deltas (see `specs/api-contract-freeze/spec.md`) plus the AI
process-lifecycle work. Decisions D5, D6, D8–D12 moved to `code-health-tail` (decision
IDs are shared across the two changes; D1–D4 and D7 live here). The quick-fix track
(`quick-fixes-2026-07`) merged to `main` 2026-07-27 (`721fc00`).

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

- Make broadcast emission atomic with the owning transaction (finding 1.3); the
  `suppressBroadcast` flags are retained per D1 (panel ruling — they own the
  composite's frame contract).
- Eliminate the orphan-process hazard on the chat/topic path and the turn-orchestration
  drift class (1.1, 1.14, 2.2).
- Return `416` for suffix ranges on zero-byte blobs (1.7).

**Non-Goals:** everything in the proposal's Non-Goals list — notably the entire
consolidation tail (now `code-health-tail`) and the deferred finding 1.13.

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

**D4 — `issuedClaudeSessionIds` bounding: DEFERRED (gate ruling 2, 2026-07-27).** The
panel found the drafted approach (insertion-order eviction at an unstated cap) breaks
the baseline `ai-topics-chat` SHALL ("… the server SHALL resume") with no authorizing
delta — an evicted-but-legitimate id gets `422` — and `Map.set` doesn't refresh
insertion order, so the FIFO cap would evict the longest-lived, most-active
conversation FIRST. The gate deferred: no cap in this change; review finding 1.13 is
re-dispositioned to accepted residual / roadmap (the leak is two short strings per
completed turn). Any future cap requires an `ai-topics-chat` delta with touch-refresh
and a stated cap value.

**D5, D6 — moved to `code-health-tail`** (gate ruling 1; decision IDs are shared
across the two changes).

**D7 — Zero-byte suffix range maps to the existing unsatisfiable-range path.** In the
blob-store range computation, a suffix range against `size === 0` raises
`InvalidRangeError` (the type the router already maps to `416`) instead of constructing
an invalid stream window. Covered by a new unit + integration test.

**D8–D12 and the finding-5.9 residual dispositions — moved to `code-health-tail`**
(gate ruling 1).

## Risks / Trade-offs

- [Broadcast queue changes emission *timing* within an RPC (mid-txn → post-commit)] →
  not externally observable (same synchronous call, before return), but WS int tests
  that accidentally depend on intra-RPC interleaving could surface; fix tests only if
  they asserted unpublished timing, never by re-suppressing.
- [Shared turn orchestrator could subtly change SSE output] → pin both paths' observable
  SSE sequences with tests *before* extracting; scrubbing stays per-path.
- [Kill-ladder swap on the chat path regresses some edge] → the ladder being adopted is
  the spike-proven v2 one; add a unit test for the leader-exits-member-survives case
  (the exact scenario the old ladder failed).
- [Sequencing] → one change in flight: this change → `code-health-tail` →
  `server-capabilities`.

## Migration Plan

Internal-only: no data migration, no deploy steps beyond normal release. Rollback is
`git revert` of the branch merge. The two contract deltas are failure-path-only and
require no client updates.

## Open Questions

- None blocking.

## Panel & review log

> Task numbers inside the dated entries below use the PRE-SPLIT numbering (the
> numbering in force when each entry was written). Post-split mapping: old head 9.x →
> head 5.x; old phases 5–8 → `code-health-tail` phases 2–5 (e.g. old 5.4 → tail 2.4,
> old 5.5 → tail 2.5, old 7.4/7.6/7.7 → tail 4.4/4.6/4.7, old 8.1/8.2 → tail 5.1/5.2).
> Head tasks 1.x–4.x cited below are unchanged; 4.3 is struck.

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
  frames-not-timing (folded into D3/task 1.3 language); 5.9 leftovers recorded as OBS
  in `code-health-tail`'s design (moved there by the split).

  Verified-and-held notes from all four reviewers are preserved in the panel transcripts
  (`.apply/`-external; summarized: D1 covers every broadcast path incl. alarm/constructor
  `expireIfStale`; no close/evict or re-entrancy window in the flush; D7 closes the whole
  invalid-window class — the suffix branch was the only crash path; D8's sync-throw is
  indistinguishable at Hono's `onError` incl. the WS middleware; security chokepoints —
  scrub allow-lists, principal binding, closed-world lockdown, dashboard-CRUD gate
  narrowing — are preserved by the rewritten D3/D12).
- **2026-07-27 — Gate (owner ruling): all four panel recommendations adopted.**
  (1) SPLIT executed — this change narrowed to the head (phases 1–4 + final gates,
  decisions D1–D4/D7); the tail became the `code-health-tail` change (D5, D6, D8–D12),
  sequenced after this one. (2) Finding 1.13 DEFERRED — task 4.3 struck, D4 records the
  constraint any future cap must satisfy. (3) Toast-API + path-encoding convergence
  DROPPED to accepted residual; `OkResponse` adoption kept (in the tail). (4) Seed-chain
  test migration kept at full breadth (lands in the tail). Session-scope note: apply-
  time implementer subagents will run top-tier (Opus/Fable) this session per the
  owner's model directive — recorded here as the ledger justification the SDLC's
  mid-tier default requires.
- **2026-07-27 — Post-gate consistency read** (single reviewer over all nine final
  documents: both changes' proposal/design/tasks/delta + the review doc with its gate
  addendum). Verdict: three findings, none normative, all fixed — (1) this log's
  pre-split task numbers annotated with the post-split mapping (above); (2) the stale
  "5.9 leftovers recorded above" pointer redirected to `code-health-tail`; (3) the
  tail's "no contract-surface phases" claim given its rationale (documentary delta,
  zero observable change). Everything else verified consistent: decision-ID partition
  (D1–D4/D7 vs D5/D6/D8–D12, all twelve accounted for), finding assignment (no finding
  claimed by both changes or by neither), delta specs vs Capabilities sections, gate
  addendum vs actual scopes, sequencing and merge refs.
