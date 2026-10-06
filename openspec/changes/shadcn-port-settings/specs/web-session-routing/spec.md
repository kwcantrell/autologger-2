# Spec Delta

## MODIFIED Requirements

### Requirement: Legacy selection spine retired
The app SHALL NOT write `body.dataset.sessionId` and SHALL NOT define
`window.V3_selectSession` or `window.V3_closeSession`; in-app callers of those globals
SHALL use the router (or component props) instead. The imperative `syncChrome` DOM
toggling SHALL be removed, with both of its observable behaviors preserved by
route-driven rendering: without an active session the app renders the dedicated home
route component in the workspace's place (a stable, e2e-observable region of its own —
the legacy `#v3-session-placeholder` element and its copy are retired with it); with an
active session it renders the session workspace (`#v3-session-grid`); and the page title
resets to "AutoLogger" when no session is active. Test code SHALL observe the active
session through the URL.

The swap remains mount-driven by the route, but it is **no longer instantaneous**: with
the workspace behind session resolution and a lazy chunk, there is an interstitial window
in which the route is `/sessions/<id>` and `#v3-session-grid` is not yet in the DOM —
the loading frame, the chunk fallback, or (on failure) the boundary's retry card is
rendered in its place. An observer that treats "route says session" as implying "session
grid is present" SHALL be understood as asserting the settled state, not every commit in
between. The reverse direction is unchanged and immediate: leaving the session route
unmounts the grid in that commit.

#### Scenario: No dataset or window-global writes
- **WHEN** a session is selected or closed through any path (click, deep link,
  Back/Forward)
- **THEN** `document.body.dataset.sessionId` remains unset and
  `window.V3_selectSession` / `window.V3_closeSession` are undefined

#### Scenario: Home/workspace swap is route-driven
- **WHEN** a session becomes active (by any path) or is closed
- **THEN** the dedicated home component renders without a session and the session grid
  renders with one once resolution and the workspace chunk have settled — mount-driven
  by the route, with an interstitial window in which neither the home component nor the
  session grid is present because a route-state frame occupies that position instead

#### Scenario: Studio-switch close path still works
- **WHEN** the settings modal's save handler detects an active-studio change while on
  `/sessions/<id>`
- **THEN** the app navigates to `/` with the same behavior the close-session control
  produces
