# Tasks: nextjs-frontend-migration

Anchors are orientation only — locate code by content before editing. Every task is
gated by `npm run typecheck` + `npm test` (plus the web vitest suite once it exists on
the Next path); phase-level gates are listed at each phase. Phases 3 and 4 touch the
frozen-contract surface and get risk-tier per-phase reviews.

## 1. Entry refactor (Vite still ships; pure refactor, no contract surface)

- [x] 1.1 Extract the provider trees from `web/src/pages/index/main.tsx` and
      `web/src/pages/admin-users/main.tsx` into `IndexRoot.tsx` / `AdminRoot.tsx`
      components (admin keeps `<StrictMode>` as a subtree wrapper); the `main.tsx`
      entries become thin `createRoot(...).render(<XRoot/>)` shims. Existing web vitest
      suite + `npm run typecheck` green.
- [x] 1.2 Make the asset-import call sites bundler-agnostic: the 2 png / 1 webm imports
      (`LoginPage.tsx`, `AdminUsersPage.tsx`,
      `web/src/shared/utils/loadingVideo.ts`) consume a `.src`-shaped module type;
      update `web/src/types/assets.d.ts` accordingly. Vite build still green
      (`npm run build -w web`).

## 2. Next scaffold in parallel (Vite path still authoritative; no contract surface)

- [x] 2.1 Add `next` to `web/` and `server/` package.json; add
      `@tailwindcss/postcss` + `web/postcss.config.mjs`; add `web/next.config.ts` with
      the panel-decided contents: `reactStrictMode: false`,
      `images: { unoptimized: true }`, `poweredByHeader: false`,
      `skipTrailingSlashRedirect: true`; set `NEXT_TELEMETRY_DISABLED=1` in the
      dev/build/start scripts; add `.next/` to `.gitignore`; accept and commit Next's
      managed tsconfig edits and `next-env.d.ts`.
- [x] 2.2 Add the segment-shape helper to the shared route-definition module
      (`web/src/shared/utils/loginReturnPath.ts`, alongside `isRouterKnownPathname`)
      with unit tests: `[]`, `['sessions', <non-empty>]`, `['teams']` accepted; nested/
      empty shapes rejected; percent-encoding semantics documented in the tests.
- [x] 2.3 Build the `app/` tree: `(index)/layout.tsx` (+ body attrs, metadata, CSS
      imports in pinned order: `tailwind.css` then `overlayscrollbars.css`),
      `(index)/[[...path]]/page.tsx` (validates via 2.2's helper, `notFound()`
      otherwise, renders the static skeleton + `ssr: false` island wrapper for
      `IndexRoot`), `(admin)/layout.tsx` + `(admin)/admin/users/page.tsx` (`ssr: false`
      island for `AdminRoot`), root `not-found.tsx`. Remove the AppShell-level
      overlayscrollbars import.
- [x] 2.4 Add standalone `web/vitest.config.ts` (react plugin, jsdom, `@/` aliases) so
      the web suite runs without `vite.config.ts`; repoint `web/tsconfig.node.json`
      includes. Gate: web vitest green under the new config while `vite.config.ts`
      still exists.
- [x] 2.5 Update `web/src/webBoundaries.repo.test.ts`: entry-bundle-isolation rules
      rewritten from `main.tsx`/`index.html` to the `app/` entry files; add the
      `app/`-layer rule (`app` may import `pages`/`api`/`shared`; nothing imports
      `app`).
- [x] 2.6 **Framework-behavior spike (gates phase 3 — panel decision 2026-08-13).**
      Against the phase-2 scaffold (Vite path still authoritative), verify and record
      in the `.apply/` ledger, pinning the Next version: (a) wouter `pushState` across
      `/`, `/sessions/:id`, `/teams` triggers no RSC refetch and no island remount;
      (b) browser Back/Forward preserves departure-watcher ordering (Next's patched
      history + popstate listener double-handling); (c) `/sessions/a%2Fb` reaches the
      catch-all as two segment entries and serves the shell; (d) RESOLVED BY
      MEASUREMENT (task 2.3 smoke test + owner ruling 2026-08-13): Next normalizes
      trailing slashes for catch-all matching regardless of
      `skipTrailingSlashRedirect` — enforcement moved to the Hono bridge (task 3.2);
      the spike records the measurement citation, no re-verification needed;
      (e) with `force-dynamic`, repeated shell requests write nothing under
      `web/.next`; (f) `viewport`-exported theme color emits the expected
      `<meta name="theme-color">`. Any failure returns the design to the gate before
      phase 3 dispatches. Phase-2 gate: `next build` passes AND the full existing
      Vite-path suite (unit + e2e) stays green AND the spike ledger records (a)-(f).

## 3. Server integration + cutover (CONTRACT SURFACE — risk-tier review over this phase's cumulative diff)

- [x] 3.1 Add `server/src/node/nextFrontend.ts` (wraps `next({ dev, dir })`/`prepare()`;
      exposes `{ requestHandler, upgradeHandler, close }`; returns `null` when
      `web/.next` missing in prod; a `prepare()` rejection with a build directory
      present rethrows — fail the boot loudly, never silently degrade to API-only) and
      update the name-pinned `server/src/node/` membership test. Unit-test both the
      missing-build fallback and the corrupt-build reject path.
- [x] 3.2 Replace the static block in `server/src/app.ts` (locate by content:
      `serveHtml` + the four HTML routes + `serveStatic` catch-all) with the
      **GET-only** `frontend.handle(...)` bridge returning `RESPONSE_ALREADY_SENT`
      (import from `@hono/node-server/utils/response`). Guards (panel 2026-08-13):
      absent `frontend` → Hono 404; absent `c.env.outgoing` (upgrade replay,
      `app.request()` tests) → Hono 404, and `Bindings` gains an explicit `outgoing?`;
      `frontend.handle()` rejections are caught in the bridge — rethrow only if no
      headers were sent, else log and return the sentinel; trailing-slash paths
      (ending in `/`, except `/` itself) get Hono's 404 and are never bridged (owner
      ruling 2026-08-13 — Next 15.5.23 normalizes trailing slashes for catch-all
      matching regardless of `skipTrailingSlashRedirect`). Rewrite
      `server/src/routers/staticServing.int.test.ts` as dispatch-contract tests against
      a stub frontend (API routes never bridge; `/`, `/sessions/:id`, `/teams`,
      `/admin/users`, asset paths do; `POST /sessions/abc` 404s without invoking the
      bridge; absent-`outgoing` envs 404; `GET /teams/` and other trailing-slash
      paths 404 without invoking the bridge; IP allowlist covers page requests) — the
      bridge is a new seam and gets this characterization coverage in the same task.
- [x] 3.3 Wire `server/src/main.ts`: instantiate `nextFrontend` and only call `serve()`
      after `prepare()` resolves (or API-only is decided); install the path-dispatching
      `server.on('upgrade')` (capture Hono's upgrade handler via a stub `{on()}` server
      passed to `injectWebSocket`; `/api/*` → Hono; otherwise apply the IP-allowlist
      decision to the socket's remote address, then → Next dev handler / destroy in
      prod, destroy on allowlist failure); dev script sets `HOST=127.0.0.1` by default
      (overridable); add `await frontend?.close()` to shutdown (not serialized before
      `server.close()`); update the missing-build warning. Integration checks: session
      WS connects and receives a broadcast frame through the real server; a
      global-`fetch`-dependent flow (JWKS verify path, stubbed upstream) works after
      `prepare()` (global-object patching check; `overrideGlobalObjects: false` is the
      fallback lever); non-allowlisted non-`/api` upgrade is destroyed.
- [x] 3.4 Cut over the scripts and delete the Vite path: root `dev` →
      `npm run dev -w server`; root/e2e `build` steps → `next build`; delete
      `web/vite.config.ts` (including `sessionDeepLinkDevShell`), both `index.html`s,
      both `main.tsx` shims, and `web`'s `"dev": "vite"` script; drop
      `@tailwindcss/vite` and the now-unused root `concurrently` devDependency; update
      `scripts/teardown.mjs`'s hardcoded `5173` port entry; keep `vite`/
      `@vitejs/plugin-react` as vitest-only devDeps. Bump the Playwright webServer
      timeout. Phase gate: `npm test`, `npm run typecheck`, web vitest, `next build`,
      and full `npm run e2e` (chromium + login-gate) green.

## 4. Auth, deep-link, and visual verification (CONTRACT-ADJACENT — risk-tier review)

- [x] 4.1 Run and, where the serving change shifted behavior, update the e2e specs
      covering: login-gate cookie flow + return-path stash, unknown-session-serves-shell
      (`/sessions/does-not-exist-xyz`), `/sessions/a/b` → 404, `/sessions/a%2Fb` →
      200 shell, `/teams/` → 404 (no redirect), `/teams`, `/admin/users`,
      `/?login_error=...`. Assert the no-existence-oracle property in its delta form:
      with identical request headers, response **bodies** are identical across
      {existing, deleted, foreign-team, random} session states for the same id. Also
      assert `GET /_next/image?url=/static/logo-autologger-app.png&w=64&q=75` is never
      an optimized image (optimizer disabled — spec scenario).
- [x] 4.2 Run both visual suites (`visual-desktop`, `visual-mobile`). Target zero
      diffs; if any appear, inspect each and re-bless baselines deliberately in this
      branch's diff (never defer drift), recording the inspection outcome in the phase
      report.
- [x] 4.3 Manual dev-mode verification (documented in the phase report): single-process
      dev boots at :8787, web-edit HMR works, server-edit restart re-prepares Next,
      session WS + dev HMR sockets coexist, dev OAuth start/callback round-trips
      same-origin (with real creds if available; otherwise assert the redirect shape),
      and with no `HOST` override the process listens on `127.0.0.1` only (not
      reachable from a non-loopback interface — spec scenario / gate ruling E2).

## 5. SSR easy wins

- [x] 5.1 Single-source the server-rendered skeleton (panel rework 2026-08-13): one
      shared React component rendered both as the `dynamic()` `loading` fallback and by
      the island's loading branch — no hand-maintained markup mirror. Skeleton contains
      no user- or session-derived data. Done-ness gate: a jsdom test asserting the
      fallback and the loading branch render the same component.
(The former stretch task — server-side `/api/profile` prefetch — was removed by gate
ruling E1, 2026-08-13: deferred to its own future change. See design.md D9.3 and the
Panel & review log.)

## 6. Docs + cleanup + final gates

- [x] 6.1 Repartition `web-docs/model/components.ts` globs (`web/src/app/**` covered,
      deleted-file pins removed), regenerate the edges snapshot, and pass
      `npm run docs:check`.
- [x] 6.2 Update README (dev/build/run sections, `:5173` references, architecture
      notes; endpoint table unchanged), CLAUDE.md (dev-auth invariant wording; the
      Vite loopback-pin guardrail is **ported, not deleted** — dev binds loopback by
      default with the same LAN-bypass rationale, LAN testing via the prod serve
      path), and the Cursor adapter restart rule (single-process `:8787` disposition
      per the `cursor-agent-adapters` delta) — re-run that surface's drift guard.
- [x] 6.3 Final gates: full `npm test` + `npm run typecheck` + web vitest +
      `npm run e2e` (chromium + login-gate) + visual suites (baselines current or
      re-blessed in this branch) + `npm run docs:check`. Whole-branch layered scoped
      audit per SDLC (contract/seam diffs of phases 3-4, full diffs of deferred phases,
      materialized file list + stray-file scan, seam call-site check for the
      `frontend` bridge and upgrade dispatcher).
