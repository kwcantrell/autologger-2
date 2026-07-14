# api-contract-freeze

## Purpose

The server's externally observable HTTP/WS contract is frozen. This capability replaces
the retired "Python parity" anchor. The freeze exists because real consumers depend on the
surface — the in-repo `web/` frontend, the separately-deployed Bitfocus Companion module,
the `e2e/` Playwright suite, and external API clients (bearer-token scripts, stale
Companion installs) — but consumers are the *reason* for the freeze, not its measuring
stick. The frozen surface is the full published surface (the README endpoint table is the
normative route inventory), independent of what any consumer currently reads.

## Requirements

### Requirement: Frozen HTTP/WS contract
The server SHALL preserve its entire published externally observable contract, including
but not limited to: the endpoint inventory (routes and methods; the README endpoint table
is the normative list), JSON response shapes, status codes, non-JSON response bodies
(CSV/JSONL exports), header and range-request semantics (e.g. `Content-Range` on audio
download), and WebSocket message shapes *and emission semantics* (which events fire and
when, not only their payloads). New API surface MUST NOT be added, and existing observable
behavior MUST NOT change, without an OpenSpec change whose delta spec authorizes it.

Two explicit non-loopholes:

- Absence of a current in-repo caller does NOT unfreeze any endpoint or field — surface
  kept for stale or external clients (e.g. `/api/companion/commands/wait`) is as frozen
  as surface `web/` reads on every render.
- Updating in-repo consumers in the same change does NOT exempt the server delta —
  deployed Companion module versions lag the repo, so "both sides moved together" still
  breaks fielded installs.

#### Scenario: Change proposal states contract impact
- **WHEN** a change proposal is drafted for this repo
- **THEN** it explicitly states the observable HTTP/WS contract impact

#### Scenario: Contract-affecting diff carries an authorizing delta spec
- **WHEN** a diff alters any published observable behavior (route, method, status code,
  response body shape or format, header semantics, or WS message shape or emission)
- **THEN** a delta spec authorizing that exact change exists under
  `openspec/changes/<name>/specs/`; a diff without one is a contract violation

#### Scenario: Unconsumed surface stays frozen
- **WHEN** an endpoint or response field has no current caller in `web/`, `companion/`,
  or `e2e/`
- **THEN** it remains part of the frozen contract, and removing or altering it still
  requires an authorizing delta spec

#### Scenario: Consumer co-mutation is not an exemption
- **WHEN** a change edits an observable server behavior and updates the in-repo consumers
  to match within the same change
- **THEN** the server delta still requires an authorizing delta spec

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
caught-and-classified exceptions are the token exchange (→ `exchange_failed`) and
id_token verification including its JWKS fetch (→ `token_invalid`). The handler MUST NOT
blanket-convert all errors to redirects.

Diagnostic detail (the former JSON `detail` strings, including operator guidance such as
`PUBLIC_BASE_URL` mismatch hints) SHALL NOT appear in any response; it is logged
server-side instead. Log content and format are operational behavior, not
client-observable frozen surface — the sanitization requirements for logged
request/provider-derived values are normative in the change's design and tests, not in
this contract.

The success path SHALL remain byte-identical in behavior: set the session cookie and
`302` to `/` with no query parameters.

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
- **WHEN** the callback completes successfully (valid state, exchange, and id_token)
- **THEN** the server sets the session cookie and responds `302` with `Location: /`,
  exactly as before this change

#### Scenario: Unexpected internal error stays 500
- **WHEN** the callback fails outside the enumerated classes (e.g. a catalog or KV
  write throws after successful verification, or the CSRF-state read itself throws)
- **THEN** the response is the app's ordinary `500` error — no `login_error` redirect,
  no cookie
