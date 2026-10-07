## MODIFIED Requirements

### Requirement: Show-scoped log-import job endpoints

The published HTTP contract SHALL include:

- `POST /api/shows/:showId/log-import` — body `{ spreadsheet_url: string }`;
  success `200 { job_id: string }`; validation/authorization failures use
  `{ detail }` with appropriate 4xx. Missing show AND an authenticated
  requester without access to the show (not a member of the show's studio, or a
  member without a grant for the show) get the uniform
  `404 { detail: "Show not found." }` (no existence oracle). The route is
  configuration-gated: unless `SHEETS_LOG_IMPORT_ENABLED` is `1`/`true`/`yes`
  (trimmed, case-insensitive) it responds `503 { detail }` with detail
  "Google Sheets log import is not configured on this deployment. Set
  SHEETS_LOG_IMPORT_ENABLED=1 to enable it."; the checks run in the order
  access 404 → config gate → body validation.
- `GET /api/log-import/:jobId` — success `200` with a JSON job status object
  including at least `status` (`queued`|`running`|`completed`|`failed`),
  `lines` (string array progress), and `error` (string or null). The route is
  creator-scoped: unknown job ids and jobs created by a different user both
  get the uniform
  `404 { detail: "Log import job not found." }`. It is NOT egress-gated (it
  reads only the job record in the catalog). Any server process sharing the
  database SHALL answer it (ADR 0021 slice 9b). A terminal job's record expires
  one hour after it finishes, so its status is only promised for about an hour.
  A `queued` or `running` job whose process stopped heartbeating more than 60 s
  ago SHALL be reported `failed` with `error`
  `"The server running this import stopped."`.

These endpoints are additive. Existing event POST/PUT shapes remain unchanged;
imported events are created server-side by the job (not via a new public
create-at-arbitrary-timecode client endpoint in this change).

#### Scenario: POST accepts a spreadsheet URL and returns a job id

- **WHEN** an authorized client POSTs a non-empty `spreadsheet_url` for an
  existing show on a configured deployment
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

#### Scenario: A member without a grant gets the show 404
- **WHEN** a member of the show's studio who holds no grant for the show POSTs a log import, on a
  configured or an unconfigured deployment
- **THEN** the response is `404 { detail: "Show not found." }`, byte-identical to the unknown-show
  response, and no job is created

#### Scenario: Another process answers the status poll
- **WHEN** a job started through process A is polled through process B
- **THEN** process B returns the job's current `{status, lines, error}`

#### Scenario: A job whose process stopped reads as failed
- **WHEN** a job is `running` and its process stops heartbeating for more than 60 s
- **THEN** a poll returns `status: "failed"` with `error: "The server running this import stopped."`
  and the lines written so far
