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

### Requirement: Generation lock status is observable
The deployment SHALL expose `GET /api/transcript-generation/status` that reports whether
the process-wide transcript generation slot is held. Auth SHALL match sibling transcript
routes (same middleware / login gate as `GET …/transcript-words`). The response SHALL be:

| Condition | Body |
|---|---|
| No run in flight | `{ "in_flight": false }` |
| Run in flight | `{ "in_flight": true, "session_id": <string\|null>, "session_title": <string\|null>, "started_at": "<ISO-8601 UTC>" }` |

The lock is process-wide, so the holder may belong to a studio the requester is
not a member of. For a logged-in requester (`user !== null`) who lacks studio
membership of the holding session, `session_id` and `session_title` SHALL both
be `null` while `in_flight` stays `true` — the same key set with null values,
never absent keys. The dev-anonymous requester (`user === null`) sees the full
identifiers, matching the membership scope every sibling route applies
(sibling-route parity). For a permitted requester, `session_id` SHALL be the
holder's session id and `session_title` SHALL be the catalog session title at
the time of the status read, or `null` if no session row exists for
`session_id`. `started_at` SHALL be the UTC instant the lock was acquired for
the current run. The endpoint MUST NOT start, stop, or otherwise mutate
generation.

#### Scenario: Idle status
- **WHEN** no transcript generation run holds the process-wide slot
- **THEN** `GET /api/transcript-generation/status` responds `200` with
  `{ "in_flight": false }` and MUST NOT include busy-only fields as required true values

#### Scenario: Busy status names the holder for a permitted requester
- **WHEN** a generation run for session S is in flight, the catalog row for S has title T,
  and the requester is anonymous (`user === null`) or a member of S's studio
- **THEN** `GET /api/transcript-generation/status` responds `200` with `in_flight: true`,
  `session_id` equal to S, `session_title` equal to T, and a parseable UTC `started_at`

#### Scenario: Non-member sees redacted busy status
- **WHEN** a generation run for session S is in flight and the requester is logged in but
  not a member of S's studio
- **THEN** the response is `200` with `in_flight: true`, `session_id: null`,
  `session_title: null`, and the real `started_at` — busy-ness stays truthful, the
  holder's identifiers do not leak across tenants

#### Scenario: Missing catalog title is null
- **WHEN** a generation run is in flight for session S, no catalog row exists for S, and
  the requester is permitted to view S
- **THEN** the busy response includes `session_title: null` and still includes `session_id`
  and `started_at`

### Requirement: Single-flight generation
At most one generation run SHALL execute per process at a time, and at most one per
session: a generate request arriving while another run is in flight (same or different
session) SHALL respond `409` with an actionable detail and MUST NOT issue a provider
request. The `409` detail SHALL name the session that holds the lock (catalog title when
available, otherwise the session id) when the requester is permitted to view that session
(anonymous requester, or a member of the holder's studio); for a logged-in non-member —
and for the race where the holder released the lock between the failed acquire and error
mapping, leaving nothing to check membership against — the detail SHALL fall back to the
identifier-free generic in-flight detail (`GENERATION_IN_FLIGHT_DETAIL`). Status stays
`409` either way. Before issuing the provider request, the pipeline
SHALL check whether the originating HTTP request has been aborted and, if so, abandon the
run without provider spend, responding `400` with a detail distinct from the other `400`
conditions (no-audio, all-unreadable, no-speech) — **not** an unauthorized status code
outside the api-contract-freeze table (gate decision 2026-07-14). A run whose client
disconnects after the provider request was issued SHALL still complete server-side (words
persist; a later `GET …/transcript-words` shows them). While the lock is held, the
deployment SHALL expose the holder via `GET /api/transcript-generation/status` (see
Generation lock status is observable).

#### Scenario: Concurrent generate is rejected cheaply
- **WHEN** a second generate request arrives while a run is already in flight
- **THEN** it receives `409` and no additional provider request is made

#### Scenario: Concurrent 409 detail names the busy session
- **WHEN** a generate request arrives while a run for session S titled T is in flight and
  the requester is anonymous or a member of S's studio
- **THEN** the `409` `{detail}` string includes T (or S if no title) so an operator can
  identify the holder without calling status

#### Scenario: Concurrent 409 for a non-member is identifier-free
- **WHEN** a generate request from a logged-in non-member of S's studio arrives while a
  run for S is in flight (or the holder released in the race before error mapping)
- **THEN** the response is `409` with the generic in-flight `{detail}` that names no
  session id or title

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
gives the timeline position. For anchor resolution, segments sharing a
`recording_ordinal` form a **chunk group** whose base is its lowest-ordinal member
(segments with a null `recording_ordinal` are each their own group, as are all
pre-existing single-segment recordings); when multiple `Recording N Started` anchors
share an ordinal (a same-N re-run), each same-N segment pairs with the same-N anchor
whose event wall time most nearly precedes the segment's `started_at_utc`, FIFO per
ordinal as elsewhere. Anchor events SHALL resolve to a group, in order: (1) the
`Recording N Started` internal event matched by the group's `recording_ordinal` —
claimed by the group's base only (bases visited in segment-ordinal order, one anchor per
base); (2) i-th remaining unmatched base ↔ i-th unmatched start event, in ordinal/time
order; (3) no anchor (every member anchorless).

Given the group's resolved anchor `A` (event `E`), each member's own anchor SHALL be
**event-wall-time derived**: `A + max(0, (started_at_utc(member) − wall_time_utc(E)) /
1000)` when both timestamps are parseable — so a member's placement never depends on
which sibling chunks survived. Fallbacks preserving pre-change behavior exactly: when
`wall_time_utc(E)` is unparseable, the base anchors at `A` and non-base members derive
`A + max(0, (started_at_utc(member) − started_at_utc(base)) / 1000)`; a member with
unparseable `started_at_utc` anchors at `A` if it is its group's only member (the legacy
single-segment shape) and is otherwise anchorless. A non-base member SHALL NOT claim a
step-1 anchor or participate in index pairing. For every pre-change live recording the
stored `started_at_utc` equals the start event's wall time, so the derived delta is 0 and
placement is unchanged. Import-synthesized takes SHALL carry the same identity going
forward (the import anchor threads the take's `startedAtUtc` into the Started event's
wall time — design D9); historical import rows, whose stored event wall time postdates
the segment's `started_at_utc`, floor to a delta of 0 under the `max(0, ·)` clamp. Both
properties SHALL be test-pinned before this requirement's implementation lands.

Anchor timeline seconds SHALL be computed from the start event's stored
`timecode_total_frames / frame_rate` (frame arithmetic — never by re-parsing a formatted
SMPTE string or recomputing from live transport state); derived anchors add the clamped
wall-clock delta to that frame-derived base. The remapped position SHALL be stored as:
`session_time` = the SMPTE rendering at the session frame rate, and
`start_sec`/`end_sec` = the remapped session-timeline seconds of the word's start and
end. Anchorless words SHALL still be stored, with empty `session_time` and `start_sec`/
`end_sec` of `0` (matching manual inserts).

#### Scenario: Words land at their recording's timeline position
- **WHEN** a session has two recordings with a gap between them and generation runs
- **THEN** words from the second recording carry `session_time`/`start_sec` values at the
  second recording interval's position, not immediately after the first recording's words

#### Scenario: Anchorless segment still yields words
- **WHEN** a segment has no matching recording-start event by ordinal or order pairing
- **THEN** its words are stored with empty `session_time` and zeroed `start_sec`/`end_sec`,
  and are not silently dropped

#### Scenario: Chunked recording words land at their cumulative position
- **WHEN** recording 2 consists of three chunk segments sharing `recording_ordinal = 2`,
  each with its own `started_at_utc`, and generation runs
- **THEN** each chunk's words anchor at the `Recording 2 Started` position plus that
  chunk's wall-clock delta from the start event — never all at the recording's start
  (overlapping each other) and never index-paired to another recording's anchor

#### Scenario: A discarded first chunk does not shift the survivors
- **WHEN** a three-chunk recording's first chunk was permanently lost and discarded, so
  only chunks 2 and 3 exist as segments
- **THEN** chunks 2 and 3's words still land at their true wall-clock deltas from the
  `Recording N Started` event — not at the recording start, and not shifted early by the
  missing chunk's duration

#### Scenario: A follow-on chunk without a start timestamp goes anchorless, never mis-paired
- **WHEN** a segment shares `recording_ordinal` with a group base but has
  `started_at_utc = null`
- **THEN** its words are stored anchorless (empty `session_time`, zeroed seconds) rather
  than being index-paired to some other recording's unmatched start event

#### Scenario: Existing single-segment sessions place identically
- **WHEN** a pre-change session (one segment per recording, `started_at_utc` equal to its
  start event's wall time) is regenerated
- **THEN** every word's `session_time`/`start_sec`/`end_sec` is identical to the
  pre-change output (the derived delta is 0)

#### Scenario: Same-N re-runs keep their anchors apart
- **WHEN** a session contains two distinct `Recording 1` cycles (the first fully
  discarded recording left its events behind) and the second cycle has two chunk segments
- **THEN** the second cycle's chunks pair with the second `Recording 1 Started` anchor
  (the one nearest-preceding their `started_at_utc`), and neither chunk claims the first
  cycle's anchor

#### Scenario: Enrichment inherits derived anchors
- **WHEN** a paragraph's anchoring segment is a follow-on chunk with a derived anchor
- **THEN** the paragraph's `start_sec`/`end_sec` are remapped through that derived anchor
  (the enrichment requirements' "same anchor chain" language now includes derivation),
  not `null`

### Requirement: Word content, ordering, and provider parameters
Provider requests SHALL set `diarize=true`, `smart_format=true`, `paragraphs=true`,
`sentiment=true`, `language=en`, and the configured model; `punctuate` SHALL NOT be set
explicitly (`smart_format=true` implies punctuation, keeping `punctuated_word` populated),
and words SHALL be read from the first/only audio channel. The stored `word` text SHALL be
the provider's `punctuated_word`, falling back to `word` when absent. Words SHALL be stored
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
A successful generation run SHALL replace the session's entire transcript-words set **and
its persisted enrichment** via a **single-transaction hub RPC** (delete-then-insert of
words, paragraphs, and sentiment segments in one transaction; the RPC body stays
synchronous per the hub invariant, and accepts `start_sec`/`end_sec`). All enrichment
extraction and remapping happens in the **router layer** before this call — no `await` and
no provider-shape logic enters the synchronous hub body. The replace transaction SHALL run
only after **all** groups' provider requests have succeeded — a failed group discards the
whole run's results, words and enrichment alike. A failed run SHALL leave the existing words
**and existing enrichment** untouched. **Zero-word guard (gate decision 2026-07-14):** a run
whose provider requests all succeed but yield zero words in total SHALL NOT replace anything
— the existing transcript and its enrichment are preserved and the response is `400` with a
distinct no-speech-detected detail. Skipped segments mean the `200` response can be a partial
transcript; this is returned without any warning indication (the frozen response shape has no
channel for one) — a deliberate, accepted property. Enrichment persistence MUST NOT be a
second writer outside this transaction; there is exactly one atomic replace covering words
and enrichment together, so a crash can never leave words persisted with enrichment lost (or
vice versa).

#### Scenario: Re-run replaces prior words
- **WHEN** generation succeeds on a session that already has transcript words and enrichment
- **THEN** the stored set afterward contains only the new run's words and enrichment,
  replaced in a single transaction

#### Scenario: Failed run preserves existing words
- **WHEN** any group's provider request fails mid-run
- **THEN** the session's pre-existing transcript words and enrichment are unchanged and no
  partial insert of either is observable at any point

#### Scenario: Zero-word result does not wipe the transcript
- **WHEN** generation succeeds upstream but returns zero words (e.g. silent audio) for a
  session that already has transcript words and enrichment
- **THEN** the response is `400` with a no-speech-detected detail and the existing words and
  enrichment are untouched

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

### Requirement: Enrichment capture from the provider response
The generation pipeline SHALL capture the paragraph and sentiment enrichment DeepGram
already returns for the requested `paragraphs=true` / `sentiment=true` parameters, instead
of discarding it. Per group, the provider call SHALL return, alongside its words, the
group's **paragraphs** — read from `results.channels[0].alternatives[0].paragraphs.paragraphs[]`,
each carrying its `speaker`, group-file `start`/`end` seconds, and the text formed by
concatenating its `sentences[].text` — and the group's **sentiment** — read from the
**top-level** `results.sentiments.segments[]` (each with `start_word`/`end_word` word
indices into that group's word array, `sentiment`, `sentiment_score`, and the segment
`text`). Extraction SHALL be **defensively tolerant**: any missing or malformed field
(absent `paragraphs`/`sentiments`/`sentences`, a non-array where an array is expected)
SHALL yield empty enrichment for that group and MUST NOT throw. All numeric fields
(`start`, `end`, `sentiment_score`, word indices) SHALL be coerced via `Number(...)` as
`extractWords` already does for word timings; a value that coerces to `NaN` SHALL be
treated as absent, never persisted. Words remain the sole success gate; enrichment is
strictly additive to the run's result — a group that yields words but no usable enrichment
still succeeds.

#### Scenario: Paragraphs and sentiment are captured, not discarded
- **WHEN** a group's provider response contains `alternatives[0].paragraphs.paragraphs[]`
  and top-level `results.sentiments.segments[]`
- **THEN** the pipeline retains that group's paragraphs (with speaker and text) and its
  sentiment segments (with text and score), in addition to its words

#### Scenario: Missing or malformed enrichment does not fail a word-bearing run
- **WHEN** a group returns words but its `paragraphs`/`sentiments` are absent, malformed,
  or contain non-numeric scores/indices
- **THEN** extraction yields empty enrichment for that group, does not throw, and the run
  succeeds with words persisted

### Requirement: Enrichment timeline remapping
Captured enrichment SHALL be remapped onto the session timeline **per group, using the
same anchor context computed for that group's words, before words from all groups are
merged and globally ordered** — because sentiment `start_word`/`end_word` indices and
paragraph group-file seconds are only meaningful within their own group's word slice.
Remapping SHALL never throw and SHALL never fail a word-bearing run:

- **Sentiment segments** SHALL take their session-timeline start/end from the remapped
  positions of the words at their `start_word` and `end_word` indices within that group.
  Indices that are out of range, negative, or non-integer SHALL be clamped to the group's
  word bounds; a segment in a zero-word group SHALL be dropped; a segment whose
  `end_word < start_word` SHALL be normalized so end ≥ start. As an index-base guard, a
  segment whose leading `text` token does not match the word at its `start_word` SHALL be
  stored with NULL session-timeline start/end (degraded to unanchored) rather than
  persisting a confidently-wrong span.
- **Paragraphs** SHALL have their group-file `start`/`end` seconds remapped through the
  same anchor chain used for words. A paragraph is an **interval anchored as a unit**: both
  `start` and `end` resolve against the single segment containing the paragraph's `start`,
  so a paragraph that straddles a concatenation seam keeps a coherent duration; the stored
  `end_sec` SHALL be clamped to be ≥ `start_sec`.

Enrichment whose group (or boundary word) has **no resolvable anchor** SHALL be stored with
**NULL** session-timeline start/end — distinct from a genuine `0` — so a consumer can tell
"no timeline position" from "at the start of the timeline" (the `ai-v2-dashboards`
never-zeros-as-data contract). Anchorless enrichment SHALL NOT be dropped. Enrichment SHALL
NOT be resolved in a post-pass over the already-merged, already-sorted word set.

#### Scenario: Sentiment segment inherits its words' timeline position
- **WHEN** a sentiment segment spans `start_word`..`end_word` in a group whose words
  remap to a later recording interval, and its leading text token matches `words[start_word]`
- **THEN** the stored segment's session-timeline start/end match the remapped positions of
  those boundary words, not the group-file seconds

#### Scenario: Malformed sentiment indices never kill a good run
- **WHEN** a sentiment segment has an out-of-range, negative, or non-integer index, or its
  text does not match `words[start_word]`
- **THEN** the segment is clamped, dropped, or degraded to NULL start/end as specified, no
  exception propagates, and the run's words are persisted normally

#### Scenario: Paragraph seconds are remapped as a single-anchor interval
- **WHEN** a paragraph reports group-file `start`/`end` seconds in an anchored group,
  including one whose span crosses a segment concatenation seam
- **THEN** the stored paragraph's session-timeline start/end are anchor-remapped against the
  segment containing its start, with `end_sec ≥ start_sec`

#### Scenario: Anchorless-group enrichment is retained with NULL times, not zeros
- **WHEN** a group (or a segment's boundary word) has no resolvable recording-start anchor
- **THEN** its paragraphs and sentiment segments are stored with NULL session-timeline
  start/end (never silently `0`), and are not dropped

### Requirement: Enrichment persistence and internal read
A successful generation run SHALL persist the remapped enrichment in the per-session
database in two tables created idempotently in the per-session schema init (no catalog
migration), so existing session databases gain them empty on next open: paragraph rows
(nullable session-timeline `start_sec`/`end_sec`, speaker rendered as the same decimal
string convention as word speakers, concatenated text) and sentiment-segment rows (nullable
session-timeline `start_sec`/`end_sec`, `sentiment`, `sentiment_score`, segment text). Rows
SHALL carry contiguous ordinals from 0 assigned by the **same two-bucket order words use**:
anchored rows (non-NULL start) first, ordered by `start_sec` ascending with a stable
secondary key, followed by anchorless rows (NULL start) in group/segment order — so the
read order is deterministic. Speaker ids are diarization indices consistent only within one
provider request; the system SHALL NOT attempt cross-group speaker reconciliation for
enrichment, matching the words path. No session-level sentiment average is persisted (a
consumer computes any roll-up from the stored segments with the weighting it needs).

Enrichment SHALL be readable through a synchronous SessionHub read
(`listTranscriptEnrichment`) returning `{ paragraphs, sentiment }` as arrays in ordinal
order; a session that has never generated (or whose last run produced no enrichment) SHALL
read as empty arrays, never an error. This is an **in-process read only** — no new HTTP
route is added, and the frozen `GET /api/sessions/:sessionId/transcript-words` shape is
unchanged, so this change adds no observable HTTP/WS contract surface.

#### Scenario: Enrichment round-trips through the hub read
- **WHEN** a generation run persists paragraphs and sentiment segments, and a caller then
  invokes `listTranscriptEnrichment`
- **THEN** it returns `{ paragraphs, sentiment }` with both arrays in deterministic ordinal
  order (anchored-by-time then anchorless)

#### Scenario: Never-generated session reads as empty, not error
- **WHEN** `listTranscriptEnrichment` is invoked for a session with no transcript enrichment
- **THEN** it returns empty `paragraphs` and empty `sentiment` (the tables exist but hold no
  rows), never an error

#### Scenario: The frozen transcript-words shape is unchanged
- **WHEN** a client calls `GET /api/sessions/:id/transcript-words` after this change
- **THEN** the response shape is byte-for-byte what it returned before, and no new HTTP
  route exists — enrichment is read only in-process

### Requirement: Enrichment is a generation snapshot
Persisted enrichment SHALL be treated as a snapshot of the run that produced it, tied to
that run's word set and indices. Manual `transcript-words` mutations (insert, update,
delete) SHALL NOT recompute, remap, or wipe enrichment — it may become stale relative to
edited words, and that is accepted. The only operation that changes enrichment is a
subsequent generation run, which replaces it wholesale.

#### Scenario: Manual word edit leaves enrichment untouched
- **WHEN** a user deletes or edits a transcript word after a generation run
- **THEN** the persisted paragraphs and sentiment segments are unchanged (and may no longer
  align with the edited words)

