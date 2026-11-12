# Spec Delta

## MODIFIED Requirements

### Requirement: Batch Import modal layout and actions

The Batch Import modal SHALL include, in order: a Show dropdown equivalent to New
Session's show picker; an Import Audio control; an Import YouTube Playlist control
with its playlist picker beneath it ("YouTube playlist selection") and, beneath the
picker, the Autogenerate after import group when it is shown ("YouTube playlist import
can autogenerate afterwards"); an Import Logs control; a Start Import control; and a
progress region beneath Start Import. Import Logs SHALL collect the public Google
Sheets URL for the log import specified by sheets-log-import (through a themed text
prompt); the import itself SHALL run only on Start Import. Import Logs SHALL NOT open
a directory picker, import audio, or create sessions. Start Import SHALL be enabled
when a show is selected, no run is in progress, at least one of these is ready: a
chosen folder, a loaded playlist with at least one checked entry, or a logs URL; and,
while Autogenerate after import is ticked, at least one of its steps is ticked, at
most 1000 playlist entries are checked, and the up-front check has not found a
blocked reason. Otherwise it SHALL be disabled; while the checkbox is ticked, the
reason SHALL be shown beneath the group ("Pick at least one step.", "Autogenerate
after import covers at most 1000 videos; check fewer videos or untick it.", or
Settings' text for the blocked reason). With Autogenerate after import ticked, Start
Import SHALL first open that requirement's confirm and run only when it is confirmed.
Start Import SHALL run the ready parts in this order: the folder import, then the
playlist import, then the log import, so that logs can match sessions the audio parts
created, and then, when ticked, the autogenerate start. All parts SHALL report into the
one progress region, each part's lines following the previous part's.

#### Scenario: Import Logs collects the Sheets URL for the log import

- **WHEN** the user activates Import Logs
- **THEN** a themed prompt asks for the public Google Sheets URL, no directory picker
  opens, and nothing is imported or created until the user activates Start Import

#### Scenario: A playlist alone enables Start Import

- **WHEN** no folder and no logs URL are chosen, Autogenerate after import is not
  ticked, and a loaded playlist has two entries checked
- **THEN** Start Import is enabled, and it is disabled again when the user unchecks both

#### Scenario: Autogenerate options can disable Start Import

- **WHEN** a loaded playlist has two entries checked and the user ticks Autogenerate
  after import and then unticks all four steps
- **THEN** Start Import is disabled with "Pick at least one step.", and it is enabled
  again when the user ticks a step or unticks Autogenerate after import

#### Scenario: Parts run folder, playlist, logs

- **WHEN** the user has chosen a folder, a playlist selection and a logs URL, and activates
  Start Import
- **THEN** the folder groups are processed first, then the playlist entries, then the log
  import, and the progress region keeps every part's lines in that order

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
progress, the modal SHALL decide, again whenever the show, steps or wiki mode change, whether a
job with those steps would be refused for a missing provider or approval, in this order:

1. It SHALL ask the batch autogenerate preview route (api-contract-freeze "Batch autogenerate
   endpoints") for the run's team with `show_ids` of the selected show and the chosen steps and
   wiki mode. A `200` answer's `blocked` is the verdict.
2. When the preview answers otherwise (such as `400` for a show with no sessions yet or with more
   than 1000) or not at all, the modal SHALL derive the verdict from the user's provider status
   (`GET /api/me/providers`, api-contract-freeze "Provider credential routes"), in the start route's order: Transcripts ticked
   and no `stt` credential → `unconfigured-stt`; Log events, Topics or Wiki ticked and no `llm`
   credential, or an `llm` credential whose provider is `claude-cli` while `claude_cli_allowed` is
   false → `unconfigured-llm`; `run_features_allowed` false → `not-approved`; otherwise none.
3. When neither answers, there is no verdict.

A verdict naming a reason SHALL show Settings' text for it beneath the options and disable Start
Import ("Batch Import modal layout and actions"). The check is advisory: a provider the browser
cannot see (a saved key the server cannot decrypt, or a deployment's own speech-to-text fallback)
can make it differ from the server, and the end-of-run start reports the server's own answer.

**Confirm.** When Start Import is activated with the checkbox ticked, the modal SHALL first read
the team's jobs (`GET /api/teams/:teamId/autogenerate-jobs`, api-contract-freeze "Batch
autogenerate endpoints") and then open a themed confirm, before anything is imported. When that
list holds a job whose `status` is `queued` or `running`, the confirm SHALL begin with the warning
`A batch job is already running for this team; autogenerate after this import will not start unless it has finished by then.` The warning SHALL NOT disable or replace the
confirm's Start: the user may still start, and the end-of-run start reports a live job as below.
When the read fails or does not answer, the confirm SHALL open without the warning and nothing is
blocked. With N checked playlist entries and S ticked steps it SHALL say
`Import N videos, then autogenerate on up to N sessions, at most N×S runs.` (the numbers
computed), that only videos imported in this run are included, that the work runs on the user's
own provider accounts, that the providers are checked again when the import ends, and, in "Add new pages and additions to the wiki" mode with Wiki ticked,
Settings' warning that AI-written new pages and additions will be added to wiki pages without
review while rewrites that remove or change text stay as suggestions. Dismissing it SHALL start
nothing. Confirming SHALL run Start Import as usual; no further prompt SHALL be shown for the
autogenerate job. Start Import with the checkbox unticked SHALL show no confirm.

**Qualifying sessions.** A session SHALL qualify when the playlist part of this run logged
`Completed <name>` for it: a session created and imported in this run, this import's own
unfinished session from an earlier run that this run imported into, or an import whose unknown
outcome was confirmed by a segment appearing. Entries skipped as already in the system, failed, unconfirmed, or still
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

#### Scenario: An empty show is still checked before importing

- **WHEN** an owner whose provider status has no `stt` credential ticks the checkbox with
  Transcripts ticked for a show with no sessions, so the preview answers `400`
- **THEN** the modal shows "Add a speech-to-text key in Settings → Advanced to generate
  transcripts." and Start Import is disabled until Transcripts is unticked

#### Scenario: A retried session from an earlier run qualifies

- **WHEN** an earlier run left this import's session for an entry without audio, and this run
  imports into it and logs `Completed <name>`
- **THEN** that session is in the end-of-run job's `session_ids`

#### Scenario: The confirm shows the estimate

- **WHEN** an admin with 12 checked entries, the checkbox ticked and Transcripts and Topics ticked
  activates Start Import
- **THEN** a themed confirm says `Import 12 videos, then autogenerate on up to 12 sessions, at most
  24 runs.` and nothing is imported until it is confirmed

#### Scenario: A live job is warned about but does not block

- **WHEN** an admin activates Start Import with the checkbox ticked while the team's job list
  holds a `running` job another admin started
- **THEN** the confirm begins with "A batch job is already running for this team; autogenerate after this import will not start unless it has finished by then.", its Start is enabled, and confirming runs the import

#### Scenario: A failed job-list read shows no warning

- **WHEN** the job-list read before the confirm fails with a network error
- **THEN** the confirm opens without the live-job warning and Start Import works as usual

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
