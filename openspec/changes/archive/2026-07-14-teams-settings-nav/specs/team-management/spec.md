# team-management — delta

## MODIFIED Requirements

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

The `/teams` route SHALL remain a full citizen of the app shell: the shell's settings
affordance SHALL open and close the settings modal while on `/teams`, on desktop and
mobile, and the page SHALL provide an explicit affordance that returns to the sessions
home view (`/`) via the shared navigation wrapper — present in every state the page
renders (the signed-in page and the signed-in-required notice alike). A settings save
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

#### Scenario: Dev-anonymous mode degrades gracefully
- **WHEN** `/teams` is loaded on a dev-anonymous deployment (no OAuth, no user)
- **THEN** a signed-in-required notice renders and no `/api/teams/*` request is
  issued

#### Scenario: Settings opens from the teams route
- **WHEN** a user on `/teams` activates the shell's Settings affordance
- **THEN** the settings modal opens, and its close control dismisses it

#### Scenario: Teams page offers a way back in every state
- **WHEN** `/teams` renders the signed-in page, and separately when it renders the
  signed-in-required notice
- **THEN** in both states an on-page affordance is present that navigates to `/` (the
  sessions home view) without relying on browser Back

#### Scenario: Open modal survives route changes
- **WHEN** the settings modal is open and the route changes (e.g. browser Back between
  `/` and `/teams`)
- **THEN** the modal remains open and functional, and the shell's Settings state never
  desynchronizes from what is rendered
