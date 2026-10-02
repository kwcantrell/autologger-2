## REMOVED Requirements

### Requirement: Configuration and network gating

**Reason**: Its open-network refusal applied only with `REQUIRE_LOGIN` disabled, a
non-loopback bind and no `IP_ALLOWLIST`. `REQUIRE_LOGIN` is removed and login is always
required, so the refusal can no longer happen and is deleted. The configuration gate is
unchanged and is restated under "Log import is configuration-gated".

**Migration**: None for clients. The open-network `503` detail is never returned; a caller
needs a signed-in session (see `api-contract-freeze` "Login is required on every API route").

## ADDED Requirements

### Requirement: Log import is configuration-gated

`POST /api/shows/:showId/log-import` SHALL be configuration-gated: unless
`SHEETS_LOG_IMPORT_ENABLED` is `1`, `true`, or `yes` (trimmed,
case-insensitive), the route SHALL respond `503 { detail }` with detail
"Google Sheets log import is not configured on this deployment. Set
SHEETS_LOG_IMPORT_ENABLED=1 to enable it." before any body parsing, job
creation, or egress. Check ordering follows youtube-import: show/membership
`404` first, then the configuration gate, then body validation. The route SHALL NOT have any
network-posture refusal. `GET /api/log-import/:jobId` SHALL NOT be egress-gated — it reads
only local in-process state.

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

## MODIFIED Requirements

### Requirement: Job authorization and lifecycle

`POST /api/shows/:showId/log-import` SHALL respond `404 { detail: "Show not
found." }` uniformly for a nonexistent show and for a signed-in requester
who is not a member of the show’s studio (no existence oracle). Every job
records the signed-in user who created it. `GET /api/log-import/:jobId` SHALL be
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
