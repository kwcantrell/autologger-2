# Spec Delta

## MODIFIED Requirements

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


### Requirement: Member content access
A user SHALL be able to access a show when:
- they are the `owner` or an `admin` of the show's team; or
- they are a `member` of the show's team who holds a grant for that show.

A user SHALL be able to access a session when they can access the session's show. A session with no show SHALL be denied.

This one rule SHALL decide:
- every session-scoped API route;
- the session WebSocket upgrade;
- the show-scoped log import, checked when it is requested and again before each sheet it imports;
- every Companion route called by a signed-in user;
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
