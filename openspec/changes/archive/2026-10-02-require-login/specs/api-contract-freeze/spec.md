## MODIFIED Requirements

### Requirement: Transcript generation lock status endpoint
`GET /api/transcript-generation/status` SHALL be frozen surface with:

| Condition | Response |
|---|---|
| No generation run in flight | `200 { "in_flight": false }` |
| Generation run in flight | `200 { "in_flight": true, "session_id": string\|null, "session_title": string\|null, "started_at": string }` |

`started_at` SHALL be ISO-8601 UTC. For a requester permitted to view the holding
session (a member of its studio — the same membership scope sibling routes enforce by
404), `session_id` SHALL be the holder's id and `session_title` SHALL be the catalog
title at read time or `null` if the session row is absent. For a requester lacking that
membership, `session_id` and
`session_title` SHALL both be `null` — same key set, never absent keys, `in_flight`
still `true`. The route MUST NOT mutate generation state. Auth SHALL match sibling
transcript list routes.

#### Scenario: Idle response shape
- **WHEN** the slot is free
- **THEN** the response is `200` with `in_flight` false

#### Scenario: Busy response shape
- **WHEN** the slot is held
- **THEN** the response is `200` with `in_flight` true and the busy fields populated as
  specified — identifiers for permitted requesters, `session_id`/`session_title` nulled
  (same key set) for requesters without membership of the holding session

### Requirement: Transcript generation endpoint behavior
`POST /api/sessions/:sessionId/transcript-words/generate` SHALL move from unconditional
`503` to configuration-dependent behavior, which becomes frozen surface on shipping:

| Condition | Response |
|---|---|
| `DEEPGRAM_API_KEY` unset/blank | `503 {detail}` — identical to the current unavailable response |
| configured, success | `200 {words: [...]}` — each word in the same trimmed wire shape `GET …/transcript-words` returns, namely exactly the seven keys `{id, session_time, speaker, word, start_sec, end_sec, ordinal}`; `start_sec`/`end_sec` carry remapped session-timeline seconds (`0` for anchorless words) rounded to 3 decimals; the array is the complete post-replace list in ordinal order |
| configured, session has no audio segments | `400 {detail}` |
| configured, segments exist but none is readable | `400 {detail}` (distinct detail) |
| configured, provider succeeds but returns zero words | `400 {detail}` (no-speech detail); existing words preserved |
| configured, another generation run in flight | `409 {detail}`; the detail names the busy session (title preferred, else id) when the requester may view it (a member of the holder's studio), and falls back to the identifier-free generic in-flight detail for non-members or when the holder released in the race; no provider request issued |
| configured, request aborted before any provider call | `400 {detail}` — a distinct aborted detail, not `200`/`503`; no provider request issued |
| configured, upstream STT failure/timeout, or a group file over the provider size limit | `502 {detail}` |

`session_id` and `created_at_utc` SHALL NOT appear on any transcript-word wire object: the
former was redundant with the path parameter the caller already holds, the latter is
server-internal bookkeeping. The store and the per-session database keep both, so
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
- **WHEN** a generate request arrives while another run is already in flight and the
  requester is a member of the holder's studio
- **THEN** the response is `409 {detail}` that identifies the busy session, and no
  provider spend occurs for it

#### Scenario: Concurrent run 409 is identifier-free for non-members
- **WHEN** a generate request from a requester without membership of the
  holder's studio arrives while another run is in flight
- **THEN** the response is `409` with the generic in-flight `{detail}` naming no session,
  and no provider spend occurs for it

#### Scenario: Pre-provider-call abort maps to 400, not a new status code
- **WHEN** the originating HTTP request is already aborted before any DeepGram request
  would be issued
- **THEN** the response is `400 {detail}` with a detail distinct from the no-audio and
  all-unreadable `400` details, and no provider spend occurs

#### Scenario: Sibling stubs stay frozen
- **WHEN** a configured deployment receives `GET /api/sessions/:id/transcribe.csv`
- **THEN** it still responds with the current `503 {detail}`

### Requirement: YouTube import endpoint behavior

`POST /api/sessions/:sessionId/youtube-import` SHALL move from unconditional `503` to
configuration-dependent behavior, which becomes frozen surface on shipping:

| Condition | Response |
|---|---|
| no `yt-dlp` available (no configured path and none on `PATH`) | `503 {detail}` — identical to the current unavailable response |
| configured, malformed body or non-allowlisted / unparseable `url` | `400 {detail}`; no subprocess spawned |
| configured, another import for the same session in flight, OR the global concurrency ceiling is reached | `409 {detail}`; no subprocess spawned |
| configured, success | `200 {ok: true}` — one downloaded audio segment attached to the session; if `use_publish_date` is true and the video reports an upload date, the session's `episode_date` is set from it (best-effort: a failed episode-date or catalog-mirror write after the segment is attached is logged and still returns this success) |
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

#### Scenario: Concurrent same-session import or global-ceiling maps to 409

- **WHEN** a configured deployment receives a `youtube-import` request for a session whose
  previous import is still running, or when the global concurrency ceiling is already reached
- **THEN** the response is `409 {detail}` and no subprocess is spawned

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

### Requirement: Topic generation endpoint behavior

`POST /api/sessions/:sessionId/topics/generate` SHALL move from unconditional `503` to
configuration-dependent behavior, which becomes frozen surface on shipping:

| Condition | Response |
|---|---|
| `CLAUDE_CLI_PATH` unset/blank | `503 {detail}` — identical to the current unavailable response |
| configured, another AI turn (chat or generate) holds the session slot, or global ceiling reached | `409 {detail}`; no subprocess |
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

- **WHEN** a configured request has no transcript / hits the turn bound / the CLI turn fails
- **THEN** the response is `400` / `409` / `502` respectively (each `{detail}`-shaped),
  distinct from the unconfigured `503`

#### Scenario: transcribe.csv stays frozen

- **WHEN** a configured deployment receives `GET /api/sessions/:id/transcribe.csv`
- **THEN** it still responds with the current `503 {detail}`

### Requirement: Show-scoped log-import job endpoints

The published HTTP contract SHALL include:

- `POST /api/shows/:showId/log-import` — body `{ spreadsheet_url: string }`;
  success `200 { job_id: string }`; validation/authorization failures use
  `{ detail }` with appropriate 4xx. Missing show AND an authenticated
  requester without membership of the show's studio both get the uniform
  `404 { detail: "Show not found." }` (no existence oracle). The route is
  configuration-gated: unless `SHEETS_LOG_IMPORT_ENABLED` is `1`/`true`/`yes`
  (trimmed, case-insensitive) it responds `503 { detail }` with detail
  "Google Sheets log import is not configured on this deployment. Set
  SHEETS_LOG_IMPORT_ENABLED=1 to enable it."; the checks run in the order
  membership 404 → config gate → body validation.
- `GET /api/log-import/:jobId` — success `200` with a JSON job status object
  including at least `status` (`queued`|`running`|`completed`|`failed`),
  `lines` (string array progress), and `error` (string or null). The route is
  creator-scoped: unknown job ids and jobs created by a different user both
  get the uniform
  `404 { detail: "Log import job not found." }`. It is NOT egress-gated
  (local in-process state only). Terminal jobs are prunable one hour after
  finishing and the in-memory job map is capped at 200 entries (oldest
  terminal evicted first; queued/running jobs never evicted), so a terminal
  job's status is only promised for about an hour after it finishes.

These endpoints are additive. Existing event POST/PUT shapes remain unchanged;
imported events are created server-side by the job (not via a new public
create-at-arbitrary-timecode client endpoint in this change).

#### Scenario: POST accepts a spreadsheet URL and returns a job id

- **WHEN** an authorized client POSTs a non-empty `spreadsheet_url` for an
  existing show on a configured deployment
- **THEN** the response is `200 { job_id }` and a subsequent GET for that id by
  the same requester is not `404`

#### Scenario: Unconfigured deployment is 503

- **WHEN** `SHEETS_LOG_IMPORT_ENABLED` is unset/blank and an authorized client
  POSTs to log-import for an existing show
- **THEN** the response is `503 { detail }` naming `SHEETS_LOG_IMPORT_ENABLED`
  and no job is created

#### Scenario: Non-creator status read is a uniform 404

- **WHEN** an authenticated user GETs a log-import job created by another user
- **THEN** the response is `404 { detail: "Log import job not found." }`,
  byte-identical to the unknown-id response

### Requirement: Show detail is addressable by id

The server SHALL expose `GET /api/shows/:showId`, returning `200 { show }` where `show` is
the **full** show serializer output (the same shape `GET /api/shows` and `POST /api/shows`
emit: `id`, `studio_id`, `name`, `show_code`, `title_suffix`, `categories`,
`event_palette`, `event_palette_preset`, `event_palette_custom`). Authorization SHALL
mirror `GET /api/shows`: the requester MUST be signed in and a member of the show's studio.

An unknown show id and a requester who is not a member of the show's studio SHALL both
produce an **identical** `404 { detail }` — same status, same body — so the route cannot be
used as an existence oracle for another tenant's show ids. This mirrors the pinned-404
posture the sibling routes already take for cross-tenant reads.

#### Scenario: Member reads a show by id

- **WHEN** a requester who is a member of the show's studio requests
  `GET /api/shows/:showId` for an existing show
- **THEN** the response is `200 { show }` carrying the full show shape, including
  `categories` and the three palette fields

#### Scenario: Unknown show id is a 404

- **WHEN** a requester requests `GET /api/shows/:showId` for an id no show has
- **THEN** the response is `404 { detail }`

#### Scenario: Non-member gets the same 404 as an unknown id

- **WHEN** a signed-in requester who is not a member of the show's studio requests
  `GET /api/shows/:showId` for a show that does exist
- **THEN** the response is `404` with a body byte-identical to the unknown-id response, and
  nothing in the status or body distinguishes the two cases

### Requirement: API_TOKEN authenticates only the Companion surface
A request's `API_TOKEN` bearer credential SHALL be honoured only when the request path is
under `/api/companion/`. Here and in the login gate, "the request path" is the percent-decoded
path the router matches, so an encoded spelling of a path (for example `/%61pi/companion/state`
or `/%61pi/sessions`) is treated exactly as its literal form. On every other path, including
every other `/api/*` route, the
`/api/sessions/:id/ws` upgrade (any `role`), `/auth/*`, and `/api/admin/*`, a request that
carries a valid `API_TOKEN` and no other credential SHALL be handled exactly as a request
that carries no credential: `401` with `{"detail": "Login required."}` wherever a request
with no credential gets that response. `ADMIN_TOKEN` handling on `/api/admin/*` is unchanged. This requirement
authorizes a breaking change to fielded headless clients that used `API_TOKEN` outside
`/api/companion/*`. Deployed Companion modules call only
`/api/companion/{state,categories,log,transport,command}` and are unaffected.

#### Scenario: Companion routes still accept the token
- **WHEN** `GET /api/companion/state` is sent with a valid
  `API_TOKEN` bearer and no session cookie
- **THEN** the response is `200` with the frozen state shape

#### Scenario: Token no longer opens other API routes
- **WHEN** `GET /api/sessions` is sent with a valid `API_TOKEN`
  bearer and no session cookie
- **THEN** the response is `401` `{"detail": "Login required."}`

#### Scenario: Token no longer opens the session WebSocket
- **WHEN** `/api/sessions/<id>/ws?role=companion` is opened with a
  valid `API_TOKEN` bearer and no session cookie
- **THEN** the upgrade is refused exactly as for an unauthenticated client

#### Scenario: Token outside the Companion surface is inert under open login
- **WHEN** `GET /api/sessions/<id>/ai/v2/dashboard` is called with a valid `API_TOKEN` bearer
  and no session cookie
- **THEN** the response is identical to the same request sent with no `Authorization`
  header: `401` `{"detail": "Login required."}`

#### Scenario: Encoded spellings get the literal path's answer
- **WHEN** with no session cookie, `GET /%61pi/sessions` is sent
  with no credential, `GET /%61pi/companion/state` is sent with no credential, and
  `GET /api/%63ompanion/state` is sent with a valid `API_TOKEN` bearer
- **THEN** the first two get `401` `{"detail": "Login required."}` and the third gets `200`
  with the frozen state shape, exactly as `/api/sessions` and `/api/companion/state` do

## ADDED Requirements

### Requirement: Login is required on every API route
Login SHALL always be required; there is no setting that turns it off. A `/api/*` request
without a valid session cookie SHALL get `401` with `{"detail": "Login required."}`, except:
- `GET /api/profile` and `HEAD /api/profile` (HEAD is served by the GET handler), which answer
  signed-out callers with the frozen profile response;
- `/api/admin/*`, which authenticates with `ADMIN_TOKEN`;
- `/api/companion/*` with a valid `API_TOKEN` bearer, as "API_TOKEN authenticates only the
  Companion surface" specifies (no studio-membership scoping).

The decision uses the percent-decoded request path the router matches, as defined in "API_TOKEN
authenticates only the Companion surface". `/auth/*` is unchanged. The `/api/sessions/:id/ws`
upgrade SHALL be refused for a caller without a valid session cookie. Every studio-membership
check SHALL apply to the signed-in user; the only caller with no user is `API_TOKEN` on
`/api/companion/*`. In the `GET /api/profile` response, `auth.oauth_configured` SHALL always be
`true`.

#### Scenario: Signed-out session list is refused
- **WHEN** `GET /api/sessions` is sent with no session cookie and no other credential
- **THEN** the response is `401` `{"detail": "Login required."}`

#### Scenario: Signed-out profile keeps its shape
- **WHEN** `GET /api/profile` is sent with no session cookie
- **THEN** the response is `200` with its frozen shape, `auth.logged_in` false and
  `auth.oauth_configured` true

#### Scenario: Signed-out HEAD of the profile is exempt
- **WHEN** `HEAD /api/profile` is sent with no session cookie and no other credential
- **THEN** the response is `200` with no body, not `401`

#### Scenario: Signed-out profile update is refused
- **WHEN** `PUT /api/profile` is sent with no session cookie
- **THEN** the response is `401` `{"detail": "Login required."}` and nothing is written
