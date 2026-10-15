## MODIFIED Requirements

### Requirement: Timeline remapping of word timestamps
Each returned word's provider timestamp (time within the combined group file) SHALL be
remapped to the session timeline: group-file time minus the owning segment's group offset
gives the within-segment offset; the segment's session-timeline anchor plus that offset
gives the timeline position. A **merged segment** (one produced by the media worker from
a recording's chunks, carrying `seams`: for each original chunk its media offset in the
merged file and its `started_at_utc`) SHALL be remapped seam by seam: the word's owning
seam is the last seam whose offset is at or before the within-segment offset; that seam's
anchor is derived from the segment's resolved anchor exactly as a chunk's would be
(`A + max(0, (started_at_utc(seam) − wall_time_utc(E)) / 1000)`), and the position is the
seam anchor plus the offset within the seam. A segment without seams is remapped as
before. For anchor resolution, segments sharing a
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

#### Scenario: A merged recording places words as its chunks did
- **WHEN** a three-chunk recording is merged into one segment with three seams and the
  transcript is regenerated
- **THEN** every word's `start_sec` equals, within 1 ms, the value it had when the three
  chunks were separate segments: words of the third chunk are anchored at that chunk's
  wall-clock delta from the start event, not at the merged file's running time

#### Scenario: A segment without seams is unchanged
- **WHEN** a session has only single-segment recordings and no `seams`
- **THEN** every word's position is identical to the output before this change


### Requirement: Segment grouping and concatenation
The pipeline SHALL classify each audio segment by **probing the blob bytes** (container +
actual track codec + stream parameters via the muxing library) — the stored `mime_type` is
a hint only, since the upload path constrains it solely to keep audio responses out of the
`/api/*` compression filter (any compressible or blank type degrades to `audio/webm`;
every other client-supplied type, including `application/octet-stream` and `video/*`, is
stored verbatim), and other segment writers persist their own producer-supplied types. No
stored `mime_type` therefore identifies the actual codec. Segments SHALL be
grouped by probed codec + stream parameters — Opus, AAC, PCM, FLAC families — and, per group,
concatenated by **packet copy without re-encoding** into a single container the provider
accepts: Opus groups into WebM, AAC groups into MP4, PCM groups into WAVE, FLAC groups into
FLAC (each copied frame's header renumbered to the variable-block-size form with its running
sample number and its CRCs recomputed, the audio bytes unchanged, so the file is conformant
RFC 9639 and decodes to exactly the concatenated samples). Segments within
a group SHALL be ordered by segment ordinal, and each segment's cumulative time offset
within the group file SHALL be recorded for timestamp remapping. Segments that are
unreadable, unparseable, or whose probed codec is outside the
supported families SHALL be **skipped** (the reconciliation posture used elsewhere), but a
segment whose blob is **missing** from the blob store SHALL fail the run with `502` and a
detail naming the segment (a listed row without bytes means a swap or restore is in
progress, never a stale legacy row, now that the media worker replaces rows only in one
transaction); a
stream-parameter mismatch within a codec family (sample rate, channel count, or a FLAC
bit depth) splits into a further sub-group rather than failing the run. One STT request SHALL be issued per resulting group. Concatenation
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

#### Scenario: FLAC session transcribes without re-encoding
- **WHEN** a session's segments are FLAC files (for example legacy WAVs converted to FLAC) with
  identical stream parameters
- **THEN** one combined FLAC file is produced by frame copy, it decodes to exactly the
  concatenation of the segments' samples, and it is sent with content type `audio/flac`

#### Scenario: A FLAC parameter change starts a new group
- **WHEN** consecutive FLAC segments differ in sample rate, channel count or bit depth
- **THEN** each run of identical parameters becomes its own group and request

#### Scenario: A missing blob fails the run instead of silently dropping audio
- **WHEN** a listed segment's blob is absent from the blob store
- **THEN** generation fails with `502` and a detail naming that segment, and no transcript
  is replaced
