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
`200` with the index shell HTML — the same page identity served at `/` (same route
group, layout, and page component; responses across router-known paths differ only in
the framework's serialized URL data) — unconditionally on whether a session with that
id exists and on whether the requester is authorized to see it. The HTML layer SHALL
NOT leak session existence: for a fixed deployment and fixed request headers, the
response SHALL NOT vary with session existence, deletion state, or the requester's
authorization — for a real session, a deleted session, and a foreign team's session at
the same id, the response bodies are identical. (The document MAY embed the requested
route itself — the serving framework serializes the matched URL — but SHALL embed no
session-derived or catalog-derived data. The response MAY vary with content-negotiation
headers the serving framework defines — e.g. an RSC flight request returns a payload,
not HTML — and MAY vary across deployments via build identifiers; neither variance may
correlate with session state.) Authentication happens client-side through the existing
`GET /api/profile` surface, and session resolution through the `GET /api/sessions/:id`
detail endpoint; the HTML route itself adds no JSON surface, sets no cookies, and takes
no query-parameter semantics.

Paths outside the frozen inventory — including `/sessions` (no id),
`/sessions/<id>/<more>` (nested segments), and trailing-slash variants of inventory
paths (`/teams/`, `/sessions/<id>/`) — SHALL keep responding `404` when no static
asset matches, with no canonicalizing redirect. Non-GET requests to paths outside the
inventory SHALL keep responding with the server's own `404`, exactly as before this
change. (Non-normative: a percent-encoded slash, e.g. `/sessions/a%2Fb`, is a
single raw path segment and therefore serves the shell — integration tests must not
assert `404` for the encoded form.)

#### Scenario: Deep link serves the shell
- **WHEN** `GET /sessions/abc-123` is requested (any single non-empty id segment,
  existing session or not, authenticated or not)
- **THEN** the server responds `200` with the index shell HTML, with no `Set-Cookie`

#### Scenario: No existence oracle
- **WHEN** `GET /sessions/<id>` is requested with identical request headers for an
  existing session, a deleted session, a foreign team's session, and a random
  nonexistent id
- **THEN** the response bodies are identical across all four cases for the same id
  value, and no part of any response derives from session or catalog data

#### Scenario: Non-matching paths stay 404
- **WHEN** `GET /sessions`, `GET /sessions/a/b`, or `GET /teams/` (or any other path
  outside the endpoint inventory, including trailing-slash variants) is requested and
  no static asset matches
- **THEN** the response status remains `404` with no redirect (the 404 body is
  unpinned — the frontend framework's not-found document or the server's own 404,
  depending on which layer answers; only the status is pinned)

#### Scenario: Stray-path upgrade disposition
- **WHEN** a WebSocket upgrade is attempted in production on a path outside `/api/`
- **THEN** the socket is destroyed (previously it received an HTTP-status close via the
  upgrade replay; this change authorizes the destroy disposition — the `/api` WS
  surface is unchanged)

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
`GET /teams` SHALL respond `200` with the index shell HTML — the same page identity
served at `/` and `/sessions/:id` — unconditionally on authentication (the login
gate renders client-side), setting no cookies. Paths below it (`/teams/<more>`)
remain outside the inventory and keep responding `404` when no static asset matches.

#### Scenario: Teams deep link serves the shell
- **WHEN** `GET /teams` is requested by an anonymous client
- **THEN** the server responds `200` with the index shell HTML and no `Set-Cookie`

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

### Requirement: Transcript generation lock status endpoint
`GET /api/transcript-generation/status` SHALL be frozen surface with:

| Condition | Response |
|---|---|
| No generation run in flight | `200 { "in_flight": false }` |
| Generation run in flight | `200 { "in_flight": true, "session_id": string\|null, "session_title": string\|null, "started_at": string }` |

`started_at` SHALL be ISO-8601 UTC. For a requester permitted to view the holding
session (anonymous `user === null`, or a member of its studio — the same membership
scope sibling routes enforce by 404), `session_id` SHALL be the holder's id and
`session_title` SHALL be the catalog title at read time or `null` if the session row
is absent. For a logged-in requester lacking that membership, `session_id` and
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
  (same key set) for logged-in requesters without membership of the holding session

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
| configured, another generation run in flight | `409 {detail}`; the detail names the busy session (title preferred, else id) when the requester may view it (anonymous, or a member of the holder's studio), and falls back to the identifier-free generic in-flight detail for logged-in non-members or when the holder released in the race; no provider request issued |
| configured, request aborted before any provider call | `400 {detail}` — a distinct aborted detail, not `200`/`503`; no provider request issued |
| configured, upstream STT failure/timeout, or a group file over the provider size limit | `502 {detail}` |

Existing route semantics are otherwise unchanged: unknown session → the existing
`requireSession` behavior; the request body remains ignored/empty. No other transcription
surface changes — `GET/POST/PATCH/DELETE …/transcript-words`, `…/topics` CRUD, and
`transcribe.csv` (`503`) keep their current frozen behavior, except that
`GET /api/transcript-generation/status` is an additional authorized surface (see above).

#### Scenario: Unconfigured deployments are byte-for-byte unchanged
- **WHEN** a deployment without `DEEPGRAM_API_KEY` receives `POST
  /api/sessions/:id/transcript-words/generate`
- **THEN** the response status and body match the pre-change `503 {detail}` exactly

#### Scenario: Configured success returns the list shape
- **WHEN** a configured deployment successfully generates a transcript
- **THEN** the response is `200` with `{words}` whose entries match the shape of
  `GET /api/sessions/:id/transcript-words` entries

#### Scenario: Concurrent run maps to 409 naming the holder
- **WHEN** a generate request arrives while another run is already in flight and the
  requester is anonymous or a member of the holder's studio
- **THEN** the response is `409 {detail}` that identifies the busy session, and no
  provider spend occurs for it

#### Scenario: Concurrent run 409 is identifier-free for non-members
- **WHEN** a generate request from a logged-in requester without membership of the
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
  SHEETS_LOG_IMPORT_ENABLED=1 to enable it."; when configured, the shared
  open-network refusal predicate applies next (`503 { detail }`), in the
  youtube-import ordering (membership 404 → config gate → open-network
  refusal → body validation).
- `GET /api/log-import/:jobId` — success `200` with a JSON job status object
  including at least `status` (`queued`|`running`|`completed`|`failed`),
  `lines` (string array progress), and `error` (string or null). The route is
  creator-scoped: unknown job ids and jobs created by a different
  authenticated user both get the uniform
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
  existing show on a configured, non-open deployment
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

### Requirement: events/generate optional body and deleted count

`POST /api/sessions/:sessionId/events/generate` SHALL accept an optional JSON
object body with:

- `regenerate` — optional boolean (default false)
- `selection` — optional array of objects `{ category_id: string,
  option_label?: string | null }`, bounded: at most 500 entries,
  `category_id` ≤ 200 characters, `option_label` ≤ 200 characters

Malformed bodies SHALL yield `400`, including bound violations. Combining
`regenerate: true` with a non-empty `selection` SHALL yield `400`. Success
response SHALL remain JSON `{ created: number, cap_hit: boolean }` and SHALL
include `deleted: number` when the request regenerated. When `regenerate` is
false/absent, `deleted` MAY be omitted. The regenerate delete
is **after-success**: prior auto rows are snapshotted by id pre-spawn, stay
readable (and keep appearing in `GET …/events`) for the whole run, and are
deleted in one transaction — emitting one existing `event.changed` broadcast
when at least one row was removed, and none otherwise — only after the CLI
turn succeeds **with at least one created event**, and before the
`200` is built; a `502` run deletes nothing, and a successful zero-created
regenerate deletes nothing and responds
`200 { created: 0, cap_hit: false, deleted: 0 }`. Existing status codes and
guard-ladder details for unconfigured / busy / no-transcript / etc. remain as
previously frozen unless superseded by the `auto-event-generation` delta.

#### Scenario: Absent body preserves Generate All

- **WHEN** a client POSTs generate with an empty body
- **THEN** behavior matches prior Generate All (no delete; full instruction set)
  and a `200` success body includes `created` and `cap_hit`

#### Scenario: Regenerate success includes deleted

- **WHEN** a client POSTs `{ "regenerate": true }` and the run succeeds
- **THEN** the `200` body includes `deleted` as a non-negative integer plus
  `created` and `cap_hit`

#### Scenario: Zero-created regenerate success deletes nothing

- **WHEN** a client POSTs `{ "regenerate": true }` and the CLI turn succeeds
  without creating any event
- **THEN** the response is `200 { created: 0, cap_hit: false, deleted: 0 }`
  and a subsequent `GET …/events` still returns the prior auto rows

#### Scenario: Regenerate failure leaves the contract surface truthful

- **WHEN** a client POSTs `{ "regenerate": true }` and the CLI turn fails
- **THEN** the response is the fixed opaque `502 {detail}`, no `event.changed`
  broadcasts were emitted beyond those of the run's own inserts, and a
  subsequent `GET …/events` still returns the prior auto rows

### Requirement: Events list has_auto_generated field

`GET /api/sessions/:sessionId/events` SHALL include `has_auto_generated`
(boolean) in its response envelope alongside the existing fields
(`events`, `total`, `logged_event_count`, `offset`, `limit`). The value SHALL
be computed over the **whole session's** events — not the returned page — and
SHALL be true exactly when at least one event's metadata carries
`auto_generated === true` (the same predicate the regenerate pre-spawn
snapshot uses).
The field is additive: no existing field's shape, order dependence, or
semantics changes.

#### Scenario: Auto rows beyond the returned page are reported

- **WHEN** a session's only auto-generated events lie outside the requested
  `limit`/`offset` window
- **THEN** the events list response carries `has_auto_generated: true`

#### Scenario: No auto rows

- **WHEN** a session has no event whose metadata carries
  `auto_generated === true`
- **THEN** the events list response carries `has_auto_generated: false`

### Requirement: Show title_suffix on show wire; next_episode omitted

Every show object emitted via the shared show serializer (profile `shows[]`,
`GET /api/shows`, and `POST /api/shows` create responses) SHALL include
`title_suffix` as either `"date"` or `"episode"` and SHALL NOT include
`next_episode`. Profile `show_updates[]` entries SHALL accept `title_suffix`
with the same two values. Legacy `next_episode` keys on profile/show update
bodies SHALL be ignored (not persisted) and SHALL NOT cause `400` solely due
to that key. Catalog persistence SHALL store `title_suffix` on `shows`. The
SQLite column `shows.next_episode` MAY remain for rollback safety but SHALL
NOT be bumped on session create and SHALL NOT appear on the show wire.

#### Scenario: Profile show carries title_suffix

- **WHEN** a client reads profile after migration
- **THEN** each `shows[]` entry includes `title_suffix` of `"date"` or
  `"episode"` and omits `next_episode`

#### Scenario: Shows list matches profile show shape

- **WHEN** a client reads `GET /api/shows` after migration
- **THEN** each show object includes `title_suffix` and omits `next_episode`

#### Scenario: Profile update persists title_suffix

- **WHEN** a client PUTs profile with `show_updates[].title_suffix` set to
  `"episode"`
- **THEN** a subsequent profile read returns that show with
  `title_suffix: "episode"`

#### Scenario: Legacy next_episode on update is ignored

- **WHEN** a client PUTs profile with `show_updates[].next_episode` set
- **THEN** the update succeeds without failing solely due to that key and no
  next-episode counter is written as a live product field

### Requirement: Wire deck_title equals stored session title

Wherever the frozen HTTP surface emits `deck_title` for a session (including
`GET /api/companion/state` when `session` is non-null, session list/detail
serializers, and session status payloads that already include `deck_title`),
`deck_title` SHALL equal the trimmed stored session `title`, or `"—"` if that
title is blank. Field names and surrounding object shapes remain unchanged;
only the value derivation is authorized to change from
`{show_code} - {episode}` (when a show code is present) to the stored title.

#### Scenario: Companion deck_title tracks title

- **WHEN** Companion state is fetched for an active session titled `HD_260802`
- **THEN** `session.deck_title` is `HD_260802`

#### Scenario: Session list deck_title tracks title

- **WHEN** a session list entry is serialized for a session titled `HD_260802`
  with a non-blank show code
- **THEN** that entry's `deck_title` is `HD_260802`

### Requirement: Create-session optional episode under date suffix

`POST /api/sessions` SHALL continue to accept an optional `title`. When `title`
is omitted/blank and the linked show's `title_suffix` is `"date"`, `episode`
MAY be omitted or blank and the server SHALL still create the session with a
derived title per the `session-title-suffix` capability. When the linked show's
`title_suffix` is `"episode"`, a blank `episode` SHALL be rejected with `400`
unless an explicit non-blank `title` bypasses derivation. An explicit non-blank
`title` SHALL win over derivation and SHALL be stored after the existing
create-path trim (leading/trailing whitespace removed).

#### Scenario: Date-suffix create without episode succeeds

- **WHEN** a client creates a session for a date-suffix show without `title` and
  without `episode`
- **THEN** the response is `200` with a derived `title` and the session exists

#### Scenario: Episode-suffix create without episode fails

- **WHEN** a client creates a session for an episode-suffix show without a
  non-blank `episode` and without an explicit title that bypasses derivation
- **THEN** the response is `400 { detail }`

### Requirement: Events POST strips reserved auto-generation metadata keys

`POST /api/sessions/:sessionId/events` SHALL remove the keys `auto_generated`
and `auto_generate_run_id` from client-supplied `metadata` before the event is
stored — silently, regardless of the values sent (no error, no status-code
change; the ignore/strip precedent), and unconditionally (the internal-category
path included). All other metadata keys SHALL pass through unchanged — except
the existing category-UI-snapshot keys, which the snapshot merge continues to
overwrite exactly as today. The existing serialized-size cap applies to the
`metadata` field as sent (pre-strip). The stripping is
observable: subsequent reads of the created event carry metadata without the
reserved keys. Server-side writers (the generation run's `create_event` tool,
the sheets importer's hub write) are NOT this route and SHALL be unaffected.

#### Scenario: Stamping client is stripped

- **WHEN** a client POSTs an event with
  `metadata: { auto_generated: true, auto_generate_run_id: "x", note: "keep" }`
- **THEN** the response is the normal `200` created event whose metadata
  contains `note` but neither reserved key, and subsequent event reads agree

#### Scenario: Stripping is value-independent

- **WHEN** a client POSTs an event with
  `metadata: { auto_generated: "yes", auto_generate_run_id: 7, note: "keep" }`
- **THEN** the stored/echoed metadata carries `note` and neither reserved key,
  regardless of the values sent

#### Scenario: Ordinary metadata unaffected

- **WHEN** a client POSTs an event with metadata carrying no reserved keys
- **THEN** the stored metadata is byte-equivalent to today's behavior

