## REMOVED Requirements

### Requirement: Team roles: owner, admin and member
**Reason**: Its rule that content operations stay role-agnostic, and that `requireSession` SHALL NOT
consult roles, no longer holds: session content now needs show access (owner decisions 3 and 4,
2026-10-02). Its "Content access is role-blind" scenario can't be kept, so the requirement is
restated under a new name.
**Migration**: "Team roles, owner anchor and show access" below keeps every other rule and
scenario, adds grant management to the role table, and replaces the role-blind scenario. "Member
content access" and "Show grants" carry the content rules.

### Requirement: Owner-anchored team lifecycle
**Reason**: Its revocation-latency rule ("live connections … are not force-terminated") and its
scenario "Removed member's live session is not severed mid-flight" no longer hold: owner decision
E (2026-10-02) closes the affected user's session sockets when access is lost.
**Migration**: "Owner-anchored team lifecycle and access revocation" keeps every other rule and
scenario and replaces that one.

## ADDED Requirements

### Requirement: Owner-anchored team lifecycle and access revocation
The owner and admins SHALL be able to rename their team and remove a `member`. Only the owner
SHALL be able to promote a `member` to `admin`, demote an `admin` to `member`, remove an
`admin`, transfer ownership, and delete the team. Any member other than the owner SHALL be able
to leave. Deleting a team SHALL keep the existing rule: it is rejected while the team still has
shows. Deleting SHALL remove the team's memberships, pending invites, definition row, and
settings blob — through the same store method the admin plane uses, so both planes cascade
identically.

**The owner anchors the team.** The owner SHALL NOT leave, be removed or have their role changed
through this surface; each such request SHALL be rejected with `409` (`Transfer ownership
first.`) and change nothing. Last-admin protection SHALL NOT exist: an owner may demote or
remove every admin, and a team whose only admin-capable member is the owner is valid.

**Transfer.** `POST /api/teams/:id/owner {user_id}` SHALL make `user_id` the owner and the
previous owner an `admin`, in one catalog transaction. The target SHALL be a current member of
the team (`404 Member not found` otherwise) whose account is enabled (`400` otherwise). A
transfer to the caller themselves SHALL succeed and change nothing.

**Revocation.** Removal, leave, demotion, transfer, delete and a grant revoke take effect at the
next authorization check (HTTP request or WebSocket establishment). In addition, when a removal,
leave, demotion to `member` (team plane or support plane), support-plane membership delete or
grant revoke commits, the server SHALL close every session WebSocket the affected user holds in
this process on a session they can no longer access (owner decision E, 2026-10-02); the client's
reconnect gets the masked `404`. Sockets on sessions the user still reaches stay open, and
in-flight HTTP requests are not interrupted. This covers one server process; with several
processes or Realtime (slices 8 and 9) the close is driven from the database.

#### Scenario: Promote, demote, remove
- **WHEN** a team owner promotes member M to admin, then demotes them back, then removes them
- **THEN** each operation succeeds in turn and the members list reflects it

#### Scenario: An admin removes members but not admins
- **WHEN** admin A removes member M, and then attempts to remove admin B
- **THEN** M's removal succeeds, and the attempt on B responds `403` and B keeps their membership

#### Scenario: The owner cannot leave or be stripped
- **WHEN** the owner attempts to leave, and an admin or the owner attempts to remove the owner or
  change the owner's role
- **THEN** each request responds `409` with `Transfer ownership first.` and the owner's
  membership is unchanged

#### Scenario: Transfer ownership
- **WHEN** owner O transfers ownership of the team to member M
- **THEN** M is the owner, O is an `admin`, the team has exactly one owner, and O can now leave

#### Scenario: Transfer to a non-member or a disabled account
- **WHEN** the owner transfers ownership to a user who is not a member of the team, and then to a
  member whose account is disabled
- **THEN** the first responds `404 Member not found`, the second responds `400`, and the owner is
  unchanged

#### Scenario: Delete blocks on shows
- **WHEN** the owner attempts to delete a team that still has shows
- **THEN** the request is rejected (same behavior as the existing admin-plane delete) and the
  team survives

#### Scenario: A removed member's session socket is closed
- **WHEN** an admin removes member M while M has a session WebSocket open in that team
- **THEN** after the removal commits M's socket is closed, its reconnect gets the masked `404`,
  and M's next HTTP request in that team is denied

#### Scenario: Demotion to member closes sockets without a grant
- **WHEN** the owner demotes admin A to member while A has session WebSockets open on a show A
  holds a grant for and on a show A holds none for
- **THEN** the socket on the ungranted show is closed and the socket on the granted show stays
  open

### Requirement: Team roles, owner anchor and show access
Every team membership SHALL carry a role: `owner`, `admin` or `member`. A team SHALL have at
most one `owner`, and the catalog SHALL refuse a second one. All `/api/teams/*` endpoints SHALL
require an authenticated user (`401` otherwise). For a team the caller is not a member of, team
endpoints SHALL respond with a masked `404` (existence not confirmed, matching the sessions
posture). For a team the caller is a member of without the required role, they SHALL respond
`403`. Team-management operations SHALL require these roles:

| Operation | owner | admin | member |
| --- | --- | --- | --- |
| rename | yes | yes | `403` |
| invite, revoke an invite | yes | yes | `403` |
| remove a `member` | yes | yes | `403` |
| remove an `admin` | yes | `403` | `403` |
| change a role (promote or demote) | yes | `403` | `403` |
| delete the team | yes | `403` | `403` |
| transfer ownership | yes | `403` | `403` |
| grant or revoke show grants | yes | yes | `403` |
| create a show, change team or show settings | yes | yes | `403` |
| leave | `409` | yes | yes |

No operation on this surface SHALL target the owner: removing the owner or changing the owner's
role SHALL be refused with `409` and change nothing, whoever the caller is. Content access SHALL
follow "Member content access": owners and admins reach every show of their team, and a member
reaches only the shows they hold a grant for. There are no built-in teams: every team,
`test-studios` and `test-studio-2` included, is managed through this surface.

#### Scenario: Admin manages, member cannot
- **WHEN** a team `admin` renames the team and a plain `member` of the same team attempts the
  same rename
- **THEN** the admin's request succeeds and the member's responds `403`

#### Scenario: Only the owner changes roles and deletes
- **WHEN** a team `admin` attempts to promote a member, demote another admin, or delete the
  team
- **THEN** each request responds `403` and nothing changes, and the same requests by the owner
  succeed (the delete subject to the shows rule)

#### Scenario: Non-member cannot probe a team
- **WHEN** an authenticated user who is not a member of team T calls any `/api/teams/T/*`
  operation, and another user calls the same operation for a team id that does not exist
- **THEN** both receive the same masked `404`

#### Scenario: Former built-ins are ordinary teams
- **WHEN** the owner of `test-studios` (after the bootstrap claim) renames it, and a non-member
  calls any `/api/teams/test-studios/*` operation
- **THEN** the rename succeeds and the non-member gets the masked `404`; no request gets the old
  built-in `400`

#### Scenario: Content access follows the role and the grants
- **WHEN** the owner, an admin, a member with a grant for show S and a member without one each
  open a session of S in their team
- **THEN** the first three get the session, and the member without a grant gets the masked
  `404`

### Requirement: Show grants
A show grant SHALL be a `(user, show)` pair that gives a `member` full session access in that
show: open, record, edit, create sessions and imports. Each grant SHALL record `can_write`, which
is always true in this version, who granted it and when. Owners and admins of the show's team
SHALL grant and revoke grants, and see each member's granted shows in the team detail; a member
SHALL get `403`.

- **Grant.** The target SHALL be a current member of the show's team (`404 Member not found`
  otherwise). Granting to the owner or an admin SHALL succeed and store nothing, because their
  role already gives access. Granting a grant that exists SHALL succeed and change nothing. A
  member whose account is disabled SHALL be grantable (the membership is inert while disabled).
- **Revoke.** Revoking SHALL succeed whether or not the grant existed.
- **Scope.** The show SHALL belong to the team named in the request (`404 Show not found.`
  otherwise, after the caller's role check).
- **Revocation with the membership.** When a member leaves a team, is removed from it, or loses
  the membership through the support plane, their grants for that team's shows SHALL be deleted
  in the same transaction as the membership. Deleting a show or a user SHALL delete its grants.
- **Role changes keep grants.** Promoting a member to admin, demoting an admin to member, and
  transferring ownership SHALL leave stored grants unchanged; a grant held by an owner or admin
  has no effect until they are a `member` again.
- **Concurrency.** The caller's role and the target's membership SHALL be re-checked inside the
  transaction that writes the grant. A grant racing the target's leave or removal SHALL end as
  some serial order of the two: either the leave commits first and the grant gets `404 Member not
  found`, or the grant commits first and the leave deletes it. In both cases no grant outlives
  the membership.
- **Open sockets close.** After a revoke commits, the server SHALL close every session WebSocket
  that user holds on the show's sessions in this process; the client's reconnect then gets the
  masked `404`. Sockets on shows the user still reaches stay open (team-management "Owner-anchored
  team lifecycle and access revocation").

#### Scenario: An admin grants a member a show
- **WHEN** an admin grants member M show S of their team, and M then opens a session of S
- **THEN** the grant responds `200`, the team detail lists S in M's `show_ids`, and M gets the
  session

#### Scenario: A member cannot manage grants
- **WHEN** a plain `member` grants or revokes a grant in their team
- **THEN** each request responds `403` and nothing changes

#### Scenario: Granting to a non-member, an owner or an admin
- **WHEN** an admin grants show S to a user who is not a member of the team, then to the owner,
  then to another admin
- **THEN** the first responds `404 Member not found`, and the other two respond `200` and store no
  grant

#### Scenario: Grant and revoke are idempotent
- **WHEN** an admin grants member M show S twice, then revokes it twice
- **THEN** every request responds `200`, and M ends with no grant for S

#### Scenario: A show from another team
- **WHEN** an admin of team T grants a show that belongs to team U, or a show id that does not
  exist
- **THEN** both respond `404 Show not found.` and nothing is stored

#### Scenario: Leaving or removal revokes the grants
- **WHEN** member M holds grants for two shows of team T and one show of team U, and M leaves T
  (or an admin removes M from T, or support deletes M's membership of T)
- **THEN** M has no grant for T's shows and keeps the grant for U's show, and re-inviting M to T
  restores no access

#### Scenario: A promoted and demoted member keeps their grants
- **WHEN** the owner promotes member M, who holds a grant for show S, to admin and later demotes
  M back to member
- **THEN** M reaches every show while admin, and after the demotion reaches S and no other show

#### Scenario: A revoke closes the member's open sockets
- **WHEN** member M has session WebSockets open on a session of show S and on a session of show T,
  both granted, and an admin revokes M's grant for S
- **THEN** M's socket on the S session is closed and its reconnect gets the masked `404`, and M's
  socket on the T session stays open

#### Scenario: An unrelated revoke leaves a granted socket open
- **WHEN** member M holds a grant for show S and has a session WebSocket open on it, and an admin
  revokes another member's grant for S, or M's grant for another show
- **THEN** M's socket stays open

#### Scenario: A grant racing the target's leave
- **WHEN** an admin grants member M a show while M leaves the team
- **THEN** either the grant gets `404 Member not found`, or the grant succeeds and the leave
  deletes it; in both cases M ends with no membership and no grant

### Requirement: Member content access
A user SHALL be able to access a show when they are the `owner` or an `admin` of the show's team,
or a `member` of the show's team who holds a grant for that show. A user SHALL be able to access
a session when they can access the session's show; a session with no show SHALL be denied. This
one rule SHALL decide every session-scoped API route, the session WebSocket upgrade, the
show-scoped log import (when it is requested and again before each sheet it imports), every
Companion route called by a signed-in user, and which sessions the transcript-generation lock
names to a requester. A denial SHALL be the same masked `404` a
non-member gets today, so a member without a grant cannot tell whether the session exists.

What a member without a grant keeps:
- the team's show list and each show's details (`GET /api/shows`, `GET /api/shows/:showId`);
- the session list of their active show, in the usual entry shape with only identity, titles and
  dates filled; the fields that carry content or live state are blanked (api-contract-freeze
  "Session list entries for a show without access");
- switching their active team and show, and editing their own names.

What needs a role, whatever the grants:
- creating a show, changing team settings and editing a show's settings need `owner` or `admin`
  (`403`).

Creating a session in a show the caller can see but cannot access SHALL get `403` (the show is
not masked), decided inside the creating transaction, so a revoke that commits first refuses the
create.

The web app SHALL follow the same rule (web-home-launch "Session actions follow show access"),
and its Settings modal SHALL stay reachable for a member: a member's view SHALL hide the team
defaults and the show editing controls, and its save SHALL NOT send team or show settings
(proposed; the owner confirms at approval).

#### Scenario: A member without a grant is masked
- **WHEN** a member with no grant for show S requests a session of S, its events, an export, its
  audio, an AI route, its WebSocket, or the log import for S
- **THEN** each responds with the same masked `404` a non-member of the team gets

#### Scenario: Titles stay visible
- **WHEN** a member with no grant for their active show S requests the session list
- **THEN** the response lists S's sessions in the usual shape, with titles and dates and with
  `notes` empty, `event_count` 0 and `is_rolling` false

#### Scenario: Owners and admins need no grant
- **WHEN** the owner and an admin of team T, holding no grants, open a session of any show of T
- **THEN** both get the session

#### Scenario: Members don't create shows or change settings
- **WHEN** a member, with or without grants, creates a show in their team or saves team or show
  settings
- **THEN** each request responds `403` and nothing changes

#### Scenario: A revoke racing a session create
- **WHEN** an admin revokes member M's grant for show S while M creates a session in S
- **THEN** either the create commits first and the session exists, or the revoke commits first
  and the create responds `403` and creates nothing

#### Scenario: A member saves Settings
- **WHEN** a member opens Settings, switches the active team and saves
- **THEN** the modal shows no team defaults or show editing controls, the save succeeds, and the
  request carried no team or show settings

## MODIFIED Requirements

### Requirement: Teams management page
The web app SHALL provide team management at the `/teams` route, reachable from the
app shell: the user's teams with their role in each and a create-team affordance. Each team
SHALL render one of three views, by the user's role in it:
- **owner:** rename, members list with roles, invite by email, pending-invite list with revoke,
  promote/demote, remove member, "Transfer ownership" on each other member, a show-access picker
  on each `member` row, and delete team. No leave affordance.
- **admin:** rename, members list with roles, invite by email, pending-invite list with revoke,
  remove on `member` rows, and a show-access picker on each `member` row. No role toggles, no
  transfer, no delete; a leave affordance.
- **member:** the read-only members list plus a leave affordance; pending invites and other
  members' show access SHALL NOT be shown.

The show-access picker SHALL list the team's shows with one checkbox each, checked for the shows
the member holds a grant for; toggling a checkbox SHALL grant or revoke that show. Owner and admin
rows SHALL NOT offer the picker (their role gives access to every show).

A view of a team that has no owner SHALL show a notice that the team has no owner and needs
support; an admin's view keeps its admin controls under the notice. There are no built-in team rows: every team
renders by role. Mutations SHALL be reflected in the UI without a manual reload. Errors
surfaced by the owner rules, caps, and validation rules SHALL be presented
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
- **THEN** team A shows rename, invites (including pending invites) and remove on member rows,
  with no role toggles, transfer or delete; and team B shows the read-only view with leave

#### Scenario: Owner sees role and ownership controls
- **WHEN** the owner of team A opens `/teams`
- **THEN** team A shows the admin controls plus role toggles, "Transfer ownership" on other
  members, and delete, and shows no leave affordance

#### Scenario: Invite flow round-trip
- **WHEN** an admin invites an email from `/teams` and then revokes it
- **THEN** the pending invite appears in the list after inviting and disappears
  after revoking, without a page reload

#### Scenario: Orphaned team is visible as such
- **WHEN** a member opens `/teams` for a team that has no owner (a former built-in before the
  bootstrap claim, or after a support-plane action)
- **THEN** the team renders with a no-owner-contact-support notice instead of management
  controls

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

#### Scenario: Granting a show from the team page
- **WHEN** an admin opens `/teams`, ticks show S on member M's row, and later unticks it
- **THEN** M holds a grant for S after the first change and none after the second, each
  reflected without a page reload, and owner and admin rows show no picker
