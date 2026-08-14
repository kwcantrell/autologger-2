# web-frontend-platform Specification

## Purpose
TBD - created by archiving change nextjs-frontend-migration. Update Purpose after archive.
## Requirements
### Requirement: Next.js frontend served through the Hono bridge
The web frontend SHALL be a Next.js (App Router) application compiled from `web/`, served
by the existing Hono server process through a bridge catch-all: **GET** requests matching
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
The bridge SHALL run after the IP-allowlist and auth-context middleware, so page and
asset requests retain exactly the middleware coverage they have today. The server SHALL
NOT import any module under `web/src/**`, and the Next compilation graph SHALL NOT
include any module under `server/src/**` or `packages/**`.

In production the set of non-`/api`/`/auth` path families answered with anything other
than `404` SHALL be closed and enumerated: the four shell routes, `/_next/static/*`,
`public/`-served files (including `/static/*`), the not-found document, and the
framework's flight/RSC variants of the shell routes. The image optimizer endpoint
(`/_next/image`) SHALL NOT be served (`images.unoptimized`), and the framework's
`X-Powered-By` header and build/dev telemetry egress SHALL be disabled.

#### Scenario: API routes never reach the frontend bridge
- **WHEN** any `/api/*` or `/auth/*` request is handled
- **THEN** it is answered by the mounted Hono router, and the frontend bridge is not
  invoked for it

#### Scenario: Page requests pass through server middleware
- **WHEN** an `IP_ALLOWLIST` is configured and a non-allowlisted client requests `/`
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

### Requirement: WebSocket upgrade dispatch
The single HTTP server SHALL dispatch `upgrade` events by path: upgrades under `/api/`
SHALL go to the Hono WebSocket machinery (preserving the existing pre-upgrade
middleware and the env-identity contract unchanged); all other upgrades SHALL go to
Next's upgrade handler in dev mode and SHALL be destroyed in production. Because
upgrade dispatch happens at the raw server level, outside the Hono middleware chain,
non-`/api` upgrades SHALL be admitted to Next's handler only when the socket's remote
address passes the same IP-allowlist decision applied to HTTP requests; a socket
failing that decision SHALL be destroyed. The session WebSocket surface
(`GET /api/sessions/:id/ws`) SHALL behave exactly as before this change.

#### Scenario: Session WebSocket still upgrades
- **WHEN** a client opens `ws://<host>/api/sessions/<id>/ws?role=browser` for an
  accessible session
- **THEN** the upgrade completes through the Hono path and live `*.changed` frames are
  delivered as before

#### Scenario: Non-API upgrade in production
- **WHEN** a production server receives an upgrade request for a path outside `/api/`
- **THEN** the socket is destroyed without reaching the session WebSocket machinery

#### Scenario: Allowlist covers the dev HMR socket
- **WHEN** an `IP_ALLOWLIST` is configured and a non-allowlisted client attempts a
  non-`/api` WebSocket upgrade against a dev server
- **THEN** the socket is destroyed before reaching Next's upgrade handler

### Requirement: API-only fallback mode and boot ordering
WHEN the production server boots and the Next build output (`web/.next`) is missing, the
server SHALL warn loudly and run API-only: all `/api/*` and `/auth/*` surface behaves
normally, and unmatched paths respond `404` from the server. The server SHALL begin
accepting connections only after the frontend's `prepare()` has resolved (or after
API-only mode has been decided). A `prepare()` failure with a build directory present
SHALL fail the boot loudly — it SHALL NOT silently degrade to API-only mode.

#### Scenario: Missing build keeps the API alive
- **WHEN** the server starts in production with no `web/.next` present
- **THEN** a warning is logged, API endpoints respond normally, and `GET /` responds
  `404`

#### Scenario: Corrupt build fails the boot
- **WHEN** the server starts in production with `web/.next` present but `prepare()`
  rejecting (corrupt or truncated build, config error)
- **THEN** the boot fails with a loud error — the server does not come up API-only

### Requirement: Shell routing from the shared route definition
Next SHALL serve the index shell for exactly the router-known paths — `/`,
`/sessions/:id` (one non-empty raw segment), `/teams` — via a catch-all that validates
the segment list the framework provides, treating each raw path segment as exactly one
entry regardless of any percent-encoded separators it carries — the validator SHALL NOT
decode-and-re-split segment values — and the admin
shell at `/admin/users` via a concrete route. The accepted segment shapes SHALL derive
from the shared route-definition module (`web/src/shared/utils/loginReturnPath.ts`) via
a segment-shape helper added alongside `isRouterKnownPathname`. The module holds two
predicates with deliberately different domains — the deep-link predicate (excludes `/`)
consumed by the stash write and return-path validator, and the shell segment-shape
helper (includes `/`) consumed by the catch-all — and they SHALL NOT be merged. Any
other path SHALL yield `404`; trailing-slash variants of router-known paths (e.g.
`/teams/`) SHALL NOT be redirected to their canonical form and SHALL yield `404`,
matching pre-change behavior (enforced at the serving layer in front of the framework:
paths ending in `/`, other than `/` itself, are answered `404` by the server and never
reach the framework). Shell responses SHALL set no cookies and read no cookies;
for a fixed deployment and fixed request headers, the response SHALL NOT vary with
session/team existence, deletion state, or requester authorization, and SHALL embed no
session-derived or catalog-derived data. Shell routes SHALL be dynamically rendered
with no per-request persistence into the build directory (`web/.next` stays read-only
at runtime).

#### Scenario: Nested session path stays 404
- **WHEN** `GET /sessions/a/b` is requested
- **THEN** the response is `404` (three raw segments — not a router-known shape)

#### Scenario: Percent-encoded slash stays a single segment
- **WHEN** `GET /sessions/a%2Fb` is requested
- **THEN** the shell is served with `200` (one raw id segment whose decoded value
  contains `/`, matching pre-change behavior)

#### Scenario: Trailing slash stays 404
- **WHEN** `GET /teams/` or `GET /sessions/abc/` is requested
- **THEN** the response is `404` with no redirect, matching pre-change behavior

#### Scenario: No runtime writes to the build directory
- **WHEN** shell routes are requested repeatedly (including many distinct session ids)
  against a production server
- **THEN** no new files appear under `web/.next`

### Requirement: Client-island rendering
The index and admin application trees SHALL render as client-only islands (`ssr: false`
dynamic imports from client wrapper components): no server-side rendering or hydration
of the application trees. React StrictMode SHALL remain disabled for the index tree and
enabled for the admin tree (via an explicit subtree `<StrictMode>`), preserving today's
per-entry semantics. In-app navigation SHALL continue through the wouter-based
navigation funnel (`web/src/pages/index/navigation.ts`) with its synchronous
pre-render departure semantics unchanged; the Next layer SHALL NOT remount the island
across in-app navigations between router-known paths.

#### Scenario: In-app navigation does not remount the island
- **WHEN** a user navigates in-app from `/` to `/sessions/<id>` and back
- **THEN** the island component instance persists (departure-watcher and transport
  semantics fire exactly as before this change) and no full document load occurs

### Requirement: Server-rendered shell
The documents served for the router-known paths **and for the admin route
(`/admin/users`)** SHALL contain server-rendered layout chrome (document structure,
theme/body attributes, stylesheet and font references, and a static loading skeleton)
rather than an empty mount node, and the not-found page SHALL be statically rendered.
The skeleton SHALL contain no user- or session-derived data.

#### Scenario: First paint is not an empty root
- **WHEN** `GET /` is fetched without executing JavaScript
- **THEN** the response HTML contains the layout chrome and loading skeleton markup, not
  an empty root element

### Requirement: Single-process development
`npm run dev` SHALL start one process serving pages, assets, API, and WebSockets on one
port (:8787), with Next dev-mode HMR for web edits. There SHALL be no second dev origin
and no dev proxy. The dev process SHALL bind loopback (`127.0.0.1`) by default,
overridable via `HOST` — preserving the security posture of the retired Vite dev
server's loopback pin (dev-mode source, framework dev endpoints, and the HMR socket are
not LAN-reachable by default; LAN device testing goes through the production serve
path).

#### Scenario: One origin in dev
- **WHEN** the dev server is running and a browser loads the app
- **THEN** pages, `/api/*` calls, and the session WebSocket all use the same origin, and
  editing a web component updates the page via HMR without a server restart

#### Scenario: Dev server is loopback-only by default
- **WHEN** `npm run dev` is started with no explicit `HOST` override
- **THEN** the process listens on `127.0.0.1` and is not reachable from other hosts
