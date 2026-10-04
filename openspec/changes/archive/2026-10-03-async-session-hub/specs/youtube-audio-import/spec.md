## ADDED Requirements

### Requirement: Downloaded audio is ingested as one supported-container segment through a transactional hub RPC

On a successful download the server SHALL attach the downloaded audio as **exactly one**
session audio segment, reusing the existing recorder ingestion path: a transactional hub RPC
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

#### Scenario: Segment metadata write stays a transactional hub RPC

- **WHEN** the segment metadata is recorded
- **THEN** it is written by one hub RPC inside a transaction, whose body awaits only its own
  transaction's statements, with the blob write performed in the router layer after the RPC
  returns

## REMOVED Requirements

### Requirement: Downloaded audio is ingested as a single supported-container segment

**Reason**: Its scenario "Segment metadata write stays a synchronous hub RPC" no longer holds: the
session hub becomes asynchronous (ADR 0021 slice 7a).

**Migration**: Replaced by "Downloaded audio is ingested as one supported-container segment through
a transactional hub RPC", which keeps every other sentence and scenario unchanged and requires a
transactional hub RPC whose body awaits only its own statements, with the blob write in the
router layer.
