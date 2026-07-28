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
DeepGram-backed generate path. If no timed transcript is available afterward, that
session’s import SHALL fail.

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

### Requirement: Log-import job HTTP surface

The system SHALL expose:

- `POST /api/shows/:showId/log-import` with JSON `{ spreadsheet_url }` returning
  `{ job_id }` on acceptance
- `GET /api/log-import/:jobId` returning job status and progress lines (including
  per-part offset/confidence when available)

#### Scenario: Unknown job id

- **WHEN** a client GETs an unknown job id
- **THEN** the response is `404` with `{ detail }`
