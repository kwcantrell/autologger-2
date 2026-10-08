## MODIFIED Requirements

### Requirement: Internal router preserves the single-origin disposition matrix
A router service SHALL front `web` and `api` and SHALL be the only service reachable from
outside the compose networks.

It SHALL evaluate every rule on the **raw request-target path exactly as received**: still
percent-encoded, case-sensitive, with no dot-segment removal or slash merging. Each rule
SHALL reproduce the path semantics of the server check it replaces:
- the `Upgrade` rule SHALL match `/api` literally on the raw path, as the server's upgrade
  dispatch does (it uses the undecoded WHATWG pathname);
- the `/api` and `/auth` HTTP rule SHALL also match percent-encoded forms of the prefix's
  letters (for example `/%61pi/x`), because the server's HTTP routing applies `decodeURI`
  and serves `/%61pi/x` as `/api/x`. It SHALL stay case-sensitive in the decoded letters
  (`/API/x` is not `/api`) and SHALL NOT decode `%2F`, which `decodeURI` also leaves
  encoded.

The rules SHALL be evaluated in this order:
1. A request whose raw path has a segment that is `.` or `..`, or percent-decodes to `.` or
   `..` (any mix of `.`, `%2e` and `%2E`), or contains an empty segment (`//`), or (under
   `/api` or `/auth`) contains `%2f`, `%2F`, `%5c`, or `%5C`, SHALL be forwarded to `api`
   with its path replaced by a fixed path outside the inventory and outside `/api` and
   `/auth`. The server's own `404` then answers it (see the `api-contract-freeze` delta).
2. An upgrade request (Node's definition: an `Upgrade` header together with a `Connection`
   header containing the `upgrade` token, case-insensitive) SHALL be aborted if its raw
   path is not literally `/api` or under `/api/`. Aborting closes the connection with no
   HTTP response written.
3. Requests whose path is `/api` or `/auth`, or starts with `/api/` or `/auth/`, SHALL go to
   `api`, WebSocket upgrades included. Prefix letters may be percent-encoded, per the HTTP
   rule above.
4. Requests with a method other than `GET` or `HEAD` SHALL go to `api`.
5. Paths other than `/` that end in `/` SHALL go to `api`.
6. All remaining requests SHALL go to `web`.

**Accepted fail-closed exceptions (owner ruling, archive gate, 2026-09-28).** Four
malformed request shapes are outside the endpoint inventory and never sent by the frontend or
Companion. For these shapes the router's answer is not required to match the single-process
server, but it SHALL NOT reach a handler the server would refuse:
- a `GET`/`HEAD` path containing a literal `\`: the server treats it as `/` and can serve
  it; the router sends it to `web`, which answers `404`;
- `OPTIONS *`: the server answers `400`; the router answers an empty `200`;
- an `/api` request line too large for the server's header limits: the server answers `431`;
  above roughly 60 KB the router can give an empty reply instead;
- an upgrade whose `/api` path contains dot-segments: the server can admit it; the router
  (traversal rule) answers `502` or `404`.

These are the only cases in which the router writes a response of its own. (An absolute-form
request target, `GET http://host/…`, is NOT an exception: it was measured to route exactly
like its origin-form equivalent.)

The router SHALL NOT compress, recompress, cache, or buffer responses. It SHALL NOT add,
remove, or alter response headers, except for removing the `Server` and `Via` headers it would otherwise add, and the
normal proxy handling of hop-by-hop headers (`Connection`, `Keep-Alive`) and header-name
case.
`Content-Encoding`, `Content-Length`, `Vary`, `Content-Range`, and streamed
(`text/event-stream`, chunked) bodies SHALL pass through exactly as the upstream emitted
them.

#### Scenario: Shell served by web
- **WHEN** `GET /`, `GET /teams`, `GET /sessions/abc`, or `GET /sessions/a%2Fb` is sent to
  the router
- **THEN** the response is `200` with the index shell HTML from `web`, with no `Set-Cookie`

#### Scenario: The retired admin page is not a shell path
- **WHEN** `GET /admin/users` is sent to the router
- **THEN** the response is `404` with the app's not-found page from `web`, and the
  `/api/admin/*` routes are unaffected

#### Scenario: Differential parity with the single-process server
- **WHEN** the same request list is sent to the router, and compared with the dispositions the
  single-process server gives for it (recorded in the router test's expectation table, last
  verified against a single-process server built from the same commit)
- **AND** the list covers: `GET` and `HEAD` of every shell route; an RSC flight request for
  `/teams`; a `/_next/static/*` asset; `/static/fonts/*`; `/_next/image?url=…`;
  `/sessions`; `/sessions/a/b`; `/sessions/a%2F`; `/teams/`; `HEAD /teams/`; `/nope`;
  `POST /sessions/abc`; `GET /api/does-not-exist`; `GET /API/profile`; `GET /%61pi/profile`
- **THEN** each pair has the same status and the same values (present or absent) for
  `Set-Cookie`, `X-Powered-By`, `Location`, `Content-Type`, `Vary`, and `Cache-Control`

#### Scenario: Stray upgrade writes nothing
- **WHEN** a WebSocket upgrade, or any other `Upgrade` request, is attempted through the
  router on `/teams`
- **THEN** the connection is closed with no HTTP status line received

#### Scenario: Session WebSocket upgrades through the router
- **WHEN** a signed-in browser opens `/api/sessions/<id>/ws?role=browser` through the router
- **THEN** the upgrade completes and live frames are delivered

#### Scenario: Traversal cannot reach a non-Companion route
- **WHEN** `GET /api/companion/%2e%2e/sessions/x`, `GET /api/companion/.%2E/admin/users`, or
  `GET /api/companion/state/..%2Fsessions` is sent to the router with a live Companion device
  token as a `Bearer`
- **THEN** the response is the server's own `404`, and no session or admin route handler
  runs

#### Scenario: API encoding passes through untouched
- **WHEN** a compressible `/api/*` response over the threshold is requested through the
  router with `Accept-Encoding: gzip`, and again without it
- **THEN** the gzipped and identity responses, and their headers, match what `api` returns
  when addressed directly

### Requirement: Deployment behind a TLS-terminating proxy is configured explicitly
The compose defaults and deployment documentation SHALL set:
- `PUBLIC_BASE_URL` to the public HTTPS origin;
- `COOKIE_SECURE=1`, set explicitly;
- `TRUST_PROXY=1`, with the router trusting forwarded headers only from a pinned compose
  subnet and sending `api` exactly one `X-Forwarded-For` value: the client address the
  router resolved.

The documentation SHALL state:
- that the upstream proxy's Companion bypass rules name exactly the five paths the Companion
  module calls (`/api/companion/state`, `/categories`, `/log`, `/transport`, `/command`),
  never wildcards;
- that `API_TOKEN` is ignored since ADR 0021 slice 9d, and every Companion install must be given
  a device token from Settings › Companion devices after the deploy that ships it (re-pairing);
- that a Google OAuth client with redirect URI `${PUBLIC_BASE_URL}/auth/google/callback`
  must exist and be verified before cutover;
- that existing sessions and teams become visible to signed-in users only after memberships
  are granted via `ADMIN_TOKEN`;
- that AI chat, topics, and events use the mounted subscription credentials, which is the
  owner's accepted risk;
- that AI v2 needs `AI_V2_API_KEY`;
- that shell and asset requests are not guaranteed the server's `IP_ALLOWLIST` coverage in
  this topology;
- that any process on the host can reach the loopback port without passing through the
  upstream proxy;
- private-registry login for the deploy host;
- the WAL-safe backup, the minimal-downtime migration (pre-seed, then a final copy inside
  the window), update, and rollback procedures.

#### Scenario: Forged X-Forwarded-For is not adopted
- **WHEN** a client sends its own `X-Forwarded-For: 1.2.3.4` through the upstream proxy and
  the router
- **THEN** the server's resolved client IP is not `1.2.3.4`

#### Scenario: Session cookie is Secure
- **WHEN** a user completes Google sign-in through the public origin
- **THEN** the session cookie is set with `Secure`, and the OAuth redirect URI is
  `${PUBLIC_BASE_URL}/auth/google/callback`

### Requirement: Router behaviour is checked without a browser
A shell test, `docker/scripts/test_router.sh ENV`, SHALL exercise a running stack's router over
plain HTTP and raw TCP, and SHALL print case names and statuses only. It SHALL cover:
- the shell routes served by `web` with `200` and no `Set-Cookie`;
- the request list of "Differential parity with the single-process server", compared with a
  committed expectation table of status and header presence;
- stray upgrades closed with no bytes written, and the session WebSocket path still proxied;
- traversal to a non-Companion route with a live Companion device token, including a non-GET and
  a query string carrying a dot-segment;
- device-token scope: Companion state is allowed; sessions, admin routes and the browser-role
  WebSocket are handled as unauthenticated;
- `web` unable to connect to `api`, and the router's port unreachable on a non-loopback host
  address.

The device token SHALL be supplied to the script by the operator, created in the stack's
Settings › Companion devices, and SHALL be held only in the script's process environment, never
printed. It SHALL run against stage (`make stage-up`) by hand. CI has no docker.

#### Scenario: A router regression is caught
- **WHEN** the router is misconfigured so that `POST /sessions/abc` reaches `web`
- **THEN** `test_router.sh stage` fails and names that request

## ADDED Requirements

### Requirement: The Companion module authenticates with a device token kept as a secret
The Bitfocus Companion module in `companion/` SHALL authenticate with a Companion device token
(api-contract-freeze "Companion device tokens authenticate only the Companion surface"), sent as
`Authorization: Bearer <token>` on the five paths it calls
(`/api/companion/{state,categories,log,transport,command}`), which are unchanged, so the upstream
proxy's Companion bypass rules do not change. The module SHALL NOT post presence.

- **Secret field.** The token SHALL be a `secret-text` configuration field labelled "Device token
  (required)", so Companion keeps its value in its secrets store rather than in the plain
  connection config. The module SHALL read the token from its secrets on start and on every
  configuration update.
- **Upgrade.** The module SHALL ship one upgrade script: when a connection's plain config holds a
  non-empty `token` and its secrets hold none, the script SHALL move the value into the secrets and
  remove it from the plain config; otherwise it SHALL change nothing.
- **Status on 401.** A `401` from the server SHALL set the connection status to bad configuration
  with the message "Device token invalid or revoked: create one in AutoLogger Settings → Companion
  devices".
- **Help and version.** The module's help SHALL explain how to create a device token in Settings
  and that an install must be re-paired after the deploy that retires `API_TOKEN`, and the module
  version SHALL be bumped.

#### Scenario: An existing token is moved into secrets
- **WHEN** the upgrade script runs on a connection whose plain config holds `token: "abc"` and
  whose secrets hold no token, then on one whose secrets already hold a token, then on one with
  no token at all
- **THEN** the first comes out with the secret token `abc` and no plain `token`, and the other two
  are unchanged

#### Scenario: The module reads the token from secrets
- **WHEN** the module starts with a device token in its secrets and calls the server
- **THEN** each request carries `Authorization: Bearer <that token>`, and no token is read from
  the plain config

#### Scenario: A revoked token tells the operator what to do
- **WHEN** the server answers the module's state poll with `401`
- **THEN** the connection status is bad configuration with the device-token message naming
  Settings → Companion devices
