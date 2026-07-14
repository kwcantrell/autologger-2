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
