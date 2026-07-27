# Design: code-health-tail

## Context

Split from `code-health-consolidation` by its 2026-07-27 gate (ruling 1). Decision IDs
below keep their original numbers (D5–D12) so the review-doc and panel-log
cross-references stay valid; D1–D4 and D7 live in the head change. The 2026-07-27
fact-check (claims S8–S16, S18, W1–W12) and adversarial panel covered this content
pre-split; their corrections are already folded into the decisions below. Source brief:
`docs/reviews/2026-07-27-full-repo-review.md`.

**Preconditions**: the head change (`code-health-consolidation`) is merged first — its
D3 rewrite of the AI turn runners changes files this change's 5.9-batch touches
(`aiV2SdkSpawn`'s redundant `terminateOnce` dissolves there, not here), and
`quick-fixes-2026-07` (merged 2026-07-27, `721fc00`) already landed the shared exports
this change consumes (e.g. `WORKSPACE_EVENTS_LIMIT`).

**Invariants a future reader must not "helpfully" undo** (all preserved): SessionHub
RPC bodies stay synchronous; every mutating hub RPC stays inside one transaction;
single Node process; the frozen contract — every consolidation here is
behavior-preserving, and the one spec delta pins existing behavior; the deliberate
patterns the review excluded (mounted-hidden latches, 503-latch fallback, scrub
chokepoints, provenance headers, the dashboard-CRUD routes' deliberately narrower gate
set) are untouched.

## Goals / Non-Goals

**Goals:** single-source every duplicated-logic pair dispositioned to this change
(findings 2.1, 2.3–2.12, 2.14, 3.8-documentation, 5.6, 5.7), remove the spurious-await
pattern (5.1), land the batched web items (5.9 OS subset incl. `OkResponse`), and
dedupe test infrastructure (5.10) — each with behavior-preservation tests.

**Non-Goals:** the head change's scope; toast-API/path-encoding convergence (gate:
residual); finding 2.13 (residual); finding 1.13 (gate: deferred); `useZoomRail`
rewrite.

## Decisions

**D5 — Web SSE consolidation: one `useSseTurn` hook + one composer component.** The hook
owns fetch/reader/decoder buffering (over the already-shared `parseSseFrames`, which is
not duplicated today — AiV2Design imports it from AiChat), delta-append, abort-vs-lost
classification (per-path `CONNECTION_LOST_DETAIL` string), and the notConfigured-503
branch. Parameterization surface per the fact-check (claim W1): an event-vocabulary
handler map with chat-only `tool`, design-only `question`/`dashboard`, and per-path
`done`/`error` bodies (chat's `done` parses and propagates `claude_session_id`;
design's clears pending-question state, and its `error` clears it before pushing the
message). The Stop/Send textarea footer becomes a shared component with one slot: a
plain `placeholder: string` prop computed by the caller (panel: not a function slot).
*Alternatives:* leave duplicated with lint-guard comments — rejected: ~150 lines of
already-observed drift surface.

**D6 — Query keys: extend the existing factory modules.** Add `sessionStatusKeys` and
`audioSegmentsKeys` factories (neither exists today — fact-check W6) beside the existing
`eventsKeys`/`sessionKeys`/`teamKeys`/`topicsQueryKey` and replace every bare literal.
Sweep inventory (W6): `session-status` in `useSessionSocket.ts` (×3), `useTransport.ts`,
`useSessionStatus.ts`, `useAudio.ts`, PLUS the prefix-only literal `['session-status']`
in `HomeSettingsModal.tsx` (needs an `.all`-style factory entry) and two test files;
`audio-segments` in `useSessionSocket.ts`, `useSessions.ts`, `useAudio.ts`. Key
*arrays are unchanged* (same strings, same shapes), so no cache invalidation behavior
changes — compile-time coupling only.

**D8 — De-async `requireSession` and drop spurious awaits.** `requireSession` becomes
synchronous (its body already is — fact-check S13); the ~45 `await`s on hub RPCs and
the two `Promise.all` wraps over sync calls are removed; test seed helpers likewise.
Handlers stay `async` where Hono requires a Promise return.
*Consequence check (panel-verified):* sync throw vs rejected promise is
indistinguishable at Hono's `onError`, including the WS upgrade middleware; removing
awaits removes only microtask yields, which never let I/O interleave.

**D9 — PUT `internal` category branch (3.8): KEEP the branch — it is reachable, not
dead.** (Reversed by the fact-check, claim S12.) `validateCategoriesList`
(`server/src/studio.ts`) accepts any non-empty trimmed string as a category id with no
reserved-id list, so a studio profile CAN define a category with id `internal`; for such
a profile, PUT's `stripCategoryUiSnapshots` branch fires and is load-bearing observable
behavior. Keep the branch, add a comment documenting the reachability condition and the
deliberate PUT-vs-POST asymmetry, add a pinning test, and pin the edge in the baseline
via this change's delta spec.
*Alternatives:* delete as dead code — rejected: refuted by the validator read; align
PUT to POST — rejected: observable contract change with no consumer need.

**D10 — `core.eventCounts()` owns the event-count SQL.** The duplicated count queries
(including the `lower(trim(category)) != 'internal'` filter) move to one core helper;
`TransportStore.statusLive` calls it, restoring sessionCore's stated "stores never read
each other's tables" layering.

**D11 — Companion payload typed server-side only.** Declare the state-payload type next
to the companion router and type the builder against it; companion keeps its own copy
(documented mirroring, same as `web/src/api/types.ts`). The server-side type MUST
describe what the server actually sends — including the two `last_command` fields
(`session_id`, `created_at_utc`) that companion's `LastCommand` interface
under-declares today (fact-check S18); companion's type is NOT changed (frozen wire;
excess fields are benign to a structural TS consumer). No shared package, no wire
change.
*Alternative:* a shared workspace types package — rejected: new coupling surface for a
frozen wire shape; mirroring with per-field provenance is the repo's established
pattern.

**D12 — Remaining consolidations follow the obvious single-source direction** (each with
a behavior-pinning test first where one doesn't exist), with fact-check/panel
refinements: deck title → existing `sessionDeckDisplayTitle` (three copies verified
behaviorally identical, no import cycle); marker grouping → one shared util consumed by
Timeline + MarkerNav (implementations verified outcome-equivalent,
phrasing-different); generate-latch → `useGatedGenerate` + shared toolbar fragment
(verify the near-verbatim premise against the post-quick-fixes tree — W3; the
Transcribe reason-span carries an inline `<code>` element the shared fragment must
slot); palette-9 → single exported `normalizePalette9` + module-level `DEFAULT_PALETTE`
in EventButtonsTable's shape (W5: neither name is exported anywhere today, so no
migration hazard); session cards → EXTRACTION, not unification (panel: W7's six
difference axes are perfectly correlated with archived-vs-active — extract the verbatim
~40 duplicated lines into a shared delete-confirm hook, a shared meta/runtime
derivation helper, and a shared menu/meta-row scaffold, keeping two thin variant
components); aiV2 guard prologue → `guardAiV2Route` parameterized by WHICH 503 gates
apply (S10: dashboard-CRUD routes deliberately gate only on `aiV2Configured`); store
patch-builder/ordinal-seed → shared private helpers; lease free-path → private
`freeLease()`; mime↔ext → one bidirectional table; internal-audio grammar →
recording.ts imports from audioClips.ts (W2: reconcile `?? ''` vs `|| ''` and decide
export visibility — audioClips' sort is module-private today while recording.ts exports
it); existence checks → `SELECT 1` at the two non-conforming sites this change already
rewrites; companion row-reuse (S14: only 2 of 3 re-fetch sites cast; returning the row
from `requireActiveSession` removes all three re-fetches); catalog cleanups per finding
5.7 (upsert for `authSetPrefs` — currently 2–3 statements depending on row existence —
`tx()` for the two read-modify-write pairs, `resetToDefault()` local in
`getStudioSettingsBlob`, single `listShowsForStudio` per profile assembly). Test-infra
dedupe (5.10, corrected counts S16/W11): shared `parseSse` (2 files) + seed-chain
helper (~9–12 int-test files, full breadth per gate ruling 4), shared e2e
`createSession` helper (8 sites / 5 spec files, promoting visual.spec's private
helper), `configuredEnv` rename, shared fake-core helper (2 of 3 fakes use
`as unknown as` casts), relocate the misplaced fakeClock suites.

**Explicit residual dispositions for finding 5.9's unlisted leftovers**: NewSessionModal
inline styles, `audio.ts` waveform-bound comment mismatch (the [-0.02,1.02] acceptance
range itself is frozen), `app.ts` `as 400` cast — accepted residuals (OBS), not tasked.
`aiV2SdkSpawn`'s redundant `terminateOnce`/`cleaned` ordering is absorbed by the head
change's D3 rewrite.

## Risks / Trade-offs

- [Wide file touch surface] → phases are behavior-preserving with pinning tests; no
  contract-surface phases here, so per-phase reviews defer to the whole-branch audit
  except where files/state are shared with deferred phases (SDLC audit-package rules).
- [Shared abstractions could subtly change UI behavior] → pin-before-extract ordering
  per task; frozen-contract suites + zero-visual-change e2e gate.
- [Sequencing] → this change waits for the head change's merge (one change in flight);
  `server-capabilities` queues behind this change (it builds UI gating on the very feed
  components task 4.4 refactors).

## Migration Plan

Internal-only: no data migration, no deploy steps. Rollback is `git revert` of the
branch merge. The one spec delta pins existing behavior and requires nothing of clients.

## Open Questions

None blocking. The catalog statement-cache idea (finding 5.7's `CatalogDb` re-prepare
note) remains deliberately excluded — perf-only at current scale.

## Panel & review log

> This change was reviewed pre-split as part of `code-health-consolidation`; the
> entries below inherit from that change's log (same date, same reviewers) and record
> only what bears on this half. Full detail: the head change's `design.md`.

- **2026-07-27 — Pre-panel fact-check (inherited):** claims S8–S16, S18, W1–W12 cover
  this change's content; verdicts and corrections are folded into D5–D12 above
  (notably: S12 reversed D9 to keep-and-document; W6/W1/W5 supplied the sweep and
  parameterization inventories; S16/W11 corrected the test-dedupe counts).
- **2026-07-27 — Adversarial panel (inherited):** rulings folded here: session-card
  direction reversed to extraction (scope MAJOR-2); finding 5.6 tasked after being
  caught untasked (scope MAJOR-3 / requirements F3); finding 2.13 de-scoped to
  residual; `SELECT 1` rebilled as two-site incidental; seed-chain breadth kept (gate
  ruling 4); toast/path-encoding dropped, `OkResponse` kept (gate ruling 3); D5's
  composer slot simplified to a string prop.
- **2026-07-27 — Gate:** all four panel recommendations adopted by the owner —
  (1) split executed, this change is the tail and lands after the head; (2) finding
  1.13 deferred (not in either change); (3) toast/path-encoding convergence dropped to
  residual, `OkResponse` kept; (4) seed-chain migration at full breadth here.
- **Post-gate consistency read** — PENDING.
