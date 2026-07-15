# transcript-generation

## Purpose

Real server-side speech-to-text behind the existing
`POST /api/sessions/:sessionId/transcript-words/generate` route: when a DeepGram API key
is configured, the server combines a session's recorded audio segments into per-codec
group files (packet-copy, no re-encoding), sends one DeepGram pre-recorded request per
group, remaps returned word timestamps onto the session timeline, and atomically replaces
the session's transcript words. The single-file-per-group approach exists because
DeepGram's diarization speaker labels are only consistent within one request, and the
product renders speakers as "Person N" across the whole session. Unconfigured deployments
keep the frozen `503` unchanged.

## Requirements

### Requirement: Configuration-gated generation
Transcript generation SHALL be gated on a `DEEPGRAM_API_KEY` environment variable. When
the key is unset or blank, `POST /api/sessions/:sessionId/transcript-words/generate` SHALL
retain its current behavior — `503` with the existing unavailable detail — byte-for-byte,
so unconfigured deployments are unchanged. When the key is set, the endpoint SHALL run the
generation pipeline. The DeepGram model SHALL default to `nova-3` and be overridable via a
`DEEPGRAM_MODEL` environment variable. The API key MUST NOT appear in any response body,
log line, or stored artifact, and MUST be sent only in the `Authorization` request header
(never in a URL) so no error path can stringify it.

#### Scenario: Unconfigured deployment keeps the frozen 503
- **WHEN** `DEEPGRAM_API_KEY` is unset and a client calls `POST
  /api/sessions/:id/transcript-words/generate`
- **THEN** the response is the same `503 {detail}` the endpoint returns today

#### Scenario: Configured deployment generates
- **WHEN** `DEEPGRAM_API_KEY` is set and the session has at least one readable audio
  segment
- **THEN** the endpoint responds `200 {words}` with the generated transcript words

### Requirement: Single-flight generation
At most one generation run SHALL execute per process at a time, and at most one per
session: a generate request arriving while another run is in flight (same or different
session) SHALL respond `409` with an actionable detail and MUST NOT issue a provider
request. Before issuing the provider request, the pipeline SHALL check whether the
originating HTTP request has been aborted and, if so, abandon the run without provider
spend, responding `400` with a detail distinct from the other `400` conditions (no-audio,
all-unreadable, no-speech) — **not** an unauthorized status code outside the
api-contract-freeze table (gate decision 2026-07-14). A run whose client disconnects
after the provider request was issued SHALL still complete server-side (words persist; a
later `GET …/transcript-words` shows them).

#### Scenario: Concurrent generate is rejected cheaply
- **WHEN** a second generate request arrives for a session that already has a run in
  flight
- **THEN** it receives `409` and no additional provider request is made

#### Scenario: Pre-provider-call abort is abandoned cheaply with a distinct 400
- **WHEN** the originating HTTP request is already aborted before any provider request
  would be issued
- **THEN** the run is abandoned, no provider request is made, and the response is `400`
  with a detail distinct from the other `400` conditions

#### Scenario: Disconnected client does not lose the completed run
- **WHEN** the client's connection drops after the provider request was issued and the
  run then succeeds
- **THEN** the replaced words are persisted and served by subsequent list requests

### Requirement: Segment grouping and concatenation
The pipeline SHALL classify each audio segment by **probing the blob bytes** (container +
actual track codec + stream parameters via the muxing library) — the stored `mime_type` is
a hint only, since upload accepts any client-supplied content type. Segments SHALL be
grouped by probed codec + stream parameters — Opus, AAC, PCM families — and, per group,
concatenated by **packet copy without re-encoding** into a single container the provider
accepts: Opus groups into WebM, AAC groups into MP4, PCM groups into WAVE. Segments within
a group SHALL be ordered by segment ordinal, and each segment's cumulative time offset
within the group file SHALL be recorded for timestamp remapping. Segments that are
missing from the blob store, unreadable, unparseable, or whose probed codec is outside the
supported families SHALL be **skipped** (the reconciliation posture used elsewhere); a
stream-parameter mismatch within a codec family splits into a further sub-group rather
than failing the run. One STT request SHALL be issued per resulting group. Concatenation
SHALL be spooled through temporary files (not held wholly in memory), and a group file
exceeding the provider's documented size limit SHALL fail the run with `502` and a detail
naming the limit.

#### Scenario: Homogeneous session produces one request
- **WHEN** a session's segments are all Opus (any mix of webm and ogg containers)
- **THEN** exactly one combined WebM file is produced and exactly one DeepGram request is
  issued for the session

#### Scenario: Legacy PCM session transcribes without re-encoding
- **WHEN** a session's segments are all legacy `.wav` (PCM) files with identical stream
  parameters
- **THEN** one combined WAVE file is produced by packet/sample copy and transcription
  proceeds

#### Scenario: Mixed-codec session degrades to one request per group
- **WHEN** a session contains both Opus and AAC segments
- **THEN** two combined files are produced (WebM and MP4), each transcribed in its own
  request, and all returned words are merged into the session transcript

#### Scenario: Corrupt or mislabeled segment does not brick generation
- **WHEN** one segment's blob is unparseable (or its probed codec is unsupported) and
  other readable segments exist
- **THEN** the bad segment is skipped and generation succeeds over the remaining segments

### Requirement: Timeline remapping of word timestamps
Each returned word's provider timestamp (time within the combined group file) SHALL be
remapped to the session timeline: group-file time minus the owning segment's group offset
gives the within-segment offset; the segment's session-timeline anchor plus that offset
gives the timeline position. The anchor SHALL resolve, in order: (1) the `Recording N
Started` internal event matched by the segment's `recording_ordinal`; (2) i-th unmatched
segment ↔ i-th unmatched start event, in ordinal/time order; (3) no anchor. Anchor
timeline seconds SHALL be computed from the start event's stored
`timecode_total_frames / frame_rate` (frame arithmetic — never by re-parsing a formatted
SMPTE string or recomputing from live transport state). The remapped position SHALL be
stored as: `session_time` = the SMPTE rendering at the session frame rate, and
`start_sec`/`end_sec` = the remapped session-timeline seconds of the word's start and end.
Anchorless words SHALL still be stored, with empty `session_time` and `start_sec`/
`end_sec` of `0` (matching manual inserts).

#### Scenario: Words land at their recording's timeline position
- **WHEN** a session has two recordings with a gap between them and generation runs
- **THEN** words from the second recording carry `session_time`/`start_sec` values at the
  second recording interval's position, not immediately after the first recording's words

#### Scenario: Anchorless segment still yields words
- **WHEN** a segment has no matching recording-start event by ordinal or order pairing
- **THEN** its words are stored with empty `session_time` and zeroed `start_sec`/`end_sec`,
  and are not silently dropped

### Requirement: Word content, ordering, and provider parameters
Provider requests SHALL set `diarize=true`, `punctuate=true`, and the configured model;
`smart_format` SHALL NOT be set, `language` SHALL be left to the provider default, and
words SHALL be read from the first/only audio channel. The stored `word` text SHALL be the
provider's `punctuated_word`, falling back to `word` when absent. Words SHALL be stored
with contiguous ordinals from 0 in this order: anchored words by remapped timeline
position (ties by within-group order), followed by anchorless segments' words grouped by
segment ordinal in within-segment time order. The `200 {words}` response array SHALL be in
ordinal order (it is the complete post-replace list).

#### Scenario: Punctuated text is stored
- **WHEN** the provider returns `word: "hello"` with `punctuated_word: "Hello,"`
- **THEN** the stored word text is `"Hello,"`

#### Scenario: Anchorless words sort after anchored words
- **WHEN** a generation run stores words from both anchored and anchorless segments
- **THEN** every anchored word's ordinal precedes every anchorless word's ordinal, and
  ordinals are contiguous from 0

### Requirement: Speaker labels
Diarization SHALL be enabled on provider requests. Each word's `speaker` field SHALL be
stored as the provider's integer speaker id rendered as a decimal string (`"0"`, `"1"`, …)
— the format the frontend's speaker renderer already consumes. Speaker ids are consistent
within one provider request (one codec group); the system SHALL NOT attempt cross-group
speaker reconciliation.

#### Scenario: Speaker integers round-trip to the UI convention
- **WHEN** generation stores a word DeepGram attributed to speaker `1`
- **THEN** the stored `speaker` field is the string `"1"` (rendered by the existing UI as
  "Person 2" at default offset)

### Requirement: Regeneration replaces the transcript atomically
A successful generation run SHALL replace the session's entire transcript-words set via a
**single-transaction hub RPC** (delete-then-insert in one transaction; the RPC body
stays synchronous per the hub invariant, and accepts `start_sec`/`end_sec`). The replace
transaction SHALL run only after **all** groups' provider requests have succeeded — a
failed group discards the whole run's results. A failed run SHALL leave the existing words
untouched. **Zero-word guard (gate decision 2026-07-14):** a run whose provider requests
all succeed but yield zero words in total SHALL NOT replace anything — the existing
transcript is preserved and the response is `400` with a distinct no-speech-detected
detail. Skipped segments mean the `200` response can be a partial transcript; this is
returned without any warning indication (the frozen response shape has no channel for
one) — a deliberate, accepted property.

#### Scenario: Re-run replaces prior words
- **WHEN** generation succeeds on a session that already has transcript words
- **THEN** the stored set afterward contains only the new run's words, replaced in a
  single transaction

#### Scenario: Failed run preserves existing words
- **WHEN** any group's provider request fails mid-run
- **THEN** the session's pre-existing transcript words are unchanged and no partial
  insert is observable at any point

#### Scenario: Zero-word result does not wipe the transcript
- **WHEN** generation succeeds upstream but returns zero words (e.g. silent audio) for a
  session that already has transcript words
- **THEN** the response is `400` with a no-speech-detected detail and the existing words
  are untouched

### Requirement: Failure mapping
When the key is configured: a session with zero audio segment rows SHALL yield `400` with
an actionable detail; a session whose segments are all skipped (no readable segment
remains) SHALL yield `400` with a distinct detail; a provider request failure or provider
timeout SHALL yield `502` with a detail that does not leak the API key or verbatim
upstream bodies; the client-side provider timeout SHALL be configured longer than the
provider's documented 10-minute processing ceiling (undici's 300s default is insufficient
and MUST be overridden). The pipeline SHALL run in the router layer — no `await` enters a
SessionHub RPC body — and any hub access after an `await` SHALL re-acquire the hub through
the registry (idle eviction may have closed the previous handle during the await).
Generation runs against the segment set snapshotted at run start; segments uploaded
mid-run (e.g. a recording in progress) are absent from the result — accepted snapshot
semantics.

#### Scenario: No audio to transcribe
- **WHEN** generation is requested for a session with no audio segments
- **THEN** the response is `400` with a detail explaining there is no audio to transcribe

#### Scenario: All segments unreadable
- **WHEN** every segment's blob is missing or unparseable
- **THEN** the response is `400` with a distinct detail (no provider request is made)

#### Scenario: Upstream failure maps to 502
- **WHEN** DeepGram responds with an error or exceeds the configured timeout
- **THEN** the endpoint responds `502` with a generic upstream-failure detail and existing
  words are preserved
