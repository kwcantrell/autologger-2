## MODIFIED Requirements

### Requirement: Job authorization and lifecycle

`POST /api/shows/:showId/log-import` SHALL respond `404 { detail: "Show not
found." }` uniformly for a nonexistent show and for a signed-in requester
who cannot access the show — not a member of the show’s studio, or a member
without a grant for the show (team-management "Member content access") — so
there is no existence oracle. Every job records the signed-in user who created
it, and SHALL re-check that user's access to the show before each sheet it
imports: when access is lost, the job appends `Access revoked; stopping.`, ends
`failed` with error `Access revoked.`, and imports no further sheet; events
already written stay. `GET /api/log-import/:jobId` SHALL be
creator-scoped: any requester other than the job's creator receives the same `404 { detail: "Log import job not found." }` as an unknown id. Job
records live in the catalog's key-value store (ADR 0021 slice 9b), so any server
process sharing the database can report a job: a terminal (completed/failed) job
SHALL expire one hour after finishing, and a queued/running job SHALL NOT expire
while its process keeps heartbeating (every 10 s). A queued/running job whose
heartbeat is more than 60 s old SHALL be reported `failed` with error
`The server running this import stopped.`, and that report SHALL be final: the job's record is
switched to `failed` with a compare-and-swap, and a runner that finds its record changed stops
importing; the sheets it already imported stay.

#### Scenario: Non-member POST looks like a missing show

- **WHEN** an authenticated user who is not a member of the show’s studio POSTs
  a log-import request for that show
- **THEN** the response is `404 { detail: "Show not found." }`, identical to a
  nonexistent show id

#### Scenario: Foreign job id is a uniform 404

- **WHEN** an authenticated user GETs a job id created by a different user
- **THEN** the response is `404 { detail: "Log import job not found." }`,
  identical to an unknown id

#### Scenario: Running jobs survive the size cap

- **WHEN** a running job keeps heartbeating past 2 h (its record's initial expiry), however many
  other jobs exist (the size cap was removed)
- **THEN** its record is still readable and reports `running`

#### Scenario: A job whose process stopped reads as failed

- **WHEN** a job's process stops while the job is `running`, and 61 s pass
- **THEN** a poll reports `failed` with error `The server running this import stopped.` and the
  lines written before the stop

#### Scenario: A member without a grant looks like a missing show

- **WHEN** a member of the show’s studio who holds no grant for the show POSTs a
  log-import request for it
- **THEN** the response is `404 { detail: "Show not found." }`, identical to a
  nonexistent show id, and no job is created

#### Scenario: A caller with access gets a job

- **WHEN** a caller who can access the show (its team's owner or an admin, or a
  member with a grant for it) POSTs a log-import request on a configured deployment
- **THEN** the response is `200 { job_id }`

#### Scenario: Losing access stops the job

- **WHEN** the creator's grant is revoked while the job is between two sheets
- **THEN** the job stops with the line `Access revoked; stopping.` and status
  `failed`, and the earlier sheet's events remain

### Requirement: Log import is configuration-gated

`POST /api/shows/:showId/log-import` SHALL be configuration-gated: unless
`SHEETS_LOG_IMPORT_ENABLED` is `1`, `true`, or `yes` (trimmed,
case-insensitive), the route SHALL respond `503 { detail }` with detail
"Google Sheets log import is not configured on this deployment. Set
SHEETS_LOG_IMPORT_ENABLED=1 to enable it." before any body parsing, job
creation, or egress. Check ordering follows youtube-import: show/membership
`404` first, then the configuration gate, then body validation. The route SHALL NOT have any
network-posture refusal. `GET /api/log-import/:jobId` SHALL NOT be egress-gated — it reads
only the job record in the catalog.

#### Scenario: Unconfigured deployment refuses before any egress

- **WHEN** `SHEETS_LOG_IMPORT_ENABLED` is unset and an authorized client POSTs
  a log-import request for an existing show
- **THEN** the response is `503 { detail }` naming `SHEETS_LOG_IMPORT_ENABLED`
  and no fetch is issued and no job is created

#### Scenario: Non-loopback bind without an allowlist is not refused

- **WHEN** the deployment sets `SHEETS_LOG_IMPORT_ENABLED=1`, is bound to a non-loopback
  address with no `IP_ALLOWLIST`, and a signed-in member of the show's studio POSTs a
  valid request
- **THEN** no network-posture `503` is returned, and the response is `200 { job_id }`
