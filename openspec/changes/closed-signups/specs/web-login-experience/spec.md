## MODIFIED Requirements

### Requirement: Login-error rendering
When the index page renders the login view and the URL carries `?login_error=<code>`, the
view SHALL display a human-readable, retryable error message mapped from the code in
four groups: `state_invalid` → the sign-in attempt expired, try again; `provider_error`
→ sign-in was cancelled or refused; `signup_closed` → this Google account doesn't have access
yet, and the person who shared the link can set it up; every other code — including codes not
recognized by the client — → a generic sign-in-failed message. The mapping SHALL treat
unrecognized codes identically to the generic group (the server may add codes over time). The
message SHALL NOT disclose deployment configuration. The retry control SHALL start a fresh
sign-in via `/auth/google/start`.

#### Scenario: Expired OAuth state
- **WHEN** the login view renders with `?login_error=state_invalid`
- **THEN** it shows the attempt-expired message and offers a retry button that navigates
  to `/auth/google/start`

#### Scenario: Cancelled at the provider
- **WHEN** the login view renders with `?login_error=provider_error`
- **THEN** it shows the cancelled-or-refused message with the retry control

#### Scenario: Account not set up yet
- **WHEN** the login view renders with `?login_error=signup_closed`
- **THEN** it shows the no-access-yet message with the retry control, and the message names no
  setting or environment

#### Scenario: Generic and unknown codes
- **WHEN** the login view renders with `?login_error=exchange_failed` (or any code the
  client does not recognize, e.g. `some_future_code`)
- **THEN** it shows the generic sign-in-failed message with the retry control

#### Scenario: Error param while authenticated
- **WHEN** `/` loads with `?login_error=<code>` but the profile reports
  `auth.logged_in: true`
- **THEN** the app shell renders normally and the stale error param is ignored
