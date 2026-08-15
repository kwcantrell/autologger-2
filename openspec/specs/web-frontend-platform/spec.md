# web-frontend-platform Specification

## Purpose

How the web frontend is built, served, and booted — everything below the application's own
screens. This capability owns the Next.js (App Router) frontend compiled from `web/` and served
by the single Hono process through a catch-all bridge: the bridge's request handoff and its
`404`/fallback boundaries, the WebSocket upgrade dispatch that must not be swallowed by it,
API-only fallback mode and boot ordering, shell routing derived from the shared route
definition, the client-island rendering split, the server-rendered document shell (its static
loading skeleton and critical-font preloads), and single-process loopback-bound development.

It also owns the delivery-cost properties of that shell, which are easy to regress precisely
because nothing about the UI changes when they do: the client island is route-split behind
recoverable error boundaries so one route's bundle is not every route's; the self-hosted font
stack declares no byte-identical duplicate and no unreferenced face, and the two faces on the
critical path are served from stable paths the shell can preload against; and the Companion
presence heartbeat runs off an off-main-thread clock so a backgrounded tab is not throttled out
of being a valid Companion target.
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

The document for the **router-known paths** SHALL additionally emit `<link rel="preload"
as="font" type="font/woff2" crossorigin>` for the two font faces on the critical path — the
deduplicated Inter latin subset and the League Gothic latin subset the loading skeleton itself
renders in. (This applies to the index route group's layout; the admin route's document is
unchanged and emits no font preloads.) Because that layout has no `<head>` element and Next's
`metadata` export has no preload API, the links are rendered in the body and hoisted to the
document head by React 19 — the supported route.

Two properties of those preloads are load-bearing:

- **The preload `href` and the CSS `src:` MUST resolve to the same URL.** A preload names an
  exact request; if the stylesheet then asks for a different URL, the preloaded bytes are dead
  weight and the font is fetched twice. Satisfying this is what forces those two faces onto
  stable, build-invariant paths; where those files live and what that costs is owned by
  `Self-hosted font faces are deduplicated and scoped to what renders`, and is not restated
  here.
- **`crossorigin` is mandatory**, even same-origin. Fonts are always fetched in CORS mode, so a
  preload without it is a cache-key mismatch and the file downloads twice — the opposite of the
  intended effect.

#### Scenario: First paint is not an empty root
- **WHEN** `GET /` is fetched without executing JavaScript
- **THEN** the response HTML contains the layout chrome and loading skeleton markup, not
  an empty root element

#### Scenario: Critical fonts are preloaded with matching URLs
- **WHEN** `GET /` is fetched without executing JavaScript
- **THEN** the document contains two `<link rel="preload" as="font" type="font/woff2"
  crossorigin>` elements whose `href`s are the same stable `/static/fonts/` URLs the
  stylesheet's `@font-face` `src:` declarations request


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


### Requirement: The client island is route-split behind recoverable boundaries

The single `ssr: false` client island SHALL NOT ship the whole application tree in one chunk.
Six surfaces SHALL be split out and loaded on demand: the **session workspace**
(`WorkspaceStatic`, mounted by `SessionRoute`), the **teams route**, and four **modals** — New
Session, Batch Import, YouTube Import Error, and Home Settings. Surfaces that render on the very
first homepage paint — the rail, the home route, the login page, the root gate, and
`SessionRoute` itself — SHALL stay statically imported, because splitting them would only buy a
waterfall.

Each split point SHALL use **`React.lazy`**, not `next/dynamic`. This is load-bearing rather
than stylistic: under the App Router, `next/dynamic` resolves to an implementation with no
`.preload()`, no `.retry()`, and `error` hardcoded to `null`, while the vitest tier resolves the
react-loadable implementation that has all three. A warming or retry layer built on those APIs
would therefore pass its tests and be `undefined` in production. Plain `React.lazy` behaves
identically in both tiers, and warming is a bare `import()` of the same module-scope loader,
which webpack de-dupes against the `lazy()`'s own request.

Every boundary SHALL be wrapped in a **chunk-load error boundary**, because the island has no
error boundary above it (the `pageExtensions` pin means there is no `error.page.tsx`), so a
rejected chunk import would otherwise throw straight out of the island root and unmount the
entire app to a permanently blank page. The trigger is routine, not exotic: a redeploy rewrites
content-hashed chunk URLs, so any tab left open across a deploy fails its next lazy import.

The boundary's retry SHALL **rebuild the `lazy()` instance**. `React.lazy` memoizes the promise
it is handed, rejection included, so a module-scope `lazy()` that has failed re-throws forever —
resetting boundary state, remounting, or clicking Retry any number of times cannot make it call
`import()` again. Call sites SHALL therefore pass a referentially stable **loader**, and the
wrapper SHALL own the instance together with an attempt counter in one state object (so they
cannot drift), with the attempt used as the boundary's `key` so a retry both remounts the
boundary and issues a genuinely new fetch. A failure SHALL stay **local** to its own boundary: a
dead modal chunk shows a dismissible card over an intact route rather than taking the route
down. A non-chunk render error SHALL render a visible error surface with Reload only (no Retry,
which could not work) and SHALL be logged with its component stack rather than swallowed.

Fallback discipline SHALL follow the surface's role:

- **Overlay** boundaries use `null`. An inline fallback would paint as stray content in the
  document flow rather than as an overlay, and the overlays are already gated behind open flags
  over an unchanged page, so arriving a frame late costs no layout shift.
- **Route** boundaries use a real surface **identical to their pending state** — `SessionRoute`
  renders the same `RouteLoadingState` frame for the chunk fetch that it renders while resolving
  the session, so the wait is one continuous frame rather than two differently sized ones; the
  teams boundary renders that same frame with its own label and id.

Measured outcome: the homepage **island chunk set** falls from **581,762 B to 218,401 B**. The
**measurement instrument SHALL be recorded with the measurement**: Next's First Load JS table is
blind to this change, because every boundary lives inside the already-dynamic island chunk, so the
island's own chunk set — read from `react-loadable-manifest` — is the only valid instrument, and
the figures above are that instrument's. A number quoted from the First Load JS table is not
evidence about this requirement.

Stated as **total homepage-critical JS** — the page/layout shell plus the island set — the same
pair reads 936,699 B → 573,544 B. That is a different quantity, and it moves only because the
island half moves: the shell half is what remains after subtracting the island set from each
total, 354,937 B before and 355,143 B after — a 206 B difference, i.e. flat, with the entire
363 KB reduction coming from the island. The two pairs SHALL NOT be relabelled into each other,
and the island-set instrument clause above governs the island-set pair specifically.

Honest limits of what shipped, recorded here rather than implied away: only two of the six
boundaries are warmed (settings after a 2.5 s idle delay, the workspace on session-route entry);
there is **no busy affordance** on an invoking control during a cold chunk fetch, so activating
New Session or Batch Import on a cold chunk produces nothing on screen for the duration; there
is **no cancellation across the async gap**, so a pending overlay can land after the user has
navigated away; and the chunk-set measurement is **not scripted or regression-guarded**.

#### Scenario: A cold homepage load does not fetch the split chunks

- **WHEN** the homepage is loaded cold with no session open
- **THEN** the workspace, teams, and modal chunks are not among the scripts fetched for first
  paint

#### Scenario: A failed chunk fetch is scoped, not fatal

- **WHEN** a lazy import rejects because its content-hashed URL no longer exists
- **THEN** the owning boundary renders a retry/reload surface and the rest of the application
  stays mounted and interactive — the island does not blank

#### Scenario: Retry after a failed import can succeed

- **WHEN** the user activates Retry on a chunk-load failure and the module is now reachable
- **THEN** a fresh `lazy()` instance is built, a new network request is issued, and the surface
  renders — rather than re-throwing the cached rejection

#### Scenario: A modal chunk failure leaves the route intact

- **WHEN** a modal's chunk fails to load
- **THEN** a dismissible failure card appears over the route, the route beneath remains rendered
  and interactive, and dismissing it closes the modal's open flag


### Requirement: Self-hosted font faces are deduplicated and scoped to what renders

The self-hosted font stack SHALL declare no redundant and no unused faces.

**No two `@font-face` declarations SHALL reference byte-identical font files.** Three Inter faces
(weights 400, 500, and 600) were byte-identical copies of the same variable font carrying the
full weight axis, so the browser downloaded the same ~48 KB file three times to render one
typeface. They SHALL be a single `@font-face` whose `font-weight` is the **range** `400 600`,
letting the variable axis serve every weight the app asks for.

**A declared `@font-face` SHALL correspond to a family something in `web/src` actually renders.**
The Chivo Mono and Oswald declarations, and their files, had zero references anywhere and SHALL
be deleted. This deletion's win is honestly bounded: an unreferenced `@font-face` never
downloads, so what it removes is source and build size, **not** transfer.

**The two faces on the critical path SHALL be served from stable, deliberately
non-content-hashed `/static/fonts/` paths in `web/public/`**, rather than being bundler-emitted
with a content hash — the deduplicated Inter latin subset and the League Gothic latin subset the
boot loading skeleton renders in. A build-invariant URL is what lets the root layout's preload
name the same request the stylesheet's `@font-face` `src:` makes (the matching-URL rule is
stated by `Server-rendered shell`); a hashed filename would change under the preload and fetch
the file twice. Accepted trade-off: these two files lose immutable content-hash caching. They
change approximately never. The remaining subsets of those families (League Gothic latin-ext and
vietnamese) and the other self-hosted families stay bundler-emitted asset imports.

Measured outcome: −94 KB of font transfer per session-page load.

#### Scenario: One Inter file per page

- **WHEN** a session page is loaded and rendered
- **THEN** exactly one Inter `.woff2` is requested, and it serves every Inter weight the page
  renders

#### Scenario: The preloaded faces are fetched once each

- **WHEN** a page in the index route group is loaded
- **THEN** the preloaded Inter and League Gothic files are each requested exactly once — the
  preload and the CSS `src:` resolve to the same URL and share one request

#### Scenario: No declared family is unreferenced

- **WHEN** the stylesheet's `@font-face` families are enumerated and compared against the
  families referenced by `web/src`
- **THEN** every declared family is referenced by something that renders


### Requirement: The Companion presence heartbeat outlives tab backgrounding

While a page holds a session, the client SHALL keep its Companion presence entry fresh for as
long as the page is alive, **regardless of tab visibility**. The server prunes a presence entry
after a fixed freshness window (`PRESENCE_FRESH_MS`, 15 s) and Companion's active-session
resolution requires a fresh entry, so a client that stops reporting is dropped as a Companion
target while its tab, its WebSocket, and possibly an in-progress recording are all still alive.

The reporting interval SHALL stay strictly under that window in every visibility state. It is
currently 5 s while visible and 10 s while hidden — the hidden cadence is a traffic reduction,
**not** a pause, and SHALL NOT be widened to or past the freshness window. A visibility change
SHALL additionally report immediately, so a hide or show is observable to Companion at once
rather than at the next tick, and a change to whether audio is playing SHALL likewise report
once without restarting the interval.

The interval SHALL NOT depend on a main-thread timer. Chrome applies intensive throttling to
main-thread timers in a tab hidden longer than five minutes, coalescing them to roughly one
wakeup per minute — four times the freshness window — and an open WebSocket does not exempt the
page. The clock therefore runs off the main thread (a dedicated worker created from a Blob URL,
which intensive throttling does not apply to). Where a dedicated worker cannot be created — no
`Worker`, no Blob URL, or a Content-Security-Policy that denies `blob:` workers — the
implementation SHALL fall back to a main-thread timer and SHALL treat the sub-window guarantee as
not holding on that path, documented at the call site rather than silently assumed. A worker that
fails **asynchronously** (the CSP case: the constructor returns and the failure arrives as an
error event) SHALL be detected and SHALL re-arm the fallback, because a worker that never ticks
is strictly worse than the main-thread timer it replaced.

This is a property a future reader is likely to "optimize" away: pausing the heartbeat while
hidden looks like an obvious saving and silently costs the operator Companion control of a
backgrounded tab. A fake-timer test cannot observe browser throttling, so tests SHALL NOT be read
as evidence that a main-thread cadence is sufficient.

#### Scenario: A backgrounded tab stays a valid Companion target
- **WHEN** a page holding a session is hidden for longer than the server's presence freshness
  window, including beyond the five-minute intensive-throttling threshold
- **THEN** presence reports continue at a cadence under that window, and Companion commands
  addressed to that session continue to resolve rather than failing with no-active-session

#### Scenario: Visibility and playback changes report immediately
- **WHEN** the tab is hidden or shown, or the playing state changes
- **THEN** a presence report is sent at once carrying the new state, and the periodic interval
  is not restarted by it

#### Scenario: A worker-less environment degrades to a documented weaker guarantee
- **WHEN** a dedicated worker cannot be created, or an already-created worker fails
  asynchronously
- **THEN** reporting continues on a main-thread timer, and the sub-window guarantee is recorded
  as not holding on that path rather than being claimed
