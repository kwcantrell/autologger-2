## MODIFIED Requirements

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
| `GET /api/teams/:id` | member | team detail: `{id, name, role, enabled_admin_count, members: [{id, email, given_name, family_name, role}]}` (`enabled_admin_count` = members whose role is `admin` and whose accounts are not disabled — the owner is not counted, so a new team reports `0`; per-member disabled status is deliberately not exposed; `members` lists the owner first, then admins, then members); `invites: [{email, invited_at_utc}]` present only when the caller is `admin` or `owner` |
| `PATCH /api/teams/:id` `{display_name}` | admin or owner | rename (display name only) |
| `DELETE /api/teams/:id` | owner | delete; `400` while shows exist |
| `POST /api/teams/:id/invites` `{email}` | admin or owner | immediate membership for existing users, else pending invite; idempotent per team+email |
| `DELETE /api/teams/:id/invites/:email` | admin or owner | revoke pending invite |
| `POST /api/teams/:id/members/:userId/role` `{role}` | owner | promote/demote between `admin` and `member`; `409` when the target is the owner |
| `DELETE /api/teams/:id/members/:userId` | admin or owner | remove member; removing an `admin` needs the owner (`403` for an admin caller); `409` when the target is the owner |
| `POST /api/teams/:id/leave` | member | caller leaves; `409` for the owner |
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
`401`, the masked `404`, the caller's role `403`, body validation `400`, then the target's
`404`, `409` or owner-only `403`.

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

## ADDED Requirements

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
