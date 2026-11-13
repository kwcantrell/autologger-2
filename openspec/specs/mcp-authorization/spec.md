# mcp-authorization Specification

## Purpose
Lets a Claude client connect to AutoLogger as a custom connector through AutoLogger's own OAuth 2.1 authorization server, behind `CUSTOM_DASHBOARDS_ENABLED` (ADR 0035 decision 5; design `docs/design/custom-session-dashboards.md` section 4). This capability covers discovery, dynamic client registration, the OAuth storage and its cleanup (J2), and authorization with consent, the token endpoint and revocation (J3). Connected apps are added by a later job (J4).

## Requirements

### Requirement: The OAuth server exists only with the flag on
Every route of this capability SHALL answer as specified only while `CUSTOM_DASHBOARDS_ENABLED` is
on (`1`, `true` or `yes`, case-insensitively after trimming). The flag SHALL be read per request.
With it off, each route SHALL answer exactly what the same request answers with no such route
mounted: a `GET` or `HEAD` SHALL reach the frontend bridge (the Next not-found document in the
single-process server, Hono's `404` in the API-only `api` image), and any other method SHALL get
Hono's `404`. With it off, no response SHALL carry a header this capability adds, nothing SHALL be
written to the OAuth tables, and the OAuth sweeper SHALL NOT run.

#### Scenario: Flag off, the new paths answer as unmounted paths
- **WHEN** the flag is unset, `0` or `off`, and `GET`, `HEAD`, `POST`, `PUT`, `DELETE` and
  `OPTIONS` are sent to `/.well-known/oauth-protected-resource`,
  `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`,
  `/oauth/register`, `/oauth/authorize`, `/oauth/authorize/resume`, `/oauth/token` and
  `/oauth/revoke`, with and without a session cookie
- **THEN** the `GET` and `HEAD` requests reach the frontend bridge, each answer is byte for byte
  the answer of an unmounted path such as `/oauth/not-a-route`, and no client, rate window or KV
  entry is stored

### Requirement: Discovery metadata
The issuer SHALL be `PUBLIC_BASE_URL` without a trailing slash (`ISSUER`), and the protected
resource SHALL be `ISSUER + "/mcp"` (`RESOURCE`). There SHALL be one scope, `dashboards`.

- **`GET /.well-known/oauth-protected-resource`** and
  **`GET /.well-known/oauth-protected-resource/mcp`** SHALL each answer `200` with exactly the
  RFC 9728 document `{resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported:
  ["dashboards"], bearer_methods_supported: ["header"], resource_name: "AutoLogger"}`.
- **`GET /.well-known/oauth-authorization-server`** SHALL answer `200` with exactly the RFC 8414
  document `{issuer: ISSUER, authorization_endpoint: ISSUER + "/oauth/authorize",
  token_endpoint: ISSUER + "/oauth/token", registration_endpoint: ISSUER + "/oauth/register",
  revocation_endpoint: ISSUER + "/oauth/revoke", response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
  revocation_endpoint_auth_methods_supported: ["none"], scopes_supported: ["dashboards"],
  authorization_response_iss_parameter_supported: true}`.

The documents SHALL need no credentials and SHALL carry no other field.

#### Scenario: The documents match exactly
- **WHEN** the flag is on with `PUBLIC_BASE_URL=https://example.com` and the three metadata paths
  are fetched
- **THEN** each answers `200` with the document above, `resource` `https://example.com/mcp` and
  `issuer` `https://example.com`, and no other field

### Requirement: Dynamic client registration
`POST /oauth/register` SHALL register a public OAuth client (RFC 7591) from a JSON object body of
at most 64 KiB, and SHALL issue no client secret.

- **Accepted fields.**
  - `client_name`: required, 1-100 characters (Unicode code points), with no control character and
    no bidirectional-text control (U+061C, U+200E, U+200F, U+202A-U+202E, U+2066-U+2069).
  - `redirect_uris`: required, 1-5 redirect URIs.
  - `grant_types`: optional; when present it SHALL include `authorization_code` and MAY add only
    `refresh_token`.
  - `response_types`: optional; when present it SHALL be exactly `["code"]`.
  - `token_endpoint_auth_method`: optional; when present it SHALL be `none`.
  - `application_type`: optional; when present it SHALL be `web` or `native`.
  - Every other field SHALL be ignored, and no URI it names SHALL ever be fetched or rendered.
- **Redirect URIs.** Each SHALL be at most 2000 characters with no whitespace, control character
  or `#`, no user info, and SHALL be either an absolute `https:` URL with a host, or a loopback
  `http://127.0.0.1`, `http://localhost` or `http://[::1]` URL with any port or none. An
  authorization request SHALL match a registered URI exactly, except that a loopback URI matches
  with any port (RFC 8252 section 7.3).
- **Issued.** `client_id` SHALL be `alc_` followed by 16 random bytes in base64url. The answer
  SHALL be `201 {client_id, client_id_issued_at, client_name, redirect_uris, grant_types:
  ["authorization_code", "refresh_token"], response_types: ["code"],
  token_endpoint_auth_method: "none"}`, plus `application_type` when one was given.
- **Refusals.** A problem with `redirect_uris` SHALL answer `400 {error: "invalid_redirect_uri",
  error_description}`. Any other invalid field, a body that is not a JSON object, or a body over
  64 KiB SHALL answer `400 {error: "invalid_client_metadata", error_description}`. A refused
  registration SHALL store nothing.
- **Headers.** Every answer of `POST /oauth/register` SHALL carry `Cache-Control: no-store` and
  `Referrer-Policy: no-referrer`.

#### Scenario: A client registers
- **WHEN** a client posts `{client_name: "Claude", redirect_uris:
  ["https://claude.ai/api/mcp/auth_callback", "http://127.0.0.1:33418/callback"]}`
- **THEN** the answer is `201` with an `alc_` `client_id`, no secret, both URIs, and
  `token_endpoint_auth_method` `none`, and one client row is stored with its source address

#### Scenario: Redirect URI rules
- **WHEN** a registration names `http://example.com/cb`, `https://example.com/cb#f`,
  `myapp://cb`, `http://localhost.evil.com/cb`, no URI, or six URIs
- **THEN** each answers `400 {error: "invalid_redirect_uri", ...}` and nothing is stored

#### Scenario: The loopback port is ignored when matching
- **WHEN** `http://127.0.0.1/cb` is registered and an authorization request names
  `http://127.0.0.1:51234/cb`, and `https://example.com/cb` is registered and a request names
  `https://example.com:443/cb`
- **THEN** the first matches and the second does not

#### Scenario: Field limits
- **WHEN** a registration has no `client_name`, a 101-character name, a name with a control
  character or a right-to-left override, `token_endpoint_auth_method` `client_secret_basic`,
  `response_types` `["token"]`, or a body that is not JSON
- **THEN** each answers `400 {error: "invalid_client_metadata", ...}` and nothing is stored

### Requirement: Registration is rate-limited per source address and capped
Registrations SHALL be counted per source address in fixed one-hour windows stored in the catalog
and shared by every process: an IPv4 address (or an IPv4-mapped IPv6 address) counts alone, and an
IPv6 address counts by its `/64` prefix. The source address SHALL be the one the IP allowlist uses
(the socket address, or the first `X-Forwarded-For` hop with `TRUST_PROXY` on). Every attempt
SHALL count, valid or not. Past 10 in a window the answer SHALL be
`429 {detail: "Rate limit exceeded; retry in N s."}` with `Retry-After: N`, where `N` is the
whole seconds left in the window (at least 1).

There SHALL be at most 10,000 registered clients. A registration that would pass that SHALL answer
`429 {detail: "Too many registered clients; try again later."}` and store nothing. The count and
the insert SHALL be one statement; concurrent registrations at the cap may pass it by the number
racing.

#### Scenario: The 11th registration from one IPv4 address
- **WHEN** one IPv4 address registers 10 clients within an hour and then an 11th
- **THEN** the first 10 answer `201`, the 11th answers `429` with `Retry-After`, and a
  registration from another address answers `201`

#### Scenario: Two addresses in one IPv6 /64 share a window
- **WHEN** `2001:db8:aa:bb::1` and `2001:db8:aa:bb:ffff:1:2:3` register 5 clients each, and then
  a third address in the same `/64` registers one
- **THEN** that registration answers `429`, and one from `2001:db8:aa:bc::1` answers `201`

#### Scenario: The live-client cap
- **WHEN** 10,000 clients exist and another registration arrives
- **THEN** it answers `429 {detail: "Too many registered clients; try again later."}` and the
  count stays 10,000

### Requirement: OAuth storage
The catalog SHALL hold the OAuth server's state in five tables: `mcp_clients`, `mcp_grants`,
`mcp_access_tokens`, `mcp_refresh_tokens` and `mcp_rate_windows`.

- A grant SHALL record its user, client, scope, resource, creation time, and an `expires_at_utc`
  that is not null: the grant's 90-day hard cap from creation (ADR 0035 decision 16).
- A refresh token row SHALL have a `successor_sealed` column for the refresh grace window's sealed
  successor (ADR 0035 decision 17), null unless set at rotation.
- Tokens SHALL be stored only as the hex SHA-256 of the token.
- Deleting a user or a client SHALL delete its grants, and deleting a grant its tokens.
- Every table SHALL be system-only: the allow-all policy for `catalog_system`, no `catalog_user`
  policy, and `catalog_user` privileges revoked, so a user binding gets `42501` on every
  statement. The server SHALL use them only under the reviewed system reasons `mcp-oauth` (the
  OAuth routes) and `mcp-sweep` (the cleanup).

#### Scenario: A user binding is refused
- **WHEN** a `catalog_user` binding selects, inserts, updates or deletes rows of any of the five
  tables, its own included
- **THEN** each statement fails with `42501` and no row changes

#### Scenario: The cap is required
- **WHEN** a grant row is inserted without `expires_at_utc`
- **THEN** the insert fails with `23502`

### Requirement: Cleanup
With the flag on, every process SHALL sweep the OAuth tables once a minute. Each sweep SHALL, at
the clock's current time, with each delete bounded to 1000 rows:
- delete access tokens past their expiry;
- delete refresh tokens expired more than a day ago;
- set `successor_sealed` to null on every refresh token used longer ago than the grace window (30
  seconds by default), and keep it on one used within the window, exactly at its end included;
- delete grants revoked more than 30 days ago, and grants whose 90-day cap passed more than 30
  days ago, with their tokens;
- delete clients with no grant that is live or ended within 30 days, when they were never
  authorized and are more than 24 hours old, or were last authorized more than 30 days ago;
- delete rate windows that started more than an hour ago.

A failed sweep SHALL log a warning naming only the error kind, and the next sweep SHALL run as
usual.

#### Scenario: Unused clients
- **WHEN** the sweep runs with one never-authorized client created 24 hours and 1 second ago and
  one created 23 hours ago
- **THEN** the first is deleted and the second is kept

#### Scenario: Capped grants
- **WHEN** the sweep runs with one grant whose 90-day cap passed 31 days ago and one whose cap
  passed 29 days ago
- **THEN** the first is deleted with its tokens and the second is kept

#### Scenario: Sealed successors
- **WHEN** the sweep runs with the default 30-second window and refresh tokens used 31, 30 and 29
  seconds ago, each with a `successor_sealed`
- **THEN** the one used 31 seconds ago has `successor_sealed` null and the other two keep theirs

### Requirement: Authorization requests
`GET /oauth/authorize` SHALL check, in order:

1. `client_id` names a registered client and `redirect_uri` matches one of its registered URIs
   (exactly, or a loopback URI with any port), each given once. If not, it SHALL answer `400`
   with a plain HTML page and SHALL NOT redirect.
2. Every parameter appears once, `response_type=code`, `code_challenge` is 43-128 characters of
   the PKCE alphabet with `code_challenge_method=S256`, `resource` equals `ISSUER + "/mcp"`,
   `scope` is absent or `dashboards`, and `state` is 1-512 characters. A failure SHALL answer
   `302` to the request's `redirect_uri` with `error` (`invalid_target` for the resource,
   `invalid_scope` for the scope, `invalid_request` otherwise), `iss` = `ISSUER`, and `state`
   when it was valid.

It SHALL then store the validated request in KV as `mcpauthz:<id>` (a 128-bit id, 10 minutes).
With a valid session cookie it SHALL answer the consent page. Without one it SHALL start the
existing Google sign-in with a new OAuth state stored, under the same prefix and TTL, as
`mcp:<id>`, and the same Google redirect URI, so the callback resumes the request
(api-contract-freeze "OAuth callback failure redirect"). Every check of the sign-in itself is
unchanged.

`GET /oauth/authorize/resume?request=<id>` SHALL answer the consent page for a live request and a
valid session cookie, and a `400` HTML page saying to start again otherwise.

#### Scenario: Errors before validation never redirect
- **WHEN** `client_id` is missing or unknown, or `redirect_uri` is missing, repeated or not
  registered, whatever the other parameters
- **THEN** the answer is `400` HTML with no `Location`

#### Scenario: Errors after validation return to the client
- **WHEN** the client and redirect URI are valid and `code_challenge_method` is `plain`
- **THEN** the answer is `302` to the redirect URI with `error=invalid_request`, the `state` and
  `iss`

#### Scenario: Signed out
- **WHEN** a valid request arrives with no session
- **THEN** the answer is `302` to Google, with a state whose stored value is `mcp:<id>` for a
  stored request

### Requirement: Consent
The consent page SHALL show the signed-in user's email, the client name labelled as given by the
client and rendered as text, the redirect host in bold, the sentence "read every session you can
open, and create, edit and delete dashboards in studios where you are an owner or admin", and
Approve and Deny buttons in a form that posts `request`, `decision` and `csrf` to
`POST /oauth/authorize`. Consent SHALL be asked on every authorization; no decision is remembered
per client.

`csrf` SHALL be the HMAC-SHA256, under `MCP_SIGNING_SECRET`, of the request id and the SHA-256 of
the session cookie. `POST /oauth/authorize` SHALL require a session cookie, a `decision` of
`approve` or `deny`, and that CSRF token, compared in constant time, before it takes the request;
any failure, or a request already taken or expired, SHALL answer `400` HTML. The request SHALL be
taken atomically, so it is decided at most once.

- **Approve** SHALL create a grant (user, client, scope, resource) whose `expires_at_utc` is 90
  days after its creation, stamp the client's `last_authorized_at_utc`, and store a code (32 random
  bytes in base64url) as KV `mcpcode:<sha256(code)>` for 60 seconds with the grant id, client id,
  redirect URI, code challenge, resource and scope. It SHALL return to the client with `code`,
  `state` and `iss`.
- **Deny** SHALL return to the client with `error=access_denied`, `state` and `iss`, creating
  nothing.

Returning to the client SHALL be a `200` HTML page, never a `302`, holding a
`<meta http-equiv="refresh" content="0; url=...">` and a "Continue to <host>" link to the same
URL: the stored redirect URI with the parameters appended to its query, never built from form
fields, escaped as an HTML attribute.

Every HTML page of these routes SHALL be rendered by the server with escaping, hold one inline
`<style>` and load nothing, and carry `Content-Security-Policy: default-src 'none'; style-src
'sha256-<hash of that style>'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
`X-Frame-Options: DENY`, `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.

#### Scenario: CSRF
- **WHEN** a consent form is posted with a forged token, from another session, or with the
  token of another request
- **THEN** each answers `400` HTML, and the real form still approves once

#### Scenario: Approve
- **WHEN** the signed-in user approves
- **THEN** the answer is `200` with no `Location`, and its meta refresh and link name the
  registered redirect URI with `code`, `state` and `iss`

#### Scenario: Deny
- **WHEN** the signed-in user denies
- **THEN** the page returns to the redirect URI with `error=access_denied`, `state` and `iss`,
  and no grant exists

### Requirement: The authorization code grant
`POST /oauth/token` SHALL take a form-urlencoded body of at most 16 KiB with each parameter once;
anything else is `400 {error: "invalid_request"}`. Every answer SHALL carry
`Cache-Control: no-store` and `Referrer-Policy: no-referrer`. A missing `client_id` or
`grant_type` is `invalid_request`, and a `grant_type` other than `authorization_code` or
`refresh_token` is `unsupported_grant_type`.

For `authorization_code`: missing `code`, `redirect_uri` or a well-formed `code_verifier` SHALL be
`invalid_request` and an unknown client `invalid_client`, each before the code is touched. The
code SHALL then be taken from KV atomically; its client SHALL equal `client_id`, its redirect URI
SHALL equal `redirect_uri` exactly, `resource` SHALL equal `ISSUER + "/mcp"`, and
`BASE64URL(SHA256(code_verifier))` SHALL equal its challenge in constant time. Any failure SHALL
be `400 {error: "invalid_grant"}`, and a code is never usable twice. On success it SHALL record
`mcpcodeused:<sha256(code)>` → grant id for 10 minutes and answer
`200 {access_token, token_type: "Bearer", expires_in, refresh_token, scope: "dashboards"}`.
Access tokens are `alm_` and refresh tokens `alr_`, each followed by 32 random bytes in base64url;
only their SHA-256 is stored. A code whose grant is revoked, past its cap, or whose user is
disabled gets `invalid_grant`.

A code presented again after its exchange SHALL get `invalid_grant`, and the grant its first use
produced SHALL be revoked: `revoked_at_utc` set and every token of it deleted in one transaction,
logged as `mcp oauth: code reuse, grant <id> revoked`.

#### Scenario: The code flow
- **WHEN** a client completes consent and exchanges the code with the right verifier
- **THEN** it gets `200` with an `alm_` access token, an `alr_` refresh token, `expires_in` 3600
  and scope `dashboards`

#### Scenario: Exchange failures
- **WHEN** the verifier is wrong, the code was used, the `redirect_uri` differs, or the
  `resource` is another
- **THEN** each answers `400 {error: "invalid_grant"}`

#### Scenario: A replayed code
- **WHEN** an exchanged code is presented again
- **THEN** it answers `invalid_grant`, and the grant's access and refresh tokens are deleted

### Requirement: Token lifetimes and the 90-day cap
Every grant SHALL expire 90 days after its creation (ADR 0035 decision 16), whatever refreshes
happen; the cap is fixed. An access token SHALL expire at the earlier of 1 hour after issue and
the grant's cap, and a refresh token at the earlier of 30 days after issue and the cap, so each
rotation restarts the 30 days but never moves the cap. `expires_in` SHALL count the whole seconds
to the access token's expiry, so it is below 3600 in the last hour of a grant. Past the cap every
refresh SHALL answer `invalid_grant`.

#### Scenario: A late refresh token
- **WHEN** a refresh token is issued 70 days into a grant
- **THEN** it expires at the grant's cap

#### Scenario: Daily refreshes end at the cap
- **WHEN** a client refreshes every day
- **THEN** the refresh 90 days after the grant's creation answers `invalid_grant`

### Requirement: Refresh rotation and reuse detection
A `refresh_token` request SHALL run in one transaction, in this order:

1. Hash the token and read it with its grant. An unknown token, or an unspent one past its
   expiry, SHALL answer `invalid_grant` and change nothing.
2. A spent token is a reuse, whatever `client_id` came with it, and goes to the reuse rules.
3. A live token whose grant belongs to another client SHALL answer `invalid_grant` before any
   write: the token stays unspent and nothing is revoked. A live token whose grant is revoked or
   past its cap, or whose user is disabled, also answers `invalid_grant` and stays unspent.
4. Rotate: mark the token used with one `UPDATE` that repeats the client check, issue a new
   access and refresh token, and, unless the grace window is `0`, seal the successor onto the
   spent row (`successor_sealed`).

Reuse rules (ADR 0035 decision 17): a reuse SHALL get `200` with the successor already issued, the
same `access_token` and `refresh_token`, with `expires_in` recomputed and no token row written,
only when the window is not `0`, at most the window has passed since the token was used (exactly
the window included), the request's `client_id` is the grant's client, the grant is live and
within its cap, the user is enabled, and the seal opens. Any other reuse SHALL revoke the grant
(`revoked_at_utc` set, every access and refresh token of it deleted), log
`mcp oauth: refresh reuse, grant <id> revoked`, and answer `invalid_grant`. Two concurrent
refreshes of one token SHALL both answer `200` with the same tokens.

The seal SHALL be AES-256-GCM with a random 96-bit nonce and the row's `token_hash` and
`grant_id` as additional authenticated data, under a key from HKDF-SHA256 over the spent raw
refresh token with `MCP_SIGNING_SECRET` as the salt and `mcp-refresh-grace` as the info. It SHALL
contain neither raw token in clear, and SHALL NOT open for another row or under another secret.

#### Scenario: Grace window
- **WHEN** the same client reuses a rotated token 29 or 30 seconds after the rotation
- **THEN** it gets the successor that rotation issued, and no token row is written

#### Scenario: Outside the window
- **WHEN** the same client reuses it 31 seconds after, or another client reuses it 10 or 31
  seconds after
- **THEN** the grant is revoked with all its tokens and the answer is `invalid_grant`

#### Scenario: Another client's live token
- **WHEN** a live refresh token is presented with another client's `client_id`
- **THEN** the answer is `invalid_grant`, the token stays unspent with no seal, and the right
  client then refreshes it with `200`

#### Scenario: Window off
- **WHEN** `MCP_REFRESH_GRACE_SECONDS` is `0`
- **THEN** rotation writes no seal, and a reuse at the same instant or one second later revokes

### Requirement: The grace window setting
The window SHALL be `MCP_REFRESH_GRACE_SECONDS`, in whole seconds from `0` to `60`; unset or
empty means 30, and `0` turns it off. The boot guard refuses any other value while the flag is
on (web-frontend-platform). The token endpoint and the sweeper SHALL both read it.

#### Scenario: The sweeper reads the setting
- **WHEN** the flag is on and `MCP_REFRESH_GRACE_SECONDS` is `7`
- **THEN** each sweep clears seals used longer ago than 7 seconds

### Requirement: Token endpoint rate limits
Token requests SHALL be counted in fixed one-minute windows stored in the catalog: every request
per source address (IPv4 alone, IPv6 by `/64`, as for registration), then each request with a
`client_id` per client. Past 60 for an address or 30 for a client the answer SHALL be
`429 {detail: "Rate limit exceeded; retry in N s."}` with `Retry-After: N`.

#### Scenario: Per client
- **WHEN** one client makes 31 token requests in a minute from different addresses
- **THEN** the 31st answers `429` and another client's request answers as usual

#### Scenario: Per IPv6 /64
- **WHEN** two addresses in one `/64` make 60 token requests in a minute between them
- **THEN** a 61st from that `/64` answers `429`, and one from another `/64` does not

### Requirement: Revocation
`POST /oauth/revoke` (RFC 7009) SHALL take a form-urlencoded `token`, an optional
`token_type_hint` (ignored), and `client_id`. When the token is an access or refresh token of a
grant of that client, the whole grant SHALL be revoked: `revoked_at_utc` set and every token of
it deleted in one transaction. The answer SHALL be `200` with no body whether or not anything was
revoked (an unknown token, another client's token, or no `client_id`); a request with no `token`
SHALL answer `400 {error: "invalid_request"}`. Every answer carries `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`.

#### Scenario: A client revokes its refresh token
- **WHEN** a client posts its refresh token with its `client_id`
- **THEN** the answer is `200`, the grant is revoked, and the refresh token gets `invalid_grant`

#### Scenario: Another client's token
- **WHEN** a client posts a token of another client's grant
- **THEN** the answer is `200` and nothing is revoked
