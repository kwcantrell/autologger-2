# web-session-routing (delta)

<!-- Gate override of D10 (2026-07-21): the no-session home view becomes a dedicated home
     route component instead of the workspace's placeholder region, so this capability's
     "Legacy selection spine retired" requirement — which pins the placeholder↔grid swap —
     is modified. Deep-link resolution, latching, navigation-funnel, and departure-watcher
     requirements are untouched. -->

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

#### Scenario: No dataset or window-global writes
- **WHEN** a session is selected or closed through any path (click, deep link,
  Back/Forward)
- **THEN** `document.body.dataset.sessionId` remains unset and
  `window.V3_selectSession` / `window.V3_closeSession` are undefined

#### Scenario: Home/workspace swap is route-driven
- **WHEN** a session becomes active (by any path) or is closed
- **THEN** the dedicated home component renders without a session and the session grid
  renders with one — mount-driven by the route, with the e2e assertions updated from the
  retired placeholder element to the home component's region in this same change

#### Scenario: Studio-switch close path still works
- **WHEN** the settings modal's save handler detects an active-studio change (the sole
  caller of `window.V3_closeSession` today) while on `/sessions/<id>`
- **THEN** the app navigates to `/` with the same behavior the close-session control
  produces
