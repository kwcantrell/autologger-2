# Tasks — chunked-live-recording

*file:line anchors below are orientation only — locate code by content before editing.*

## 0. Browser-premise spike (before anything is built on D1)

- [x] 0.1 Spike: dev run with a small `CHUNK_MS` (~5 s) prototyping stop + immediate
  restart of `MediaRecorder` on the same `MediaStream`, on Chromium AND Firefox. Verify:
  each chunk uploads as an independently playable segment (plays back, duration-probes,
  `decodeAudioData` succeeds), the meter stays live across the boundary, the gap is
  small (eyeball ≤ ~100 ms), and rollover still fires in a backgrounded tab. Record the
  results in design.md (D1). If a browser fails, STOP and escalate the capability's
  browser scope to the gate (design Open Questions) before continuing.

## 1. Characterization guard for clip layout

- [x] 1.1 Add characterization tests for `rebuildAudioClips` /
  `matchAudioSegmentsToIntervalsGreedy` / the legacy ordinal path
  (`web/src/shared/utils/audioClips.ts`) pinning today's behavior for: one segment per
  recording, null `recording_ordinal` segments (sync-from-disk shape), legacy
  ordinal-less events, repeated-N cycles (two `Recording 2` blocks), segments with
  missing `started_at_utc` (placeholder + end-chaining), and probe-failure durations.
  These pin the "single-segment sessions are unchanged" scenario before any reshape.
  Gate: `npm run typecheck` + `npm test`.

## 2. Multi-chunk clip layout (web)

- [x] 2.1 Reshape interval matching to chunk groups per design D4 / the
  web-session-console delta: one interval per same-`recording_ordinal` group (null
  ordinals stay singletons), same-N cycles split by wall-clock adjacency (FIFO per
  ordinal), unpaired-start (crash) groups never consume another recording's interval,
  placement event-wall-time derived per gate ruling E-A (chunk k at interval start +
  clamped delta from the start event's wall time; fallbacks per the delta spec), each
  chunk extended to the next chunk's position (last chunk to interval end — probe
  failures inherit the span). Applies to both the greedy matcher and the legacy `usedOrd`
  path (crash-survivor sessions reach the legacy path — D4 records why). TDD with new
  multi-chunk layout tests (three-chunk interval, same-N re-run, crashed recording,
  discarded-first-chunk survivor placement, probe-failure coverage); update
  `feedRowSeek.clipLayoutParity.test.tsx` alongside. Gate: `npm run typecheck` +
  `npm test`.

## 3. Transcript anchor derivation (packages/transcription)

- [x] 3.0 (amended by the U3-halt ruling — design D9; the original halt fired 2026-08-12,
  see `.apply/u3-halt-report.md`) Thread the import anchor and pin the E-A identity:
  (a) `SessionHub.anchorImportedTake` gains the take's `startedAtUtc` (threaded from both
  import handlers in `server/src/routers/sessions.ts`, which already compute it) and
  stamps the synthesized `Recording N Started` event's **wall time** with it — WITHOUT
  disturbing the event's timecode anchoring (`timecode_total_frames` stays the transport
  position per the `youtube-audio-import` spec; read `EventStore.addEvent` fully to keep
  wall-time and timecode sources independent). (b) Fixtures/tests pinning: live path
  identity (event wall time == segment `started_at_utc` when the client sends the same
  timestamp); import paths delta-0 by construction post-threading (both YouTube and
  local/batch int tests); historical negative-delta rows floor to 0 under `max(0, ·)`
  (unit fixture). Gate: `npm run typecheck` + `npm test`.
- [x] 3.1 Add nullable `startedAtUtc` to `SegmentAnchorInfo` and the event wall time to
  `AnchorCandidateEvent`; thread both from `AudioSegmentMeta` / events through
  `generateTranscriptWords`. Typecheck-only change plus existing suites. Gate:
  `npm run typecheck` + `npm test`.
- [x] 3.2 Implement chunk-group anchor resolution in `resolveAnchors`
  (`packages/transcription/src/transcriptRemap.ts`) per design D5 / the delta spec:
  groups by `recording_ordinal` (same-N cycles split by nearest-preceding event wall
  time), base-only step-1 claiming and index pairing, every member's anchor
  event-wall-time derived `A + max(0, (started_at(member) − wallTime(event))/1000)` with
  the spec'd fallbacks (unparseable event wall time → base-relative; singleton-null →
  `A`; else anchorless). TDD in `transcriptRemap.test.ts`: chunked-recording placement,
  discarded-first-chunk survivor placement, existing-single-segment identity (delta-0),
  missing-timestamp anchorless case, same-N re-run separation, unresolved-base case,
  chunked ≡ unchunked placement (including a paused-transport fixture), an
  enrichment-inherits-derivation case, and no-regression cases for the existing
  scenarios. Gate: `npm run typecheck` + `npm test`.

## 4. Recorder chunk pipeline (web)

- [x] 4.1 Build the recorder-owned chunk-pipeline module (outside the component
  lifecycle): single-flight in-order upload chain (boundary/Retry/final-stop triggers
  pump one pipeline, no overlapping attempts), rescue queue with failure classification
  (transient re-queued; permanent 4xx set aside as rescue-only; zero-byte chunks
  skipped), ambiguous-failure dedupe hook (refetch segments, match
  `recording_ordinal` + `started_at_utc`), sessionId bound at recording start,
  drain/discard semantics. Pure logic with clock + upload function injected —
  `MediaRecorder` wiring stays out (design D6). Unit tests: ordering under slow uploads,
  Retry-vs-boundary race, poison-pill drain-past, dedupe, discard consent. Gate:
  `npm run typecheck` + `npm test`.
- [x] 4.2 Wire `AudioRecorder.tsx` to the module: stop/restart `MediaRecorder` on the
  same `MediaStream` every `CHUNK_MS` (design D1/D2), per-chunk
  `started_at_utc`/`ended_at_utc` at actual capture boundaries (design D3), recording
  ordinal derived per design D8 (max across segment `recording_ordinal`s, parsed
  `Recording N` events, and queued chunks — never `segments.length + 1`), one lease +
  one event pair per recording, waveform peaks per chunk, unexpected-`onstop`
  treated as stop (never restart on a dead stream). Phase invariants (design D3):
  mid-take uploads never leave the `recording` phase; heartbeat, recording indication,
  and save overlay key off capture state; `DONE` reachable only from stopped;
  `timeline-audio-seek-overlay` toggling stays out of the mid-take path. Reducer gains
  explicit rollover/drain states. Component tests where practical
  (`AudioRecorder.meter.test.tsx` shows the pattern) — heartbeat-across-rollover and
  ordinal-derivation cases included. Gate: `npm run typecheck` + `npm test`.

## 5. Rescue surface (web)

- [x] 5.1 Build the dedicated recorder-owned rescue surface (NOT the legacy toast store —
  design D6): persistent banner listing failed chunks with per-chunk Download
  (filesystem-safe filename, extension from the blob's actual container type, object URL
  revoked after use) and a Retry that pumps the pipeline; discard only via an explicit
  confirmation naming the amount discarded; immune to `hideToast()`/auto-dismiss (test
  the `AudioSaveOverlay` `hideToast` interaction explicitly); survives recorder unmount
  (module-owned state). Extend the `beforeunload` guard to queue-non-empty / in-flight.
  Unit tests: dismissal-is-consent path, persistence across overlay transitions, leave
  warning coverage. Gate: `npm run typecheck` + `npm test`.

## 6. Integration confirmation (server, no server code changes)

- [x] 6.1 Integration test: two `POST …/audio/segments` uploads sharing
  `recording_ordinal` with distinct wall windows → segments list returns both with
  correct metadata and capture-ordered ordinals; plus the duplicate-detection premise —
  a re-upload with identical `recording_ordinal` + `started_at_utc` is distinguishable
  via the segments list (documents the client dedupe contract; the server itself stays
  unchanged). Gate: `npm run typecheck` + `npm test`.

## 7. Final gates

- [x] 7.1 Manual verification: dev run with a small `CHUNK_MS` — chunks appear as
  segments during recording; kill the tab mid-recording and confirm completed chunks
  survived and lay out correctly (crash → legacy-path case); stop the server to force
  failures and exercise transient retry, permanent set-aside, Retry, Download, and the
  discard confirm; confirm recording numbers stay consecutive across multi-chunk
  recordings.
- [x] 7.2 Full gates: `npm run typecheck`, `npm test`, `npm run e2e` (chromium +
  login-gate) AND `npm run e2e:visual` (the rescue surface is new UI — re-bless any
  legitimately-changed baselines in this branch's diff), and root `npm run docs:check`.
  Attach the new `live-recording-chunks` capability in `web-docs/model/components.ts` at
  archive time.
