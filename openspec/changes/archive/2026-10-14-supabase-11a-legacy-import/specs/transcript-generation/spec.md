## MODIFIED Requirements

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
missing from the blob store, unreadable, unparseable, or whose probed codec is outside the
supported families SHALL be **skipped** (the reconciliation posture used elsewhere); a
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
