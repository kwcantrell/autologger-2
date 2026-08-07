## ADDED Requirements

### Requirement: Public Sheets workbook ingest

The system SHALL accept a Google Sheets URL for a workbook shared as
anyone-with-the-link and SHALL fetch an XLSX export of that workbook server-side
without requiring Google Sheets OAuth scopes. Rows for import SHALL start at
row 7 (1-based). A row SHALL be imported when column A is non-empty. Column A is
the sheet timecode, column B the message, column C an optional event type.

#### Scenario: Unreachable or private workbook fails the job

- **WHEN** the server cannot download a usable XLSX for the given URL
- **THEN** the log-import job fails with an operator-readable `{ detail }` (or
  per-job error field) and creates no events

### Requirement: Sheet-to-session title match

For the show selected in Batch Import, the system SHALL match a spreadsheet sheet
name to a session when `trim(sheet.name) === trim(session.title)`. Unmatched
sheets SHALL be reported as skipped in job progress and SHALL NOT fail the whole
job by themselves.

#### Scenario: Matching sheet imports into that session

- **WHEN** a sheet named `HD_385` exists and a session for the selected show has
  `title` `HD_385`
- **THEN** log rows from that sheet are considered for that session

### Requirement: Transcript required before sync

Before aligning log rows, the system SHALL use existing timed transcript words when
present; otherwise it SHALL attempt transcript generation via the existing
DeepGram-backed generate path (retrying once, after a short pause, on upstream or
in-flight generation errors). If no timed transcript is available afterward, that
session’s import SHALL fail.

#### Scenario: Missing transcript is generated before sync

- **WHEN** a matched session has no timed transcript words and the DeepGram
  generate path produces words with usable timing
- **THEN** the job reports transcript generation in its progress lines and sync
  proceeds against the generated words

#### Scenario: Generation failure fails only that session

- **WHEN** transcript generation fails for a matched session (including after
  the single retry for upstream/in-flight errors) or yields no words with
  usable timing
- **THEN** that session’s import fails with an operator-readable progress line
  and the job continues with the remaining sheets

### Requirement: Score-based per-seam sync

The system SHALL compute a sync offset per audio seam part using scored
transcript↔message alignment (exact and near token matches). Part 0 SHALL require
at least one solid match. Later parts SHALL require corroborated decent-or-better
matches within a 60-second offset agreement, or a single solid match. Failure of
these rules SHALL fail that session’s import (no partial silent offset-0 import).

Sheet timecodes SHALL be interpreted with frame 0. Offset SHALL be
`transcript_time − sheet_time`; imported session time SHALL be `sheet_time + offset`.

#### Scenario: Solid five-word match sets part-0 offset

- **WHEN** a log message shares five consecutive exact transcript tokens near the
  sheet time
- **THEN** that candidate is solid and its offset is used for part 0

### Requirement: Category mapping from column C

Blank column C SHALL map to the show category named OTHER (case-insensitive).
Unmatched non-blank C SHALL map to OTHER and append ` - {C}` to the message.
DROPDOWN/ON_OFF types SHALL match option labels; BUTTON/TEXT SHALL match category
name; longest matching candidate wins. Message body SHALL be full column B
(except the unmatched append). Matched dropdown/on_off option SHALL be stored in
event metadata as `import_option`.

#### Scenario: Missing OTHER category fails the session

- **WHEN** the show has no category named OTHER
- **THEN** that session’s import fails with a clear error

### Requirement: Duplicate skip

When creating an imported event, the system SHALL skip creation if a non-internal
event already exists with the same message and the same `timecode_total_frames`.
The comparison uses the post-mapping message (after any unmatched-type append)
and the exact frame value computed for the row; skipped duplicates are counted
in the session’s summary progress line.

#### Scenario: Exact frame-and-message duplicate is skipped

- **WHEN** an import row maps to message M at `timecode_total_frames` F and a
  non-internal event with message M at exactly F already exists on the session
- **THEN** no new event is created for that row and the summary line’s skipped
  count includes it

### Requirement: Configuration and network gating

`POST /api/shows/:showId/log-import` SHALL be configuration-gated: unless
`SHEETS_LOG_IMPORT_ENABLED` is `1`, `true`, or `yes` (trimmed,
case-insensitive), the route SHALL respond `503 { detail }` with detail
"Google Sheets log import is not configured on this deployment. Set
SHEETS_LOG_IMPORT_ENABLED=1 to enable it." before any body parsing, job
creation, or egress. When configured, the route SHALL apply the shared
open-network refusal predicate (server bound to a non-loopback address with
`REQUIRE_LOGIN` disabled and no `IP_ALLOWLIST`) and respond `503 { detail }` —
a run can trigger paid DeepGram transcription, so the endpoint shares the
spend-per-request posture of youtube-import. Check ordering follows
youtube-import: show/membership `404` first, then the configuration gate, then
the open-network refusal, then body validation. `GET /api/log-import/:jobId`
SHALL NOT be egress-gated — it reads only local in-process state.

#### Scenario: Unconfigured deployment refuses before any egress

- **WHEN** `SHEETS_LOG_IMPORT_ENABLED` is unset and an authorized client POSTs
  a log-import request for an existing show
- **THEN** the response is `503 { detail }` naming `SHEETS_LOG_IMPORT_ENABLED`
  and no fetch is issued and no job is created

#### Scenario: Open-network deployment refuses even when configured

- **WHEN** the deployment sets `SHEETS_LOG_IMPORT_ENABLED=1` but is bound to a
  non-loopback address with `REQUIRE_LOGIN` disabled and no `IP_ALLOWLIST`
- **THEN** the POST responds `503 { detail }` and no job is created

### Requirement: Job authorization and lifecycle

`POST /api/shows/:showId/log-import` SHALL respond `404 { detail: "Show not
found." }` uniformly for a nonexistent show and for an authenticated requester
who is not a member of the show’s studio (no existence oracle); anonymous
requesters (`user == null`: `REQUIRE_LOGIN=0` dev mode, or API-token auth)
pass, as on sibling routes. `GET /api/log-import/:jobId` SHALL be
creator-scoped: an authenticated requester who did not create the job receives
the same `404 { detail: "Log import job not found." }` as an unknown id. Job
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

### Requirement: Log-import job HTTP surface

The system SHALL expose:

- `POST /api/shows/:showId/log-import` with JSON `{ spreadsheet_url }` returning
  `{ job_id }` on acceptance
- `GET /api/log-import/:jobId` returning job status, progress lines (including
  per-part offset/confidence when available), and a nullable `error` string

#### Scenario: Unknown job id

- **WHEN** a client GETs an unknown job id
- **THEN** the response is `404` with `{ detail }`
