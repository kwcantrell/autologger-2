## MODIFIED Requirements

### Requirement: Publish-date opt-in writes the session episode date via the catalog layer

When `use_publish_date` is true and the fetched video metadata carries a usable upload date,
the server SHALL set the session's `episode_date` through the **catalog** layer (the same
single-column session mutator seam used by archive/hide), not a per-session hub RPC —
`episode_date` is a catalog `sessions` column with no per-session-DB counterpart. The stored
value SHALL be a calendar date that the UI renders as the **intended day**: because the
client date formatter parses a bare `YYYY-MM-DD` as UTC midnight (which renders as the
previous day for negative-UTC-offset viewers), the change SHALL ensure the displayed date is
not shifted a day earlier. When `use_publish_date` is false, or the metadata carries no
usable date, `episode_date` SHALL be left unchanged. The episode-date write is best-effort: if
it fails after the audio is attached, the import SHALL still succeed, `episode_date` SHALL be
left unchanged, and a warning naming the session and the intended date SHALL be logged. The field's presence and type in the
session JSON response are unchanged (it was already a nullable field).

#### Scenario: Opt-in sets the episode date to the correct calendar day

- **WHEN** an import succeeds with `use_publish_date: true` and the video reports an upload
  date
- **THEN** the session's `episode_date` is set from that date and the UI displays the video's
  actual publish day (not one day earlier) regardless of viewer time zone

#### Scenario: Opt-out leaves the episode date untouched

- **WHEN** an import succeeds with `use_publish_date: false`
- **THEN** the import does not write `episode_date`

#### Scenario: Missing date is a no-op, not a failure

- **WHEN** `use_publish_date: true` but the metadata carries no usable upload date
- **THEN** the import still succeeds (audio is ingested) and `episode_date` is left unchanged

#### Scenario: A failed episode-date write does not fail the import

- **WHEN** an import with `use_publish_date: true` attaches its audio and the episode-date
  write then fails
- **THEN** the response is `200 {ok: true}`, the audio segment is attached once, and a warning
  names the session and the intended date
