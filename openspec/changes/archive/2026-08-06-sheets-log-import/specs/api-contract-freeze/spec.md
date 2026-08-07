## ADDED Requirements

### Requirement: Show-scoped log-import job endpoints

The published HTTP contract SHALL include:

- `POST /api/shows/:showId/log-import` — body `{ spreadsheet_url: string }`;
  success `200 { job_id: string }`; validation/authorization failures use
  `{ detail }` with appropriate 4xx. Missing show AND an authenticated
  requester without membership of the show's studio both get the uniform
  `404 { detail: "Show not found." }` (no existence oracle). The route is
  configuration-gated: unless `SHEETS_LOG_IMPORT_ENABLED` is `1`/`true`/`yes`
  (trimmed, case-insensitive) it responds `503 { detail }` with detail
  "Google Sheets log import is not configured on this deployment. Set
  SHEETS_LOG_IMPORT_ENABLED=1 to enable it."; when configured, the shared
  open-network refusal predicate applies next (`503 { detail }`), in the
  youtube-import ordering (membership 404 → config gate → open-network
  refusal → body validation).
- `GET /api/log-import/:jobId` — success `200` with a JSON job status object
  including at least `status` (`queued`|`running`|`completed`|`failed`),
  `lines` (string array progress), and `error` (string or null). The route is
  creator-scoped: unknown job ids and jobs created by a different
  authenticated user both get the uniform
  `404 { detail: "Log import job not found." }`. It is NOT egress-gated
  (local in-process state only). Terminal jobs are prunable one hour after
  finishing and the in-memory job map is capped at 200 entries (oldest
  terminal evicted first; queued/running jobs never evicted), so a terminal
  job's status is only promised for about an hour after it finishes.

These endpoints are additive. Existing event POST/PUT shapes remain unchanged;
imported events are created server-side by the job (not via a new public
create-at-arbitrary-timecode client endpoint in this change).

#### Scenario: POST accepts a spreadsheet URL and returns a job id

- **WHEN** an authorized client POSTs a non-empty `spreadsheet_url` for an
  existing show on a configured, non-open deployment
- **THEN** the response is `200 { job_id }` and a subsequent GET for that id by
  the same requester is not `404`

#### Scenario: Unconfigured deployment is 503

- **WHEN** `SHEETS_LOG_IMPORT_ENABLED` is unset/blank and an authorized client
  POSTs to log-import for an existing show
- **THEN** the response is `503 { detail }` naming `SHEETS_LOG_IMPORT_ENABLED`
  and no job is created

#### Scenario: Non-creator status read is a uniform 404

- **WHEN** an authenticated user GETs a log-import job created by another user
- **THEN** the response is `404 { detail: "Log import job not found." }`,
  byte-identical to the unknown-id response
