## MODIFIED Requirements

### Requirement: Branded home launch surface
The no-session home view (`/`, and any unmatched path rendering the home view) SHALL present a
launch surface as a **dedicated home route component** rendered in the workspace's place (gate
override of D10 — see the `web-session-routing` delta, which retires the legacy placeholder
element): the product wordmark in the brand
display face (currently League Gothic — the face itself is non-normative brand identity), a
one-line positioning tagline, a "jump back in" card for the most recent active session
(defined as the first entry of the active-sessions list — server order, newest created) when
one exists and the user can open it, and a New Session action (rendered as the primary action
when no **active** session exists; copy accounts for archived-only users — "start a session",
not "first") when the active team has at least one show the user can access ("Session actions
follow show access").
Copy SHALL NOT reference viewport-specific chrome (e.g. "the left rail"). The route structure
is otherwise unchanged — `/` SHALL NOT auto-redirect.

#### Scenario: Home with existing sessions
- **WHEN** the user is on `/` and at least one active session exists
- **THEN** the launch surface shows the wordmark, the resume card for the first active-list
  entry, and a New Session button

#### Scenario: No active sessions
- **WHEN** the user is on `/` with no active sessions
- **THEN** the launch surface shows the wordmark and a primary create-session action whose
  copy is correct whether or not archived sessions exist

#### Scenario: Resuming from the card
- **WHEN** the user activates the resume card
- **THEN** the app navigates to that session's `/sessions/:id` route through the shared
  navigation wrapper (a since-deleted session resolves per `web-session-routing`'s
  deep-link-resolution states — the card does not need to pre-validate)

#### Scenario: New Session opens the shared modal
- **WHEN** the user activates the home New Session action
- **THEN** the AppShell-owned New Session modal opens (the same flow as the rail's button)

#### Scenario: Home for a member without access
- **WHEN** a member whose active team has no show they can access loads `/`, and the active show
  has active sessions
- **THEN** the launch surface shows the wordmark and tagline, no resume card and no New Session
  action

## ADDED Requirements

### Requirement: Session actions follow show access
The web app SHALL decide what a user can do with sessions from the profile: the user's role in
each team (`auth.user.teams[].role`) and each show's `can_access`. A user can access a show when
its `can_access` is `true`.

- **Create and import.** The rail's New Session and Batch Import controls and the home New
  Session action SHALL be shown only when the active team has at least one show the user can
  access. The New Session and Batch Import show pickers SHALL list only shows the user can access.
- **Session cards.** A session card (Recent or Archived, rail or home) whose show the user cannot
  access SHALL render as a non-openable row: its title is plain text, activating the card does
  not navigate, its card menu (rename, archive, restore, delete) is absent, and it shows the hint
  "No access — ask a team admin". Search filtering applies to these rows as to others.
- **Deep links.** Opening `/sessions/:id` for a session the user cannot access SHALL resolve to
  the existing not-found state (`web-session-routing`), with its copy unchanged.
- **Freshness.** A grant or revoke made on `/teams` SHALL be reflected in these affordances
  without a manual reload once the profile is refetched.

#### Scenario: A member without access sees titles only
- **WHEN** a member with no grant for their active show S opens the app
- **THEN** the rail lists S's sessions as non-openable rows with the "No access — ask a team
  admin" hint and no card menu, and New Session and Batch Import are hidden

#### Scenario: A granted member gets the actions back
- **WHEN** an admin grants that member show S and the member's profile refetches
- **THEN** S's session cards open their sessions, New Session and Batch Import are shown, and
  their show pickers list S

#### Scenario: Pickers list only accessible shows
- **WHEN** a member holding a grant for show A but not show B of the active team opens New
  Session or Batch Import
- **THEN** the show picker lists A and not B

#### Scenario: Owners and admins see every action
- **WHEN** the owner or an admin of the active team opens the app
- **THEN** every session card is openable, and New Session and Batch Import are shown whenever
  the team has a show
