## MODIFIED Requirements

### Requirement: Transcript required before sync

Before aligning log rows, the system SHALL use existing timed transcript words when present.
Otherwise it SHALL attempt transcript generation via the existing DeepGram-backed generate path,
retrying once, after a short pause, on upstream or in-flight generation errors.

Generation SHALL use the job creator's speech-to-text credential, as provider-credentials "Work
runs on its user's credentials" resolves it, including the fallback in development mode. The
credential is read when the session's generation starts, so a key the creator saves or removes
while the job runs applies to the sessions not yet started.

Generation SHALL be attempted only when the job's creator is an approved user for run features
(run-status-and-sweeper D9), as decided when the job was created. Otherwise the job SHALL record
the progress line `Skipped transcript generation: limited to approved users on this server.` for
that session and SHALL NOT claim a `transcript-generation` lease.

When the creator is approved but has no usable credential, the job SHALL record the progress line
`Skipped transcript generation: add a speech-to-text key in Settings → Advanced.` for that session
and SHALL NOT claim a lease. The approval check comes first, so a session gets at most one of
the two skip lines.

If no timed transcript is available afterward, that session's import SHALL fail.

#### Scenario: Missing transcript is generated before sync

- **WHEN** a matched session has no timed transcript words, the job's creator is an approved user
  with a speech-to-text credential, and the DeepGram generate path produces words with usable
  timing
- **THEN** the job reports transcript generation in its progress lines, the DeepGram request
  carries the creator's key, and sync proceeds against the generated words

#### Scenario: A creator who is not approved skips generation

- **WHEN** a matched session has no timed transcript words and the job's creator is not an approved
  user for run features
- **THEN** the job records the skip line for that session, claims no `transcript-generation`
  lease, fails that session's import, and continues with the remaining sheets

#### Scenario: A creator without a key is told where to add one

- **WHEN** in production mode a matched session has no timed transcript words and the job's creator
  has no speech-to-text credential
- **THEN** the job records the add-a-key progress line for that session, makes no DeepGram
  request, and that session's import fails while the job continues with the remaining sheets

#### Scenario: Generation failure fails only that session

- **WHEN** transcript generation fails for a matched session (including after
  the single retry for upstream/in-flight errors) or yields no words with
  usable timing
- **THEN** that session's import fails with an operator-readable progress line
  and the job continues with the remaining sheets
