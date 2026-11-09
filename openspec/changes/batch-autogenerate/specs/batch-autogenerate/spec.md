# Spec Delta

## Purpose
Batch autogenerate fills a studio's missing transcripts, auto-generated events, topics and wiki
updates across many sessions in one durable, resumable server-side job that runs as its
initiator, on the initiator's own provider credentials, one session at a time.

## ADDED Requirements

### Requirement: Only a team's owners and admins run batch jobs
Starting, previewing, listing, reading and cancelling batch autogenerate jobs of a team SHALL
require the caller to be that team's `owner` or `admin`. A caller who is not a member of the team
SHALL get the team family's masked `404`, and a `member` SHALL get `403 Admin role required.`.
Every owner and admin of the team SHALL see every job of the team, whoever started it, and MAY
cancel it. Starting a job SHALL also require the caller to be an approved user (api-contract-freeze
"Run features are limited to approved users").

#### Scenario: A member cannot start or see jobs
- **WHEN** a plain member of team T, holding grants for every show of T, previews, starts or lists
  batch jobs of T
- **THEN** each request answers `403 Admin role required.` and no job is created

#### Scenario: Another admin sees and cancels the owner's job
- **WHEN** the owner of T starts a job and an admin of T reads and then cancels it
- **THEN** the admin reads the job with its items, and the cancel is accepted

### Requirement: Jobs go with their team
Deleting a team SHALL delete its jobs and their items. A team with a `queued` or `running` job
always has shows, so the existing team delete refuses it first. The operator's legacy import with
`--replace` or `--replace-live` SHALL refuse a team that has a `queued` or `running` job, naming
the reason, and change nothing; finished jobs SHALL be deleted with the team it replaces.

#### Scenario: Replacing a team during a job
- **WHEN** an operator runs the legacy import with `--replace` for a team whose job is running
- **THEN** the import is refused with a message saying a batch autogenerate job is in progress and
  nothing is deleted

### Requirement: A job's scope is a set of shows or a list of sessions of one team
A job SHALL name exactly one team and exactly one of:
- **shows**: one or more shows of that team; the candidates are every session of those shows that
  is not deleted (`ui_hidden`), archived sessions included;
- **sessions**: one or more session ids, each of which SHALL be a session of a show of that team,
  not deleted, and accessible to the initiator; duplicates are removed.

A show id that is not a show of the team SHALL answer `404 Show not found.` and a session id that
fails the rule above SHALL answer `404 Session not found`, both before any job is created. A scope
with no candidate session SHALL answer `400 No sessions to process.`; more than 1000 candidate
sessions SHALL answer `400` naming the limit. The candidate list SHALL be fixed when the job is
created: sessions created later are not added.

#### Scenario: Default scope is every show
- **WHEN** the client sends every show id of the team
- **THEN** every non-deleted session of the team is a candidate, archived ones included

#### Scenario: A foreign session is refused
- **WHEN** a session-list job names a session of another team
- **THEN** the response is `404 Session not found` and no job exists

### Requirement: Sessions run oldest first by episode date
Candidate sessions SHALL be processed in ascending order of their effective date, then their
`started_at_utc`, then their `created_at_utc`, then their id (byte order). The effective date is
the session's `episode_date` when it is a valid `YYYY-MM-DD` date, else the first ten characters
of `started_at_utc` when they form one, else those of `created_at_utc` when they form one.
Sessions with no effective date SHALL come after every dated session. The order SHALL be recorded
when the job is created as each session's ordinal and SHALL NOT change afterwards.

#### Scenario: Missing episode date falls back to the start date
- **WHEN** session A has `episode_date` `2024-03-01`, session B has none and started
  `2024-02-10T18:00:00Z`, and session C has neither and was created `2025-01-01T00:00:00Z`
- **THEN** the order is B, A, C

#### Scenario: Equal dates are ordered by start time, then id
- **WHEN** two sessions share `episode_date` `2024-03-01` and the one with id `b` started earlier
  than the one with id `a`
- **THEN** `b` runs before `a`

### Requirement: Steps run in dependency order and only where output is missing
A job SHALL run the steps the user selected from `transcript`, `events`, `topics` and `wiki`, for
each session in the order transcript → events → topics → wiki. A step SHALL run only when its
output is missing, decided just before the step and again after the session's single-flight is
held:
- **transcript** is missing when the session has no transcript words;
- **events** is missing when the session has no auto-generated event (an event whose metadata
  marks it auto-generated), other than **recorded partial output** (below); manual events do not
  count;
- **topics** is missing when the session has no topics, other than recorded partial output;
- **wiki** is never "present": it runs for every processed session that has transcript words.

**The job's own partial output.** Before each topic or event a step writes, the job SHALL know
it is the step's own: events by the attempt's run id, recorded on the item before the turn
starts, and topics by their ids, each recorded on the item before the topic is written. When a
step is re-entered after an interrupted attempt, it SHALL first delete the topics its earlier
attempts recorded and SHALL exclude its earlier attempts' events from the run's prompt and from
its anchor computation, as a regenerate excludes its snapshot; then it decides "missing" as above.
After a successful events run, the events of every earlier attempt SHALL be deleted. Partial
output of an interrupted attempt SHALL never make a step `present`. Every such delete runs as the
initiator and touches only rows the item recorded.

**Recording is refused when the job lost its lease.** The write that records a run id or a topic
id on the item SHALL be fenced on the job's lease. When it changes no row, nothing SHALL be
written: an events run whose run id could not be recorded SHALL NOT start, and a topic whose id
could not be recorded SHALL NOT be inserted; the topic tool SHALL refuse that call and every later
call of the turn, the turn SHALL end as failed, and that worker SHALL write nothing more for the
job.

**Recorded partial output** of a session and step is every event whose run id, and every topic
whose id, is recorded on an item for that session and step, of **any** job, whose status is not
`done`, except rows a person edited. It SHALL NOT count as present for any job, and a later
job's step on that session SHALL delete it (version-guarded, below) before its gap check, as its
own initiator.

**A person's edit wins.** Every own-output delete SHALL be guarded by the row's version at insert
(`1`): a row whose version moved because a person edited it SHALL be kept, SHALL count as present
(the person adopted it), and the item SHALL record how many rows it kept this way (`kept_edited`).

**Every ending cleans up.** Whenever an item ends without `done`, or a session is abandoned with an
attempt in flight or recorded partial output (a cancel, including one during a busy or rate-limit
wait; any job stop, `provider-failing` included; ladder steps 1-4 refusing the session; a failed
step), the item's own output SHALL be cleaned up first, as above. When the cleanup cannot run (the
initiator lost access, the account is gone, or the job row vanished), the rows stay recorded on a
non-`done` item and so remain excluded from every gap check until a later job removes them.

A step whose output is present SHALL be skipped with the outcome `present` and SHALL write
nothing. A transcript produced by a step SHALL be written only if the session still has no
transcript words when it commits; otherwise it is discarded and the outcome is `present`. A step
SHALL never delete or replace transcript words, topics or events that existed before it started,
except the job's own partial output named above.

When a step's precondition is not met, it SHALL be skipped with a classified outcome and the
session's later steps that depend on it SHALL be skipped too: a session with no audio segments
(`no-audio`) for transcript; no transcript words (`no-transcript`) for events, topics and wiki; no
transcript word with a session-time anchor (`no-anchors`) for events; no event button with a
generation instruction on the show (`no-instructions`) for events only. A precondition skip is not
a failure.

#### Scenario: Only the gaps are filled
- **WHEN** a session has transcript words and manual events but no auto-generated events and no
  topics, and the job selected all four steps
- **THEN** the transcript step is `present` and writes nothing, events and topics run, and the
  wiki update runs

#### Scenario: A transcript typed in during the run is kept
- **WHEN** the transcript step's provider call is running and a person adds a transcript word to
  the session
- **THEN** the generated transcript is discarded, the person's word remains, and the step's
  outcome is `present`

#### Scenario: A session with no audio
- **WHEN** a session has no audio segments and no transcript, and the job selected transcript and
  topics
- **THEN** the transcript step is skipped `no-audio`, topics is skipped `no-transcript`, no
  provider request is made, and the job continues with the next session

### Requirement: The worker acts as the initiator and re-checks before every session
A job SHALL store its initiator's user id and SHALL NOT store any token, cookie, provider key or
other credential. Before each session, in this order, the worker SHALL:
1. stop if a cancel was requested (see "Cancel");
2. load the initiator's account; a missing or disabled account SHALL stop the job with
   `stop_reason` `initiator-unavailable`;
3. re-check that the initiator is an `owner` or `admin` of the job's team; otherwise the job SHALL
   stop with `initiator-role-lost`;
4. re-check that the initiator is an approved user; otherwise the job SHALL stop with
   `not-approved`;
5. re-check, as the initiator, that the session exists, is not deleted, belongs to a show of the
   job's team and is accessible to the initiator; otherwise every step of that session SHALL be
   skipped with `access-lost` (or `session-gone` for a deleted or missing session), a line SHALL
   be logged without any session content, and the job SHALL continue.

Every catalog and session read and write for the session SHALL run bound to the initiator, under
the same row-level security as a request by that user. Each step SHALL resolve the initiator's
provider credential of the kind it needs when the step starts (provider-credentials "Work runs on
its user's credentials"), with the same rules as the manual route, including the Claude CLI
allowlist read on every turn. When a step's credential is unavailable, that item SHALL be
`failed` with `unconfigured` and the job SHALL stop with `unconfigured-stt` or `unconfigured-llm`,
since every later session would fail the same way.

#### Scenario: Access lost to one session
- **WHEN** a job is between two sessions and the next session is deleted
- **THEN** that session's steps are `skipped` with `session-gone`, no provider request is made for
  it, and the job continues with the following session

#### Scenario: Initiator demoted mid-job
- **WHEN** the initiator is demoted from admin to member while a step runs
- **THEN** the step finishes, the job stops with `stop_reason` `initiator-role-lost` before the
  next session, and the remaining items are `cancelled`

#### Scenario: Initiator's key removed mid-job
- **WHEN** the initiator deletes their `llm` credential while a job with topics selected is
  between sessions
- **THEN** the next topics step stops the job with `unconfigured-llm` and no model request is made

#### Scenario: No credential is stored
- **WHEN** a job is created by a user with saved provider credentials
- **THEN** the job and item rows hold the initiator's user id and no secret, token or key

### Requirement: One session at a time, sharing the per-session single-flight
A job SHALL process one session and one step at a time. Each step SHALL take the same per-session
single-flight as its manual route (the shared AI-turn slot and `ai-turn` run lease for events,
topics and wiki; the transcript generation lock and `transcript-generation` run lease for
transcript) and release it when the step ends. A session is **busy** for a step when that
single-flight is held by someone else or the session has a live `recording` lease. A busy step
SHALL be retried every 15 seconds for up to 10 minutes, checking for a cancel between tries; if it
is still busy, every remaining step of that session SHALL be skipped with `busy` and the job SHALL
continue. A busy skip is not a failure. While a batch step holds a session's slot, the manual
routes SHALL answer their existing busy `409`.

A team SHALL have at most one `queued` or `running` job. A server process SHALL run at most one
job at a time; queued jobs SHALL be claimed oldest first.

#### Scenario: A person is chatting with the AI on the session
- **WHEN** the job reaches the events step of a session whose AI slot is held by an AI chat turn
  that ends after 40 seconds
- **THEN** the step waits, runs once the slot is free, and its outcome is `done`

#### Scenario: A session is being recorded
- **WHEN** the job reaches a session with a live recording lease that stays live for 10 minutes
- **THEN** the session's remaining steps are skipped `busy` and the job moves on

### Requirement: A failed step skips the rest of its session
When a step fails (the provider call failed, timed out, was over a size limit, or the run did not
complete), the item SHALL be `failed` with a classified outcome, the session's later steps SHALL
be `skipped` with `earlier-step-failed`, and the job SHALL continue with the next session. A step
that ends `failed` for any reason, `interrupted` included, SHALL delete the events of every run id
its attempts recorded and the topics its attempts recorded by id, so the session is left
"missing" for a later job; a failed wiki step stores nothing, as the manual route does. Topics or
events a person added during the step SHALL NOT be deleted. When the initiator can no longer
delete them (access lost), they remain and the item stays `failed`. Outcomes and their
details SHALL be fixed strings chosen by the server; no provider output, prompt, transcript text,
file path or stack trace SHALL be stored in a job or item, returned by a route, or logged.

#### Scenario: Events fail on one session
- **WHEN** the events step fails on session 2 of 3 after its run created 4 events
- **THEN** those 4 events are deleted, session 2's topics and wiki are `skipped`
  `earlier-step-failed`, session 3 is processed, and the job ends `finished` with one failed item

#### Scenario: A person's topic survives a failed batch topics step
- **WHEN** a batch topics turn creates 3 topics, a person adds a topic to the same session, and
  the turn then fails
- **THEN** the 3 topics the turn created are deleted and the person's topic remains

### Requirement: Persistent provider failure stops the job
When a provider answers HTTP `429` (rate limited) and the step can tell (speech to text, and AI
turns on the AI SDK route), the job SHALL retry the same step after 30, 60, 120, 240 and 480
seconds, checking for a cancel during each wait, and after the fifth refusal the item SHALL be
`failed` with `rate-limited`. The job SHALL keep one count per provider kind, speech to text
(the transcript step) and language model (events, topics, wiki): a processed session in which a
step of that kind ended `failed` as `provider-failed`, `generation-failed` or `rate-limited` adds
one to that kind's count; a step of that kind ending `done` resets only that kind's count; other
outcomes leave both unchanged. When either count reaches 3, the job SHALL stop with `stop_reason`
`provider-failing` and its remaining items SHALL be `cancelled` with `job-stopped`.

#### Scenario: A revoked key stops the job
- **WHEN** the initiator's speech-to-text key is revoked at the provider and sessions 4, 5 and 6
  each fail their transcript step with `provider-failed`
- **THEN** the job ends `failed` with `stop_reason` `provider-failing` after session 6, and no
  provider request is made for session 7 or later

#### Scenario: A revoked language-model key stops the job while transcription works
- **WHEN** the initiator's `llm` key is revoked at the provider and sessions 1, 2 and 3 each get a
  `done` transcript and a `provider-failed` events step
- **THEN** the job stops with `provider-failing` after session 3 and makes no request for session 4

#### Scenario: A rate limit is waited out
- **WHEN** a topics turn is refused with `429` twice and then succeeds
- **THEN** the step waited 30 and 60 seconds, its outcome is `done`, and the language-model
  failure count is reset

#### Scenario: A cancel during a rate-limit wait cleans up
- **WHEN** an events attempt wrote 3 events and was refused with `429`, and an admin cancels during
  the wait
- **THEN** the 3 events are deleted, the item is `cancelled`, and the job is `cancelled`

#### Scenario: An edited partial event is kept
- **WHEN** an interrupted events attempt wrote 2 events and a person edited one of them before the
  job resumed
- **THEN** the resumed step deletes the unedited one, keeps the edited one, records `kept_edited`
  1, and the step is `present`

### Requirement: Cancel stops after the current step
A cancel SHALL be recorded on the job with who requested it and when. A `queued` job SHALL become
`cancelled` at once. A `running` job SHALL finish the step in progress (its provider call is not
interrupted and its output is kept), then become `cancelled`; every item not yet started SHALL be
`cancelled`. A cancel of a job that already ended SHALL change nothing.

#### Scenario: Cancel during a long transcript
- **WHEN** an admin cancels a job while a transcript step's provider call runs
- **THEN** the transcript is written when the call returns, no further step starts, the job is
  `cancelled`, and the remaining items are `cancelled`

### Requirement: A job resumes after a restart
A running job SHALL hold a lease that its process renews while it works. When the lease has
lapsed (the process stopped), any server process SHALL claim the job, within 90 seconds of the
lease's last renewal, and continue it from the first item that has not ended. An item that was `running` when the lease lapsed SHALL be re-run
as gap-fill: its output is re-checked with the rules of "Steps run in dependency order and only
where output is missing" (the job's own partial events do not count as present; a wiki run whose
suggestions were already stored is not repeated, and in `accept` mode its pending suggestions are
then accepted). An item that has been interrupted three times SHALL be `failed` with
`interrupted`. Items that ended SHALL NOT run again.

#### Scenario: Server restart during the topics step
- **WHEN** the server stops while session 5's topics step runs, after sessions 1-4 finished, and
  starts again
- **THEN** the job is claimed again within 90 seconds, sessions 1-4 are not re-run, the topics
  the interrupted attempt wrote are deleted, session 5's topics step re-runs and is not `present`,
  and the job continues with session 5's wiki step

#### Scenario: Restart after the wiki suggestions were stored
- **WHEN** the server stops after a wiki step stored its suggestions and before they were accepted
- **THEN** after the restart no new wiki run is made for that session and its pending suggestions
  from that run are accepted

### Requirement: Wiki output is auto-accepted or left pending
A job SHALL carry a wiki mode: `accept` (the default) or `pending`. In `pending` mode the wiki
step SHALL store suggestions as a manual wiki update does. In `accept` mode, after the step stored
its suggestions, the job SHALL auto-accept only **safe** suggestions (owner decision, 2026-11-09),
in the order they were proposed, through the same accept transaction as a person's accept
(show-wiki "A batch job accepts suggestions as its initiator"). A suggestion is safe when it
proposes a new page, or when it rewrites an existing page by additions only, as show-wiki defines;
any suggestion that would remove or change existing text, title or alias SHALL stay `pending` for
a person. A safe suggestion whose accept is refused for any reason SHALL stay `pending` too. None
of this fails the step. The item SHALL record how many suggestions were accepted and how many were
left pending.

#### Scenario: A rewrite that removes text is left for a person
- **WHEN** in `accept` mode a wiki step stores a new-page suggestion and a rewrite of an existing
  page that drops one of its lines
- **THEN** the new page is created, the rewrite stays `pending`, and the item records 1 accepted
  and 1 left pending

#### Scenario: A stale suggestion is left pending
- **WHEN** in `accept` mode a wiki step stores two additions-only suggestions and a person edits
  the first target page before it is accepted
- **THEN** the first suggestion stays `pending`, the second is `accepted`, and the item records 1
  accepted and 1 left pending

### Requirement: The estimate and the confirm
A preview SHALL answer, for a proposed job, the number of candidate sessions, the selected steps,
the number of sessions whose output for each selected step is missing now, and the upper bound
`sessions × selected steps`. Starting a job SHALL require the session count the client confirmed
(`expected_sessions`); when it differs from the server's count at start, the start SHALL answer
`409` with the current count and create nothing.

#### Scenario: Sessions added after the estimate
- **WHEN** a client previews 12 sessions, a session is added to a selected show, and the client
  starts with `expected_sessions` 12
- **THEN** the response is `409` with `sessions` 13 and no job is created

### Requirement: The report
A job SHALL expose its status, stop reason, step counts and, per session in processing order, each
selected step's status (`pending`, `running`, `done`, `skipped`, `failed`, `cancelled`), its
classified outcome and the outcome's fixed detail. A job SHALL end `finished` when every item
ended (with or without failed items), `cancelled` after a cancel, or `failed` when it stopped for a
`stop_reason` other than a cancel.

Each outcome SHALL go with exactly one item status:

| Item status | Outcomes |
| --- | --- |
| `done` | none (null) |
| `skipped` | `present`, `no-audio`, `no-speech`, `no-transcript`, `no-anchors`, `no-instructions`, `busy`, `access-lost`, `session-gone`, `earlier-step-failed` |
| `failed` | `unconfigured`, `provider-failed`, `rate-limited`, `too-large`, `missing-audio-file`, `unreadable`, `generation-failed`, `interrupted` |
| `cancelled` | `cancelled` (a cancel), `job-stopped` (any other stop reason) |

`pending` and `running` items have no outcome.

#### Scenario: Report after a mixed run
- **WHEN** a job over three sessions ends with one `present` transcript, one `no-audio` skip and
  one failed topics step
- **THEN** the job is `finished`, and its detail lists those three outcomes against their sessions
  and steps with their fixed details
