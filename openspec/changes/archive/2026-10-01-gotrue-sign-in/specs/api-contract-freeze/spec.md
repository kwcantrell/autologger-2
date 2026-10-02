## MODIFIED Requirements

### Requirement: OAuth callback failure redirect
`GET /auth/google/callback` SHALL respond to each enumerated failure class with `302`
and `Location: /?login_error=<code>` — no JSON body, no session cookie — where `<code>`
is the stable identifier for the failure class:

| Failure class (in evaluation order) | Code |
|---|---|
| `error` query parameter present (provider/user-cancel) | `provider_error` |
| OAuth not configured | `oauth_not_configured` |
| Missing `code` and/or `state` query parameters | `missing_params` |
| Unknown, reused, or expired CSRF state | `state_invalid` |
| Authorization-code token exchange failed | `exchange_failed` |
| Missing `id_token`, id_token verification failed (including a failed JWKS fetch), or missing `sub` claim | `token_invalid` |
| The verified id_token's `email_verified` claim is not `true`, or its email is empty | `email_unverified` |
| Supabase Auth unreachable, timed out, or refused the verified Google ID token; its user does not hold exactly one Google identity with the verified `sub`; or its user id differs from the account's id for this `sub`, or belongs to an account with another `sub` | `identity_unavailable` |

Frozen surface: the redirect mechanism (`302`, `Location: /?login_error=<code>`, empty
body, no `Set-Cookie`) and the meaning and stability of each code listed above — a code,
once emitted, MUST NOT change meaning. The code set is additive-open: new codes MAY be
added without a further authorizing delta, and clients MUST treat unrecognized codes as
a generic sign-in failure.

Boundary rule — the enumerated classes are the handler's **explicit branch returns**,
not a blanket conversion. In particular, `state_invalid` covers only the case where the
state lookup completes and reports the state absent; a thrown or failed store read is an
unexpected internal error and stays `500`. Any uncaught throw (KV, catalog, other
infrastructure) propagates to the app's ordinary `500` handler; the deliberate
caught-and-classified exceptions are the token exchange (→ `exchange_failed`),
id_token verification including its JWKS fetch (→ `token_invalid`), and the Supabase Auth
exchange (→ `identity_unavailable`). The handler MUST NOT
blanket-convert all errors to redirects.

Diagnostic detail (the former JSON `detail` strings, including operator guidance such as
`PUBLIC_BASE_URL` mismatch hints) SHALL NOT appear in any response; it is logged
server-side instead. Log content and format are operational behavior, not
client-observable frozen surface — the sanitization requirements for logged
request/provider-derived values are normative in the change's design and tests, not in
this contract.

The success path SHALL remain byte-identical in behavior: set the session cookie and
`302` to `/` with no query parameters. Before any account is read or created, the verified
Google ID token SHALL be exchanged with Supabase Auth, and the account's id SHALL be the
Supabase Auth user id.

#### Scenario: User cancels at Google
- **WHEN** Google redirects to `/auth/google/callback?error=access_denied`
- **THEN** the server responds `302` with `Location: /?login_error=provider_error`, sets
  no cookie, and the response carries no diagnostic detail (it is logged server-side)

#### Scenario: Missing OAuth query parameters
- **WHEN** the callback is requested with `code` but no `state` (or vice versa, or
  neither)
- **THEN** the server responds `302` with `Location: /?login_error=missing_params` and
  sets no cookie

#### Scenario: Expired or replayed CSRF state
- **WHEN** the callback receives a `state` and the state lookup completes, reporting it
  absent from the store (expired, already consumed, or forged)
- **THEN** the server responds `302` with `Location: /?login_error=state_invalid` and
  sets no cookie

#### Scenario: Token exchange fails
- **WHEN** the authorization-code exchange with Google returns a non-OK response
- **THEN** the server responds `302` with `Location: /?login_error=exchange_failed`,
  sets no cookie, and the response carries no diagnostic detail

#### Scenario: Callback hit while OAuth unconfigured
- **WHEN** `/auth/google/callback` is requested and OAuth is not configured
- **THEN** the server responds `302` with `Location: /?login_error=oauth_not_configured`
  (replacing the former `503` JSON body)

#### Scenario: Invalid token cluster maps to one code
- **WHEN** the token exchange succeeds but the response lacks an `id_token`, or the
  id_token fails verification, or its claims lack a `sub`
- **THEN** each of those three paths responds `302` with
  `Location: /?login_error=token_invalid` and sets no cookie

#### Scenario: Success path unchanged
- **WHEN** the callback completes successfully (valid state, exchange, id_token, and Supabase
  Auth exchange)
- **THEN** the server sets the session cookie and responds `302` with `Location: /`,
  exactly as before this change

#### Scenario: Unexpected internal error stays 500
- **WHEN** the callback fails outside the enumerated classes (e.g. a catalog or KV
  write throws after successful verification, or the CSRF-state read itself throws)
- **THEN** the response is the app's ordinary `500` error — no `login_error` redirect,
  no cookie

#### Scenario: Supabase Auth unavailable
- **WHEN** the Google ID token verifies, but Supabase Auth is unreachable, times out, or refuses
  the token
- **THEN** the server responds `302` with `Location: /?login_error=identity_unavailable`, sets no
  cookie, and creates or changes no account

#### Scenario: A new account takes the Supabase Auth id
- **WHEN** a Google account signs in for the first time and Supabase Auth returns user id `U`
- **THEN** the created account's id is `U`

#### Scenario: An account whose id differs from Supabase Auth's is refused
- **WHEN** an account exists for the Google subject with id `A`, and Supabase Auth returns a
  different user id `B`, or Supabase Auth returns id `A` for a Google subject whose account does
  not exist while account `A` belongs to another subject
- **THEN** the server responds `302` with `Location: /?login_error=identity_unavailable`, sets no
  cookie, and leaves every account unchanged

#### Scenario: An unverified Google email is refused
- **WHEN** the id_token verifies but its `email_verified` claim is absent or not `true`
- **THEN** the server responds `302` with `Location: /?login_error=email_unverified`, sets no
  cookie, does not call Supabase Auth, and creates or changes no account

### Requirement: Disabled-account sign-in redirect
When the OAuth callback completes token verification for a Google `sub` whose user
row exists but is disabled, the server SHALL respond `302` with
`Location: /?login_error=account_disabled`, set no cookie, and change no catalog account
(Supabase Auth may record the sign-in attempt in its own user record) —
replacing the current latent `500` (the new-user branch violating the unique
`google_sub` constraint). `account_disabled` joins the login-error code set under
its existing additive-open rule (clients treat unrecognized codes as a generic
sign-in failure); the enumerated failure-class table and the success path are
otherwise untouched.

#### Scenario: Disabled user signs in
- **WHEN** a user whose account is disabled completes the Google OAuth flow
- **THEN** the callback responds `302` to `/?login_error=account_disabled` with no
  cookie, and no catalog account is created or modified
