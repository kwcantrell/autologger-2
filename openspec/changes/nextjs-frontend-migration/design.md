# Design: nextjs-frontend-migration

## Context

The frontend is a Vite 8 / React 19 MPA (`web/`) with two HTML entries, proxied in dev
from :5173 into the Hono server on :8787; in production the server serves `web/dist` via
four explicit HTML routes plus a `serveStatic` catch-all (`server/src/app.ts`). The user
goals are a unified single stack/process, SSR/faster shell loads, and Next.js DX, deployed
self-hosted (Docker or plain Node), never serverless. Hard invariants that bound the
design: the frozen HTTP/WS contract (`api-contract-freeze`), the single long-lived Node
process, and the `@hono/node-ws` upgrade path's dependence on `c.env` object identity.

**Current state, measured on `main` @ `48998fb` (clean tree):**

- `web/package.json`: react/react-dom `^19.0.0`, wouter `^3.10.0`, tailwindcss `^4.3.2`,
  vite `^8.0.0` (dev). No `next` dependency anywhere in the workspace.
- `server/src/app.ts:97-126`: the static block — `serveHtml` helper, explicit routes `/`,
  `/sessions/:id`, `/teams` → `src/pages/index/index.html`, `/admin/users` →
  `src/pages/admin-users/index.html`, then `app.get('*', serveStatic({ root: publicDir }))`.
  The env-identity comment block sits at `app.ts:40-62`.
- `server/src/middleware/ipAllowlist.ts:161`: client IP read from
  `c.env.incoming?.socket?.remoteAddress` — the raw Node request is already on `c.env`.
- `@hono/node-server` 1.19.14 installed; `RESPONSE_ALREADY_SENT` is exported from
  `@hono/node-server/utils/response` (verified in `dist/utils/response.d.ts`; the package
  exports map includes `./utils/*`).
- `web/vite.config.ts`: `sessionDeepLinkDevShell` plugin (line 28), `/api` + `/auth`
  proxy with `ws: true`, loopback host pin — all to be retired.
- `web/src/shared/utils/loginReturnPath.ts:53`: `isRouterKnownPathname` exists and its
  doc comment already designates it the single route predicate to extend.
- `openspec/specs/web-session-routing/spec.md:34-38` normatively requires the three-way
  route-table mirror this change retires; `openspec/specs/api-contract-freeze/spec.md`
  "Session deep-link HTML route" pins "the same document body served at `/`";
  `openspec/specs/cursor-agent-adapters/spec.md:127` requires the restart rule to state a
  "`:5173` (Vite) disposition". All three receive deltas.
- Inherited deferral pointers relied on: none — this change starts from the archived
  baselines above.

## Goals / Non-Goals

**Goals:**
- One process, one origin: Next.js 15 (App Router) serves the HTML/asset layer through
  the existing Hono server; dev and prod both run at :8787.
- Frozen `/api`/`/auth`/WS surface byte-identical by construction (Hono routers unmodified).
- Server-rendered shell (layout chrome, fonts, loading skeleton) replacing the blank
  `#root` first paint; heavy app trees stay client-only (`ssr: false`).
- Retire the three-way route-table mirror in favor of the one shared route-definition
  module.
- Keep every guard test's protection equivalent or stronger.

**Non-Goals:**
- Rewriting API routes as Next route handlers; SSR/hydration of the heavy islands;
  changing in-app navigation semantics; Turbopack; `output: 'standalone'`;
  Vercel/serverless; multi-replica scaling; visual redesign.

## Decisions

### D1. Custom-server shape: Hono stays outermost; Next bridged from a Hono catch-all

`server/src/main.ts` keeps `serve({ fetch: app.fetch })` from `@hono/node-server`. The
static block in `app.ts` is replaced by a catch-all that calls a new injected
`frontend: { handle(incoming, outgoing): Promise<void> }` (implemented by
`server/src/node/nextFrontend.ts` wrapping `next({ dev, dir: <repo>/web })` +
`prepare()`), then returns `RESPONSE_ALREADY_SENT` (imported from
`@hono/node-server/utils/response`). When `frontend` is absent (HTTP tests, API-only
mode), unmatched paths 404 from Hono exactly as an asset miss does today.

- **Alternative considered — raw `http.createServer` prefix dispatcher in front of both
  apps**: rejected. It would silently drop IP-allowlist and auth-context coverage for
  HTML routes (both are registered on `'*'` before the catch-all and today cover page
  requests), and it would create a second place where the `/api` prefix is interpreted.
  With the bridge, mount order alone guarantees `/api`/`/auth` can never be shadowed by
  Next, and the env-identity WebSocket contract is untouched because the Hono pipeline is
  untouched.
- **Alternative considered — `next start` as a separate process behind a proxy**:
  rejected; violates the single-process invariant and reintroduces the two-origin split
  this change exists to remove.

**Upgrade dispatch.** `injectWebSocket` must not see Next's dev-HMR WebSocket (it
terminates sockets whose route doesn't complete an upgrade), and Next must not see
`/api/sessions/:id/ws`. `main.ts` installs a single `server.on('upgrade')` dispatcher:
paths under `/api/` go to Hono's upgrade handler — captured by passing `injectWebSocket`
a stub `{ on(event, handler) }` object instead of the real server (verified: the
installed `@hono/node-ws` 1.3.1 `injectWebSocket` registers exactly one
`server.on('upgrade', …)` listener and touches no other server property) — everything
else goes to Next's dev upgrade handler in dev and is destroyed in prod.
**Apply-time correction (task 4.3 fix, 2026-08-13):** the dev handler is the
`upgradeHandler` property GETTER on the Next custom-server object (router-server's
real dispatcher → `hotReloader.onHMR`), NOT the `getUpgradeHandler()` method — that
method resolves to render-server `handleUpgrade()`, a documented no-op in next
15.5.23 that silently drops sockets mid-handshake (this broke dev HMR until
root-caused; pinned by a unit test). Next's `blockCrossSite` runs on HMR upgrades —
warn-only while `allowedDevOrigins` is unset; if a future Next blocks by default,
add `allowedDevOrigins: ['127.0.0.1']` to `web/next.config.ts`. **Panel
fixes (2026-08-13):** (a) non-`/api` upgrades are admitted to Next's handler only when
the socket's remote address passes the same IP-allowlist decision applied to HTTP
requests — upgrade dispatch happens at the raw server level, outside Hono's middleware,
so without this check a configured `IP_ALLOWLIST` would not cover the dev HMR socket;
(b) today a stray-path upgrade gets an HTTP-status close through the node-ws replay
(`socket.end('HTTP/1.1 404 …')`) while the new prod path destroys the socket — this is
declared in the `api-contract-freeze` delta rather than left implicit. This dispatcher
is the riskiest integration point and gets its own task and e2e verification (session
WS + dev HMR both alive; non-allowlisted upgrade destroyed).

**Bridge guards (panel fixes 2026-08-13).** The `@hono/node-ws` upgrade replay calls
`app.request(url, {headers}, env)` with `env = { incoming, outgoing: undefined }`, and
plain `app.request()` tests do the same — so the bridge catch-all can be reached with
no writable response object. The bridge therefore: (a) is mounted for **GET only**
(Hono answers HEAD through GET handlers) — non-GET unmatched requests keep 404ing from
Hono exactly as they do today via `app.get('*', serveStatic)`, avoiding an unauthorized
404→405/Next-status drift; (b) falls back to Hono's 404 when `c.env.outgoing` is absent
(`Bindings` gains an explicit `outgoing?`); (c) catches `frontend.handle()` rejections
itself — if Next already started writing, log and return the sentinel (never let
`onError` compose a second response onto a half-written socket); rethrow only when no
headers have been sent.

**Boot ordering (panel fix 2026-08-13).** The server begins accepting connections only
after `prepare()` resolves (or after API-only mode is decided). A `prepare()` rejection
with a build directory *present* fails the boot loudly — it is a broken deploy, not a
missing frontend, and must not silently degrade to API-only. **API-only mode** is
otherwise preserved: prod boot with `web/.next` missing warns loudly and runs API-only
(warning text updated from `web/dist`).

**Global-object caveat (panel finding 2026-08-13).** `@hono/node-server`'s
`getRequestListener` replaces `global.Request`/`global.Response` with lightweight
proxies at `serve()` time, and Next's `prepare()` patches `global.fetch` for its cache
instrumentation. The frozen server behavior relies on global `fetch` (JWKS verify,
DeepGram, AI runtime). A dedicated verification task exercises a global-`fetch` flow in
the combined process after `prepare()`; `@hono/node-server`'s `overrideGlobalObjects:
false` option is the documented lever if the proxies and Next's patch interact badly.

**Env-loading order (deliberate invariant).** `createBindings(process.env)` snapshots
config *before* `next()` is instantiated; `prepare()` auto-loads `web/.env*` into
`process.env`. The snapshot-first ordering is load-bearing — server config must never
be sourced from a web-side dotfile. Server secrets belong in `server/.env` only, and
`web/.env*` stays gitignored.

**Shutdown**: `await frontend?.close()` joins the SIGINT/SIGTERM path without being
serialized before `server.close()`; the 5 s failsafe and `closeAllConnections()` stay.

**Module-graph separation (deliberate invariant — do not "helpfully" undo).** The server
imports the `next` package but never `web/src/**`; Next compiles `web/src/**` but never
`server/src/**`. Consequence: Next dev-HMR cannot double-instantiate server singletons
(SQLite handles, SessionHubRegistry, presence) *by construction*, and the web↛packages
boundary keeps meaning something. Any future "just import the component from the server"
or "share this util across the seam" edit breaks this invariant.

`nextFrontend.ts` joins `server/src/node/` (composition-root wiring role); the
name-pinned membership test from `feature-service-packages` is updated in the same task
that adds the file.

### D2. Workspace: `web/` becomes the Next app in place

Keep the workspace, guard tests, and `@/api|@/shared|@/pages` aliases (Next reads
tsconfig `paths` natively). Add `web/src/app/**`, `web/next.config.ts`,
`web/postcss.config.mjs`, a standalone `web/vitest.config.ts`, `next-env.d.ts`; accept
and commit Next's managed tsconfig edits. **Apply-time deviations (task 2.3, recorded
2026-08-13):** (1) Next's legacy Pages Router detection unconditionally claims
`web/src/pages/` — the App Router special files therefore use
`pageExtensions: ['page.tsx', 'page.ts']` and carry a `.page.` suffix
(`layout.page.tsx`, `page.page.tsx`, …), leaving the existing `pages/` tree invisible
to Next's router; (2) Next has no default loader for `.webm`, so `next.config.ts`
adds a webpack `asset/resource` rule for it. Delete `web/vite.config.ts`, both `index.html`s,
both `main.tsx` entries. `webBoundaries.repo.test.ts` scans `web/src` from disk so
`app/` enters its scope automatically; its entry-bundle-isolation rules are rewritten
from `main.tsx`/`index.html` to the `app/` entry files, and one layering rule is added:
`app/` may import `pages`/`api`/`shared`; nothing imports `app/`.

- **Alternative — new `web-next/` workspace, migrate page-by-page**: rejected; doubles
  the guard-test surface, splits the atlas model, and the app is small enough (two
  entries) to cut over atomically behind phase gates.

### D3. Routing: wouter + navigation funnel stay in the client island; Next is the shell router

`departureWatcher.ts` requires the transport stop to fire **synchronously before** React
observes a location change. `next/navigation`'s `router.push` is transition-based with no
pre-render hook, so in-app navigation keeps wouter and the mandated `navigation.ts`
funnel. **Honest mechanism statement (panel-corrected 2026-08-13):** wouter composing
with Next rests on Next ≥14.1's native-history support — Next patches
`window.history.pushState`/`replaceState` and its `popstate` listener restores state
without an RSC navigation. "Every shell path renders the same page component" is
necessary but not sufficient (same component ≠ same instance if Next performs a real
navigation between URLs under `[[...path]]`). This is version-sensitive framework
behavior that no local check can verify (`next` is not yet installed), so **phase 2
includes a spike task that gates phase 3**: minimal Next app + wouter island, asserting
(a) pushState across `/`, `/sessions/:id`, `/teams` triggers no RSC refetch and no
island remount, (b) browser Back/Forward (popstate double-handling: Next's listener +
the departure watcher's) preserves the departure-watcher ordering, (c) the
encoded-slash and trailing-slash behaviors below, (d) no runtime writes appear under
`web/.next`. The verified Next version is pinned.

- `web/src/app/(index)/[[...path]]/page.tsx` — optional catch-all validating the
  **decoded segment list** Next hands it: `[]`, `['sessions', <one non-empty segment>]`,
  or `['teams']`; anything else calls `notFound()`. **Panel-corrected, then
  measurement-corrected wording (2026-08-13):** the load-bearing property is that one
  raw path segment arrives as exactly one params entry and the validator never
  decodes-and-re-splits. (Apply-time measurement on Next 15.5.23, task 2.3: params
  arrive with segments still percent-ENCODED — `/sessions/a%2Fb` →
  `['sessions', 'a%2Fb']` — not decoded as the panel-era wording assumed. The outcome
  is identical either way: two entries → shell; `isShellSegments` checks shape and
  non-emptiness only. Deriving naively from `SESSIONS_ROUTE_RE`'s `[^/]+` against a
  decoded value would have wrongly 404'd the encoded form — the never-re-split rule
  stands regardless of encoding.) `/sessions/a/b` arrives as 3 entries → 404, matching
  today. The accepted
  shapes derive from the shared route-definition module (`loginReturnPath.ts`): a
  segment-shape helper is added alongside `isRouterKnownPathname` so the stash write,
  the return-path validator, and the Next catch-all consume one definition (AppShell's
  wouter route strings cannot mechanically import the predicate — they remain the one
  sanctioned mirror, kept in lockstep per the `web-session-routing` delta). Note the module deliberately holds **two predicates with different
  domains**: `isRouterKnownPathname` (deep-link set — excludes `/`) for the stash write
  and return-path validator, and the segment-shape helper (shell set — includes `/`)
  for the catch-all; they must not be "unified". **This retires the three-way lockstep
  mirror** (`web-session-routing` delta).
- **Rendering mode (panel decision 2026-08-13): the catch-all shell is
  `force-dynamic`.** Next's default for a dynamic route without `generateStaticParams`
  is on-demand static generation — first request per id would persist per-id HTML into
  `web/.next` at runtime, racing the two hermetic e2e servers sharing one `.next`,
  opening unbounded attacker-driven disk growth on an unauthenticated route, and adding
  `x-nextjs-cache` header variance. `force-dynamic` keeps `web/.next` read-only at
  runtime (asserted by a task) and is cheap for a static client-island shell.
- **Trailing slash (panel decision 2026-08-13; mechanism corrected by apply-time
  measurement + owner ruling, 2026-08-13):** today `/teams/` 404s and the delta pins
  that. Measured on Next 15.5.23 (task 2.3's live smoke test): `skipTrailingSlashRedirect:
  true` suppresses only the 308 — the catch-all still normalizes the trailing slash for
  route matching, so `/teams/` reached the shell (200). The original design assumption
  (`['teams', '']` failing shape validation) does not hold. **Enforcement therefore
  lives in the Hono bridge** (task 3.2): any path ending in `/` except `/` itself gets
  Hono's 404 and is never bridged — a route-table-free rule that exactly reproduces
  today's `serveStatic` behavior (no asset path ends in `/`). The pinned 404 status is
  unchanged; its body is Hono's 404, which the delta leaves unpinned.
  `skipTrailingSlashRedirect: true` stays in `next.config.ts` as defense-in-depth
  (trailing-slash paths never reach Next through the bridge, so no 308 can leak).
- `web/src/app/(admin)/admin/users/page.tsx` — concrete route (static segments win over
  the catch-all); root `not-found.tsx`.
- Shell pages are static client-island wrappers: they read no cookies, set none —
  "unknown session id serves the shell, no auth at the HTML layer" holds by construction.
- **Heavy islands render `ssr: false`** via a client wrapper using
  `dynamic(() => import(...), { ssr: false })` (App Router requires the `ssr: false`
  call inside a client component). Rationale: today's product is 100% client-rendered
  into an empty `#root`; hydrating the 26k-LOC tree (MediaRecorder, AudioContext,
  `matchMedia` breakpoints, the module-singleton coordination registry) buys nothing and
  creates the entire hydration-mismatch risk class, and zero-hydration parity protects
  the pixel-exact visual suites. The wrappers are the **designated seam** for future SSR
  adoption (user: SSR is a future goal).

- **Alternative — full `next/navigation` adoption**: rejected; no synchronous pre-render
  navigation hook (breaks the departure-watcher contract), and per-route RSC navigation
  would remount the workspace across in-app transitions.

### D4. Two Vite entries → two route groups with separate root layouts

App Router over Pages Router (recorded rationale, panel request): the per-entry
`<html>`/body-attribute/StrictMode split needs multiple root layouts, which only route
groups provide (Pages Router has a single `_document`), and the user's SSR-later goal
runs through the RSC path.

- `(index)/layout.tsx`: `<html lang="en">`, `<body data-v4-transport="rolling">`,
  metadata title `AutoLogger`, theme color `#070b14` — **exported from the `viewport`
  export, not `metadata`** (Next 15 rejects `themeColor` in `metadata`; panel fix
  2026-08-13) — explicit metadata icons pointing at the existing `/static/...` paths
  (no `app/icon.png` convention — head output stays equivalent).
- `(admin)/layout.tsx`: theme color `#1e2129` (same `viewport` mechanism), title
  `AutoLogger — Admin Users`.
- `main.tsx` bodies become `IndexRoot.tsx` / `AdminRoot.tsx` components (provider trees
  unchanged). Cross-group navigation is a full page load — matching today's MPA behavior.
- **StrictMode**: `reactStrictMode: false` globally (the index tree must not
  double-invoke — load-bearing for the departure watcher and coordination registry);
  `AdminRoot` restores its current behavior by wrapping its subtree in an explicit
  `<StrictMode>` element (supported React semantics). Net: identical to today.

### D5. CSS / assets

- Tailwind v4: `@tailwindcss/vite` → `@tailwindcss/postcss`. `tailwind.css` (with
  `@layer`/`@theme`/30 `@font-face` and relative font urls) compiles unchanged; fonts
  emit as hashed `/_next/static/media/*` — same bytes, new URLs.
- `tailwind.css` then `overlayscrollbars/overlayscrollbars.css` are imported **in the
  group layouts, in that order** — centralizing in layouts pins cascade order (App
  Router CSS-ordering drift is a known footgun; visual suites are `maxDiffPixels: 0`).
  The AppShell-level CSS import is removed.
- `web/public/static/*` already matches Next's `public/` convention: `/static/...` URLs
  preserved verbatim, zero moves.
- The 2 png / 1 webm module imports become `StaticImageData`-shaped: touch the 3 call
  sites (`LoginPage.tsx`, `AdminUsersPage.tsx`, `loadingVideo.ts` — fact-check corrected
  from 4; `ChunkRescueBanner` has no asset import) to use `.src`; replace
  `web/src/types/assets.d.ts`. The `package.json` version import
  (`appVersion.ts`) works as-is.

### D6. Static-serving handoff + declared observable deltas

Delete `serveHtml`, the four HTML routes, and the `serveStatic` catch-all from `app.ts`.
Declared deltas (user-accepted 2026-08-13; extended by panel findings the same day;
authorized by this change's `api-contract-freeze` delta):

1. Shell HTML is Next-rendered. Page identity (same route group/layout/page component;
   responses across router-known paths differ only in the framework's serialized URL
   data) and the no-existence-oracle property are preserved, but byte-identity with `/`
   no longer holds — Next embeds the requested route in the document. **The oracle
   property is stated as header-fixed invariance, not literal determinism** (panel fix):
   for a fixed deployment and fixed request headers, the response varies with neither
   session/team existence nor deletion state nor requester authorization, and embeds no
   session- or catalog-derived data; it MAY vary with content-negotiation headers the
   framework defines (e.g. `RSC: 1` returns a flight payload) and across deployments
   (buildId).
2. Non-inventory 404 bodies become Next's not-found HTML; the frozen spec pins *status*
   only (verified against the baseline text), and status stays 404. Non-GET unmatched
   requests never reach Next (GET-only bridge) — their 404s are unchanged.
3. Hashed bundles move `/assets/*` → `/_next/static/*`; `/static`/`/_next` caching
   headers come from Next. The old `/assets/*` paths were never part of the frozen
   `/api`+`/auth` inventory.
4. **Closed set of Next-answered path families in production** (panel fix — anything
   outside it is a drift bug, not an accident): the four shell routes, `/_next/static/*`,
   `/static/*` + other `public/` files, the not-found document, and the RSC flight
   variants of the shell routes. `next.config.ts` disables what would otherwise ship by
   default: `images: { unoptimized: true }` (no `/_next/image` optimizer — the app uses
   plain `<img>`; the optimizer is an unauthenticated compute endpoint with a CVE
   history), `poweredByHeader: false`, `skipTrailingSlashRedirect: true` (D3), and
   telemetry disabled via `NEXT_TELEMETRY_DISABLED=1` in scripts (this repo's posture is
   that every network egress is disclosed; Next's build/dev telemetry is egress).
5. Stray-path (non-`/api`) WebSocket upgrades in production are destroyed, where today
   they receive an HTTP-status close through the node-ws replay. Declared in the
   `api-contract-freeze` delta.

### D7. Tests

- **Vitest stays** for web unit/jsdom tests: a standalone `web/vitest.config.ts`
  (`@vitejs/plugin-react` + jsdom + the three aliases); `vite`/`@vitejs/plugin-react`
  remain devDeps for vitest only. Component tests need path updates, not rewrites.
- `server/src/routers/staticServing.int.test.ts` is rewritten from fixture-dist
  assertions to **dispatch-contract** assertions against a stub `frontend`: API routes
  never bridge; `/`, `/sessions/:id`, `/teams`, `/admin/users`, and asset paths do; the
  IP allowlist still covers page requests. (Rule: the bridge is a new seam — it gets
  characterization coverage before cutover, not just "suites pass".) Shell-content
  behavior is covered end-to-end by the e2e specs.
- e2e: `playwright.config.ts` webServer commands stay `npm run start -w server`; the
  root `e2e*` scripts' web build becomes `next build`; webServer timeout bumped (prod
  `prepare()` startup); the two hermetic servers share `web/.next`, which stays
  genuinely read-only at runtime because the shell is `force-dynamic` (D3) — asserted
  by a no-runtime-writes check, not assumed.
- Visual suites: zero-diff target; any diff is inspected, and baselines are regenerated
  only deliberately (user-accepted 2026-08-13).

### D8. web-docs atlas

`web-docs/model/components.ts` globs are repartitioned (`web/src/app/**` added to the
web components, deleted-file pins removed); the edges snapshot regenerates;
`npm run docs:check` gates the phase and re-runs at branch completion and archive. The
new `web-frontend-platform` capability is attached in `components.ts` in the archive
commit per the final-gates rule.

### D9. SSR easy wins (in scope by user mandate, additive above the islands)

1. Server-rendered layout chrome + a static loading skeleton that the island replaces
   on mount — real HTML/fonts/theme on first paint (the tangible "faster loads" win).
   **Panel rework (2026-08-13):** the skeleton is a **single shared React component**
   rendered both as the `dynamic()` `loading` fallback and by the island's own loading
   branch — one definition, no hand-maintained mirror of client loading UI (the change
   is elsewhere retiring exactly that mirror shape). It contains no user- or
   session-derived data. Done-ness is a checkable jsdom assertion (the fallback and the
   loading branch render the same component), not an unmeasurable "does not visibly
   jump" criterion.
2. `not-found.tsx` statically rendered.
3. **Cookie-forwarding `/api/profile` prefetch: DEFERRED (gate ruling E1,
   2026-08-13).** The panel (all four reviewers) found it contradicts this change's own
   delta specs as written (shell responses read no cookies and embed no catalog data),
   makes shell HTML per-user, and needs a bespoke hydration channel into an `ssr:false`
   island this design never sketched. The gate accepted the panel's recommendation:
   it is **out of this change's scope** and gets its own future change with its own
   carve-out delta and auth-focused review. The shell requirements in this change's
   deltas therefore stand unqualified.

### D10. Dev workflow

Single combined process (user decision 2026-08-13): `tsx watch src/main.ts` with
`next({ dev: process.env.NODE_ENV !== 'production' })`. Web edits → Next HMR (webpack
pipeline; Turbopack is unavailable under a custom server); server edits → process restart
+ re-`prepare()` (amortized by the on-disk `.next` cache). Root `dev` collapses to
`npm run dev -w server`; the Vite proxy and dev-shell plugin are deleted. Dev OAuth
round-trips same-origin at :8787 for the first time (the Vite proxy could never carry
the Google callback).

**Dev bind posture (panel fix 2026-08-13 — the loopback pin gets a successor, not a
deletion).** Today the dev frontend (source modules, HMR, transform pipeline) is
loopback-pinned at `:5173` by `web/vite.config.ts`, a documented guardrail; the server's
`HOST` default is `0.0.0.0`. Deleting the pin while moving the dev frontend onto the
`0.0.0.0` server would expose source, Next dev endpoints (`/__nextjs_*`), and the HMR
socket to the LAN by default — and the HMR socket sits on the upgrade path, outside
Hono's middleware, so even a configured `IP_ALLOWLIST` would not cover it without D1's
dispatcher check. Disposition: **the dev script sets `HOST=127.0.0.1` by default**
(overridable); LAN device testing continues through the prod serve path
(`npm run build && npm run start`), exactly the posture CLAUDE.md documents today. The
CLAUDE.md guardrail is ported (rationale intact), not deleted (task 6.2).

## Risks / Trade-offs

- [Upgrade-dispatch fragility — `injectWebSocket` vs Next's HMR socket] → dedicated
  task; stub-capture of Hono's upgrade handler; e2e checks that the session WS and dev
  HMR both stay alive; prod destroys non-`/api` upgrades; non-`/api` upgrades pass the
  IP-allowlist decision before reaching Next.
- [Next's history patching double-handles popstate with the departure watcher; a real
  RSC navigation between catch-all URLs would remount the island] → phase-2 spike
  gates phase 3 (pushState no-refetch/no-remount, Back/Forward ordering, pinned Next
  version); catch-all shape keeps all shell paths on one page component.
- [Global-object patching: `@hono/node-server` proxies `global.Request`/`Response` at
  `serve()`; Next patches `global.fetch` at `prepare()`] → post-`prepare()` verification
  task exercises a global-`fetch` flow (JWKS path); `overrideGlobalObjects: false` is
  the fallback lever.
- [Runtime writes into `web/.next` (on-demand static generation): e2e share-race,
  attacker-driven disk growth on an unauthenticated route, cache-header variance] →
  shell is `force-dynamic`; a task asserts no runtime writes under `web/.next`.
- [Hydration mismatches across a 26k-LOC client tree] → eliminated by construction:
  `ssr: false` islands; the skeleton is static markup with no client data.
- [HMR double-instantiation of server singletons] → impossible by construction
  (module-graph separation, D1); stated as a deliberate invariant.
- [Visual snapshot churn from CSS ordering / font URL changes] → layout-pinned CSS
  order; zero-diff target; inspect-then-regenerate policy.
- [404-body and asset-header deltas surprise an unknown client] → declared in the
  `api-contract-freeze` delta; statuses and the endpoint inventory unchanged; panel
  reviews the wording.
- [Dev DX regressions: webpack-only HMR, server-edit restarts re-prepare Next, dev port
  moves 5173→8787] → accepted (user decision); offset by proxy/plugin deletion and real
  OAuth in dev.
- [No `output: 'standalone'` with a custom server] → Docker/plain-Node deploys ship
  `web/.next` + full `node_modules`; documented, acceptable for self-hosting.
- [Next-managed tsconfig edits fight the repo style] → accept and commit them in the
  scaffold phase; noted so reviewers don't revert them.

## Migration Plan

Six phases, each leaving the repo green (see `tasks.md`): entry refactor (Vite still
ships) → Next scaffold in parallel (both builds green) → server integration + cutover
(risk-tier review: contract surface) → auth/deep-link/visual verification (risk-tier
review: contract-adjacent) → SSR easy wins → docs + cleanup. Rollback before phase 3 is
trivial (Vite path still authoritative); after phase 3, rollback is `git revert` of the
cutover commits — no data or schema migrations are involved anywhere in this change.

## Open Questions

None outstanding. Resolved by user decision (2026-08-13): single-process dev at :8787;
404/asset-header deltas accepted as declared diffs; visual baselines may be regenerated
after deliberate inspection; SSR is a future goal — easy wins in scope now, heavy islands
stay client-only. Gate rulings (2026-08-13): E1 — the profile-prefetch stretch is
deferred to its own change; E2 — dev binds loopback by default.

## Panel & review log

**2026-08-13 — Pre-panel fact-check pass** (light-tier mechanical fetch-and-compare over
`proposal.md`, `design.md`, and the four delta specs, against `main` @ `48998fb`):
21 claim groups checked — package versions and absence of `next`; the `app.ts` static
block and env-identity comment (whole-block reads, spans confirmed); `ipAllowlist.ts`
raw-socket read; `@hono/node-server` 1.19.14 `RESPONSE_ALREADY_SENT` export (dist types
+ exports map); `vite.config.ts` plugin/proxy/host-pin; `isRouterKnownPathname` and its
single-predicate doc comment; the three baseline spec wordings being modified (mirror
clause, "same document body served at `/`"/"same status, same body"/status-only 404,
`:5173` disposition — all quoted verbatim); departure-watcher synchronous-before-`impl`
mechanism (full read of `navigation.ts` + `departureWatcher.ts`); StrictMode split
between the two entries; HTML entries' body attr + theme colors; `public/static`
contents; Playwright webServer/visual config + root scripts; server no-build scripts;
the name-pinned `server/src/node/` membership test (`NODE_DIR_ALLOWED_RELATIVE_PATHS`,
read + live test run); `client.ts` API root/credentials/wsUrl + zero `import.meta.env`
(grep-derived); `overlayscrollbars.css` import site; router/endpoint count derivation
(15 routers confirmed; 81 HTTP registrations + 1 WS, receiver-scoped count reconciled
twice — noted the naive grep over-counts ~2x on context/port `.get()` calls).
**Corrected (1):** asset-import call sites are 3 (`LoginPage.tsx`, `AdminUsersPage.tsx`,
`loadingVideo.ts`), not 4 — `ChunkRescueBanner.tsx` has no asset import; fixed in
proposal.md Impact, design D5, and task 1.2. **Left unverified:** Next.js 15 external
framework claims (no-standalone-with-custom-server, webpack-only dev under custom
server, multiple root layouts, `ssr:false` inside client components) — `next` is not
installed, nothing to mechanically check against; these reach the panel un-vouched.
Judgment claims (risk rankings, "buys nothing" characterizations) reach the panel
un-vouched.

**2026-08-13 — Adversarial panel** (four reviewers with distinct mandates —
requirements / assumptions / failure & abuse / scope & simpler design — all calibrated
skeptical; the assumptions reviewer read the installed `@hono/node-server` 1.19.14,
`@hono/node-ws` 1.3.1, and Hono 4.12.29 dist sources). Synthesis dispositions:

*Blockers/majors fixed in place:*
1. Dev HMR/upgrade allowlist bypass + loopback-pin deletion without successor (3
   reviewers) → D1 dispatcher allowlist check; D10 dev `HOST=127.0.0.1` default;
   guardrail ported in task 6.2; spec scenario added.
2. `/_next/image` optimizer + undeclared default Next surface (3 reviewers) → D6
   closed path-family set; `images.unoptimized`, `poweredByHeader: false`, telemetry
   disabled; spec scenario.
3. No-oracle wording literally false under Next (RSC content negotiation, buildId,
   dynamic rendering) (2 reviewers) → restated as header-fixed invariance to
   existence/authorization, body-scoped identity; task 4.1 asserts across
   {existing, deleted, foreign-team, random} ids with fixed headers.
4. Bridge method scope unspecified → 404→405 drift (3 reviewers) → GET-only bridge,
   non-GET 404s unchanged; scenario + dispatch test.
5. Encoded-slash: catch-all receives *decoded* segments; "raw segment shape" wording
   would steer an implementer into 404ing `/sessions/a%2Fb` (2 reviewers) → D3
   reworded (decoded list, segments may contain `/`); e2e case added; spike coverage.
6. wouter/Next history-patching no-remount claim: wrong mechanism, unverified,
   first-tested post-cutover (2 reviewers) → D3 rationale rewritten; phase-2 spike
   task gates phase 3; risk logged.
7. Catch-all rendering mode undecided (on-demand static generation ⇒ runtime `.next`
   writes, e2e share-race, disk-growth abuse, cache-header variance) → `force-dynamic`
   decision in D3; no-runtime-writes assertion task.
8. Upgrade replay reaches the bridge with `outgoing === undefined` ⇒ crash/500 where
   today a clean 404-close → bridge guards absent `outgoing`; `Bindings` gains
   `outgoing?`; dispatch test.
9. `prepare()` failure and listen-before-ready unspecified → boot-ordering + fail-loud
   requirements in D1/spec; reject-path unit test.
10. Trailing-slash 308 vs pinned 404 → `skipTrailingSlashRedirect: true`; scenario
    (`GET /teams/` → 404); spike coverage.
11. Task 5.1 skeleton = a new hand-maintained mirror with an unmeasurable criterion →
    single shared component (dynamic-loading fallback ≡ island loading branch), jsdom
    done-ness gate.
12. Global-object patching (node-server proxies Request/Response; Next patches fetch)
    invisible to "Hono unmodified" reasoning → verification task + documented lever.

*Escalated to the gate:*
- **E1 — D9.3 stretch profile-prefetch** (all four reviewers; the failure/abuse
  reviewer graded it a blocker): contradicts this change's own delta SHALLs; per-user
  shell HTML; bespoke hydration channel. Panel recommends **drop from this change,
  defer to its own change**. Conflicts with the user's "migrate any easy wins to SSR"
  mandate only if it is an easy win — the panel's finding is that it is not.
  **Decision (gate, 2026-08-13): deferred to its own change.** Former task 5.2
  removed; the delta SHALLs stand unqualified.
- **E2 — dev binds loopback by default** (fixed in place in D10 as the
  security-preserving default, flagged here because it is DX-visible): LAN testing of
  dev builds requires an explicit `HOST` override or the prod serve path.
  **Decision (gate, 2026-08-13): confirmed.**

*Minors accepted as residual or fixed with one line:*
`.gitignore` gains `.next/` (task 2.1); stale `:5173` in `scripts/teardown.mjs`,
orphaned root `concurrently` dep, and `web`'s `dev: vite` script added to task 3.4's
enumeration; proposal's phantom "static-asset fallback language" sentence fixed; the
two-predicates (deep-link set vs shell set) distinction recorded in D3 and the
`web-session-routing` delta; `themeColor` moved to the `viewport` export (D4);
stray-upgrade close-vs-destroy declared (D6.5); `web/.env*` ordering invariant (D1);
bridge double-send guard (D1); prod non-API-upgrade destroy semantics; one-phase
window where `main.tsx` shims are unguarded by entry-isolation rules (accepted,
10-line shims); Pages-Router-rationale line added (D4).

**2026-08-13 — Post-gate consistency read** (light-tier, over the final `proposal.md`,
`design.md`, `tasks.md`, and all four delta specs, after the panel fixes and gate
rulings E1/E2 were folded in). Findings and fixes: (1) proposal/design said AppShell's
wouter patterns "consume" the shared route module while the delta spec correctly calls
them the one manually-synced mirror — proposal and design D3 aligned to the spec's
story; (2) the "Image optimizer is not served" scenario had no verifying task — added
to task 4.1's e2e list; (3) the "Dev server is loopback-only by default" scenario had
no verifying task — added to task 4.3's checklist; (4) the "Server-rendered shell"
requirement's "router-known paths" wording read as excluding `/admin/users` while D4/
D9.1 treat both groups symmetrically — requirement broadened to name the admin route
explicitly. Accepted as residual: the label collision between this change's gate
ruling E1 (2026-08-13) and the prior `cursor-agent-adapters` baseline's "gate ruling
E1 (2026-08-06)" quoted inside the MODIFIED requirement — dates disambiguate, and
editing inherited baseline text would add archive-sync noise.

**2026-08-13 — Apply-time amendment (task 2.3 measurements + owner ruling).** Live
smoke testing on the pinned Next 15.5.23 falsified two design-mechanism claims (both
flagged by the implementer, neither silently worked around): (1) trailing-slash
normalization — `skipTrailingSlashRedirect` suppresses only the 308; `/teams/` matched
the catch-all and served the shell. Escalated to the owner as a frozen-surface concern
per protocol; **ruling: enforce the pinned 404 in the Hono bridge** (route-table-free
trailing-slash rule, task 3.2), keeping the authorized delta's observable outcome
unchanged. D3, the platform spec's shell-routing requirement, the freeze delta's
404-body parenthetical, and tasks 3.2/2.6(d) amended accordingly. (2) catch-all params
arrive percent-encoded, not decoded — outcomes unchanged (`isShellSegments` is
shape-only); D3 and the platform spec reworded to the encoding-agnostic
never-re-split property. Also recorded in D2: two undocumented build blockers fixed
in-unit (`web/src/pages/` collides with Next's legacy Pages Router detection →
`pageExtensions` + `.page.` suffixes; no default `.webm` loader → webpack
`asset/resource` rule).
