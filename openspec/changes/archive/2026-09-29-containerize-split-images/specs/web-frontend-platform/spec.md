## MODIFIED Requirements

### Requirement: Next.js frontend served through the Hono bridge
The web frontend SHALL be a Next.js (App Router) application compiled from `web/`. It SHALL
be servable in either of two topologies: the **single-process topology** specified by this
requirement, and the **split-container topology** specified by "Split-container serving
topology". In the single-process topology the frontend SHALL be served by the existing Hono
server process through a bridge catch-all: **GET** requests matching
no mounted route SHALL be handed to Next's request handler via the raw Node
request/response objects and answered by Next; the Hono handler SHALL signal the
already-sent response (`RESPONSE_ALREADY_SENT`) rather than composing a second response.
Non-GET requests matching no mounted route SHALL keep responding with the server's own
`404`, exactly as before this change (HEAD is answered through the GET handlers, as
today). When the raw response object is absent from the request env (the WebSocket
upgrade replay and direct `app.request()` calls construct envs without one), the bridge
SHALL respond with the server's own `404` instead of invoking Next. A rejection from the
frontend handler after response bytes have been written SHALL NOT result in a second
response being composed onto the connection.
`/api/*` and `/auth/*` routes SHALL be mounted before the bridge and can never reach it.
The bridge SHALL run after the IP-allowlist and auth-context middleware, so in the
single-process topology page and asset requests retain exactly the middleware coverage
they have today. The server SHALL NOT import any module under `web/src/**`, and the Next
compilation graph SHALL NOT include any module under `server/src/**` or `packages/**`.

In production the set of non-`/api`/`/auth` path families answered with anything other
than `404` SHALL be closed and enumerated, in both topologies: the four shell routes,
`/_next/static/*`, `public/`-served files (including `/static/*`), the not-found document,
and the framework's flight/RSC variants of the shell routes. The image optimizer endpoint
(`/_next/image`) SHALL NOT be served (`images.unoptimized`), and the framework's
`X-Powered-By` header and build/dev telemetry egress SHALL be disabled.

#### Scenario: API routes never reach the frontend bridge
- **WHEN** any `/api/*` or `/auth/*` request is handled
- **THEN** it is answered by the mounted Hono router, and the frontend bridge is not
  invoked for it

#### Scenario: Page requests pass through server middleware
- **WHEN** the single-process topology is running, an `IP_ALLOWLIST` is configured, and a
  non-allowlisted client requests `/`
- **THEN** the request is rejected by the allowlist middleware before the bridge runs,
  exactly as it is for API routes

#### Scenario: Module graphs stay separate
- **WHEN** the server workspace's import graph and the Next build's module graph are
  examined
- **THEN** no server module resolves into `web/src/**` and no web module resolves into
  `server/src/**` or `packages/**`

#### Scenario: Non-GET unmatched requests keep the server's 404
- **WHEN** `POST /sessions/abc` (or any non-GET request to a path outside the endpoint
  inventory) is received
- **THEN** the response is the server's own `404`, and the frontend bridge is not
  invoked

#### Scenario: Bridge without a writable response object
- **WHEN** the bridge catch-all is reached by a request env carrying no raw response
  object (e.g. the WebSocket upgrade replay for a stray `/api`-prefixed path)
- **THEN** the server responds `404` without invoking Next

#### Scenario: Image optimizer is not served
- **WHEN** `GET /_next/image?url=/static/logo-autologger-app.png&w=64&q=75` is
  requested in production
- **THEN** the optimizer endpoint is not served (the response is a `404` or the
  framework's disabled-optimizer error status — never an optimized image)

## ADDED Requirements

### Requirement: Split-container serving topology
The Next build SHALL also emit standalone server output (`output: 'standalone'`, traced from
the repository root). That output SHALL be able to serve the frontend with no Hono process
present, and SHALL serve the same routes, page components, and closed path-family set as the
bridge. Enabling standalone output SHALL NOT change how the single-process topology behaves.

In the split-container topology, the standalone server SHALL sit behind the internal router
specified by the `container-deployment` capability. The router SHALL send to the server
(running API-only) every request that the bridge would have answered with the server's own
`404`:
- all `/api*` and `/auth*` paths;
- all non-GET/HEAD methods;
- trailing-slash paths other than `/`.

The router SHALL close stray non-`/api` `Upgrade` requests with no response written. Its path
matching SHALL use the raw, case-sensitive request path, exactly as the bridge's checks do.

As a result, the following dispositions SHALL hold unchanged at the public origin:
- "API routes never reach the frontend bridge"
- "Non-GET unmatched requests keep the server's 404"
- "Trailing slash stays 404"
- "Non-API upgrade in production"

**Carve-out:** in this topology, shell and asset requests do not reach the server, so the
"Page requests pass through server middleware" guarantee is **not guaranteed** for them.
Access control for shell and asset requests is the upstream proxy's responsibility, and the
deployment documentation SHALL say so.

#### Scenario: Standalone output leaves single-process serving unchanged
- **WHEN** `npm run build && npm run start` runs after standalone output is enabled
- **THEN** the single-process server serves the shell, assets, and API exactly as before,
  and the existing e2e suites pass

#### Scenario: Same shell from both topologies
- **WHEN** `GET /sessions/abc` is requested from the single-process server and, for the
  same build, through the split topology's router
- **THEN** both respond `200` with the index shell from the same page component and no
  `Set-Cookie`

#### Scenario: Server middleware coverage of shell requests is not guaranteed in split topology
- **WHEN** the split topology is running with `IP_ALLOWLIST` set on the server and a
  non-allowlisted client requests `/` through the router
- **THEN** no requirement guarantees the request is rejected, while that client's `/api/*`
  requests are still rejected by the server
