# Spec Delta

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
  `GET /api/companion/state/..%2Fsessions` is sent to the router with a valid `API_TOKEN`
- **THEN** the response is the server's own `404`, and no session or admin route handler
  runs

#### Scenario: API encoding passes through untouched
- **WHEN** a compressible `/api/*` response over the threshold is requested through the
  router with `Accept-Encoding: gzip`, and again without it
- **THEN** the gzipped and identity responses, and their headers, match what `api` returns
  when addressed directly
