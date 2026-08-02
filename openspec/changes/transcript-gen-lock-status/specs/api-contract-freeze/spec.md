# api-contract-freeze — delta

## ADDED Requirements

### Requirement: Transcript generation lock status endpoint
`GET /api/transcript-generation/status` SHALL be frozen surface with:

| Condition | Response |
|---|---|
| No generation run in flight | `200 { "in_flight": false }` |
| Generation run in flight | `200 { "in_flight": true, "session_id": string, "session_title": string\|null, "started_at": string }` |

`started_at` SHALL be ISO-8601 UTC. `session_title` SHALL be the catalog title at read
time or `null` if the session row is absent. The route MUST NOT mutate generation state.
Auth SHALL match sibling transcript list routes.

#### Scenario: Idle response shape
- **WHEN** the slot is free
- **THEN** the response is `200` with `in_flight` false

#### Scenario: Busy response shape
- **WHEN** the slot is held
- **THEN** the response is `200` with `in_flight` true and the busy fields populated as
  specified

## MODIFIED Requirements

### Requirement: Transcript generation endpoint behavior
`POST /api/sessions/:sessionId/transcript-words/generate` SHALL move from unconditional
`503` to configuration-dependent behavior, which becomes frozen surface on shipping:

| Condition | Response |
|---|---|
| `DEEPGRAM_API_KEY` unset/blank | `503 {detail}` — identical to the current unavailable response |
| configured, success | `200 {words: [...]}` — each word in the same enriched shape `GET …/transcript-words` returns (store fields plus `session_id`); `start_sec`/`end_sec` carry remapped session-timeline seconds (`0` for anchorless words); the array is the complete post-replace list in ordinal order |
| configured, session has no audio segments | `400 {detail}` |
| configured, segments exist but none is readable | `400 {detail}` (distinct detail) |
| configured, provider succeeds but returns zero words | `400 {detail}` (no-speech detail); existing words preserved |
| configured, another generation run in flight | `409 {detail}` whose detail names the busy session (title preferred, else id); no provider request issued |
| configured, request aborted before any provider call | `400 {detail}` — a distinct aborted detail, not `200`/`503`; no provider request issued |
| configured, upstream STT failure/timeout, or a group file over the provider size limit | `502 {detail}` |

Existing route semantics are otherwise unchanged: unknown session → the existing
`requireSession` behavior; the request body remains ignored/empty. No other transcription
surface changes — `GET/POST/PATCH/DELETE …/transcript-words`, `…/topics` CRUD, and
`transcribe.csv` (`503`) keep their current frozen behavior, except that
`GET /api/transcript-generation/status` is an additional authorized surface (see above).

#### Scenario: Unconfigured deployments are byte-for-byte unchanged
- **WHEN** a deployment without `DEEPGRAM_API_KEY` receives `POST
  /api/sessions/:id/transcript-words/generate`
- **THEN** the response status and body match the pre-change `503 {detail}` exactly

#### Scenario: Configured success returns the list shape
- **WHEN** a configured deployment successfully generates a transcript
- **THEN** the response is `200` with `{words}` whose entries match the shape of
  `GET /api/sessions/:id/transcript-words` entries

#### Scenario: Concurrent run maps to 409 naming the holder
- **WHEN** a generate request arrives while another run is already in flight
- **THEN** the response is `409 {detail}` that identifies the busy session, and no
  provider spend occurs for it

#### Scenario: Pre-provider-call abort maps to 400, not a new status code
- **WHEN** the originating HTTP request is already aborted before any DeepGram request
  would be issued
- **THEN** the response is `400 {detail}` with a detail distinct from the no-audio and
  all-unreadable `400` details, and no provider spend occurs

#### Scenario: Sibling stubs stay frozen
- **WHEN** a configured deployment receives `GET /api/sessions/:id/transcribe.csv`
- **THEN** it still responds with the current `503 {detail}`
