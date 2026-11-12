# Spec Delta

## ADDED Requirements

### Requirement: YouTube playlist import can autogenerate afterwards

The Batch Import modal SHALL offer an **Autogenerate after import** checkbox beneath the playlist
picker, unticked by default, shown only while a playlist is loaded and only to a user whose role
in the modal's team (the profile's active team, whose shows the Show dropdown lists) is `owner` or
`admin`. A `member` SHALL NOT see it, and no autogenerate request SHALL be sent for a member. While
the checkbox is ticked the modal SHALL show the same step checkboxes (Transcripts, Log events,
Topics, Wiki, in run order) and the same wiki mode choice as Settings → Batch autogenerate
(web-ui-system "Settings runs batch autogenerate for owners and admins"), with the same labels and
defaults: all four steps ticked, and "Add new pages and additions to the wiki", which is enabled
only while Wiki is ticked. Every control of this group SHALL be disabled while a run is in
progress. Closing and reopening the modal SHALL reset the group to its defaults.

**Up-front check.** While the checkbox is ticked, at least one step is ticked and no run is in
progress, the modal SHALL ask the batch autogenerate preview route (api-contract-freeze "Batch
autogenerate endpoints") for the run's team with `show_ids` of the selected show and the chosen
steps and wiki mode, again whenever those change. When the answer is `200` with a non-null
`blocked`, the modal SHALL show Settings' text for that reason beneath the options and Start
Import SHALL be disabled until the steps change so that nothing is blocked or the checkbox is
unticked. Any other answer, or no answer, SHALL leave Start Import as it otherwise is (the check
is advisory; the end-of-run start reports a refusal). Start Import SHALL also be disabled while
the checkbox is ticked and no step is ticked ("Pick at least one step."), or more than 1000
playlist entries are checked ("Autogenerate after import covers at most 1000 videos; check fewer
videos or untick it.").

**Confirm.** When Start Import is activated with the checkbox ticked, a themed confirm SHALL open
before anything is imported. With N checked playlist entries and S ticked steps it SHALL say
`Import N videos, then autogenerate on up to N sessions, at most N×S runs.` (the numbers
computed), that only videos imported in this run are included, that the work runs on the user's
own provider accounts, and, in "Add new pages and additions to the wiki" mode with Wiki ticked,
Settings' warning that AI-written new pages and additions will be added to wiki pages without
review while rewrites that remove or change text stay as suggestions. Dismissing it SHALL start
nothing. Confirming SHALL run Start Import as usual; no further prompt SHALL be shown for the
autogenerate job. Start Import with the checkbox unticked SHALL show no confirm.

**Qualifying sessions.** A session SHALL qualify when the playlist part of this run logged
`Completed <name>` for it: a session created and imported in this run, this import's own
unfinished session imported into in this run, or an import whose unknown outcome was confirmed by
a segment appearing. Entries skipped as already in the system, failed, unconfirmed, or still
importing on the server SHALL NOT qualify. Sessions of the folder and log parts SHALL NOT qualify.

**End-of-run start.** After the last part of Start Import has ended (the log part when there is
one; also when a part ended with a `Failed` line), and only when the run was not aborted, the
modal SHALL:

1. With no qualifying session, send no request and log `Autogenerate not started: no video was
   imported in this run.`
2. Otherwise send the preview with `session_ids` exactly the qualifying sessions and the confirmed
   steps and wiki mode. A non-null `blocked` SHALL end the start with
   `Autogenerate not started: <Settings' text for that reason>`.
3. Otherwise send the start with the same scope and `expected_sessions` equal to the preview's
   `sessions`, and on `201` log (with the preview's `sessions` and `max_runs`)
   `Autogenerate started for <sessions> sessions (at most <max_runs> runs); follow it in Settings → Batch autogenerate.`

Every other outcome SHALL be exactly one progress line, and no request SHALL be retried:

| Outcome | Progress line |
| --- | --- |
| start `409` with `job_id` (a live job for the team) | `Autogenerate not started: a batch job is already running for this team. Start one for this show in Settings → Batch autogenerate when it ends.` |
| preview or start answered with a string `detail` (`400`, `403`, `404`, `409` sessions changed, `503`) | `Autogenerate not started: <detail> Start it in Settings → Batch autogenerate.` |
| preview or start answered `422` or another JSON body without a string `detail` below `500`; preview answered `500` or above or with no JSON answer | `Autogenerate not started: the request failed. Start it in Settings → Batch autogenerate.` |
| start answered `500` or above, or with no JSON answer (network error, proxy timeout) | `Autogenerate may have started; check Settings → Batch autogenerate before starting it again.` |

The autogenerate step SHALL NOT change, remove or reorder any line the import parts logged, SHALL
NOT turn an import's outcome into a failure, and SHALL leave the progress region's final state
(100%, lines visible) as it would be without it. Closing the modal before the end-of-run preview
or start has been sent SHALL send neither; closing it while one is in flight SHALL send nothing
further.

#### Scenario: A member does not see the checkbox

- **WHEN** a user whose role in the active team is `member` loads a playlist in the modal
- **THEN** no Autogenerate after import checkbox is shown, and a run sends no autogenerate request

#### Scenario: Options default like Settings

- **WHEN** an admin loads a playlist and ticks Autogenerate after import
- **THEN** Transcripts, Log events, Topics and Wiki are ticked and the wiki mode is "Add new pages
  and additions to the wiki"

#### Scenario: A blocked user is told before importing

- **WHEN** an owner with no language model ticks the checkbox with Topics ticked and the preview
  for the show answers `blocked` `unconfigured-llm`
- **THEN** the modal shows "Add a language model in Settings → Advanced to autogenerate." and
  Start Import is disabled, and it is enabled again when the owner unticks the checkbox

#### Scenario: The confirm shows the estimate

- **WHEN** an admin with 12 checked entries, the checkbox ticked and Transcripts and Topics ticked
  activates Start Import
- **THEN** a themed confirm says `Import 12 videos, then autogenerate on up to 12 sessions, at most
  24 runs.` and nothing is imported until it is confirmed

#### Scenario: Only this run's imports are in the job

- **WHEN** a confirmed run over five entries completes entries 1 and 4, skips entry 2 as already
  in the system, fails entry 3 and leaves entry 5 unconfirmed
- **THEN** after the run the preview and start are sent with `session_ids` of the sessions of
  entries 1 and 4, the start's `expected_sessions` is the preview's `sessions` (2), and the last
  line is `Autogenerate started for 2 sessions (at most 8 runs); follow it in Settings → Batch autogenerate.`

#### Scenario: Nothing imported means no job

- **WHEN** a confirmed run skips every checked entry as already in the system
- **THEN** no preview or start is sent and the last line is
  `Autogenerate not started: no video was imported in this run.`

#### Scenario: A live job is reported, not retried

- **WHEN** the end-of-run start answers `409` with a `job_id`
- **THEN** the last line points to Settings → Batch autogenerate, the earlier `Completed` lines are
  unchanged, and no further autogenerate request is sent

#### Scenario: An unknown start outcome is not repeated

- **WHEN** the end-of-run start fails with a network error
- **THEN** the last line is `Autogenerate may have started; check Settings → Batch autogenerate before starting it again.` and the start is not sent again

#### Scenario: Closing the modal starts no job

- **WHEN** the user closes the modal while the third of five entries is importing
- **THEN** no autogenerate preview or start is sent
