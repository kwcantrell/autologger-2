# api-contract-freeze Delta

## ADDED Requirements

### Requirement: Local audio import endpoint

The published inventory SHALL include
`POST /api/sessions/:sessionId/local-audio-import`. The request SHALL carry one
audio body (raw bytes) with a non-empty Content-Type, and a positive finite
`duration_s` query parameter not exceeding 86_400 seconds (24 hours). The
request MAY carry an `X-Audio-Seam-Parts` header: a JSON array of
`{ duration_s }` objects, each `duration_s` positive finite, whose sum is
within 0.5 s of the query `duration_s`; a malformed header (non-JSON, not a
non-empty array, non-object entries, non-positive/non-finite durations) or a
sum mismatch SHALL be `400 { detail }`; an absent/blank header defaults to one
part equal to `duration_s`. Accepted parts are persisted by APPENDING to any
seam parts stored by earlier imports on the session (the persisted list
describes the session's full audio timeline across takes, in take order).
Success SHALL be `200 { ok: true }`. An import arriving while the session is
actively recording SHALL be `409 { detail }`; the rolling state is checked
before attach and re-checked after the blob put, and the post-put re-check
rolls the attempt back. Put failures SHALL roll back the segment metadata row;
failures after a successful put (late rolling re-check, anchor failure) SHALL
roll back BOTH the metadata row and the stored blob (row first, blob delete
best-effort), and SHALL NOT leave an anchored take for the failed attempt. Missing/invalid `duration_s`,
missing/blank Content-Type, or `duration_s` above the supported maximum SHALL
be `400 { detail }`. Bodies over `MAX_LOCAL_AUDIO_IMPORT_BYTES` (1500 MiB —
the endpoint's own cap, deliberately higher than the 50 MB live segment
upload cap) SHALL be `413 { detail }`, enforced identically (same `{ detail }`
string) whether tripped by the declared Content-Length, mid-stream during the
counted body read (chunked bodies / lying Content-Lengths never buffer past
the cap), or the post-read backstop.

#### Scenario: Inventory lists local-audio-import

- **WHEN** a client calls `POST /api/sessions/:sessionId/local-audio-import` with a
  valid audio body and `duration_s` on an existing session
- **THEN** the call is in-contract and succeeds with `200 { ok: true }` when
  attach+anchor succeeds

#### Scenario: Missing duration is rejected

- **WHEN** the request omits `duration_s` or supplies a non-positive value
- **THEN** the response is `400 { detail }` and no audio segment is attached

#### Scenario: Missing Content-Type is rejected

- **WHEN** the request omits `Content-Type` or supplies a blank value
- **THEN** the response is `400 { detail }` and no audio segment is attached

#### Scenario: Oversized body is rejected

- **WHEN** the declared or read body size exceeds the 1500 MiB
  local-audio-import cap — including a chunked body with no Content-Length
  whose stream crosses the cap mid-read
- **THEN** the response is `413 { detail }` and no audio segment is attached

#### Scenario: Malformed seam-parts header is rejected

- **WHEN** the request carries an `X-Audio-Seam-Parts` header that is not a
  non-empty JSON array of positive-finite `{ duration_s }` objects, or whose
  durations do not sum to within 0.5 s of `duration_s`
- **THEN** the response is `400 { detail }` and no audio segment is attached

#### Scenario: Rolling session is rejected

- **WHEN** the session is actively recording when the import arrives, or starts
  recording between the blob put and the anchor
- **THEN** the response is `409 { detail }` and the attempt leaves no segment
  row or anchored take; the stored blob is deleted best-effort (rollback never
  masks the original failure, and never leaves a row pointing at a missing blob)
