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
records live in process memory: terminal (completed/failed) jobs SHALL become
prunable one hour after finishing, and the job map SHALL be capped at 200
entries with the oldest terminal jobs evicted first — queued/running jobs are
NEVER evicted (the map may transiently exceed the cap rather than orphan a
live import’s status).

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

- **WHEN** the job map is at its 200-entry cap and holds running jobs
- **THEN** only terminal jobs are evicted; no queued or running job is removed

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
