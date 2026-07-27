# api-contract-freeze Delta

## ADDED Requirements

### Requirement: Local audio import endpoint

The published inventory SHALL include
`POST /api/sessions/:sessionId/local-audio-import`. The request SHALL carry one
audio body (raw bytes) with a non-empty Content-Type, and a positive finite
`duration_s` query parameter not exceeding 86_400 seconds (24 hours). Success
SHALL be `200 { ok: true }`. Put/anchor failures SHALL roll back segment metadata
and SHALL NOT leave an anchored take for the failed attempt. Missing/invalid
`duration_s`, missing/blank Content-Type, or `duration_s` above the supported
maximum SHALL be `400 { detail }`. Oversized bodies SHALL be `413 { detail }`.

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

- **WHEN** the declared or read body size exceeds the audio upload cap
- **THEN** the response is `413 { detail }` and no audio segment is attached
