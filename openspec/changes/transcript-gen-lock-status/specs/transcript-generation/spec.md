# transcript-generation — delta

## ADDED Requirements

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

## MODIFIED Requirements

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
