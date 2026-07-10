# Frontend adoption (sub-project 2) — design

**Date:** 2026-07-09
**Status:** Draft — pending adversarial panel + owner gate
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
changes** (Tailwind is sub-project 3). The Python repo's `frontend/` is left untouched;
this repo's copy becomes canonical for this app.

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

## Stage 1: workspace conversion (mechanical, zero behavior change)

```
autologger-cf/
├── package.json          # root: private, workspaces ["server", "web"], fan-out scripts
├── server/
│   ├── package.json      # autologger-server; today's deps minus @playwright/test
│   ├── tsconfig.json     # moved verbatim
│   ├── vitest.workspace.ts
│   ├── .env.example      # moved here — the server package owns its runtime config
│   └── src/              # today's src/, moved verbatim
├── web/                  # stage 2
├── e2e/                  # stage 4
└── docs/ …               # unchanged
```

- `src/` → `server/src/` with no content edits (imports are relative). `tsconfig.json` and
  `vitest.workspace.ts` move alongside; their `src/**` globs remain correct relative to
  `server/`.
- **Runtime state stays with the server package.** `npm run -w server …` sets cwd to
  `server/`, so tsx's `--env-file-if-exists=.env`, the `DATA_DIR` default `./data`, and the
  operator's `.env` all keep working unchanged at `server/.env` and `server/data/`. The
  existing `.gitignore` patterns (`.env`, `data/` — no leading slash) already match at any
  depth.
- Root `package.json` keeps the name `autologger` and the version counter; `concurrently`
  and `@playwright/test` are root devDependencies (`@playwright/test` moves out of the
  server package's `dependencies`, where it never belonged).
- Root scripts at this stage fan out to the server only (`test`, `typecheck`, `dev`,
  `start`); the full orchestration table (including `concurrently` dev and `e2e`) lands in
  stage 4 once `web/` exists.
- One root lockfile (npm workspaces hoisting); `server/package-lock.json` does not exist.
- **Done when:** `npm install && npm test && npm run typecheck` from the root are green
  with zero behavior change.

## Stage 2: the `web/` workspace

Snapshot copy of `/home/kalen/AutoLog/frontend` (`src/`, `tsconfig.json`,
`tsconfig.node.json`, `biome.json`, `package.json`, `vite.config.ts`) with config-level
edits only:

- **`vite.config.ts` rewritten for this repo:**
  - `AUTOLOGGER_CF_BUILD` fork deleted; `base` is `/` always; `outDir` is `web/dist`
    (gitignored), `emptyOutDir: true`.
  - The two rollup HTML inputs (`src/pages/index/index.html`,
    `src/pages/admin-users/index.html`) and the `@/api` / `@/shared` / `@/pages` aliases
    stay as-is.
  - Dev proxy targets the Node server: `/api` → `http://localhost:8787` with **`ws: true`**
    (the session WebSocket is `/api/sessions/:id/ws`, so this one entry covers it) and
    `/auth` → `http://localhost:8787`. The `/static` proxy entry is dropped (next bullet).
- **Logos become real files** at `web/public/static/logo-autologger-transparent.png` and
  `web/public/static/logo-autologger-app.png` (copied once from the Python repo's
  `src/autologger/web/static/`). Vite serves `web/public/` at `/` in dev and copies it into
  `dist/` at build, so the HTML's `/static/logo-…` favicon/apple-touch-icon links work
  identically in dev and prod with no proxy and no `cp` step.
- **API-root parameterization deleted:** `src/api/client.ts` becomes
  `export const API_ROOT = '/api'` — the `document.body.dataset.apiRoot` read and the
  `__API_ROOT__` sentinel check go away, and `wsUrl` drops its now-dead absolute
  `http(s)://` branch. Both page `index.html` files lose the `data-api-root="__API_ROOT__"`
  body attribute (`data-v4-transport` stays — unrelated).
- **`web/package.json`:** name `autologger-web`, private. Scripts: `dev`, `build`
  (`tsc --noEmit && vite build`), `preview`, `lint` / `format` (biome). `docs:api` and the
  typedoc devDependencies are dropped; `typedoc.json` is not copied. Runtime deps
  (React 19, Radix, TanStack Query/Virtual, clsx, overlayscrollbars) come over unchanged.
- Dev URLs keep Python-repo parity: Vite serves pages at
  `http://localhost:5173/src/pages/<page>/index.html`. No new routing invention.
- **Zero component changes.** Only `client.ts` (API root) and the two `index.html` files
  (attribute removal) are touched under `web/src/`.

## Stage 3: server serving changes

Small, isolated diff to `server/src/app.ts` + `server/src/main.ts`:

- **Static root points at the web build.** `main.ts` resolves `web/dist` relative to its
  own source location (`join(dirname(fileURLToPath(import.meta.url)), '../../web/dist')`
  from `server/src/main.ts`), correct regardless of cwd. The `opts.publicDir` override in `wireApp` stays for tests.
- **`__API_ROOT__` rewrite deleted.** `serveHtml` stops doing `replaceAll` and just serves
  the file. `GET /` and `GET /admin/users` still explicitly serve
  `dist/src/pages/{index,admin-users}/index.html` (no client-side router; explicit-routes
  shape unchanged); the catch-all `serveStatic` keeps serving hashed `/assets/*` and
  `/static/*`. The "PHASE-1 TRANSITIONAL" comment block goes away.
- **Missing-build behavior:** `/` keeps returning the current 404 path when `web/dist` is
  absent, and `main.ts` logs a one-line startup hint ("frontend not built — run
  `npm run build`"). No hard failure — API-only operation stays legitimate (tests,
  Companion-only setups).
- **Serving integration test** uses a small fixture dist (two page HTML files + one asset),
  not a real Vite build, asserting: `/` and `/admin/users` return their HTML **verbatim**
  (no substitution artifacts), `/assets/*` and `/static/*` are served, API routes are never
  shadowed by the static layer, unknown paths 404. `npm test` stays independent of a
  frontend build; the real build is exercised by the e2e tier.
- `.gitignore`: `public/` entry replaced by `web/dist/`; the `public/` snapshot concept is
  gone.

## Stage 4: orchestration, e2e smoke, docs & versioning

**Root scripts** (npm workspaces fan-out):

| Script | Does |
|---|---|
| `dev` | `concurrently` → `dev -w server` (tsx watch, :8787) + `dev -w web` (Vite, :5173) |
| `build` | `build -w web` (the server needs no build; tsx runs TS directly) |
| `start` | `start -w server` — production: serves `web/dist` |
| `test` | `test -w server` (vitest, unchanged unit/integration tiers) |
| `typecheck` | both workspaces |
| `lint` | `lint -w web` (biome; the server has no linter today — unchanged) |
| `e2e` | `build -w web && playwright test` |

**Playwright e2e smoke** — root `e2e/` dir, `playwright.config.ts` at the root:

- Playwright's `webServer` starts the real server (`start -w server`) with `PORT=8791`,
  `HOST=127.0.0.1`, `REQUIRE_LOGIN=0`, and `DATA_DIR` pointing at a wiped, gitignored
  `e2e/.data/`. `REQUIRE_LOGIN=0` because Google OAuth cannot be driven headlessly;
  anonymous mode is a supported configuration and exercises the same serving + API + WS
  paths.
- Smoke scenarios (deliberately few):
  1. `/` renders the session workspace shell with no page errors.
  2. Create a session and log an event through the UI; assert it appears in the event feed.
  3. With the page open, POST an event via `fetch` and assert it appears **without
     reload** — proves the WebSocket/live-update pipeline end to end.
  4. `/admin/users` renders.
- Chromium via `npx playwright install chromium` (documented one-time step).

**Docs & versioning:**

- README: "Serving the SPA" rewritten (workspace setup, one-command dev, build/e2e flows);
  the `AUTOLOGGER_CF_BUILD` + logo-`cp` instructions die. Setup section becomes root
  `npm install`.
- CLAUDE.md: setup/layout/guardrails sections update; the `public/` guardrail becomes
  `web/dist/` (build artifact — don't hand-edit or commit).
- Root `package.json` version 0.4.0 → 0.5.0 at ship. No CHANGELOG file exists in this
  repo; release notes stay in the git log + plan docs, as with v0.4.0.

## Definition of done

- `npm install` (root) → `npm run dev` serves the app at :5173 (Vite, proxied API/WS) with
  live HMR against the Node server at :8787.
- `npm run build && npm run start` serves the production app at :8787 from `web/dist` with
  no serve-time rewriting.
- `npm test`, `npm run typecheck`, `npm run lint` green from the root.
- `npm run e2e` green (all four smoke scenarios).
- One manual browser pass before merge (login flow with real Google creds, session
  workspace, Companion presence if convenient) — the e2e tier can't cover OAuth.
- `grep -r __API_ROOT__` over this repo returns nothing.

## Risks

- **Vite dev WS proxying** (`ws: true` on `/api`) is the one piece with no precedent in
  either repo — the Python-era dev flow proxied HTTP only, and WS went same-origin in prod.
  Mitigated by smoke scenario 3 (prod path) and a manual dev-mode check during
  implementation.
- **Path resolution from `main.ts` to `web/dist`** assumes the source layout
  (two levels up from `server/src/`). Running the server from a bundled/compiled
  location would break it — acceptable: this repo runs via tsx from source (no build step),
  and the `publicDir` override remains for anything unusual.
- **Workspace hoisting** could surface duplicate-React-type issues between root and `web/`.
  Low risk (server has no React deps); typecheck of both workspaces is the tripwire.

## Out of scope

- Any component, styling, or behavior change (Tailwind migration is sub-project 3).
- The Python repo, including its now-dormant `AUTOLOGGER_CF_BUILD` vite mode (dead code
  there; cleanable later in that repo).
- CI pipelines (none exist in this repo).
- Transcription / YouTube import (remain 503); `restart_supported` (stays `false`).
- Server-side lint tooling.

## Panel & review log

*(pending — adversarial panel runs before the spec→plan gate per repo SDLC)*
