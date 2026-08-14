# web-home-launch

## Purpose

Capability scope: the home surface and session-finding affordances — the launch surface on
`/` plus the navigation rail’s session search and session cards, which render on every route.
## Requirements
### Requirement: Branded home launch surface
The no-session home view (`/`, and any unmatched path rendering the home view) SHALL present a
launch surface as a **dedicated home route component** rendered in the workspace's place (gate
override of D10 — see the `web-session-routing` delta, which retires the legacy placeholder
element): the product wordmark in the brand
display face (currently League Gothic — the face itself is non-normative brand identity), a
one-line positioning tagline, a "jump back in" card for the most recent active session
(defined as the first entry of the active-sessions list — server order, newest created) when
one exists, and a New Session action (rendered as the primary action when no **active**
session exists; copy accounts for archived-only users — "start a session", not "first").
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

### Requirement: Real rail session search
The navigation rail SHALL provide a working session search: a visible input that filters the
Recent and Archived session lists by title (case-insensitive) as the user types, with a clear
control and an explicit "no sessions match" empty state. The former offscreen-input search
affordance SHALL be removed — activating the search affordance SHALL never move focus to a
visually hidden element. On the collapsed desktop rail the search collapses to its icon; the
collapsed affordance SHALL be a focusable control activatable by keyboard, and activating it
(pointer or keyboard) expands the rail and moves focus into the visible input.

#### Scenario: Filtering sessions
- **WHEN** the user types a query into the rail search
- **THEN** only sessions whose titles contain the query (case-insensitive) remain listed, and
  clearing the query restores the full lists

#### Scenario: No matches
- **WHEN** the query matches no sessions
- **THEN** the list shows a "no sessions match" message naming the query

#### Scenario: Collapsed-rail activation
- **WHEN** the desktop rail is collapsed and the user activates the search affordance by
  pointer or keyboard
- **THEN** the rail expands and keyboard focus lands in the visible search input

### Requirement: Session-card status polling is bounded

The recent-sessions list SHALL NOT run per-card session-status pollers for
background sessions: at most the **open session's** card (the session whose
`/sessions/:id` route the workspace currently displays) subscribes to the
per-session status query, and subscribing it SHALL add no status poller
beyond the workspace's own. Background cards SHALL derive
their live indication and timecode from the sessions-list poll's own row
fields (`is_rolling`, `rolling_timecode`), refreshing at that poll's cadence
and rendered in the list's `HH:MM:SS` form (no frame field).

#### Scenario: Background rolling cards add no pollers

- **WHEN** the list shows several rolling sessions while one different session
  is open
- **THEN** only the open session's status query is subscribed (shared with the
  workspace), and the rolling cards still show a live badge and an `HH:MM:SS`
  timecode from the list data

#### Scenario: No open session means no pollers at all

- **WHEN** the user is on `/` (no session open) and the list shows rolling
  sessions
- **THEN** no session-status query is subscribed anywhere, and every rolling
  card shows its live badge and `HH:MM:SS` timecode from list data

#### Scenario: Open-session card stays fresh

- **WHEN** the open session is rolling
- **THEN** its card's timecode comes from the shared status query at the
  workspace's existing cadence

