# Design — chunked-live-recording

## Context

Live recordings longer than ~1 hour are silently lost. The recorder accumulates the whole
take in memory and uploads it once on stop; the server rejects live segment uploads over
50 MB with 413; the client upload path has no catch, so the failure surfaces nowhere and
the blob is already discarded.

### Current state, measured on `main` @ `4e8e146`

All claims below were verified this session by reading the named code (whole function
unless noted):

- **Single-blob capture:** `AudioRecorder` calls `mr.start()` with no timeslice
  (`web/src/pages/index/components/AudioRecorder.tsx:280`); `ondataavailable` pushes into
  `chunksRef`; `onstop` builds one `Blob` from all chunks and uploads once (`:241-278`).
- **50 MB cap:** `MAX_AUDIO_BYTES = 50 * 1024 * 1024`
  (`server/src/routers/audio.ts:31`), enforced pre-read on Content-Length (`:126`) and
  post-read on `byteLength` (`:129`); over-cap → `413`.
- **Silent loss:** `doUpload` (`AudioRecorder.tsx:153-194`) is `try/finally` with no
  `catch`; on failure no toast fires, `finally` dispatches `DONE` (overlay/UI reset as if
  successful), and `onstop` already cleared `chunksRef.current = []` (`:249`) — the blob is
  unreachable afterward.
- **Not the lease:** heartbeats every 8 s (`AudioRecorder.tsx:18`) against a 40 s staleness
  window (`packages/session-core/src/leaseStore.ts:8`); the upload endpoint does not check
  the lease (`server/src/routers/audio.ts:122-151`, read in full).
- **One-segment-per-recording assumptions in consumers:**
  - Clip layout: `matchAudioSegmentsToIntervalsGreedy`
    (`web/src/shared/utils/audioClips.ts:176-243`) assigns each segment to a distinct
    recording interval; the legacy path enforces one segment per ordinal via `usedOrd`
    (`:281-291`). Follow-on chunks would be matched to other intervals or chained at the
    timeline end.
  - Transcript anchors: `resolveAnchors`
    (`packages/transcription/src/transcriptRemap.ts:409-462`, read in full) — step 1 lets
    the first segment with `recording_ordinal = N` claim the `Recording N Started` anchor;
    later same-ordinal segments fall through to step 2 index-pairing against *other*
    recordings' leftover anchors (misplacement) or end anchorless.
  - **The recorder itself** (panel finding): `nextOrdinal = (segData?.segments.length ??
    0) + 1` (`AudioRecorder.tsx:92`) derives the next recording number from the *segment
    count* — multi-chunk recordings would make recording numbers skip (1, 5, 9, …) and a
    fully-discarded recording would cause ordinal reuse. See D8.
- **Multi-segment support already exists** at the storage/API level: `addAudioSegment`
  auto-increments `ordinal` per session (`packages/session-core/src/audioStore.ts:80-124`),
  `sync-from-disk` backfills arbitrary segment sets, the segments list response is an
  array, and `mergeAudioSegments` concatenates same-codec runs with per-segment offsets
  (`packages/transcription/src/audioMerge.ts:237-267`).
- **Bitrate arithmetic** (unverified externally — browser-dependent): WebM/Opus at
  Chrome's default ~128 kbps ≈ 0.96 MB/min → the 50 MB cap is crossed at ~52 min; other
  defaults put it between ~50 and ~70 min. The cap-crossing mechanism itself is measured;
  only the exact minute mark varies.

## Goals / Non-Goals

**Goals:**

- A live recording of arbitrary length saves fully, with bounded client memory and every
  upload far below the 50 MB cap.
- A crash/close mid-recording preserves all successfully-uploaded chunks (a crash loses
  the in-flight chunk plus any rescue-queued chunks — stated honestly).
- Upload failure is loud and recoverable (persistent rescue surface, retained blobs,
  Retry, local Download) within the page's lifetime.
- Timeline clips and transcript word placement remain correct with multi-chunk
  recordings, including after failures, retries, and same-N re-runs.
- Zero observable HTTP/WS contract change.

**Non-Goals:** see proposal (cap changes, import paths, at-rest merging, cross-reload
persistence, resumable/multi-client recording).

## Decisions

### D1 — Chunk by stopping and restarting MediaRecorder, not `start(timeslice)`

Every `CHUNK_MS`, stop the active `MediaRecorder` and immediately construct + start a new
one **on the same `MediaStream`** (mic permission, stream, and level meter stay live —
the meter binds to the stream, not the recorder). Each stop yields a complete,
independently playable container file.

- *Alternative — `mr.start(timesliceMs)`:* rejected. Timeslice chunks after the first
  carry no container/init segment; they are not standalone files, so they can't be
  uploaded as independent segments (playback, duration probe, and per-segment DeepGram
  merge all assume self-contained files).
- *Alternative — upload one growing file via ranged appends:* rejected; requires new
  server surface (contract freeze) and complicates atomic blob writes.
- Trade-off: a small capture gap per rollover (expected tens of ms). Accepted for a
  logging tool; D4/D5 use wall-clock timestamps so the gap never skews placement.
- **This mechanism rests on browser behavior no repo read can verify** (panel): restart
  semantics on a live stream, actual gap size, rollover timers in backgrounded tabs. A
  spike task (tasks §0) verifies it on Chromium + Firefox before anything is built on it;
  if a supported browser can't restart seamlessly, the capability statement gets scoped
  before apply proceeds (escalate at that point, not after building).
- **Spike results (2026-08-12, task 0.1 — PASS on both browsers):** Chromium 3/3 chunks
  independently decodable + probe-able, stop→start gap 63.6–65.8 ms, track `live`
  throughout; Firefox 3/3, gap 21–32 ms, track `live`. Two findings: (a) **Firefox
  resets `MediaRecorder.mimeType` to `""` by `dataavailable`/`stop` time** — read the
  mime at `start` (or from a delivered Blob's own `.type`), never from `mr.mimeType` at
  stop (binding on task 4.2's chunk mime and D6's rescue filenames; note today's
  `onstop` already mislabels Firefox ogg as webm via this path); (b) headless tooling
  cannot model real OS tab-throttling — the backgrounded-rollover premise is verified
  only against timer scheduling and stays on task 7.1's manual checklist. Full report:
  `.apply/u0-spike-report.md`.
- An **unexpected** `onstop` (mic unplugged, device switched, OS revoked capture) must be
  distinguished from a rollover stop: unexpected stop = treat as a user stop (upload/queue
  what exists, release lease, surface the reason) — never restart on a dead stream.

### D2 — `CHUNK_MS = 10 minutes` (design-owned constant)

~10 MB/chunk at Chrome's default Opus bitrate — 5× headroom under the 50 MB cap, and a
crash loses at most ~10 minutes plus whatever the rescue queue holds. The value is
deliberately **not** in the capability spec (the spec pins the outcome — far below cap,
bounded loss); adjusting the constant is a design/tuning edit, not a spec change. Tests
inject a smaller value.

- *Alternative — size-triggered rollover:* more precise but requires observing encoder
  output mid-recording; time-based is predictable and testable. Even 320 kbps ≈ 24 MB per
  10 min keeps headroom.

### D3 — Chunk metadata: same `recording_ordinal`, real per-chunk wall window; events unchanged

Each chunk uploads through the existing `POST …/audio/segments` with the recording's
`recording_ordinal` and the chunk's own `started_at_utc`/`ended_at_utc`, where
`started_at_utc` is captured at the chunk's **actual capture start** (for chunk 1: when
the recorder starts, not lease-claim time — removes permission-prompt latency from all
deltas). Exactly one `Recording N Started` / `Recording N Stopped` internal event pair
per recording, one lease claim/release, heartbeats spanning the whole take.

**Phase invariant (panel):** mid-take chunk uploads never leave the `recording` phase.
Today `UPLOAD_START`→`DONE` would kill the heartbeat permanently (the interval
self-destructs when `phase !== 'recording'`, `AudioRecorder.tsx:283-289`), drop the
recording indication, flash the save overlay, and re-arm `toggle()` for a concurrent
second recording. Heartbeats, the recording indication, and the save overlay key off
capture state; `DONE` is reachable only from the stopped state; the full-screen saving
presentation appears only for the final drain. `doUpload`'s `timeline-audio-seek-overlay`
DOM toggling also stays out of the mid-take path.

- *Alternative — per-chunk Started/Stopped events:* rejected. Floods the event feed,
  multiplies anchors (the `Recording (\d+) Started` regex feeds transcript anchoring and
  interval building), and changes user-visible log content for no benefit.
- **Deliberate invariant:** chunk boundaries are invisible to the event feed and the HTTP
  contract. A future reader must not "helpfully" add per-chunk events or new endpoints.

### D4 — Clip layout: chunk groups per interval instance, wall-clock placement, gap-free width

`rebuildAudioClips` groups same-`recording_ordinal` segments into **chunk groups**
(null-ordinal segments stay singleton groups — legacy sessions bit-identical) and matches
one interval per group. Same-N re-run cycles (which `buildRecordingIntervalsFromInternalEvents`
explicitly supports, `audioClips.ts:88-90`) split same-N segments into per-cycle groups
by wall-clock adjacency to their cycle's start event, FIFO per ordinal. A group with no
paired interval (crash: `Started` without `Stopped`) keeps today's unmatched behavior and
never consumes another recording's interval. Within an interval, placement is
**event-wall-time derived** (gate ruling E-A): chunk `k` at
`interval start + max(0, started_at_k − wallTime(interval's start event))`, so no chunk's
position depends on which siblings survived; fallbacks (unparseable event wall time →
base-relative deltas; unparseable member `started_at_utc` → singleton at interval start /
legacy chaining) preserve pre-change behavior bit-identically, since every pre-change
session has delta 0 (`started_at_utc` == event wall time). **Each chunk's clip extends to
the next chunk's position (last chunk to the interval end)** so intervals stay covered
from the first surviving chunk by construction — probe failures inherit that span instead
of collapsing to a 1 s clip, and the frozen jump-coverage requirement ("a jump with no
covering recording moves the playhead only") never regresses there. The lead before the
first surviving chunk (mic-open latency ~0–2 s on new recordings; a discarded leading
chunk's span) is truthfully uncovered — jumps there take the existing no-coverage
behavior. Existing sessions render no such sliver (delta 0).

- *Alternative — cumulative probed durations:* rejected; ignores the rollover gap and
  probe failures would shift every later chunk.
- *Alternative — width from probed duration alone:* rejected (panel): a failed probe
  would uncover ~99% of an interval and suppress feed-jump playback there.
- **Why the legacy `usedOrd` path is also reworked** (panel — recorded so a leaner-minded
  reader doesn't cut it): the change's own headline scenario, a tab killed mid-take,
  produces a `Recording N Started` with no `Stopped` — no pairable interval. If that
  crashed take is the session's only recording, `intervals.length === 0` and the session
  lands on the **legacy path**; crash-survivor chunks are exactly the multi-chunk data it
  must lay out sanely.

### D5 — Transcript anchors: group-based, event-wall-time derivation (gate ruling E-A)

`resolveAnchors` gains chunk-group semantics per the delta spec: groups keyed by
`recording_ordinal` (same-N cycles split by wall-clock adjacency to their anchor events —
`AnchorCandidateEvent` gains the event's wall time to support this); only the group
**base** (lowest-ordinal member) claims a step-1 anchor or participates in index pairing.
Every member's own anchor is then **event-wall-time derived**:
`A + max(0, (started_at_member − wallTime(anchor event))/1000)` — placement independent
of which sibling chunks survived (the gate ordered this hardening over the
lowest-ordinal-base variant). Non-base members never claim leftover anchors and never
index-pair. Fallbacks preserve pre-change behavior exactly: unparseable event wall time →
base at `A`, non-base derive from the base's `started_at_utc`; unparseable member
`started_at_utc` → `A` for a singleton group (the legacy shape), anchorless otherwise.
`SegmentAnchorInfo` gains nullable `startedAtUtc`; `generateTranscriptWords` passes it
from `AudioSegmentMeta` (in scope at the construction site — fact-checked).

**Price of the hardening (accepted at the gate; refined by the U3-halt ruling
2026-08-12):** the formula must be proven a no-op on existing data. For every pre-change
live recording, `started_at_utc` == the event's `marked_at_utc` (the same client
timestamp is sent to both, normalized by the same `parseOptionalMarkedAt` helper), so
delta = 0 by construction. The import paths were found structurally NON-zero
(`anchorImportedTake` stamps the synthesized Started event with a fresh `Clock.now()`
*after* the blob put, while the segment's `started_at_utc` predates the put) — task 3.0's
halt gate fired and the ruling was **D9: thread the anchor** (see D9). Historical
import rows keep a negative delta that the formula's `max(0, ·)` floors to 0 —
placement bit-identical — and that floor-to-zero behavior is fixture-pinned (task 3.0)
so it is a designed property, not a timing accident.

- *Alternative — inherit via merged-group offsets (`SegmentOffset`):* rejected; group
  offsets assume contiguous audio (no rollover gap), break across codec-param group
  splits, and couple anchor semantics to merge internals.
- *Alternative — non-base members derive from the base's `started_at_utc` (base sits at
  `A` exactly):* simpler and automatically bit-identical on existing data, but a
  permanently-failed-then-discarded first chunk shifts every survivor early by its
  duration. The gate ruled for the event-wall-time base (E-A); this variant survives only
  as the unparseable-event-wall-time fallback.
- **Correctness criterion + premise (panel):** the anchor base is *frozen-timecode*
  seconds (`timecodeForMark` freezes while transport is paused), while deltas are wall
  clock — these diverge under a mid-take transport pause. The criterion is **"a chunked
  take places words/clips exactly where the unsplit take would have"**: the unchunked
  recorder also runs audio through transport pauses and places words at
  `anchor + audio offset`, so wall-delta derivation reproduces unchunked placement
  exactly, pause or no pause. A test asserts chunked ≡ unchunked placement, including a
  paused-transport fixture. Enrichment (paragraphs/sentiment) resolves through the same
  `resolveAnchors` map, so it inherits derivation automatically — one test pins it.
- Negative deltas (clock stepped backwards mid-take) clamp to 0.
- The formerly-proposed "discarded base shifts survivors" residual is **eliminated** by
  the E-A ruling — survivors place correctly regardless of which chunks were discarded
  (spec scenario "A discarded first chunk does not shift the survivors").

### D6 — Upload pipeline: single-flight, ordered, classified failures; rescue owned outside the component

All uploads for a recording — rollover chunks, retries, the final chunk — flow through
**one single-flight in-order pipeline** (a later chunk never starts before every earlier
chunk's outcome is known; concurrent triggers — boundary, Retry, final stop — just pump
the same pipeline). This is load-bearing, not ceremony (panel): server segment `ordinal`
is arrival order, and D4/D5 key their base on lowest ordinal — out-of-order uploads would
invert the base. A chunk leaves the queue only on confirmed success; after an ambiguous
network-level failure the pipeline refetches the segments list and treats an existing
`(recording_ordinal, started_at_utc)` match as success (idempotency without new server
surface). Failures classify: transient (network/5xx/408/429) stay queued; permanent
(other 4xx) move to rescue-only so they can't poison the queue head (zero-byte chunks are
skipped outright — the server 400s them). 

The rescue surface is a **dedicated recorder-owned persistent banner, not the legacy
toast store** (panel): `Toast.tsx` has no action buttons, auto-dismisses non-persistent
toasts in 3.2 s, and `hideToast()` pops the most recent persistent toast from unrelated
code paths (`AudioSaveOverlay` calls it on leave) — any of which would turn
"dismissal-is-consent" into programmatic or timed data loss. Discard requires an explicit
confirm naming the amount discarded, per-chunk Downloads revoke their object URLs after
use, and filenames are filesystem-safe (no ISO colons) with the extension derived from
the blob's actual container type (`mr.mimeType` — Safari records `audio/mp4`, not webm).

The queue and pipeline live in a module outside the component (the recorder is **not**
remounted per session — `SessionWorkspace` renders it unkeyed — so uploads bind the
sessionId captured at recording start, and rescue survives unmount/session switch). The
`beforeunload` guard extends from `phase === 'recording'` to "recording OR queue
non-empty OR upload in flight".

**Why the recorder stays non-idle until drain/discard** (panel — recorded rationale): D8
counts rescue-queued chunks' ordinals when minting the next recording's ordinal, but
holding the recorder out of `idle` until the queue resolves is the belt to that suspender
— it prevents a new recording from interleaving with a half-persisted one at all.

- *Alternative — abort recording on first failed chunk:* rejected; a transient blip would
  kill an hours-long take.
- *Alternative — manual Retry only (no boundary re-attempts):* rejected; a mid-take
  outage would strand chunks the user shouldn't have to babysit, and boundary re-attempts
  are a few lines given the pipeline exists anyway.
- *Alternative — persist unsent chunks to IndexedDB:* out of scope (proposal Non-Goals).
- Memory note: queued failed chunks accumulate in memory only while uploads fail — never
  worse than today's whole-take buffering.

### D7 — Waveform peaks per chunk

The existing per-segment waveform flow runs after each chunk upload (it already lives
inside the upload path, so this falls out for free — the spec pins it as one scenario,
not a standalone requirement). Decoding ≤10-minute blobs removes the current
`decodeAudioData`-on-multi-hour-audio risk; the per-rollover decode transient (~50–100 MB
PCM for a 10-min chunk) is short-lived and best-effort as today.

### D8 — Recording ordinals derive from prior recordings, never `segments.length`

`nextOrdinal = segments.length + 1` breaks the moment recordings are multi-segment
(numbers skip: 1, 5, 9, …) and collides after a fully-discarded recording (count
unchanged → N reused → two `Recording N` event pairs; D4/D5 then co-mingle them). New
derivation: `max(max recording_ordinal across segments, max N parsed from Recording
events, max ordinal held by rescue-queued chunks) + 1`. Events cover the
discarded-recording case; segments cover event-log-failure cases; the local queue covers
not-yet-persisted chunks.

### D9 — Import anchors thread the segment's wall time (U3-halt ruling, 2026-08-12)

`SessionHub.anchorImportedTake` (used by YouTube import and local/batch import) gains the
take's `startedAtUtc`, threaded from the router (which already computed it for the
segment), and stamps the synthesized `Recording N Started` event's **wall time** with it
instead of a fresh `Clock.now()` — making the E-A delta-0 identity hold by construction
for future imports, exactly as it does for live recordings. Constraints:

- **The event's timecode anchoring is untouched.** The `youtube-audio-import` capability
  spec pins `timecode_total_frames` to the session's transport position at import time —
  only the wall-time source changes; the implementer must verify `EventStore.addEvent`
  can take the threaded wall time without re-deriving the timecode from it (extend the
  hub-internal call shape if needed; the hub RPC surface is not the frozen HTTP contract).
- **Historical rows need no migration:** their stored deltas are negative (event stamped
  after the put), and the formula's `max(0, ·)` floors them to 0 — placement
  bit-identical, fixture-pinned as a designed property (task 3.0).
- **No import-spec delta required:** neither `youtube-audio-import` nor
  `batch-audio-import` constrains the Started event's wall-time source (verified by
  reading both specs); shapes, statuses, atomicity, and emission semantics are unchanged.
  The proposal's contract-impact section records this reasoning.
- Precedent note: the `youtube-audio-import` spec's "Recording-ordinal assignment avoids
  collision" requirement already mandates exactly D8's max-over-segments-and-events
  derivation — D8 aligns the live recorder with existing spec'd import behavior.
- Implementation notes (U3, 2026-08-12): `EventStore.addEvent` gained an optional
  `storedWallTimeUtc` consulted only for the stored `wall_time_utc` — timecode derivation
  untouched (unit-pinned: override independence, `explicitAnchor` precedence,
  omitted-fallback byte-identity). When threaded, the synthesized **Stopped** event's
  wall time is `startedAtUtc + durationS` (not a fresh `now()`): interval pairing orders
  Started/Stopped by wall time, so the Started < Stopped invariant must not depend on how
  long the anchor RPC takes. The E-A formula itself never reads Stopped wall times.
- *Alternative — pin the clamp as the invariant (no code change):* rejected by the
  ruling; it encodes an accidental timing property as if designed.
- *Alternative — formula for multi-member groups only:* rejected; reopens a sliver of
  the E-A corner (a recording reduced to one surviving chunk).

## Risks / Trade-offs

- [Browser restart semantics unverified] → spike task 0 (Chromium + Firefox, small
  `CHUNK_MS`, backgrounded-tab check) before dependent work; scope the capability if a
  browser fails.
- [Capture gap at each rollover] → same-stream immediate restart; wall-clock placement
  absorbs it; accepted.
- [Unexpected `onstop` (device loss)] → distinguished from rollover; treat as stop with
  rescue; never restart on a dead stream (D1).
- [Legacy heuristics regress for existing sessions] → characterization tests over
  today's shapes (single segment per recording, null ordinals, ordinal-less legacy
  events, missing `started_at_utc`, repeated-N cycles) before reshaping
  (`rebuildAudioClips` currently has no direct covering tests — fact-checked; the
  existing `feedRowSeek.clipLayoutParity.test.tsx` seam is updated alongside).
- [Chunks split across merge groups on codec-param change] → same stream/recorder
  settings make this near-impossible; D5's derivation doesn't rely on group contiguity.
- [Event-wall-time derivation re-places import-path segments] → gated by
  characterization fixtures pinning delta 0 on YouTube-import / local-import shapes
  BEFORE the resolver change lands (task 3.0); a nonzero fixture delta halts for an
  apply-time decision instead of silently moving existing words.
- [Lead sliver before the first chunk on new recordings (~0–2 s mic-open latency)] →
  truthfully uncovered; existing no-coverage jump behavior applies; existing sessions
  unaffected (delta 0). Accepted.
- [Lost lease mid-take (laptop sleep > 40 s)] → pre-existing; heartbeat responses are
  fire-and-forget today. Chunking strictly improves the data-loss half (pre-sleep chunks
  persisted). The spec's lease scenario asserts client behavior (claim once, heartbeat
  continuously, release once), not an unenforceable server-side continuous hold. Residual.
- [Rescue module complexity] → the module owns pure sequencing/queue/ordering with a
  clock and upload function injected; `MediaRecorder` wiring stays in the component
  (panel: keep the abstraction boundary tight).

## Migration Plan

Pure client + transcription-internals change; no schema or contract migration. Old
sessions (single segment per recording, null backfill ordinals, repeated-N cycles) remain
valid inputs to every changed consumer — covered by characterization tests. Rollback =
revert the branch.

## Open Questions

- `CHUNK_MS` final value (10 min proposed) — design-owned; gate may adjust.
- If the task-0 spike fails on Firefox (or Safari behavior is shown broken), apply halts
  and the capability's browser scope returns to the gate with the spike's results
  (gate ruling E-B, 2026-08-12: decide-if-fails; nothing pre-committed).

## Panel & review log

### 2026-08-12 — pre-panel fact-check pass (light-tier subagent, main @ 4e8e146)

14 stated claims checked, **14 confirmed, 0 corrected, 0 left unverified** — each via
whole-function reads with quoted evidence (single-blob capture path; 50 MB cap pre/post
checks → 413; `doUpload` try/finally-no-catch silent path; 8 s heartbeat / 40 s staleness
/ no lease check on upload; `usedIv`/`usedOrd` one-per-interval sets; `resolveAnchors`
fall-through; no `recording_ordinal` uniqueness in the `session_audio_segments` DDL;
MODIFIED-requirement fidelity vs the baseline spec (all original sentences preserved, two
original scenarios verbatim); no conflicting web-session-console requirement; `s.
started_at_utc` in scope at the `SegmentAnchorInfo` construction site; meter bound to the
`MediaStream` not the recorder; waveform PUT exists and is called per-segment; `e2e`/
`e2e:visual`/`docs:check` scripts exist; no direct covering tests for
`rebuildAudioClips`). Clarifications on record: (a) for live-recorder sessions the
**greedy matcher** is the path that actually runs (`intervals.length > 0` whenever
internal Started/Stopped pairs exist); the legacy `usedOrd` path fires only for sessions
with zero parseable internal recording events — see D4 for why it is still reworked; (b)
the `session_audio_segments` DDL lives inline in `sessionCore.ts`, not migration `.sql`.
The Context section's bitrate arithmetic remains **unverified** (browser-dependent;
flagged in place).

### 2026-08-12 — adversarial panel (4 reviewers: requirements, assumptions, failure & abuse, scope), synthesis + fold-back

**Blockers/majors fixed in place** (deduped across reviewers):

1. *Recording-ordinal derivation* (blocker; req F1 / assumptions M2 / failure M7):
   `segments.length + 1` skips numbers and collides after discard while both consumer
   deltas promote `recording_ordinal` to a correctness-bearing key → new D8 + spec
   requirement with scenarios.
2. *Derivation/layout base fragile against ordering and dismissal* (assumptions M1 /
   failure M2 / req F5, F7): base pinned to lowest-ordinal member, made safe by the new
   single-flight ordered pipeline; negative deltas clamp to 0; "first" now defined
   identically in both deltas. Dismissed-base case accepted as a bounded residual (see
   escalations).
3. *No serialization/idempotency → duplicates* (failure M1 / req F5): single-flight
   pipeline requirement + ambiguous-failure dedupe by segments refetch + scenarios;
   integration task extended.
4. *Poison-pill queue head* (failure M3): failure classification (transient vs permanent),
   zero-byte skip, per-chunk rescue-only, per-chunk discard with confirm.
5. *Rescue toast unimplementable / programmatic consent* (req F4 / failure M5 / scope m4):
   dedicated persistent recorder-owned banner outside the legacy toast store; no
   auto-dismiss; `hideToast()` immune; confirm-to-discard; scenario added.
6. *Phase/heartbeat/indication coupling* (failure M4 / req F11): mid-take uploads never
   leave the `recording` phase; heartbeat/indication/overlay key off capture state; D3
   phase invariant + spec scenario.
7. *Unmount/session-switch/navigation holes* (failure M6 / req F3): module-owned queue,
   sessionId bound at recording start, leave-warning extended, "only silent-discard path"
   scoped honestly to the page lifetime; crash-loss claim corrected to include queued
   chunks.
8. *Same-N re-runs mishandled by flat ordinal grouping* (req F2 / failure M7 / assumptions
   M4): groups formed per cycle by wall-clock adjacency, FIFO per ordinal; unpaired-start
   (crash) groups never steal an interval; scenarios in both deltas.
9. *Chunk width / probe-failure coverage regression against frozen seek requirements*
   (req F6): extend-to-next-chunk width rule; coverage-by-construction scenario.
10. *Unverified browser premise built on last* (scope M1 / assumptions M3): task-0 spike
    (Chromium + Firefox, backgrounded tab) before dependent tasks; unexpected-`onstop`
    handling added to D1.
11. *Spec pinned implementation detail* (scope M2): `CHUNK_MS` value, rescue filename
    template, and the stop/restart mechanism sentence moved from normative spec text to
    design ownership; filename spec'd as filesystem-safe with container-derived extension
    (Safari `audio/mp4`).

**Escalated to the gate** (ruled 2026-08-12; gate passed with these dispositions):

- E-A: *Dismissed-base residual* — **gate ordered the hardening**: every member derives
  from the anchor event's wall time (placement independent of surviving siblings),
  with characterization fixtures pinning delta 0 on existing live + import shapes before
  the resolver change lands (D5, task 3.0). The lowest-ordinal-base variant survives only
  as the unparseable-event-wall-time fallback.
- E-B: *Browser scope* — **gate chose decide-if-fails**: a Firefox spike failure halts
  apply at task 0 and returns to the gate with results; nothing pre-committed. (Resolved
  2026-08-12: spike PASSED both browsers; no scoping needed.)
- U3-halt (2026-08-12): task 3.0's delta-0 gate fired — import paths stamp their
  synthesized Started event after the segment (`anchorImportedTake` fresh-`now()`), so
  the E-A identity fails structurally there (clamp masks it today). **Ruling: thread the
  anchor (D9)** — `anchorImportedTake` carries the segment's `startedAtUtc` into the
  event's wall time; historical rows pinned safe via the clamp; scope amendment to the
  proposal's server-impact line recorded. Alternatives (pin-the-clamp, multi-member-only
  formula) rejected — see D9.

### 2026-08-12 — consistency read after panel fold-back (light-tier subagent)

Read all six documents (proposal, design, three delta specs, tasks). **One finding,
fixed:** the proposal's Capabilities summary still called the rescue surface a "toast"
(stale pre-panel language) — reworded to the dedicated persistent rescue surface.
Everything else clean: group/base/same-N/clamp/null-ordinal definitions verbatim-
consistent across both consumer deltas; MODIFIED header matches the baseline exactly; no
normative `CHUNK_MS`/filename-template text survives in spec files; crash-loss claims
consistent; E-A/E-B escalations present as open items; all D-number and task references
resolve; every spec scenario has a covering task.

### 2026-08-12 — consistency read after the D9 (U3-halt) fold-back (light-tier subagent)

Read all six change documents plus the halt report. **Clean** — no stale zero-server-
change or pre-halt pinning language; D9 constraints stated consistently across proposal/
design/transcript delta; task 3.0's amendment matches D9 and stays disjoint from 3.1/3.2;
Panel-log entry matches the ruling; all D9 and `.apply/u3-halt-report.md` references
resolve.

### 2026-08-12 — post-gate consistency read (light-tier subagent)

Read all six documents after the E-A/E-B rulings were folded back. **Clean** — no stale
pre-ruling language (the base-relative rule survives only as the spec'd fallback), both
consumer deltas state the identical formula/clamp/fallbacks, the log's escalation entries
match the actual rulings, task 3.0 precedes the resolver work, and all
D-number/task/scenario cross-references resolve.

### 2026-08-13 — whole-branch layered audit + fix wave

Audit (all mandatory layers; gates re-run independently) found **1 major + 4 minors →
fix wave `0b7d13d`**, then merge-ready. MAJOR: the clip-layout reshape dropped the
pre-change `max(intervalEnd, startSec + probedDuration)` over-run floor (real for
paused-transport recordings), contradicting the delta spec's pre-change-identity clause —
fixed by restoring the floor on the last placed member, amending the spec's width
sentence to match, and pinning `d > span` cases (a pre-existing pin's expected value
corrected as a direct consequence, documented in place). Minors fixed: mislabeled
"legacy path" characterization titles; stale `generateTranscript.ts` comment; the
negative-delta-through-resolver fixture the task-3.0 TODO promised; proposal
contract-impact amended to name the Stopped event's re-sourced wall time. Verified clean
with affirmative evidence: frozen contract untouched beyond recorded D9 data values (full
server diff read); all five declared seams hold at every enumerated call site; all
transcript-delta scenarios and all but one console scenario test-mapped (the feed-jump-
into-follow-on-chunk scenario is manual-verified only — recorded residual); tree hygiene
clean; build/typecheck/test re-run green; artifacts truthful on spot-check. Residual
register (ledger): F6 events-page ordinal blind spot; pre-existing session-switch
retargeting of Stopped-event/lease hooks; ended_at/Stopped-event ms divergence; banner
construction-order fragility (loud-failure by design); CHUNK_MS injection seam
unreachable in built bundles; the manual-only playback scenario. Post-wave gates:
typecheck, full tests, e2e 20/20, e2e:visual 44/44 (baselines untouched),
`docs:check`, `openspec validate --strict` — all green.

**Minors accepted as residual or fixed as text:**

- Lost-lease-mid-take overlap (pre-existing; spec scenario reworded to client behavior) —
  residual. — Memory during a long outage ≈ whole take (never worse than today) —
  residual, noted in D6. — Enrichment inherits derivation via the shared chain — design
  note + spec scenario + test added (req F10). — WS emission-timing rationale added to
  the proposal's contract-impact section (req F12). — `started_at_utc` = actual capture
  start (assumptions m6) — folded into D3. — Null-ordinal singleton grouping pinned
  (assumptions m10) — folded into both deltas + characterization tests. — Memory-SHALL
  carve-out for the rescue queue (req F9) — folded. — Object-URL revocation + filename
  hygiene (failure m9) — folded into D6. — Chain edge case: unresolved base ⇒ members
  anchorless (req F8a) — folded into the transcript delta. — 4.1 module scope kept to
  pure sequencing (scope m6) — folded into D6/risks.
