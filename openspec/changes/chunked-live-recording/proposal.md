# Chunked live recording

## Why

Live recordings longer than roughly an hour silently fail to save: the recorder holds the
whole take in browser memory and uploads it as one blob on stop, the server caps live
segment uploads at 50 MB (413), and the upload path has no error handling — the failure is
invisible and the audio is unrecoverable. Long sessions are a primary use case (podcast /
show logging), so this is data loss on the main workflow.

## What Changes

- **Recorder chunk rollover (web):** `AudioRecorder` stops and immediately restarts
  `MediaRecorder` on the same `MediaStream` every ~10 minutes, uploading each completed
  chunk immediately as its own audio segment (same `recording_ordinal`, per-chunk
  `started_at_utc`/`ended_at_utc`). One `Recording N Started`/`Stopped` event pair and one
  lease per recording, exactly as today — chunk boundaries are invisible to the event feed.
  Bounded client memory; every upload stays far under the 50 MB cap; a tab crash loses
  only the chunks not yet persisted (the in-flight chunk plus any rescue-queued ones)
  instead of the whole take.
- **Single-flight ordered upload pipeline (web):** every chunk upload — fresh, retried, or
  final — flows through one in-order pipeline (no overlapping attempts, capture order
  preserved so server segment ordinals stay meaningful), with lost-response dedupe against
  the segments list so retries never duplicate audio.
- **Recording-ordinal derivation fix (web):** the next recording's number derives from the
  prior recordings (max existing `recording_ordinal`/event `N` + 1), no longer from the
  segment count — multi-chunk recordings would otherwise skip numbers (1, 5, 9, …) and a
  fully-discarded recording would reuse its ordinal.
- **Upload-failure rescue (web):** failures surface on a dedicated persistent rescue
  surface (the legacy toast store auto-dismisses and can be cleared programmatically) —
  blobs retained, per-chunk Retry/Download, transient failures retried at chunk
  boundaries without stopping the recording, permanent failures set aside so they never
  block later chunks, and discard only via an explicit confirmation. No more silent
  discard within the page's lifetime.
- **Timeline clip layout (web):** the clip-matching pipeline (`rebuildAudioClips`) learns
  chunk groups — one recording interval per same-`recording_ordinal` group (same-N re-run
  cycles split by wall-clock adjacency), follow-on chunks placed by wall-clock delta and
  extended to the next chunk so intervals stay covered even on probe failure — today's
  greedy matcher would scatter follow-on chunks across other intervals or chain them at
  the timeline end.
- **Transcript anchor derivation (server/transcription):** the anchor chain in
  `resolveAnchors` learns chunk-group derivation — a group's base claims the recording's
  anchor, and every member places at `anchor + max(0, its started_at_utc − the anchor
  event's wall time)` (gate ruling E-A: placement independent of which chunks survived,
  provably delta-0 on existing data) — so chunk 2+'s words land at their true
  session-timeline position instead of falling through to index-pairing against other
  recordings' anchors (misplacement) or anchorless.
- **Import anchors thread the segment's wall time (server, U3-halt ruling / design D9):**
  `SessionHub.anchorImportedTake` (YouTube + local/batch import) stamps the synthesized
  `Recording N Started` event's wall time with the take's own `startedAtUtc` instead of a
  post-upload `Clock.now()`, so the E-A delta-0 identity holds by construction for
  imports too; timecode anchoring (the spec'd transport-position anchor) is untouched,
  and historical rows are clamp-floored to identical placement (fixture-pinned).
- **No server HTTP-surface changes.** `MAX_AUDIO_BYTES` stays 50 MB; the segment upload/
  list/download endpoints, statuses, and JSON shapes are untouched — the only server
  change is the D9 wall-time data source above, inside the hub's composite RPC.

## Capabilities

### New Capabilities

- `live-recording-chunks`: the live recorder's chunk-rollover behavior (rollover cadence,
  per-chunk segment metadata, single lease/event pair per recording, ordinal derivation,
  single-flight upload pipeline) and the upload-failure rescue UX (dedicated persistent
  rescue surface, retained blobs, retry, local download).

### Modified Capabilities

- `transcript-generation`: the "Timeline remapping of word timestamps" anchor chain gains
  a derived-anchor step for follow-on segments that share a `recording_ordinal` with an
  already-anchored segment.
- `web-session-console`: timeline clip layout requirement extended — a recording interval
  may contain multiple chunk segments positioned contiguously within it (feed-row seek and
  scrub behavior unchanged).

## Non-Goals

- Raising or restructuring the 50 MB live upload cap, or any server-side streaming upload
  work — chunks make the cap moot for live recording.
- Changing batch/local audio import, YouTube import, or their higher caps.
- Merging chunk segments back into one file at rest (transcription's `mergeAudioSegments`
  already concatenates same-codec runs for DeepGram; storage keeps per-chunk files).
- Retrying uploads across page reloads / persisting unsent chunks to IndexedDB — the rescue
  path is in-page (toast, retry, download); a reload still loses unsent chunks.
- Multi-client or resumable recording.

## Contract impact

**None intended.** The frozen HTTP/WS surface is untouched: same endpoints, same status
codes (uploads stay under the existing 50 MB cap), same JSON shapes (the segments list has
always been an array; multiple segments per recording already occur via sync-from-disk
backfill and legacy data). The `Recording N Started/Stopped` internal event pattern is
unchanged. Other connected clients will observe `audio.changed` broadcasts and a growing
segments list *during* a recording rather than once at stop — that is client-call-pattern
timing, not a change to the server's per-request behavior or WS emission semantics, so no
freeze delta is required for it. The D9 import-anchor threading changes one **data
value** on future imports (the synthesized Started event's `wall_time_utc` becomes the
take's `startedAtUtc` rather than a post-upload clock read) — shapes, status codes,
atomicity, and WS emission semantics are unchanged, and neither the
`youtube-audio-import` nor `batch-audio-import` spec constrains that wall-time source
(both pin the timecode anchor, which is untouched) — so no freeze or import-spec delta is
required for it either. The synthesized `Recording N Stopped` event's `wall_time_utc` is
likewise re-sourced, from `startedAtUtc + durationS` instead of a second independent
fresh clock read (`SessionHub.anchorImportedTake`, D9) — covered by the same
no-spec-constrains-the-source reasoning, since neither import spec pins that value
either. If design review finds any observable HTTP/WS change is unavoidable, this change
must gain an `api-contract-freeze` delta before apply.

## Impact

- `web/src/pages/index/components/AudioRecorder.tsx` — chunk rollover, ordinal
  derivation, phase invariants; plus a new recorder-owned chunk-pipeline module (queue,
  single-flight ordering, rescue state) and a dedicated rescue-surface component (the
  legacy `Toast.tsx` is not extended).
- `web/src/shared/utils/audioClips.ts` (+ `useAudioClips`,
  `feedRowSeek.clipLayoutParity.test.tsx`) — chunk-group clip layout.
- `packages/transcription/src/transcriptRemap.ts` — group-based derivation in the anchor
  chain; `SegmentAnchorInfo` gains the segment's `started_at_utc`;
  `AnchorCandidateEvent` gains the event's wall time (same-N cycle adjacency).
- `packages/transcription/src/generateTranscript.ts` — passes the new fields through.
- `packages/session-core/src/SessionHub.ts` (`anchorImportedTake`) +
  `server/src/routers/sessions.ts` (both import handlers) — D9 wall-time threading.
- Tests across `web/` unit, `packages/transcription` unit, `server/` integration.
