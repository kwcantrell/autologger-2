# Frontend Adoption (Sub-project 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the React frontend into this repo as a `web/` npm workspace with Vite dev proxying and direct production serving — one `npm install && npm run dev` from the root, no serve-time HTML rewriting, verified by a Playwright e2e smoke tier.

**Architecture:** npm workspaces (`server/` + `web/`), staged mechanical adoption per the approved spec `docs/superpowers/specs/2026-07-09-frontend-adoption-design.md`. The server serves `web/dist` resolved from source location; the Vite dev server (loopback-pinned) proxies `/api` (with WS) and `/auth` to :8787. The `__API_ROOT__` parameterization is deleted end to end (gate decision E1 includes one line in `AudioRecorder.tsx`).

**Tech Stack:** Node ≥22.12, Hono + @hono/node-server, better-sqlite3, Vite 8 + React 19, vitest 2, @playwright/test, biome 2, concurrently.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-09-frontend-adoption-design.md` — the build contract. `file:line` anchors below are orientation; **locate quoted code by content before editing**.
- **Zero component changes** under `web/src/` except: `api/client.ts`, `pages/index/index.html`, `pages/admin-users/index.html`, and one line in `pages/index/components/AudioRecorder.tsx` (gate decision E1).
- **Python repo untouched**: never modify anything under `/home/kalen/AutoLog` outside `autologger-cf/autologger-cf` (read/copy only).
- Conventional commits (`type(scope): summary`). Commit at the end of every task. Do not push.
- Working directory for all commands: repo root `/home/kalen/AutoLog/autologger-cf/autologger-cf` unless a step says otherwise.
- Root `engines`: `"node": ">=22.12"` (Vite 8 floor) from Task 3 onward.
- The server package must keep working when invoked via `npm run <script> -w server` (cwd = `server/`) **and** when tests run from the repo root.

---

### Task 1: Make `MIGRATIONS_DIR` cwd-independent

The move in Task 2 survives only because `npm -w` chdirs; migrations must resolve from source location, like `web/dist` will later. (Spec stage 1, panel: assumptions #2.)

**Files:**
- Modify: `src/node/config.ts:13`

**Interfaces:**
- Produces: unchanged `createBindings(procEnv)` behavior; migrations found regardless of process cwd.

- [ ] **Step 1: Edit the constant**

In `src/node/config.ts`, replace (locate by content):

```ts
const MIGRATIONS_DIR = join(process.cwd(), 'src/db/migrations');
```

with:

```ts
// Resolved from this file's location, not cwd — the server must work both via
// `npm run -w server` (cwd = server/) and under test runners started elsewhere.
const MIGRATIONS_DIR = fileURLToPath(new URL('../db/migrations', import.meta.url));
```

and add to the imports at the top of the file:

```ts
import { fileURLToPath } from 'node:url';
```

(`join` stays — it is still used for `dataDir` paths.)

- [ ] **Step 2: Verify tests still pass (migrations are exercised by every int test)**

Run: `npm test && npm run typecheck`
Expected: all green (the integration setup runs `createBindings` → `applyMigrations` per test).

- [ ] **Step 3: Verify cwd-independence explicitly**

Run: `cd /tmp && /home/kalen/AutoLog/autologger-cf/autologger-cf/node_modules/.bin/vitest run --root /home/kalen/AutoLog/autologger-cf/autologger-cf --project integration 2>&1 | tail -5; cd -`
Expected: integration project passes even with shell cwd `/tmp`. (If the `--root` invocation fails for reasons unrelated to migrations, note it and rely on Step 2 — the real guarantee is the `import.meta.url` resolution.)

- [ ] **Step 4: Commit**

```bash
git add src/node/config.ts
git commit -m "fix(config): resolve MIGRATIONS_DIR from source location, not cwd"
```

---

### Task 2: Workspace conversion (`src/` → `server/src/`)

Mechanical stage-1 move. Zero **API** behavior change; SPA serving from the old root `public/` snapshot goes knowingly dark until Task 5. (Spec stage 1.)

**Files:**
- Move: `src/` → `server/src/`, `tsconfig.json` → `server/tsconfig.json`, `vitest.workspace.ts` → `server/vitest.workspace.ts`, `.env.example` → `server/.env.example`
- Create: `server/package.json`
- Modify: `package.json` (root), `README.md` (quickstart paths)

**Interfaces:**
- Produces: workspaces `server` (name `autologger-server`); root fan-out scripts `dev`/`start`/`test`/`typecheck` (server-only until Task 7). Later tasks rely on: server source at `server/src/`, server cwd = `server/` under `npm -w`.

- [ ] **Step 1: Move the files with git mv**

```bash
mkdir server
git mv src server/src
git mv tsconfig.json server/tsconfig.json
git mv vitest.workspace.ts server/vitest.workspace.ts
git mv .env.example server/.env.example
```

- [ ] **Step 2: Move local (gitignored) runtime state so dev keeps working**

```bash
[ -f .env ] && mv .env server/.env || true
[ -d data ] && mv data server/data || true
```

- [ ] **Step 3: Write `server/package.json`**

```json
{
  "name": "autologger-server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "dev": "tsx watch --env-file-if-exists=.env src/main.ts",
    "start": "tsx --env-file-if-exists=.env src/main.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@hono/node-server": "^1.19.11",
    "@hono/node-ws": "^1.3.1",
    "better-sqlite3": "^12.11.1",
    "hono": "^4.6.14",
    "jose": "^5.9.6",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^26.1.1",
    "tsx": "^4.23.0",
    "typescript": "^5.7.2",
    "vitest": "^2.1.9"
  }
}
```

Note: `@playwright/test` deliberately does NOT come along — it moves to root devDependencies (it was misfiled in the server's `dependencies`).

- [ ] **Step 4: Rewrite the root `package.json`**

Replace the whole file with:

```json
{
  "name": "autologger",
  "version": "0.4.0",
  "private": true,
  "description": "AutoLogger — portable Node server + React frontend (npm workspaces)",
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "workspaces": [
    "server",
    "web"
  ],
  "scripts": {
    "dev": "npm run dev -w server",
    "start": "npm run start -w server",
    "typecheck": "npm run typecheck -w server",
    "test": "npm run test -w server"
  },
  "devDependencies": {
    "@playwright/test": "^1.61.1",
    "@types/node": "^26.1.1",
    "concurrently": "^9.1.0"
  }
}
```

(`web` in `workspaces` is forward-declared; npm tolerates a missing workspace dir until Task 3 creates it — if `npm install` complains, temporarily set `"workspaces": ["server"]` and restore in Task 3.)

- [ ] **Step 5: Patch README quickstart paths (spec: panel scope #7)**

In `README.md`, locate the "Quick start (local)" code block and replace:

```bash
npm install
cp .env.example .env               # fill GOOGLE_CLIENT_ID/SECRET for real OAuth
```

with:

```bash
npm install
cp server/.env.example server/.env # fill GOOGLE_CLIENT_ID/SECRET for real OAuth
# upgrading an existing checkout? your state moved: mv .env data server/
```

(The migration one-liner is a spec requirement — panel scope #1 — for other checkouts;
Step 2 only fixed this machine.)

- [ ] **Step 6: Reinstall and verify**

```bash
rm -rf node_modules package-lock.json
npm install
npm test && npm run typecheck
```

Expected: install succeeds (one root lockfile), all tests green, typecheck green.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor!: convert to npm workspaces — src/ becomes server/src/ (spec stage 1)

Existing checkouts: local runtime state moved — run \`mv .env data server/\`
(and delete the stale root public/ snapshot; it is rebuilt as web/dist in
stage 3)."
```

---

### Task 3: Create the `web/` workspace (frontend snapshot + config)

**Files:**
- Create: `web/src/**` (copied from `/home/kalen/AutoLog/frontend/src`), `web/tsconfig.json`, `web/tsconfig.node.json`, `web/biome.json` (copied), `web/package.json` (new), `web/vite.config.ts` (new), `web/public/static/logo-autologger-{transparent,app}.png`
- Modify: root `package.json` (engines tighten)

**Interfaces:**
- Produces: `npm run build -w web` → `web/dist/` (pages at `dist/src/pages/{index,admin-users}/index.html`, assets at `dist/assets/`, logos at `dist/static/`); `npm run dev -w web` → Vite on `127.0.0.1:5173` proxying `/api` (ws) + `/auth` to :8787; `npm run typecheck -w web`.

- [ ] **Step 1: Copy the frontend source (never modify the original)**

```bash
mkdir web
cp -r /home/kalen/AutoLog/frontend/src web/src
cp /home/kalen/AutoLog/frontend/tsconfig.json /home/kalen/AutoLog/frontend/tsconfig.node.json /home/kalen/AutoLog/frontend/biome.json web/
```

Do NOT copy: `package.json`, `package-lock.json`, `vite.config.ts`, `typedoc.json`, `node_modules` (new `package.json`/`vite.config.ts` are written below; typedoc stays behind per spec).

- [ ] **Step 2: Write `web/package.json`**

Runtime deps identical to the source frontend; typedoc pruned; `preview` dropped (spec: panel scope #3); `typecheck` added (spec: panel assumptions #6).

```json
{
  "name": "autologger-web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit",
    "lint": "biome check --write src/",
    "format": "biome format --write src/"
  },
  "dependencies": {
    "@radix-ui/react-dialog": "^1.1.15",
    "@radix-ui/react-popover": "^1.1.15",
    "@radix-ui/react-radio-group": "^1.3.8",
    "@radix-ui/react-select": "^2.2.6",
    "@radix-ui/react-tooltip": "^1.2.8",
    "@tanstack/react-query": "^5.0.0",
    "@tanstack/react-query-devtools": "^5.0.0",
    "@tanstack/react-virtual": "^3.13.24",
    "clsx": "^2.1.1",
    "overlayscrollbars": "^2.16.0",
    "overlayscrollbars-react": "^0.5.6",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^6.0.0",
    "typescript": "^6.0.0",
    "vite": "^8.0.0"
  }
}
```

(TypeScript ^6 here vs ^5.7 in `server/` is **intentional divergence** — each workspace resolves its own; npm nests conflicting majors per-workspace.)

- [ ] **Step 3: Write `web/vite.config.ts`**

The `AUTOLOGGER_CF_BUILD` fork, `/static/react-dist` base, and the `/static` proxy entry are gone; `server.host` is pinned to loopback (spec: panel failure #3 — the proxy must never expose the server to the LAN as `127.0.0.1`).

```ts
import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  base: '/',

  css: {
    modules: { localsConvention: 'camelCaseOnly' },
  },

  resolve: {
    alias: {
      '@/api': path.resolve(__dirname, 'src/api'),
      '@/shared': path.resolve(__dirname, 'src/shared'),
      '@/pages': path.resolve(__dirname, 'src/pages'),
    },
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'admin-users': path.resolve(__dirname, 'src/pages/admin-users/index.html'),
        index: path.resolve(__dirname, 'src/pages/index/index.html'),
      },
    },
  },

  server: {
    // Loopback only — the proxy would otherwise let LAN peers reach the API
    // *as* 127.0.0.1, bypassing IP_ALLOWLIST. LAN device testing goes through
    // the production serve path at :8787.
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', ws: true },
      '/auth': 'http://localhost:8787',
    },
  },
});
```

- [ ] **Step 4: Logos → `web/public/static/`, optimized (spec: panel scope #6)**

```bash
mkdir -p web/public/static
command -v ffmpeg && {
  ffmpeg -y -i /home/kalen/AutoLog/src/autologger/web/static/logo-autologger-transparent.png -vf scale=128:-1 web/public/static/logo-autologger-transparent.png
  ffmpeg -y -i /home/kalen/AutoLog/src/autologger/web/static/logo-autologger-app.png -vf scale=180:-1 web/public/static/logo-autologger-app.png
} || {
  cp /home/kalen/AutoLog/src/autologger/web/static/logo-autologger-transparent.png web/public/static/
  cp /home/kalen/AutoLog/src/autologger/web/static/logo-autologger-app.png web/public/static/
}
ls -la web/public/static/
```

Expected: both PNGs present; with ffmpeg, each well under 50 KB (originals are 129 KB / 339 KB). If ffmpeg is unavailable and the originals were copied, note it in the commit message (accepted residual, but try `npx @squoosh/cli` or similar first).

- [ ] **Step 5: Tighten root engines (Vite 8 floor — spec: panel assumptions #7)**

In root `package.json`, change:

```json
  "engines": {
    "node": ">=22"
  },
```

to:

```json
  "engines": {
    "node": ">=22.12"
  },
```

(If Task 2 Step 4 had to shrink `workspaces` to `["server"]`, restore `["server", "web"]` now.)

- [ ] **Step 6: Install and build**

```bash
npm install
npm run build -w web
npm run typecheck -w web
ls web/dist/src/pages/index/index.html web/dist/src/pages/admin-users/index.html web/dist/static/
```

Expected: build succeeds; both page HTML files exist under `web/dist/src/pages/`; `web/dist/static/` contains the two logos. `web/dist` is already gitignored by the existing any-depth `dist/` pattern — verify with `git status --short web/ | grep dist` → empty.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): adopt React frontend as web/ workspace (spec stage 2)"
```

---

### Task 4: Delete the API-root parameterization (incl. gate decision E1)

**Files:**
- Modify: `web/src/api/client.ts`, `web/src/pages/index/index.html`, `web/src/pages/admin-users/index.html`, `web/src/pages/index/components/AudioRecorder.tsx`

**Interfaces:**
- Produces: `API_ROOT` is the constant `'/api'` exported from `web/src/api/client.ts`; `apiFetch`/`apiUrl`/`wsUrl` signatures unchanged (consumers untouched).

- [ ] **Step 1: `client.ts` — constant API_ROOT**

Replace (locate by content):

```ts
const rawApiRoot = (document.body.dataset.apiRoot ?? '').trim();
export const API_ROOT =
  rawApiRoot === '__API_ROOT__' || rawApiRoot === '' ? '/api' : rawApiRoot.replace(/\/$/, '');
```

with:

```ts
export const API_ROOT = '/api';
```

- [ ] **Step 2: `client.ts` — simplify `wsUrl` and its doc comment (spec: panel scope #8)**

Replace:

```ts
/**
 * WebSocket URL for an API path, mirroring `apiUrl`'s API_ROOT logic:
 * an absolute API_ROOT (`http(s)://…`) swaps its scheme to `ws(s)`; a relative
 * `/api` root resolves same-origin against the current page. The cookie rides the
 * same-origin upgrade.
 */
export function wsUrl(path: string): string {
  const suffix = `/${path.replace(/^\//, '')}`;
  if (/^https?:\/\//i.test(API_ROOT)) {
    return `${API_ROOT.replace(/^http/i, 'ws')}${suffix}`;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${API_ROOT}${suffix}`;
}
```

with:

```ts
/**
 * WebSocket URL for an API path: resolves same-origin against the current
 * page under the `/api` root. The cookie rides the same-origin upgrade.
 */
export function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${API_ROOT}/${path.replace(/^\//, '')}`;
}
```

- [ ] **Step 3: Strip `data-api-root` from both page HTML files**

`web/src/pages/index/index.html` — replace:

```html
  <body data-api-root="__API_ROOT__" data-v4-transport="rolling">
```

with:

```html
  <body data-v4-transport="rolling">
```

`web/src/pages/admin-users/index.html` — replace:

```html
  <body data-api-root="__API_ROOT__">
```

with:

```html
  <body>
```

- [ ] **Step 4: E1 — `AudioRecorder.tsx` one-line edit**

In `web/src/pages/index/components/AudioRecorder.tsx`, inside `beaconRelease`, replace (locate by content):

```ts
        // Use raw fetch URL — apiFetch is not available at page hide time
        const apiRoot = (document.body.dataset.apiRoot ?? '').replace(/\/$/, '') || '/api';
        navigator.sendBeacon(`${apiRoot}/sessions/${sessionId}/audio-recording-lease/release`, b);
```

with:

```ts
        // Use raw sendBeacon URL — apiFetch is not available at page hide time
        navigator.sendBeacon(`${API_ROOT}/sessions/${sessionId}/audio-recording-lease/release`, b);
```

and add to the file's imports (match the file's existing import style for `@/api` vs relative — use whatever `client.ts` is imported as elsewhere in `web/src/pages/index/`; the alias form is):

```ts
import { API_ROOT } from '@/api/client';
```

If the file already imports from the client module, extend that import instead of adding a new line.

- [ ] **Step 5: Verify — grep, typecheck, build**

```bash
grep -rE "__API_ROOT__|data-api-root|dataset\.apiRoot" web/src ; echo "grep exit: $?"
npm run build -w web
```

Expected: grep exit 1 — no matches in `web/src`. (Scoped to the frontend on purpose:
`server/src/app.ts` still carries the serve-time rewrite until Task 5; the repo-wide
sweep is Task 10 Step 5.) Build green.

- [ ] **Step 6: Commit**

```bash
git add web/src
git commit -m "feat(web): delete API-root parameterization — hardcode same-origin /api (gate E1)"
```

---

### Task 5: Server serving rewire (TDD) + `public/` snapshot removal

**Files:**
- Test: `server/src/routers/staticServing.int.test.ts` (new)
- Modify: `server/src/app.ts`, `server/src/main.ts`, `.gitignore`
- Delete: `public/` (untracked stale snapshot dir, if present)

**Interfaces:**
- Consumes: `wireApp(app, upgradeWebSocket, { publicDir?, bindings? })` from `server/src/app.ts`; test harness `env` proxy from `server/src/test/harness.ts`.
- Produces: `wireApp` serves page HTML **verbatim** (no substitution); `main.ts` passes `publicDir` = `<repo>/web/dist` resolved from source location.

- [ ] **Step 1: Write the failing integration test**

Create `server/src/routers/staticServing.int.test.ts`:

```ts
// Serving contract for the built SPA (spec stage 3): HTML verbatim (no
// __API_ROOT__ substitution), assets + /static served, API never shadowed.
// Uses a fixture dist in a temp dir — `npm test` stays independent of a real
// Vite build (the e2e tier covers that).

import { Hono } from 'hono';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpgradeWebSocket } from 'hono/ws';
import { afterAll, describe, expect, it } from 'vitest';
import { wireApp } from '../app';
import { env } from '../test/harness';
import type { AppEnv } from '../types';

const upgradeStub = ((() => async (c: { text(b: string, s: number): Response }) =>
  c.text('WebSocket unavailable in HTTP tests', 426)) as unknown) as UpgradeWebSocket;

const dist = mkdtempSync(join(tmpdir(), 'autologger-dist-'));
mkdirSync(join(dist, 'src/pages/index'), { recursive: true });
mkdirSync(join(dist, 'src/pages/admin-users'), { recursive: true });
mkdirSync(join(dist, 'assets'), { recursive: true });
mkdirSync(join(dist, 'static'), { recursive: true });
// The rewrite token is assembled by concatenation so the CONTIGUOUS string
// never appears in this source file — the spec's DoD grep over the repo must
// stay clean. The *served fixture* still contains the real token, which is
// what makes the verbatim assertion fail while serveHtml still rewrites.
const REWRITE_TOKEN = ['__API_', 'ROOT__'].join('');
writeFileSync(
  join(dist, 'src/pages/index/index.html'),
  `<!DOCTYPE html><html><body>index page ${REWRITE_TOKEN} stays verbatim</body></html>`,
);
writeFileSync(
  join(dist, 'src/pages/admin-users/index.html'),
  '<!DOCTYPE html><html><body>admin page</body></html>',
);
writeFileSync(join(dist, 'assets/app-abc123.js'), 'console.log("bundle");');
writeFileSync(join(dist, 'static/logo.png'), 'png-bytes');

const app = wireApp(new Hono<AppEnv>(), upgradeStub, { publicDir: dist });

afterAll(() => rmSync(dist, { recursive: true, force: true }));

describe('static serving (fixture dist)', () => {
  it('serves / verbatim — no serve-time rewrite of the old token', async () => {
    const res = await app.request('/', {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`${REWRITE_TOKEN} stays verbatim`);
  });

  it('serves /admin/users HTML', async () => {
    const res = await app.request('/admin/users', {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('admin page');
  });

  it('serves hashed /assets/* and /static/* files', async () => {
    const js = await app.request('/assets/app-abc123.js', {}, env);
    expect(js.status).toBe(200);
    expect(await js.text()).toContain('bundle');
    const png = await app.request('/static/logo.png', {}, env);
    expect(png.status).toBe(200);
  });

  it('never shadows API routes with the static catch-all', async () => {
    const res = await app.request('/api/profile', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
  });

  it('404s unknown paths', async () => {
    const res = await app.request('/definitely-not-a-page', {}, env);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it — the verbatim test must FAIL**

Run: `npm test -w server -- staticServing`
Expected: "serves / verbatim" FAILS — the current `serveHtml` rewrites the token in the
served fixture to `/api`, so the `stays verbatim` string comes back mangled. The other
assertions pass.

- [ ] **Step 3: Delete the rewrite in `server/src/app.ts`**

Replace (locate by content):

```ts
  // Static hosting. __API_ROOT__ substitution is PHASE-1 TRANSITIONAL (spec:
  // scope #6) — sub-project 2 replaces it with a Vite build-time define.
  async function serveHtml(c: Context<AppEnv>, assetPath: string) {
    let html: string;
    try {
      html = await readFile(join(publicDir, assetPath), 'utf-8');
    } catch {
      return c.notFound();
    }
    return c.html(html.replaceAll('__API_ROOT__', '/api'));
  }
```

with:

```ts
  // Static hosting: explicit page routes (no client-side router) + a catch-all
  // for hashed /assets/* and /static/*. publicDir is the web/ workspace's Vite
  // build output, passed by main.ts (tests pass a fixture dir).
  async function serveHtml(c: Context<AppEnv>, assetPath: string) {
    let html: string;
    try {
      html = await readFile(join(publicDir, assetPath), 'utf-8');
    } catch {
      return c.notFound();
    }
    return c.html(html);
  }
```

- [ ] **Step 4: Point `main.ts` at `web/dist` + startup hint**

In `server/src/main.ts`, add to the imports:

```ts
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
```

After the `const hostname = …` line, add:

```ts
// web/dist resolved from this file's location (server/src/ → repo root/web/dist)
// so cwd never matters. API-only operation is legitimate; just say why / 404s.
const webDist = join(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
if (!existsSync(webDist)) {
  console.warn('frontend not built — run `npm run build` (serving API only)');
}
```

and change the `wireApp` call from:

```ts
wireApp(app, upgradeWebSocket, { bindings });
```

to:

```ts
wireApp(app, upgradeWebSocket, { bindings, publicDir: webDist });
```

- [ ] **Step 5: Run tests — all green now**

Run: `npm test && npm run typecheck`
Expected: PASS including all five `staticServing` assertions.

- [ ] **Step 6: Remove the `public/` ignore entry and the stale snapshot (spec: panel failure #6)**

In `.gitignore`, delete these two lines (the `dist/` pattern above them already covers `web/dist/` at any depth — do not add a new entry):

```
# SPA build artifact — reproduced by the frontend build (AUTOLOGGER_CF_BUILD=1)
public/
```

Then delete the stale snapshot so it can't be accidentally committed once un-ignored:

```bash
rm -rf public
git status --short | head
```

Expected: no `public/` in git status output.

- [ ] **Step 7: Smoke the real thing**

```bash
(cd server && PORT=8790 REQUIRE_LOGIN=0 DATA_DIR=$(mktemp -d) npx tsx src/main.ts &) && sleep 3
curl -s http://127.0.0.1:8790/ | grep -o '<title>[^<]*</title>'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8790/api/profile
pkill -f 'tsx src/main.ts'
```

Expected: `<title>AutoLogger</title>` (served from `web/dist`, no rewrite) and `200`.

- [ ] **Step 8: Commit**

```bash
git add server/src/app.ts server/src/main.ts server/src/routers/staticServing.int.test.ts .gitignore
git commit -m "feat(serving): serve web/dist directly — __API_ROOT__ rewrite and public/ snapshot removed (spec stage 3)"
```

---

### Task 6: Graceful-shutdown hardening

`server.close()` never completes while a WebSocket is open — the normal state of this app — so Ctrl-C under `concurrently` and Playwright teardown would hang/SIGKILL every time. (Spec stage 4, panel failure #2.)

**Files:**
- Modify: `server/src/main.ts`

**Interfaces:**
- Produces: SIGINT/SIGTERM closes all connections (incl. upgraded sockets) and exits ≤ 5 s even with live WebSockets.

- [ ] **Step 1: Harden the signal handler**

In `server/src/main.ts`, replace (locate by content):

```ts
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => {
      close();
      process.exit(0);
    });
  });
}
```

with:

```ts
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    // server.close() alone never completes while a WebSocket is open (upgraded
    // sockets aren't idle keep-alives) — the normal state of this app. Destroy
    // them too, and guarantee exit even if something else holds the loop.
    const failsafe = setTimeout(() => process.exit(1), 5000);
    failsafe.unref();
    server.close(() => {
      close();
      process.exit(0);
    });
    (server as import('node:http').Server).closeAllConnections?.();
  });
}
```

- [ ] **Step 2: Verify empirically with a live WebSocket**

The only WS route is `/api/sessions/:sessionId/ws` (gated by `requireSession`), so create
a session first. A failed upgrade would make this check pass vacuously — the `WS OPEN`
precondition guards against that.

```bash
(cd server && PORT=8790 REQUIRE_LOGIN=0 DATA_DIR=$(mktemp -d) npx tsx src/main.ts &) && sleep 3
SID=$(curl -s -X POST http://127.0.0.1:8790/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{"show_id":"show-autolog-test","episode":"1"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
echo "session: $SID"
node -e "
const ws = new WebSocket('ws://127.0.0.1:8790/api/sessions/${SID}/ws?role=browser');
ws.onopen = () => console.log('WS OPEN');
ws.onerror = () => console.log('WS ERROR');
setTimeout(() => process.exit(0), 8000);
" > /tmp/ws-check.log &
sleep 2
grep -q 'WS OPEN' /tmp/ws-check.log && echo "precondition ok — live WebSocket" \
  || echo "PRECONDITION FAILED — no live WebSocket; this check proves nothing, fix first"
SRV_PID=$(pgrep -f 'tsx src/main.ts' | head -1)
kill -INT "$SRV_PID"
sleep 3
pgrep -f 'tsx src/main.ts' && echo "STILL RUNNING — FAIL" || echo "exited cleanly — PASS"
```

Expected: `precondition ok — live WebSocket` **and** `exited cleanly — PASS` within ~3 s
of the SIGINT. Both lines are required — a PASS without the precondition is vacuous.

- [ ] **Step 3: Run the suite**

Run: `npm test && npm run typecheck`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add server/src/main.ts
git commit -m "fix(server): close live connections on shutdown — Ctrl-C/supervisor teardown no longer hangs"
```

---

### Task 7: Root orchestration + e2e scaffolding (scenarios 1 & 4)

**Files:**
- Modify: root `package.json` (final scripts), `.gitignore` (`e2e/.data/`)
- Create: `playwright.config.ts`, `e2e/global-setup.ts`, `e2e/tsconfig.json`, `biome.json` (root, e2e scope), `e2e/smoke.spec.ts` (scenarios 1 & 4)

**Interfaces:**
- Consumes: server `start` script (Task 2), `web/dist` build (Task 3), verbatim serving (Task 5).
- Produces: root scripts per the spec's stage-4 table; `npm run e2e` runs Playwright against a hermetic server on :8791. Task 8 extends `e2e/smoke.spec.ts`.

- [ ] **Step 1: Final root `package.json` scripts + devDeps**

Replace the root `"scripts"` block with:

```json
  "scripts": {
    "dev": "concurrently -n server,web -c blue,magenta --kill-others-on-fail \"npm run dev -w server\" \"npm run dev -w web\"",
    "build": "npm run build -w web",
    "start": "npm run start -w server",
    "test": "npm run test -w server",
    "typecheck": "npm run typecheck -w server && npm run typecheck -w web && tsc --noEmit -p e2e",
    "lint": "npm run lint -w web && biome check --write e2e playwright.config.ts",
    "e2e": "npm run build -w web && playwright test"
  },
```

and extend root `"devDependencies"` (keep the existing entries) with:

```json
    "@biomejs/biome": "^2.0.0",
    "typescript": "^5.7.2"
```

(Root `typescript` powers `tsc -p e2e`; it matches the server's ^5.7.2 so npm dedupes/hoists one copy. Root biome matches web's ^2.0.0 — same dedupe.)

Then: `npm install`

- [ ] **Step 2: `.gitignore` — the e2e data dir (spec: panel assumptions #4)**

Add to `.gitignore` (the existing `data/` pattern does NOT match a dir named `.data`):

```
# e2e server state — wiped by e2e/global-setup.ts each run
e2e/.data/
```

- [ ] **Step 3: Root `biome.json` (e2e + playwright config scope)**

Create `biome.json` at the root — same settings as `web/biome.json`, scoped to the e2e tier:

```json
{
  "$schema": "./node_modules/@biomejs/biome/configuration_schema.json",
  "assist": { "actions": { "source": { "organizeImports": "on" } } },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "trailingCommas": "all"
    }
  },
  "files": {
    "includes": ["e2e/**/*.ts", "playwright.config.ts"]
  }
}
```

- [ ] **Step 4: `playwright.config.ts` (hermetic webServer — spec: panel req #1/assumptions #1–#3)**

```ts
import { defineConfig } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:8791',
  },
  webServer: {
    command: 'npm run start -w server',
    url: 'http://127.0.0.1:8791/api/profile',
    // Never adopt a leftover orphan started with different env.
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      PORT: '8791',
      HOST: '127.0.0.1',
      REQUIRE_LOGIN: '0',
      // Absolute — the server script's cwd is server/, so a relative path
      // would land at server/e2e/.data.
      DATA_DIR: join(here, 'e2e', '.data'),
      // Hermetic: explicit empty strings BEAT server/.env values (process env
      // wins over --env-file). A developer's real Google creds would otherwise
      // flip oauthConfigured() and 401 the anonymous smoke flow.
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      PUBLIC_BASE_URL: '',
      IP_ALLOWLIST: '',
      API_TOKEN: '',
      ADMIN_TOKEN: '',
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
```

- [ ] **Step 5: `e2e/global-setup.ts` (the wipe has an owner)**

```ts
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Wipe the e2e server state before the webServer boots — a crashed prior run
 * (SIGKILL teardown) must not leak DBs/WAL files into this run. */
export default function globalSetup(): void {
  rmSync(join(dirname(fileURLToPath(import.meta.url)), '.data'), {
    recursive: true,
    force: true,
  });
}
```

- [ ] **Step 6: `e2e/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["./**/*.ts", "../playwright.config.ts"]
}
```

- [ ] **Step 7: `e2e/smoke.spec.ts` — scenarios 1 & 4**

```ts
import { expect, test } from '@playwright/test';

test('workspace shell renders with no page errors', async ({ page }) => {
  const errors: Error[] = [];
  page.on('pageerror', (e) => errors.push(e));
  await page.goto('/');
  await expect(
    page.getByText('Select a session, or create a new one from the left rail.'),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('/admin/users renders', async ({ page }) => {
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: 'Admin Users' })).toBeVisible();
});
```

- [ ] **Step 8: Install chromium (one-time) and run**

```bash
npx playwright install chromium
npm run e2e
```

Expected: both tests PASS. Then run the rest of the gates: `npm run typecheck && npm run lint && npm test` → all green.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json .gitignore biome.json playwright.config.ts e2e/
git commit -m "feat(e2e): root orchestration scripts + hermetic Playwright smoke harness (spec stage 4)"
```

---

### Task 8: Smoke scenarios 2 & 3 (UI session + live-WS probe)

**Files:**
- Modify: `e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: seeded show `show-autolog-test` ('Autolog Test Show', category "Scene" of type BUTTON — `server/src/db/migrations/0001_init.sql`); UI selectors below (verified against the frontend source; re-verify by content if any click times out).

Selector reference (verified against the live frontend source — plan review):
- New Session button: `#v6-btn-new-session`; modal form `#new-session-form`; submit `#ns-submit` ("Create & open").
- **`#ns-show` is a Radix Select trigger `<button>`, NOT a native `<select>`** — `selectOption` will throw; the options are portal-rendered `role="option"` items. The anonymous default studio (`test-studios`) owns exactly one show, so "Autolog Test Show" is **preselected** — assert the trigger's text instead of selecting. If ever needed: `click()` the trigger, then `getByRole('option', { name: /Autolog Test Show/ }).click()`.
- Session active: `#v3-session-grid` loses the `hidden` class; `document.body.dataset.sessionId` holds the id.
- Transport roll (enables category buttons): `#btn-ctl-2` (btn2 = "roll timecode", only in stop state).
- Category buttons (rolling): `#cat-strip-live-slot [data-category-id]`, BUTTON-type logs its label immediately; "Scene" is BUTTON-type in the seeded show.
- Event feed: `#v4-log-sheet`; **row cells use hashed CSS-module classes** (`styles.sheetCat`, `styles.rowMsgText` → `_sheetCat_ab12c_…` at runtime) — never select by those bare class names. Anchor on the unhashed `tr[data-event-id]` and filter by text.
- POST endpoint: `POST /api/sessions/{id}/events` body `{ "category": "<category-id>", "message": "…" }` (category is the category **id**, not the label).

- [ ] **Step 1: Append scenarios 2 & 3 to `e2e/smoke.spec.ts`**

```ts
test('create a session, log via UI, and see an out-of-band event live (WS)', async ({
  page,
}) => {
  await page.goto('/');

  // Scenario 2: create a session through the UI. #ns-show is a Radix Select
  // trigger (not a native <select>); the anonymous default studio owns exactly
  // one show, so "Autolog Test Show" is preselected — assert, don't select.
  await page.locator('#v6-btn-new-session').click();
  await expect(page.locator('#new-session-form')).toBeVisible();
  await expect(page.locator('#ns-show')).toBeEnabled();
  await expect(page.locator('#ns-show')).toContainText('Autolog Test Show');
  await page.locator('#ns-submit').click();
  await expect(page.locator('#v3-session-grid')).not.toHaveClass(/hidden/);

  // Roll timecode so category buttons enable, then log via the "Scene" button.
  await page.locator('#btn-ctl-2').click();
  const sceneBtn = page
    .locator('#cat-strip-live-slot [data-category-id]')
    .filter({ hasText: 'Scene' });
  await expect(sceneBtn).toBeEnabled();
  await sceneBtn.click();
  // Row cells carry hashed CSS-module classes — anchor on tr[data-event-id].
  await expect(
    page.locator('#v4-log-sheet tr[data-event-id]').filter({ hasText: 'Scene' }).first(),
  ).toBeVisible();

  // Scenario 3: out-of-band POST; the row must appear with NO reload, focus
  // change, or page interaction — otherwise React Query's refetchOnWindowFocus
  // could fetch over HTTP and mask a dead WebSocket.
  const sessionId = await page.evaluate(() => document.body.dataset.sessionId);
  expect(sessionId).toBeTruthy();
  const categoryId = await sceneBtn.getAttribute('data-category-id');
  expect(categoryId).toBeTruthy();
  await page.evaluate(
    async ({ sid, cat }) => {
      const res = await fetch(`/api/sessions/${sid}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: cat, message: 'e2e-live-probe' }),
      });
      if (!res.ok) throw new Error(`POST /events failed: ${res.status}`);
    },
    { sid: sessionId as string, cat: categoryId as string },
  );
  await expect(
    page.locator('#v4-log-sheet tr[data-event-id]').filter({ hasText: 'e2e-live-probe' }),
  ).toBeVisible({ timeout: 10_000 });
});
```

- [ ] **Step 2: Run the e2e suite**

Run: `npm run e2e`
Expected: all 3 tests PASS. If "Autolog Test Show" is not preselected in the `#ns-show`
trigger, open the Radix select (`await page.locator('#ns-show').click()`) and pick it via
`page.getByRole('option', { name: /Autolog Test Show/ }).click()` — the options are
portal-rendered `role="option"` items, not `<option>` elements. If the "Scene" button
never enables, screenshot and check whether transport roll (`#btn-ctl-2`) requires an
extra state — the button config lives in `web/src/pages/index/components/TransportControls.tsx`.

- [ ] **Step 3: Full gates**

Run: `npm test && npm run typecheck && npm run lint && npm run e2e`
Expected: everything green.

- [ ] **Step 4: Commit**

```bash
git add e2e/smoke.spec.ts
git commit -m "test(e2e): session-create + UI log + live-WS probe smoke scenarios"
```

---

### Task 9: Docs + version 0.5.0

**Files:**
- Modify: `README.md`, `CLAUDE.md`, root `package.json` (version)

- [ ] **Step 1: README — rewrite the serving/setup story**

Replace the entire "## Serving the SPA" section (locate by heading) with:

```markdown
## Frontend (web/ workspace)

The React frontend lives in `web/` (Vite 8 + React 19, CSS Modules) and is canonical for
this app. `npm run build` emits `web/dist/`; the server serves it directly — `GET /` and
`GET /admin/users` return the built page HTML verbatim (no serve-time rewriting; the API
root is hardcoded same-origin `/api`), and a static catch-all serves hashed `/assets/*`
plus `/static/*` (favicon logos ship from `web/public/static/`).

### Dev flow

```bash
npm run dev        # concurrently: server (tsx watch, :8787) + Vite (:5173)
```

Browse `http://127.0.0.1:5173/src/pages/index/index.html`. Vite proxies `/api` (incl. the
session WebSocket) and `/auth` to :8787.

**Dev auth is anonymous by design**: set `REQUIRE_LOGIN=0` and `HOST=127.0.0.1` in
`server/.env`. Google OAuth cannot round-trip through the Vite proxy (the callback
redirects to `PUBLIC_BASE_URL` on :8787 and the cookie lands on that origin) — verify
OAuth against the production serve path instead:

```bash
npm run build && npm run start   # everything on :8787
```

If dev auth is misconfigured (login required but no session), the first symptom is an
opaque WebSocket drop — the 401 fires before the upgrade, so the browser sees a bare
close with no status.

**Keep Vite on loopback.** `server.host` is pinned to `127.0.0.1` in `web/vite.config.ts`;
exposing Vite to the LAN would let peers reach the API *as* 127.0.0.1, bypassing
`IP_ALLOWLIST`. Test LAN devices against :8787.

### e2e smoke

```bash
npx playwright install chromium   # one-time
npm run e2e                       # builds web/, boots a hermetic server on :8791
```

The Playwright `webServer` runs with `REQUIRE_LOGIN=0`, loopback bind, a wiped
`e2e/.data/` DATA_DIR, and explicitly blanked OAuth/token env — your real `server/.env`
never leaks into the suite.
```

Also update the top-of-README quickstart (already `cp server/.env.example server/.env`
from Task 2) to mention `npm run dev` starting both processes, and bump any
`Version:` string the README carries to 0.5.0 if present.

- [ ] **Step 2: CLAUDE.md — layout/commands/guardrails**

Update `CLAUDE.md` (this repo's, at the root):

1. In "Project overview", state the repo is now npm workspaces: `server/` (Node backend) + `web/` (React frontend, canonical copy) + `e2e/` (Playwright smoke).
2. In "Setup & commands", replace the command block with:

```markdown
```bash
npm install
cp server/.env.example server/.env             # fill GOOGLE_CLIENT_ID/SECRET for real OAuth

npm run dev                                    # server :8787 + Vite :5173 (concurrently)
npm run build && npm run start                 # production: server serves web/dist
npm run typecheck                              # server + web + e2e
npm test                                       # server vitest (unit + integration)
npm run e2e                                    # Playwright smoke (hermetic server on :8791)
npm run lint                                   # biome: web src/ + e2e/
```
```

3. In "Source layout", note: server code now under `server/src/` (same module map), frontend under `web/src/`, e2e under `e2e/`.
4. In "Guardrails", replace the `public/` bullet with: "`web/dist/` is a reproducible build artifact (gitignored) — don't hand-edit or commit it. Keep the Vite dev server loopback-bound (`server.host` pin in `web/vite.config.ts`); LAN testing goes through :8787."
5. Add one invariant line: "Dev auth is anonymous (`REQUIRE_LOGIN=0`, loopback); OAuth is verified on the production serve path — the Vite proxy cannot round-trip the Google callback."

- [ ] **Step 3: Version bump**

Root `package.json`: `"version": "0.4.0"` → `"version": "0.5.0"`.

- [ ] **Step 4: Verify docs commands are copy-paste true**

Run each command block you wrote (skip `playwright install` if cached): `npm run typecheck && npm test` at minimum.
Expected: green; no README command references a path that doesn't exist.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md package.json
git commit -m "docs: workspace layout, dev-auth recipe, e2e flow — v0.5.0"
```

---

### Task 10: Full Definition-of-Done verification

**Files:** none (verification only; fix-forward if anything fails).

- [ ] **Step 1: Clean-slate gates**

```bash
rm -rf node_modules server/node_modules web/node_modules package-lock.json
npm install
npm test && npm run typecheck && npm run lint
npm run e2e
```

Expected: all green from a fresh install. (`npm run e2e` must also pass with a fully filled-in `server/.env` — if yours is blank, temporarily fill dummy `GOOGLE_CLIENT_ID/SECRET` + `PUBLIC_BASE_URL` and re-run to prove hermeticity, then restore.)

- [ ] **Step 2: Dev flow + WS-through-proxy check (spec risk #1)**

Precondition: `server/.env` holds the **stated dev config** (`REQUIRE_LOGIN=0`,
`HOST=127.0.0.1`) — the DoD's dev bullet is scoped to it, and the session-create below is
anonymous.

```bash
npm run dev &
sleep 6
curl -s http://127.0.0.1:5173/src/pages/index/index.html | grep -o '<title>[^<]*</title>'   # Vite serves the page
curl -s http://127.0.0.1:5173/api/profile | head -c 120; echo                                # HTTP proxied
SID=$(curl -s -X POST http://127.0.0.1:5173/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{"show_id":"show-autolog-test","episode":"1"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
node -e "
const ws = new WebSocket('ws://127.0.0.1:5173/api/sessions/${SID}/ws?role=browser');
ws.onopen = () => { console.log('WS through Vite proxy: OPEN'); process.exit(0); };
ws.onerror = () => { console.log('WS through Vite proxy: FAILED'); process.exit(1); };
setTimeout(() => process.exit(1), 5000);
"
```

Expected: title printed, JSON profile body, `WS through Vite proxy: OPEN` — the proxied
upgrade reaching the same route that Task 6 Step 2 exercised directly on :8790. (If the
POST 400s because the seeded show belongs to a different session DB state, create the
session through the UI instead and read `document.body.dataset.sessionId`.)

- [ ] **Step 3: Ctrl-C teardown check (DoD bullet)**

With `npm run dev` still running in the foreground of a terminal, press Ctrl-C (or `kill -INT` the `concurrently` process group), then:

```bash
sleep 3
ss -ltn | grep -E '8787|5173' && echo "PORTS STILL HELD — FAIL" || echo "both ports freed — PASS"
```

Expected: `both ports freed — PASS`.

- [ ] **Step 4: Prod flow**

```bash
npm run build && npm run start &
sleep 4
curl -s http://127.0.0.1:8787/ | grep -c '__API_ROOT__'    # must be 0
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/static/logo-autologger-transparent.png
kill -INT %% 2>/dev/null || pkill -f 'tsx --env-file'
```

Expected: `0` and `200`.

- [ ] **Step 5: Repo-wide grep (DoD)**

```bash
grep -rE '__API_ROOT__|data-api-root|dataset\.apiRoot' --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=docs . || echo CLEAN
```

Expected: `CLEAN` — strictly. Only `docs/` is excluded (the spec/plan legitimately
mention the strings). The `staticServing.int.test.ts` fixture assembles the token by
concatenation precisely so this sweep stays clean; if the grep finds anything, that is a
real failure, not an acceptable residual.

- [ ] **Step 6: Report for the manual pass**

Tell the user the automated DoD is green and hand over the one **manual** item (spec DoD): a browser pass on the production serve path with real Google creds (`server/.env` filled, `npm run build && npm run start`, log in at `http://127.0.0.1:8787`, create a session, check Companion presence if convenient). Do not claim this item done — it needs their credentials.

- [ ] **Step 7: Final commit (if verification produced fixes)**

```bash
git status --short
# commit any fix-forward changes with a conventional message; otherwise nothing to do
```
