## MODIFIED Requirements

### Requirement: Generation lock status is observable
The deployment SHALL expose `GET /api/transcript-generation/status` that reports whether
a transcript generation run is in flight anywhere in the deployment. Auth SHALL match sibling
transcript routes (same middleware / login gate as `GET …/transcript-words`). The response SHALL
be:

| Condition | Body |
|---|---|
| No run in flight | `{ "in_flight": false }` |
| Run in flight | `{ "in_flight": true, "session_id": <string\|null>, "session_title": <string\|null>, "started_at": "<ISO-8601 UTC>" }` |

Several sessions may generate at once, so the status SHALL name one run: the live
`transcript-generation` run lease with the earliest `started_at_ms` (ties broken by session id)
across every process sharing the database and every team. The read SHALL be a system read, so
row-level security does not hide other teams' runs (run-status-and-sweeper D5). A lease whose
`started_at_ms` is null (written before that column existed) SHALL NOT be reported.

The holder may therefore belong to a session the requester
cannot access. For a requester without access to the holding session's show (not a
member of its studio, or a member without a grant for the show; team-management "Member
content access"), `session_id` and `session_title` SHALL both be `null` while `in_flight`
stays `true` — the same key set with null values, never absent keys. A requester with
access to the holding session's show sees the full identifiers, matching the access
rule every sibling route applies (sibling-route parity). For a permitted requester, `session_id` SHALL be the
holder's session id and `session_title` SHALL be the catalog session title at
the time of the status read, or `null` if no session row exists for
`session_id`. `started_at` SHALL be the UTC instant of the lease's `started_at_ms`, the time the
current run claimed it. The endpoint MUST NOT start, stop, or otherwise mutate
generation.

#### Scenario: Idle status
- **WHEN** no live `transcript-generation` run lease exists in the deployment
- **THEN** `GET /api/transcript-generation/status` responds `200` with
  `{ "in_flight": false }` and MUST NOT include busy-only fields as required true values

#### Scenario: Busy status names the holder for a permitted requester
- **WHEN** a generation run for session S is in flight, the catalog row for S has title T,
  and the requester can access S's show
- **THEN** `GET /api/transcript-generation/status` responds `200` with `in_flight: true`,
  `session_id` equal to S, `session_title` equal to T, and a parseable UTC `started_at`

#### Scenario: Non-member sees redacted busy status
- **WHEN** a generation run for session S is in flight and the requester cannot access S's
  show (not a member of S's studio, or a member without a grant for S's show)
- **THEN** the response is `200` with `in_flight: true`, `session_id: null`,
  `session_title: null`, and the real `started_at` — busy-ness stays truthful, the
  holder's identifiers do not leak across tenants

#### Scenario: Missing catalog title is null
- **WHEN** a generation run is in flight for session S, no catalog row exists for S, and
  the requester is permitted to view S
- **THEN** the busy response includes `session_title: null` and still includes `session_id`
  and `started_at`

#### Scenario: The earliest of several runs is named
- **WHEN** session S started generating through process A, session R then started generating
  through process B sharing the database, and a member of both shows reads the status through B
- **THEN** the response names S with S's start time

#### Scenario: A finished run stops being reported
- **WHEN** runs for sessions S and then R are in flight, and S's run releases its lease (or the
  lease expires) while R's run is still live
- **THEN** the status names R

### Requirement: Single-flight generation
At most one generation run SHALL execute per session at a time, across every process sharing the
database (its `transcript-generation` session lease, ADR 0021 slice 8b). Runs for different
sessions SHALL run concurrently: on `AI_PROVIDER=claude_cli` there is no process-wide or
deployment-wide ceiling (run-status-and-sweeper D3). A generate request for a session that already
has a run in flight, in this process or another, SHALL respond `409` with an actionable detail and
MUST NOT issue a provider request. The `409` detail SHALL name the session (catalog title when
available, otherwise the session id) and the run's start time when the requester is permitted to
view that session (can access its show): a refusal in this process reads the start time from the
in-process per-session run registry, and a refusal by another process's lease reads the live
lease's `started_at_ms`. For a requester without that access — and for the race where the run's
lease is no longer live, or carries no start time, when the refusal is mapped, leaving nothing to
name — the detail SHALL fall back to the identifier-free generic in-flight detail
(`GENERATION_IN_FLIGHT_DETAIL`). Status stays `409` either way. Before issuing the provider request, the pipeline
SHALL check whether the originating HTTP request has been aborted and, if so, abandon the
run without provider spend, responding `400` with a detail distinct from the other `400`
conditions (no-audio, all-unreadable, no-speech) — **not** an unauthorized status code
outside the api-contract-freeze table (gate decision 2026-07-14). A run whose client
disconnects after the provider request was issued SHALL still complete server-side (words
persist; a later `GET …/transcript-words` shows them). While a run is in flight, the
deployment SHALL expose a holder via `GET /api/transcript-generation/status` (see
Generation lock status is observable).

#### Scenario: Concurrent generate is rejected cheaply
- **WHEN** a second generate request for a session arrives while a run for that session is already
  in flight
- **THEN** it receives `409` and no additional provider request is made

#### Scenario: Concurrent 409 detail names the busy session
- **WHEN** a generate request for session S arrives while a run for S titled T is in flight in this
  process, and the requester can access S's show
- **THEN** the `409` `{detail}` string includes T (or S if no title) and the run's start time, so
  an operator can identify the holder without calling status

#### Scenario: Concurrent 409 for a non-member is identifier-free
- **WHEN** a requester without access to S's show (a non-member of S's studio, or a member without
  a grant for S's show) requests generation for S while a run for S is in flight
- **THEN** the route's existing session access check answers it before any `409` or provider
  request, so no session id or title is named

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
- **WHEN** another process holds a live `transcript-generation` lease for session S whose
  `started_at_ms` is null (written before that column existed), or the lease stops being live
  between the refused claim and the error mapping, and a member of S's show requests generation
  for S through this process, whose registry has no run for S
- **THEN** the response is `409` with the generic in-flight `{detail}`, no provider request is
  made, and this process's registry has no run for S afterwards

#### Scenario: A run in another process is refused naming the session
- **WHEN** another process holds a live `transcript-generation` lease for session S titled T with
  a start time, and a member of S's show requests generation for S through this process
- **THEN** the response is `409` with a `{detail}` that includes T and that start time, and no
  provider request is made

#### Scenario: Two sessions generate at once
- **WHEN** a run for session S is in flight, and a member requests generation for session R through
  the same process or another
- **THEN** R's request is not refused with `409`, and both runs complete
