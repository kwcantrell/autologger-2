# transcript-generation — delta

## MODIFIED Requirements

### Requirement: Segment grouping and concatenation
The pipeline SHALL classify each audio segment by **probing the blob bytes** (container +
actual track codec + stream parameters via the muxing library) — the stored `mime_type` is
a hint only, since the upload path constrains it solely to keep audio responses out of the
`/api/*` compression filter (any compressible or blank type degrades to `audio/webm`;
every other client-supplied type, including `application/octet-stream` and `video/*`, is
stored verbatim), and other segment writers persist their own producer-supplied types. No
stored `mime_type` therefore identifies the actual codec. Segments SHALL be
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

#### Scenario: A clamped mime_type does not determine grouping
- **WHEN** a segment's stored `mime_type` is `audio/webm` because the upload's declared
  type was compressible, but its bytes are actually AAC
- **THEN** the segment is grouped by its probed codec (AAC), not by the stored hint

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
read as empty arrays, never an error. This is an **in-process read only** — no HTTP route
exposes enrichment, and enrichment adds nothing to the transcript-words wire shape.

That wire shape is no longer the shape this capability shipped against: `perf-audit-remediation`
trimmed it to exactly the seven keys `{id, session_time, speaker, word, start_sec, end_sec,
ordinal}`, dropping `session_id` and `created_at_utc` and rounding `start_sec`/`end_sec` to
3 decimals (see the `api-contract-freeze` delta in that change). Enrichment SHALL NOT
reintroduce either dropped key, and SHALL NOT add fields to that shape.

#### Scenario: Enrichment round-trips through the hub read
- **WHEN** a generation run persists paragraphs and sentiment segments, and a caller then
  invokes `listTranscriptEnrichment`
- **THEN** it returns `{ paragraphs, sentiment }` with both arrays in deterministic ordinal
  order (anchored-by-time then anchorless)

#### Scenario: Never-generated session reads as empty, not error
- **WHEN** `listTranscriptEnrichment` is invoked for a session with no transcript enrichment
- **THEN** it returns empty `paragraphs` and empty `sentiment` (the tables exist but hold no
  rows), never an error

#### Scenario: Enrichment adds nothing to the transcript-words shape
- **WHEN** a client calls `GET /api/sessions/:id/transcript-words` for a session that has
  persisted enrichment
- **THEN** each word object carries exactly the seven keys `id`, `session_time`, `speaker`,
  `word`, `start_sec`, `end_sec`, and `ordinal` — no paragraph, sentiment, or other
  enrichment field — and no HTTP route exposes enrichment at all
