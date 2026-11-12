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
while the Autogenerate after import group is shown with its checkbox ticked and at
least one playlist entry is checked ("autogenerate is armed"), at least one of its
steps is ticked, at most 1000 playlist entries are checked, the up-front check for
the current show and steps has finished, and it found no blocked reason. Otherwise it
SHALL be disabled; while autogenerate is armed, the reason SHALL be shown beneath the
group ("Pick at least one step.", "Autogenerate after import covers at most 1000
videos; check fewer videos or untick it.", "Checking your providers…", or Settings'
text for the blocked reason). With autogenerate armed, Start Import SHALL first open
that requirement's confirm and run only when it is confirmed. While a run is in
progress, a click outside the modal and the Escape key SHALL NOT close it; the
modal's Close control SHALL still close it and abort the run ("Progress reporting").
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

#### Scenario: A ticked box with no checked entry does not narrow Start Import

- **WHEN** a folder is chosen, a loaded playlist has Autogenerate after import ticked
  with no step ticked, and the user unchecks every playlist entry
- **THEN** Start Import is enabled, and activating it imports the folder with no
  autogenerate confirm

#### Scenario: Escape does not interrupt a run

- **WHEN** the user presses Escape or clicks outside the modal while a run is in
  progress
- **THEN** the modal stays open and the run continues; activating Close closes it and
  aborts the run

#### Scenario: Parts run folder, playlist, logs

- **WHEN** the user has chosen a folder, a playlist selection and a logs URL, and activates
  Start Import
- **THEN** the folder groups are processed first, then the playlist entries, then the log
  import, and the progress region keeps every part's lines in that order

## ADDED Requirements

### Requirement: YouTube playlist import can autogenerate afterwards

**The group.** The Batch Import modal SHALL offer an **Autogenerate after import** checkbox
beneath the playlist picker, unticked by default, shown only while a playlist is loaded and only
to a user whose role in the modal's team (the profile's active team, whose shows the Show dropdown
lists) is `owner` or `admin`. A `member` SHALL NOT see it, and no autogenerate request SHALL be sent
for a member. While the checkbox is ticked the modal SHALL show the same step checkboxes
(Transcripts, Log events, Topics, Wiki, in run order) and the same wiki mode choice as Settings →
Batch autogenerate (web-ui-system "Settings runs batch autogenerate for owners and admins"), with
the same labels and defaults: all four steps ticked, and "Add new pages and additions to the
wiki", which is enabled only while Wiki is ticked. Every control of the group SHALL be disabled
while a run is in progress. Whenever the group is hidden (no playlist loaded, a new link being
loaded, a failed listing) and when the modal is closed, the checkbox SHALL be unticked and the
options reset to their defaults. Autogenerate is **armed** while the group is shown, its checkbox
is ticked and at least one playlist entry is checked; the rules below apply only while it is armed.

**Up-front check.** While autogenerate is armed, at least one step is ticked and no run is in
progress, the modal SHALL check, for the current show, steps and wiki mode and again whenever they
change, whether a job would be refused for a missing provider or approval:

1. It SHALL ask the batch autogenerate preview route (api-contract-freeze "Batch autogenerate
   endpoints") for the run's team with `show_ids` of the selected show and the chosen steps and
   wiki mode. Only an answer to the current show, steps and wiki mode counts; an answer to an
   earlier selection SHALL NOT be used. Until it answers, the check is pending and Start Import is
   disabled ("Checking your providers…").
2. A `200` answer with a non-null `blocked` is a **block**: Settings' text for the reason is shown
   beneath the options and Start Import is disabled. A `200` with `blocked` null is clear.
3. Any other answer (such as `400` for a show with no sessions yet or with more than 1000) or no
   answer SHALL NOT block. The modal SHALL then read the user's provider status
   (`GET /api/me/providers`, api-contract-freeze "Provider credential routes") and, when it
   suggests a reason in the start route's order (Transcripts ticked and no `stt` credential;
   Log events, Topics or Wiki ticked and no `llm` credential or a `claude-cli` one while
   `claude_cli_allowed` is false; `run_features_allowed` false), show Settings' text for it as a
   warning followed by "Your providers are checked again when the import ends.", with Start Import
   left enabled. A failed provider read shows nothing.

**Confirm.** When Start Import is activated with autogenerate armed, the modal SHALL first read
the team's jobs (`GET /api/teams/:teamId/autogenerate-jobs`, api-contract-freeze "Batch
autogenerate endpoints") and then open a themed confirm, before anything is imported. When that
list holds a job whose `status` is `queued` or `running`, the confirm SHALL begin with the warning
`A batch job is already running for this team; autogenerate after this import will not start unless it has finished by then.` The warning SHALL NOT disable or replace the confirm's Start: the user may still
start, and the end-of-run start reports a live job as below. When the read fails or does not
answer, the confirm SHALL open without the warning and nothing is blocked. With N checked playlist
entries and S ticked steps the confirm SHALL say
`Import N videos, then autogenerate on up to N sessions, at most N×S runs.` (the numbers
computed), that only videos this import brings in are included, that the work runs on the user's
own provider accounts, that the providers are checked again when the import ends, and, in "Add new
pages and additions to the wiki" mode with Wiki ticked, Settings' warning that AI-written new
pages and additions will be added to wiki pages without review while rewrites that remove or
change text stay as suggestions. Dismissing it SHALL start nothing. When it is confirmed, the
modal SHALL look at the up-front check for the current selection once more: if it is now a block,
nothing SHALL run and the block is shown as above; otherwise Start Import runs and no further
prompt SHALL be shown for the autogenerate job. The modal SHALL record the signed-in user's id at
that moment. Start Import with autogenerate not armed SHALL show no confirm.

**Qualifying sessions.** A session SHALL qualify when the playlist part of this run either:

- logged `Completed <name>` for it: a session created and imported in this run, this import's own
  unfinished session from an earlier run that this run imported into, or an import whose unknown
  outcome was confirmed by a segment appearing; or
- skipped its entry as already in the system while the matching session is this import's own
  remembered session for that show and video (batch-audio-import "YouTube playlist import run",
  "Retry into an unfinished session") and has audio segments: audio an earlier, interrupted run of
  this import brought in. The skip line is unchanged, and the session SHALL then be forgotten as a
  completed one is, so later runs treat it as an ordinary existing session.

Other skipped entries, failed, unconfirmed and still-importing entries SHALL NOT qualify. Sessions
of the folder and log parts SHALL NOT qualify.

**End-of-run start.** After the last part of Start Import has ended (the log part when there is
one; also when a part ended with a `Failed` line), and only when the run was not aborted and
autogenerate was confirmed, the modal SHALL:

1. With no qualifying session, send no request and log
   `Autogenerate not started: no video was imported by this import.`
2. Read the profile. When the signed-in user differs from the one recorded at the confirm, log
   `Autogenerate not started: you are signed in as a different user than the one who confirmed.`
   and send nothing more; when the read fails, log the "request failed" line below.
3. Send the preview with `session_ids` exactly the qualifying sessions and the confirmed steps and
   wiki mode. A non-null `blocked` SHALL end the start with
   `Autogenerate not started: <Settings' text for that reason>`.
4. Send the start with the same scope and `expected_sessions` equal to the preview's `sessions`,
   and on `201` log (with the preview's `sessions` and `max_runs`)
   `Autogenerate started for <sessions> sessions (at most <max_runs> runs); follow it in Settings → Batch autogenerate.`

**One re-scope on `404`.** When the preview or the start answers `404 {"detail":"Session not
found"}` (a qualifying session was deleted or hidden meanwhile), the modal SHALL once re-read the
run's show's session list (re-aligning the active show first, as the playlist run does), keep the
qualifying ids still listed for that show, log
`Autogenerate: left out <k> imported session(s) that no longer exist.` with the number dropped,
and run steps 3-4 once more over the rest (step 1's line when none is left). A second `404`, or
any other answer, ends the start as below. There SHALL be no other repeated request.

Every other outcome SHALL be exactly one progress line:

| Outcome | Progress line |
| --- | --- |
| start `409` with `job_id` (a live job for the team) | `Autogenerate not started: a batch job is already running for this team. Start one for this show in Settings → Batch autogenerate when it ends.` |
| preview or start answered with a string `detail` (`400`, `403`, `404` after the re-scope or for the team, `409` sessions changed, `503`) | `Autogenerate not started: <detail> Start it in Settings → Batch autogenerate.` |
| preview or start answered `422` or another JSON body without a string `detail` below `500`; preview answered `500` or above or with no JSON answer; a failed profile or session-list read | `Autogenerate not started: the request failed. Start it in Settings → Batch autogenerate.` |
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

#### Scenario: Loading another link unticks the box

- **WHEN** an admin has ticked Autogenerate after import and unticked Topics, then loads another
  playlist link
- **THEN** the group is hidden while it loads, and once the new playlist is shown the checkbox is
  unticked and all four steps are ticked again

#### Scenario: A blocked user is told before importing

- **WHEN** an owner with no language model ticks the checkbox with Topics ticked and the preview
  for the show answers `blocked` `unconfigured-llm`
- **THEN** the modal shows "Add a language model in Settings → Advanced to autogenerate." and
  Start Import is disabled, and it is enabled again when the owner unticks the checkbox

#### Scenario: Start Import waits for the current check

- **WHEN** the preview for the selection with Topics ticked answered `blocked` null, and the owner
  ticks Transcripts, whose preview has not answered yet
- **THEN** Start Import is disabled with "Checking your providers…" until that preview answers,
  and the earlier answer is not used

#### Scenario: An empty show only warns

- **WHEN** an owner whose provider status has no `stt` credential ticks the checkbox with
  Transcripts ticked for a show with no sessions, so the preview answers `400`
- **THEN** the modal shows "Add a speech-to-text key in Settings → Advanced to generate
  transcripts." with "Your providers are checked again when the import ends.", and Start Import
  stays enabled

#### Scenario: A block that arrives during the confirm stops the run

- **WHEN** the confirm is open and the up-front check for the current selection is refreshed and
  now answers `blocked` `not-approved`, and the user confirms
- **THEN** nothing is imported, the block is shown and Start Import is disabled

#### Scenario: The confirm shows the estimate

- **WHEN** an admin with 12 checked entries, the checkbox ticked and Transcripts and Topics ticked
  activates Start Import
- **THEN** a themed confirm says `Import 12 videos, then autogenerate on up to 12 sessions, at most
  24 runs.` and nothing is imported until it is confirmed

#### Scenario: A live job is warned about but does not block

- **WHEN** an admin activates Start Import with the checkbox ticked while the team's job list
  holds a `running` job another admin started
- **THEN** the confirm begins with "A batch job is already running for this team; autogenerate after this import will not start unless it has finished by then.", its Start is enabled, and confirming runs the
  import

#### Scenario: A failed job-list read shows no warning

- **WHEN** the job-list read before the confirm fails with a network error
- **THEN** the confirm opens without the live-job warning and Start Import works as usual

#### Scenario: Only this import's videos are in the job

- **WHEN** a confirmed run over five entries completes entries 1 and 4, skips entry 2 as already
  in the system, fails entry 3 and leaves entry 5 unconfirmed
- **THEN** after the run the preview and start are sent with `session_ids` of the sessions of
  entries 1 and 4, the start's `expected_sessions` is the preview's `sessions` (2), and the last
  line is `Autogenerate started for 2 sessions (at most 8 runs); follow it in Settings → Batch autogenerate.`

#### Scenario: A retried session from an earlier run qualifies

- **WHEN** an earlier run left this import's session for an entry without audio, and this run
  imports into it and logs `Completed <name>`
- **THEN** that session is in the end-of-run job's `session_ids`

#### Scenario: An interrupted earlier run's import qualifies on the rerun

- **WHEN** an earlier run was closed while entry 3 was importing, the server then attached its
  audio, and a rerun with the same entries checked skips entry 3 as already in the system
- **THEN** entry 3's session is in the end-of-run job's `session_ids`, its skip line is unchanged,
  and a third run treats it as an ordinary existing session that does not qualify

#### Scenario: Nothing imported means no job

- **WHEN** a confirmed run skips every checked entry as already in the system and none of them is
  this import's own remembered session
- **THEN** no preview or start is sent and the last line is
  `Autogenerate not started: no video was imported by this import.`

#### Scenario: Another account does not inherit the confirm

- **WHEN** the user who confirmed signs out mid-run and another user signs in in the same browser
  before the import ends
- **THEN** no preview or start is sent and the last line is
  `Autogenerate not started: you are signed in as a different user than the one who confirmed.`

#### Scenario: A deleted session is left out once

- **WHEN** three sessions qualify, one is deleted before the run ends, and the end-of-run preview
  answers `404 {"detail":"Session not found"}`
- **THEN** the modal re-reads the show's sessions, logs
  `Autogenerate: left out 1 imported session(s) that no longer exist.`, and previews and starts
  once more over the other two

#### Scenario: A live job is reported, not retried

- **WHEN** the end-of-run start answers `409` with a `job_id`
- **THEN** the last line points to Settings → Batch autogenerate, the earlier `Completed` lines are
  unchanged, and no further autogenerate request is sent

#### Scenario: An unknown start outcome is not repeated

- **WHEN** the end-of-run start fails with a network error
- **THEN** the last line is `Autogenerate may have started; check Settings → Batch autogenerate before starting it again.` and the start is not sent again

#### Scenario: Closing the modal starts no job

- **WHEN** the user activates Close while the third of five entries is importing
- **THEN** no autogenerate preview or start is sent
