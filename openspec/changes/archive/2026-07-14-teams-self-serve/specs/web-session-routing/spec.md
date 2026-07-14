# web-session-routing — delta

## MODIFIED Requirements

### Requirement: URL-addressed session state
The web app SHALL derive its active-session state from the URL via a client-side route
table with exactly three app routes: `/` (no session selected; home/sessions view),
`/sessions/:id` (the session workspace for `:id`), and `/teams` (the team management
view; no session selected). Selecting a session SHALL push a
history entry for `/sessions/:id`; selecting the session that is already active SHALL
NOT push a duplicate entry (no-op or replace); closing the active session SHALL
navigate to `/`; browser Back/Forward SHALL drive the same state transitions as in-app
selection and close. Creating a session SHALL navigate to its `/sessions/:id` the same
way selection does. Navigating to `/teams` SHALL push a history entry and leaves any
active session (the departure semantics of the transport-stop requirement apply
unchanged). The workspace's session id SHALL come from the route parameter —
there SHALL be no parallel component-state copy of the active session id that can
disagree with the URL. The router-known route predicate SHALL remain defined in the
shared route-definition module, which its two runtime consumers (the post-login
stash write and the return-path validator) import; the three sanctioned mirrors of
the route table — `AppShell`'s wouter patterns, the vite dev-middleware matcher, and
the server serve block — SHALL each be extended in the same change that extends the
module (they cannot mechanically share one definition; keeping them in lockstep is
the requirement).

(Non-normative: a path matching no route — reachable today via the raw built-asset
path the static handler serves, e.g. `/src/pages/index/index.html` — renders the
no-session home view without rewriting the address bar.)

#### Scenario: Selecting a session updates the URL
- **WHEN** an authenticated user selects a session from the rail or session list
- **THEN** the address bar shows `/sessions/<id>`, a history entry is pushed, and the
  workspace for that session mounts

#### Scenario: Re-selecting the active session does not stack history
- **WHEN** the user activates the session card or rail entry for the session already
  shown at `/sessions/<id>`
- **THEN** no additional history entry is created — one Back press still leaves the
  session

#### Scenario: Browser Back leaves the session
- **WHEN** the user is on `/sessions/<id>` (having navigated there in-app) and presses
  the browser Back button
- **THEN** the app returns to the no-session home view at `/`, exactly as if the
  close-session control had been used

#### Scenario: Deep-link reload restores the session
- **WHEN** an authenticated user reloads the browser on `/sessions/<id>` for a session
  they can access, or pastes that URL into a new tab
- **THEN** the session workspace for `<id>` mounts once resolution completes — the
  session survives the reload

#### Scenario: Teams route is a first-class app route
- **WHEN** an authenticated user navigates to `/teams` in-app, or reloads the browser
  on `/teams`
- **THEN** the team management view mounts at that URL, and browser Back returns to
  the previous view

### Requirement: Originator-scoped transport stop on route departure
When, and only when, the current client initiated the transport roll during the
current workspace mount (it issued the transport-start command), a same-document
departure from that session's `/sessions/:id` — the close control, browser
Back/Forward within the app, or in-app navigation to any route that does not match
the same session id (`/`, `/teams`, or a different session's route)
— SHALL invoke the same stop-transport-if-needed behavior the close-session control
invokes today, exactly once per departure. A client that did NOT initiate the roll
(it deep-linked or navigated into an already-rolling session) SHALL NOT stop the
transport on departure, by any navigation path. Cross-document departures (tab close,
navigating to another origin, Back off a deep-link landing that is the first history
entry) are outside this requirement's scope.

#### Scenario: Originator's departure stops the roll
- **WHEN** the user started the roll in this workspace and leaves `/sessions/<id>` via
  the close control, browser Back, or by selecting another session
- **THEN** stop-transport-if-needed fires exactly once for the departure

#### Scenario: Departure to the teams route stops the originator's roll
- **WHEN** the user started the roll in this workspace and navigates to `/teams`
- **THEN** stop-transport-if-needed fires exactly once, the same as any other
  departure

#### Scenario: Passive viewer's departure never stops the roll
- **WHEN** a user opens `/sessions/<id>` while the transport is already rolling
  (started by another client) and then leaves by any navigation path
- **THEN** no transport-stop command is issued — the roll continues for the operator
  who started it

#### Scenario: StrictMode double-invoke does not stop anything
- **WHEN** the app runs under React StrictMode (dev) and a workspace mounts on a
  rolling session
- **THEN** the mount/unmount simulation issues no transport-stop command
