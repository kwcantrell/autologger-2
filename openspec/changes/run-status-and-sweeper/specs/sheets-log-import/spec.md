## MODIFIED Requirements

### Requirement: Transcript required before sync

Before aligning log rows, the system SHALL use existing timed transcript words when
present; otherwise it SHALL attempt transcript generation via the existing
DeepGram-backed generate path (retrying once, after a short pause, on upstream or
in-flight generation errors). Generation SHALL be attempted only when the job's creator is an
approved user for run features (run-status-and-sweeper D9), as decided when the job was created;
otherwise the job SHALL record the progress line
`Skipped transcript generation: limited to approved users on this server.` for that session and
SHALL NOT claim a `transcript-generation` lease. If no timed transcript is available afterward, that
session’s import SHALL fail.

#### Scenario: Missing transcript is generated before sync

- **WHEN** a matched session has no timed transcript words, the job's creator is an approved user,
  and the DeepGram generate path produces words with usable timing
- **THEN** the job reports transcript generation in its progress lines and sync
  proceeds against the generated words

#### Scenario: Generation failure fails only that session

- **WHEN** transcript generation fails for a matched session (including after
  the single retry for upstream/in-flight errors) or yields no words with
  usable timing
- **THEN** that session’s import fails with an operator-readable progress line
  and the job continues with the remaining sheets

#### Scenario: A creator who is not approved skips generation

- **WHEN** a matched session has no timed transcript words and the job's creator is not an approved
  user for run features
- **THEN** the job records the skip line for that session, claims no `transcript-generation`
  lease, fails that session's import, and continues with the remaining sheets
