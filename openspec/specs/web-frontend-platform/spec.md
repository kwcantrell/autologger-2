# web-frontend-platform Specification

## Purpose

How the web frontend is built, served, and booted — everything below the application's own
screens. This capability owns the Next.js (App Router) frontend compiled from `web/` and served
by the single Hono process through a catch-all bridge (or, in the split-container topology,
by Next's standalone server behind an internal router): the bridge's request handoff and its
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
decode-and-re-split segment values. Any other path, including the retired `/admin/users`,
SHALL fall through to the not-found page. The accepted segment shapes SHALL derive
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
The index application tree SHALL render as a client-only island (`ssr: false` dynamic
import from a client wrapper component): no server-side rendering or hydration of the
application tree. React StrictMode SHALL remain disabled for the index tree, preserving
today's semantics. (The admin tree and its separate island were retired with the
`/admin/users` page.) In-app navigation SHALL continue through the wouter-based
navigation funnel (`web/src/pages/index/navigation.ts`) with its synchronous
pre-render departure semantics unchanged; the Next layer SHALL NOT remount the island
across in-app navigations between router-known paths.

#### Scenario: In-app navigation does not remount the island
- **WHEN** a user navigates in-app from `/` to `/sessions/<id>` and back
- **THEN** the island component instance persists (departure-watcher and transport
  semantics fire exactly as before this change) and no full document load occurs

### Requirement: Server-rendered shell
The documents served for the router-known paths SHALL contain server-rendered layout chrome (document structure,
theme/body attributes, stylesheet and font references, and a static loading skeleton)
rather than an empty mount node, and the not-found page SHALL be statically rendered.
The skeleton SHALL contain no user- or session-derived data.

The document for the **router-known paths** SHALL additionally emit `<link rel="preload"
as="font" type="font/woff2" crossorigin>` for the three font faces on the critical path — the
Barlow latin subset at weights 400 and 600 (the UI face's body and emphasis weights) and the
League Gothic latin subset the loading skeleton itself renders in. Because that layout has no `<head>` element and Next's
`metadata` export has no preload API, the links are rendered in the body and hoisted to the
document head by React 19 — the supported route.

Two properties of those preloads are load-bearing:

- **The preload `href` and the CSS `src:` MUST resolve to the same URL.** A preload names an
  exact request; if the stylesheet then asks for a different URL, the preloaded bytes are dead
  weight and the font is fetched twice. Satisfying this is what forces those three faces onto
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
- **THEN** the document contains three `<link rel="preload" as="font" type="font/woff2"
  crossorigin>` elements whose `href`s are the same stable `/static/fonts/` URLs the
  stylesheet's `@font-face` `src:` declarations request

### Requirement: Single-process development
Development SHALL run only inside the dev compose stack (`make dev-up`). There, `npm run dev`
SHALL start one process serving pages, assets, API, and WebSockets on one origin (`:8787`,
through the dev gate), with Next dev-mode HMR for web edits. There SHALL be no second dev origin
and no dev proxy. The dev process SHALL bind loopback (`127.0.0.1`), pinned by the dev compose
file. Outside production mode the server SHALL default `HOST` to `127.0.0.1`, and it SHALL use one
effective host value both for binding and for its loopback checks (the AI v2 credentials rule). This preserves the
security posture of the retired Vite dev server's loopback pin: dev-mode source, framework dev
endpoints, and the HMR socket are not LAN-reachable. LAN device testing is unavailable during the
Supabase migration, until the stage stack is made reachable through the upstream proxy.

The server SHALL refuse to boot, exiting non-zero with a message that names `make dev-up` and no
environment values, unless `AUTOLOGGER_STACK` is one of `dev`, `stage` or `prod` (the compose
stack sentinel). It SHALL refuse to boot when `DATA_DIR` is unset or not an absolute path, and
SHALL NOT fall back to a default data directory. It SHALL refuse to boot when `BLOB_DIR` (the
audio blob root, shared by every server process: core-ports-architecture "Audio blobs are shared
by every server process") is unset or not an absolute path, and when `BLOB_DIR` and `DATA_DIR`
resolve to the same directory or either lies inside the other; each message names the variable
and prints no value, and SHALL NOT fall back to a default blob directory. These checks SHALL run
before the data-directory lock. It SHALL refuse to boot when any of `PGHOST`,
`PGPORT`, `PGUSER`, `PGPASSWORD` or `PGDATABASE` is unset, naming the missing variables and no
values, before taking the data-directory lock. It SHALL refuse to boot when another server
process already holds that `DATA_DIR`, before connecting to the catalog, sweeping or creating
anything in it. In every stack, it SHALL refuse to boot when
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` or `PUBLIC_BASE_URL` is unset or blank (a value that is
empty or only whitespace counts as blank), because no one could sign in, and when `REQUIRE_LOGIN`
is set to any value, the empty string included, so a stale setting fails loudly instead of being
ignored; each message names the variable and prints no value. A running server therefore always
reports `auth.oauth_configured: true`. In every stack, it SHALL also refuse to boot when
`BOOTSTRAP_OWNER_EMAIL` is unset or blank (the same trimmed rule), because no one could claim
the teams that have no owner (team-management, "Bootstrap owner"), and when it contains any
non-ASCII character, because the claim matches exact ASCII only; each message names the variable
and prints no value. A server that boots SHALL log a masked form of the value so the operator
can check it: the domain and a short hash of the normalized address, never the local part. `npm run dev` SHALL apply the same checks before starting its file watcher, so a
refused run exits instead of waiting for changes. No package script SHALL read a `server/.env`
file.

#### Scenario: Host boot is refused
- **WHEN** `npm run dev` is run on the host, outside any compose stack
- **THEN** it exits non-zero naming `make dev-up`, nothing listens on :8787, and no data
  directory is opened

#### Scenario: No implicit data directory
- **WHEN** the server boots with a valid `AUTOLOGGER_STACK` and `DATA_DIR` unset or relative
- **THEN** it exits non-zero naming `DATA_DIR`, and opens no data directory

#### Scenario: No implicit blob directory
- **WHEN** the server boots with a valid `AUTOLOGGER_STACK` and `DATA_DIR`, and `BLOB_DIR` unset
  or relative
- **THEN** it exits non-zero naming `BLOB_DIR`, prints no environment value, and creates nothing
  in either directory

#### Scenario: The blob directory may not overlap the data directory
- **WHEN** the server boots with `DATA_DIR=/data` and `BLOB_DIR` set to `/data`, `/data/blobs`
  or `/`
- **THEN** it exits non-zero naming `BLOB_DIR` and `DATA_DIR`, prints no environment value, and
  takes no data-directory lock

#### Scenario: Two servers share one blob directory
- **WHEN** a server holds `DATA_DIR=/a` with `BLOB_DIR=/blobs` and a second server starts with
  `DATA_DIR=/b` and the same `BLOB_DIR`
- **THEN** the second server boots, and each serves the audio the other stored

#### Scenario: Missing catalog connection settings refuse boot
- **WHEN** the server or `npm run dev` starts with a valid `AUTOLOGGER_STACK`, `DATA_DIR` and
  `BLOB_DIR`, and `PGPASSWORD` unset
- **THEN** it exits non-zero naming `PGPASSWORD`, prints no environment value, and creates
  nothing in the data directory

#### Scenario: A second server on the same data directory is refused
- **WHEN** a server holds a `DATA_DIR` and a second server process starts against it, whether
  by `npm run dev` or directly
- **THEN** the second process exits non-zero before connecting to the catalog or removing any
  scratch directory, and the running server is unaffected

#### Scenario: A stale REQUIRE_LOGIN refuses boot
- **WHEN** the server starts with a valid `AUTOLOGGER_STACK` and `REQUIRE_LOGIN=0` set
- **THEN** it exits non-zero naming `REQUIRE_LOGIN`, and nothing listens

#### Scenario: Missing Google client refuses boot
- **WHEN** the server starts with a valid `AUTOLOGGER_STACK` and `GOOGLE_CLIENT_ID` blank
- **THEN** it exits non-zero naming `GOOGLE_CLIENT_ID`, prints no environment value, and
  nothing listens

#### Scenario: Whitespace-only sign-in settings count as blank
- **WHEN** the server starts with a valid `AUTOLOGGER_STACK`, a non-blank `GOOGLE_CLIENT_ID`
  and `GOOGLE_CLIENT_SECRET`, and `PUBLIC_BASE_URL` set to only spaces
- **THEN** it exits non-zero naming `PUBLIC_BASE_URL`, prints no environment value, and
  nothing listens

#### Scenario: A blank bootstrap owner refuses boot
- **WHEN** the server or `npm run dev` starts with a valid `AUTOLOGGER_STACK`, the sign-in
  settings set, and `BOOTSTRAP_OWNER_EMAIL` unset or only spaces
- **THEN** it exits non-zero naming `BOOTSTRAP_OWNER_EMAIL`, prints no environment value, and
  nothing listens

#### Scenario: A non-ASCII bootstrap owner refuses boot
- **WHEN** the server starts with `BOOTSTRAP_OWNER_EMAIL` set to `Kalen@gmail.com`
- **THEN** it exits non-zero naming `BOOTSTRAP_OWNER_EMAIL` and prints no value

#### Scenario: The bootstrap owner is logged masked
- **WHEN** the server boots with `BOOTSTRAP_OWNER_EMAIL=Owner@Example.com`
- **THEN** its startup log names `example.com` and a short hash of `owner@example.com`, and
  contains neither `owner` nor `Owner` as the local part

#### Scenario: No package script reads server/.env
- **WHEN** every `package.json` script in the repository is inspected
- **THEN** none passes an env file to Node or tsx

#### Scenario: One origin in dev
- **WHEN** the dev server is running and a browser loads the app
- **THEN** pages, `/api/*` calls, and the session WebSocket all use the same origin, and
  editing a web component updates the page via HMR without a server restart

#### Scenario: Dev server is loopback-only by default
- **WHEN** the server starts outside production mode with no `HOST` set
- **THEN** it listens on `127.0.0.1`, is not reachable from other hosts, and treats itself as
  loopback-bound for its loopback checks

### Requirement: The client island is route-split behind recoverable boundaries

The single `ssr: false` client island SHALL NOT ship the whole application tree in one chunk.
Five surfaces SHALL be split out and loaded on demand: the **session workspace**
(`WorkspaceStatic`, mounted by `SessionRoute`), three **modals** — New Session, Batch Import and
YouTube Import Error — and the **Settings view**, an overlay that the shell's Settings affordance
and the `/teams` route both open (the separate teams route surface is retired into it). Surfaces that render on the very
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
  the session, so the wait is one continuous frame rather than two differently sized ones. The Settings view is an
  overlay boundary, including when `/teams` opens it.

Measured outcome (recorded for the original six-surface split; folding the teams route into the
Settings view does not add homepage-critical code, and its effect on the island set is re-measured
with the same instrument as evidence for that change): the homepage **island chunk set** falls from **581,762 B to 218,401 B**. The
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

Honest limits of what shipped, recorded here rather than implied away: only two of the five
boundaries are warmed (settings after a 2.5 s idle delay, the workspace on session-route entry);
there is **no busy affordance** on an invoking control during a cold chunk fetch, so activating
New Session or Batch Import on a cold chunk produces nothing on screen for the duration; there
is **no cancellation across the async gap**, so a pending overlay can land after the user has
navigated away; and the chunk-set measurement is **not scripted or regression-guarded**.

#### Scenario: A cold homepage load does not fetch the split chunks

- **WHEN** the homepage is loaded cold with no session open
- **THEN** the workspace, Settings view, and modal chunks are not among the scripts fetched for first
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

**No two `@font-face` declarations SHALL reference byte-identical font files.** (History: three
Inter faces were once byte-identical copies of one variable font and were merged into a single
range declaration.) The UI face is now **Barlow**, which ships as static per-weight files: each
declared weight SHALL map to its own distinct file, and no weight SHALL be declared that nothing
renders. Inter is retired together with its file once nothing references it.

**A declared `@font-face` SHALL correspond to a family something in `web/src` actually renders.**
The redesign's faces are Barlow (UI), Barlow Condensed (labels, tabs, status) and JetBrains Mono
(timecode and measured values only); the home wordmark keeps League Gothic.
The Chivo Mono and Oswald declarations, and their files, had zero references anywhere and SHALL
be deleted. This deletion's win is honestly bounded: an unreferenced `@font-face` never
downloads, so what it removes is source and build size, **not** transfer.

**The three faces on the critical path SHALL be served from stable, deliberately
non-content-hashed `/static/fonts/` paths in `web/public/`**, rather than being bundler-emitted
with a content hash — the Barlow latin subset at weights 400 and 600 and the League Gothic latin
subset the boot loading skeleton renders in. A build-invariant URL is what lets the root layout's preload
name the same request the stylesheet's `@font-face` `src:` makes (the matching-URL rule is
stated by `Server-rendered shell`); a hashed filename would change under the preload and fetch
the file twice. Accepted trade-off: these three files lose immutable content-hash caching. They
change approximately never. The remaining subsets and weights of those families (League Gothic latin-ext and vietnamese,
Barlow 500 and 700) and the other self-hosted families (Barlow Condensed, JetBrains Mono) stay
bundler-emitted asset imports.

Measured outcome (for the earlier Inter deduplication): −94 KB of font transfer per session-page
load. The Barlow switch's transfer is re-measured as evidence for that change.

#### Scenario: One Inter file per page

- **WHEN** a session page is loaded and rendered
- **THEN** no Inter `.woff2` is requested (the scenario keeps its historical name), and each Barlow
  weight the page renders is requested exactly once

#### Scenario: The preloaded faces are fetched once each

- **WHEN** a page in the index route group is loaded
- **THEN** the preloaded Barlow 400, Barlow 600 and League Gothic files are each requested exactly
  once — the
  preload and the CSS `src:` resolve to the same URL and share one request

#### Scenario: No declared family is unreferenced

- **WHEN** the stylesheet's `@font-face` families are enumerated and compared against the
  families referenced by `web/src`
- **THEN** every declared family is referenced by something that renders

### Requirement: The Companion presence heartbeat outlives tab backgrounding

While a page holds a session, the client SHALL keep its Companion presence entry fresh for as
long as the page is alive, **regardless of tab visibility**. The server ignores a presence entry
older than a fixed freshness window (`PRESENCE_FRESH_MS`, 15 s, defined in the presence port) and
deletes it after 60 s; Companion's active-session resolution requires a fresh entry, so a client
that stops reporting is dropped as a Companion target while its tab, its WebSocket, and possibly
an in-progress recording are all still alive. Presence is stored in the catalog and shared by
every server process (core-ports-architecture "Companion presence is shared by every process"),
and each entry records the signed-in user who posted it, so a Companion device follows only its
own user's pages (api-contract-freeze "Companion routes run as the caller's user"). The page
posts presence with its session cookie; the reporting cadence and the request body are unchanged
by that.

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
- **THEN** the single-process server serves the shell, assets, and API exactly as before

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
