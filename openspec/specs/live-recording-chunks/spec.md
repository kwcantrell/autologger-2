# live-recording-chunks Specification

## Purpose
TBD - created by archiving change chunked-live-recording. Update Purpose after archive.
## Requirements


### Requirement: Chunk rollover bounds capture memory and upload size

While a local recording is active, the recorder SHALL roll the capture over on a fixed
cadence chosen so that every chunk stays far below the 50 MB live segment cap and a crash
loses a bounded amount of audio (design D2 owns the constant; the microphone stream and
level meter stay live across the boundary). Each completed chunk SHALL be a
self-contained playable container file, submitted to the upload pipeline (see the
single-flight requirement) for the existing `POST /api/sessions/:sessionId/audio/segments`
endpoint as its own segment carrying the recording's `recording_ordinal` and the chunk's
own wall-clock `started_at_utc`/`ended_at_utc` window, where `started_at_utc` reflects
when that chunk's capture actually began (not lease-claim time). A zero-byte chunk SHALL
be skipped, never uploaded or queued (the server 400s empty payloads). The recorder SHALL
NOT accumulate more than the in-progress chunk's data in memory, other than rescue-queued
chunks awaiting retry. After each successful chunk upload the recorder SHALL compute and
upload that chunk's waveform peaks via the existing per-segment waveform endpoint,
best-effort (a waveform failure never fails the chunk).

#### Scenario: A long take produces multiple under-cap segments
- **WHEN** a local recording runs for three-and-a-half rollover cadences and is stopped
- **THEN** four segments exist for that recording (three rollover chunks and the final
  chunk), each an independently playable file, and no upload exceeded the 50 MB live
  segment cap

#### Scenario: A crash mid-take loses only unpersisted chunks
- **WHEN** the browser tab is killed two-and-a-half cadences into a recording with no
  pending upload failures
- **THEN** the two chunks completed at the first two rollover boundaries are already
  persisted as segments on the server

#### Scenario: Each chunk gets its own waveform
- **WHEN** a two-chunk recording completes with both uploads succeeding
- **THEN** both segments carry waveform peaks computed from their own chunk's audio


### Requirement: Recording ordinals derive from prior recordings, never segment counts

A new recording's ordinal (the `N` in `Recording N Started/Stopped` and the uploaded
`recording_ordinal`) SHALL be strictly greater than every recording ordinal previously
used in the session, derived from persisted per-recording state (the maximum existing
`recording_ordinal` across segments and the maximum `N` across `Recording N
Started/Stopped` internal events, plus any ordinal held by not-yet-uploaded rescue-queued
chunks) — never from the count of segments. Consecutive recordings SHALL number
consecutively regardless of how many chunk segments each produced.

#### Scenario: Multi-chunk recordings do not skip recording numbers
- **WHEN** a four-chunk recording completes and the user starts another recording
- **THEN** the second recording logs `Recording 2 Started` and uploads
  `recording_ordinal = 2`

#### Scenario: A fully-discarded recording does not cause ordinal reuse
- **WHEN** every chunk of recording 1 fails to upload and the user explicitly discards
  them, then starts a new recording
- **THEN** the new recording uses ordinal 2 (the `Recording 1` events exist), never
  reusing ordinal 1


### Requirement: One lease and one event pair per recording

Chunk boundaries SHALL be invisible outside the recorder: the client claims the recording
lease once before capture starts, heartbeats it on the existing cadence for the whole
take, and releases it once after the final chunk's capture stops; exactly one
`Recording N Started` / `Recording N Stopped` internal event pair is logged per recording
regardless of chunk count. Mid-take chunk uploads SHALL NOT change the recorder's
recording phase, interrupt heartbeats, or alter phase-derived UI (recording indication,
duration counter, save overlay) — the full-screen saving presentation appears only for
the final drain after capture stops. The HTTP/WS surface SHALL be unchanged (existing
endpoints, statuses, shapes only).

#### Scenario: A three-chunk recording logs one Started/Stopped pair
- **WHEN** a recording rolls over twice before stopping
- **THEN** the event feed contains exactly one `Recording N Started` and one
  `Recording N Stopped` for it, and the client sent lease heartbeats continuously from
  claim to the final stop without a mid-take release

#### Scenario: Mid-take uploads do not disturb the recording indication
- **WHEN** a rollover chunk uploads while capture continues
- **THEN** the recording indication and duration counter stay lit, heartbeats continue,
  and no full-screen saving overlay appears


### Requirement: Chunk uploads are single-flight and ordered

All chunk uploads for a recording — fresh rollover chunks, rescue retries, and the final
chunk — SHALL flow through one single-flight pipeline in capture order: a later chunk's
upload never starts before every earlier chunk's outcome (success, or classified-permanent
failure set aside for rescue) is known, and concurrent drain triggers (a rollover
boundary, the user's Retry, the final stop) SHALL NOT produce overlapping upload attempts.
A chunk leaves the queue only on confirmed success. Before re-attempting a chunk whose
prior attempt failed ambiguously (a network-level failure after the request may have been
sent), the client SHALL refetch the segments list and treat an existing segment with the
same `recording_ordinal` and `started_at_utc` as that chunk's success, so a lost response
never duplicates audio.

#### Scenario: Retry racing a rollover boundary does not double-upload
- **WHEN** the user clicks Retry moments before a rollover boundary's automatic
  re-attempt fires
- **THEN** each queued chunk is uploaded at most once and exactly one segment exists per
  chunk

#### Scenario: A slow upload defers the next chunk, preserving order
- **WHEN** chunk k's upload is still in flight when the next rollover boundary completes
  chunk k+1
- **THEN** chunk k+1 waits for chunk k's outcome, so server-assigned segment ordinals
  match capture order

#### Scenario: A lost response does not duplicate a chunk
- **WHEN** a chunk's upload request reaches the server but the response is lost, and the
  chunk is retried
- **THEN** the client detects the already-persisted segment (same `recording_ordinal` and
  `started_at_utc`) and treats the chunk as uploaded, creating no duplicate


### Requirement: Upload failure is surfaced and recoverable

A failed chunk upload SHALL never silently discard audio while the page lives. Failures
surface on a dedicated, recorder-owned rescue surface that is persistent — never
auto-dismissed, never dismissed by the legacy toast store's clearing paths — showing the
failure (including the server's `detail` when present) and offering **Retry** (pumps the
single-flight pipeline) and per-chunk **Download** (a filesystem-safe filename identifying
the session, recording ordinal, chunk index, and chunk start time, with an extension
matching the blob's actual container type). Failures SHALL be classified: transient
failures (network errors, 5xx, 408, 429) stay queued and are re-attempted at each chunk
boundary and at the final stop; permanent failures (other 4xx) are set aside as
rescue-only (Download/discard) and SHALL NOT block later chunks from draining. A
mid-recording failure SHALL NOT stop the recording. Discard SHALL require an explicit
confirmation that names the amount of audio being discarded; no timeout, auto-dismiss, or
programmatic toast-clearing path may discard. The recorder SHALL reach its idle state
(permitting a new recording) only after the rescue queue drains or the user explicitly
discards its remainder.

#### Scenario: Mid-recording upload failure does not interrupt capture
- **WHEN** chunk 2's upload fails transiently while recording continues
- **THEN** the rescue surface appears, recording is uninterrupted, and chunk 2 is
  re-attempted at the next rollover boundary before that boundary's own chunk

#### Scenario: Final upload failure offers retry and local download
- **WHEN** the final chunk's upload fails after the user stops the recording
- **THEN** the blob is retained, Retry re-attempts the upload, Download saves the chunk
  locally, and the recorder does not report success or return to idle

#### Scenario: A permanently-failing chunk cannot hold later chunks hostage
- **WHEN** a queued chunk fails with a permanent (4xx) rejection while later chunks are
  queued behind it
- **THEN** that chunk moves to rescue-only (its Download and discard remain available)
  and the later chunks drain normally

#### Scenario: The rescue surface outlives transient UI
- **WHEN** the rescue surface has been showing for several minutes while other toasts and
  overlays come and go
- **THEN** it is still present with its chunks intact — no auto-dismiss timer, overlay
  transition, or `hideToast()`-style clearing removed it

#### Scenario: Discard is explicit and informed
- **WHEN** the user activates the rescue surface's discard control with two chunks queued
- **THEN** a confirmation naming the amount of audio (e.g. its duration or chunk count)
  must be accepted before the chunks are discarded, and this confirmed path is the only
  in-page way an un-uploaded chunk is ever discarded


### Requirement: Rescue and uploads are bound to their recording's session and survive component lifecycle

Chunk uploads and the rescue queue SHALL bind to the session id captured when the
recording started, and the queue SHALL live outside the recorder component's lifecycle,
so switching the workspace to another session (the recorder is not remounted per session)
or unmounting the recorder mid-drain neither retargets uploads at the wrong session nor
silently discards queued chunks. The page-leave warning SHALL cover, in addition to
active recording, any state with a non-empty rescue queue or an in-flight chunk upload.
(A full page unload after the warning still loses unsent chunks — an accepted, disclosed
limit, per the proposal's Non-Goals.)

That coverage is unchanged. What is now additionally required is the **attachment
discipline** behind it, which is user-observable in a new way. A registered `beforeunload`
listener disqualifies the page from the back/forward cache on its **mere presence** — the
browser never inspects whether the handler would actually warn — so registering one at module
scope, for the lifetime of the tab, cost every route a restored-from-bfcache navigation,
including the overwhelmingly common case where nothing has ever been recorded.

Therefore:

- **The page SHALL remain bfcache-eligible while there is nothing to lose.** No
  `beforeunload` listener SHALL be registered by the chunk machinery while the rescue queue
  is empty and no upload is in flight — including before any recording has ever started, when
  the queue singleton does not yet exist. The leave-warning module SHALL reach the queue
  through a peek/creation seam that never constructs the singleton itself.
- **The listener SHALL be attached synchronously with the enqueue that creates the risk.**
  The module SHALL subscribe to the queue and attach on any snapshot with a non-empty chunk
  list or an in-flight upload; because the queue notifies its subscribers synchronously from
  inside `enqueue()` (and from every other mutation point), the listener is armed in the same
  turn as the chunk landing in the queue. There SHALL be no window in which a chunk exists
  unwarned. The handler SHALL still re-read the live snapshot when it fires, as race defense.
- **The listener SHALL be removed when the queue drains**, restoring bfcache eligibility.
  Attach and detach SHALL both be idempotent, so a repeated non-empty snapshot cannot stack a
  second listener and a repeated drain cannot double-remove.
- **`AudioRecorder`'s own leave guard SHALL be likewise scoped**: its `beforeunload` listener
  is registered only for the span of an actual recording (`phase === 'recording'`), not for the
  component's whole mount. Gating the registration, not merely the handler body, is what keeps
  an idle session page bfcache-eligible.

Multiple `beforeunload` listeners compose — each gets its own chance to `preventDefault()` — so
the recorder's guard and the queue's guard coexist without either needing to know about the
other.

#### Scenario: Session switch mid-recording does not retarget uploads
- **WHEN** the user switches the workspace to a different session while a recording with
  pending chunk uploads is active
- **THEN** every chunk (including later rollovers of that recording) uploads to the
  session where the recording started

#### Scenario: Closing the tab with queued chunks warns first
- **WHEN** the user closes the tab after stopping a recording whose rescue queue is
  non-empty
- **THEN** the browser's leave warning fires (the same guard as leaving mid-recording)

#### Scenario: An idle app registers no leave listener
- **WHEN** the app is loaded on any route and nothing has been recorded — no chunk is queued
  and no upload is in flight
- **THEN** no `beforeunload` listener is registered by the chunk machinery or by the recorder,
  and the page stays eligible for the back/forward cache

#### Scenario: Enqueuing a chunk arms the warning in the same turn
- **WHEN** a chunk is enqueued
- **THEN** the `beforeunload` listener is registered synchronously with that enqueue, with no
  intervening turn in which the chunk is queued but the warning is not armed

#### Scenario: Draining the queue disarms the warning
- **WHEN** the last queued chunk finishes uploading and no upload remains in flight
- **THEN** the `beforeunload` listener is removed and the page is bfcache-eligible again
