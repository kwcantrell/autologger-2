# api-contract-freeze

## Purpose

The server's externally observable HTTP/WS contract is frozen. This capability replaces
the retired "Python parity" anchor. The freeze exists because real consumers depend on the
surface — the in-repo `web/` frontend, the separately-deployed Bitfocus Companion module,
the `e2e/` Playwright suite, and external API clients (bearer-token scripts, stale
Companion installs) — but consumers are the *reason* for the freeze, not its measuring
stick. The frozen surface is the full published surface (the README endpoint table is the
normative route inventory), independent of what any consumer currently reads.
## Requirements
### Requirement: Frozen HTTP/WS contract
The server SHALL preserve its entire published externally observable contract, including
but not limited to: the endpoint inventory (routes and methods; the README endpoint table
is the normative list), JSON response shapes, status codes, non-JSON response bodies
(CSV/JSONL exports), header and range-request semantics (e.g. `Content-Range` on audio
download), and WebSocket message shapes *and emission semantics* (which events fire and
when, not only their payloads). New API surface MUST NOT be added, and existing observable
behavior MUST NOT change, without an OpenSpec change whose delta spec authorizes it.

Two explicit non-loopholes:

- Absence of a current in-repo caller does NOT unfreeze any endpoint or field — surface
  kept for stale or external clients (e.g. `/api/companion/commands/wait`) is as frozen
  as surface `web/` reads on every render.
- Updating in-repo consumers in the same change does NOT exempt the server delta —
  deployed Companion module versions lag the repo, so "both sides moved together" still
  breaks fielded installs.

#### Scenario: Change proposal states contract impact
- **WHEN** a change proposal is drafted for this repo
- **THEN** it explicitly states the observable HTTP/WS contract impact

#### Scenario: Contract-affecting diff carries an authorizing delta spec
- **WHEN** a diff alters any published observable behavior (route, method, status code,
  response body shape or format, header semantics, or WS message shape or emission)
- **THEN** a delta spec authorizing that exact change exists under
  `openspec/changes/<name>/specs/`; a diff without one is a contract violation

#### Scenario: Unconsumed surface stays frozen
- **WHEN** an endpoint or response field has no current caller in `web/`, `companion/`,
  or `e2e/`
- **THEN** it remains part of the frozen contract, and removing or altering it still
  requires an authorizing delta spec

#### Scenario: Consumer co-mutation is not an exemption
- **WHEN** a change edits an observable server behavior and updates the in-repo consumers
  to match within the same change
- **THEN** the server delta still requires an authorizing delta spec

### Requirement: OAuth callback failure redirect
`GET /auth/google/callback` SHALL respond to each enumerated failure class with `302`
and `Location: /?login_error=<code>` — no JSON body, no session cookie — where `<code>`
is the stable identifier for the failure class:

| Failure class (in evaluation order) | Code |
|---|---|
| `error` query parameter present (provider/user-cancel) | `provider_error` |
| OAuth not configured | `oauth_not_configured` |
| Missing `code` and/or `state` query parameters | `missing_params` |
| Unknown, reused, or expired CSRF state | `state_invalid` |
| Authorization-code token exchange failed | `exchange_failed` |
| Missing `id_token`, id_token verification failed (including a failed JWKS fetch), or missing `sub` claim | `token_invalid` |

Frozen surface: the redirect mechanism (`302`, `Location: /?login_error=<code>`, empty
body, no `Set-Cookie`) and the meaning and stability of each code listed above — a code,
once emitted, MUST NOT change meaning. The code set is additive-open: new codes MAY be
added without a further authorizing delta, and clients MUST treat unrecognized codes as
a generic sign-in failure.

Boundary rule — the enumerated classes are the handler's **explicit branch returns**,
not a blanket conversion. In particular, `state_invalid` covers only the case where the
state lookup completes and reports the state absent; a thrown or failed store read is an
unexpected internal error and stays `500`. Any uncaught throw (KV, catalog, other
infrastructure) propagates to the app's ordinary `500` handler; the deliberate
caught-and-classified exceptions are the token exchange (→ `exchange_failed`) and
id_token verification including its JWKS fetch (→ `token_invalid`). The handler MUST NOT
blanket-convert all errors to redirects.

Diagnostic detail (the former JSON `detail` strings, including operator guidance such as
`PUBLIC_BASE_URL` mismatch hints) SHALL NOT appear in any response; it is logged
server-side instead. Log content and format are operational behavior, not
client-observable frozen surface — the sanitization requirements for logged
request/provider-derived values are normative in the change's design and tests, not in
this contract.

The success path SHALL remain byte-identical in behavior: set the session cookie and
`302` to `/` with no query parameters.

#### Scenario: User cancels at Google
- **WHEN** Google redirects to `/auth/google/callback?error=access_denied`
- **THEN** the server responds `302` with `Location: /?login_error=provider_error`, sets
  no cookie, and the response carries no diagnostic detail (it is logged server-side)

#### Scenario: Missing OAuth query parameters
- **WHEN** the callback is requested with `code` but no `state` (or vice versa, or
  neither)
- **THEN** the server responds `302` with `Location: /?login_error=missing_params` and
  sets no cookie

#### Scenario: Expired or replayed CSRF state
- **WHEN** the callback receives a `state` and the state lookup completes, reporting it
  absent from the store (expired, already consumed, or forged)
- **THEN** the server responds `302` with `Location: /?login_error=state_invalid` and
  sets no cookie

#### Scenario: Token exchange fails
- **WHEN** the authorization-code exchange with Google returns a non-OK response
- **THEN** the server responds `302` with `Location: /?login_error=exchange_failed`,
  sets no cookie, and the response carries no diagnostic detail

#### Scenario: Callback hit while OAuth unconfigured
- **WHEN** `/auth/google/callback` is requested and OAuth is not configured
- **THEN** the server responds `302` with `Location: /?login_error=oauth_not_configured`
  (replacing the former `503` JSON body)

#### Scenario: Invalid token cluster maps to one code
- **WHEN** the token exchange succeeds but the response lacks an `id_token`, or the
  id_token fails verification, or its claims lack a `sub`
- **THEN** each of those three paths responds `302` with
  `Location: /?login_error=token_invalid` and sets no cookie

#### Scenario: Success path unchanged
- **WHEN** the callback completes successfully (valid state, exchange, and id_token)
- **THEN** the server sets the session cookie and responds `302` with `Location: /`,
  exactly as before this change

#### Scenario: Unexpected internal error stays 500
- **WHEN** the callback fails outside the enumerated classes (e.g. a catalog or KV
  write throws after successful verification, or the CSRF-state read itself throws)
- **THEN** the response is the app's ordinary `500` error — no `login_error` redirect,
  no cookie

### Requirement: Session deep-link HTML route
`GET /sessions/:id`, where `:id` is a single non-empty path segment, SHALL respond
`200` with the SPA index page HTML — the same document body served at `/` — 
unconditionally on whether a session with that id exists and on whether the requester
is authorized to see it. The HTML layer SHALL NOT leak session existence: the response
for a real session, a deleted session, and a foreign team's session is identical.
Authentication happens client-side through the existing `GET /api/profile` surface,
and session resolution through the `GET /api/sessions/:id` detail endpoint this same
delta authorizes below; the HTML route itself adds no JSON surface, sets no cookies,
and takes no query-parameter semantics.

This is an explicit page route, not a catch-all: paths outside the frozen inventory —
including `/sessions` (no id) and `/sessions/<id>/<more>` (nested segments) — keep
their current behavior (the static-asset fallback, `404` when no asset matches).
(Non-normative: a percent-encoded slash, e.g. `/sessions/a%2Fb`, is a single raw path
segment and therefore serves the shell — integration tests must not assert `404` for
the encoded form.)

#### Scenario: Deep link serves the shell
- **WHEN** `GET /sessions/abc-123` is requested (any single non-empty id segment,
  existing session or not, authenticated or not)
- **THEN** the server responds `200` with the SPA index HTML, identical to the document
  served at `/`, with no `Set-Cookie`

#### Scenario: No existence oracle
- **WHEN** `GET /sessions/<id>` is requested for a real session and for a random
  nonexistent id, in either case by an anonymous client
- **THEN** the two responses are indistinguishable (same status, same body)

#### Scenario: Non-matching paths stay 404
- **WHEN** `GET /sessions` or `GET /sessions/a/b` (or any other path outside the
  endpoint inventory) is requested and no static asset matches
- **THEN** the response remains `404`, exactly as before this change

### Requirement: Session detail endpoint
`GET /api/sessions/:id` SHALL respond `200` with a JSON object carrying exactly the
same field set and value semantics as one element of the `active`/`archived` arrays in
the `GET /api/sessions` response (produced by the same serialization, so the shapes
cannot drift), for any session the requester is authorized to access under the same
authorization rule the existing per-session routes use (studio membership via the
session's show), regardless of the requester's active-show or active-studio
preferences and regardless of the session's archived state. It SHALL respond `404` —
indistinguishable across the cases — for a nonexistent id, a deleted (`ui_hidden`)
session, and a session the requester is not authorized to access, preserving the
existing 404-masking posture. Authentication requirements match the other
`/api/sessions/*` routes. This endpoint is additive: the `GET /api/sessions` list
response (scope, shape, and semantics) is unchanged.

#### Scenario: Authorized fetch regardless of active scope
- **WHEN** an authenticated member of the session's studio requests
  `GET /api/sessions/<id>` while their active show or active studio preference points
  elsewhere
- **THEN** the server responds `200` with the session object, field-for-field the
  shape of a `GET /api/sessions` list entry

#### Scenario: Archived session still resolves
- **WHEN** the session exists, the requester is authorized, and the session is
  archived
- **THEN** the server responds `200` with the session object reflecting its archived
  state

#### Scenario: Masked 404 across all denial causes
- **WHEN** `GET /api/sessions/<id>` is requested for an id that never existed, for a
  deleted (`ui_hidden`) session, or for a session in a studio the requester is not a
  member of
- **THEN** every case responds with the same `404` (same shape), with no signal
  distinguishing them

### Requirement: Team management endpoint family
The server SHALL expose the following authenticated team-management routes, which
become frozen surface on shipping. All are JSON; all require a logged-in user
(`401` otherwise); team-scoped routes respond with a masked `404` for teams the
caller is not a member of (nonexistent and foreign teams indistinguishable) and
`403` for member-without-admin-role where noted. Response objects are
additive-open (clients tolerate unknown fields).

| Route | Auth | Behavior |
|---|---|---|
| `POST /api/teams` `{id, display_name}` | any user | create team, caller becomes `admin`; validation errors `400` |
| `GET /api/teams/:id` | member | team detail: `{id, name, role, enabled_admin_count, members: [{id, email, given_name, family_name, role}]}` (`enabled_admin_count` = admins whose accounts are not disabled — the client's orphaned-team signal; per-member disabled status is deliberately not exposed); `invites: [{email, invited_at_utc}]` present only when caller is `admin` |
| `PATCH /api/teams/:id` `{display_name}` | admin | rename (display name only) |
| `DELETE /api/teams/:id` | admin | delete; `400` while shows exist |
| `POST /api/teams/:id/invites` `{email}` | admin | immediate membership for existing users, else pending invite; idempotent per team+email |
| `DELETE /api/teams/:id/invites/:email` | admin | revoke pending invite |
| `POST /api/teams/:id/members/:userId/role` `{role}` | admin | promote/demote; `409` if it would strip the last enabled admin |
| `DELETE /api/teams/:id/members/:userId` | admin | remove member; `409` for last enabled admin |
| `POST /api/teams/:id/leave` | member | caller leaves; `409` for last enabled admin |

**Default behaviors (frozen with the family):** built-in team ids are rejected `400`
on every `/api/teams/:id/*` route; a `:userId` that is not a member of the team →
`404` (`Member not found` — the caller is a team admin, membership of their own team
is not masked from them); role change to the already-held role → `200` idempotent;
invite revocation → `200` idempotent whether or not the invite existed; the
`:email` path segment is percent-decoded, then normalized identically to invite-time
(JS lowercase/trim) before matching; rename shares create's display-name validation
(non-empty, ≤200); invite emails are validated (plausible shape, ≤254 chars);
creation and pending-invite caps reject with `400` and an actionable message. Role
values outside `admin`|`member` are schema-rejected `400`.

#### Scenario: Family is authenticated and masked
- **WHEN** an anonymous client calls any `/api/teams/*` route, and an authenticated
  non-member calls a team-scoped route for a real team and for a nonexistent id
- **THEN** the anonymous call gets `401`, and the two non-member calls get the same
  masked `404`

#### Scenario: Role gate distinguishes 403 from 404
- **WHEN** a plain `member` of a team calls an admin-only route on that team
- **THEN** the response is `403` (they may know the team exists; they may not manage
  it)

### Requirement: Teams page HTML route
`GET /teams` SHALL respond `200` with the SPA index page HTML — the same document
served at `/` and `/sessions/:id` — unconditionally on authentication (the login
gate renders client-side), setting no cookies. Paths below it (`/teams/<more>`)
remain outside the inventory and keep their current behavior.

#### Scenario: Teams deep link serves the shell
- **WHEN** `GET /teams` is requested by an anonymous client
- **THEN** the server responds `200` with the SPA index HTML and no `Set-Cookie`

### Requirement: Profile teams role field
Each entry of the profile payload's `auth.user.teams[]` array SHALL gain a `role`
field (`"admin"` | `"member"`) reflecting the caller's membership role. The field is
additive; all existing profile fields and semantics are unchanged, and clients MUST
tolerate its presence.

#### Scenario: Role visible in profile
- **WHEN** a logged-in user who admins team A and is a member of team B fetches
  `GET /api/profile`
- **THEN** `auth.user.teams` contains A with `role: "admin"` and B with
  `role: "member"`

### Requirement: Admin add-membership role field
The support-plane `POST /api/admin/users/:userId/memberships` body SHALL accept an
optional `role` field (`"admin"` | `"member"`); when absent, behavior is the
existing one with `role` defaulting to `member`. With the role column present the
operation becomes an **upsert**: if the membership already exists, its role is
updated to the requested (or defaulted) value — the pre-change `INSERT OR IGNORE`
no-op would silently fail the rescue path. This is the orphaned-team rescue: support
can mint or promote an `admin` membership for a team whose last admin is gone. The
support plane is deliberately not subject to last-admin protection or built-in
exclusions. All other `/api/admin/*` surface is unchanged.

#### Scenario: Support rescues an orphaned team by promotion
- **WHEN** the admin-token client POSTs a membership with `role: "admin"` for a
  user who is already a plain `member` of a team that currently has no admins
- **THEN** the existing membership's role is updated to `admin` (not silently
  ignored) and the user can manage the team

#### Scenario: Legacy admin body still works
- **WHEN** the admin-token client POSTs a membership body without a `role` field
- **THEN** the request succeeds exactly as before this change, creating a `member`
  membership

### Requirement: New-user membership grant behavior
On first Google sign-in, a new user SHALL receive exactly the memberships
materialized from pending invites matching their normalized email, and only when
the presented id_token carries `email_verified: true` — the former
`NEW_USER_ALL_TEAMS` blanket grant SHALL NOT occur regardless of the environment
variable's value. This is an authorized behavior change to the new-user branch of
`GET /auth/google/callback`; the callback's redirect contract (success `302 /`,
failure `302 /?login_error=<code>`) is untouched.

#### Scenario: New user without invites starts empty
- **WHEN** a Google account with no pending invites completes first sign-in on a
  server with `NEW_USER_ALL_TEAMS=1`
- **THEN** the created user has zero memberships (and the deprecated variable only
  produced a startup warning)

### Requirement: Disabled-account sign-in redirect
When the OAuth callback completes token verification for a Google `sub` whose user
row exists but is disabled, the server SHALL respond `302` with
`Location: /?login_error=account_disabled`, set no cookie, and change nothing —
replacing the current latent `500` (the new-user branch violating the unique
`google_sub` constraint). `account_disabled` joins the login-error code set under
its existing additive-open rule (clients treat unrecognized codes as a generic
sign-in failure); the enumerated failure-class table and the success path are
otherwise untouched.

#### Scenario: Disabled user signs in
- **WHEN** a user whose account is disabled completes the Google OAuth flow
- **THEN** the callback responds `302` to `/?login_error=account_disabled` with no
  cookie, and no user row is created or modified

### Requirement: Transcript generation endpoint behavior
`POST /api/sessions/:sessionId/transcript-words/generate` SHALL move from unconditional
`503` to configuration-dependent behavior, which becomes frozen surface on shipping:

| Condition | Response |
|---|---|
| `DEEPGRAM_API_KEY` unset/blank | `503 {detail}` — identical to the current unavailable response |
| configured, success | `200 {words: [...]}` — each word in the same enriched shape `GET …/transcript-words` returns (store fields plus `session_id`); `start_sec`/`end_sec` carry remapped session-timeline seconds (`0` for anchorless words); the array is the complete post-replace list in ordinal order |
| configured, session has no audio segments | `400 {detail}` |
| configured, segments exist but none is readable | `400 {detail}` (distinct detail) |
| configured, provider succeeds but returns zero words | `400 {detail}` (no-speech detail); existing words preserved |
| configured, another generation run in flight | `409 {detail}`; no provider request issued |
| configured, request aborted before any provider call | `400 {detail}` — a distinct aborted detail, not `200`/`503`; no provider request issued |
| configured, upstream STT failure/timeout, or a group file over the provider size limit | `502 {detail}` |

Existing route semantics are otherwise unchanged: unknown session → the existing
`requireSession` behavior; the request body remains ignored/empty. No other transcription
surface changes — `GET/POST/PATCH/DELETE …/transcript-words`, `…/topics` CRUD,
`…/topics/generate` (`503`), and `transcribe.csv` (`503`) keep their current frozen
behavior.

#### Scenario: Unconfigured deployments are byte-for-byte unchanged
- **WHEN** a deployment without `DEEPGRAM_API_KEY` receives `POST
  /api/sessions/:id/transcript-words/generate`
- **THEN** the response status and body match the pre-change `503 {detail}` exactly

#### Scenario: Configured success returns the list shape
- **WHEN** a configured deployment successfully generates a transcript
- **THEN** the response is `200` with `{words}` whose entries match the shape of
  `GET /api/sessions/:id/transcript-words` entries

#### Scenario: Concurrent run maps to 409
- **WHEN** a generate request arrives while another run is already in flight
- **THEN** the response is `409 {detail}` and no provider spend occurs for it

#### Scenario: Pre-provider-call abort maps to 400, not a new status code
- **WHEN** the originating HTTP request is already aborted before any DeepGram request
  would be issued
- **THEN** the response is `400 {detail}` with a detail distinct from the no-audio and
  all-unreadable `400` details, and no provider spend occurs

#### Scenario: Sibling stubs stay frozen
- **WHEN** a configured deployment receives `POST /api/sessions/:id/topics/generate` or
  `GET /api/sessions/:id/transcribe.csv`
- **THEN** both still respond with the current `503 {detail}`

### Requirement: YouTube import endpoint behavior

`POST /api/sessions/:sessionId/youtube-import` SHALL move from unconditional `503` to
configuration-dependent behavior, which becomes frozen surface on shipping:

| Condition | Response |
|---|---|
| no `yt-dlp` available (no configured path and none on `PATH`) | `503 {detail}` — identical to the current unavailable response |
| open-network config (`REQUIRE_LOGIN` off + non-loopback + no `IP_ALLOWLIST`) | `503 {detail}`; no subprocess spawned — mirrors the AI chat / AI v2 refusal |
| configured, malformed body or non-allowlisted / unparseable `url` | `400 {detail}`; no subprocess spawned |
| configured, another import for the same session in flight, OR the global concurrency ceiling is reached | `409 {detail}`; no subprocess spawned |
| configured, success | `200 {ok: true}` — one downloaded audio segment attached to the session; if `use_publish_date` is true and the video reports an upload date, the session's `episode_date` is set from it |
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

- **WHEN** a deployment with `REQUIRE_LOGIN` disabled, a non-loopback bind, and no
  `IP_ALLOWLIST` receives `POST /api/sessions/:id/youtube-import` (even with `yt-dlp`
  configured)
- **THEN** the response is `503 {detail}` and no subprocess is spawned, mirroring the AI
  chat / AI v2 open-network refusal

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
- **THEN** the response is `502 {detail}` — distinct from the unconfigured/refused `503` —
  and no audio segment is attached (any inserted metadata row is rolled back)

#### Scenario: Sibling stubs stay frozen

- **WHEN** a configured deployment receives `POST /api/sessions/:id/topics/generate` or
  `GET /api/sessions/:id/transcribe.csv`
- **THEN** both still respond with the current `503 {detail}`

#### Scenario: Session JSON shape is unchanged

- **WHEN** a session that was populated by an opt-in import is listed or fetched
- **THEN** its JSON has the same fields as before, with `episode_date` now carrying the
  imported date rather than `null` — no field added, removed, or retyped

### Requirement: YouTube import success anchors a take; refuses while a recording is live

`POST /api/sessions/:sessionId/youtube-import`, on a **successful** import, SHALL — in
addition to attaching the segment — create two internal events (`Recording N Started`/
`Stopped`) and advance the transport by the imported video's duration. These emit the
**existing** `event.changed` and `transport.changed` WebSocket messages, in their existing
shapes (the same a recorded take emits) — no new message shape. The HTTP success body stays
`200 {ok:true}`. Additionally, the endpoint SHALL respond `409 {detail}` (a new precondition
on the existing `409` status — no new status code) when the session's transport is actively
rolling, so an import cannot clobber a live recording. Failed imports emit none of the take
messages.

#### Scenario: Successful import emits the standard take WS messages

- **WHEN** a client is subscribed to a session's WebSocket and an import succeeds
- **THEN** it receives `event.changed` (for the two `Recording N` events) and
  `transport.changed` (for the duration advance) in their existing shapes, plus the existing
  `audio.changed` — and the HTTP response is still `200 {ok:true}`

#### Scenario: Import while recording maps to 409

- **WHEN** a `youtube-import` request is made while the session transport `is_rolling`
- **THEN** the response is `409 {detail}` (the existing `409` status, new precondition), no
  take is synthesized, and the live recording is unaffected

#### Scenario: Response shape and status matrix are otherwise unchanged

- **WHEN** an import is requested under any other condition
- **THEN** the HTTP status/body match the existing frozen matrix exactly — this change adds
  only success-path event/transport emission and the rolling `409` precondition, no
  response-shape or new-status change

#### Scenario: Failed import emits no take messages

- **WHEN** an import fails after validation
- **THEN** no `event.changed` or `transport.changed` is emitted on its behalf and no
  `Recording` events or transport advance persist

### Requirement: Topic generation endpoint behavior

`POST /api/sessions/:sessionId/topics/generate` SHALL move from unconditional `503` to
configuration-dependent behavior, which becomes frozen surface on shipping:

| Condition | Response |
|---|---|
| `CLAUDE_CLI_PATH` unset/blank | `503 {detail}` — identical to the current unavailable response |
| open-network config (`REQUIRE_LOGIN` off + non-loopback + no `IP_ALLOWLIST`) | `503 {detail}`; no subprocess — mirrors the AI chat refusal |
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
  distinct from the unconfigured/open-network `503`

#### Scenario: transcribe.csv stays frozen

- **WHEN** a configured deployment receives `GET /api/sessions/:id/transcribe.csv`
- **THEN** it still responds with the current `503 {detail}`

### Requirement: Broadcast atomicity with the owning transaction

WS `*.changed` broadcasts SHALL be emitted only for mutations whose owning transaction
has committed. The server SHALL NOT emit a broadcast for a write that is subsequently
rolled back (e.g. a commit-time `SQLITE_FULL` failure). On the success path, the set of
broadcasts emitted for a given mutation, their payloads, and their relative order SHALL
be identical to the current published behavior — this requirement authorizes suppressing
emission on failure, not any change to emission on success.

This requirement pins observables only — it does not mandate an implementation
mechanism. Mutations performed inside a transaction SHALL have their broadcasts held
until that transaction commits; broadcasts legitimately issued outside any transaction
(e.g. a composite RPC's deliberate post-commit emission) remain immediate sends and are
unaffected. The composite RPC's published frame set (its suppressed intermediate
store-level frames and its exact post-commit frames) is part of the frozen success-path
behavior and SHALL NOT change.

#### Scenario: Failed commit emits no broadcast

- **WHEN** a mutating hub RPC's transaction fails at or before commit
- **THEN** no `*.changed` broadcast of any kind is emitted for that mutation, and
  connected clients observe no notification for the rolled-back write

#### Scenario: Successful mutation broadcasts exactly as today

- **WHEN** a mutating hub RPC's transaction commits successfully
- **THEN** the broadcasts emitted (types, payloads, and relative order) match the
  published pre-change behavior exactly

#### Scenario: Composite mutation emits once, after commit

- **WHEN** a composite RPC performs multiple store mutations in one transaction
- **THEN** clients observe broadcasts only after the whole transaction commits, and the
  previously flag-suppressed intermediate broadcasts remain unobserved, matching the
  published pre-change success-path behavior

### Requirement: Suffix range against a zero-byte audio blob

On the audio download endpoint (`GET /api/sessions/:sessionId/audio/segments/:segmentId`,
the repo's only Range-consuming route), a syntactically valid suffix `Range` request
(`bytes=-N`, `N > 0`) against a zero-byte audio blob SHALL yield the same
unsatisfiable-range response the endpoint already produces for other unsatisfiable
ranges (`416`), rather than an internal error. (Implementation note for the auditor:
`InvalidRangeError → 416` is mapped at two sites — the router's local catch and the app
error handler — which must stay consistent.) This
authorizes converting the current crash-driven `500` on this path to `416`; all other
range-request behavior (including `Content-Range` semantics on satisfiable ranges) is
unchanged.

#### Scenario: Suffix range on empty blob returns 416

- **WHEN** a client requests `Range: bytes=-N` for an audio object whose stored blob is
  zero bytes long
- **THEN** the response is the endpoint's existing unsatisfiable-range response (`416`),
  not a `500`

#### Scenario: Satisfiable ranges are unchanged

- **WHEN** a client requests any range against a non-empty blob that the published
  contract satisfies today
- **THEN** the status, headers (`Content-Range`), and body bytes are unchanged

### Requirement: Event update strips UI snapshots for profile-defined internal category

`PUT /api/sessions/:sessionId/events/:eventId` SHALL reject (`400`) any category that
is not defined in the studio profile, and — when the studio profile defines a category
whose id case-insensitively equals `internal` — SHALL strip category UI snapshots from
the event metadata before persisting, exactly as it does today. This asymmetry with
event creation (POST admits the built-in `internal` category even when the profile does
not define it; PUT requires profile membership first) is deliberate, frozen behavior.
The snapshot-stripping branch is reachable (a studio profile MAY define a category with
id `internal` — category-id validation reserves no ids) and MUST NOT be removed as dead
code.

#### Scenario: Profile-defined internal category strips snapshots on update

- **WHEN** a studio profile defines a category with id `internal` (any letter case) and
  a client PUTs an event update carrying that category
- **THEN** the update is accepted and category UI snapshots are stripped from the
  event's metadata, matching current published behavior

#### Scenario: Non-profile category still rejected on update

- **WHEN** a client PUTs an event update whose category is not defined in the studio
  profile (including `internal` when the profile does not define it)
- **THEN** the response is the existing `400`, unchanged

### Requirement: Local audio import endpoint

The published inventory SHALL include
`POST /api/sessions/:sessionId/local-audio-import`. The request SHALL carry one
audio body (raw bytes) with a non-empty Content-Type, and a positive finite
`duration_s` query parameter not exceeding 86_400 seconds (24 hours). The
request MAY carry an `X-Audio-Seam-Parts` header: a JSON array of
`{ duration_s }` objects, each `duration_s` positive finite, whose sum is
within 0.5 s of the query `duration_s`; a malformed header (non-JSON, not a
non-empty array, non-object entries, non-positive/non-finite durations) or a
sum mismatch SHALL be `400 { detail }`; an absent/blank header defaults to one
part equal to `duration_s`. Accepted parts are persisted by APPENDING to any
seam parts stored by earlier imports on the session (the persisted list
describes the session's full audio timeline across takes, in take order).
Success SHALL be `200 { ok: true }`. An import arriving while the session is
actively recording SHALL be `409 { detail }`; the rolling state is checked
before attach and re-checked after the blob put, and the post-put re-check
rolls the attempt back. Put failures SHALL roll back the segment metadata row;
failures after a successful put (late rolling re-check, anchor failure) SHALL
roll back BOTH the metadata row and the stored blob (row first, blob delete
best-effort), and SHALL NOT leave an anchored take for the failed attempt. Missing/invalid `duration_s`,
missing/blank Content-Type, or `duration_s` above the supported maximum SHALL
be `400 { detail }`. Bodies over `MAX_LOCAL_AUDIO_IMPORT_BYTES` (1500 MiB —
the endpoint's own cap, deliberately higher than the 50 MB live segment
upload cap) SHALL be `413 { detail }`, enforced identically (same `{ detail }`
string) whether tripped by the declared Content-Length, mid-stream during the
counted body read (chunked bodies / lying Content-Lengths never buffer past
the cap), or the post-read backstop.

#### Scenario: Inventory lists local-audio-import

- **WHEN** a client calls `POST /api/sessions/:sessionId/local-audio-import` with a
  valid audio body and `duration_s` on an existing session
- **THEN** the call is in-contract and succeeds with `200 { ok: true }` when
  attach+anchor succeeds

#### Scenario: Missing duration is rejected

- **WHEN** the request omits `duration_s` or supplies a non-positive value
- **THEN** the response is `400 { detail }` and no audio segment is attached

#### Scenario: Missing Content-Type is rejected

- **WHEN** the request omits `Content-Type` or supplies a blank value
- **THEN** the response is `400 { detail }` and no audio segment is attached

#### Scenario: Oversized body is rejected

- **WHEN** the declared or read body size exceeds the 1500 MiB
  local-audio-import cap — including a chunked body with no Content-Length
  whose stream crosses the cap mid-read
- **THEN** the response is `413 { detail }` and no audio segment is attached

#### Scenario: Malformed seam-parts header is rejected

- **WHEN** the request carries an `X-Audio-Seam-Parts` header that is not a
  non-empty JSON array of positive-finite `{ duration_s }` objects, or whose
  durations do not sum to within 0.5 s of `duration_s`
- **THEN** the response is `400 { detail }` and no audio segment is attached

#### Scenario: Rolling session is rejected

- **WHEN** the session is actively recording when the import arrives, or starts
  recording between the blob put and the anchor
- **THEN** the response is `409 { detail }` and the attempt leaves no segment
  row or anchored take; the stored blob is deleted best-effort (rollback never
  masks the original failure, and never leaves a row pointing at a missing blob)

