## REMOVED Requirements

### Requirement: YouTube import endpoint behavior

**Reason**: The process-wide ceiling it required is removed on `AI_PROVIDER=claude_cli` (run-status-and-sweeper D2), so its title and ceiling scenarios no longer describe the behaviour. Restated under "YouTube import endpoint behavior per session".

## MODIFIED Requirements

### Requirement: Transcript generation lock status endpoint
`GET /api/transcript-generation/status` SHALL be frozen surface with:

| Condition | Response |
|---|---|
| No generation run in flight | `200 { "in_flight": false }` |
| Generation run in flight | `200 { "in_flight": true, "session_id": string\|null, "session_title": string\|null, "started_at": string }` |

`started_at` SHALL be ISO-8601 UTC. For a requester permitted to view the holding
session (one who can access its show — the same access rule sibling routes enforce by
404), `session_id` SHALL be the holder's id and `session_title` SHALL be the catalog
title at read time or `null` if the session row is absent. For a requester lacking that
access, `session_id` and
`session_title` SHALL both be `null` — same key set, never absent keys, `in_flight`
still `true`. The route MUST NOT mutate generation state. Auth SHALL match sibling
transcript list routes.

The route SHALL report the whole deployment, not one process: a run is in flight when any process
sharing the database holds a live `transcript-generation` run lease with a start time, and the
holding session is the one whose lease has the earliest `started_at_ms` (ties by session id).
`started_at` SHALL be that lease's `started_at_ms` (run-status-and-sweeper D5). The body shape,
the redaction and the status codes are unchanged.

#### Scenario: Idle response shape
- **WHEN** no process sharing the database holds a live `transcript-generation` lease
- **THEN** the response is `200` with `in_flight` false

#### Scenario: Busy response shape
- **WHEN** a live `transcript-generation` lease is held, in this or another process
- **THEN** the response is `200` with `in_flight` true and the busy fields populated as
  specified — identifiers for permitted requesters, `session_id`/`session_title` nulled
  (same key set) for requesters without access to the holding session (non-members, and
  members without a grant for its show)

#### Scenario: A run in another process is reported
- **WHEN** a run for session S holds its lease through process A, and a member of S's show reads
  the status through process B sharing the database
- **THEN** B responds `200` with `in_flight` true, `session_id` S and S's start time

### Requirement: Transcript generation endpoint behavior
`POST /api/sessions/:sessionId/transcript-words/generate` SHALL move from unconditional
`503` to configuration-dependent behavior, which becomes frozen surface on shipping:

| Condition | Response |
|---|---|
| `DEEPGRAM_API_KEY` unset/blank | `503 {detail}` — identical to the current unavailable response |
| configured, requester not an approved user (see "Run features are limited to approved users") | `403 {"detail": "This feature is limited to approved users on this server."}`; checked before every row below, no provider request issued |
| configured, success | `200 {words: [...]}` — each word in the same trimmed wire shape `GET …/transcript-words` returns, namely exactly the seven keys `{id, session_time, speaker, word, start_sec, end_sec, ordinal}`; `start_sec`/`end_sec` carry remapped session-timeline seconds (`0` for anchorless words) rounded to 3 decimals; the array is the complete post-replace list in ordinal order |
| configured, session has no audio segments | `400 {detail}` |
| configured, segments exist but none is readable | `400 {detail}` (distinct detail) |
| configured, provider succeeds but returns zero words | `400 {detail}` (no-speech detail); existing words preserved |
| configured, another generation run for the same session in flight, in this or another process | `409 {detail}`; the detail names the busy session (title preferred, else id) and the run's start time when the requester may view it (can access the session's show), and falls back to the identifier-free generic in-flight detail for requesters without that access or when the run's start time can no longer be read (the holder released in the race, or its lease has no start time); no provider request issued. A run for another session never causes this `409` (run-status-and-sweeper D3) |
| configured, request aborted before any provider call | `400 {detail}` — a distinct aborted detail, not `200`/`503`; no provider request issued |
| configured, upstream STT failure/timeout, or a group file over the provider size limit | `502 {detail}` |

`session_id` and `created_at_utc` SHALL NOT appear on any transcript-word wire object: the
former was redundant with the path parameter the caller already holds, the latter is
server-internal bookkeeping. The store and the session tables keep both, so
server-internal consumers that read the hub directly are unaffected. Full float precision
for `start_sec`/`end_sec` likewise stays in the store; the rounding is a wire-only
projection.

Existing route semantics are otherwise unchanged: unknown session → the existing
`requireSession` behavior; the request body remains ignored/empty. Every transcript-word
response emits that one trimmed shape — the `GET …/transcript-words` list, the generate
`200`, the create `201`, and the `PATCH` response — and no other transcription surface
changes: `DELETE …/transcript-words/:wordId`, `…/topics` CRUD, and `transcribe.csv` (`503`)
keep their current frozen behavior, except that `GET /api/transcript-generation/status` is
an additional authorized surface (see above).

#### Scenario: Unconfigured deployments are byte-for-byte unchanged
- **WHEN** a deployment without `DEEPGRAM_API_KEY` receives `POST
  /api/sessions/:id/transcript-words/generate`
- **THEN** the response status and body match the pre-change `503 {detail}` exactly

#### Scenario: Configured success returns the list shape
- **WHEN** a configured deployment successfully generates a transcript
- **THEN** the response is `200` with `{words}` whose entries match the shape of
  `GET /api/sessions/:id/transcript-words` entries

#### Scenario: Every transcript-word response carries the trimmed seven-key shape
- **WHEN** a client reads `GET …/transcript-words`, generates words, creates a word
  (`201`), or patches one
- **THEN** each returned word object has exactly the keys `id`, `session_time`, `speaker`,
  `word`, `start_sec`, `end_sec`, and `ordinal`, with `start_sec`/`end_sec` rounded to 3
  decimals and neither `session_id` nor `created_at_utc` present

#### Scenario: Concurrent run maps to 409 naming the holder
- **WHEN** a generate request for session S arrives while another run for S is already in flight,
  in this or another process, and the requester can access S's show
- **THEN** the response is `409 {detail}` that identifies the busy session and its start time, and
  no provider spend occurs for it

#### Scenario: Concurrent run 409 is identifier-free for non-members
- **WHEN** a generate request for session S from a requester without access to S's show (not a
  member of its studio, or a member without a grant for it) arrives while a run for S is in flight
- **THEN** the existing `requireSession` behavior answers it, so no response names the session,
  and no provider spend occurs for it

#### Scenario: Runs for different sessions are both admitted
- **WHEN** a configured deployment receives a generate request for session R while a run for
  session S is in flight, in this or another process
- **THEN** R's request is not answered `409`

#### Scenario: Pre-provider-call abort maps to 400, not a new status code
- **WHEN** the originating HTTP request is already aborted before any DeepGram request
  would be issued
- **THEN** the response is `400 {detail}` with a detail distinct from the no-audio and
  all-unreadable `400` details, and no provider spend occurs

#### Scenario: Sibling stubs stay frozen
- **WHEN** a configured deployment receives `GET /api/sessions/:id/transcribe.csv`
- **THEN** it still responds with the current `503 {detail}`

### Requirement: Topic generation endpoint behavior

`POST /api/sessions/:sessionId/topics/generate` SHALL move from unconditional `503` to
configuration-dependent behavior, which becomes frozen surface on shipping:

| Condition | Response |
|---|---|
| `CLAUDE_CLI_PATH` unset/blank | `503 {detail}` — identical to the current unavailable response |
| configured, requester not an approved user (see "Run features are limited to approved users") | `403 {"detail": "This feature is limited to approved users on this server."}`; checked before every row below, no subprocess |
| configured, another AI turn (chat, AI v2 design, event generation or topic generation) holds the session slot, in this or another process | `409 {detail}`; no subprocess. On `AI_PROVIDER=claude_cli` there is no global ceiling, so turns for other sessions never cause this `409` (run-status-and-sweeper D2) |
| configured, session has no transcript words | `400 {detail}`; no subprocess |
| configured, success | `200 {topics: [...]}` — the session's topics after a crash-safe replace-all generation (prior topics deleted only after the fresh set is created), in the same shape `GET …/topics` returns |
| configured, CLI turn failure (spawn/timeout/CLI error/zero topics created) | `502 {detail}`; the session's prior topics are **unchanged, byte-for-byte** (never modified — the fresh topics this run created are removed) |

Existing route semantics are otherwise unchanged: an unknown/inaccessible session → the
existing `requireSession` behavior. No other stubbed surface changes — `transcribe.csv` keeps
its frozen `503`. The topics CRUD routes (`GET/POST/PATCH/DELETE …/topics`) are unchanged.

#### Scenario: Unconfigured deployments are byte-for-byte unchanged

- **WHEN** a deployment with no `CLAUDE_CLI_PATH` receives `POST
  /api/sessions/:id/topics/generate`
- **THEN** the response status and body match the pre-change `503 {detail}` exactly, and no
  subprocess is spawned

#### Scenario: Configured success returns the topics list shape

- **WHEN** a configured deployment successfully generates topics
- **THEN** the response is `200` with `{topics}` whose entries match
  `GET /api/sessions/:id/topics` entries

#### Scenario: No-transcript maps to 400, concurrency to 409, CLI failure to 502

- **WHEN** a configured request has no transcript / finds the session's turn slot held / the CLI
  turn fails
- **THEN** the response is `400` / `409` / `502` respectively (each `{detail}`-shaped),
  distinct from the unconfigured `503`

#### Scenario: transcribe.csv stays frozen

- **WHEN** a configured deployment receives `GET /api/sessions/:id/transcribe.csv`
- **THEN** it still responds with the current `503 {detail}`

### Requirement: The session revision advances once per session write
A session's revision SHALL advance by exactly one for each committed session write transaction
that changed at least one of the session's content rows, of any kind: events, transport, audio
segments, transcript words and enrichment, topics, dashboards, session metadata, and the recording
lease's state. For the recording lease, a claim that takes or refreshes the lease, a release, and an
expiry that frees it SHALL each count as a change; a heartbeat SHALL NOT, even though it extends the
lease. A transaction that changes no row, and every read, SHALL leave it unchanged. Two internal writes SHALL NOT count as changes: the seed a session's runtime writes
when it first opens the session, and the bookkeeping the event list's orphan relink check writes;
so listing events SHALL leave it unchanged unless the relink changes an event. A run lease
(kinds `ai-turn`, `transcript-generation` and `youtube-import`, ADR 0021 slice 8b) is not content:
claiming, renewing, releasing or overwriting one, and the lease sweeper deleting an expired one
(run-status-and-sweeper D6), SHALL leave the revision unchanged. The sweeper freeing an expired
recording lease is that lease's expiry, and SHALL advance the revision once. It SHALL never decrease, and two committed writes of one session SHALL never carry the
same value.

The existing fields carry this revision, with their names and shapes unchanged:
- `revision` in the `event.changed` WebSocket frame, which is the revision of the transaction that
  emitted the frame;
- `events_stream_revision` in `GET /api/sessions/:id/status` and `GET /api/companion/state`.

`event.changed` SHALL still be emitted only where it was emitted before; a write that changes no
event SHALL still emit none. A transaction that changes several events (an imported take's
`Recording N` events) SHALL advance the revision by one, not by one per event.

#### Scenario: A transcript edit advances the revision
- **WHEN** a client reads the session status, patches a transcript word, and reads the status again
- **THEN** `events_stream_revision` grew by exactly one, and no `event.changed` frame was sent

#### Scenario: A read leaves the revision unchanged
- **WHEN** a client lists the events (first page, so the orphan relink check runs), the words and
  the topics of a session twice
- **THEN** `events_stream_revision` is the same before and after

#### Scenario: Frames carry their transaction's revision
- **WHEN** a client logs two events one after the other while a socket is attached
- **THEN** the two `event.changed` frames carry consecutive revisions, and the status read after
  the second shows the second frame's revision

#### Scenario: Existing revisions carry over
- **WHEN** the migration is applied to a session whose `events_stream_revision` was 17
- **THEN** its status reports 17, and its next write reports 18

#### Scenario: A heartbeat leaves the revision unchanged
- **WHEN** a client claims the recording lease, reads the status, heartbeats three times, and reads
  the status again
- **THEN** `events_stream_revision` is the same in both reads

#### Scenario: Lease claims, releases and expiries each advance it once
- **WHEN** a client claims the lease, another client's claim is refused, the holder releases it, a
  client claims it again, and the lease then expires and is freed
- **THEN** the revision advanced by exactly one for the first claim, the release, the second claim
  and the expiry each, and not at all for the refused claim

#### Scenario: Run leases leave the revision unchanged
- **WHEN** a client reads the session status, runs an AI chat turn on the session that calls no
  write tool (the `ai-turn` lease is claimed, renewed and released around it), and reads the status
  again
- **THEN** `events_stream_revision` is the same in both reads

#### Scenario: A swept run lease leaves the revision unchanged
- **WHEN** a session's `ai-turn` lease expires without a release, a lease sweeper tick deletes it,
  and a client reads the session status before and after the tick
- **THEN** `events_stream_revision` is the same in both reads, and no frame was sent

## ADDED Requirements

### Requirement: YouTube import endpoint behavior per session

`POST /api/sessions/:sessionId/youtube-import` SHALL move from unconditional `503` to
configuration-dependent behavior, which becomes frozen surface on shipping:

| Condition | Response |
|---|---|
| no `yt-dlp` available (no configured path and none on `PATH`) | `503 {detail}` — identical to the current unavailable response |
| configured, requester not an approved user (see "Run features are limited to approved users") | `403 {"detail": "This feature is limited to approved users on this server."}`; checked before every row below, including the body `400`, no subprocess spawned |
| configured, malformed body or non-allowlisted / unparseable `url` | `400 {detail}`; no subprocess spawned |
| configured, another import for the same session in flight, in this or another process | `409 {detail}`; no subprocess spawned. On `AI_PROVIDER=claude_cli` there is no global concurrency ceiling, so imports for other sessions never cause this `409` (run-status-and-sweeper D2) |
| configured, success | `200 {ok: true}` — one downloaded audio segment attached to the session; if `use_publish_date` is true and the video reports an upload date, the session's `episode_date` is set from it (best-effort: a failed episode-date write after the segment is attached is logged and still returns this success; the session's live projection commits with the anchor, so it cannot fail separately) |
| configured, download/extraction failure, hang timeout, over the 4-hour duration cap, over the byte-size cap, a live/unknown-duration stream, an unsupported produced container, or a blob-write failure | `502 {detail}`; no audio segment attached (any inserted metadata row is rolled back) |

Existing route semantics are otherwise unchanged: an unknown or inaccessible session →
the existing `requireSession` behavior. The success body remains `{ok: true}` — the shape
the client's `useYoutubeImport` mutation already reads. The session JSON shape returned by
list/detail routes is unchanged: `episode_date` was already a nullable field, and this
change only lets a successful opt-in import populate it (a value change, not a shape
change). No other stubbed surface changes — `…/topics/generate` and `transcribe.csv` keep
their current frozen `503`.

#### Scenario: Deployments without yt-dlp are byte-for-byte unchanged

- **WHEN** a deployment with no configured `yt-dlp` path and no `yt-dlp` on `PATH` receives
  `POST /api/sessions/:id/youtube-import`
- **THEN** the response status and body match the pre-change `503 {detail}` exactly, and no
  subprocess spawn or outbound YouTube request occurs

#### Scenario: Open-network deployment maps to 503

- **WHEN** a signed-in member's `POST /api/sessions/:id/youtube-import` reaches a configured
  deployment bound to a non-loopback address with no `IP_ALLOWLIST`
- **THEN** no open-network `503` is returned (that refusal is removed: login is always
  required), and the response follows the matrix above

#### Scenario: Concurrent same-session import maps to 409; other sessions are not refused

- **WHEN** a configured deployment receives a `youtube-import` request for a session whose
  previous import is still running, and, on `AI_PROVIDER=claude_cli`, another request for an idle
  session while imports for two other sessions are running
- **THEN** the first response is `409 {detail}` and no subprocess is spawned for it; the second is
  not refused, since no global ceiling applies

#### Scenario: Configured success returns the frozen ok shape

- **WHEN** a configured deployment successfully imports a video's audio
- **THEN** the response is `200` with body `{ok: true}`, and the session gains exactly one
  audio segment

#### Scenario: Non-allowlisted URL maps to 400 before any spend

- **WHEN** a configured deployment receives a request whose `url` host is not an exact member
  of the YouTube allowlist (e.g. `youtube.com.evil.com`) or is not a parseable `http(s)` URL
- **THEN** the response is `400 {detail}` and no `yt-dlp` subprocess is spawned

#### Scenario: Download/extraction failure or unsupported container maps to 502

- **WHEN** a configured, validated request fails to download or extract audio, times out,
  breaches the byte/duration bound, is a live/unknown-duration stream, produces an
  unsupported container, or the blob write fails
- **THEN** the response is `502 {detail}` — distinct from the unconfigured `503` —
  and no audio segment is attached (any inserted metadata row is rolled back)

#### Scenario: Sibling stubs stay frozen

- **WHEN** a configured deployment receives `POST /api/sessions/:id/topics/generate` or
  `GET /api/sessions/:id/transcribe.csv`
- **THEN** both still respond with the current `503 {detail}`

#### Scenario: Session JSON shape is unchanged

- **WHEN** a session that was populated by an opt-in import is listed or fetched
- **THEN** its JSON has the same fields as before, with `episode_date` now carrying the
  imported date rather than `null` — no field added, removed, or retyped

#### Scenario: A failed anchor leaves no segment
- **WHEN** a configured import's audio is fetched and stored, and the transaction that anchors the
  take (its `Recording N` events, the transport advance and the live projection) then fails
- **THEN** the response is `502 {detail}`, the session has no new audio segment, and its events,
  transport and listed `event_count` are unchanged

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
requirement or status table SHALL list the `403` at that step. No other route SHALL be affected.

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
