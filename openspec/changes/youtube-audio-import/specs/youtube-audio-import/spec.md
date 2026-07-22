# youtube-audio-import — spec

## ADDED Requirements

### Requirement: Configuration gating

YouTube audio import SHALL be gated on an available `yt-dlp` binary. The gate SHALL be
satisfied by **either** an explicitly configured `yt-dlp` path **or** a bare `yt-dlp`
resolvable on the process `PATH`. Because `PATH` resolution is filesystem I/O (not a pure
config read), the binary SHALL be resolved **once at startup** into an absolute path stored
on config, and the runtime gate SHALL be a pure boolean read of that resolved value; the
request handler SHALL use the resolved absolute path rather than re-probing per request.
When neither an explicit path nor a `PATH`-resolvable binary is available, the import
endpoint SHALL behave identically to its pre-change unavailable response — "unchanged from
before" means "no `yt-dlp` available at all", not "no path variable set".

#### Scenario: No yt-dlp available is unavailable

- **WHEN** a deployment with no configured path and no `yt-dlp` on `PATH` receives
  `POST /api/sessions/:sessionId/youtube-import`
- **THEN** the response is `503 {detail}`, matching the pre-change unavailable response
  exactly, and no subprocess is spawned and no outbound request to YouTube is made

#### Scenario: Bare yt-dlp on PATH counts as configured

- **WHEN** a deployment has no explicit path variable set but `yt-dlp` was resolvable on the
  process `PATH` at startup, and it receives a valid `youtube-import` request
- **THEN** the gate treats the deployment as configured and the server proceeds to fetch
  and ingest audio rather than returning the unavailable `503`

#### Scenario: Explicit path counts as configured

- **WHEN** a deployment sets an explicit `yt-dlp` path and receives a valid
  `youtube-import` request
- **THEN** the server uses that resolved binary and proceeds to fetch and ingest audio

### Requirement: Open-network refusal

Because an import spends bandwidth and disk and reaches a third party on the operator's IP,
the endpoint SHALL refuse to import — responding `503 {detail}` — when the deployment is in
the open-network configuration the sibling outbound features (AI chat, AI v2) already refuse
in: `REQUIRE_LOGIN` disabled **and** a non-loopback bind **and** no `IP_ALLOWLIST`. This
refusal SHALL be evaluated alongside the configuration gate, before any URL validation or
subprocess spawn.

#### Scenario: Open-network deployment refuses import

- **WHEN** a deployment with `REQUIRE_LOGIN` disabled, a non-loopback bind, and no
  `IP_ALLOWLIST` receives a `youtube-import` request (even with `yt-dlp` configured)
- **THEN** the response is `503 {detail}` and no subprocess is spawned, matching the refusal
  the AI chat / AI v2 endpoints apply in the same configuration

#### Scenario: Loopback or authenticated deployment is not refused on this basis

- **WHEN** a deployment is loopback-bound, or requires login, or sets an `IP_ALLOWLIST`
- **THEN** the open-network refusal does not apply and the request proceeds to the normal
  gate/validation flow

### Requirement: Request and URL validation

The endpoint SHALL require an existing, accessible session (the existing `requireSession`
behavior) and SHALL validate the request body as `{ url: string, use_publish_date: boolean }`.
The `url` SHALL be parsed with a URL parser and rejected unless it is an `http(s)` URL whose
lowercased `hostname` is an **exact** member of the enumerated YouTube allowlist:
`youtube.com`, `www.youtube.com`, `m.youtube.com`, `music.youtube.com`, `youtu.be`,
`youtube-nocookie.com`. A substring/suffix match SHALL NOT be used (it is bypassable by
hosts like `youtube.com.evil.com`). A rejected URL SHALL NOT cause any subprocess spawn or
outbound request.

#### Scenario: youtu.be share link is accepted

- **WHEN** a configured deployment receives a request whose `url` host is `youtu.be` (the
  default YouTube share link)
- **THEN** the URL passes validation and the import proceeds

#### Scenario: Look-alike host is rejected before any fetch

- **WHEN** the `url` host is a look-alike such as `youtube.com.evil.com`,
  `evil-youtube.com`, or a userinfo trick like `https://youtube.com@evil.com` (whose real
  host is `evil.com`), or the value is not a parseable `http(s)` URL
- **THEN** the response is `400 {detail}` and no `yt-dlp` subprocess is spawned

#### Scenario: Malformed body is rejected

- **WHEN** the request body is missing `url`, or `use_publish_date` is not a boolean
- **THEN** the response is a `{detail}`-shaped validation error and no fetch occurs

#### Scenario: Session guard is preserved

- **WHEN** a `youtube-import` request names a session the caller may not access
- **THEN** the response is whatever the existing `requireSession` guard returns for that
  session, unchanged by this capability

### Requirement: External fetch is bounded, hardened, and isolated

The server SHALL invoke `yt-dlp` by spawning the binary with a **discrete argument array,
never a shell-interpolated string**, with a `--` terminator preceding the positional URL,
passing the parser-normalized URL (`url.href`) that was validated, and a fixed output
template (not derived from the video title). The subprocess SHALL be hardened against
ambient code execution and secret exposure: it SHALL be spawned with configuration and
plugin loading disabled (so no ambient `yt-dlp` config file or plugin can inject flags such
as `--exec`), and with a **minimal, scrubbed environment** that does NOT inherit the server
process's environment (so the child never sees server secrets).

The subprocess SHALL be bounded on four axes, any breach terminating/aborting it and failing
the request: (1) a **maximum downloaded byte size** enforced during download; (2) rejection
of **live or unknown-duration** media detected at the metadata step; (3) a **maximum video
duration of 4 hours** for known-duration media, rejected before its full audio is fetched;
(4) a **wall-clock hang timeout**.

The download SHALL be written into a per-request temporary directory located **outside the
audio blob prefix** (so a partial/failed download can never be reconciled as a segment), and
that directory SHALL be **removed on every exit path** (success, failure, timeout, bound
breach). Temp directories orphaned by a process crash/kill SHALL be swept at startup.

#### Scenario: URL is never shell-interpreted and never option-interpreted

- **WHEN** the server invokes `yt-dlp` for a request
- **THEN** the URL and every other parameter are passed as discrete process arguments (not a
  shell command line), with a `--` terminator before the URL so it cannot be reinterpreted
  as an option

#### Scenario: Child process cannot be hijacked by ambient config or env

- **WHEN** `yt-dlp` is spawned
- **THEN** configuration/plugin loading is disabled and the child environment is a minimal
  scrubbed set that excludes the server's secrets, so an ambient config/plugin cannot inject
  flags and the child cannot read server credentials

#### Scenario: Oversized, live, or over-long media is bounded

- **WHEN** the media exceeds the byte-size cap, is a live/unknown-duration stream, is longer
  than the 4-hour duration cap, or the subprocess exceeds the wall-clock hang timeout
- **THEN** the subprocess is aborted/terminated (or the media is rejected before a full
  fetch) and the request fails with a `{detail}` error rather than downloading unboundedly or
  buffering an unbounded file

#### Scenario: Temp directory is cleaned up on every path and swept on crash

- **WHEN** an import request finishes on any path, or a prior run's process was killed
  mid-download
- **THEN** the per-request temporary directory and its contents are removed (in-request on a
  normal exit; at startup for a crash-orphaned directory), and it never resided under the
  audio blob prefix

### Requirement: Global concurrency ceiling

Across all sessions, the number of concurrent import runs SHALL be bounded by a global
ceiling. A request that would exceed the ceiling SHALL respond `409 {detail}` and SHALL NOT
spawn a subprocess. This bounds aggregate resource use (a single actor opening many sessions
cannot spawn an unbounded number of concurrent downloads / in-memory buffers).

#### Scenario: Import at the global ceiling is rejected

- **WHEN** the number of in-flight import runs is already at the global ceiling and another
  `youtube-import` request arrives (for any session)
- **THEN** the response is `409 {detail}` and no additional subprocess is spawned

#### Scenario: Ceiling slot is released when a run finishes

- **WHEN** an in-flight import run completes (success or failure)
- **THEN** its slot is released and a subsequent import request is admitted up to the ceiling

### Requirement: Per-session single-flight

At most one import run per session SHALL be in flight at a time. When an import request
arrives for a session that already has a run in progress, the server SHALL respond
`409 {detail}` and SHALL NOT spawn a second subprocess or make a second outbound request.
The guard SHALL be released when the run finishes (success or failure), so a later import
for the same session is permitted.

#### Scenario: Concurrent import for the same session is rejected

- **WHEN** a `youtube-import` request arrives for a session whose previous import is still
  running
- **THEN** the response is `409 {detail}`, and no additional subprocess is spawned and no
  additional outbound request is made

#### Scenario: Guard is released after a run finishes

- **WHEN** an import run for a session completes (whether it succeeded or failed)
- **THEN** a subsequent import request for that session is no longer rejected as concurrent

#### Scenario: Different sessions import concurrently within the ceiling

- **WHEN** imports are requested for two different sessions at the same time and the global
  ceiling is not exceeded
- **THEN** neither is rejected as concurrent on account of the other

### Requirement: Downloaded audio is ingested as a single supported-container segment

On a successful download the server SHALL attach the downloaded audio as **exactly one**
session audio segment, reusing the existing recorder ingestion path: a synchronous hub RPC
records the segment metadata and returns its blob key, then the router layer writes the
downloaded bytes to that key in the audio blob store. The fetch SHALL pin `yt-dlp`'s format
selection to the containers the audio path supports, and the stored extension and
`Content-Type` SHALL be derived from the **actually produced file**, not assumed. If the
produced container is not one the audio path supports, the request SHALL fail cleanly
(`502 {detail}`) rather than storing a mislabeled, undecodable blob. The audio SHALL be
stored as downloaded (no transcode). After a successful import the segment SHALL appear in
the session's audio-segment listing exactly as a recorded segment would (it renders a
client-computed waveform like any segment with no server-side peaks).

#### Scenario: Import produces one playable segment

- **WHEN** an import successfully downloads a video's audio in a supported container
- **THEN** the session's audio-segment listing gains exactly one new segment whose bytes are
  the downloaded container, retrievable and seekable through the existing audio-segment blob
  route, with a `Content-Type` matching the produced container

#### Scenario: Unsupported produced container fails cleanly

- **WHEN** `yt-dlp` produces a container the audio path does not support
- **THEN** the request fails with `502 {detail}` and no segment (and no blob) is attached

#### Scenario: Segment metadata write stays a synchronous hub RPC

- **WHEN** the segment metadata is recorded
- **THEN** it is written by a synchronous hub RPC inside a transaction, with the async blob
  write performed in the router layer (no `await` inside the hub method)

### Requirement: Publish-date opt-in writes the session episode date via the catalog layer

When `use_publish_date` is true and the fetched video metadata carries a usable upload date,
the server SHALL set the session's `episode_date` through the **catalog** layer (the same
single-column session mutator seam used by archive/hide), not a per-session hub RPC —
`episode_date` is a catalog `sessions` column with no per-session-DB counterpart. The stored
value SHALL be a calendar date that the UI renders as the **intended day**: because the
client date formatter parses a bare `YYYY-MM-DD` as UTC midnight (which renders as the
previous day for negative-UTC-offset viewers), the change SHALL ensure the displayed date is
not shifted a day earlier. When `use_publish_date` is false, or the metadata carries no
usable date, `episode_date` SHALL be left unchanged. The field's presence and type in the
session JSON response are unchanged (it was already a nullable field).

#### Scenario: Opt-in sets the episode date to the correct calendar day

- **WHEN** an import succeeds with `use_publish_date: true` and the video reports an upload
  date
- **THEN** the session's `episode_date` is set from that date and the UI displays the video's
  actual publish day (not one day earlier) regardless of viewer time zone

#### Scenario: Opt-out leaves the episode date untouched

- **WHEN** an import succeeds with `use_publish_date: false`
- **THEN** the import does not write `episode_date`

#### Scenario: Missing date is a no-op, not a failure

- **WHEN** `use_publish_date: true` but the metadata carries no usable upload date
- **THEN** the import still succeeds (audio is ingested) and `episode_date` is left unchanged

### Requirement: Synchronous single-shot request model

The import SHALL complete within the single `POST` request the client already issues: there
is no status, polling, or job surface. A successful import SHALL respond `200 {ok: true}` —
the shape the client mutation reads. A long download holds the request open; the bounds above
cap how long and how large that can be.

#### Scenario: Success returns the frozen ok shape

- **WHEN** an import completes successfully
- **THEN** the response is `200` with body `{ok: true}`

#### Scenario: No polling surface is introduced

- **WHEN** a client imports audio
- **THEN** the outcome is delivered entirely by the single request/response, with no
  additional status or job endpoint added

### Requirement: Failure behavior is atomic — no orphaned segment

A failure after the URL passes validation — download/extraction error, unsupported produced
container, a bound breach, or a blob-write (`put`) failure — SHALL respond with a clean
`{detail}`-shaped JSON error distinct from the unconfigured/refused `503` (e.g. `502`). A
failed import SHALL leave the session's audio **exactly as it was**: in particular, if the
segment metadata row was already inserted and the subsequent blob write fails, the row SHALL
be rolled back, so a failure can never leave a metadata row pointing at a missing blob. The
response detail is the message the client surfaces to the user.

#### Scenario: Download failure is a clean detail error

- **WHEN** `yt-dlp` fails to fetch or extract audio for a valid, configured request
- **THEN** the response is a `{detail}`-shaped error (e.g. `502`), not a `200` and not the
  unconfigured/refused `503`, and no audio segment is attached to the session

#### Scenario: Blob-write failure leaves no orphan row

- **WHEN** the segment metadata row is inserted but the blob write (e.g. disk full) fails
- **THEN** the inserted row is deleted and the session's audio-segment listing is byte-for-byte
  unchanged from before the request

#### Scenario: Failure leaves the session's audio unchanged

- **WHEN** an import fails for any reason after validation
- **THEN** the session's audio-segment listing is unchanged from before the request

### Requirement: A successful import produces a timeline-anchored take

On a successful import the server SHALL record the imported audio as a single **take**
anchored on the session timeline, so it is indistinguishable to downstream consumers
(transcript remap, audio-clip placement, events feed) from a recorded take. Without this,
imported audio is anchorless: transcript words get `session_time=''`/`start_sec=0`, the audio
bar is unplaced, and no events appear. Concretely, a successful import SHALL, after the blob
`put` succeeds: assign a recording ordinal `N`, attach the segment with `recording_ordinal=N`
and non-null `started_at_utc`/`ended_at_utc`, and create a `Recording N Started` internal
event, advance the transport by the video's duration, and create a `Recording N Stopped`
internal event. The three anchor writes (Started, transport advance, Stopped) SHALL be
performed **atomically in a single transaction** that emits its WebSocket notifications once,
so a partial anchor (e.g. a `Recording N Started` with no `Stopped`) can never persist.

#### Scenario: Imported audio is timeline-anchored

- **WHEN** an import succeeds for a session
- **THEN** the session gains a `Recording N Started` internal event whose
  `timecode_total_frames` equals the session's transport position at import time, a matching
  `Recording N Stopped` internal event after the duration advance, and exactly one audio
  segment whose `recording_ordinal` is `N`

#### Scenario: Transcript generated afterward is timeline-positioned

- **WHEN** transcript generation runs on a session whose only audio is an imported, anchored
  segment
- **THEN** the produced words carry non-empty `session_time` derived from the `Recording N
  Started` anchor (not the anchorless `session_time=''`)

#### Scenario: Anchor writes are atomic

- **WHEN** the anchor transaction fails part-way (e.g. a disk error between the events)
- **THEN** none of the three anchor writes persist — no dangling `Recording N Started`
  without its `Stopped`, and no partial transport advance

### Requirement: Recording-ordinal assignment avoids collision

The import SHALL choose `N` as one greater than the highest ordinal already in use in the
session — the max over both existing segments' `recording_ordinal` **and** existing
`Recording k` event numbers — so `N` cannot collide with a still-present take even after an
earlier segment was deleted (deleting a segment does not delete its `Recording k` events).
The `Recording N Started`/`Stopped` events and the segment's `recording_ordinal` SHALL all
use that same `N`.

#### Scenario: First import gets ordinal 1

- **WHEN** the first import into a session with no takes succeeds
- **THEN** the events are `Recording 1 Started`/`Stopped` and the segment's `recording_ordinal`
  is `1`

#### Scenario: Ordinal does not collide after a deletion

- **WHEN** an import succeeds in a session where an earlier take's segment was deleted but its
  `Recording k` events remain
- **THEN** `N` is greater than every existing `recording_ordinal` and every existing
  `Recording k` event number, so the imported take's anchor cannot resolve to a prior take's
  position

### Requirement: Anchor position and take extent

The `Recording N Started` event SHALL be anchored at the session's transport position at
import time. The transport SHALL then be advanced by the video's duration (in frames at the
session frame rate, sourced from the same `yt-dlp` metadata the import already reads), so the
`Recording N Stopped` event and the take extent cover `[position, position+duration]` and a
subsequent take/import lands after it (no overlap). A video whose reported duration is not a
positive number SHALL be rejected as a failed import rather than producing a zero-length take.

#### Scenario: Two sequential imports do not overlap

- **WHEN** two imports succeed one after the other in the same session
- **THEN** the second take is anchored after the first (its events and segment extent follow
  the first's), not at the same position

### Requirement: Import is refused while a recording is live

If the session's transport is actively rolling (a live recording in progress) when a
`youtube-import` request would proceed, the server SHALL refuse it with `409 {detail}` and
SHALL NOT synthesize a take or advance/clobber the live roll. This protects the in-flight
recording, which the import's transport advance would otherwise silently end and corrupt.

#### Scenario: Import during a live recording is refused

- **WHEN** a `youtube-import` request is made for a session whose transport `is_rolling` is
  true
- **THEN** the response is `409 {detail}`, no subprocess/synthesis clobbers the live roll,
  and the recording continues unaffected

### Requirement: Existing anchorless imports are not retroactively changed

This anchoring applies only to imports performed after it ships. Segments already stored
anchorless SHALL NOT be migrated or altered; there is no backfill (a re-import produces an
anchored take).

#### Scenario: Prior anchorless segment is untouched

- **WHEN** the server runs against a session that already holds an anchorless imported segment
- **THEN** that segment is left exactly as it was; only a new import produces an anchored take
