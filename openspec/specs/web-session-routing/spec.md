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
`/sessions/:id` (the session workspace for `:id`), and `/teams` (the sessions home view with the Settings view opened on its Members section; no
session selected). Selecting a session SHALL push a
history entry for `/sessions/:id`; selecting the session that is already active SHALL
NOT push a duplicate entry (no-op or replace); closing the active session SHALL
navigate to `/`; browser Back/Forward SHALL drive the same state transitions as in-app
selection and close. Creating a session SHALL navigate to its `/sessions/:id` the same
way selection does. Navigating to `/teams` SHALL push a history entry and leaves any
active session (the departure semantics of the transport-stop requirement apply
unchanged). The workspace's session id SHALL come from the route parameter —
there SHALL be no parallel component-state copy of the active session id that can
disagree with the URL. The router-known route table SHALL remain defined in the
shared route-definition module, which its runtime consumers import: the post-login
stash write, the return-path validator, and the server-side shell router (the Next
catch-all's segment-shape validation). The module holds two predicates with
deliberately different domains — the deep-link predicate (`isRouterKnownPathname`,
excludes `/`) consumed by the stash write and return-path validator, and the shell
segment-shape helper (includes `/`) consumed by the catch-all — and they SHALL NOT be
merged into one predicate. `AppShell`'s wouter patterns remain the one
sanctioned mirror that cannot mechanically share the definition — extending it in the
same change that extends the module is the requirement. (The former vite dev-middleware
matcher and hand-written server serve block no longer exist; the shell router consumes
the module directly instead of mirroring it.)

Route matching stays eager, but the **view** a matched route mounts may be code-split. `/teams`
has no chunk of its own: matching it renders the home view and sets the shell's Settings state to
the Members section, so the Settings view's overlay boundary (web-frontend-platform "The client
island is route-split behind recoverable boundaries") is what loads — with that boundary's `null`
fallback while in flight and its dismissible failure card over the intact home view on failure.
Route identity, history behaviour, and the route table are unaffected.

(Non-normative: a path matching no route 404s at the HTML layer under the shell
router; the previously reachable raw built-asset path, e.g.
`/src/pages/index/index.html`, no longer exists as a served asset.)

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
- **THEN** the home view renders at that URL with the Settings view open on Members once the
  Settings chunk has loaded, and browser Back returns to the previous view

#### Scenario: The teams route announces its own chunk wait and failure
- **WHEN** `/teams` is matched while the Settings chunk is still in flight, and separately when
  that chunk fetch fails
- **THEN** the pending case shows the home view with nothing overlaid (the overlay boundary's
  `null` fallback), and the failed case shows the overlay variant's dismissible failure card over
  the home view, with the rest of the app shell still mounted

#### Scenario: Route table extension is single-sourced
- **WHEN** a future change adds a router-known route
- **THEN** it extends the shared route-definition module (predicate and segment shape)
  and `AppShell`'s wouter patterns in the same change, and no other copy of the route
  table exists to update

### Requirement: Deep-link resolution states
The client SHALL resolve the `:id` route parameter with a per-id query against
`GET /api/sessions/:id` (the endpoint specified by the `api-contract-freeze` capability),
fetched on route entry — not by searching the polled sessions collection.
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

Resolution is no longer the only gate in front of the workspace. The workspace is a
lazy chunk, so **the Workspace outcome above expands into three rendered states** at a
chunk boundary that sits below resolution:

- **Workspace-chunk pending** — the chunk is in flight. Its `<Suspense>` fallback SHALL
  be the same brand loading component the resolving branch renders, with the same
  markup, label, and DOM id, so resolution → chunk load is one continuous frame that
  adds no second visual transition and no layout shift.
- **Workspace-chunk failed** — the chunk import rejected, and the boundary's failure
  surface renders in the route's place while the rest of the app shell stays mounted and
  interactive. What that surface offers, and what retrying it does, are **not specified
  here**: the boundary's behaviour — the fresh `lazy()` instance a retry builds, the
  attempt counter, and the reload-only treatment of a non-chunk render error — is owned
  by the `web-frontend-platform` requirement **`The client island is route-split behind
  recoverable boundaries`**. This capability owns only that the failure is one of the
  states this route can render, and that it renders in place of the workspace rather
  than taking the route down.
- **Workspace** — the chunk resolved and the workspace is mounted.

The workspace chunk SHALL be sequenced **behind** session resolution — an arbitrary id
must never drive the workspace's per-session fetches — and, because that ordering would
otherwise serialize two round trips behind one loading frame, a **parallel warm-up
import SHALL be fired on route entry** so the download overlaps resolution rather than
following it. The warm-up SHALL be side-effect-free with respect to the UI: it mounts
nothing, its rejection is swallowed (a genuinely broken chunk surfaces through the
boundary when the render path needs it), and an id that resolves to not-found or
archived warms a chunk it never mounts — accepted as bytes on an uncommon path in
exchange for removing a serial round trip from the common one.

All of these states SHALL render inside the shared page frame, which reserves the
mounted workspace's height (`min-h-[calc(100vh-2.2rem)]`, relaxed to `max-md:min-h-0`,
mirroring the workspace root element). Swapping any resolution state — or the chunk
fallback — out for the mounted workspace SHALL therefore shift nothing. This reservation
is what took the measured session-page CLS from 0.123 to 0.001.

Resolution SHALL be latched: once the workspace has mounted for an id, background
changes to the sessions collection (poll updates, remote archive, active-show or
studio switches) SHALL NOT evict it; the resolution state changes only on route
change, on retry from the error state, on Restore from the archived interstitial, or on
a retry of a failed workspace chunk.

#### Scenario: Deep link to an active session
- **WHEN** `/sessions/<id>` resolves and the per-id query returns a non-archived
  session
- **THEN** the session workspace mounts for `<id>` once its chunk has loaded

#### Scenario: The chunk wait is visually continuous with resolution
- **WHEN** a cold deep link resolves to a live session and the workspace chunk is still
  in flight
- **THEN** the same brand loading frame that was rendering during resolution continues
  to render — same component, same label, same DOM id — and no layout shift occurs when
  the workspace finally mounts in its place

#### Scenario: The workspace download overlaps resolution
- **WHEN** the app enters `/sessions/<id>` with a non-empty id
- **THEN** the workspace module import starts immediately, in parallel with the
  resolution request, and the resolution-gated lazy mount resolves off that same
  in-flight load rather than issuing a second one

#### Scenario: A failed workspace chunk is one of the route's rendered states
- **WHEN** the workspace chunk fetch fails (for example, a redeploy rewrote the
  content-hashed URL under an open tab)
- **THEN** the boundary's failure surface occupies the route's frame in place of the
  workspace, with the rest of the shell still mounted and interactive — its recovery
  behaviour being whatever `web-frontend-platform` requires of that boundary

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
The app SHALL NOT write `body.dataset.sessionId` and SHALL NOT define `window.V3_selectSession` or `window.V3_closeSession`. In-app callers of those globals SHALL use the router (or component props) instead.

The imperative `syncChrome` DOM toggling SHALL be removed, with both of its observable behaviors preserved by route-driven rendering:
- **Without an active session,** the app renders the dedicated home route component in the workspace's place. That component is a stable, e2e-observable region of its own; the legacy `#v3-session-placeholder` element and its copy are retired with it.
- **With an active session,** it renders the session workspace (`#v3-session-grid`).

The page title resets to "AutoLogger" when no session is active. Test code SHALL observe the active session through the URL.

The swap remains mount-driven by the route, but it is **no longer instantaneous**. With the workspace behind session resolution and a lazy chunk, there is an interstitial window in which the route is `/sessions/<id>` and `#v3-session-grid` is not yet in the DOM. In that window the loading frame, the chunk fallback, or (on failure) the boundary's retry card is rendered in its place. An observer that treats "route says session" as implying "session grid is present" SHALL be understood as asserting the settled state, not every commit in between. The reverse direction is unchanged and immediate: leaving the session route unmounts the grid in that commit.

#### Scenario: No dataset or window-global writes
- **WHEN** a session is selected or closed through any path (click, deep link, Back/Forward)
- **THEN** `document.body.dataset.sessionId` remains unset and `window.V3_selectSession` / `window.V3_closeSession` are undefined

#### Scenario: Home/workspace swap is route-driven
- **WHEN** a session becomes active (by any path) or is closed
- **THEN** the dedicated home component renders without a session and the session grid renders with one once resolution and the workspace chunk have settled. This is mount-driven by the route, with an interstitial window in which neither the home component nor the session grid is present because a route-state frame occupies that position instead.

#### Scenario: Studio-switch close path still works
- **WHEN** the active team changes (through the top bar's team menu) while on `/sessions/<id>`
- **THEN** the app navigates to `/` with the same behavior the close-session control produces
