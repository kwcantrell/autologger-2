# Spec Delta

## ADDED Requirements

### Requirement: Batch autogenerate job object
Every batch autogenerate endpoint that returns a job SHALL return exactly this object:

```
{ "id": string, "team_id": string,
  "status": "queued" | "running" | "finished" | "cancelled" | "failed",
  "stop_reason": null | "cancelled" | "initiator-unavailable" | "initiator-role-lost"
                 | "not-approved" | "unconfigured-stt" | "unconfigured-llm",
  "scope": "shows" | "sessions", "show_ids": [string] | null,
  "steps": ["transcript" | "events" | "topics" | "wiki"],
  "wiki_mode": "accept" | "pending",
  "initiator_id": string, "initiator_name": string,
  "cancel_requested_by_name": string | null, "cancel_requested_at_utc": string | null,
  "created_at_utc": string, "started_at_utc": string | null, "finished_at_utc": string | null,
  "sessions": number,
  "counts": { "pending": number, "running": number, "done": number,
              "skipped": number, "failed": number, "cancelled": number },
  "current": { "session_id": string, "step": string } | null }
```

- **`steps`** lists the selected steps in run order; **`show_ids`** is null for a session-list job.
- **`counts`** counts item rows (one per session and selected step) by status.
- **`current`** names the item now running, or null.
- **`*_name`** follows the wiki page object's rule: given and family name recorded at the time,
  never an email.
- **`stop_reason`** is `cancelled` exactly when `status` is `cancelled`, one of the other values
  exactly when `status` is `failed`, and null otherwise.

Every item SHALL carry an outcome from this fixed list, each with its fixed detail, or null:

| Outcome | Detail |
| --- | --- |
| `present` | `Already had output; left unchanged.` |
| `no-audio` | `The session has no audio to transcribe.` |
| `no-speech` | `No speech was found in the audio.` |
| `no-transcript` | `The session has no transcript words.` |
| `no-anchors` | `The transcript has no timecodes to place events on.` |
| `no-instructions` | `No event button on this show has a generation instruction.` |
| `busy` | `The session stayed busy for 10 minutes.` |
| `access-lost` | `The initiator can no longer access this session.` |
| `session-gone` | `The session no longer exists.` |
| `earlier-step-failed` | `Skipped because an earlier step failed.` |
| `unconfigured` | `No provider is configured for this step.` |
| `provider-failed` | `The provider request failed.` |
| `too-large` | `The audio is over the provider's size limit.` |
| `missing-audio-file` | `An audio file of the session is missing.` |
| `unreadable` | `The audio could not be read.` |
| `generation-failed` | `Generation failed.` |
| `interrupted` | `Interrupted three times; not retried.` |
| `cancelled` | `Cancelled before it started.` |
| `job-stopped` | `The job stopped before this step.` |

`done`, `pending` and `running` items have a null outcome and detail. No other text SHALL appear
in an outcome or detail.

#### Scenario: A finished job reports its counts
- **WHEN** a job over 2 sessions with steps transcript and topics ends with 3 items `done` and 1
  `skipped`
- **THEN** the job object has `status` `finished`, `stop_reason` null, `sessions` 2 and `counts`
  `{"pending":0,"running":0,"done":3,"skipped":1,"failed":0,"cancelled":0}`

### Requirement: Batch autogenerate endpoints
The server SHALL expose these JSON routes. All require a logged-in user (`401
{"detail":"Login required."}`), set no cookie, and decide, before anything else of their own, the
team family's masked `404` (`Team not found`) for a team the caller is not a member of and `403
{"detail":"Admin role required."}` for a `member`.

**Scope body** (preview and start):

```
{ "show_ids"?: [string], "session_ids"?: [string],
  "steps": ["transcript" | "events" | "topics" | "wiki"],
  "wiki_mode"?: "accept" | "pending" }
```

Exactly one of `show_ids` and `session_ids` SHALL be present and non-empty (at most 200 and 1000
ids); `steps` SHALL be non-empty without duplicates; `wiki_mode` defaults to `accept`. Any other
shape answers `400` with the validation body.

**`POST /api/teams/:teamId/autogenerate-jobs/preview`** takes the scope body:

| Status | When | Body |
| --- | --- | --- |
| `400` | invalid body | the validation body |
| `404` | a show id is not a show of the team | `{"detail":"Show not found."}` |
| `404` | a session id is not an accessible, non-deleted session of the team | `{"detail":"Session not found"}` |
| `400` | no candidate session | `{"detail":"No sessions to process."}` |
| `400` | more than 1000 candidate sessions | `{"detail":"A batch job can process at most 1000 sessions."}` |
| `200` | otherwise | `{"sessions": number, "steps": [string], "runs": {<step>: number}, "max_runs": number, "blocked": null \| "unconfigured-stt" \| "unconfigured-llm" \| "not-approved"}` |

- `runs` has one key per selected step: the sessions whose output for that step is missing now
  (for `wiki`, every candidate session). `max_runs` is `sessions × steps`.
- `blocked` names the first reason the caller could not start this job now, in the start route's
  order, or null. The preview writes nothing.

**`POST /api/teams/:teamId/autogenerate-jobs`** takes the scope body plus a required
`"expected_sessions": number`:

| Status | When | Body |
| --- | --- | --- |
| `400` | invalid body | the validation body |
| `404` | show or session not in scope, as for preview | as for preview |
| `400` | no candidate session, or more than 1000 | as for preview |
| `503` | `transcript` is selected and the caller has no speech-to-text credential | `{"detail":"Add a speech-to-text key in Settings → Advanced to generate transcripts."}` |
| `503` | `events`, `topics` or `wiki` is selected and the caller has no AI route | `{"detail":"Add a language model in Settings → Advanced to autogenerate."}` |
| `403` | the caller isn't an approved user | the existing run-feature 403 |
| `409` | the team has a `queued` or `running` job | `{"detail":"A batch job is already running for this team.","job_id":string}` |
| `409` | the candidate count differs from `expected_sessions` | `{"detail":"The sessions changed since the estimate.","sessions":number}` |
| `201` | the job was created | `{"job": <job object>}` |

The job, its item rows and its candidate order SHALL be written in one transaction, so two
concurrent starts for one team create exactly one job and the other answers the first `409`.

**`GET /api/teams/:teamId/autogenerate-jobs`** SHALL answer `200 {"jobs": [<job object>]}`, the
team's 20 newest jobs, newest first. Query parameters are ignored.

**`GET /api/teams/:teamId/autogenerate-jobs/:jobId`** SHALL answer `200`:

```
{ "job": <job object>,
  "sessions": [{ "session_id": string, "title": string, "show_id": string,
                 "effective_date": string | null, "ordinal": number,
                 "steps": [{ "step": string, "status": "pending" | "running" | "done"
                                       | "skipped" | "failed" | "cancelled",
                             "outcome": string | null, "detail": string | null,
                             "wiki_accepted": number | null, "wiki_pending": number | null }] }] }
```

in processing order; `title` is the session's current title, or `""` when it no longer exists;
`wiki_accepted` and `wiki_pending` are numbers only on a `done` wiki item. A job id that doesn't
exist or belongs to another team answers `404 {"detail":"Job not found."}`.

**`POST /api/teams/:teamId/autogenerate-jobs/:jobId/cancel`** takes no body (any body is ignored):

| Status | When | Body |
| --- | --- | --- |
| `404` | as for the job read | `{"detail":"Job not found."}` |
| `409` | the job already ended | `{"detail":"Job already ended.","status":string}` |
| `200` | the cancel was recorded (repeating it is `200` too) | `{"job": <job object>}` |

A `queued` job is `cancelled` in the `200` body; a `running` job stays `running` with
`cancel_requested_by_name` set until its current step ends.

A wiki revision written by a batch accept SHALL carry the note `accepted suggestion <id> (batch
<job id>)`, or `created from suggestion <id> (batch <job id>)` for a new page, in the wiki revision
endpoints' existing `note` field (show-wiki "A batch job accepts suggestions as its initiator").

#### Scenario: Start, then a second start
- **WHEN** an admin previews 12 sessions and starts with `expected_sessions` 12, and another admin
  of the team then starts a job
- **THEN** the first answer is `201` with a `queued` or `running` job, and the second is `409`
  with the first job's `job_id`

#### Scenario: Unconfigured initiator
- **WHEN** an owner with no `llm` credential, who does not resolve to the Claude CLI, starts a job
  with `topics` selected
- **THEN** the response is the language-model `503` and no job is created

#### Scenario: Member and outsider
- **WHEN** a plain member of team T and a user outside T each call
  `GET /api/teams/T/autogenerate-jobs`
- **THEN** the member gets `403 {"detail":"Admin role required."}` and the outsider gets the
  masked `404`, byte-identical to the answer for a team id that doesn't exist

#### Scenario: Cancel a finished job
- **WHEN** an admin cancels a job whose status is `finished`
- **THEN** the response is `409 {"detail":"Job already ended.","status":"finished"}` and the job
  is unchanged

## MODIFIED Requirements

### Requirement: Run features are limited to approved users

The run-starting routes `POST /api/sessions/:id/ai/chat`, `POST /api/sessions/:id/ai/v2/design`,
`POST /api/sessions/:id/topics/generate`, `POST /api/sessions/:id/events/generate`,
`POST /api/sessions/:id/youtube-import` and `POST /api/sessions/:id/transcript-words/generate` SHALL
respond `403 {"detail": "This feature is limited to approved users on this server."}` to a logged-in
user who may access the session but whose verified login email is not an approved user
(run-status-and-sweeper D9). The bootstrap owner (`BOOTSTRAP_OWNER_EMAIL`) SHALL always be an
approved user, and `RUN_FEATURE_EMAILS`, a comma-separated list whose entries are trimmed and whose
blank entries are dropped, SHALL add approved users to it; unset, blank or all-blank (such as `,`)
SHALL mean the bootstrap owner alone. Every match SHALL use the bootstrap-owner rule (trimmed,
`A`-`Z` folded, exact; a non-ASCII token email never matches). The check SHALL run immediately after
the route's configuration `503` (so every earlier refusal of the route's frozen order, such as
`401`, the session-access `404`, the AI v2 principal `404` and, for events/generate, the body `400`,
keeps its place), and before the in-process slot, the run lease and any subprocess or provider
call. For `ai/v2/design` it SHALL run after both the configuration `503` and the agent-credentials
`503`, that is after the whole shared AI v2 guard prologue, and SHALL NOT be part of that prologue,
which the AI v2 answer route also runs and which stays ungated. Each route's own ordered
requirement or status table SHALL list the `403` at that step. The batch autogenerate start route (`POST /api/teams/:teamId/autogenerate-jobs`) SHALL apply the
same rule to its caller, the job's initiator, at the step its status table lists, and the job
SHALL re-check it before every session it processes (batch-autogenerate). No other route SHALL be
affected.

#### Scenario: A user who is not approved is refused before any work

- **WHEN** a member of the session's show whose email is not in `RUN_FEATURE_EMAILS` posts to any of
  the six routes on a configured deployment
- **THEN** the response is `403` with the fixed detail, no subprocess or provider call is made, no
  in-process slot is taken, and no run lease row is written

#### Scenario: Unset list means the bootstrap owner

- **WHEN** `RUN_FEATURE_EMAILS` is unset and the bootstrap owner posts to one of the six routes
- **THEN** the request proceeds to the route's existing behavior

#### Scenario: An all-blank list means the bootstrap owner alone

- **WHEN** `RUN_FEATURE_EMAILS` is `,` (only blank entries), and the bootstrap owner and then
  another member of the session's show post to one of the six routes on a configured deployment
- **THEN** the bootstrap owner's request proceeds to the route's existing behavior, and the other
  member's request is answered `403` with the fixed detail

#### Scenario: Granting someone keeps the owner approved

- **WHEN** `RUN_FEATURE_EMAILS` names only another member's address, and the bootstrap owner posts to
  one of the six routes on a configured deployment
- **THEN** the bootstrap owner's request proceeds to the route's existing behavior, and the named
  member is admitted too

#### Scenario: An unconfigured feature still answers 503

- **WHEN** a user who is not approved posts to a route whose feature is not configured
- **THEN** the response is the route's existing `503`, not `403`

#### Scenario: A batch job's initiator must be approved

- **WHEN** an admin of a team whose email is not an approved user posts a valid start request to
  `POST /api/teams/:teamId/autogenerate-jobs` on a configured deployment
- **THEN** the response is `403` with the fixed detail and no job is created
