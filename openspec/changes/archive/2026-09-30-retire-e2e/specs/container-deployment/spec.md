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
- **WHEN** `GET /`, `GET /teams`, `GET /sessions/abc`, `GET /sessions/a%2Fb`, or
  `GET /admin/users` is sent to the router
- **THEN** the response is `200` with the index or admin shell HTML from `web`, with no
  `Set-Cookie`

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

## REMOVED Requirements

### Requirement: Container e2e project
**Reason**: All Playwright e2e is retired (ADR 0021 slice 1.4a, owner decision 2026-09-30). The project's runner booted a host `npm run start` reference server, and host serving is retired in slice 1.4b. Its router security cases move to a non-browser router test (see "Router behaviour is checked without a browser").
**Migration**: The suites (`e2e/serving-contract.spec.ts`, `e2e/container-routing.spec.ts`), `e2e/container/run.sh` and `e2e/container/compose.e2e.yaml` remain in git history before this change. A later change rebuilds browser e2e against the Supabase stack.

## ADDED Requirements

### Requirement: Router behaviour is checked without a browser
A shell test, `docker/scripts/test_router.sh ENV`, SHALL exercise a running stack's router over
plain HTTP and raw TCP, and SHALL print case names and statuses only. It SHALL cover:
- the shell routes served by `web` with `200` and no `Set-Cookie`;
- the request list of "Differential parity with the single-process server", compared with a
  committed expectation table of status and header presence;
- stray upgrades closed with no bytes written, and the session WebSocket path still proxied;
- traversal to a non-Companion route with a valid `API_TOKEN`, including a non-GET and a query
  string carrying a dot-segment;
- `API_TOKEN` scope: Companion state is allowed; sessions, admin routes and the browser-role
  WebSocket are handled as unauthenticated;
- `web` unable to connect to `api`, and the router's port unreachable on a non-loopback host
  address.

It SHALL run against stage (`make stage-up`) by hand. CI has no docker.

#### Scenario: A router regression is caught
- **WHEN** the router is misconfigured so that `POST /sessions/abc` reaches `web`
- **THEN** `test_router.sh stage` fails and names that request
