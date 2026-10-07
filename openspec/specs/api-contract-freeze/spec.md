# api-contract-freeze

## Purpose

The server's externally observable HTTP/WS contract is frozen. This capability replaces
the retired "Python parity" anchor. The freeze exists because real consumers depend on the
surface — the in-repo `web/` frontend, the separately-deployed Bitfocus Companion module,
and external API clients (bearer-token scripts, stale
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
| The verified id_token's `email_verified` claim is not `true`, or its email is empty | `email_unverified` |
| Supabase Auth unreachable, timed out, or refused the verified Google ID token; its user does not hold exactly one Google identity with the verified `sub`; or its user id differs from the account's id for this `sub`, or belongs to an account with another `sub` | `identity_unavailable` |

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
caught-and-classified exceptions are the token exchange (→ `exchange_failed`),
id_token verification including its JWKS fetch (→ `token_invalid`), and the Supabase Auth
exchange (→ `identity_unavailable`). The handler MUST NOT
blanket-convert all errors to redirects.

Diagnostic detail (the former JSON `detail` strings, including operator guidance such as
`PUBLIC_BASE_URL` mismatch hints) SHALL NOT appear in any response; it is logged
server-side instead. Log content and format are operational behavior, not
client-observable frozen surface — the sanitization requirements for logged
request/provider-derived values are normative in the change's design and tests, not in
this contract.

The success path SHALL remain byte-identical in behavior: set the session cookie and
`302` to `/` with no query parameters. Before any account is read or created, the verified
Google ID token SHALL be exchanged with Supabase Auth, and the account's id SHALL be the
Supabase Auth user id.

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
- **WHEN** the callback completes successfully (valid state, exchange, id_token, and Supabase
  Auth exchange)
- **THEN** the server sets the session cookie and responds `302` with `Location: /`,
  exactly as before this change

#### Scenario: Unexpected internal error stays 500
- **WHEN** the callback fails outside the enumerated classes (e.g. a catalog or KV
  write throws after successful verification, or the CSRF-state read itself throws)
- **THEN** the response is the app's ordinary `500` error — no `login_error` redirect,
  no cookie

#### Scenario: Supabase Auth unavailable
- **WHEN** the Google ID token verifies, but Supabase Auth is unreachable, times out, or refuses
  the token
- **THEN** the server responds `302` with `Location: /?login_error=identity_unavailable`, sets no
  cookie, and creates or changes no account

#### Scenario: A new account takes the Supabase Auth id
- **WHEN** a Google account signs in for the first time and Supabase Auth returns user id `U`
- **THEN** the created account's id is `U`

#### Scenario: An account whose id differs from Supabase Auth's is refused
- **WHEN** an account exists for the Google subject with id `A`, and Supabase Auth returns a
  different user id `B`, or Supabase Auth returns id `A` for a Google subject whose account does
  not exist while account `A` belongs to another subject
- **THEN** the server responds `302` with `Location: /?login_error=identity_unavailable`, sets no
  cookie, and leaves every account unchanged

#### Scenario: An unverified Google email is refused
- **WHEN** the id_token verifies but its `email_verified` claim is absent or not `true`
- **THEN** the server responds `302` with `Location: /?login_error=email_unverified`, sets no
  cookie, does not call Supabase Auth, and creates or changes no account

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
authorization rule the existing per-session routes use (show access: the requester is the
owner or an admin of the session's team, or a member holding a grant for the session's show;
team-management "Member content access"), regardless of the requester's active-show or active-studio
preferences and regardless of the session's archived state. It SHALL respond `404` —
indistinguishable across the cases — for a nonexistent id, a deleted (`ui_hidden`)
session, and a session the requester is not authorized to access (a non-member of the team, or
a member without a grant for the session's show), preserving the existing 404-masking posture. Authentication requirements match the other
`/api/sessions/*` routes. This endpoint is additive: the `GET /api/sessions` list
response keeps its scope and shape; for a caller without access to the listed show its values
follow "Session list entries for a show without access".

#### Scenario: Authorized fetch regardless of active scope
- **WHEN** an authenticated requester who can access the session's show (owner, admin, or a
  member with a grant for it) requests `GET /api/sessions/<id>` while their active show or active studio preference points
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
  deleted (`ui_hidden`) session, for a session in a studio the requester is not a
  member of, or for a session of a show the requester, a member of its team, holds no grant for
- **THEN** every case responds with the same `404` (same shape), with no signal
  distinguishing them

#### Scenario: A member without a grant gets the masked 404
- **WHEN** a member of the session's team who holds no grant for the session's show requests
  `GET /api/sessions/<id>`, and an admin of the same team requests it with no grant
- **THEN** the member gets the same `404` as for a nonexistent id, and the admin gets `200`

### Requirement: Team management endpoint family
The server SHALL expose the following authenticated team-management routes, which
become frozen surface on shipping. All are JSON; all require a logged-in user
(`401` otherwise); team-scoped routes respond with a masked `404` for teams the
caller is not a member of (nonexistent and foreign teams indistinguishable) and
`403` for a member without the required role where noted. Response objects are
additive-open (clients tolerate unknown fields). Every `role` value in a response is `"owner"`,
`"admin"` or `"member"`.

| Route | Auth | Behavior |
|---|---|---|
| `POST /api/teams` `{id, display_name}` | any user | create team, caller becomes `owner`: `200 {id, name, role: "owner"}`; validation errors `400` |
| `GET /api/teams/:id` | member | team detail: `{id, name, role, enabled_admin_count, members: [{id, email, given_name, family_name, role}]}`; for an `admin` or `owner` caller each `members[]` entry also carries `show_ids` (string array: the shows of this team the member holds a grant for, sorted; `[]` for owner and admin entries, whose role gives access to every show) (`enabled_admin_count` = members whose role is `admin` and whose accounts are not disabled — the owner is not counted, so a new team reports `0`; per-member disabled status is deliberately not exposed; `members` lists the owner first, then admins, then members); `invites: [{email, invited_at_utc}]` present only when the caller is `admin` or `owner` |
| `PATCH /api/teams/:id` `{display_name}` | admin or owner | rename (display name only) |
| `DELETE /api/teams/:id` | owner | delete; `400` while shows exist |
| `POST /api/teams/:id/invites` `{email}` | admin or owner | immediate membership for existing users, else pending invite; idempotent per team+email |
| `DELETE /api/teams/:id/invites/:email` | admin or owner | revoke pending invite |
| `POST /api/teams/:id/members/:userId/role` `{role}` | owner | promote/demote between `admin` and `member`; `409` when the target is the owner |
| `DELETE /api/teams/:id/members/:userId` | admin or owner | remove member; removing an `admin` needs the owner (`403` for an admin caller); `409` when the target is the owner |
| `POST /api/teams/:id/leave` | member | caller leaves; `409` for the owner |
| `PUT /api/teams/:id/shows/:showId/grants/:userId` | admin or owner | grant the show to a member: `200 {ok: true}`; no body (any body is ignored); a `:userId` that is not a member of the team → `404` (`Member not found`); the owner or an admin as target → `200`, nothing stored; an existing grant → `200`, unchanged; a `:showId` that is not a show of this team → `404` (`Show not found.`) |
| `DELETE /api/teams/:id/shows/:showId/grants/:userId` | admin or owner | revoke: `200 {ok: true}` whether or not the grant existed (including a `:userId` that is not a member); a `:showId` that is not a show of this team → `404` (`Show not found.`) |
| `POST /api/teams/:id/owner` `{user_id}` | owner | transfer: `user_id` becomes `owner` and the caller becomes `admin`, in one transaction: `200 {ok: true}`; a `user_id` that is not a member of the team → `404` (`Member not found`); a member whose account is disabled → `400`; the caller's own id → `200`, no change |

**Default behaviors (frozen with the family):** every team id, including `test-studios` and
`test-studio-2`, is handled by the rules above (no id is rejected as built-in); a `:userId` that
is not a member of the team →
`404` (`Member not found` — the caller is a team admin or owner, membership of their own team
is not masked from them); role change to the already-held role → `200` idempotent;
invite revocation → `200` idempotent whether or not the invite existed; the
`:email` path segment is percent-decoded, then normalized identically to invite-time
(JS lowercase/trim) before matching; rename shares create's display-name validation
(non-empty, ≤200); invite emails are validated (plausible shape, ≤254 chars);
creation and pending-invite caps reject with `400` and an actionable message. Role-change body
values outside `admin`|`member` (`owner` included: ownership moves only by transfer) are
schema-rejected `400`; a transfer body without a non-empty string `user_id` is rejected `400`.
The owner `409` has the detail `Transfer ownership first.`. Statuses are decided in this order:
`401`, the masked `404`, the caller's role `403`, body validation `400`, the grant routes' show
`404`, then the target's `404`, `409` or owner-only `403`. Leaving the team or being removed from it
(team plane or support plane) deletes the member's grants for the team's shows in the same
transaction.

#### Scenario: Family is authenticated and masked
- **WHEN** an anonymous client calls any `/api/teams/*` route, and an authenticated
  non-member calls a team-scoped route for a real team and for a nonexistent id
- **THEN** the anonymous call gets `401`, and the two non-member calls get the same
  masked `404`

#### Scenario: Role gate distinguishes 403 from 404
- **WHEN** a plain `member` of a team calls an admin-only route on that team, and an `admin`
  calls an owner-only route on it
- **THEN** both responses are `403` (they may know the team exists; they may not manage
  it)

#### Scenario: Creation returns the owner role
- **WHEN** a signed-in user creates a team
- **THEN** the response is `200 {id, name, role: "owner"}`

#### Scenario: Transfer route
- **WHEN** the owner posts `{user_id}` naming a current enabled member to
  `POST /api/teams/:id/owner`
- **THEN** the response is `200 {ok: true}`, and the team detail then lists that member with
  `role: "owner"` and the caller with `role: "admin"`

#### Scenario: The owner is never a target
- **WHEN** any caller removes the owner, changes the owner's role, or the owner leaves
- **THEN** the response is `409` with the detail `Transfer ownership first.`

#### Scenario: Former built-in ids are not rejected
- **WHEN** a member of `test-studios` calls `GET /api/teams/test-studios`
- **THEN** the response is `200` with the team detail, not the former built-in `400`

#### Scenario: Grant routes
- **WHEN** an admin `PUT`s a grant of show S to member M, reads the team detail, and `DELETE`s the
  grant twice
- **THEN** the `PUT` is `200 {ok: true}`, the team detail lists M with `show_ids` containing S,
  both `DELETE`s are `200 {ok: true}`, and the team detail then lists M with `show_ids: []`

#### Scenario: Grant routes keep the family's statuses
- **WHEN** a plain member calls a grant route on their team, a non-member calls it, and an admin
  calls it with a show of another team
- **THEN** the member gets `403`, the non-member gets the masked `404`, and the admin gets `404`
  with `Show not found.`

#### Scenario: show_ids is for managers only
- **WHEN** an admin and a plain member of the same team fetch `GET /api/teams/:id`
- **THEN** every `members[]` entry in the admin's response carries `show_ids`, and no entry in the
  member's response does

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
field (`"owner"` | `"admin"` | `"member"`) reflecting the caller's membership role. The field is
additive; all existing profile fields and semantics are unchanged, and clients MUST
tolerate its presence.

#### Scenario: Role visible in profile
- **WHEN** a logged-in user who admins team A and is a member of team B fetches
  `GET /api/profile`
- **THEN** `auth.user.teams` contains A with `role: "admin"` and B with
  `role: "member"`

#### Scenario: Owner role visible in profile
- **WHEN** a logged-in user who owns team C fetches `GET /api/profile`
- **THEN** `auth.user.teams` contains C with `role: "owner"`

### Requirement: Admin add-membership role field
The support-plane `POST /api/admin/users/:userId/memberships` body SHALL accept an
optional `role` field (`"owner"` | `"admin"` | `"member"`); when absent, behavior is the
existing one with `role` defaulting to `member`. With the role column present the
operation becomes an **upsert**: if the membership already exists, its role is
updated to the requested (or defaulted) value — the pre-change `INSERT OR IGNORE`
no-op would silently fail the rescue path. This is the orphaned-team rescue: support
can mint or promote an `admin` or `owner` membership for a team whose owner or admins are gone or
disabled. **`role: "owner"`** SHALL, in one transaction, demote the team's current owner (if it
is another user) to `admin` and make the target the owner, so the team never has two owners; an
upsert of `owner` for the current owner is a no-op. A POST **without** a `role` field that would
change the current owner's role SHALL be rejected with `409` (`Explicit role required to change
the team owner.`) and change nothing, so the legacy default never demotes an owner by accident.
Otherwise the support plane is deliberately not subject to the team plane's owner rules: an
explicit `admin` or `member` upsert, or a membership delete, on the current owner is applied and
leaves the team ownerless (until the bootstrap claim or an owner upsert). All other
`/api/admin/*` surface is unchanged.

#### Scenario: Support rescues an orphaned team by promotion
- **WHEN** the admin-token client POSTs a membership with `role: "admin"` for a
  user who is already a plain `member` of a team that currently has no admins
- **THEN** the existing membership's role is updated to `admin` (not silently
  ignored) and the user can manage the team

#### Scenario: Support hands ownership to another user
- **WHEN** the admin-token client POSTs a membership with `role: "owner"` for user U in a team
  whose owner O is disabled
- **THEN** U is the owner, O is an `admin`, and the team has exactly one owner

#### Scenario: A role-less POST never demotes the owner
- **WHEN** the admin-token client POSTs a membership body without a `role` field for the team's
  current owner, and then the same body with `role: "admin"`
- **THEN** the first gets `409` with `Explicit role required to change the team owner.` and the
  owner is unchanged; the second succeeds and the team has no owner

#### Scenario: Legacy admin body still works
- **WHEN** the admin-token client POSTs a membership body without a `role` field
- **THEN** the request succeeds exactly as before this change, creating a `member`
  membership

### Requirement: New-user membership grant behavior
On first Google sign-in, a new user SHALL receive exactly the memberships
materialized from pending invites matching their normalized email, and only when
the presented id_token carries `email_verified: true` — the former
`NEW_USER_ALL_TEAMS` blanket grant SHALL NOT occur regardless of the environment
variable's value. The one addition is the bootstrap owner: a sign-in, first or later, whose
verified email normalizes to `BOOTSTRAP_OWNER_EMAIL` also becomes `owner` of every team that has
no owner (team-management, "Bootstrap owner"). These are authorized behavior changes to
`GET /auth/google/callback`; the callback's redirect contract (success `302 /`,
failure `302 /?login_error=<code>`) is untouched, and a failed bootstrap claim still redirects to
`302 /` with a login session.

#### Scenario: New user without invites starts empty
- **WHEN** a Google account with no pending invites, whose email is not the bootstrap owner's,
  completes first sign-in on a server with `NEW_USER_ALL_TEAMS=1`
- **THEN** the created user has zero memberships (and the deprecated variable only
  produced a startup warning)

#### Scenario: The bootstrap owner's first sign-in owns the ownerless teams
- **WHEN** the bootstrap owner's Google account completes first sign-in while teams without an
  owner exist
- **THEN** the callback responds `302 /`, and the created user is `owner` of each of those teams,
  whoever created them

### Requirement: Disabled-account sign-in redirect
When the OAuth callback completes token verification for a Google `sub` whose user
row exists but is disabled, the server SHALL respond `302` with
`Location: /?login_error=account_disabled`, set no cookie, and change no catalog account
(Supabase Auth may record the sign-in attempt in its own user record) —
replacing the current latent `500` (the new-user branch violating the unique
`google_sub` constraint). `account_disabled` joins the login-error code set under
its existing additive-open rule (clients treat unrecognized codes as a generic
sign-in failure); the enumerated failure-class table and the success path are
otherwise untouched.

#### Scenario: Disabled user signs in
- **WHEN** a user whose account is disabled completes the Google OAuth flow
- **THEN** the callback responds `302` to `/?login_error=account_disabled` with no
  cookie, and no catalog account is created or modified

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

#### Scenario: Idle response shape
- **WHEN** the slot is free
- **THEN** the response is `200` with `in_flight` false

#### Scenario: Busy response shape
- **WHEN** the slot is held
- **THEN** the response is `200` with `in_flight` true and the busy fields populated as
  specified — identifiers for permitted requesters, `session_id`/`session_title` nulled
  (same key set) for requesters without access to the holding session (non-members, and
  members without a grant for its show)

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
| configured, another generation run in flight | `409 {detail}`; the detail names the busy session (title preferred, else id) when the requester may view it (can access the holder's show), and falls back to the identifier-free generic in-flight detail for requesters without that access or when the holder released in the race; no provider request issued |
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
- **WHEN** a generate request arrives while another run is already in flight and the
  requester can access the holder's show
- **THEN** the response is `409 {detail}` that identifies the busy session, and no
  provider spend occurs for it

#### Scenario: Concurrent run 409 is identifier-free for non-members
- **WHEN** a generate request from a requester without access to the holder's show (not a
  member of its studio, or a member without a grant for it) arrives while another run is in flight
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

#### Scenario: A failed anchor leaves no segment
- **WHEN** a configured import's audio is fetched and stored, and the transaction that anchors the
  take (its `Recording N` events, the transport advance and the live projection) then fails
- **THEN** the response is `502 {detail}`, the session has no new audio segment, and its events,
  transport and listed `event_count` are unchanged

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

### Requirement: Broadcast atomicity with the owning transaction

WS `*.changed` broadcasts SHALL be emitted only for mutations whose owning transaction
has committed. The server SHALL NOT emit a broadcast for a write that is subsequently
rolled back (e.g. a failed commit). On the success path, the set of
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
unchanged, except that the served `Content-Type` is the normalized value defined by
"Audio content types are clamped to non-compressible".

#### Scenario: Suffix range on empty blob returns 416

- **WHEN** a client requests `Range: bytes=-N` for an audio object whose stored blob is
  zero bytes long
- **THEN** the response is the endpoint's existing unsatisfiable-range response (`416`),
  not a `500`

#### Scenario: Satisfiable ranges are unchanged

- **WHEN** a client requests any range against a non-empty blob that the published
  contract satisfies today
- **THEN** the status, `Content-Range`, `Content-Length`, and body bytes are unchanged, and
  the `Content-Type` is the segment's stored type as normalized by the audio content-type
  clamp

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
  requester without access to the show (not a member of the show's studio, or a
  member without a grant for the show) get the uniform
  `404 { detail: "Show not found." }` (no existence oracle). The route is
  configuration-gated: unless `SHEETS_LOG_IMPORT_ENABLED` is `1`/`true`/`yes`
  (trimmed, case-insensitive) it responds `503 { detail }` with detail
  "Google Sheets log import is not configured on this deployment. Set
  SHEETS_LOG_IMPORT_ENABLED=1 to enable it."; the checks run in the order
  access 404 → config gate → body validation.
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

#### Scenario: A member without a grant gets the show 404
- **WHEN** a member of the show's studio who holds no grant for the show POSTs a log import, on a
  configured or an unconfigured deployment
- **THEN** the response is `404 { detail: "Show not found." }`, byte-identical to the unknown-show
  response, and no job is created

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

Show objects are emitted through **two** serializers, and both SHALL include `title_suffix`
as either `"date"` or `"episode"` and SHALL NOT include `next_episode`:

- The **brief** serializer, used for profile `shows[]`, emits exactly
  `{id, studio_id, name, show_code, title_suffix}`, plus `can_access` in the profile.
- The **full** serializer, used by `GET /api/shows`, `GET /api/shows/:showId`, and
  `POST /api/shows` create responses, emits those five fields plus `categories`,
  `event_palette`, `event_palette_preset`, and `event_palette_custom`.

`can_access` (boolean, additive) SHALL be on every profile `shows[]` entry, and only there:
`true` when the caller can access the show (owner or admin of its team, or a member holding a
grant for it; team-management "Member content access"), else `false`. The full serializer's
shape is unchanged.

The two shapes differ deliberately: profile is fetched on every page load and fans out over
every show in every studio the caller can reach, so the per-show configuration it does not
need is served on demand by the `/api/shows` routes instead.

Profile `show_updates[]` entries SHALL accept `title_suffix` with the same two values.
Legacy `next_episode` keys on profile/show update bodies SHALL be ignored (not persisted)
and SHALL NOT cause `400` solely due to that key. Catalog persistence SHALL store
`title_suffix` on `shows`. The SQLite column `shows.next_episode` MAY remain for rollback
safety but SHALL NOT be bumped on session create and SHALL NOT appear on the show wire.

#### Scenario: Profile show carries title_suffix

- **WHEN** a client reads profile after migration
- **THEN** each `shows[]` entry includes `title_suffix` of `"date"` or
  `"episode"` and omits `next_episode`

#### Scenario: Profile shows[] carries the brief shape

- **WHEN** a client reads `GET /api/profile`
- **THEN** each `shows[]` entry carries exactly `id`, `studio_id`, `name`, `show_code`,
  `title_suffix` and `can_access` — no `categories`, no palette fields, and no `next_episode`

#### Scenario: The /api/shows routes carry the full shape

- **WHEN** a client reads `GET /api/shows?studio_id=…` or `GET /api/shows/:showId`
- **THEN** each show object includes `title_suffix`, `categories`, `event_palette`,
  `event_palette_preset`, and `event_palette_custom`, and omits `next_episode`

#### Scenario: Profile update persists title_suffix

- **WHEN** a client PUTs profile with `show_updates[].title_suffix` set to
  `"episode"`
- **THEN** a subsequent profile read returns that show with
  `title_suffix: "episode"`

#### Scenario: Legacy next_episode on update is ignored

- **WHEN** a client PUTs profile with `show_updates[].next_episode` set
- **THEN** the update succeeds without failing solely due to that key and no
  next-episode counter is written as a live product field

#### Scenario: can_access reflects the caller's access
- **WHEN** a member holding a grant for show A but not show B of the same team reads
  `GET /api/profile`, and an admin of that team reads the same
- **THEN** the member's `shows[]` has A with `can_access: true` and B with `can_access: false`,
  the admin's has both with `can_access: true`, and `GET /api/shows` carries no `can_access`

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

### Requirement: `/api/*` responses are content-encoding negotiated

The server SHALL apply response compression to the `/api/*` surface, and only to that
surface. The set of responses subject to negotiation SHALL be defined by a single shared
predicate — hono's `COMPRESSIBLE_CONTENT_TYPE_REGEX` plus `application/x-ndjson` (which
that regex omits, and which `export.jsonl` emits) — exported from one module
(`server/src/compressibleTypes.ts`, `isCompressibleResponseType`) and consumed by the
compression middleware, by the body-measuring middleware, and by the audio router's mime
clamp, so those three can never disagree about which responses are in scope.

A compressible `/api/*` response over the middleware's 1024-byte threshold SHALL be sent
with `Content-Encoding: gzip` when the request's `Accept-Encoding` permits it, and with no
`Content-Encoding` otherwise. Because `c.json()`/`c.text()` set no `Content-Length` and the
threshold is measurable only when one is present, an inner middleware SHALL buffer
non-streaming compressible bodies that carry no length and stamp an accurate
`Content-Length` before the compression decision is made — without it the threshold is
inert and every small acknowledgement is gzipped to a larger body. That middleware SHALL
NOT consume a streaming response: it SHALL return before touching the body whenever the
response carries `Transfer-Encoding`, carries a non-compressible `Content-Type`, already
carries `Content-Encoding` or `Content-Length`, is bodyless, or answers a `HEAD` request.

Every negotiation-eligible `/api/*` response SHALL carry `Vary: Accept-Encoding`, including
the responses that ship identity — a shared cache that keyed a gzipped representation on the
URL alone would otherwise serve those bytes to a client that never sent `Accept-Encoding`,
and the reverse (an identity entry served to a gzip-capable client with no revalidation) is
equally wrong. The header SHALL be appended to any `Vary` a route already set, never
clobber it, and SHALL be treated as already satisfied when the existing value contains `*`
or an `Accept-Encoding` token in any case. It SHALL be stamped inside the compression
middleware so that it survives that middleware's response rebuild and appears on the
gzipped response.

Four surfaces SHALL be excluded **structurally** — by a property of the response itself, not
by an enumerated exception list that a future route could fall out of:

- **Audio byte serving** — the served `Content-Type` is clamped to a type the shared
  predicate never matches (see "Audio content types are clamped to non-compressible"), so
  the filter cannot select it and the hand-set `Content-Length`/`Content-Range` survive
  untouched. Being outside negotiation entirely, these responses also receive no `Vary`.
- **SSE** — `streamSSE` sets both `Transfer-Encoding: chunked` and
  `text/event-stream`; each independently causes a skip, and the `Transfer-Encoding` guard
  precedes the `Vary` step, so an SSE stream is neither buffered nor `Vary`-stamped.
- **WebSocket upgrades** — no compressible response body exists, and the compression
  middleware never touches `c.env`, so the `@hono/node-ws` env-identity handshake is
  unaffected.
- **The Next frontend bridge and `/auth/*`** — both are outside the `/api/*` mount scope;
  Next compresses its own responses.

#### Scenario: Large compressible body is gzipped and marked Vary

- **WHEN** a client sends `Accept-Encoding: gzip` to an `/api/*` route whose JSON response
  exceeds the size threshold
- **THEN** the response carries `Content-Encoding: gzip`, its decoded bytes equal the
  un-encoded body, and its `Vary` includes `Accept-Encoding`

#### Scenario: Identity response on the same route still carries Vary

- **WHEN** the same `/api/*` route is requested without an `Accept-Encoding` that permits
  gzip
- **THEN** the response carries no `Content-Encoding` and its `Vary` still includes
  `Accept-Encoding`

#### Scenario: Sub-threshold JSON ships identity with an accurate length

- **WHEN** an `/api/*` route returns a compressible JSON body smaller than 1024 bytes, with
  `Accept-Encoding: gzip` offered
- **THEN** the response carries no `Content-Encoding`, and its `Content-Length` equals the
  actual byte length of the body

#### Scenario: Audio range response is never encoded

- **WHEN** a client sends `Accept-Encoding: gzip` with a satisfiable `Range` to the audio
  download route
- **THEN** the `206` response carries no `Content-Encoding`, and its `Content-Range` and
  `Content-Length` are exactly the values the route set

#### Scenario: SSE stream is neither buffered nor Vary-stamped

- **WHEN** a client opens an `/api/*` SSE stream
- **THEN** the response carries no `Content-Encoding` and no `Vary: Accept-Encoding`, and
  its events are delivered incrementally rather than as one buffered blob

#### Scenario: Frozen export bodies are transported encoded, not altered

- **WHEN** a client sends `Accept-Encoding: gzip` to `…/export.csv` or `…/export.jsonl`
- **THEN** the response carries `Content-Encoding: gzip` and `Vary: Accept-Encoding`, and the
  decoded bytes are byte-for-byte the export body the frozen contract already specified —
  the freeze on non-JSON export bodies constrains the representation, and content-coding is
  transport applied above it, transparent to any conforming HTTP client

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

### Requirement: Audio content types are clamped to non-compressible

An audio segment's `Content-Type` SHALL be normalized by a single idempotent rule: any
value that the shared `/api/*` compressible-type predicate matches — and any absent or
blank value — degrades to `audio/webm`; **every other value round-trips verbatim**, with
parameters and case preserved (`audio/webm;codecs=opus` stays exactly that).

The rule SHALL be applied on store by `POST /api/sessions/:sessionId/audio/segments`, and
on serve by `GET /api/sessions/:sessionId/audio/segments/:segmentId` on **both** the full-body
`200` branch and the `206` range branch. Applying it again on serve is deliberate defense in
depth: it covers rows written by the other segment writers (local audio import, YouTube
import) and by older builds, and it is a no-op for every mime those paths actually produce.

This exists to guarantee one invariant: **a stored `Content-Type` can never cause an audio
range response to be compressed.** hono's `compress()` has no `206`/`Content-Range` guard —
an encoded range response loses its hand-set `Content-Length` while `Content-Range` still
describes identity bytes, corrupting playback for any range-assembling client.

The rule SHALL be defined by that compressibility hazard and SHALL NOT be an audio-type
allowlist. An allowlist goes stale silently and mangles real media: the batch importer
uploads a single `.mp4`/`.webm` file with the browser-reported `video/mp4` / `video/webm`,
and `.ogg` can arrive as `application/ogg` — none of which are compressible, none of which
must be rewritten (Safari refuses to play a `video/mp4` clip served as `audio/webm`). A bare
`audio/` prefix test is likewise insufficient, because the compressible regex ends in a
structured-suffix alternative that matches types such as `audio/x+json`; the predicate
therefore tests the full type string.

Normalization SHALL NOT be a rejection: a mislabelled upload keeps succeeding, and only its
*stored* mime moves. No script-injection protection is lost by passing non-compressible
types through — every type a browser executes markup from (`text/html`,
`application/xhtml+xml`, `image/svg+xml`, `text/xml`) is inside the compressible set and is
therefore still clamped.

#### Scenario: A video/mp4 batch import serves verbatim over a range

- **WHEN** a single-file batch import stores a segment whose declared content type is
  `video/mp4`, and a client then issues a `Range` request for it with
  `Accept-Encoding: gzip`
- **THEN** the `206` response's `Content-Type` is `video/mp4`, it carries no
  `Content-Encoding`, and its `Content-Range` and `Content-Length` are intact

#### Scenario: A compressible upload type is clamped on store and on serve

- **WHEN** a segment is uploaded to `POST /api/sessions/:sessionId/audio/segments` with
  `Content-Type: text/plain`
- **THEN** the stored segment's `mime_type` is `audio/webm`, the segment is served with
  `Content-Type: audio/webm`, and its range responses ship identity

#### Scenario: A parameterized audio type round-trips byte-identically

- **WHEN** a segment is uploaded with `Content-Type: audio/webm;codecs=opus`
- **THEN** the stored and served content type is exactly `audio/webm;codecs=opus`,
  parameters and case unchanged

### Requirement: sync-from-disk returns counts, not the segment list

`POST /api/sessions/:sessionId/audio/segments/sync-from-disk` SHALL respond
`200 {inserted, updated, scanned, has_audio}` and SHALL NOT include a `segments` array.
`inserted` is the number of metadata rows created for blobs found on disk, `scanned` is the
number of blobs examined, and `has_audio` reports whether the session has any segment after
the sync. `updated` SHALL be present and SHALL be `0`: the sync only ever inserts rows for
blobs that lack metadata, so no code path can produce a non-zero value. The key is retained
for wire-shape stability, not because it varies — a future reader SHALL NOT infer from its
presence that an update path exists.

The removed array is recorded as deliberate: the sole consumer discarded it, and it carried
roughly 349 KB of `waveform_peaks` per call. A client that needs the segment list SHALL read
`GET /api/sessions/:sessionId/audio/segments`, which is unchanged.

#### Scenario: A sync that inserts rows returns counts only

- **WHEN** a client posts to `…/audio/segments/sync-from-disk` for a session whose blob
  store holds segments with no metadata rows
- **THEN** the response body has exactly the keys `inserted`, `updated`, `scanned`, and
  `has_audio`, with no `segments` key, and the caller obtains the segment list from
  `GET …/audio/segments`

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

### Requirement: Traversal-shaped request targets are not normalized into inventory routes in the split topology
In the split-container topology (`container-deployment`), a request whose raw path meets any
of the following conditions SHALL be answered with the server's own `404`:
- it has a segment that is, or percent-decodes to, `.` or `..`;
- it contains an empty segment;
- it contains an encoded `/` or `\` under `/api` or `/auth`.

Such a request SHALL NOT be dispatched to whatever inventory route its normalized form
names. Such targets are not in the endpoint inventory. This requirement authorizes the
`404` where the single-process server normalizes them into a route today.

#### Scenario: Encoded dot-segments do not reach a route
- **WHEN** `GET /api/companion/%2e%2e/sessions` is sent with a valid session cookie at the
  public origin of the split topology
- **THEN** the response is `404` and the sessions list handler does not run

### Requirement: Text containing NUL is refused
The catalog cannot store the character U+0000 (NUL). A request value containing NUL that would
reach a catalog statement, whether from a path segment, a query value or a body field, SHALL be
refused with status `400` and a JSON body `{"detail": "<message>"}`. The statement carrying it
SHALL NOT be sent, and a catalog transaction it belongs to SHALL write nothing.

Session content is catalog content (ADR 0021 slice 7b-1), so this covers it too: an event's
category, message or metadata, a transcript word, a topic, a dashboard and every other value a
session write stores. A session write carrying NUL SHALL save nothing and send no `*.changed`
broadcast, whether the value came from the request or from a server-side source (a transcription
provider, an AI tool call, an imported sheet); such a source's run reports the failure through
its existing failure path.

These cases are handled explicitly:
- `POST /api/companion/presence` with a `session_id` containing NUL SHALL be refused with `400`,
  and SHALL store no presence.
- An OAuth callback whose `state` contains NUL SHALL be treated as an invalid state, with the
  existing `state_invalid` redirect.
- A sign-in whose identity token has a subject or email claim containing NUL SHALL be refused
  with the existing `token_invalid` redirect.
- NUL SHALL be removed from the given-name, family-name and picture claims before they are
  stored.

Values without NUL SHALL behave as before.

#### Scenario: NUL in a show name is a 400
- **WHEN** a client creates a show whose `name` contains `\u0000`
- **THEN** the response is `400` with a JSON `detail`, and no show is created

#### Scenario: NUL in a team display name is a 400
- **WHEN** a team admin creates a team whose `display_name` contains `\u0000`
- **THEN** the response is `400` with a JSON `detail`, as for the family's other validation errors, and no team is created

#### Scenario: NUL in a path segment is a 400
- **WHEN** a client requests a team-scoped route whose team id path segment contains a percent-encoded NUL
- **THEN** the response is `400` with a JSON `detail`, not `500`

#### Scenario: NUL in a presence session id is refused
- **WHEN** a Companion client posts presence with a `session_id` containing NUL
- **THEN** the response is `400`, and a later `GET /api/companion/state` answers as if that presence had never been posted

#### Scenario: NUL in the OAuth state is an invalid state
- **WHEN** the OAuth callback receives a `state` containing a percent-encoded NUL
- **THEN** it redirects with `login_error=state_invalid`

#### Scenario: NUL in the email claim refuses sign-in
- **WHEN** a first Google sign-in carries an `email` containing NUL
- **THEN** it redirects with `login_error=token_invalid` and creates no user

#### Scenario: NUL in a name claim is stripped
- **WHEN** a first Google sign-in carries a `given_name` containing NUL and valid other claims
- **THEN** the user is created, and the stored given name is the claim with NUL removed

#### Scenario: NUL in an event message is a 400
- **WHEN** a client logs an event whose `message` contains `\u0000`
- **THEN** the response is `400` with a JSON `detail`, the session has no new event, and no
  `event.changed` frame is sent

### Requirement: Catalog integer fields are bounded
A request integer that the server stores in a 64-bit catalog column (session
`start_offset_frames`, on create and on update) SHALL be at most `9007199254740991`
(`Number.MAX_SAFE_INTEGER`). A larger value SHALL be refused with status `422` and the existing
validation-error body, instead of failing on storage.

#### Scenario: An oversized frame offset is a 422
- **WHEN** a client creates a session with `start_offset_frames` of `1e20`
- **THEN** the response is `422` with a validation-error body, and no session is created

### Requirement: Concurrent first sign-in succeeds
Two OAuth callbacks for the same Google subject, carrying different valid states, that both find
no existing user SHALL both complete sign-in to the one user created. Neither SHALL get a `500`.
The second follows the existing-user path, including its disabled-account redirect. This replaces
the latent `500` that the unique Google-subject constraint gave the loser.

This narrows "Unexpected internal error stays 500" only for this race: a duplicate first
sign-in is an expected outcome, not an internal error. Any other catalog failure in the callback
still gives `500`.

#### Scenario: Two tabs sign in for the first time
- **WHEN** two first sign-in callbacks for one Google subject run at the same time with different valid states
- **THEN** both redirect to `/` with a session cookie, and exactly one user exists for that subject

### Requirement: Log-import job lines carry no internal error text
The lines and `error` field of a log-import job SHALL keep showing the operator-readable message
of a domain failure, unchanged. Examples are a missing session, missing audio segments or seam
metadata, a missing OTHER category, a failed part sync, an unreadable or unparseable sheet, and a
transcript failure. A failure raised by the catalog or its database driver SHALL appear as a
generic line naming the session (or, for a job-level failure, a generic `Failed` line), and its
detail SHALL be logged on the server only.

#### Scenario: A catalog failure during a job
- **WHEN** a catalog statement fails while a log-import job processes a session
- **THEN** the job's line for that session says the session failed without the database error's text, and the server log has the error

### Requirement: Login is required on every API route
Login SHALL always be required; there is no setting that turns it off. A `/api/*` request
without a valid session cookie SHALL get `401` with `{"detail": "Login required."}`, except:
- `GET /api/profile` and `HEAD /api/profile` (HEAD is served by the GET handler), which answer
  signed-out callers with the frozen profile response;
- `/api/admin/*`, which authenticates with `ADMIN_TOKEN`;
- `/api/companion/*` with a valid `API_TOKEN` bearer, as "API_TOKEN authenticates only the
  Companion surface" specifies (no studio-membership or show-access scoping).

The decision uses the percent-decoded request path the router matches, as defined in "API_TOKEN
authenticates only the Companion surface". `/auth/*` is unchanged. The `/api/sessions/:id/ws`
upgrade SHALL be refused for a caller without a valid session cookie. Every access check (studio
membership, team role, show access) SHALL apply to the signed-in user; the only caller with no
user is `API_TOKEN` on `/api/companion/*`. In the `GET /api/profile` response, `auth.oauth_configured` SHALL always be
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

#### Scenario: The access check applies to the signed-in user
- **WHEN** a signed-in member without a grant for show S requests a session of S
- **THEN** the response is the masked `404`, decided for that user; no request on this surface
  is authorized by `API_TOKEN` outside `/api/companion/*`

### Requirement: Admin-plane builtin flag is always false
The support plane's frozen shapes keep their `builtin` field: each `studios_catalog[]` entry of
`GET /api/admin/users` and the `studio` object of `POST /api/admin/studios`. There are no
built-in teams, so the field SHALL always be `false`, including for `test-studios` and
`test-studio-2`. The admin plane's team delete SHALL treat those two teams like any other (refused with `400`
while the team has shows).

#### Scenario: Former built-ins report builtin false
- **WHEN** the admin-token client calls `GET /api/admin/users` on a fresh catalog
- **THEN** `studios_catalog` lists `test-studios` and `test-studio-2`, first and in that order,
  each with `builtin: false`

#### Scenario: A created team reports builtin false
- **WHEN** the admin-token client creates a team with `POST /api/admin/studios`
- **THEN** the response's `studio` object carries `builtin: false`

### Requirement: Show creation and team settings need owner or admin
`POST /api/shows` SHALL require the caller to be the `owner` or an `admin` of the target team. A
member of the team SHALL get `403 {"detail": "Admin role required."}` and no show SHALL be
created; the role SHALL be checked inside the creating transaction. The existing statuses keep
their order: body validation, `400 Unknown studio id.` for a team that does not exist, the masked
`404` for a non-member, then the role `403`.

`PUT /api/profile` with a non-null `settings` or a non-empty `show_updates` SHALL require the
caller to be the `owner` or an `admin` of the selected team (`active_studio_id`). A member SHALL
get `403 {"detail": "Admin role required."}` and nothing SHALL be written, including the body's
active team and show and names. The check runs after the existing `403 No access to that team.`
and before any write. A body without `settings` and `show_updates` (switching the active team or
show, editing names) SHALL behave as before for members. The zero-membership branch is unchanged.

#### Scenario: A member cannot create a show
- **WHEN** a plain member of team T posts `POST /api/shows` for T
- **THEN** the response is `403 {"detail": "Admin role required."}` and T has no new show, while
  the same request by an admin of T is `200 {show}`

#### Scenario: A member cannot save team or show settings
- **WHEN** a plain member puts `PUT /api/profile` with `settings` for their active team, and then
  with `show_updates` for one of its shows
- **THEN** both responses are `403 {"detail": "Admin role required."}` and neither the settings
  nor the show changes, nor the member's active team and show

#### Scenario: A member still switches teams and edits names
- **WHEN** a plain member puts `PUT /api/profile` with only `active_studio_id`, `active_show_id`,
  `given_name` and `family_name`
- **THEN** the response is `200` with the updated profile

### Requirement: Session creation needs show access
`POST /api/sessions` SHALL require the caller to be able to access the requested show (the owner
or an admin of its team, or a member holding a grant for it). A caller who can see the show (a
member of its team) but cannot access it SHALL get `403 {"detail": "No access to this show."}`
and no session SHALL be created. The show is visible to members, so this denial is not masked.
The existing checks keep their order and statuses (`403 No team access.`, `400 Unknown
show_id.`, `400 Show does not belong to the active team.`), then this `403`, then title
validation. The access check SHALL be made inside the transaction that creates the session, so a
grant revoked before that transaction commits refuses the create.

#### Scenario: A member without a grant cannot create a session
- **WHEN** a member whose active team is T posts `POST /api/sessions` for a show of T they hold no
  grant for
- **THEN** the response is `403 {"detail": "No access to this show."}` and no session is created

#### Scenario: A granted member creates a session
- **WHEN** the same member, after an admin grants them the show, repeats the request
- **THEN** the response is `200` with the created session, in the frozen create shape

### Requirement: Companion routes check a signed-in caller's session access
Every access check on `/api/companion/*` SHALL apply to the signed-in user when there is one.
A request authenticated only by `API_TOKEN` (no signed-in user) is the system caller and SHALL
behave as before this change (owner decision 6, 2026-10-02; a device credential comes in slice 9).

- **Presence.** `POST /api/companion/presence` from a signed-in user with a non-empty
  `session_id` SHALL require that user to be able to access that session (team-management "Member
  content access"). A session that does not exist, is deleted, or that the user cannot access
  SHALL get the masked `404 {"detail": "Session not found"}` and SHALL store no presence; the
  client's earlier presence row is left to expire. The existing NUL check (`400`) runs first. A
  post with `closing: true` or with an empty or absent `session_id` SHALL behave as before.
- **Reads and writes on the active session.** For a signed-in caller, `GET /api/companion/state`,
  `GET /api/companion/categories`, `POST /api/companion/log`, `POST /api/companion/transport` and
  `POST /api/companion/command` SHALL resolve the active session as before (the freshest
  presence) and then check the caller's access to it. When the caller cannot access it, each
  route SHALL answer exactly as it does when there is no active session, so the session's
  existence does not leak: `state` returns `active_session_id: null` and `session: null` (and
  `last_command: null` when the stored command names a session the caller cannot access), with
  `connected_clients` unchanged; `categories`, `log`, `transport` and `command` return the
  existing `409 {"detail": "No active session — open AutoLogger in a browser and open a
  session."}` and change nothing.
- `GET /api/companion/commands/wait` and `POST /api/companion/commands/:commandId/ack` read no
  session and are unchanged.

#### Scenario: Presence for a session the user cannot open
- **WHEN** a signed-in member with no grant for show S posts presence naming a session of S, and
  then a session id that does not exist
- **THEN** both responses are the same `404`, and `GET /api/companion/state` answers as if neither
  presence had been posted

#### Scenario: Presence for an accessible session is stored
- **WHEN** a signed-in member holding a grant for show S posts presence naming a session of S
- **THEN** the response is `200 {ok: true}`, and `GET /api/companion/state` reports that session

#### Scenario: A signed-in caller cannot drive a session they cannot open
- **WHEN** a granted teammate's presence makes a session of show S active, and a signed-in member
  with no grant for S calls `state`, `categories`, `log`, `transport` and `command`
- **THEN** `state` reports no active session and no session-naming `last_command`, the other four
  respond with the no-active-session `409`, and no event, take or command is written; the same
  holds when the active session belongs to another team

#### Scenario: Token-only callers are unchanged
- **WHEN** a client authenticated only by `API_TOKEN` posts presence naming any existing session
  and then calls `state` and `log`
- **THEN** the responses are as before this change

### Requirement: Session list entries for a show without access
`GET /api/sessions` SHALL keep its scope (the caller's active show) and its entry shape for every
caller. When the caller cannot access the listed show (a member of its team without a grant), each
entry SHALL keep `id`, `title`, `deck_title`, `show_id`, `show_code`, `show_name`, `episode`,
`session_status`, `frame_rate`, `start_offset_frames`, `created_at_utc`, `episode_date` and
`archived` as today, and SHALL blank every field that carries content or live state:
- `notes` SHALL be `""`;
- `event_count` SHALL be `0`;
- `is_rolling` SHALL be `false`;
- `current_take` SHALL be `0`;
- `rolling_timecode` SHALL be `null`;
- `total_runtime_hms` SHALL be `"00:00:00"` (the value for a session with nothing logged).

The list's split into `active` and `archived` and its order are unchanged. For a caller who can
access the show the entries are unchanged.

#### Scenario: Titles and dates only
- **WHEN** a member with no grant for their active show S, which has a rolling session with notes
  and events, requests `GET /api/sessions`
- **THEN** each entry carries its id, title, show identity and dates, with `notes: ""`,
  `event_count: 0`, `is_rolling: false`, `current_take: 0`, `rolling_timecode: null` and
  `total_runtime_hms: "00:00:00"`

#### Scenario: A granted caller sees full entries
- **WHEN** a member holding a grant for S, or an admin, requests the same list
- **THEN** the entries are identical to the pre-change entries

### Requirement: Session sockets close when access is lost
When a grant revoke, a member removal, a leave, a demotion to `member` (team plane or support
plane) or a support-plane membership delete commits, the server SHALL close every
`/api/sessions/:id/ws` socket the affected user holds, in any server process sharing the
database (ADR 0021 slice 9a), on a session that user can no longer access, with close code `4403` (owner decision E, 2026-10-02). No other message is sent
on these sockets. A reconnect is refused like any upgrade for a session the caller cannot access
(the masked `404`). Sockets of other users, and the affected user's sockets on sessions they can
still access, SHALL stay open. This is new WebSocket emission semantics, authorized here.

#### Scenario: A revoked member's socket closes
- **WHEN** member M has a socket open on a session of show S and an admin revokes M's grant for S
- **THEN** M's socket closes with code `4403`, and M's next upgrade for that session is refused

#### Scenario: Other sockets stay open
- **WHEN** the same revoke commits while another member granted S and an admin have sockets open on
  that session
- **THEN** both stay open and keep receiving broadcasts

#### Scenario: A socket on another process closes
- **WHEN** member M has a socket open on a session of show S through process B, and an admin
  revokes M's grant for S through process A
- **THEN** M's socket on B closes with code `4403`

### Requirement: Imports re-check show access as they run
A log-import job SHALL re-check its creator's access to the show before each sheet it imports.
When the creator has lost access, the job SHALL stop: it appends the progress line `Access
revoked; stopping.`, ends with status `failed` and error `Access revoked.`, and imports no further
sheet. Events already written by earlier sheets stay. A YouTube import
(`POST /api/sessions/:id/youtube-import`) SHALL re-check the caller's access after the download
and before writing any segment or take; when access was lost meanwhile it SHALL respond with the
masked `404 {"detail": "Session not found"}` and write nothing.

#### Scenario: A log import stops when access is revoked
- **WHEN** a member's log import is between two sheets and an admin revokes the member's grant
- **THEN** the job's lines end with `Access revoked; stopping.`, its status is `failed` with error
  `Access revoked.`, the first sheet's events remain, and the second sheet's are not written

#### Scenario: A YouTube import after a revoke writes nothing
- **WHEN** a member's YouTube import is downloading and an admin revokes the member's grant
- **THEN** the response is the masked `404` and the session has no new segment or take

### Requirement: Writes whose access is revoked in flight change nothing
A write whose access is revoked while the request is in flight SHALL change nothing, and SHALL
get the answer its route already gives for missing access. Revoked in flight means that a grant
revocation, a member removal or a demotion commits after the route's access check and before its
write. Such a write went through with its success response before ADR 0021 slice 6b-2, when the
database did not enforce access.
- `PUT /api/sessions/:id`, `POST /api/sessions/:id/archive`, `POST /api/sessions/:id/restore`
  and `DELETE /api/sessions/:id` SHALL answer `404 {"detail": "Session not found"}` and leave the
  session row unchanged.
- `PUT /api/profile` with team settings or show updates SHALL answer
  `403 {"detail": "Admin role required."}` and write nothing, prefs and names included, as
  "Show creation and team settings need owner or admin" already requires of a member.
- A YouTube import's opt-in publish date SHALL NOT be written. The import's response is
  unchanged, as for any publish date that cannot be stored.

This narrows those routes' success outcome only for this race: a write the caller no longer has
access to is an expected refusal, not a success. Every request that no such revocation races
SHALL get the same status, body and side effects as before.

#### Scenario: A session rename racing a grant revoke
- **WHEN** a granted member's `PUT /api/sessions/:id` has passed its access check, and the
  revocation of the member's grant on the session's show commits before the update
- **THEN** the response is `404 {"detail": "Session not found"}` and the session's title is
  unchanged

#### Scenario: An archive racing a removal
- **WHEN** a member's `POST /api/sessions/:id/archive` has passed its access check, and the
  member's removal from the team commits before the archive
- **THEN** the response is `404 {"detail": "Session not found"}` and the session is not archived

#### Scenario: A profile save racing a demotion
- **WHEN** an admin's `PUT /api/profile` with `settings` has passed its early role check, and the
  admin's demotion to member commits before the save
- **THEN** the response is `403 {"detail": "Admin role required."}` and the team's settings,
  shows, and the admin's prefs and names are unchanged

### Requirement: Session content rows carry their version
Every event, transcript word and topic in a JSON response SHALL carry `version`, a positive
integer: the row's current version as of the response (ADR 0021 slice 7c-1). The field SHALL be
added to the existing row shapes without removing or renaming any field. Its responses are:
- events: the event list (`GET /api/sessions/:id/events`), create (`POST …/events`), update
  (`PUT …/events/:eventId`) and Companion `POST /api/companion/log`;
- transcript words: the list, create, update (`PATCH`) and generate responses;
- topics: the list, create, update (`PATCH`) and generate responses.

A row's version SHALL be 1 when it is created and SHALL grow by exactly one with each committed
change to the row, whoever makes it (a user edit, generation, the transcript replace, an import,
the log import or Companion). The CSV and JSONL exports SHALL NOT change: they carry no version.

#### Scenario: A created row starts at version 1
- **WHEN** a client creates an event, a transcript word and a topic
- **THEN** each response carries `version: 1`, and the lists return the same rows with `version: 1`

#### Scenario: Every change advances the version
- **WHEN** a transcript word is patched twice without a version, and the transcript is then
  regenerated
- **THEN** the two `PATCH` responses show versions 2 and 3, and the regenerated words start at
  version 1 (the replace creates new rows)

#### Scenario: Exports are unchanged
- **WHEN** a session with events is exported as CSV and as JSONL
- **THEN** both bodies are byte-identical to the bodies before this change, with no version column
  or key

### Requirement: Opt-in version checks on session content edits
The edit routes for events (`PUT` and `DELETE /api/sessions/:id/events/:eventId`), transcript
words (`PATCH` and `DELETE …/transcript-words/:wordId`) and topics (`PATCH` and `DELETE
…/topics/:topicId`) SHALL accept an optional expected version:
- `PUT` and `PATCH` take `version` (an integer from 1 to 9007199254740991) and `overwrite` (a
  boolean) in the JSON body;
- `DELETE` takes `?version=<n>` (decimal digits, same range) and `&overwrite=1`.

`overwrite` without `version`, a `version` outside the range, and a non-numeric `version` query
SHALL be refused with the existing validation answer, `422 {"detail": [...]}`.

A request without `version` SHALL behave exactly as before this change (last writer wins), apart
from the `version` field in its response.

A request with `version` SHALL be answered in this order:
1. the existing `404 {"detail":"Session not found"}` for a session the caller cannot reach;
2. `422` for an invalid body or query;
3. the event update's existing `400`s;
4. the route's existing `404` when the row does not exist (`Event not found.`, `Transcript word
   not found.`, `Topic not found.`);
5. `409 {"detail":"Version conflict.","current":<row>}` when the row's current version differs
   from `version`, where `<row>` is the row as that route's success response would return it,
   with its current `version`; nothing is written;
6. otherwise the existing success answer, with the new version (a delete answers as today).

The check and the write SHALL be atomic: of several requests that carry the same current version
for one row, at most one SHALL succeed and the others SHALL be answered `409`.

The Companion routes, the generate routes and every other writer SHALL accept no version and SHALL
never answer this `409`.

#### Scenario: A request without a version is unchanged
- **WHEN** a client updates an event whose version is 4 without sending a version
- **THEN** the update succeeds with the existing status and body plus `version: 5`

#### Scenario: A current version succeeds
- **WHEN** a client patches a topic whose version is 2 with `version: 2`
- **THEN** the response is `200` with the topic at `version: 3`

#### Scenario: A stale version is refused with the current row
- **WHEN** two clients read a transcript word at version 1, the first patches it with `version: 1`,
  and the second then patches it with `version: 1`
- **THEN** the second gets `409` with `detail` `Version conflict.` and `current` equal to the
  word's `PATCH` response shape at `version: 2` showing the first client's change, and the word is
  unchanged by the second request

#### Scenario: A stale delete is refused
- **WHEN** a client deletes an event with `?version=1` after another client updated it to version 2
- **THEN** the response is `409` with `current` at `version: 2`, and the event still exists

#### Scenario: A deleted row answers 404, not 409
- **WHEN** a client patches or deletes a topic with a version after another client deleted it
- **THEN** the response is the existing `404 {"detail":"Topic not found."}`

#### Scenario: Two edits with the same version
- **WHEN** two clients send `PUT` for one event with the same current version concurrently
- **THEN** exactly one gets `200` and the other gets `409` whose `current` is the winner's result

#### Scenario: Overwrite needs a version
- **WHEN** a client sends `overwrite: true` without `version`
- **THEN** the response is `422` and nothing is written

#### Scenario: Validation comes before the version check
- **WHEN** a client sends a stale `version` with an event update whose category the session's
  profile does not define
- **THEN** the response is the existing `400 Unknown category for this studio profile.`, not `409`

### Requirement: Overwrites are audited
A versioned edit sent with `overwrite: true` (`overwrite=1` on `DELETE`) that passes the version
check and changes the row SHALL, in the same transaction as the write, record one overwrite: the signed-in user, the
session, the row's table and id, the time, the version it replaced, the row before the write and
the row after it (none for a delete). An overwrite that fails the check SHALL be answered `409` and
record nothing. An overwrite that changes nothing (a `PATCH` with no fields) SHALL record nothing.
An edit without `overwrite` SHALL record nothing. Recording SHALL NOT change the
response: an overwrite answers exactly as the same edit without `overwrite` would.

#### Scenario: An overwrite after a conflict is recorded
- **WHEN** a client gets `409` for an event update and re-sends it with the `current.version` it
  received and `overwrite: true`
- **THEN** the update succeeds, and one overwrite record names the client's user, the event, the
  replaced version, the event as it was before and as it is after

#### Scenario: A stale overwrite is refused and not recorded
- **WHEN** a third client changes the event between the `409` and the overwrite
- **THEN** the overwrite gets `409` with the third client's row, and no overwrite is recorded

#### Scenario: A failed write records nothing
- **WHEN** an overwrite's transaction rolls back after the record was written
- **THEN** neither the write nor the record persists

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
claiming, renewing, releasing or overwriting one SHALL leave the revision unchanged. It SHALL never decrease, and two committed writes of one session SHALL never carry the
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

### Requirement: The recording lease is held by one user and client
A session's recording lease (`POST /api/sessions/:id/audio-recording-lease`, `/heartbeat`,
`/release`, body `{"client_id": …}`) SHALL be held by one signed-in user together with one client
id. The request and response shapes are unchanged.

- **Client id.** The route trims `client_id`. An id that is empty after trimming, or that contains
  NUL, SHALL be treated as never matching: a claim answers the existing `409`, a heartbeat
  `{"ok":false}`, and a release `{"ok":true}` with no change. It SHALL never answer `500`.
- **Claim.** A claim SHALL succeed (`200 {"ok":true}`) when there is no lease, when the lease has
  expired, or when the same user and client already hold it. Otherwise it SHALL answer the existing
  `409 {"detail":"Another window, tab, or user is already recording audio for this session."}` and
  change nothing. This applies when another user holds the lease, and when the same user holds it
  with another client.
- **Heartbeat.** A heartbeat SHALL extend the lease (`200 {"ok":true}`) only for the same user and
  client, and only while the lease has not expired. Any other heartbeat SHALL answer
  `200 {"ok":false}` and change nothing. This includes a heartbeat after expiry, even when no
  process has freed the lease yet.
- **Release.** A release SHALL free the lease only for the same user and client. Every release SHALL
  answer `200 {"ok":true}`.
- **Expiry.** A lease SHALL expire 40 s after its last claim or heartbeat. After that any user with
  access to the session may claim it.
- **Status.** `audio_recording_lease_holder_id`, `audio_recording_lease_alive` and
  `audio_recording_lease_age_sec` in `GET /api/sessions/:id/status` keep their names and types.
  `audio_recording_lease_holder_id` SHALL be the holder's client id only for the holding user (or a
  system caller reading a system-held lease); every other caller SHALL get the fixed value
  `"another-client"`, which never equals a client id the web issues. It is unchanged when there is
  no lease. The lease is alive exactly when it has not expired, and the age is the time since the
  last claim or heartbeat. `GET /api/companion/state`'s `is_recording` still equals the lease being
  alive.

#### Scenario: Another user cannot take a live lease
- **WHEN** user A claims the lease with client `tab-a`, and user B, who has access to the session,
  claims it with client `tab-b`, and then with client `tab-a`
- **THEN** both of B's claims answer `409`, and the status still shows `tab-a` alive

#### Scenario: Another user cannot extend or release the lease
- **WHEN** user A holds the lease with client `tab-a`, and user B heartbeats and then releases with
  client `tab-a`
- **THEN** B's heartbeat answers `{"ok":false}`, B's release answers `{"ok":true}`, and the lease is
  still held by A with an unchanged expiry

#### Scenario: A heartbeat cannot revive an expired lease
- **WHEN** the holder's last heartbeat was more than 40 s ago and no process has freed the lease,
  and the holder heartbeats
- **THEN** the heartbeat answers `{"ok":false}`, the status reports the lease not alive, and another
  user's claim succeeds

#### Scenario: Other viewers do not learn the holder's client id
- **WHEN** user A holds the lease with client `tab-a`, A and user B read the session status, and
  the Companion reads `GET /api/companion/state`
- **THEN** A's status shows `tab-a` and B's shows `another-client`, both with
  `audio_recording_lease_alive` true, and the Companion's `is_recording` is true

#### Scenario: A blank or NUL client id is refused, never a server error
- **WHEN** a client claims, heartbeats and releases with a whitespace-only client id, and then with
  one containing NUL
- **THEN** each claim answers `409`, each heartbeat `{"ok":false}`, each release `{"ok":true}`, and
  nothing is stored

#### Scenario: Releasing lets another user claim
- **WHEN** user A releases the lease, and user B claims it
- **THEN** B's claim answers `200 {"ok":true}`, and the status shows B's client id alive

### Requirement: Validation error bodies carry zod 4 issues
A request refused by a request schema SHALL be answered `422 {"detail": [...]}`, where `detail` is
the array of zod 4 issues for that request (the repo's `zod` major is 4). Each issue SHALL carry
`code`, `path` (an array of keys and indexes) and `message`. Clients SHALL rely on nothing else in
an issue. Its other fields, its code for a given failure, and the wording of messages the code does
not set SHALL be those zod 4 produces. A message the code sets (for example
`overwrite requires version`) SHALL be returned unchanged.

The same zod 4 messages SHALL appear where a route builds a string `detail` from issues:
- the team routes' `400` detail, which is the first issue's message;
- the AI v2 dashboard write's `422` detail, which is the issues' messages joined with `; `.

A number field SHALL refuse a non-finite value, for example JSON `1e400`, which parses to
`Infinity`, with this `422`. Apart from that, the status codes, the `{detail}` envelope, and which
requests are refused SHALL NOT change.

#### Scenario: A missing field is a zod 4 issue
- **WHEN** a client creates a session without `show_id`
- **THEN** the response is `422`, `detail` is an array, and one issue has code `invalid_type`, path
  `["show_id"]` and a non-empty message

#### Scenario: A message the code sets is unchanged
- **WHEN** a client sends `PUT` on an event with an otherwise valid body, `overwrite: true` and no
  `version`
- **THEN** the response is `422`, and one issue has path `["overwrite"]` and message
  `overwrite requires version`

#### Scenario: A non-finite number is refused
- **WHEN** a client creates a topic whose body has `"duration_sec": 1e400`
- **THEN** the response is `422`, one issue has path `["duration_sec"]`, and no topic is written

#### Scenario: Defaults and transforms are unchanged
- **WHEN** the DELETE version query schema parses `{version: "12", overwrite: "1"}` and `{}`, and
  every request schema with a default or transform parses the inputs recorded before the migration
- **THEN** the first gives version `12` with overwrite `true`, the second gives an empty object,
  and every other output is the same as before the migration

### Requirement: Session sockets close after live updates were interrupted
A server process's connection for receiving session frames can drop (ADR 0021 slice 9a). While it
is down, sockets attached to that process receive no frames. When the connection is
re-established after a loss, the process SHALL close every `/api/sessions/:id/ws` socket attached
to it at that moment with close code `1012`, once per loss, and SHALL send no other message on
those sockets. Frames committed while the connection was down are not replayed. A client recovers
them by reconnecting, which reads the current state as on any open, and the reconnect is admitted
as usual. This is new WebSocket emission semantics, authorized here.

#### Scenario: Sockets close when the frame connection comes back
- **WHEN** a browser has a socket open through process B, B's frame connection drops, and B
  re-establishes it
- **THEN** the socket closes with code `1012` once, and the browser's reconnect is admitted

#### Scenario: Frames resume after the reconnect
- **WHEN** the browser has reconnected to B after that close, and a write then commits through
  process A
- **THEN** the browser's socket on B receives that write's frame
