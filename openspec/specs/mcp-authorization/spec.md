# mcp-authorization Specification

## Purpose
Lets a Claude client connect to AutoLogger as a custom connector through AutoLogger's own OAuth 2.1 authorization server, behind `CUSTOM_DASHBOARDS_ENABLED` (ADR 0035 decision 5; design `docs/design/custom-session-dashboards.md` section 4). This capability covers discovery, dynamic client registration, the OAuth storage and its cleanup. Authorization, consent, tokens and revocation are added by later jobs (J3, J4).

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
  `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server` and
  `/oauth/register`
- **THEN** the `GET` and `HEAD` requests reach the frontend bridge, each answer is byte for byte
  the answer of an unmounted path such as `/oauth/not-a-route`, and no client or rate window is
  stored

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
