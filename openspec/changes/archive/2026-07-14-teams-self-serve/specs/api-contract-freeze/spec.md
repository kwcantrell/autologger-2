# api-contract-freeze — delta

## ADDED Requirements

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
