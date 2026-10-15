## ADDED Requirements

### Requirement: Recording finalize endpoint
The published inventory SHALL include
`POST /api/sessions/:sessionId/audio/recordings/:recordingOrdinal/finalize`. It is additive. It
SHALL require login and session access like the audio segment routes. `:recordingOrdinal` SHALL be
a positive safe integer, else `400 { detail }`; an unknown session SHALL be `404 { detail }`. The
JSON body `{ chunks: [started_at_utc, …] }` lists the windows the client recorded (1 to 1000
timestamps, else `400 { detail }`). On success it SHALL answer `200 { ok: true, merge: "queued" |
"not-needed" | "already-queued" | "waiting" }`: `not-needed` when the recording has fewer than
two segments, `already-queued` when a live merge job exists, `waiting` when a listed window is not
yet held by a segment or a seam, `queued` when it enqueued one. It SHALL not check the recording
lease. It SHALL change no segment row itself.

#### Scenario: Finalize queues one merge
- **WHEN** a client calls finalize twice for a recording with three segments, listing their three
  windows
- **THEN** the first answer is `200 { ok: true, merge: "queued" }`, the second
  `200 { ok: true, merge: "already-queued" }`, and one merge job exists

#### Scenario: Finalize waits for a straggler
- **WHEN** finalize lists four windows and the session holds three of them
- **THEN** the answer is `200 { ok: true, merge: "waiting" }` and no merge job exists

#### Scenario: A single-segment recording needs no merge
- **WHEN** a client finalizes a recording with one segment
- **THEN** the answer is `200 { ok: true, merge: "not-needed" }` and no job is created

### Requirement: Resumable audio upload endpoints
The published inventory SHALL include, all additive, under
`/api/sessions/:sessionId/audio/uploads`, requiring login and session access:
- `POST` with JSON `{ content_type, size_bytes, part_sha256 }`: `content_type` non-blank,
  `size_bytes` a positive integer not over 1500 MiB (else `413 { detail }`), `part_sha256` an
  array of exactly `ceil(size_bytes / part_size)` strings of 64 lowercase hex (else
  `400 { detail }`); answers `201 { upload_id, part_size, parts_total, expires_at_utc }` where
  `part_size` is the server's constant (32 MiB); a caller with 2 open uploads, or whose staged
  bytes would exceed 3 GiB, gets `429 { detail }`; a blob volume below the free-disk floor gets
  `507 { detail }`;
- `PUT /:uploadId/parts/:n` with a raw body: `n` is 1-based; every part except the last SHALL be
  exactly `part_size` bytes and the last exactly the remainder, else `400 { detail }`; a body
  whose sha256 differs from `part_sha256[n−1]` is `400 { detail }` and is not recorded; a body
  over `part_size` is `413 { detail }`; a part MAY be re-sent; an unknown, expired, aborted or
  completed upload is `404 { detail }`; low disk is `507 { detail }`; success is `204`;
- `GET /:uploadId`: `200 { upload_id, status, size_bytes, part_size, parts_total, received,
  expires_at_utc }` where `received` is the sorted array of part numbers stored;
- `POST /:uploadId/complete` in one of two modes, chosen by the query: **import mode** with the
  same `duration_s` query parameter and optional `X-Audio-Seam-Parts` header as
  `local-audio-import`, and the same `400` rules for them, attaching and anchoring one take and
  appending the seam parts; or **segment mode** with `recording_ordinal`, `started_at_utc` and
  `ended_at_utc`, storing one segment exactly as `POST …/audio/segments` does ("Segment upload is
  idempotent per recording window" included). In both: a missing part is `409 { detail,
  missing_parts }`; a size mismatch or a part whose re-hash differs from the declared list is
  `400 { detail }` and aborts the upload; in import mode a session that is actively recording is
  `409 { detail }`, checked before attach and re-checked after the file is placed (the re-check
  rolls the attempt back as `local-audio-import` does); success is `200 { ok: true, segment_id }`;
- `DELETE /:uploadId`: `204`, the staging removed; unknown is `404 { detail }`.

`local-audio-import` is unchanged.

#### Scenario: Inventory lists the upload family
- **WHEN** a client creates an upload, PUTs every part and completes it with a valid `duration_s`
- **THEN** every call is in-contract and the completion answers `200 { ok: true, segment_id }`

#### Scenario: A missing part blocks completion
- **WHEN** completion is requested with part 3 of 4 never received
- **THEN** the answer is `409 { detail, missing_parts: [3] }` and no segment is attached

#### Scenario: Oversized declarations are refused at creation
- **WHEN** `size_bytes` exceeds 1500 MiB
- **THEN** the answer is `413 { detail }` and no upload exists

#### Scenario: A part that does not match its hash is not kept
- **WHEN** part 2's body hashes to a value other than `part_sha256[1]`
- **THEN** the answer is `400 { detail }`, `GET` does not list part 2, and it can be re-sent

#### Scenario: An oversize live chunk completes in segment mode
- **WHEN** a client completes an upload with `recording_ordinal=3`, `started_at_utc` and
  `ended_at_utc` and no `duration_s`
- **THEN** one segment with `recording_ordinal` 3 exists, no take is anchored, and the answer is
  `200 { ok: true, segment_id }`

#### Scenario: Caps and low disk refuse before any byte is staged
- **WHEN** a user with two open uploads creates another, or the blob volume is below its
  free-disk floor
- **THEN** the answer is `429 { detail }` or `507 { detail }` respectively and no staging file
  exists for the request

### Requirement: Audio segments carry duration, media status and seams
Every audio segment dict returned by `GET` and `POST /api/sessions/:sessionId/audio/segments` SHALL
carry three additive fields: `duration_ms` (a non-negative integer, or `null` while unknown),
`media_status` (`"pending"`, `"done"`, `"failed"`, or `null` for rows that predate server-side
processing) and `seams` (`null`, or for a merged segment the array of `{ offset_ms,
started_at_utc, ended_at_utc }` in media order, one per original chunk). No existing field's
shape, order dependence or semantics changes; clients MUST tolerate the three fields. The
`audio.changed` WebSocket message keeps its shape and additionally fires when the server applies
a worker result (peaks, duration, a FLAC swap or a merge), so a client re-reads the list then;
its other emission points are unchanged.

#### Scenario: A fresh segment is pending, then done
- **WHEN** a chunk is uploaded and listed at once, then listed again after the worker processed it
- **THEN** the first dict has `media_status: "pending"`, `duration_ms: null` and `seams: null`, the
  second `media_status: "done"` and an integer `duration_ms`, and an `audio.changed` message was
  emitted between them

#### Scenario: A merged segment lists its seams
- **WHEN** a three-chunk recording has been merged and the list is read
- **THEN** the merged dict's `seams` has three entries whose `offset_ms` ascend from 0 and whose
  `started_at_utc` are the three chunks' windows

#### Scenario: Legacy rows are null
- **WHEN** a segment that predates this change is listed
- **THEN** its dict carries `duration_ms: null`, `media_status: null` and `seams: null` and every
  pre-existing field unchanged

### Requirement: Segment upload is idempotent per recording window
`POST /api/sessions/:sessionId/audio/segments` with a `recording_ordinal` and a parseable
`started_at_utc` SHALL store at most one segment per `(session, recording_ordinal,
started_at_utc)` window: when the session already holds that window, as a segment row or as a
seam of a merged segment, the request SHALL answer exactly as a successful upload does with the
dict of the segment that holds the window (the chunk, or the merged segment) and SHALL store no
bytes and no row; two concurrent uploads of the same window SHALL converge on one stored copy.
Uploads without a `recording_ordinal` are unchanged. The status code and the dict shape are the
same as for a new segment (clients cannot tell a replay from the first upload, and need not).

#### Scenario: A replayed chunk is not stored twice
- **WHEN** a chunk upload succeeds and the same bytes are posted again with the same
  `recording_ordinal` and `started_at_utc`
- **THEN** the second answer carries the first segment's dict, the list still has one segment for
  that window, and the blob directory holds one file for it

#### Scenario: A chunk already merged away answers with the merged segment
- **WHEN** a recovered chunk is posted after its window was merged into one segment
- **THEN** the answer carries the merged segment's dict and no new row or blob is created

#### Scenario: Two tabs race on one window
- **WHEN** two uploads of the same window arrive at once
- **THEN** one row and one blob exist afterwards and both answers carry that segment's dict
