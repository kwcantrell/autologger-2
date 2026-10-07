## MODIFIED Requirements

### Requirement: Single-flight generation
At most one generation run SHALL execute per process at a time, and at most one per
session: a generate request arriving while another run is in flight (same or different
session) SHALL respond `409` with an actionable detail and MUST NOT issue a provider
request. The `409` detail SHALL name the session that holds the lock (catalog title when
available, otherwise the session id) when the requester is permitted to view that session
(can access the holder's show); for a requester without that access —
and for the race where the holder released the lock between the failed acquire and error
mapping, leaving nothing to check access against — the detail SHALL fall back to the
identifier-free generic in-flight detail (`GENERATION_IN_FLIGHT_DETAIL`). A run of the same
session in another process sharing the database (its `transcript-generation` session lease,
ADR 0021 slice 8b) SHALL also be refused with `409` and the generic in-flight detail, because the
process lock has no holder to name. Status stays `409` either way. Before issuing the provider request, the pipeline
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
  the requester can access S's show
- **THEN** the `409` `{detail}` string includes T (or S if no title) so an operator can
  identify the holder without calling status

#### Scenario: Concurrent 409 for a non-member is identifier-free
- **WHEN** a generate request from a requester without access to S's show (a non-member of
  S's studio, or a member without a grant for S's show) arrives while a run for S is in flight (or the holder released in the race before error mapping)
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

#### Scenario: A run in another process is refused with the generic detail
- **WHEN** another process holds a live `transcript-generation` lease for session S, and a member
  of S's show requests generation for S through this process, whose lock is free
- **THEN** the response is `409` with the generic in-flight `{detail}`, no provider request is
  made, and this process's lock is free afterwards
