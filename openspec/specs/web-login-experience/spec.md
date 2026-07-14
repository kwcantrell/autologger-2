# web-login-experience

## Purpose

The frontend's unauthenticated experience on `REQUIRE_LOGIN=1` deployments with Google
OAuth configured: a branded full-screen login view that replaces the app shell for
anonymous visitors, driven by the existing anonymous-allowed `GET /api/profile` payload
(`auth.oauth_configured`, `auth.logged_in`) rather than any new API surface. Covers the
render gate (including loading and profile-fetch-error states), the transition into and
out of the login view as auth state changes, Google sign-in entry via the existing
`GET /auth/google/start` route, and rendering of `?login_error=<code>` failures from the
OAuth callback redirect. Dev anonymous mode (`REQUIRE_LOGIN=0`, no OAuth configured)
never triggers this gate and is unaffected.

## Requirements

### Requirement: Login-page render gate
The index page (`/`) SHALL render a dedicated full-screen login view instead of the app
shell when, and only when, the `GET /api/profile` payload reports
`auth.oauth_configured === true` and `auth.logged_in === false`. While the profile query
is in flight the page SHALL render a neutral loading state using the app's existing
brand loading treatment (neither the app shell nor the login view, and never a bare
blank screen). While the login view or loading state is shown, the page SHALL NOT issue
authenticated `/api/*` requests or WebSocket connections — only `GET /api/profile` and
static assets.

#### Scenario: Anonymous visitor on an OAuth-configured deployment
- **WHEN** the index page loads and `/api/profile` returns
  `auth: { oauth_configured: true, logged_in: false }`
- **THEN** the full-screen login view renders — AutoLogger branding, a Google sign-in
  button — the app shell (rail, workspace) does not mount, and no authenticated `/api/*`
  or WebSocket traffic is issued

#### Scenario: Dev anonymous mode is unaffected
- **WHEN** the index page loads and `/api/profile` returns
  `auth: { oauth_configured: false, logged_in: false }` (`REQUIRE_LOGIN=0`, no OAuth
  config)
- **THEN** the app shell renders exactly as before this change, and the login view never
  appears

#### Scenario: Authenticated visitor
- **WHEN** the index page loads and `/api/profile` returns `auth.logged_in: true`
- **THEN** the app shell renders and the login view never appears

### Requirement: Profile-fetch failure state
When the `GET /api/profile` query fails with **no profile data available** (initial
load: network error or non-2xx after the query layer's retry), the index page SHALL
render a retryable error state — not the app shell, not the login view, and not an
indefinite loading state — and SHALL NOT issue authenticated `/api/*` requests or
WebSocket connections. The retry control SHALL re-attempt the profile fetch, SHALL be
disabled while a retry is in flight (no concurrent or queued fetches), and retries
SHALL NOT fire automatically in an unbounded loop. A **background refetch failure while
prior profile data exists** SHALL NOT trigger this state — the page keeps rendering
from the existing data.

#### Scenario: Server unreachable at boot
- **WHEN** the index page loads and the profile request fails (e.g. server down or 500)
- **THEN** the page shows an error state with a retry control (disabled while a retry
  is in flight), issues no authenticated traffic, and retrying re-fetches the profile

#### Scenario: Background refetch failure with data present
- **WHEN** the app shell is rendered and a later profile refetch fails
- **THEN** the page keeps rendering the shell from existing data; the error state does
  not appear

### Requirement: Mid-session sign-out transition
When the app shell is mounted and a subsequent successful profile refetch reports
`auth.logged_in === false` with `auth.oauth_configured === true` (login session expired
or revoked), the page SHALL transition to the login view. Loss of unsaved in-page UI
state on this transition is accepted. This transition SHALL fire only on a successful
refetch reporting signed-out — never on a refetch error.

#### Scenario: Session revoked while the app is open
- **WHEN** the shell is mounted and the next profile refetch returns
  `auth: { oauth_configured: true, logged_in: false }`
- **THEN** the login view replaces the shell, giving the signed-out user a sign-in
  control

### Requirement: Google sign-in entry
The login view SHALL provide a Google sign-in control and a distinct create-account
affordance. Both SHALL navigate the browser to the existing `GET /auth/google/start`
route — first-time Google sign-in creates the account automatically (the callback's
new-user branch), and no separate registration flow exists. The create-account
affordance's copy SHALL reflect that (account creation happens via Google sign-in) and
SHALL NOT promise a separate registration form. No new server surface is used.

#### Scenario: Starting sign-in
- **WHEN** the visitor activates the Google sign-in control
- **THEN** the browser navigates to `/auth/google/start` (which 302s to Google)

#### Scenario: Creating an account
- **WHEN** a first-time visitor activates the create-account affordance
- **THEN** the browser navigates to `/auth/google/start`, and completing the Google flow
  creates their account and signs them in (single flow, no separate registration step)

### Requirement: Login-error rendering
When the index page renders the login view and the URL carries `?login_error=<code>`, the
view SHALL display a human-readable, retryable error message mapped from the code in
three groups: `state_invalid` → the sign-in attempt expired, try again; `provider_error`
→ sign-in was cancelled or refused; every other code — including codes not recognized by
the client — → a generic sign-in-failed message. The mapping SHALL treat unrecognized
codes identically to the generic group (the server may add codes over time). The message
SHALL NOT disclose deployment configuration. The retry control SHALL start a fresh
sign-in via `/auth/google/start`.

#### Scenario: Expired OAuth state
- **WHEN** the login view renders with `?login_error=state_invalid`
- **THEN** it shows the attempt-expired message and offers a retry button that navigates
  to `/auth/google/start`

#### Scenario: Cancelled at the provider
- **WHEN** the login view renders with `?login_error=provider_error`
- **THEN** it shows the cancelled-or-refused message with the retry control

#### Scenario: Generic and unknown codes
- **WHEN** the login view renders with `?login_error=exchange_failed` (or any code the
  client does not recognize, e.g. `some_future_code`)
- **THEN** it shows the generic sign-in-failed message with the retry control

#### Scenario: Error param while authenticated
- **WHEN** `/` loads with `?login_error=<code>` but the profile reports
  `auth.logged_in: true`
- **THEN** the app shell renders normally and the stale error param is ignored
