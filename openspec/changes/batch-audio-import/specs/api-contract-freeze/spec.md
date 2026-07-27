# api-contract-freeze Delta

## ADDED Requirements

### Requirement: Local audio import endpoint

The published inventory SHALL include
`POST /api/sessions/:sessionId/local-audio-import`. The request SHALL carry one
audio body (raw bytes) with a Content-Type, and a positive finite `duration_s`
query parameter. Success SHALL be `200 { ok: true }`. Put/anchor failures SHALL
roll back segment metadata and SHALL NOT leave an anchored take for the failed
attempt. Missing/invalid `duration_s` SHALL be `400 { detail }`.

#### Scenario: Inventory lists local-audio-import

- **WHEN** a client calls `POST /api/sessions/:sessionId/local-audio-import` with a
  valid audio body and `duration_s` on an existing session
- **THEN** the call is in-contract and succeeds with `200 { ok: true }` when
  attach+anchor succeeds

#### Scenario: Missing duration is rejected

- **WHEN** the request omits `duration_s` or supplies a non-positive value
- **THEN** the response is `400 { detail }` and no audio segment is attached
