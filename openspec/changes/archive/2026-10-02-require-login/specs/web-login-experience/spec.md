## REMOVED Requirements

### Requirement: Login-page render gate

**Reason**: The gate keyed on `auth.oauth_configured === true` and kept a dev anonymous mode
that rendered the app shell to signed-out visitors. Login is now always required and the
server refuses to boot without a Google client, so the gate keys on `auth.logged_in` alone and
there is no anonymous mode. Restated under "Login view renders whenever signed out".

**Migration**: None for users on a running deployment (`oauth_configured` is always `true`
there). Dev users sign in with Google like every other stack.

## ADDED Requirements

### Requirement: Login view renders whenever signed out
Every route of the web app SHALL render a dedicated full-screen login view instead of
the app shell when, and only when, the `GET /api/profile` payload reports
`auth.logged_in === false` (`auth.oauth_configured` is not consulted) — the gate is a render
switch mounted above the client-side router, so it covers `/`, `/sessions/:id`, and any
future route without per-route wiring; there is no `/login` route and the address bar
is not rewritten. While the profile query is in flight the page SHALL render a neutral
loading state using the app's existing brand loading treatment (neither the app shell
nor the login view, and never a bare blank screen). While the login view or loading
state is shown, the page SHALL NOT issue authenticated `/api/*` requests or WebSocket
connections — only `GET /api/profile` and static assets.

#### Scenario: Signed-out visitor sees the login view
- **WHEN** the app loads at any route and `/api/profile` returns
  `auth: { oauth_configured: true, logged_in: false }`
- **THEN** the full-screen login view renders — AutoLogger branding, a Google sign-in
  button — the app shell (rail, workspace) does not mount, and no authenticated `/api/*`
  or WebSocket traffic is issued

#### Scenario: Signed-out deep link keeps its URL
- **WHEN** a signed-out visitor loads `/sessions/<id>`
- **THEN** the login view renders with the address bar still showing `/sessions/<id>` —
  no redirect to `/`, and no session data is fetched

#### Scenario: The gate ignores oauth_configured
- **WHEN** the app loads and `/api/profile` returns
  `auth: { oauth_configured: false, logged_in: false }` (no running server sends this)
- **THEN** the login view renders; there is no anonymous mode that shows the app shell

#### Scenario: Authenticated visitor
- **WHEN** the app loads at any route and `/api/profile` returns `auth.logged_in: true`
- **THEN** the app shell renders and the login view never appears

## MODIFIED Requirements

### Requirement: Mid-session sign-out transition
When the app shell is mounted and a subsequent successful profile refetch reports
`auth.logged_in === false` (login session expired or revoked), the page SHALL transition to the login view. Loss of unsaved in-page UI
state on this transition is accepted. This transition SHALL fire only on a successful
refetch reporting signed-out — never on a refetch error.

#### Scenario: Session revoked while the app is open
- **WHEN** the shell is mounted and the next profile refetch returns
  `auth: { oauth_configured: true, logged_in: false }`
- **THEN** the login view replaces the shell, giving the signed-out user a sign-in
  control

### Requirement: Post-login deep-link return
When any of the login view's sign-in affordances (Google sign-in, create-account, or
the error-state retry) is activated while the current location matches a stashable
router route (`/sessions/:id` or `/teams`), the client SHALL stash the current
path-plus-query in per-tab browser
storage (sessionStorage) before the navigation to `/auth/google/start` proceeds; when
the current location does not match a stashable route (e.g. `/` or
`/?login_error=<code>`), the affordance SHALL leave any existing stash untouched — so
a retry from the error landing page keeps the original deep link. The affordances
remain plain links to `/auth/google/start` (their `href` semantics are unchanged); the
stash write rides the activation synchronously. When the app subsequently renders with
`auth.logged_in === true` (and only then) and a stashed path is present, it SHALL validate the stash and, if
valid, replace-navigate to it (no extra history entry); the stash SHALL be cleared on
every consume path — valid, invalid, or navigation failure — so it is single-use. The
OAuth callback contract is untouched — success remains `302` to `/` and failures
remain `302` to `/?login_error=<code>`; the return is entirely client-side.

Validation SHALL accept only same-origin router-known paths, using URL parsing rather
than string prefix checks: the value MUST be a string starting with exactly one `/`
(rejecting `//host` and `/\host` protocol-relative forms), MUST contain no `\` and no
ASCII control characters, MUST resolve against the current origin to a URL whose
origin equals the current origin, and its pathname MUST match a route the client
router owns (`/sessions/:id` or `/teams`, sourced from the shared route-definition
module rather than a second regex) — same-origin pages outside the router, such as
`/admin/users`, are not valid return targets. Any invalid, absent, or non-string stash
SHALL be discarded and the user stays on `/`. The stashed value SHALL never be sent to
the server or embedded in the OAuth round-trip.

#### Scenario: Deep link survives the sign-in round-trip
- **WHEN** a signed-out visitor lands on `/sessions/<id>`, activates Google sign-in, and
  completes the OAuth flow (callback 302s to `/` and the profile now reports
  `logged_in: true`)
- **THEN** the app replace-navigates to `/sessions/<id>`, the stash is cleared, and
  pressing Back does not bounce through an intermediate `/` entry

#### Scenario: Teams deep link survives the sign-in round-trip
- **WHEN** a signed-out visitor lands on `/teams`, activates Google sign-in, and
  completes the OAuth flow successfully
- **THEN** the app replace-navigates to `/teams` and the stash is cleared

#### Scenario: Malicious or out-of-router stash is discarded
- **WHEN** the stash contains `//evil.com`, `/\evil.com`, `https://evil.com/x`, a value
  with an embedded control character, any value that does not parse to the current
  origin, or a same-origin path outside the router such as `/admin/users`
- **THEN** no navigation to it occurs, the stash is cleared, and the user remains on `/`

#### Scenario: Failed attempt keeps the return path
- **WHEN** the visitor stashed `/sessions/<id>`, the callback fails
  (`302 /?login_error=<code>`), and the visitor retries sign-in from the error state
  and succeeds
- **THEN** the retry activation does not overwrite the stash (the error page's location
  is not a stashable route), and the app still returns to `/sessions/<id>` after
  the successful attempt

#### Scenario: No stash means no navigation
- **WHEN** the app boots with `auth.logged_in: true` and no stash is present (e.g. an
  ordinary sign-in from `/`, or a returning session cookie)
- **THEN** the app renders the route in the address bar as-is, with no stash-driven
  navigation
