# web-session-routing

## Purpose

The web app's client-side routing for session state: a route table with exactly three
app routes, `/` (no session selected; home/sessions view), `/sessions/:id` (the session
workspace for `:id`), and `/teams` (the team management view; no session selected),
replacing the legacy imperative selection spine. Covers how
selecting, creating, and closing a session drive the URL and browser history; the five
mutually-exclusive resolution states a deep link to `/sessions/:id` can render (loading,
workspace, archived, not-found, error) against the `GET /api/sessions/:id` detail
endpoint (authorized in `api-contract-freeze`); the originator-scoped rule for who stops
a rolling transport on route departure (including departure to `/teams`); and retirement of
`body.dataset.sessionId`/`window.V3_selectSession`/`window.V3_closeSession`/`syncChrome`
in favor of route-driven rendering.

## Requirements

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

### Requirement: Deep-link resolution states
The client SHALL resolve the `:id` route parameter with a per-id query against
`GET /api/sessions/:id` (the endpoint authorized in this change's api-contract-freeze
delta), fetched on route entry — not by searching the polled sessions collection.
Resolution SHALL render exactly one of five states:

- **Loading** — while the per-id query has neither data nor a settled error: the app's
  brand loading treatment (never a flash of not-found).
- **Workspace** — the query returned the session and it is not archived.
- **Archived** — the query returned the session and it is archived: an interstitial,
  distinct from the live workspace, that identifies the session, offers the existing
  Restore action, and offers a way to leave. Restore success SHALL re-resolve the same
  URL to the workspace with no navigation.
- **Not-found** — the query settled with a `404`: a state that is identical for
  nonexistent sessions, deleted sessions, and sessions the user is not authorized to
  see (preserving the server's 404 masking; the page never confirms existence), with a
  way to leave.
- **Error** — the query settled with a non-404 failure (network error, 5xx): a
  retryable error state, visually and semantically distinct from not-found — a
  transient failure MUST NOT be presented as a missing session.

Resolution SHALL be latched: once the workspace has mounted for an id, background
changes to the sessions collection (poll updates, remote archive, active-show or
studio switches) SHALL NOT evict it; the resolution state changes only on route
change, on retry from the error state, or on Restore from the archived interstitial.

#### Scenario: Deep link to an active session
- **WHEN** `/sessions/<id>` resolves and the per-id query returns a non-archived
  session
- **THEN** the session workspace mounts for `<id>`

#### Scenario: Newly created session mounts without a not-found flash
- **WHEN** the user creates a session and the app navigates to its `/sessions/<id>`
- **THEN** the workspace mounts (after at most the loading treatment) — the not-found
  state never appears for the id the server just returned from creation

#### Scenario: Deep link to an archived session
- **WHEN** `/sessions/<id>` resolves and the query reports the session archived
- **THEN** the archived interstitial renders with a Restore action; activating Restore
  restores the session and the workspace mounts for `<id>` at the same URL

#### Scenario: Unknown, deleted, and unauthorized ids are indistinguishable
- **WHEN** `/sessions/<id>` resolves with a `404` — whether the id never existed, the
  session was deleted, or it belongs to a team the user is not a member of
- **THEN** one and the same not-found state renders, with no signal distinguishing the
  cases

#### Scenario: Transient failure is not "not found"
- **WHEN** `/sessions/<id>` is loaded and the per-id query fails with a network error
  or 5xx
- **THEN** the retryable error state renders — not the not-found state, not an
  indefinite loading treatment — and retrying re-issues the query

#### Scenario: Open workspace is not evicted by background changes
- **WHEN** the workspace is mounted for `/sessions/<id>` and the session disappears
  from the polled sessions list (archived remotely, or the user's active show/studio
  changed)
- **THEN** the mounted workspace stays until the user navigates; no resolution state
  replaces it in place

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

### Requirement: Legacy selection spine retired
The app SHALL NOT write `body.dataset.sessionId` and SHALL NOT define
`window.V3_selectSession` or `window.V3_closeSession`; in-app callers of those globals
SHALL use the router (or component props) instead. The imperative `syncChrome` DOM
toggling SHALL be removed, with both of its observable behaviors preserved by
route-driven rendering: the placeholder↔workspace visibility swap (the
`#v3-session-placeholder` / `#v3-session-grid` elements it toggles today) and the page
title reset to "AutoLogger" when no session is active. Test code SHALL observe the
active session through the URL.

#### Scenario: No dataset or window-global writes
- **WHEN** a session is selected or closed through any path (click, deep link,
  Back/Forward)
- **THEN** `document.body.dataset.sessionId` remains unset and
  `window.V3_selectSession` / `window.V3_closeSession` are undefined

#### Scenario: Workspace visibility swap survives the removal
- **WHEN** a session becomes active (by any path) or is closed
- **THEN** the workspace region is shown/hidden as today — the placeholder renders
  without a session, the session grid renders with one (the existing e2e assertions on
  these regions stay green)

#### Scenario: Studio-switch close path still works
- **WHEN** the settings modal's save handler detects an active-studio change (the sole
  caller of `window.V3_closeSession` today) while on `/sessions/<id>`
- **THEN** the app navigates to `/` with the same behavior the close-session control
  produces
</content>
