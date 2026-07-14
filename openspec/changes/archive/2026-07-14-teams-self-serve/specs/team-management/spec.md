# team-management — delta

## ADDED Requirements

### Requirement: Membership roles
Every team membership SHALL carry a role, `admin` or `member`. Team-management
operations (rename, delete, invite, revoke invite, change a member's role, remove a
member) SHALL require the caller to be an authenticated `admin` of that team. Content
operations (sessions, events, shows, studio settings) SHALL remain role-agnostic —
any member keeps the access they have today, and the per-session authorization path
(`requireSession`) SHALL NOT consult roles. All `/api/teams/*` endpoints SHALL
require an authenticated user (`401` otherwise — the dev-anonymous mode has no user
identity and cannot use them). For a team the caller is not a member of, team
endpoints SHALL respond with a masked `404` (existence not confirmed, matching the
sessions posture); for a team the caller is a member of without the required role,
`403`. Built-in teams (`test-studios`, `test-studio-2`) are excluded from the ENTIRE
`/api/teams/:id` management surface — every operation on a built-in id, by any
caller, SHALL be rejected with a `400` validation error (they remain support-managed
through the frozen admin plane).

#### Scenario: Admin manages, member cannot
- **WHEN** a team `admin` renames the team and a plain `member` of the same team
  attempts the same rename
- **THEN** the admin's request succeeds and the member's responds `403`

#### Scenario: Non-member cannot probe a team
- **WHEN** an authenticated user who is not a member of team T calls any
  `/api/teams/T/*` operation, and another user calls the same operation for a team
  id that does not exist
- **THEN** both receive the same masked `404`

#### Scenario: Built-ins rejected on every management route
- **WHEN** any authenticated user (member of the built-in or not) calls any
  `/api/teams/:id/*` operation — rename, delete, invite, revoke, role change,
  remove, or leave — against a built-in team id
- **THEN** the request is rejected with `400` and nothing changes

#### Scenario: Content access is role-blind
- **WHEN** a `member` (not admin) works with shows, sessions, and events in their
  team
- **THEN** every content operation behaves exactly as before this change

### Requirement: Self-serve team creation
Any authenticated user SHALL be able to create a team, providing a slug id and a
display name. Validation SHALL reuse the existing admin-path slug validator (the
`STUDIO_ID_SLUG_RE` regex — lowercase, starts with a letter, letters/digits/hyphens,
2–63 chars — not merely length bounds), reject built-in ids and duplicates, and
require a non-empty display name ≤200 chars. The creator SHALL become the team's
sole initial `admin`. Team ids SHALL be immutable after creation (rename changes
only the display name). **Creation cap (DoS control, gate ruling 2026-07-14):** a
user who is already `admin` of 20 or more non-built-in teams SHALL receive a `400`
with an actionable message instead of a new team; the support plane is not subject
to the cap.

#### Scenario: Create and own a team
- **WHEN** a signed-in user creates team `my-crew` with display name "My Crew"
- **THEN** the team exists, appears in the creator's profile teams with
  `role: "admin"`, and the creator can immediately perform admin operations on it

#### Scenario: Reserved and duplicate ids rejected
- **WHEN** a user attempts to create a team with a built-in id (e.g. `test-studios`)
  or an id that already exists
- **THEN** the request fails with a validation error and no team is created

#### Scenario: Creation cap
- **WHEN** a user who is already admin of 20 non-built-in teams attempts to create
  another
- **THEN** the request is rejected with `400` and an actionable message

### Requirement: Team lifecycle and last-admin protection
Team admins SHALL be able to rename their team, promote a `member` to `admin`,
demote an `admin` to `member` (including themselves), remove a member, and delete
the team; any member SHALL be able to leave a team. Deleting a team SHALL keep the
existing rule: it is rejected while the team still has shows. Deleting SHALL remove
the team's memberships, pending invites, definition row, and settings blob — through
the same store method the admin plane uses, so both planes cascade identically.

**Last-admin protection is a global invariant, not an operation list:** no operation
on this surface — demote, remove, leave, or any membership upsert side effect —
SHALL reduce a team's count of **enabled** admins (admins whose accounts are not
disabled) to zero; a violating request SHALL be rejected with `409` and change
nothing. The admin count and the mutation SHALL execute within a single catalog
transaction (the check is race-free only inside the transaction).

**Revocation latency:** removal, leave, and delete take effect at the next
authorization check (HTTP request or WebSocket establishment); live connections and
already-mounted workspaces are not force-terminated — this is the accepted semantic,
consistent with the latched-resolution behavior of the session UI.

#### Scenario: Promote, demote, remove
- **WHEN** a team admin promotes member M to admin, then demotes them back, then
  removes them
- **THEN** each operation succeeds in turn and the members list reflects it

#### Scenario: Last enabled admin cannot be stripped
- **WHEN** a team's only other admin account is disabled and any actor attempts to
  demote the sole enabled admin, remove them, or that admin attempts to leave
- **THEN** the operation is rejected with `409` and the membership is unchanged

#### Scenario: Delete blocks on shows
- **WHEN** an admin attempts to delete a team that still has shows
- **THEN** the request is rejected (same behavior as the existing admin-plane
  delete) and the team survives

#### Scenario: Removed member's live session is not severed mid-flight
- **WHEN** an admin removes member M while M has a session workspace open in that
  team
- **THEN** M's next authorization-checked interaction (new HTTP request or WS
  connect) is denied, but the removal request itself does not terminate M's live
  connections

### Requirement: Email invites
Team admins SHALL invite people by email. Emails SHALL be normalized as
lowercase-trimmed exact strings — normalization performed in application code
(JS `toLowerCase().trim()`) identically at invite time and sign-in time, never via
SQL `lower()` (ASCII-only folding) — with no Gmail-style alias canonicalization.
Invite input SHALL be validated (plausible email shape, ≤254 chars). If the
normalized email matches the email of record of one or more existing user rows
(**including disabled accounts** — membership is inert while disabled and this
avoids unmaterializable pendings), `member` membership SHALL be granted immediately
to every matching user; a matching user who already holds membership is left
untouched (existing role preserved — an invite is never a role downgrade and cannot
interact with last-admin protection). If no user matches, a pending invite SHALL be
recorded (one per team+email; re-inviting is idempotent). **Pending-invite cap (DoS
control, gate ruling 2026-07-14):** a team SHALL hold at most 200 pending invites;
further invites are rejected `400`. Admins SHALL be able to list and revoke their
team's pending invites; revocation is idempotent (`200` whether or not the invite
existed); a revoked invite never materializes.

At first Google sign-in, the OAuth callback's new-user branch SHALL materialize
pending invites matching the new user's normalized email into `member` memberships
— **only when the presented id_token carries `email_verified: true`** (the email
claim is an authorization join key here; unverified emails SHALL NOT match
invites) — atomically with user creation, deleting the consumed invite rows.
Existing sign-ins SHALL NOT re-scan invites. Accepted residual: an invite addressed
to a person whose existing account carries a different email of record never
converts or materializes; it remains visible in the pending list, revocable, and
the admin's remedy is to re-invite the address the account actually uses.

#### Scenario: Invite an existing user
- **WHEN** an admin invites an email that (after normalization) belongs to an
  existing user
- **THEN** that user immediately has `member` membership, no pending invite is
  stored, and the user sees the team on their next profile fetch

#### Scenario: Inviting an existing member is a no-op
- **WHEN** an admin invites the email of a user who is already a member — including
  the team's sole admin
- **THEN** the request succeeds with no change to the existing membership or role
  (the sole admin is not demoted)

#### Scenario: Invite before first sign-in
- **WHEN** an admin invites `New.Person@Example.com`, and later a Google account
  whose verified email normalizes to `new.person@example.com` signs in for the
  first time
- **THEN** the created user starts with `member` membership of the inviting team,
  and the pending invite row is consumed

#### Scenario: Unverified email never materializes
- **WHEN** a first-time sign-in presents an id_token whose `email_verified` claim
  is absent or false, and pending invites exist for that email
- **THEN** the user is created without those memberships and the pending invites
  remain (available to materialize on a later verified sign-in of that address, or
  to be revoked)

#### Scenario: Revoked invite never lands
- **WHEN** an admin revokes a pending invite before the invitee's first sign-in,
  and the invitee then signs in
- **THEN** the new user has no membership of that team

### Requirement: NEW_USER_ALL_TEAMS deprecated
The server SHALL ignore the `NEW_USER_ALL_TEAMS` environment variable: new users
receive exactly the memberships materialized from pending invites (possibly none),
never a blanket grant. When the variable is set, the server SHALL log a one-time
deprecation warning at startup. Documentation (`README`, `.env.example`) SHALL
reflect the deprecation.

#### Scenario: Blanket grant no longer happens
- **WHEN** the server runs with `NEW_USER_ALL_TEAMS=1` and a user with no pending
  invites signs in for the first time
- **THEN** the new user has zero team memberships and a deprecation warning was
  logged at startup

### Requirement: Zero-membership onboarding
When an authenticated user's profile reports no team memberships, the web app SHALL
render an onboarding state offering to create their first team in place of the
team-dependent views (`/`'s workspace, which cannot function without a team, and
equivalently `/teams`), and completing that creation SHALL
land the user in the new team as its admin with the app usable (team active,
show-creation reachable). Users whose invites materialized at sign-in never see this
state — they land in their invited team.

#### Scenario: First-team onboarding
- **WHEN** a newly signed-up user with zero memberships loads `/`
- **THEN** the onboarding state renders with a create-team affordance, and
  completing it lands them in the created team as admin

### Requirement: Teams management UI
The web app SHALL provide team management at the `/teams` route, reachable from the
app shell: the user's teams with their role in each, a create-team affordance, and —
for teams where the user is `admin` — management controls (rename, members list with
roles, invite by email, pending-invite list with revoke, promote/demote, remove
member, delete team). For teams where the user is a plain `member`, the view SHALL
be read-only (members list) plus a leave affordance; pending invites SHALL NOT be
shown to non-admins. A member's view of a team with zero enabled admins SHALL state
that the team has no admins and needs support (no self-heal affordance exists by
design). Built-in team memberships SHALL render as read-only legacy entries with no
management or leave affordances. In dev-anonymous mode (no user identity), `/teams`
SHALL render a signed-in-required notice and SHALL NOT issue `/api/teams/*`
requests. Mutations SHALL be reflected in the UI without a manual reload. Errors
surfaced by the last-admin protection, caps, and validation rules SHALL be presented
as actionable messages, not silent failures.

#### Scenario: Admin sees controls, member does not
- **WHEN** a user who is admin of team A and member of team B opens `/teams`
- **THEN** team A shows the full management controls (including pending invites) and
  team B shows the read-only view with leave

#### Scenario: Invite flow round-trip
- **WHEN** an admin invites an email from `/teams` and then revokes it
- **THEN** the pending invite appears in the list after inviting and disappears
  after revoking, without a page reload

#### Scenario: Orphaned team is visible as such
- **WHEN** a member opens `/teams` for a team whose only admins are disabled or
  removed (support-plane action)
- **THEN** the team renders with a no-admins-contact-support notice instead of
  management controls

#### Scenario: Dev-anonymous mode degrades gracefully
- **WHEN** `/teams` is loaded on a dev-anonymous deployment (no OAuth, no user)
- **THEN** a signed-in-required notice renders and no `/api/teams/*` request is
  issued
