# Proposal: nextjs-frontend-migration

## Why

The web frontend runs as a second dev origin (Vite :5173) proxied into the Hono server
(:8787), with the route table hand-mirrored in three lockstep places and the first paint
being an empty `<div id="root">`. Migrating `web/` to Next.js 15 (App Router), served by
the existing server through a custom-server bridge, unifies the stack into one process and
one origin, server-renders the shell (real HTML/fonts/theme on first paint), and opens an
incremental path to SSR — while leaving the frozen HTTP/WS API surface byte-identical
because the Hono side does not change.

## What Changes

- `web/` becomes a Next.js 15 App Router app in place: `web/src/app/**` (two root-layout
  route groups mirroring today's two Vite MPA entries), `next.config.ts`
  (`reactStrictMode: false`; admin subtree opts back in), `postcss.config.mjs` (Tailwind
  v4 via `@tailwindcss/postcss`), standalone `web/vitest.config.ts`. `web/vite.config.ts`,
  both `index.html` entries, both `main.tsx` entries, and the `sessionDeepLinkDevShell`
  dev plugin are deleted.
- The server's static-serving block (`server/src/app.ts` — four explicit HTML routes +
  `serveStatic` over `web/dist`) is replaced by a catch-all that bridges non-API requests
  to Next via `RESPONSE_ALREADY_SENT` (new `server/src/node/nextFrontend.ts` wraps the
  programmatic `next()` app). `/api/*`, `/auth/*`, and the WebSocket route are untouched;
  the `c.env`-identity upgrade contract and middleware coverage (IP allowlist, auth
  context) are preserved by construction. A path-dispatching `upgrade` listener in
  `server/src/main.ts` separates the session WebSocket from Next's dev-HMR socket.
- In-app navigation keeps wouter and the synchronous departure-watcher funnel inside
  `ssr: false` client islands; Next is the HTML-shell router only. The three-way lockstep
  route-table mirror is retired: the Next catch-all validates shell paths from the same
  shared route-definition source as the login return-path validator
  (`web/src/shared/utils/loginReturnPath.ts`).
- Dev collapses to a single process at :8787 (`tsx watch` + `next({ dev: true })`): web
  edits get Next HMR, server edits restart the process. The Vite proxy and :5173 die; dev
  OAuth round-trips same-origin for the first time.
- SSR easy wins ship with the migration: server-rendered layout chrome + a
  single-sourced static loading skeleton around the client islands (shared component,
  no hand-maintained mirror) and statically rendered `not-found`. A cookie-forwarding
  server-side `/api/profile` prefetch was examined by the adversarial panel and
  **deferred to its own future change by gate ruling E1 (2026-08-13)** — it contradicts
  this change's shell-response requirements as written (see design.md D9.3 and the
  Panel & review log).
- Dev binds loopback (`127.0.0.1`) by default (overridable via `HOST`), succeeding the
  retired Vite dev server's loopback pin; non-`/api` WebSocket upgrades pass the same
  IP-allowlist decision as HTTP requests before reaching Next's dev HMR handler.
- Test/guard surface updated, not weakened: `webBoundaries.repo.test.ts` entry-isolation
  rules rewritten for `app/` entries plus an `app`-layer rule;
  `staticServing.int.test.ts` rewritten to assert the dispatch contract against a stub
  frontend; e2e web build becomes `next build`; `web-docs/model/components.ts` globs
  repartitioned.

**Contract impact (frozen HTTP/WS surface):** no `/api/*` or `/auth/*` endpoint, JSON
shape, status code, export body, header/range semantics, or WS message/emission semantics
change — the Hono routers are not modified. Observable changes are confined to the HTML/
static layer and are authorized by this change's deltas: (1) the shell HTML for `/`,
`/sessions/:id`, `/teams`, `/admin/users` is Next-rendered — page identity and the
no-existence-oracle property are preserved (restated as header-fixed invariance: for
fixed request headers, the response never varies with session existence or
authorization), but the byte-for-byte "same document body as `/`" wording no longer
holds (Next embeds the requested route in the document); (2) non-inventory 404 bodies
become Next's not-found HTML (status stays 404; GET-only bridge — non-GET 404s are
untouched; trailing-slash variants keep 404ing with no canonicalizing redirect);
(3) hashed bundle assets move `/assets/*` → `/_next/static/*` and asset caching headers
come from Next; (4) the set of Next-answered path families in production is closed and
enumerated — the image optimizer (`/_next/image`), `X-Powered-By`, and framework
telemetry are disabled; (5) stray-path (non-`/api`) WebSocket upgrades in production
are destroyed instead of receiving an HTTP-status close. Statuses, the endpoint
inventory, and cookie behavior are unchanged.

## Capabilities

### New Capabilities

- `web-frontend-platform`: the Next.js frontend platform — App Router structure (two
  root-layout groups, validated shell catch-all, client-island rendering with
  `ssr: false`, StrictMode semantics), the custom-server bridge (Hono outermost,
  `RESPONSE_ALREADY_SENT` handoff, upgrade dispatch, API-only fallback mode),
  single-process dev, SSR shell (layout chrome + skeleton), and the module-graph
  separation invariant (server never imports `web/src/**`; Next never compiles
  `server/src/**`).

### Modified Capabilities

- `api-contract-freeze`: the "Session deep-link HTML route" and "Teams page HTML route"
  requirements are reworded from byte-identity with `/` to page-identity +
  header-fixed no-existence-oracle (for fixed request headers, the response never
  varies with session/team existence, deletion state, or authorization); the
  non-matching-path 404 requirement keeps status-only pinning with the body now Next's
  not-found HTML, extended to pin trailing-slash and non-GET 404s and to declare the
  stray-upgrade destroy disposition.
- `web-session-routing`: the "three sanctioned mirrors" lockstep clause is replaced —
  the route table has one shared definition module consumed by the stash write, the
  return-path validator, and the Next shell catch-all; AppShell's wouter patterns
  remain the one sanctioned mirror kept manually in lockstep (wouter route strings
  cannot mechanically import the predicate); the vite dev-middleware matcher and the
  server serve block no longer exist. Non-normative raw-built-asset-path note updated.
- `cursor-agent-adapters`: the restart rule's required "`:5173` (Vite) disposition"
  statement becomes a single-process dev disposition (`:8787` only).

## Non-Goals / Out of Scope

- No rewrite of API routes into Next route handlers — Hono keeps every `/api/*` and
  `/auth/*` endpoint and the WS route, verbatim.
- No SSR/hydration of the heavy client islands (session console, recorder, admin table);
  they render `ssr: false`. The ssr-false wrappers are the designated seam for future SSR
  adoption; only the shell-level SSR wins above are in scope.
- No change to in-app navigation semantics (wouter + departure watcher stay), to the
  web↛`packages/*` import boundary, to the single-process invariant, or to deployment
  shape beyond the build artifact (`web/.next` instead of `web/dist`; no
  `output: 'standalone'`).
- No Turbopack, no Vercel/serverless support, no multi-replica scaling.
- No visual redesign: the visual e2e suites target zero pixel diffs; baselines are
  regenerated only after deliberate inspection.

## Impact

- **Code**: `server/src/main.ts`, `server/src/app.ts`, new `server/src/node/nextFrontend.ts`
  (composition-root sibling — `node/` membership test updated); `web/src/app/**` (new),
  `web/` config files, 3 asset-import call sites, deletion of Vite entry/config files;
  `web/src/webBoundaries.repo.test.ts`, `server/src/routers/staticServing.int.test.ts`,
  `playwright.config.ts`, root/`web`/`server` `package.json` scripts,
  `web-docs/model/components.ts`.
- **Dependencies**: `next` added to `web/` and `server/`; `@tailwindcss/vite` →
  `@tailwindcss/postcss`; `vite`/`@vitejs/plugin-react` retained as web devDeps for
  vitest only.
- **Systems**: dev workflow (one process, :8787, webpack HMR), e2e boot (Next prod
  `prepare()` startup time; two hermetic servers sharing read-only `web/.next`), Docker/
  plain-Node deploy ships `web/.next` + full `node_modules`.
- **Docs**: README (endpoint table unchanged; dev/build sections updated), CLAUDE.md dev
  invariants (`:5173` references, Vite-proxy rationale), web-docs atlas model.
