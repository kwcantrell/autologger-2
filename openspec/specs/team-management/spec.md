# team-management

## Purpose

Self-serve team lifecycle for the web app: every membership carries a role (`owner`, `admin`
or `member`), authenticated users can create their own teams (becoming their owner) and manage
them through the `/api/teams/*` endpoint family and the `/teams` web UI. Each team has at most
one owner, enforced in the database; the owner anchors the team (it cannot leave, be removed or
be demoted without transferring ownership) and alone changes roles and deletes the team, while
admins rename, invite and remove members. Invites materialize against existing users
immediately or as a pending invite consumed at first verified sign-in. The bootstrap owner
(`BOOTSTRAP_OWNER_EMAIL`) claims every ownerless team at sign-in. Teams once
hardcoded in the product (`test-studios`, `test-studio-2`) are ordinary teams. Content access
follows the role: owners and admins reach every show of their team, and members reach a show's
sessions only through a per-show grant that owners and admins manage; losing access closes the
user's session sockets. This capability governs team membership, lifecycle and show grants.

## Requirements

### Requirement: Email invites
Team admins and the owner SHALL invite people by email. Emails SHALL be normalized as
lowercase-trimmed exact strings — normalization performed in application code
(JS `toLowerCase().trim()`) identically at invite time and sign-in time, never via
SQL `lower()` (ASCII-only folding) — with no Gmail-style alias canonicalization.
Invite input SHALL be validated (plausible email shape, ≤254 chars). If the
normalized email matches the email of record of one or more existing user rows
(**including disabled accounts** — membership is inert while disabled and this
avoids unmaterializable pendings), `member` membership SHALL be granted immediately
to every matching user; a matching user who already holds membership is left
untouched (existing role preserved — an invite never changes a role, the owner's
included). If no user matches, a pending invite SHALL be
recorded (one per team+email; re-inviting is idempotent). **Pending-invite cap (DoS
control, gate ruling 2026-07-14):** a team SHALL hold at most 200 pending invites;
further invites are rejected `400`. Admins and the owner SHALL be able to list and revoke their
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
  the team's owner
- **THEN** the request succeeds with no change to the existing membership or role
  (the owner is not demoted)

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
never a blanket grant. The one addition is the bootstrap owner, who also becomes owner of every
ownerless team at sign-in ("Bootstrap owner"); that claim does not read this variable. When the
variable is set, the server SHALL log a one-time
deprecation warning at startup. Documentation (`README`, `.env.example`) SHALL
reflect the deprecation.

#### Scenario: Blanket grant no longer happens
- **WHEN** the server runs with `NEW_USER_ALL_TEAMS=1` and a user with no pending
  invites, whose email is not the bootstrap owner's, signs in for the first time
- **THEN** the new user has zero team memberships and a deprecation warning was
  logged at startup

### Requirement: Zero-membership onboarding
When an authenticated user's profile reports no team memberships, the web app SHALL render an onboarding state offering to create their first team. It takes the place of the team-dependent views: `/`'s workspace, which cannot function without a team, and equivalently the Settings view's Team sections that `/teams` opens. Completing that creation SHALL land the user in the new team as its owner, with the app usable: the team active and show creation reachable.

Users whose invites materialized at sign-in never see this state; they land in their invited team. A new user's active team and show SHALL NOT be seeded from any global setting: they start empty, and the first team the user can reach applies.

#### Scenario: First-team onboarding
- **WHEN** a newly signed-up user with zero memberships loads `/`
- **THEN** the onboarding state renders with a create-team affordance that says the user will be the team's owner, and completing it lands them in the created team as owner

### Requirement: Teams management page
The web app SHALL provide team management in the Settings view's **Team** group, which shows the active team (chosen in the top bar). The group has three sections.

**Members**
- The members list, with each member's role and show access summary.
- Activating a member SHALL open that member's side panel.
- Owners and admins also get invite-by-email and the pending-invite list with revoke.

**Shows**
- The team's shows.
- Owners and admins get add-show.
- Activating a show SHALL open that show's side panel.

**Team details**
- The team's name and its default frame rate (a team setting; owners and admins edit it).
- Ownership transfer, leave, and delete team, each by role.
- A create-team affordance for any user.

What each role sees in the active team:
- **owner:**
  - rename;
  - invite by email;
  - pending invites with revoke;
  - in a member's panel: Admin/Member role, remove, and a show-access picker for `member` rows;
  - transfer ownership to another member;
  - delete team.
  - No leave affordance.
- **admin:**
  - rename;
  - invite by email;
  - pending invites with revoke;
  - in a `member` row's panel: remove and the show-access picker.
  - No role change, no transfer, no delete.
  - A leave affordance.
- **member:**
  - the read-only members list;
  - a leave affordance.
  - Pending invites and other members' show access SHALL NOT be shown.
  - Controls a member cannot use SHALL render disabled under a notice naming the member's role, rather than disappearing without explanation.

**Show-access picker**
- It SHALL list the team's shows with one checkbox each, checked for the shows the member holds a grant for.
- Saving the panel SHALL grant the newly checked shows and revoke the unchecked ones.
- Owner and admin rows SHALL NOT offer the picker, because their role gives access to every show.

**Delete team**
- When the team still has shows, delete team SHALL say that its shows must be removed first, rather than offering a request the server refuses.

**No-owner notice**
- A view of a team that has no owner SHALL show a notice that the team has no owner and needs support.
- An admin's view keeps its admin controls under the notice.

**General**
- There are no built-in team rows: every team renders by role.
- Mutations SHALL be reflected in the UI without a manual reload.
- Errors surfaced by the owner rules, caps and validation rules SHALL be presented as actionable messages, not silent failures.

**The `/teams` route** SHALL stay a router-known shell path.
- Loading or navigating to it SHALL open the Settings view on the Members section, over the sessions home view.
- Closing the view while on `/teams` SHALL navigate to `/` through the shared navigation wrapper, so the user never lands on an empty page.
- The view's back control is present in every state the view renders.
- An active-team change while on `/teams` SHALL NOT navigate elsewhere (the close-session path's no-open-session guard applies).

#### Scenario: Admin sees controls, member does not
- **WHEN** a user who is admin of team A and member of team B opens Settings › Members with A active, then switches to B in the top bar
- **THEN** for A they see invites (including pending invites), and a `member` row's panel offers remove and show access but no role change, with no transfer or delete in Team details. For B they see the read-only list, disabled controls under a role notice, and leave in Team details.

#### Scenario: Owner sees role and ownership controls
- **WHEN** the owner of team A opens Settings › Members and Team details
- **THEN** each other member's panel offers the role choice and remove, Team details offers rename, transfer ownership and delete team, and no leave affordance is shown

#### Scenario: Invite flow round-trip
- **WHEN** an admin invites an email from Settings › Members and then revokes it
- **THEN** the pending invite appears in the list after inviting and disappears after revoking, without a page reload

#### Scenario: Orphaned team is visible as such
- **WHEN** a member opens Settings › Members for a team that has no owner (a former built-in before the bootstrap claim, or after a support-plane action)
- **THEN** the section renders a no-owner-contact-support notice instead of management controls

#### Scenario: Signed-out visitor gets the login view
- **WHEN** `/teams` is loaded by a signed-out visitor
- **THEN** the login view renders in place of the app (there is no anonymous `/teams` notice), and no `/api/teams/*` request is issued

#### Scenario: Settings opens from the teams route
- **WHEN** a signed-in user loads or navigates to `/teams`
- **THEN** the Settings view opens on the Members section for the active team

#### Scenario: Teams page offers a way back in every state
- **WHEN** the Settings view is open on `/teams` and the user closes it, in any state the view renders
- **THEN** the app navigates to `/` (the sessions home view) without relying on browser Back

#### Scenario: Open modal survives route changes
- **WHEN** the Settings view is open and the route changes (e.g. browser Back from `/teams` to `/`)
- **THEN** the shell's Settings state never desynchronizes from what is rendered: either the view stays open and functional, or it closed through its own close path

#### Scenario: Granting a show from the team page
- **WHEN** an admin opens member M's panel, ticks show S and saves, then reopens it, unticks S and saves
- **THEN** M holds a grant for S after the first save and none after the second, each reflected without a page reload, and owner and admin panels show no picker

#### Scenario: Deleting a team that still has shows
- **WHEN** the owner of a team that still has shows opens Team details
- **THEN** delete team is unavailable and says the team's shows must be removed first

### Requirement: Self-serve team creation makes the creator owner
Any authenticated user SHALL be able to create a team, providing a slug id and a display name.
Validation SHALL reuse the existing admin-path slug validator (the `STUDIO_ID_SLUG_RE` regex —
lowercase, starts with a letter, letters/digits/hyphens, 2–63 chars — not merely length bounds),
reject ids that already exist, and require a non-empty display name ≤200 chars. The creator
SHALL become the team's `owner` and its only member. Team ids SHALL be immutable after creation
(rename changes only the display name). **Creation cap (DoS control, gate ruling 2026-07-14):**
a user who already owns 20 or more teams SHALL receive a `400` with an actionable message
instead of a new team; teams the user only admins or belongs to SHALL NOT count, and the support
plane is not subject to the cap.

#### Scenario: Create and own a team
- **WHEN** a signed-in user creates team `my-crew` with display name "My Crew"
- **THEN** the team exists, the response and the creator's profile teams carry
  `role: "owner"`, and the creator can immediately perform owner operations on it

#### Scenario: Existing ids rejected
- **WHEN** a user attempts to create a team with the id `test-studios`, or any id that already
  exists
- **THEN** the request fails with the "already exists" `400` and no team is created or changed

#### Scenario: Creation cap counts owned teams
- **WHEN** a user who owns 20 teams attempts to create another, and a user who owns 19 teams and
  admins 5 more attempts the same
- **THEN** the first is rejected with `400` and an actionable message, and the second succeeds

### Requirement: Concurrent team and ownership writes
Every team write SHALL decide its outcome from the state it commits against, so concurrent
requests end as if they had run one after the other.

- **Role re-check.** A team write (rename, delete, invite, revoke, role change, remove, transfer)
  SHALL re-check the caller's role inside the catalog transaction that performs the write. A
  caller demoted, removed or no longer owner because of a concurrently committed request SHALL
  receive the status that check gives when run alone (`403`, or the masked `404`), and SHALL
  change nothing. The early role check stays, so the order of statuses (`401`, `404`, `403`,
  then validation `400`) is unchanged.
- **Target re-check.** The target's membership and role SHALL be read inside the same
  transaction: a target that is gone gets `404 Member not found`, and a target that is the owner
  when the write commits gets the owner `409`.
- **Creation.** The cap count, the team definition and the creator's owner membership SHALL be
  written in one transaction. Concurrent creates SHALL NOT take a user past the creation cap. Id
  validation SHALL come first. Then, inside the transaction:
  - an id that still has shows SHALL be refused with `400`;
  - any membership rows, pending invite rows and settings left under the id SHALL be removed
    before the creator is added, so a reused id starts with only its creator and default
    settings.

  The admin plane's team creation SHALL apply the same refusal and removal.
- **Invites.** The user lookup, the pending-invite cap and the grant or pending row SHALL be
  written in one transaction. Concurrent invites SHALL NOT take a team past the cap.
- **Role change.** A role change SHALL update an existing membership only. When the target is not
  a member when the change commits, the request SHALL get `404 Member not found`, and no
  membership SHALL be created.
- **Removal.** Removing a member SHALL check the membership inside the transaction that removes
  it. A removal whose target is already gone SHALL get `404`.
- **Transfer.** The demotion of the old owner and the promotion of the target SHALL commit
  together or not at all. Whatever the interleaving of transfers, leaves, removals, the bootstrap
  claim and the admin plane's owner upsert, a team SHALL never have two owners, and a team that
  had an owner SHALL still have exactly one after any of these team-plane writes.
- **Show creation.** Creating a show SHALL check, inside its transaction, that the team exists (a
  defined team) and that the caller may use it. A show SHALL NOT be created for a team deleted
  concurrently; that request gets `400 Unknown studio id.`.
- **Admin plane.** The admin-plane membership add SHALL re-check the team inside its transaction.
  The admin plane's membership removal, account disable and non-owner membership upsert SHALL NOT
  be subject to the owner rules of this surface (api-contract-freeze, "Admin add-membership role
  field"). A race between one of them and any team-plane write SHALL end as some serial order of
  the two requests.
- **Cross-team independence.** Team-scoped reads and writes SHALL NOT make writes in another team
  fail. Concurrent writes in two different teams SHALL both succeed.

#### Scenario: A demoted admin's in-flight rename changes nothing
- **WHEN** admin B's rename has passed its early role check, and the owner's demotion of B
  commits before B's rename transaction
- **THEN** B's request gets `403` and the team keeps its name

#### Scenario: Concurrent creates respect the cap
- **WHEN** a user who owns 19 teams sends two team creates at the same time
- **THEN** exactly one succeeds and the other gets the cap `400`

#### Scenario: A reused team id starts empty
- **WHEN** an invite for team `acme` races the deletion of `acme`, and later another user creates
  a team `acme`
- **THEN** the new team has only its creator as a member, no pending invites, and default settings

#### Scenario: Two concurrent transfers leave one owner
- **WHEN** the owner sends two transfers of the same team, to members M and N, at the same time
- **THEN** one succeeds, the other gets `403`, and the team has exactly one owner, M or N, with
  the old owner an `admin`

#### Scenario: A transfer racing the target's leave
- **WHEN** the owner transfers ownership to member M while M leaves the team
- **THEN** either the leave commits first and the transfer gets `404 Member not found`, or the
  transfer commits first and M's leave gets `409`; in both cases the team has exactly one owner

#### Scenario: Writes in different teams don't conflict
- **WHEN** two users create two different teams at the same time, and two admins of two different
  teams invite at the same time
- **THEN** all four requests succeed

#### Scenario: Concurrent invites respect the pending cap
- **WHEN** a team holds 199 pending invites and two invites for different new emails arrive at the
  same time
- **THEN** exactly one is recorded and the other gets the cap `400`

#### Scenario: A promotion racing a removal does not resurrect the member
- **WHEN** the owner promotes member M while an admin removes M, and the removal commits first
- **THEN** the promotion gets `404 Member not found` and M has no membership

#### Scenario: A raced double removal
- **WHEN** two admins remove the same member at the same time
- **THEN** one gets `200` and the other gets `404`

#### Scenario: No show for a deleted team
- **WHEN** a show create for team T has passed its checks, and the deletion of T commits before
  the show is inserted
- **THEN** the show create gets `400 Unknown studio id.`, and no show references T

### Requirement: Bootstrap owner
The server SHALL read one email address from `BOOTSTRAP_OWNER_EMAIL`. The match SHALL be exact
ASCII: both sides are trimmed and ASCII-lowercased (only `A`-`Z` fold), never Unicode-folded. A
sign-in whose verified email contains any non-ASCII character SHALL NOT claim (the sign-in still
succeeds, and the refusal is logged). On every successful Google sign-in, new account or
existing, whose verified email matches that address this way, the signed-in user SHALL become `owner` of every team
that has no owner when the claim commits: an existing membership is upgraded to `owner`, and
otherwise an `owner` membership is created. The claim SHALL NOT change a team that already has
an owner, and SHALL NOT change any other membership: existing admins stay admins. A sign-in by
any other email SHALL claim nothing. Sign-ins that are refused (unverified email, disabled
account, identity mismatch) SHALL claim nothing.

The claim SHALL run after the account is created or updated and before the login session is
issued. If it fails, the server SHALL log the failure without the email value and the sign-in
SHALL still succeed (fail open); the next sign-in retries it. Concurrent claims and team-plane
writes SHALL NOT give a team two owners. No migration SHALL assign an owner: teams that exist
without one (the former built-ins, teams created through the admin plane, teams whose owner
support removed) stay ownerless until a bootstrap sign-in or a support-plane owner upsert.
Every team without an owner is claimed, whoever created it (owner decision A, 2026-10-02). The
claim SHALL log the id of each team it claimed, and never the email.

#### Scenario: First sign-in claims the ownerless teams
- **WHEN** a fresh catalog holds the ownerless teams `test-studios` and `test-studio-2`, and the
  bootstrap email signs in for the first time
- **THEN** the new user is `owner` of both, `GET /api/teams/test-studios` shows
  `role: "owner"`, and the log names `test-studios` and `test-studio-2` as claimed

#### Scenario: A repeat sign-in claims teams that became ownerless
- **WHEN** the bootstrap owner has signed in before, support then creates a team through the
  admin plane, and the bootstrap owner signs in again
- **THEN** the bootstrap owner is `owner` of the new team, and their other memberships are
  unchanged

#### Scenario: An owned team is untouched and admins stay admins
- **WHEN** team T has owner O and admin A, team U has no owner and admin A, and the bootstrap
  email signs in
- **THEN** T's owner is still O, the bootstrap user is `owner` of U, and A is still an `admin` of
  both

#### Scenario: Other emails claim nothing
- **WHEN** a user whose verified email differs from `BOOTSTRAP_OWNER_EMAIL` signs in while
  ownerless teams exist
- **THEN** no membership is created or changed by the sign-in

#### Scenario: The email matches after normalization
- **WHEN** `BOOTSTRAP_OWNER_EMAIL` is ` Owner@Example.com ` and the Google email is
  `owner@example.com`
- **THEN** the sign-in claims the ownerless teams

#### Scenario: A non-ASCII email never matches
- **WHEN** `BOOTSTRAP_OWNER_EMAIL` is `kalen@gmail.com` and a verified Google email is
  `Kalen@gmail.com` (U+212A KELVIN SIGN, which JS `toLowerCase` folds to `k`)
- **THEN** the sign-in succeeds, claims nothing, and logs that the claim was refused

#### Scenario: Teams other users created are claimed
- **WHEN** team `my-studio`, created by user C before this change, has admin C and no owner, and
  the bootstrap email signs in
- **THEN** the bootstrap user is `owner` of `my-studio`, C is still an `admin`, and the log names
  `my-studio`

#### Scenario: A failed claim does not block sign-in
- **WHEN** the claim's catalog write fails during the bootstrap owner's sign-in
- **THEN** the callback still responds `302 /` with a login session, and the failure is logged
  without the email value

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
grant revoke commits, the server SHALL close every session WebSocket the affected user holds, in
any server process sharing the database, on a session they can no longer access (owner decision E, 2026-10-02); the client's
reconnect gets the masked `404`. Sockets on sessions the user still reaches stay open, and
in-flight HTTP requests are not interrupted. The close is published inside the transaction that
removes the access (ADR 0021 slice 9a), so a removal whose close cannot be published fails and
changes nothing.

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
  that user holds on the show's sessions in any server process sharing the database (ADR 0021
  slice 9a); the client's reconnect then gets the
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
A user SHALL be able to access a show when:
- they are the `owner` or an `admin` of the show's team; or
- they are a `member` of the show's team who holds a grant for that show.

A user SHALL be able to access a session when they can access the session's show. A session with no show SHALL be denied.

This one rule SHALL decide:
- every session-scoped API route;
- the session WebSocket upgrade;
- the show-scoped log import, checked when it is requested and again before each sheet it imports;
- every Companion route, called by a signed-in user or by a Companion device acting as the user
  who created it (api-contract-freeze "Companion routes run as the caller's user");
- which sessions the transcript-generation lock names to a requester.

A denial SHALL be the same masked `404` a non-member gets today, so a member without a grant cannot tell whether the session exists.

What a member without a grant keeps:
- the team's show list and each show's details (`GET /api/shows`, `GET /api/shows/:showId`);
- the session list of their active show, in the usual entry shape with only identity, titles and dates filled; the fields that carry content or live state are blanked (api-contract-freeze "Session list entries for a show without access");
- switching their active team and show, and editing their own names.

What needs a role, whatever the grants:
- creating a show, changing team settings and editing a show's settings need `owner` or `admin` (`403`).

Creating a session in a show the caller can see but cannot access SHALL get `403` (the show is not masked). The check is decided inside the creating transaction, so a revoke that commits first refuses the create.

The web app SHALL follow the same rule (web-home-launch "Session actions follow show access"). Its Settings view SHALL stay reachable for a member (owner, 2026-10-02, confirmed at approval):
- a member's view SHALL disable the team settings and the show editing controls under a notice naming their role;
- a member SHALL still be able to edit and save their own account settings (their names), and that save SHALL NOT send team or show settings — the default frame rate is a team setting and lives in Team details, not Account.

#### Scenario: A member without a grant is masked
- **WHEN** a member with no grant for show S requests a session of S, its events, an export, its audio, an AI route, its WebSocket, or the log import for S
- **THEN** each responds with the same masked `404` a non-member of the team gets

#### Scenario: Titles stay visible
- **WHEN** a member with no grant for their active show S requests the session list
- **THEN** the response lists S's sessions in the usual shape, with titles and dates and with `notes` empty, `event_count` 0 and `is_rolling` false

#### Scenario: Owners and admins need no grant
- **WHEN** the owner and an admin of team T, holding no grants, open a session of any show of T
- **THEN** both get the session

#### Scenario: Members don't create shows or change settings
- **WHEN** a member, with or without grants, creates a show in their team or saves team or show settings
- **THEN** each request responds `403` and nothing changes

#### Scenario: A revoke racing a session create
- **WHEN** an admin revokes member M's grant for show S while M creates a session in S
- **THEN** either the create commits first and the session exists, or the revoke commits first and the create responds `403` and creates nothing

#### Scenario: A member saves Settings
- **WHEN** a member switches the active team in the top bar, opens Settings, edits their name and saves
- **THEN** the team and show controls render disabled under a role notice, the save succeeds, and the request carried no team or show settings
