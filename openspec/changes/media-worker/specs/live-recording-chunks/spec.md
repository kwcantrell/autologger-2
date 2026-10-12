## MODIFIED Requirements

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
start the capture with a short timeslice (design D10 owns the constant, 5 s) and append each
delivered slice to the chunk's entry in local storage ("Finished chunks are persisted locally
until the server confirms them"), so that the in-progress chunk's data is on disk within one
slice and the recorder holds at most the slices not yet written in memory; the concatenated
slices SHALL be the same bytes as a chunk recorded without a timeslice (a browser whose
slices do not concatenate, if the spike finds one, records that chunk without a timeslice
and persists it only when complete). The recorder SHALL NOT compute or upload waveform peaks
for its chunks: the server computes every new segment's peaks and duration
(media-processing "Every new segment is probed, given peaks and normalised on ingest").

#### Scenario: A long take produces multiple under-cap segments
- **WHEN** a local recording runs for three-and-a-half rollover cadences and is stopped
- **THEN** four segments exist for that recording (three rollover chunks and the final
  chunk), each an independently playable file, and no upload exceeded the 50 MB live
  segment cap

#### Scenario: A crash mid-take loses only unpersisted chunks
- **WHEN** the browser tab is killed two-and-a-half cadences into a recording with no
  pending upload failures
- **THEN** the two chunks completed at the first two rollover boundaries are already
  persisted as segments on the server, and the in-progress chunk is in local storage up to
  its last delivered slice, so no more than one slice of audio is unpersisted

#### Scenario: Each chunk gets its own waveform
- **WHEN** a two-chunk recording completes with both uploads succeeding
- **THEN** both segments receive waveform peaks computed from their own chunk's audio by
  the server's ingest processing, together with `duration_ms`, and the client sent no
  `PUT …/waveform`

### Requirement: Upload failure is surfaced and recoverable

A failed chunk upload SHALL never silently discard audio while the page lives. Failures
surface on a dedicated, recorder-owned rescue surface that is persistent — never
auto-dismissed, never dismissed by the legacy toast store's clearing paths — showing the
failure (including the server's `detail` when present) and offering **Retry** (pumps the
single-flight pipeline) and per-chunk **Download** (a filesystem-safe filename identifying
the session, recording ordinal, chunk index, and chunk start time, with an extension
matching the blob's actual container type). Failures SHALL be classified: transient
failures (network errors, 5xx, 408, 429) stay queued and are re-attempted automatically on
a per-chunk exponential backoff with jitter (design D11: from 2 s, doubling, capped at
5 min), as well as at each chunk boundary, at the final stop and when the browser fires
`online`; while the browser reports `offline` the automatic attempts pause and count no
attempt. Authentication failures (`401`, `403`) mark the chunk `blocked`, are not
re-attempted automatically, and the surface SHALL say that signing in again (in another
tab) and pressing Retry resumes them. A `413` (a chunk over the live cap, possible after a
throttled or re-acquired long chunk) SHALL re-send the chunk through the resumable parts
upload in segment mode instead of parking it. Permanent failures (other 4xx) are set aside as
rescue-only (Download/discard) and SHALL NOT block later chunks from draining. **Retry**
SHALL re-attempt every queued, blocked and permanent chunk once, in order (a user-initiated
attempt is never refused by classification). The automatic scheduler SHALL run on a timer
that keeps its cadence in a hidden tab. A
mid-recording failure SHALL NOT stop the recording. Discard SHALL require an explicit
confirmation that names the amount of audio being discarded; no timeout, auto-dismiss, or
programmatic toast-clearing path may discard. The recorder SHALL reach its idle state
(permitting a new recording) only after the rescue queue drains or the user explicitly
discards its remainder.

#### Scenario: Mid-recording upload failure does not interrupt capture
- **WHEN** chunk 2's upload fails transiently while recording continues
- **THEN** the rescue surface appears, recording is uninterrupted, and chunk 2 is
  re-attempted after its backoff delay (about 2 s, then 4 s, …) without waiting for the
  next rollover, and in any case at that boundary before the boundary's own chunk

#### Scenario: A lost connection resumes on reconnect
- **WHEN** the browser goes offline for twenty minutes during a recording and comes back
- **THEN** no attempt is counted while offline, the first attempt happens within a second
  of the `online` event, and the two chunks captured meanwhile upload in order

#### Scenario: A sign-in expiry is recoverable
- **WHEN** chunk 3's upload answers `401` mid-take
- **THEN** chunk 3 is marked blocked with a sign-in hint, later chunks are also blocked
  rather than discarded, capture continues, and after the user signs in elsewhere and
  presses Retry every blocked chunk uploads

#### Scenario: Retry reaches a permanently failed chunk
- **WHEN** a chunk was set aside after a `404` and the user presses Retry
- **THEN** one upload attempt is made for that chunk (it may fail again, and then stays
  rescue-only with Download and discard)

#### Scenario: An oversize chunk goes through parts
- **WHEN** a 70 MB chunk's upload answers `413`
- **THEN** the queue sends it as parts in segment mode with the same `recording_ordinal` and
  window, the resulting segment is confirmed like any other, and no chunk is parked

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
A full page unload after the warning no longer loses unsent chunks: they are in local
storage and resume on the next load ("Finished chunks are persisted locally until the
server confirms them"); the warning remains because the upload itself is interrupted.

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

## ADDED Requirements

### Requirement: Finished chunks are persisted locally until the server confirms them

Every chunk SHALL be written to browser storage as it is captured and kept there until the
server confirms it (a `2xx` from the segment upload, or the lost-response dedupe finding
its segment), the user discards it, or it is older than 30 days. Storage SHALL be the
origin-private file system written from a dedicated worker, falling back to IndexedDB when
that is unavailable, and to memory (today's behaviour) with a single visible warning when
neither works or the free quota is below twice the expected chunk size; persistence SHALL
never prevent recording. Storage SHALL be kept per signed-in user: each stored chunk SHALL
carry its metadata (user id, session id, recording ordinal, chunk index, `started_at_utc`,
`ended_at_utc`, mime type, byte count, a slice log, whether it is complete, and whether its
recording still awaits finalize and with which windows), only the current user's chunks
SHALL be listed or shown, and signing out SHALL first warn when that user has unsent chunks
and then wipe that user's chunks. Ownership across tabs SHALL be explicit: the recorder
holds a Web Lock per take and the uploader a Web Lock per chunk for the attempt's duration
(a heartbeat lease in the metadata where Web Locks are unavailable); the recovery scan
SHALL skip every chunk whose chunk lock or take lock is held, so a second tab never recovers
what the first is still recording or uploading. When the upload queue is created on a page
load it SHALL scan storage once and enqueue every unlocked stored chunk of the current user,
complete or partial, in capture order, bound to its own session; a recovered chunk SHALL
start in the ambiguous state (the segments list is checked before its first attempt, and the
server's idempotent upload is the second guard), and a partial chunk's `ended_at_utc` SHALL
be its `started_at_utc` plus the duration measured from its stored bytes (a media-element
probe, else the byte count over the slice log's rate), the metadata's last write time only as
a fallback. The rescue surface SHALL show them as recovered, with their count and
approximate duration, and offer Upload all, Download and Discard. The Record control SHALL
be disabled until the scan has completed, and the ordinal derivation SHALL count recovered
chunks' ordinals. Storage persistence SHALL be requested from the browser when a recording
starts, best effort (Safari grants it only to home-screen web apps and evicts a site's
storage after 7 days without use, so recovery on Safari is promised only within 7 days and
the rescue copy says so there). On `pagehide` the recorder SHALL request the pending slice,
best effort: with or without it, at most one slice of audio is unpersisted.

#### Scenario: A reload resumes the upload
- **WHEN** the tab is reloaded with two unsent chunks queued and a third chunk in progress
- **THEN** after the reload the rescue surface lists three recovered chunks (two complete,
  one partial), they upload in order to the recording's session, the recording is finalized
  once the last one is confirmed, and storage is empty afterwards

#### Scenario: A second tab does not recover a live take
- **WHEN** tab A is recording with one chunk uploading and tab B opens the session
- **THEN** tab B's scan skips the take's chunks (their locks are held), shows nothing to
  recover, and after tab A is killed the next scan in tab B recovers them

#### Scenario: A chunk the server already accepted is not uploaded twice
- **WHEN** the tab crashed after the server stored a chunk but before its storage entry was
  removed, and the next load recovers it
- **THEN** the segments-list check (or the server's idempotent answer) matches the window,
  the chunk is treated as confirmed and removed, and the session has one segment for it

#### Scenario: Another user's chunks stay private
- **WHEN** user B signs in on a machine where user A left unsent chunks
- **THEN** B's scan lists nothing of A's, and when A signs in again their chunks are offered;
  A signing out with unsent chunks is warned first, and after confirming, A's storage is wiped

#### Scenario: Record waits for the scan
- **WHEN** the session page loads with stored chunks of ordinal 3 and the user presses Record
  before the scan finished
- **THEN** the control is disabled until the scan completes, and the new recording then uses
  ordinal 4

#### Scenario: A partial chunk's window comes from its bytes
- **WHEN** a partial chunk is recovered whose metadata says 9 minutes but whose stored bytes
  decode to 4 minutes 50 seconds
- **THEN** it is uploaded with `ended_at_utc` 4 minutes 50 seconds after its start

#### Scenario: Confirmation clears storage
- **WHEN** a chunk's upload returns `200`
- **THEN** its stored bytes and metadata are removed before the next chunk is attempted

#### Scenario: Quota pressure degrades, never blocks
- **WHEN** the storage estimate shows less free space than two chunks' worth during a take
- **THEN** recording continues, later slices stay in memory, one warning says so, and the
  queue behaves as before this change for those chunks

#### Scenario: A browser without the file system API still persists
- **WHEN** `navigator.storage.getDirectory` or the sync access handle is unavailable
- **THEN** chunks are stored in IndexedDB with the same metadata and recovered the same way

#### Scenario: Old leftovers are cleaned up
- **WHEN** storage holds a chunk whose metadata is more than 30 days old at scan time
- **THEN** it is deleted, with a console warning naming its session and ordinal, and is not
  enqueued

### Requirement: A stopped recording is finalized

When the last chunk of a recording is confirmed by the server (no chunk of that
`recording_ordinal` remains queued, blocked or in flight), the client SHALL call
`POST /api/sessions/:sessionId/audio/recordings/:recordingOrdinal/finalize` once, listing
every chunk window it recorded for that ordinal; a `not-needed`, `queued`, `already-queued`
or `waiting` answer all count as done, and a failed call is retried with the chunk backoff
until it succeeds or the user discards the recording's remainder. The pending finalize and
its window list SHALL be persisted with the recording's chunks, so a recovery that completes
the upload later still finalizes. Finalize SHALL not change the recorder's phase or UI; the
merged segment appears through the session's `audio.changed` message like any other audio
change.

#### Scenario: Finalize follows the last confirmation
- **WHEN** a three-chunk recording's last chunk upload returns `200`
- **THEN** exactly one finalize call is sent for its ordinal, after that confirmation and
  not before

#### Scenario: A recovered upload finalizes late
- **WHEN** a recording's last chunk was recovered from storage after a reload and uploads
  successfully
- **THEN** the finalize call is sent then, with all of the recording's windows, and the
  recording ends up as one merged segment

### Requirement: A lost microphone is re-acquired

An unexpected recorder stop, an audio track ending, or a device change that removes the
active input SHALL NOT end the take. The recorder SHALL persist the chunk captured so far,
keep the take's ordinal, lease and events, and re-acquire the microphone (the previous
device first, then the default input), retrying on the chunk backoff for up to 60 seconds;
on success it SHALL start the next chunk index on the new stream, re-bind the level meter
and show a persistent notice that the microphone changed and recording continues. A rollover
boundary reached without a live track SHALL wait for the re-acquisition. Only when
re-acquisition fails for 60 seconds SHALL the take be finalized as before, naming the
reason. A device change while the current track is still live SHALL only be logged.

#### Scenario: A Bluetooth headset drops mid-take
- **WHEN** the active input's track ends during chunk 4
- **THEN** chunk 4 is persisted and queued as captured, the default microphone is acquired,
  chunk 5 starts on it within the backoff, the `Recording N` ordinal and lease are unchanged,
  and the notice names the change

#### Scenario: No microphone comes back
- **WHEN** every re-acquisition attempt fails for 60 seconds
- **THEN** the take is finalized with the reason shown, its captured chunks upload, and
  finalize lists the windows that were captured

#### Scenario: A plugged-in device does not interrupt
- **WHEN** a `devicechange` fires while the current track is still live
- **THEN** capture continues on the same track and nothing but a console line results

### Requirement: Recording keeps the screen awake and warns when hidden

While a recording is active the recorder SHALL hold a screen Wake Lock (best effort: an
unavailable or refused lock is logged once and never an error), release it when the
recording stops, and request it again when the document becomes visible after being hidden
(browsers release the lock on hide). When the document becomes hidden during a recording,
the recorder SHALL show a persistent in-page warning on return that the tab was in the
background and may have been throttled, naming the hidden interval, cleared by the next
user action; on browsers that suspend hidden capture (mobile Safari) the warning SHALL say
that capture may have paused.

#### Scenario: The screen stays awake while recording
- **WHEN** a recording starts on a browser with the Wake Lock API
- **THEN** a screen wake lock is held until the recording stops, and after the tab is hidden
  and shown again it is held again

#### Scenario: A backgrounded recording is called out
- **WHEN** the tab is hidden for three minutes during a recording and then shown
- **THEN** a persistent warning names the three-minute interval and clears on the next user
  action, and the recording itself is unaffected (its timers ran on the worker interval)

#### Scenario: No Wake Lock API is not an error
- **WHEN** a recording starts on a browser without `navigator.wakeLock`
- **THEN** recording proceeds, one console line notes the missing lock, and no toast or
  rescue entry appears
