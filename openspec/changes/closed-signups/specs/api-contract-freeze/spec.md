## ADDED Requirements

### Requirement: Closed sign-up redirect
While sign-ups are closed, the OAuth callback SHALL create a catalog account for a Google subject
that has none only when the verified token email is the bootstrap owner's (matched under the
bootstrap owner's exact-ASCII rule) or holds a usable approval in `catalog.account_approvals`.
An approval is usable for 7 days from its `approved_at_utc`, read against the server's Clock, and
is consumed in the transaction that creates the account; an account that is not created consumes
nothing. A token email with any character above U+007F is never approved.

The check SHALL run after the verified-email check and before the Supabase Auth exchange, and
SHALL only read: the account by the verified `sub` (any state) and, when there is none, the
approval by email. When the subject has no account and the email is neither the bootstrap owner's
nor approved, the server SHALL respond `302` with `Location: /?login_error=signup_closed`, set no
cookie, not call Supabase Auth, and create or change no catalog account. A subject that already
has an account, enabled or disabled, is handled exactly as before. When the approval is gone by
the time the account would be created (revoked, expired, or consumed by a concurrent first
sign-in of the same subject), the callback SHALL look the subject up once more and continue as an
existing account if one now exists, else respond `signup_closed`.

Sign-ups are closed when the `SIGNUPS` setting (trimmed, `A`-`Z` folded) is `closed`, or when it
is unset or blank and `AUTOLOGGER_STACK` is not `dev`; `open` opens them. Any other value SHALL
refuse boot with a message naming `SIGNUPS` and its two values and not printing the value, and
the compose wrapper SHALL refuse such a KV secret the same way before compose starts. The server
SHALL log the effective mode once at boot (`sign-ups: open` or `sign-ups: closed`). While sign-ups
are open, the callback SHALL behave exactly as before this change.

`signup_closed` joins the login-error code set under its existing additive-open rule (clients
treat unrecognized codes as a generic sign-in failure).

#### Scenario: A new, unapproved email is refused while closed
- **WHEN** sign-ups are closed and a Google account with no catalog account and an unapproved
  email completes the OAuth flow
- **THEN** the callback responds `302` to `/?login_error=signup_closed` with no cookie, Supabase
  Auth is not called, and no catalog account, membership or invite changes

#### Scenario: An approved email gets its account
- **WHEN** sign-ups are closed, `someone@example.com` was approved a day ago, and a new Google
  account with the verified email `Someone@Example.com` completes the OAuth flow
- **THEN** its account is created as on an open sign-up (session cookie, `302` to `/`, pending
  invites materialized), and the approval row is gone

#### Scenario: An expired approval is refused
- **WHEN** sign-ups are closed and the email's approval is 8 days old
- **THEN** the callback responds `302` to `/?login_error=signup_closed`, Supabase Auth is not
  called, and the approval row stays

#### Scenario: Revoked between the check and the account
- **WHEN** sign-ups are closed and the approval is revoked after the check passed but before the
  account is created
- **THEN** no account is created and the callback responds `302` to `/?login_error=signup_closed`

#### Scenario: The bootstrap owner always signs in
- **WHEN** sign-ups are closed, nothing is approved, and the bootstrap owner's Google account
  signs in for the first time
- **THEN** its account is created and the bootstrap claim runs as before

#### Scenario: Existing accounts are unaffected
- **WHEN** sign-ups are closed and a Google subject with an enabled account signs in
- **THEN** the sign-in succeeds as before; a disabled account still gets `account_disabled`

#### Scenario: A non-ASCII email is never approved
- **WHEN** sign-ups are closed and a new Google account's verified email contains a character
  above U+007F
- **THEN** the callback responds `302` to `/?login_error=signup_closed` and reads no approval

#### Scenario: Open sign-ups are unchanged
- **WHEN** sign-ups are open and a new Google account completes the OAuth flow
- **THEN** its account is created exactly as before this change, whether or not its email is
  approved, and an approval row for that email is left in place

#### Scenario: A mistyped setting refuses to start
- **WHEN** the KV secret holds `SIGNUPS=opne`
- **THEN** the compose wrapper refuses before compose starts, and a server started with it refuses
  to boot; both messages name `SIGNUPS` and neither contains `opne`

#### Scenario: The default follows the stack
- **WHEN** `SIGNUPS` is unset and the stack is `dev`, `stage` or `prod`
- **THEN** sign-ups are open on `dev` and closed on `stage` and `prod`, and the boot log says which

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
| Sign-ups are closed, no account exists for the verified `sub`, and the email is neither the bootstrap owner's nor approved (api-contract-freeze "Closed sign-up redirect"); checked before the Supabase Auth exchange | `signup_closed` |
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
`302` to `/` with no query parameters. Before any account is created or changed, the verified
Google ID token SHALL be exchanged with Supabase Auth, and the account's id SHALL be the
Supabase Auth user id. While sign-ups are closed, the closed sign-up check (api-contract-freeze
"Closed sign-up redirect") SHALL run before the exchange; it only reads (the account by the
verified `sub`, the approval by email), so a refused sign-in never reaches Supabase Auth.

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

### Requirement: Concurrent first sign-in succeeds
Two OAuth callbacks for the same Google subject, carrying different valid states, that both find
no existing user and may both create an account (sign-ups open, the email approved, or the
bootstrap owner's; api-contract-freeze "Closed sign-up redirect") SHALL both complete sign-in to
the one user created, and an approval SHALL be consumed once. While sign-ups are closed and the
email is neither approved nor the bootstrap owner's, both SHALL get `signup_closed`. Neither SHALL get a `500`.
The second follows the existing-user path, including its disabled-account redirect. This replaces
the latent `500` that the unique Google-subject constraint gave the loser.

This narrows "Unexpected internal error stays 500" only for this race: a duplicate first
sign-in is an expected outcome, not an internal error. Any other catalog failure in the callback
still gives `500`.

#### Scenario: Two tabs sign in for the first time
- **WHEN** two first sign-in callbacks for one Google subject run at the same time with different valid states
- **THEN** both redirect to `/` with a session cookie, and exactly one user exists for that subject

#### Scenario: Two tabs of an approved email sign in for the first time while closed
- **WHEN** sign-ups are closed, the email is approved, and two first sign-in callbacks for one
  Google subject run at the same time
- **THEN** both redirect to `/` with a session cookie, exactly one user exists for that subject,
  and the approval row is gone
