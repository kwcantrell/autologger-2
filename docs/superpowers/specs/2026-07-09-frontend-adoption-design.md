# Frontend adoption (sub-project 2) — design

**Date:** 2026-07-09
**Status:** Approved at gate 2026-07-09 (panel-reviewed; E1 decided — see Panel & review log)
**Parent:** `2026-07-09-node-port-and-frontend-adoption-design.md` (sub-project 1 merged as
v0.4.0). That spec's sub-project-2 section is a direction-setting summary; this document is
the build contract.

## Context & goal

The Node server (v0.4.0) serves the SPA from a gitignored `public/` snapshot produced by an
`AUTOLOGGER_CF_BUILD=1` build inside the Python repo's `frontend/` package, plus a manual
`cp` of two logo PNGs. `GET /` and `GET /admin/users` rewrite `__API_ROOT__` → `/api` at
serve time — a mechanism the parent spec explicitly marked phase-1 transitional.

**Goal:** move the React frontend into this repo as a `web/` npm workspace so the repo is
self-contained — one `npm install && npm run dev` from the root, a production build the
server serves directly, and no serve-time HTML rewriting. **Zero component/behavior
changes** (Tailwind is sub-project 3) — sole exception: one line in `AudioRecorder.tsx`
(gate decision E1). The Python repo's `frontend/` is left untouched; this repo's copy
becomes canonical for this app.

Decisions made with the owner during brainstorming (2026-07-09):

- **Approach A** — npm workspaces, staged mechanical adoption (four ordered stages, each a
  coherent commit). Single-package absorption and history-preserving subtree import were
  considered and rejected.
- **Tooling carry-over: biome only.** TypeDoc / `docs:api` stay behind (the docs site lives
  in the Python repo).
- **API-root parameterization deleted entirely** — hardcode same-origin `/api`; no Vite
  define, no env knob. (Supersedes the parent summary's "becomes a Vite build-time define"
  with the simpler end state.)
- **Root `npm run dev` runs both processes** via `concurrently`.
- **Verification includes a Playwright e2e smoke tier**, plus a serving integration test
  and both typechecks.

## Stage 1: workspace conversion (mechanical)

```
autologger-cf/
├── package.json          # root: private, workspaces ["server", "web"], fan-out scripts
├── server/
│   ├── package.json      # autologger-server; today's deps minus @playwright/test
│   ├── tsconfig.json     # moved verbatim
│   ├── vitest.workspace.ts
│   ├── .env.example      # moved here — the server package owns its runtime config
│   └── src/              # today's src/, moved (one content edit, below)
├── web/                  # stage 2
├── e2e/                  # stage 4
└── docs/ …               # unchanged
```

- `src/` → `server/src/` with **one content edit**: `MIGRATIONS_DIR` in
  `src/node/config.ts` is currently `join(process.cwd(), 'src/db/migrations')` —
  cwd-relative, which only survives the move because `npm run -w server` chdirs into the
  package. It becomes `import.meta.url`-relative (same technique stage 3 uses for
  `web/dist`), so vitest-from-root, IDE test runners, and any non-`npm -w` invocation keep
  finding migrations. *(Panel: assumptions #2.)* Everything else moves verbatim — imports
  are relative; `tsconfig.json` and `vitest.workspace.ts` globs (`src/**`,
  `./src/test/setup.int.ts`) are config-file-relative and stay correct.
- **Scope of "zero behavior change" (stated honestly):** zero *API* behavior change,
  gated by `npm test && npm run typecheck` from the root. SPA serving from the old
  root-level `public/` snapshot goes **knowingly dark** at this stage (the `./public`
  default is cwd-relative and cwd becomes `server/`); it is restored — against `web/dist` —
  by stage 3. Acceptable: the snapshot is a rebuildable artifact already slated for
  deletion. *(Panel: scope #1.)*
- **Existing operator state does not migrate itself:** a dev machine's root `.env` and
  `data/` are not found after the move. The stage-1 commit message and README note the
  one-liner: `mv .env data server/` (plus `rm -rf public` — see stage 3). *(Panel:
  scope #1.)* The existing `.gitignore` patterns (`.env`, `data/` — no leading slash)
  already match at any depth, so no ignore changes are needed for the relocation.
- Root `package.json` keeps the name `autologger` and the version counter; `concurrently`
  and `@playwright/test` are root devDependencies (`@playwright/test` moves out of the
  server package's `dependencies`, where it never belonged).
- Root scripts at this stage fan out to the server only (`test`, `typecheck`, `dev`,
  `start`); the full orchestration table (including `concurrently` dev and `e2e`) lands in
  stage 4 once `web/` exists. README's quickstart `cp .env.example .env` line is patched to
  the new path in this commit, not left broken until stage 4. *(Panel: scope #7.)*
- One root lockfile (npm workspaces); note that conflicting dependency majors across
  workspaces (typescript 5.x server vs 6.x web, vitest's vite 5 vs web's vite 8) resolve by
  **nesting** under the owning workspace's `node_modules` with workspace-local `.bin`
  precedence — expected, not a defect to "fix". *(Panel: assumptions #9, scope #9.)*
- **Done when:** `npm install && npm test && npm run typecheck` from the root are green.

## Stage 2: the `web/` workspace

Snapshot copy of `/home/kalen/AutoLog/frontend` (`src/`, `tsconfig.json`,
`tsconfig.node.json`, `biome.json`, `package.json`, `vite.config.ts`) with config-level
edits only:

- **`vite.config.ts` rewritten for this repo:**
  - `AUTOLOGGER_CF_BUILD` fork deleted; `base` is `/` always; `outDir: 'dist'` (resolving
    to `web/dist` from the repo root — not the literal string `'web/dist'`, which would
    resolve to `web/web/dist` under the config's own root), `emptyOutDir: true`. *(Panel:
    failure #8.)*
  - The two rollup HTML inputs (`src/pages/index/index.html`,
    `src/pages/admin-users/index.html`) and the `@/api` / `@/shared` / `@/pages` aliases
    stay as-is.
  - Dev proxy targets the Node server: `/api` → `http://localhost:8787` with **`ws: true`**
    (the session WebSocket is `/api/sessions/:id/ws`, so this one entry covers it) and
    `/auth` → `http://localhost:8787`. The `/static` proxy entry is dropped (next bullet).
  - **`server.host` pinned to `'127.0.0.1'`.** The Vite proxy would otherwise let any LAN
    peer reach the server *as* `127.0.0.1`, silently bypassing `IP_ALLOWLIST` and even a
    deliberate loopback bind — voiding sub-project 1's client-IP hardening via one `--host`
    flag. LAN-device testing goes through the production serve path at :8787, where the
    server's own controls apply; this guardrail is recorded in README + CLAUDE.md.
    *(Panel: failure #3.)*
- **Logos become real files** at `web/public/static/logo-autologger-transparent.png` and
  `web/public/static/logo-autologger-app.png` (copied once from the Python repo's
  `src/autologger/web/static/`, **optimized/downscaled first** — the app icon is 339 KB
  today and enters git history forever; favicon/touch-icon weight is all that's needed).
  Vite serves `web/public/` at `/` in dev and copies it into `dist/` at build, so the
  HTML's `/static/logo-…` links work identically in dev and prod with no proxy and no `cp`
  step. *(Panel: scope #6.)*
- **API-root parameterization deleted:** `src/api/client.ts` becomes
  `export const API_ROOT = '/api'` — the `document.body.dataset.apiRoot` read and the
  `__API_ROOT__` sentinel check go away; `wsUrl` drops its now-dead absolute `http(s)://`
  branch **and its doc comment describing that branch** *(panel: scope #8)*. Both page
  `index.html` files lose the `data-api-root="__API_ROOT__"` body attribute
  (`data-v4-transport` stays — unrelated). **Gate decision E1:** a second, independent
  `dataset.apiRoot` read in `pages/index/components/AudioRecorder.tsx` (sendBeacon
  lease-release) gets a one-line edit to import `API_ROOT` from `client.ts` — honoring
  "deleted entirely"; recorded as the sole exception to "zero component changes".
  *(Panel: requirements #2.)*
- **`web/package.json`:** name `autologger-web`, private. Scripts: `dev`, `build`
  (`tsc --noEmit && vite build`), `typecheck` (`tsc --noEmit`, so the root fan-out doesn't
  need a full build — *panel: assumptions #6*), `lint` / `format` (biome). The `preview`
  script is **dropped**, not carried: with no proxy config it serves `dist` with every API
  call failing; this repo's real preview is `npm run build && npm run start`. *(Panel:
  scope #3.)* `docs:api` and the typedoc devDependencies are dropped; `typedoc.json` is not
  copied. Runtime deps (React 19, Radix, TanStack Query/Virtual, clsx, overlayscrollbars)
  come over unchanged. TypeScript stays at the frontend's ^6.0.0 while the server stays at
  ^5.7.2 — **intentional divergence**, each workspace resolves its own. *(Panel:
  scope #9.)*
- Root `engines` tightens to `node >=22.12` — Vite 8 requires `^20.19.0 || >=22.12.0`, so
  plain `>=22` admits Node versions that EBADENGINE-warn and break dev. *(Panel:
  assumptions #7.)*
- Dev URLs keep Python-repo parity: Vite serves pages at
  `http://localhost:5173/src/pages/<page>/index.html`. No new routing invention.
- **Zero component changes** (E1's one line excepted). Under `web/src/`, only
  `client.ts`, the two `index.html` files, and `AudioRecorder.tsx` are touched.

## Stage 3: server serving changes

Small, isolated diff to `server/src/app.ts` + `server/src/main.ts`:

- **Static root points at the web build.** `main.ts` resolves `web/dist` relative to its
  own source location (`join(dirname(fileURLToPath(import.meta.url)), '../../web/dist')`
  from `server/src/main.ts`), correct regardless of cwd. The `opts.publicDir` override in
  `wireApp` stays — no current test uses it, but the new serving integration test below
  does. *(Panel: scope #2.)*
- **`__API_ROOT__` rewrite deleted.** `serveHtml` stops doing `replaceAll` and just serves
  the file. `GET /` and `GET /admin/users` still explicitly serve
  `dist/src/pages/{index,admin-users}/index.html` (no client-side router; explicit-routes
  shape unchanged); the catch-all `serveStatic` keeps serving hashed `/assets/*` and
  `/static/*`. The "PHASE-1 TRANSITIONAL" comment block goes away.
- **Missing-build behavior:** `/` keeps returning the current 404 path when `web/dist` is
  absent, and `main.ts` logs a startup hint ("frontend not built — run `npm run build`").
  Note `@hono/node-server`'s `serveStatic` also `console.error`s a missing root at wire
  time — two lines total, acceptable; don't suppress it. *(Panel: assumptions #8.)* No hard
  failure — API-only operation stays legitimate (tests, Companion-only setups).
- **Serving integration test** uses a fixture dist written to a temp dir by the test (two
  page HTML files + one asset), not a real Vite build, asserting: `/` and `/admin/users`
  return their HTML **verbatim** (no substitution artifacts), `/assets/*` and `/static/*`
  are served, API routes are never shadowed by the static layer, unknown paths 404.
  `npm test` stays independent of a frontend build; the real build is exercised by the e2e
  tier.
- **`.gitignore` + snapshot cleanup:** the `public/` entry is **removed** (the `web/dist`
  build output is already covered by the existing any-depth `dist/` pattern — no new entry
  needed), and the stale root `public/` directory is **deleted** in this stage; otherwise,
  the moment `public/` leaves the ignore file, a careless `git add -A` commits a full stale
  SPA build. *(Panel: failure #6, assumptions #4, scope #5.)*

## Stage 4: orchestration, e2e smoke, docs & versioning

**Root scripts** (npm workspaces fan-out):

| Script | Does |
|---|---|
| `dev` | `concurrently --kill-others-on-fail -n server,web` → `dev -w server` (tsx watch, :8787) + `dev -w web` (Vite, :5173) — kill policy + name prefixes so a half-dead pair (EADDRINUSE, crash) fails loudly instead of proxying to a stale server *(panel: failure #4)* |
| `build` | `build -w web` (the server needs no build; tsx runs TS directly) |
| `start` | `start -w server` — production: serves `web/dist` |
| `test` | `test -w server` (vitest, unchanged unit/integration tiers) |
| `typecheck` | server + web (`typecheck` scripts) + `tsc --noEmit -p e2e` (minimal `e2e/tsconfig.json` — Playwright transpiles without typechecking, so e2e code must be covered explicitly; `e2e/` is also added to biome's scope) *(panel: scope #4)* |
| `lint` | `lint -w web` (biome; the server has no linter today — unchanged) |
| `e2e` | `build -w web && playwright test` |

**Graceful-shutdown hardening (prerequisite for both supervisors):** `main.ts`'s
SIGINT/SIGTERM handler currently waits on `server.close()`, which never completes while a
WebSocket is open — the normal state of this app — so Ctrl-C under `concurrently` leaks a
zombie on :8787 and Playwright teardown escalates to SIGKILL every run. The handler
additionally calls `server.closeAllConnections()` (with a bounded-timeout `process.exit`
fallback), and stage 4's verification includes "Ctrl-C on `npm run dev` exits both
processes and frees :8787/:5173". *(Panel: failure #2.)*

**Dev-mode auth (stated, not emergent):** the supported `npm run dev` configuration is
**anonymous dev** — `REQUIRE_LOGIN=0` with `HOST=127.0.0.1` in `server/.env` (loopback bind
keeps the sub-project-1 warning moot). Google OAuth **cannot round-trip through the Vite
proxy**: the callback redirects to `PUBLIC_BASE_URL` (:8787) and the cookie lands on the
server origin, not :5173 — logging in from the dev server strands the user off-proxy, and
`localhost` vs `127.0.0.1` cookie scoping makes it silently worse. OAuth is verified on the
production serve path (`npm run build && npm run start`) instead; this is Python-era parity
(the old dev flow had the same shape), now written down. First symptom of a misconfigured
dev auth is an opaque WS drop (the 401 fires before the upgrade, so the browser sees a bare
close) — named in the README's dev section for diagnosability. *(Panel: failure #1 & #7,
requirements #3.)*

**Playwright e2e smoke** — root `e2e/` dir, `playwright.config.ts` at the root:

- **Hermetic server env (three reviewers converged on this):** the server's `start` script
  loads `server/.env`, and Node's `--env-file` semantics let every var Playwright doesn't
  set leak through — a developer's filled-in Google creds flip `oauthConfigured()` and 401
  the anonymous smoke flow, making the suite red exactly on configured machines.
  `playwright.config.ts`'s `webServer.env` therefore sets **all** of: `PORT=8791`,
  `HOST=127.0.0.1`, `REQUIRE_LOGIN=0`, absolute `DATA_DIR`, **and explicit empty strings
  for `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_BASE_URL`, `IP_ALLOWLIST`,
  `API_TOKEN`, `ADMIN_TOKEN`** (process-env values win over the env file). *(Panel:
  requirements #1, assumptions #1.)*
- **`DATA_DIR` is resolved absolute in `playwright.config.ts`** (from the config's own
  directory) — a relative `e2e/.data` would land at `server/e2e/.data` because the server
  script's cwd is `server/`. *(Panel: assumptions #3.)* The wipe has an owner: Playwright
  `globalSetup` does the `rm -rf` before the server starts. `reuseExistingServer: false`
  so a leftover orphan on :8791 (possibly started with different env) is never silently
  reused. `e2e/.data/` gets an explicit `.gitignore` entry — the existing `data/` pattern
  does **not** match a dir named `.data`. *(Panel: assumptions #4 & #5, failure #5.)*
  Fixed port 8791 means two concurrent local runs collide — accepted for a no-CI repo.
- `REQUIRE_LOGIN=0` because Google OAuth cannot be driven headlessly; anonymous mode is a
  supported configuration and exercises the same serving + API + WS paths.
- Smoke scenarios (deliberately few):
  1. `/` renders the session workspace shell with no page errors.
  2. Create a session and log an event through the UI; assert it appears in the event feed.
     (Fresh-DB anonymous flow is plausible — migrations seed built-in shows and anonymous +
     OAuth-unconfigured resolves the default studio — but this e2e is the first time the
     React UI runs against the Node server on a fresh DB; treat first-run setup state as an
     implementation checkpoint. *(Panel: assumptions #10.)*)
  3. With the page open, POST an event via `page.evaluate(fetch)` and assert it appears
     **without reload and without any focus change or page interaction** between POST and
     assertion (passive `expect.poll` on the DOM) — React Query's `refetchOnWindowFocus`
     would otherwise fetch over HTTP and green the test with the WebSocket dead. Proves the
     WS/live-update pipeline end to end. *(Panel: requirements #5.)*
  4. `/admin/users` renders.
- Chromium via `npx playwright install chromium` (documented one-time step).

**Docs & versioning:**

- README: "Serving the SPA" rewritten (workspace setup, one-command dev, anonymous
  dev-auth recipe + OAuth-on-prod-path note, build/e2e flows, Vite-stays-loopback
  guardrail); the `AUTOLOGGER_CF_BUILD` + logo-`cp` instructions die. Setup section becomes
  root `npm install`.
- CLAUDE.md: setup/layout/guardrails sections update; the `public/` guardrail becomes
  `web/dist/` (build artifact — don't hand-edit or commit); Vite loopback + dev-auth
  posture noted.
- Root `package.json` version 0.4.0 → 0.5.0 at ship. No CHANGELOG file exists in this
  repo; release notes stay in the git log + plan docs, as with v0.4.0.

## Definition of done

- `npm install` (root) → `npm run dev` under the **stated dev config** (`REQUIRE_LOGIN=0`,
  `HOST=127.0.0.1`) serves the app at :5173 (Vite, proxied API/WS) with live HMR against
  the Node server at :8787.
- `npm run build && npm run start` serves the production app at :8787 from `web/dist` with
  no serve-time rewriting.
- Ctrl-C on `npm run dev` exits both processes and frees :8787/:5173.
- `npm test`, `npm run typecheck` (server + web + e2e), `npm run lint` green from the root.
- `npm run e2e` green (all four smoke scenarios) — including on a machine with a fully
  filled-in `server/.env`.
- One manual browser pass before merge on the **production serve path** (login flow with
  real Google creds, session workspace, Companion presence if convenient) — the e2e tier
  can't cover OAuth.
- `grep -rE '__API_ROOT__|data-api-root|dataset\.apiRoot'` over this repo returns nothing.
  *(Panel: requirements #2; enforceable per gate decision E1.)*

## Risks

- **Vite dev WS proxying** (`ws: true` on `/api`) is the one piece with no precedent in
  either repo — the Python-era dev flow proxied HTTP only, and WS went same-origin in prod.
  Mitigated by smoke scenario 3 (prod path) and a manual dev-mode check during
  implementation. (Verified during panel: the cookie rides proxied upgrades; Vite's HMR WS
  uses its own path/token — no collision.)
- **Path resolution from `main.ts` to `web/dist`** assumes the source layout (two levels up
  from `server/src/`). Running the server from a bundled/compiled location would break
  it — acceptable: this repo runs via tsx from source (no build step), and the `publicDir`
  override remains for anything unusual.
- **Workspace hoisting** could surface duplicate-React-type issues between root and `web/`.
  Low risk (server has no React deps); typecheck of both workspaces is the tripwire.
  Conflicting majors (typescript, vite) nest per-workspace by design.
- **The e2e render depends on external CDNs** (Google Fonts + cdnjs `animate.css` links in
  `index.html`): stylesheet failures don't throw page errors, so scenario 1 should pass
  offline, but rendering fidelity is network-dependent. Fixing means touching components —
  out of scope; accepted residual. *(Panel: requirements #6.)*

## Out of scope

- Any component, styling, or behavior change (Tailwind migration is sub-project 3);
  E1's one-line `AudioRecorder.tsx` edit is the sole gate-decided exception.
- The Python repo, including its now-dormant `AUTOLOGGER_CF_BUILD` vite mode (dead code
  there; cleanable later in that repo).
- CI pipelines (none exist in this repo).
- Transcription / YouTube import (remain 503); `restart_supported` (stays `false`).
- Server-side lint tooling.

## Panel & review log

### 2026-07-09 — Adversarial panel (4 reviewers: requirements, assumptions, failure & abuse, scope/YAGNI)

All four verdicts: APPROVE-WITH-FIXES, no blockers. Three reviewers independently found
the non-hermetic e2e environment; two independently found the dev-auth dead end.

**Majors fixed in place:**

1. **Non-hermetic e2e server env** (requirements #1, assumptions #1, corroborated by
   failure #5) → `webServer.env` explicitly blanks `GOOGLE_CLIENT_ID`/`SECRET`/
   `PUBLIC_BASE_URL`/`IP_ALLOWLIST`/`API_TOKEN`/`ADMIN_TOKEN`; DoD requires e2e green on a
   configured machine.
2. **e2e `DATA_DIR` cwd-resolution + unowned wipe + not-actually-gitignored `.data`**
   (assumptions #3–#5, failure #5) → absolute `DATA_DIR` from the Playwright config,
   `globalSetup` wipe, `reuseExistingServer: false`, explicit `e2e/.data/` ignore entry.
3. **Dev-mode auth undefined / broken under documented defaults** (failure #1 & #7,
   requirements #3) → stated dev config (`REQUIRE_LOGIN=0` + `HOST=127.0.0.1`), OAuth
   verified on the prod serve path, opaque-WS-drop symptom documented, DoD dev bullet
   scoped to the stated config.
4. **Shutdown hang with live WebSockets under `concurrently`/Playwright** (failure #2) →
   `closeAllConnections()` + bounded-timeout exit in `main.ts`; Ctrl-C verification item.
5. **Vite `--host` voids IP-based controls** (failure #3) → `server.host` pinned to
   loopback in `vite.config.ts`; LAN testing via prod path; guardrail in README/CLAUDE.md.
6. **`MIGRATIONS_DIR` cwd-relative — "no content edits" false** (assumptions #2) → one-line
   `import.meta.url`-relative fix folded into stage 1; claim re-worded.
7. **Stage-1 "zero behavior change" over-claimed** (scope #1) → re-scoped to zero *API*
   change; SPA-dark window acknowledged; operator state-migration note added.
8. **Stale `public/` becomes committable when un-ignored; `web/dist` ignore entry
   redundant** (failure #6, assumptions #4, scope #5) → stage 3 deletes the snapshot dir;
   ignore edit reduced to removing `public/`.
9. **`concurrently` without a kill/fail policy** (failure #4) → `--kill-others-on-fail` +
   named prefixes mandated.
10. **Scenario 3 spuriously green via focus refetch** (requirements #5) → no-interaction
    assertion protocol specified.
11. **`web` had no `typecheck` script but root claimed "both workspaces"** (assumptions
    #6); **nobody typechecked/linted `e2e/`** (scope #4) → `typecheck` script added;
    `e2e/tsconfig.json` in the root fan-out; biome scope extended.
12. **`outDir` wording would resolve to `web/web/dist` under `emptyOutDir`** (failure #8)
    → phrased as `outDir: 'dist'`.
13. **Root engines `>=22` admits Node versions Vite 8 rejects** (assumptions #7) →
    tightened to `>=22.12`.

**Escalated to the gate (owner decision, not silently adopted):**

- **E1 — second `dataset.apiRoot` read in `AudioRecorder.tsx`** (requirements #2): the
  "deleted entirely" decision and the "zero component changes" mandate conflict on one
  line of one component. Options: (a) one-line edit importing `API_ROOT` from `client.ts`
  (recommended — honors "deleted entirely"; DoD grep then enforceable), or (b) accept as
  residual (it degrades gracefully to `/api`) and weaken the DoD grep. **Decision (owner,
  2026-07-09): option (a) — the one-line edit**, recorded as the sole exception to "zero
  component changes".

**Minors accepted as residual:** external-CDN dependency of the e2e render (risk-noted);
fixed e2e port 8791 single-run limitation; `serveStatic`'s extra missing-root log line;
TypeScript/vite major-version divergence across workspaces (documented as intentional);
scenario-2 fresh-DB first-run state (implementation checkpoint); Python-era dev nav warts
(logout / `href="/"` land on `:5173/`, which Vite serves nothing at — parity, not a
regression); logo PNGs enter git history (mitigated by pre-commit optimization).

### 2026-07-09 — Implementation deviations (recorded at final whole-branch review)

Two stage-4 mechanisms shipped differently than specified, both discovered and proven
during implementation, both judged strictly more correct at the final review:

1. **The e2e `.data` wipe lives in Playwright's `webServer.command`, not `globalSetup`.**
   The installed Playwright boots the webServer *before* running `globalSetups` (verified
   against its source), so the spec'd globalSetup wipe deleted `DATA_DIR` under the live
   server. The wipe now runs inside the web-server command itself, reading the same
   `DATA_DIR` env the server consumes — single source of truth, still exactly once and
   before boot. `e2e/global-setup.ts` does not exist.
2. **Smoke scenario 3 asserts the probe via `input[aria-label="Message"][value=…]`, not
   `hasText`.** While a session is rolling, the event feed renders message cells as
   inline-edit `<input>`s whose value is invisible to `textContent`/`hasText`. The
   assertion remains passive (no interaction between POST and assert), and pins the exact
   live value — stronger than the spec'd form.

### 2026-07-09 — Post-gate consistency read (light tier)

After the E1 gate decision was applied as targeted edits, a light-tier reviewer swept the
final document for stale pre-decision language, log/body contradictions, dangling
cross-references, and inter-section conflicts. Result: **clean** — no fixes required.

**Also verified by the panel (holds):** only two `/static/*` asset references exist
(logos) — fonts/video/icons are all bundled imports; one `ws: true` proxy entry covers the
only WS; `serveStatic` rejects traversal and accepts absolute roots; static catch-all
cannot shadow `/api`/`/auth` (mount order); missing `web/dist` degrades to 404s without
throwing; cookie-Secure auto-detect unaffected in dev; `apiUrl` stays live
(`useCompanionPresence` sendBeacon); npm `-w` chdir semantics confirmed empirically;
tsconfig/vitest globs are config-relative; Playwright chromium already present in the
devcontainer.
