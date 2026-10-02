## REMOVED Requirements

### Requirement: Teams management UI

**Reason**: It required a dev-anonymous `/teams` notice (no user identity) and a scenario for
it. Anonymous mode is removed: a signed-out visitor always gets the login view. Restated without
the anonymous notice under "Teams management page".

**Migration**: None. Dev users sign in with Google; the anonymous-mode panel is deleted from
the page.

## ADDED Requirements

### Requirement: Teams management page
The web app SHALL provide team management at the `/teams` route, reachable from the
app shell: the user's teams with their role in each, a create-team affordance, and —
for teams where the user is `admin` — management controls (rename, members list with
roles, invite by email, pending-invite list with revoke, promote/demote, remove
member, delete team). For teams where the user is a plain `member`, the view SHALL
be read-only (members list) plus a leave affordance; pending invites SHALL NOT be
shown to non-admins. A member's view of a team with zero enabled admins SHALL state
that the team has no admins and needs support (no self-heal affordance exists by
design). Built-in team memberships SHALL render as read-only legacy entries with no
management or leave affordances. Mutations SHALL be reflected in the UI without a manual reload. Errors
surfaced by the last-admin protection, caps, and validation rules SHALL be presented
as actionable messages, not silent failures.

The `/teams` route SHALL remain a full citizen of the app shell: the shell's settings
affordance SHALL open and close the settings modal while on `/teams`, on desktop and
mobile, and the page SHALL provide an explicit affordance that returns to the sessions
home view (`/`) via the shared navigation wrapper — present in every state the page
renders. A settings save
that switches the active studio while on `/teams` SHALL NOT navigate (the close-session
path's no-open-session guard applies).

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

#### Scenario: Signed-out visitor gets the login view
- **WHEN** `/teams` is loaded by a signed-out visitor
- **THEN** the login view renders in place of the page (there is no anonymous `/teams`
  notice), and no `/api/teams/*` request is issued

#### Scenario: Settings opens from the teams route
- **WHEN** a user on `/teams` activates the shell's Settings affordance
- **THEN** the settings modal opens, and its close control dismisses it

#### Scenario: Teams page offers a way back in every state
- **WHEN** `/teams` renders, in any state
- **THEN** in every state an on-page affordance is present that navigates to `/` (the
  sessions home view) without relying on browser Back

#### Scenario: Open modal survives route changes
- **WHEN** the settings modal is open and the route changes (e.g. browser Back between
  `/` and `/teams`)
- **THEN** the modal remains open and functional, and the shell's Settings state never
  desynchronizes from what is rendered

## MODIFIED Requirements

### Requirement: Membership roles
Every team membership SHALL carry a role, `admin` or `member`. Team-management
operations (rename, delete, invite, revoke invite, change a member's role, remove a
member) SHALL require the caller to be an authenticated `admin` of that team. Content
operations (sessions, events, shows, studio settings) SHALL remain role-agnostic —
any member keeps the access they have today, and the per-session authorization path
(`requireSession`) SHALL NOT consult roles. All `/api/teams/*` endpoints SHALL
require an authenticated user (`401` otherwise). For a team the caller is not a member of, team
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
