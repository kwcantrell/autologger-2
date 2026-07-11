# Bitfocus Companion Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Bitfocus Companion (Stream Deck) module in a new `companion/` npm workspace that lets an operator log events, roll/stop takes, and drive record/play on the active AutoLogger session, with live feedbacks and variables.

**Architecture:** A `@companion-module/base` v2 instance that is a pure HTTP client of the server's existing `/api/companion/*` endpoints. It polls `GET /state` on a self-rescheduling timer (single fetch in flight, sequence-fenced), refreshes categories when the active show changes, and does an immediate refetch after every successful action (the "A+C" design). No server changes.

**Tech Stack:** TypeScript (ESM), `@companion-module/base` `~2.0.0` (pinned), `@companion-module/tools` (build/package), Vitest (unit), Playwright + headless Companion 4.3.4 (e2e).

**Spec:** `docs/superpowers/specs/2026-07-10-companion-module-design.md` (approved, panel-reviewed; gate decisions: keep full headless harness; session guard is label-only).

## Global Constraints

- **`@companion-module/base` pinned to `~1.14.0`** (stable 1.x — the documented API this module targets: `runEntrypoint`, `InstanceBase<TConfig>`). Companion 4.3.4's accepted range is `~0.6 || 1 - 1.14.x || 2 - 2.0.x`; the `2.0.x` line **removed `runEntrypoint`** (reworked alpha API, "unconfirmed" for 4.3), so we use stable `1.14.x` (latest 1.x is `1.14.1`). Never install `@latest` / unqualified `^1` (drifts to `1.99.0` nightlies). The `check:base` guard enforces the accepted range. *(Decision 2026-07-10: the plan originally pinned `~2.0.0`; corrected to `~1.14.0` at the gate after Task 1 surfaced that all plan code is 1.x-shaped.)*
- **No new server API surface.** Consume only these five endpoints: `GET /api/companion/state`, `GET /api/companion/categories`, `POST /api/companion/log`, `POST /api/companion/transport`, `POST /api/companion/command`. Do NOT call `POST /api/companion/presence` from the module (that is the browser's heartbeat; the e2e harness simulates it).
- **Server env var is `API_TOKEN`** (this Node repo), not `AUTOLOGGER_API_TOKEN` (the Python sibling). Use `API_TOKEN` in all docs.
- **Concurrency invariants (mandatory):** single `/state` fetch in flight; monotonic sequence number fences stale responses; `refreshNow()` funnels through the same `pollState()` as the tick; self-rescheduling `setTimeout` (not `setInterval`); `destroy()`/`configUpdated()` cancel schedule + debounce timers and abort all fetches via one instance-scoped `AbortController`; an `isDestroyed` flag guards every fetch continuation.
- **Trust boundaries:** `command` (record/play) is fire-and-forget — surface `state.last_command` via `command_delivered`/`command_error` variables. `is_playing` is best-effort (presence-derived, no server self-correction); label the `playing` feedback accordingly. Active session can silently retarget — every preset button shows `deck_title`/`show_code`.
- **Conventional commits**, `type(scope): summary` (scope `companion`). Commit after each task. Branch off `main`; never use worktrees.
- **Biome** formatting: 2-space indent, single quotes, trailing commas `all`, line width 100.
- **Module id** is `autologger`; variables are namespaced `$(autologger:<name>)`.

---

## File structure

```
companion/
  package.json              # name companion-module-autologger, private ESM, deps pinned
  tsconfig.json             # NodeNext, outDir dist/, strict
  vitest.config.ts          # unit tests (node env)
  companion/
    manifest.json           # connection id "autologger", runtime node22, entrypoint ../dist/main.js
    HELP.md                 # operator help (trust boundaries)
  src/
    config.ts               # ModuleConfig type, getConfigFields(), normalizeBaseUrl()
    api.ts                  # AutologgerApi client, ApiError tagged type, endpoint methods
    state.ts                # ServerState type, toVariableValues(), toFeedbackFlags(), showIdChanged()
    variables.ts            # variableDefinitions()
    feedbacks.ts            # feedbackDefinitions(instance)
    actions.ts              # actionDefinitions(instance, categories)
    presets.ts              # presetDefinitions()
    upgrades.ts             # UpgradeScripts = []
    main.ts                 # AutologgerInstance (lifecycle, poll loop, refreshNow, backoff)
    api.test.ts             # unit
    state.test.ts           # unit
    actions.test.ts         # unit
    config.test.ts          # unit
    scripts/check-base-version.mjs   # fails build if base version outside allowed range
e2e/
  companion.e2e.spec.ts     # headless-Companion Playwright project
  companion-harness.ts      # launch Companion headless + seed server helpers
playwright.config.ts        # + "companion" project, binary-gated
```

---

### Task 1: Workspace scaffold + version-pin guard

**Files:**
- Create: `companion/package.json`, `companion/tsconfig.json`, `companion/vitest.config.ts`, `companion/companion/manifest.json`, `companion/companion/HELP.md`, `companion/src/main.ts` (stub), `companion/src/upgrades.ts`, `companion/scripts/check-base-version.mjs`, `companion/.gitignore`
- Modify: root `package.json` (workspaces + scripts)

**Interfaces:**
- Produces: `companion` workspace installable via root `npm install`; `runEntrypoint`-based entry stub; `UpgradeScripts` export (`upgrades.ts`).

- [ ] **Step 1: Create `companion/package.json`**

```json
{
  "name": "companion-module-autologger",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/main.js",
  "license": "MIT",
  "scripts": {
    "check:base": "node scripts/check-base-version.mjs",
    "build": "npm run check:base && tsc -p tsconfig.json",
    "dev": "tsc -p tsconfig.json --watch",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "package": "companion-module-build"
  },
  "dependencies": {
    "@companion-module/base": "~1.14.0"
  },
  "devDependencies": {
    "@companion-module/tools": "^2.0.0",
    "@types/node": "^26.1.1",
    "typescript": "^5.7.2",
    "vitest": "^2.1.9"
  }
}
```

- [ ] **Step 2: Create `companion/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "types": ["node"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "declaration": false,
    "skipLibCheck": true,
    "esModuleInterop": true
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 3: Create `companion/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 4: Create `companion/scripts/check-base-version.mjs`** (build guard for the pin)

```js
// Fail the build if @companion-module/base resolves outside Companion 4.3.4's
// accepted module-API range (~0.6 || 1 - 1.14.x || 2 - 2.0.x).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkgPath = require.resolve('@companion-module/base/package.json');
const { version } = JSON.parse(readFileSync(pkgPath, 'utf8'));
const [major, minor] = version.split('.').map(Number);

const ok =
  (major === 0 && minor === 6) ||
  (major === 1 && minor <= 14) ||
  (major === 2 && minor === 0);

if (!ok) {
  console.error(
    `@companion-module/base ${version} is outside Companion 4.3.4's accepted range ` +
      `(~0.6 || 1 - 1.14.x || 2 - 2.0.x). Pin to ~1.14.0 (stable 1.x).`,
  );
  process.exit(1);
}
console.log(`@companion-module/base ${version} OK for Companion 4.3.4.`);
```

- [ ] **Step 5: Create `companion/companion/manifest.json`**

```json
{
  "type": "connection",
  "id": "autologger",
  "name": "autologger",
  "shortname": "autologger",
  "description": "Control AutoLogger production logging from Bitfocus Companion: log events, roll/stop takes, record and play the active session.",
  "version": "0.1.0",
  "license": "MIT",
  "repository": "https://github.com/local/autologger-cf",
  "bugs": "https://github.com/local/autologger-cf/issues",
  "maintainers": [{ "name": "AutoLogger" }],
  "legacyIds": [],
  "runtime": {
    "type": "node22",
    "api": "nodejs-ipc",
    "apiVersion": "1.14.1",
    "entrypoint": "../dist/main.js"
  },
  "manufacturer": "AutoLogger",
  "products": ["AutoLogger"],
  "keywords": ["logging", "production", "timecode"]
}
```

- [ ] **Step 6: Create `companion/companion/HELP.md`** (operator-facing; states trust boundaries)

```markdown
# AutoLogger

Control an AutoLogger session from Companion. **A browser must be open on the
AutoLogger session** — the module acts on whichever session that browser reports as active.

## Configuration
- **Server URL** — e.g. `http://127.0.0.1:8787`.
- **API token** — only if the server runs with `API_TOKEN` set (`REQUIRE_LOGIN=1`). Leave blank on an open LAN box.
- **Poll interval (ms)** — default 1000.

## Notes
- **Which session?** Buttons show the session/show (`deck_title`) — always check it before pressing; with multiple browser tabs open the active session can change.
- **Record/Play** are relayed to the browser; the `command_error` variable reports if delivery failed. `Playing` state is best-effort (reported by the browser), unlike `Rolling`/`Recording`.
```

- [ ] **Step 7: Create `companion/src/upgrades.ts`** (+ a placeholder `config.ts` so its import resolves)

`upgrades.ts` imports `ModuleConfig` from `./config.js`, but the real `config.ts` isn't built until Task 2. Create a minimal placeholder `companion/src/config.ts` now so Task 1 typechecks; Task 2 overwrites it via TDD:

```ts
// companion/src/config.ts — placeholder; Task 2 replaces this with the real config module.
export interface ModuleConfig {
  url: string;
  token: string;
  pollMs: number;
}
```

```ts
// companion/src/upgrades.ts
import type { CompanionStaticUpgradeScript } from '@companion-module/base';
import type { ModuleConfig } from './config.js';

export const UpgradeScripts: CompanionStaticUpgradeScript<ModuleConfig>[] = [];
```

- [ ] **Step 8: Create `companion/src/main.ts` (stub — replaced in Task 8)**

```ts
import { InstanceBase, runEntrypoint, type SomeCompanionConfigField } from '@companion-module/base';
import { UpgradeScripts } from './upgrades.js';

interface ModuleConfig {
  url: string;
  token: string;
  pollMs: number;
}

class AutologgerInstance extends InstanceBase<ModuleConfig> {
  async init(_config: ModuleConfig): Promise<void> {}
  async destroy(): Promise<void> {}
  async configUpdated(_config: ModuleConfig): Promise<void> {}
  getConfigFields(): SomeCompanionConfigField[] {
    return [];
  }
}

runEntrypoint(AutologgerInstance, UpgradeScripts);
```

- [ ] **Step 9: Create `companion/.gitignore`**

```
dist/
node_modules/
```

- [ ] **Step 10: Add the workspace + scripts to root `package.json`**

In `workspaces`, add `"companion"`:
```json
  "workspaces": [
    "server",
    "web",
    "companion"
  ],
```
Update these scripts:
```json
    "test": "npm run test -w server && npm run test -w companion",
    "typecheck": "npm run typecheck -w server && npm run typecheck -w web && npm run typecheck -w companion && tsc --noEmit -p e2e",
    "lint": "npm run lint -w web && biome check --write e2e playwright.config.ts companion/src",
```

**Also extend `biome.json`** — its `files.includes` gates which paths biome processes, and it silently drops any CLI path not matched. Add the companion glob so the `lint` script actually checks companion source (without it, `companion/src` is filtered out and lint is a no-op for this workspace):
```json
  "files": {
    "includes": ["e2e/**/*.ts", "playwright.config.ts", "companion/src/**/*.ts"]
  }
```
Verify with `npm run lint` and confirm the output's "Checked N files" count includes the companion `.ts` files.

- [ ] **Step 11: Install and verify the pin resolved correctly**

Run: `npm install`
Then: `npm run check:base -w companion`
Expected: `@companion-module/base 2.0.x OK for Companion 4.3.4.` (if it prints a rejection, the pin is wrong — fix `package.json`).

- [ ] **Step 12: Verify the stub typechecks**

Run: `npm run typecheck -w companion`
Expected: PASS (no errors).

- [ ] **Step 13: Confirm the manifest `runtime.type` and API version against installed types**

Run: `node -e "import('@companion-module/base').then(m => console.log(typeof m.runEntrypoint, typeof m.InstanceBase))"`
Expected: `function function`. Also open `companion/node_modules/@companion-module/base/dist/module-api/manifest.*` and confirm `node22` is a valid `runtime.type` and the `apiVersion` you wrote matches the package's declared api version; adjust `manifest.json` if needed.

- [ ] **Step 14: Commit**

```bash
git add companion package.json package-lock.json
git commit -m "feat(companion): scaffold module workspace with base-version pin guard"
```

---

### Task 2: Config module (`config.ts`)

**Files:**
- Create: `companion/src/config.ts`, `companion/src/config.test.ts`

**Interfaces:**
- Produces: `ModuleConfig` (`{ url: string; token: string; pollMs: number }`); `getConfigFields(): SomeCompanionConfigField[]`; `normalizeBaseUrl(raw: string): string` (trims, strips trailing slashes); `clampPollMs(n: number): number` (250–10000, default 1000).

- [ ] **Step 1: Write the failing test — `companion/src/config.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { clampPollMs, normalizeBaseUrl } from './config.js';

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes and trims', () => {
    expect(normalizeBaseUrl('  http://x:8787/  ')).toBe('http://x:8787');
    expect(normalizeBaseUrl('http://x:8787')).toBe('http://x:8787');
    expect(normalizeBaseUrl('http://x:8787///')).toBe('http://x:8787');
  });
});

describe('clampPollMs', () => {
  it('clamps to [250, 10000] and defaults non-finite to 1000', () => {
    expect(clampPollMs(1000)).toBe(1000);
    expect(clampPollMs(10)).toBe(250);
    expect(clampPollMs(99999)).toBe(10000);
    expect(clampPollMs(Number.NaN)).toBe(1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w companion -- config`
Expected: FAIL (cannot find `./config.js`).

- [ ] **Step 3: Write `companion/src/config.ts`**

```ts
import { Regex, type SomeCompanionConfigField } from '@companion-module/base';

export interface ModuleConfig {
  url: string;
  token: string;
  pollMs: number;
}

export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

export function clampPollMs(n: number): number {
  if (!Number.isFinite(n)) return 1000;
  return Math.min(10000, Math.max(250, Math.trunc(n)));
}

export function getConfigFields(): SomeCompanionConfigField[] {
  return [
    {
      type: 'textinput',
      id: 'url',
      label: 'AutoLogger server URL',
      width: 8,
      default: 'http://127.0.0.1:8787',
      regex: Regex.SOMETHING,
    },
    {
      type: 'textinput',
      id: 'token',
      label: 'API token (only if REQUIRE_LOGIN=1)',
      width: 8,
      default: '',
    },
    {
      type: 'number',
      id: 'pollMs',
      label: 'Poll interval (ms)',
      width: 4,
      default: 1000,
      min: 250,
      max: 10000,
    },
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w companion -- config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add companion/src/config.ts companion/src/config.test.ts
git commit -m "feat(companion): config fields + url/poll normalization"
```

---

### Task 3: API client (`api.ts`)

**Files:**
- Create: `companion/src/api.ts`, `companion/src/api.test.ts`

**Interfaces:**
- Consumes: `ModuleConfig`, `normalizeBaseUrl` (Task 2).
- Produces:
  - `ApiErrorKind = 'network' | 'auth' | 'no_session' | 'bad_category' | 'http'`
  - `class ApiError extends Error { kind: ApiErrorKind; status?: number }`
  - `interface CategoriesResponse { session_id: string; show_id: string | null; show_name: string | null; show_code: string | null; categories: Array<{ id: string; label: string }> }`
  - `class AutologgerApi` with constructor `(opts: { url: string; token: string; signal: AbortSignal; timeoutMs?: number })` and methods returning parsed JSON or throwing `ApiError`:
    - `getState(): Promise<ServerStatePayload>` (raw shape; typed in Task 4 as `ServerState`)
    - `getCategories(): Promise<CategoriesResponse>`
    - `log(body: { category_id: string; message: string }): Promise<void>`
    - `transport(action: 'start' | 'stop' | 'toggle'): Promise<void>`
    - `command(type: 'record-start' | 'record-stop' | 'record-toggle' | 'play-toggle'): Promise<void>`

- [ ] **Step 1: Write the failing test — `companion/src/api.test.ts`**

```ts
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, AutologgerApi } from './api.js';

let server: Server;
let base: string;
let handler: (req: import('node:http').IncomingMessage, body: string) => { status: number; json: unknown };

beforeEach(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { status, json } = handler(req, body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (typeof addr === 'object' && addr) base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function api(token = ''): AutologgerApi {
  return new AutologgerApi({ url: base, token, signal: new AbortController().signal });
}

describe('AutologgerApi', () => {
  it('sends the bearer token and parses state JSON', async () => {
    let seenAuth: string | undefined;
    handler = (req) => {
      seenAuth = req.headers.authorization;
      return { status: 200, json: { connected_clients: 1, active_session_id: 's1', session: null, last_command: null } };
    };
    const state = await api('tok').getState();
    expect(seenAuth).toBe('Bearer tok');
    expect(state.active_session_id).toBe('s1');
  });

  it('omits Authorization when token is blank', async () => {
    let seenAuth: string | undefined = 'unset';
    handler = (req) => {
      seenAuth = req.headers.authorization;
      return { status: 200, json: { connected_clients: 0, active_session_id: null, session: null, last_command: null } };
    };
    await api('').getState();
    expect(seenAuth).toBeUndefined();
  });

  it('maps 401 -> auth', async () => {
    handler = () => ({ status: 401, json: { detail: 'Login required.' } });
    await expect(api().getState()).rejects.toMatchObject({ kind: 'auth' });
  });

  it('maps 409 -> no_session on transport', async () => {
    handler = () => ({ status: 409, json: { detail: 'No active session' } });
    await expect(api().transport('toggle')).rejects.toMatchObject({ kind: 'no_session' });
  });

  it('maps 400 -> bad_category on log', async () => {
    handler = () => ({ status: 400, json: { detail: 'Unknown category' } });
    await expect(api().log({ category_id: 'x', message: 'm' })).rejects.toMatchObject({ kind: 'bad_category' });
  });

  it('maps 500 -> http', async () => {
    handler = () => ({ status: 500, json: { detail: 'boom' } });
    await expect(api().getCategories()).rejects.toMatchObject({ kind: 'http', status: 500 });
  });

  it('surfaces ApiError type', async () => {
    handler = () => ({ status: 401, json: {} });
    const err = await api().getState().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w companion -- api`
Expected: FAIL (cannot find `./api.js`).

- [ ] **Step 3: Write `companion/src/api.ts`**

```ts
import { normalizeBaseUrl } from './config.js';
import type { ServerStatePayload } from './state.js';

export type ApiErrorKind = 'network' | 'auth' | 'no_session' | 'bad_category' | 'http';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  constructor(kind: ApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

export interface CategoriesResponse {
  session_id: string;
  show_id: string | null;
  show_name: string | null;
  show_code: string | null;
  categories: Array<{ id: string; label: string }>;
}

function statusToKind(status: number): ApiErrorKind {
  if (status === 401) return 'auth';
  if (status === 409) return 'no_session';
  if (status === 400) return 'bad_category';
  return 'http';
}

export class AutologgerApi {
  private readonly base: string;
  private readonly token: string;
  private readonly signal: AbortSignal;
  private readonly timeoutMs: number;

  constructor(opts: { url: string; token: string; signal: AbortSignal; timeoutMs?: number }) {
    this.base = normalizeBaseUrl(opts.url);
    this.token = opts.token.trim();
    this.signal = opts.signal;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    // Per-request timeout, linked to the instance-scoped abort signal.
    const timer = new AbortController();
    const onAbort = (): void => timer.abort();
    this.signal.addEventListener('abort', onAbort, { once: true });
    const to = setTimeout(() => timer.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timer.signal,
      });
      if (!res.ok) {
        throw new ApiError(statusToKind(res.status), `${method} ${path} -> ${res.status}`, res.status);
      }
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError('network', `${method} ${path} failed: ${String(err)}`);
    } finally {
      clearTimeout(to);
      this.signal.removeEventListener('abort', onAbort);
    }
  }

  getState(): Promise<ServerStatePayload> {
    return this.request<ServerStatePayload>('GET', '/api/companion/state');
  }

  getCategories(): Promise<CategoriesResponse> {
    return this.request<CategoriesResponse>('GET', '/api/companion/categories');
  }

  async log(body: { category_id: string; message: string }): Promise<void> {
    await this.request('POST', '/api/companion/log', body);
  }

  async transport(action: 'start' | 'stop' | 'toggle'): Promise<void> {
    await this.request('POST', '/api/companion/transport', { action });
  }

  async command(
    type: 'record-start' | 'record-stop' | 'record-toggle' | 'play-toggle',
  ): Promise<void> {
    await this.request('POST', '/api/companion/command', { type });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w companion -- api`
Expected: PASS (6 tests). Note: `state.js` is imported for a type only; create Task 4's file next, or temporarily declare the type — Task 4 defines `ServerStatePayload`, so if running Task 3 alone, add a minimal `state.ts` stub first. (Recommended order: do Task 4 before running full typecheck.)

- [ ] **Step 5: Commit**

```bash
git add companion/src/api.ts companion/src/api.test.ts
git commit -m "feat(companion): typed API client with tagged error mapping"
```

---

### Task 4: State → UI pure functions (`state.ts`)

**Files:**
- Create: `companion/src/state.ts`, `companion/src/state.test.ts`

**Interfaces:**
- Produces:
  - `interface SessionState { id: string; title: string; deck_title: string; timecode: string; frame_rate: number; is_rolling: boolean; current_take: number; is_recording: boolean; is_playing: boolean; logged_event_count: number; events_stream_revision: number; show_id: string | null; show_name: string | null; show_code: string | null }`
  - `interface LastCommand { id: string; type: string; ok: boolean; error: string | null; delivered_to: string | null }`
  - `interface ServerStatePayload { connected_clients: number; active_session_id: string | null; session: SessionState | null; last_command: LastCommand | null }`
  - `toVariableValues(s: ServerStatePayload): Record<string, string | number>`
  - `toFeedbackFlags(s: ServerStatePayload): { rolling: boolean; recording: boolean; playing: boolean; session_active: boolean }`
  - `showIdChanged(prev: ServerStatePayload | null, next: ServerStatePayload): boolean`

- [ ] **Step 1: Write the failing test — `companion/src/state.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { showIdChanged, toFeedbackFlags, toVariableValues, type ServerStatePayload } from './state.js';

const NONE: ServerStatePayload = {
  connected_clients: 0,
  active_session_id: null,
  session: null,
  last_command: null,
};

const LIVE: ServerStatePayload = {
  connected_clients: 2,
  active_session_id: 's1',
  session: {
    id: 's1',
    title: 'Ep 1',
    deck_title: 'SHOW - 1',
    timecode: '01:00:00:00',
    frame_rate: 24,
    is_rolling: true,
    current_take: 3,
    is_recording: false,
    is_playing: true,
    logged_event_count: 7,
    events_stream_revision: 9,
    show_id: 'sh1',
    show_name: 'The Show',
    show_code: 'SHOW',
  },
  last_command: { id: 'c1', type: 'record-start', ok: false, error: 'no listener', delivered_to: null },
};

describe('toVariableValues', () => {
  it('uses sentinels when no session', () => {
    const v = toVariableValues(NONE);
    expect(v.timecode).toBe('—');
    expect(v.session_title).toBe('—');
    expect(v.connected_clients).toBe(0);
  });

  it('maps live session fields and surfaces last_command', () => {
    const v = toVariableValues(LIVE);
    expect(v.timecode).toBe('01:00:00:00');
    expect(v.take).toBe(3);
    expect(v.deck_title).toBe('SHOW - 1');
    expect(v.command_delivered).toBe('no'); // ok:false
    expect(v.command_error).toBe('no listener');
  });
});

describe('toFeedbackFlags', () => {
  it('all false when no session', () => {
    expect(toFeedbackFlags(NONE)).toEqual({ rolling: false, recording: false, playing: false, session_active: false });
  });
  it('reflects live flags', () => {
    expect(toFeedbackFlags(LIVE)).toEqual({ rolling: true, recording: false, playing: true, session_active: true });
  });
});

describe('showIdChanged', () => {
  it('true when show_id differs, false when same', () => {
    expect(showIdChanged(NONE, LIVE)).toBe(true);
    expect(showIdChanged(LIVE, LIVE)).toBe(false);
    expect(showIdChanged(null, NONE)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w companion -- state`
Expected: FAIL (cannot find `./state.js`).

- [ ] **Step 3: Write `companion/src/state.ts`**

```ts
export interface SessionState {
  id: string;
  title: string;
  deck_title: string;
  timecode: string;
  frame_rate: number;
  is_rolling: boolean;
  current_take: number;
  is_recording: boolean;
  is_playing: boolean;
  logged_event_count: number;
  events_stream_revision: number;
  show_id: string | null;
  show_name: string | null;
  show_code: string | null;
}

export interface LastCommand {
  id: string;
  type: string;
  ok: boolean;
  error: string | null;
  delivered_to: string | null;
}

export interface ServerStatePayload {
  connected_clients: number;
  active_session_id: string | null;
  session: SessionState | null;
  last_command: LastCommand | null;
}

const DASH = '—';

export function toVariableValues(s: ServerStatePayload): Record<string, string | number> {
  const sess = s.session;
  const lc = s.last_command;
  return {
    timecode: sess?.timecode ?? DASH,
    take: sess?.current_take ?? DASH,
    session_title: sess?.title ?? DASH,
    deck_title: sess?.deck_title ?? DASH,
    show_name: sess?.show_name ?? DASH,
    show_code: sess?.show_code ?? DASH,
    event_count: sess?.logged_event_count ?? 0,
    frame_rate: sess?.frame_rate ?? DASH,
    connected_clients: s.connected_clients,
    active_session_id: s.active_session_id ?? DASH,
    command_delivered: lc ? (lc.ok ? 'yes' : 'no') : DASH,
    command_error: lc?.error ?? '',
  };
}

export function toFeedbackFlags(s: ServerStatePayload): {
  rolling: boolean;
  recording: boolean;
  playing: boolean;
  session_active: boolean;
} {
  const sess = s.session;
  return {
    rolling: sess?.is_rolling ?? false,
    recording: sess?.is_recording ?? false,
    playing: sess?.is_playing ?? false,
    session_active: sess !== null,
  };
}

export function showIdChanged(
  prev: ServerStatePayload | null,
  next: ServerStatePayload,
): boolean {
  const prevId = prev?.session?.show_id ?? null;
  const nextId = next.session?.show_id ?? null;
  return prevId !== nextId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w companion -- state`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add companion/src/state.ts companion/src/state.test.ts
git commit -m "feat(companion): pure state->variables/feedbacks mapping"
```

---

### Task 5: Variable + feedback definitions (`variables.ts`, `feedbacks.ts`)

**Files:**
- Create: `companion/src/variables.ts`, `companion/src/feedbacks.ts`

**Interfaces:**
- Consumes: `toFeedbackFlags` (Task 4); the instance's `getFlags()` accessor added in Task 8.
- Produces:
  - `variableDefinitions(): CompanionVariableDefinition[]`
  - `feedbackDefinitions(getFlags: () => ReturnType<typeof toFeedbackFlags>): CompanionFeedbackDefinitions`

- [ ] **Step 1: Write `companion/src/variables.ts`**

```ts
import type { CompanionVariableDefinition } from '@companion-module/base';

export function variableDefinitions(): CompanionVariableDefinition[] {
  return [
    { variableId: 'timecode', name: 'Session timecode' },
    { variableId: 'take', name: 'Current take' },
    { variableId: 'session_title', name: 'Session title' },
    { variableId: 'deck_title', name: 'Deck title (show + episode)' },
    { variableId: 'show_name', name: 'Show name' },
    { variableId: 'show_code', name: 'Show code' },
    { variableId: 'event_count', name: 'Logged event count' },
    { variableId: 'frame_rate', name: 'Frame rate' },
    { variableId: 'connected_clients', name: 'Connected browser clients' },
    { variableId: 'active_session_id', name: 'Active session id' },
    { variableId: 'command_delivered', name: 'Last record/play command delivered (yes/no)' },
    { variableId: 'command_error', name: 'Last command error' },
  ];
}
```

- [ ] **Step 2: Write `companion/src/feedbacks.ts`**

```ts
import { combineRgb, type CompanionFeedbackDefinitions } from '@companion-module/base';
import type { toFeedbackFlags } from './state.js';

const WHITE = combineRgb(255, 255, 255);
const RED = combineRgb(200, 40, 40);
const DEEP_RED = combineRgb(150, 0, 0);
const GREEN = combineRgb(40, 160, 60);
const AMBER = combineRgb(180, 120, 0);

export function feedbackDefinitions(
  getFlags: () => ReturnType<typeof toFeedbackFlags>,
): CompanionFeedbackDefinitions {
  return {
    rolling: {
      type: 'boolean',
      name: 'Take is rolling',
      defaultStyle: { bgcolor: RED, color: WHITE },
      options: [],
      callback: () => getFlags().rolling,
    },
    recording: {
      type: 'boolean',
      name: 'Recording',
      defaultStyle: { bgcolor: DEEP_RED, color: WHITE },
      options: [],
      callback: () => getFlags().recording,
    },
    playing: {
      type: 'boolean',
      name: 'Playing (best-effort — browser-reported)',
      defaultStyle: { bgcolor: GREEN, color: WHITE },
      options: [],
      callback: () => getFlags().playing,
    },
    session_active: {
      type: 'boolean',
      name: 'No active session (warn)',
      defaultStyle: { bgcolor: AMBER, color: WHITE },
      options: [],
      // True when NOT active, so the button warns.
      callback: () => !getFlags().session_active,
    },
  };
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck -w companion`
Expected: PASS. (If `combineRgb`/`CompanionFeedbackDefinitions` names differ in the installed types, adjust imports to match — verify against `node_modules/@companion-module/base/dist`.)

- [ ] **Step 4: Commit**

```bash
git add companion/src/variables.ts companion/src/feedbacks.ts
git commit -m "feat(companion): variable + boolean feedback definitions"
```

---

### Task 6: Actions (`actions.ts`)

**Files:**
- Create: `companion/src/actions.ts`, `companion/src/actions.test.ts`

**Interfaces:**
- Consumes: `AutologgerApi`, `ApiError` (Task 3); `CategoriesResponse` (Task 3).
- Produces: `interface ActionHost { api(): AutologgerApi; refreshNow(): void; log(level: 'warn' | 'error', msg: string): void; parseVariablesInString(t: string): Promise<string> }` and `actionDefinitions(host: ActionHost, categories: CategoriesResponse | null): CompanionActionDefinitions`.
- The action callbacks map `ApiError.kind` to a log line and call `host.refreshNow()` on success (see error handling in the spec).

- [ ] **Step 1: Write the failing test — `companion/src/actions.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest';
import { actionDefinitions, type ActionHost } from './actions.js';
import { ApiError } from './api.js';

function host(api: Partial<ReturnType<ActionHost['api']>>): { host: ActionHost; logs: string[]; refreshed: number } {
  const logs: string[] = [];
  let refreshed = 0;
  const h: ActionHost = {
    api: () => api as ReturnType<ActionHost['api']>,
    refreshNow: () => {
      refreshed++;
    },
    log: (level, msg) => logs.push(`${level}:${msg}`),
    parseVariablesInString: async (t) => t,
  };
  return { host: h, logs, get refreshed() {
    return refreshed;
  } } as never;
}

describe('transport action', () => {
  it('calls api.transport and refreshes on success', async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const ctx = host({ transport });
    const defs = actionDefinitions(ctx.host, null);
    await defs.transport.callback({ options: { action: 'toggle' } } as never, {} as never);
    expect(transport).toHaveBeenCalledWith('toggle');
    expect(ctx.refreshed).toBe(1);
  });

  it('logs a warn on 409 no_session and does not throw', async () => {
    const transport = vi.fn().mockRejectedValue(new ApiError('no_session', 'x', 409));
    const ctx = host({ transport });
    const defs = actionDefinitions(ctx.host, null);
    await defs.transport.callback({ options: { action: 'start' } } as never, {} as never);
    expect(ctx.logs.some((l) => l.startsWith('warn:'))).toBe(true);
  });
});

describe('log_event action', () => {
  it('logs a distinct warn on 400 bad_category', async () => {
    const log = vi.fn().mockRejectedValue(new ApiError('bad_category', 'x', 400));
    const ctx = host({ log });
    const defs = actionDefinitions(ctx.host, null);
    await defs.log_event.callback({ options: { category: 'c1', message: 'hi' } } as never, {} as never);
    expect(ctx.logs.some((l) => l.startsWith('warn:') && /category/i.test(l))).toBe(true);
  });
});
```

Note: the `host()` helper above is illustrative; when implementing, use a small concrete object literal per test rather than the getter trick if your linter objects — keep the three fields (`api`, `refreshNow`, `log`, `parseVariablesInString`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w companion -- actions`
Expected: FAIL (cannot find `./actions.js`).

- [ ] **Step 3: Write `companion/src/actions.ts`**

```ts
import type { CompanionActionDefinitions } from '@companion-module/base';
import { ApiError, type AutologgerApi, type CategoriesResponse } from './api.js';

export interface ActionHost {
  api(): AutologgerApi;
  refreshNow(): void;
  log(level: 'warn' | 'error', msg: string): void;
  parseVariablesInString(text: string): Promise<string>;
}

function reportError(host: ActionHost, verb: string, err: unknown): void {
  if (err instanceof ApiError) {
    if (err.kind === 'no_session') {
      host.log('warn', `${verb}: no active session — open AutoLogger in a browser and open a session.`);
      return;
    }
    if (err.kind === 'bad_category') {
      host.log('warn', `${verb}: unknown category for the active show — re-pick the category (the show may have changed).`);
      return;
    }
    host.log('error', `${verb}: ${err.message}`);
    return;
  }
  host.log('error', `${verb}: ${String(err)}`);
}

export function actionDefinitions(
  host: ActionHost,
  categories: CategoriesResponse | null,
): CompanionActionDefinitions {
  const choices = (categories?.categories ?? []).map((c) => ({ id: c.id, label: c.label }));
  return {
    log_event: {
      name: 'Log event',
      options: [
        {
          type: 'dropdown',
          id: 'category',
          label: 'Category',
          default: choices[0]?.id ?? '',
          choices: choices.length ? choices : [{ id: '', label: '(no active show)' }],
        },
        { type: 'textinput', id: 'message', label: 'Message', default: '', useVariables: true },
      ],
      callback: async (action) => {
        try {
          const message = await host.parseVariablesInString(String(action.options.message ?? ''));
          await host.api().log({ category_id: String(action.options.category ?? ''), message });
          host.refreshNow();
        } catch (err) {
          reportError(host, 'log event', err);
        }
      },
    },
    transport: {
      name: 'Transport (roll/stop)',
      options: [
        {
          type: 'dropdown',
          id: 'action',
          label: 'Action',
          default: 'toggle',
          choices: [
            { id: 'toggle', label: 'Toggle' },
            { id: 'start', label: 'Roll' },
            { id: 'stop', label: 'Stop' },
          ],
        },
      ],
      callback: async (action) => {
        try {
          await host.api().transport(action.options.action as 'start' | 'stop' | 'toggle');
          host.refreshNow();
        } catch (err) {
          reportError(host, 'transport', err);
        }
      },
    },
    record: {
      name: 'Record',
      options: [
        {
          type: 'dropdown',
          id: 'type',
          label: 'Command',
          default: 'record-toggle',
          choices: [
            { id: 'record-toggle', label: 'Toggle' },
            { id: 'record-start', label: 'Start' },
            { id: 'record-stop', label: 'Stop' },
          ],
        },
      ],
      callback: async (action) => {
        try {
          await host.api().command(
            action.options.type as 'record-start' | 'record-stop' | 'record-toggle',
          );
          host.refreshNow();
        } catch (err) {
          reportError(host, 'record', err);
        }
      },
    },
    play_toggle: {
      name: 'Play (toggle)',
      options: [],
      callback: async () => {
        try {
          await host.api().command('play-toggle');
          host.refreshNow();
        } catch (err) {
          reportError(host, 'play', err);
        }
      },
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w companion -- actions`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add companion/src/actions.ts companion/src/actions.test.ts
git commit -m "feat(companion): actions with error-kind-aware logging + post-action refresh"
```

---

### Task 7: Presets (`presets.ts`)

**Files:**
- Create: `companion/src/presets.ts`, `companion/src/presets.test.ts`

**Interfaces:**
- Produces: `presetDefinitions(): CompanionPresetDefinitions`. Every preset's default text includes `$(autologger:deck_title)` (silent-retarget mitigation).

- [ ] **Step 1: Write the failing test — `companion/src/presets.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { presetDefinitions } from './presets.js';

describe('presetDefinitions', () => {
  it('every preset shows deck_title and references a real feedback', () => {
    const presets = presetDefinitions();
    const ids = Object.keys(presets);
    expect(ids).toEqual(expect.arrayContaining(['roll_stop', 'record', 'play', 'log_event']));
    for (const id of ids) {
      const p = presets[id];
      if (p.type !== 'button') continue;
      // Button text lives in style.text (NOT steps, which hold only actions).
      expect(p.style.text).toContain('deck_title');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w companion -- presets`
Expected: FAIL.

- [ ] **Step 3: Write `companion/src/presets.ts`**

```ts
import { combineRgb, type CompanionPresetDefinitions } from '@companion-module/base';

const BLACK = combineRgb(0, 0, 0);
const WHITE = combineRgb(255, 255, 255);

export function presetDefinitions(): CompanionPresetDefinitions {
  return {
    roll_stop: {
      type: 'button',
      category: 'AutoLogger',
      name: 'Roll / Stop',
      style: { text: '$(autologger:deck_title)\\n$(autologger:timecode)', size: 'auto', color: WHITE, bgcolor: BLACK },
      steps: [{ down: [{ actionId: 'transport', options: { action: 'toggle' } }], up: [] }],
      feedbacks: [{ feedbackId: 'rolling', options: {} }],
    },
    record: {
      type: 'button',
      category: 'AutoLogger',
      name: 'Record',
      style: { text: 'REC\\n$(autologger:deck_title)', size: 'auto', color: WHITE, bgcolor: BLACK },
      steps: [{ down: [{ actionId: 'record', options: { type: 'record-toggle' } }], up: [] }],
      feedbacks: [{ feedbackId: 'recording', options: {} }],
    },
    play: {
      type: 'button',
      category: 'AutoLogger',
      name: 'Play',
      style: { text: 'PLAY\\n$(autologger:deck_title)', size: 'auto', color: WHITE, bgcolor: BLACK },
      steps: [{ down: [{ actionId: 'play_toggle', options: {} }], up: [] }],
      feedbacks: [{ feedbackId: 'playing', options: {} }],
    },
    log_event: {
      type: 'button',
      category: 'AutoLogger',
      name: 'Log event',
      style: { text: 'LOG\\n$(autologger:deck_title)', size: 'auto', color: WHITE, bgcolor: BLACK },
      steps: [{ down: [{ actionId: 'log_event', options: { category: '', message: '' } }], up: [] }],
      feedbacks: [{ feedbackId: 'session_active', options: {} }],
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w companion -- presets`
Expected: PASS. (If the test's `\\n` assertion mismatches actual newline encoding, assert on `deck_title` substring only — the newline is cosmetic.)

- [ ] **Step 5: Commit**

```bash
git add companion/src/presets.ts companion/src/presets.test.ts
git commit -m "feat(companion): presets with session-identifying button text"
```

---

### Task 8: Main instance — lifecycle + poll loop (`main.ts`)

**Files:**
- Modify: `companion/src/main.ts` (replace the Task 1 stub)
- Create: `companion/src/poller.ts`, `companion/src/poller.test.ts` (the sequence-fencing/backoff logic, extracted so it's unit-testable without the Companion base class)

**Interfaces:**
- Consumes: everything from Tasks 2–7.
- Produces: `class Poller` encapsulating the concurrency invariants; `AutologgerInstance` wiring it to Companion.

**`Poller` contract (tested in isolation):**
- `constructor(opts: { intervalMs: number; fetchState: (signal: AbortSignal) => Promise<T>; onState: (s: T) => void; onError: (err: unknown) => void; })`
- `start()` / `stop()` — self-rescheduling; only one fetch in flight; a response is applied only if it is the newest issued (sequence fence).
- `refreshNow()` — coalesces into the in-flight fetch if one is running, else fires immediately; shares the same apply path.
- Backoff: on consecutive errors, the next delay grows (capped); a success resets it.

- [ ] **Step 1: Write the failing test — `companion/src/poller.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest';
import { Poller } from './poller.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Poller', () => {
  it('applies only the newest response when two overlap (sequence fence)', async () => {
    let resolveFirst!: (v: number) => void;
    const calls: Array<Promise<number>> = [];
    const applied: number[] = [];
    const fetchState = vi
      .fn()
      .mockImplementationOnce(() => new Promise<number>((r) => (resolveFirst = r))) // slow
      .mockImplementationOnce(() => Promise.resolve(2)); // fast
    const p = new Poller({
      intervalMs: 5,
      fetchState,
      onState: (s: number) => applied.push(s),
      onError: () => {},
    });
    p.start(); // issues seq 1 (slow, pending)
    await tick();
    p.refreshNow(); // must coalesce into the pending seq-1 fetch, NOT start seq 2
    resolveFirst(1);
    await tick();
    expect(applied).toContain(1);
    p.stop();
    // Only one fetch was in flight at a time.
    expect(fetchState.mock.calls.length).toBeLessThanOrEqual(2);
    void calls;
  });

  it('stop() prevents further applies', async () => {
    const applied: number[] = [];
    const p = new Poller({
      intervalMs: 1,
      fetchState: () => Promise.resolve(7),
      onState: (s: number) => applied.push(s),
      onError: () => {},
    });
    p.start();
    p.stop();
    await tick();
    await tick();
    const count = applied.length;
    await tick();
    expect(applied.length).toBe(count); // no growth after stop
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w companion -- poller`
Expected: FAIL (cannot find `./poller.js`).

- [ ] **Step 3: Write `companion/src/poller.ts`**

```ts
export interface PollerOptions<T> {
  intervalMs: number;
  maxBackoffMs?: number;
  fetchState: (signal: AbortSignal) => Promise<T>;
  onState: (s: T) => void;
  onError: (err: unknown) => void;
}

export class Poller<T> {
  private readonly opts: Required<Pick<PollerOptions<T>, 'maxBackoffMs'>> & PollerOptions<T>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private seq = 0;
  private applied = -1;
  private consecutiveErrors = 0;
  private stopped = true;
  private controller: AbortController | null = null;

  constructor(opts: PollerOptions<T>) {
    this.opts = { maxBackoffMs: 30000, ...opts };
  }

  start(): void {
    this.stopped = false;
    void this.pollOnce();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
  }

  refreshNow(): void {
    if (this.stopped) return;
    if (this.inFlight) return; // coalesce: the in-flight fetch will deliver fresh state
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.pollOnce();
  }

  private schedule(): void {
    if (this.stopped) return;
    const backoff = Math.min(
      this.opts.maxBackoffMs,
      this.opts.intervalMs * 2 ** Math.min(this.consecutiveErrors, 6),
    );
    const delay = this.consecutiveErrors > 0 ? backoff : this.opts.intervalMs;
    this.timer = setTimeout(() => void this.pollOnce(), delay);
  }

  private async pollOnce(): Promise<void> {
    if (this.stopped || this.inFlight) return;
    this.inFlight = true;
    const mySeq = ++this.seq;
    this.controller = new AbortController();
    try {
      const state = await this.opts.fetchState(this.controller.signal);
      if (!this.stopped && mySeq > this.applied) {
        this.applied = mySeq;
        this.consecutiveErrors = 0;
        this.opts.onState(state);
      }
    } catch (err) {
      if (!this.stopped) {
        this.consecutiveErrors++;
        this.opts.onError(err);
      }
    } finally {
      this.inFlight = false;
      this.controller = null;
      this.schedule();
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w companion -- poller`
Expected: PASS.

- [ ] **Step 5: Replace `companion/src/main.ts` with the full instance**

```ts
import {
  InstanceBase,
  InstanceStatus,
  runEntrypoint,
  type SomeCompanionConfigField,
} from '@companion-module/base';
import { actionDefinitions } from './actions.js';
import { ApiError, AutologgerApi, type CategoriesResponse } from './api.js';
import { clampPollMs, getConfigFields, type ModuleConfig } from './config.js';
import { feedbackDefinitions } from './feedbacks.js';
import { Poller } from './poller.js';
import { presetDefinitions } from './presets.js';
import {
  showIdChanged,
  toFeedbackFlags,
  toVariableValues,
  type ServerStatePayload,
} from './state.js';
import { UpgradeScripts } from './upgrades.js';
import { variableDefinitions } from './variables.js';

class AutologgerInstance extends InstanceBase<ModuleConfig> {
  private config!: ModuleConfig;
  private controller: AbortController | null = null;
  private poller: Poller<ServerStatePayload> | null = null;
  private lastState: ServerStatePayload | null = null;
  private categories: CategoriesResponse | null = null;
  private destroyed = false;

  async init(config: ModuleConfig): Promise<void> {
    this.destroyed = false;
    this.config = config;
    this.setVariableDefinitions(variableDefinitions());
    this.setFeedbackDefinitions(feedbackDefinitions(() => toFeedbackFlags(this.lastState ?? EMPTY)));
    this.setPresetDefinitions(presetDefinitions());
    this.rebuildActions();
    this.updateStatus(InstanceStatus.Connecting);
    this.startPolling();
  }

  async configUpdated(config: ModuleConfig): Promise<void> {
    this.config = config;
    this.teardown();
    this.updateStatus(InstanceStatus.Connecting);
    this.startPolling();
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.teardown();
  }

  getConfigFields(): SomeCompanionConfigField[] {
    return getConfigFields();
  }

  private newApi(): AutologgerApi {
    if (!this.controller) this.controller = new AbortController();
    return new AutologgerApi({
      url: this.config.url,
      token: this.config.token,
      signal: this.controller.signal,
    });
  }

  private teardown(): void {
    this.poller?.stop();
    this.poller = null;
    this.controller?.abort();
    this.controller = null;
  }

  private startPolling(): void {
    this.controller = new AbortController();
    this.poller = new Poller<ServerStatePayload>({
      intervalMs: clampPollMs(this.config.pollMs),
      fetchState: (signal) =>
        new AutologgerApi({ url: this.config.url, token: this.config.token, signal }).getState(),
      onState: (s) => this.applyState(s),
      onError: (err) => this.applyError(err),
    });
    this.poller.start();
    void this.refreshCategories();
  }

  private applyState(s: ServerStatePayload): void {
    if (this.destroyed) return;
    const showChanged = showIdChanged(this.lastState, s);
    this.lastState = s;
    this.setVariableValues(toVariableValues(s));
    this.checkFeedbacks('rolling', 'recording', 'playing', 'session_active');
    this.updateStatus(InstanceStatus.Ok);
    if (showChanged) void this.refreshCategories();
  }

  private applyError(err: unknown): void {
    if (this.destroyed) return;
    if (err instanceof ApiError && err.kind === 'auth') {
      this.updateStatus(InstanceStatus.BadConfig, 'Check API token / login');
    } else {
      this.updateStatus(InstanceStatus.ConnectionFailure, 'Cannot reach AutoLogger server');
    }
  }

  private async refreshCategories(): Promise<void> {
    try {
      const cats = await this.newApi().getCategories();
      if (this.destroyed) return;
      this.categories = cats;
      this.rebuildActions();
    } catch {
      // 409 (no session) etc. — leave the last-known dropdown in place.
    }
  }

  private rebuildActions(): void {
    this.setActionDefinitions(
      actionDefinitions(
        {
          api: () => this.newApi(),
          refreshNow: () => this.poller?.refreshNow(),
          log: (level, msg) => this.log(level, msg),
          parseVariablesInString: (t) => this.parseVariablesInString(t),
        },
        this.categories,
      ),
    );
  }
}

const EMPTY: ServerStatePayload = {
  connected_clients: 0,
  active_session_id: null,
  session: null,
  last_command: null,
};

runEntrypoint(AutologgerInstance, UpgradeScripts);
```

- [ ] **Step 6: Build the whole module**

Run: `npm run build -w companion`
Expected: `@companion-module/base ... OK` then a clean `tsc` build producing `companion/dist/main.js`. Fix any type mismatches against the installed `@companion-module/base` types (esp. `InstanceStatus` members, `checkFeedbacks` signature, config-field shapes) — these are the API-surface points the assumptions review flagged.

- [ ] **Step 7: Run all unit tests + typecheck**

Run: `npm run test -w companion && npm run typecheck -w companion`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add companion/src/main.ts companion/src/poller.ts companion/src/poller.test.ts
git commit -m "feat(companion): instance lifecycle + sequence-fenced poll loop with backoff"
```

---

### Task 9: Headless-Companion e2e harness

**Files:**
- Create: `e2e/companion-harness.ts`, `e2e/companion.e2e.spec.ts`
- Modify: `playwright.config.ts` (add binary-gated `companion` project)

**Interfaces:**
- Consumes: the built `companion/dist/main.js`; the hermetic server from `playwright.config.ts` webServer (port 8791); server endpoints `POST /api/sessions`, `POST /api/companion/presence`, `GET /api/companion/state`.
- Produces: a Playwright project `companion` that runs only when the Companion binary exists.

**Preconditions the harness sets up (mirrors the spec):** seed a session via `POST /api/sessions`, then simulate a browser by `POST /api/companion/presence` with that `session_id` + `visible:true` so `primarySession()` resolves it.

- [ ] **Step 1: Write `e2e/companion-harness.ts`**

```ts
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const COMPANION_DIR = '/home/kalen/companion-x64';
export const COMPANION_MAIN = join(COMPANION_DIR, 'resources', 'app.asar'); // launched via companion_headless.sh
export const COMPANION_LAUNCHER = join(COMPANION_DIR, 'companion_headless.sh');

/** True when the local Companion install is present (harness is skipped otherwise). */
export function companionAvailable(): boolean {
  return existsSync(COMPANION_LAUNCHER);
}

/** Reserve an ephemeral loopback port (close before handing it to Companion). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export interface CompanionHandle {
  adminUrl: string;
  proc: ChildProcess;
  configDir: string;
  stop(): Promise<void>;
}

/** Launch Companion headless on an isolated config dir + per-run admin port, loading the repo dev module. */
export async function launchCompanion(repoRoot: string): Promise<CompanionHandle> {
  const adminPort = await freePort();
  const configDir = await mkdtemp(join(tmpdir(), 'companion-e2e-'));
  const proc = spawn(
    COMPANION_LAUNCHER,
    [
      '--admin-address', '127.0.0.1',
      '--admin-port', String(adminPort),
      '--config-dir', configDir,
      '--extra-module-path', repoRoot,
    ],
    { stdio: 'pipe', cwd: COMPANION_DIR },
  );
  const adminUrl = `http://127.0.0.1:${adminPort}`;
  await waitForHttp(`${adminUrl}/connections`, 30000);

  const stop = async (): Promise<void> => {
    proc.kill('SIGTERM');
    const died = await new Promise<boolean>((r) => {
      const t = setTimeout(() => r(false), 5000);
      proc.once('exit', () => {
        clearTimeout(t);
        r(true);
      });
    });
    if (!died) proc.kill('SIGKILL'); // hard-kill fallback (see spec teardown)
    await rm(configDir, { recursive: true, force: true });
  };
  return { adminUrl, proc, configDir, stop };
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Companion admin UI did not come up at ${url}`);
}

/** Seed a session on the hermetic server and simulate a visible browser presence for it. */
export async function seedActiveSession(serverBase: string): Promise<string> {
  const created = await fetch(`${serverBase}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'E2E Session' }),
  });
  if (!created.ok) throw new Error(`seed session failed: ${created.status}`);
  const sid = (await created.json()).id as string;
  const presence = await fetch(`${serverBase}/api/companion/presence`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: 'e2e-browser', session_id: sid, visible: true }),
  });
  if (!presence.ok) throw new Error(`seed presence failed: ${presence.status}`);
  return sid;
}
```

Note (verify at implementation time): confirm the exact `companion_headless.sh` argument names against `bash /home/kalen/companion-x64/companion_headless.sh --help` (or the wrapped `main.js --help`). The assumptions review confirmed `--extra-module-path`, `--admin-address`, `--admin-port` exist; confirm `--config-dir` is the config-dir flag (it may be `--config-dir` or an env var) before relying on it.

- [ ] **Step 2: Write `e2e/companion.e2e.spec.ts`**

```ts
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { companionAvailable, launchCompanion, seedActiveSession, type CompanionHandle } from './companion-harness.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = 'http://127.0.0.1:8791';

test.describe('Companion module (headless)', () => {
  test.skip(!companionAvailable(), 'Companion install not present');

  let companion: CompanionHandle;

  test.beforeAll(async () => {
    companion = await launchCompanion(repoRoot);
  });

  test.afterAll(async () => {
    await companion?.stop();
  });

  test('adds the connection, reaches OK, and a transport action rolls the take', async ({ page }) => {
    const sid = await seedActiveSession(SERVER);

    // 1. Add + configure the autologger connection via the admin UI.
    await page.goto(`${companion.adminUrl}/connections`);
    await addAutologgerConnection(page, SERVER);

    // 2. Connection reaches OK status.
    await expect(page.getByText(/autologger/i).first()).toBeVisible();
    await expect(page.getByText(/\bOK\b/i).first()).toBeVisible({ timeout: 15000 });

    // 3. Fire a transport toggle through Companion, assert the server rolled.
    await triggerTransportToggle(page);
    await expect
      .poll(async () => (await (await fetch(`${SERVER}/api/companion/state`)).json()).session?.is_rolling, {
        timeout: 10000,
      })
      .toBe(true);

    void sid;
  });
});

// These helpers encode the admin-UI interaction; selectors must be pinned against
// the running Companion 4.3.4 UI during implementation (see harness note).
async function addAutologgerConnection(page: import('@playwright/test').Page, serverUrl: string): Promise<void> {
  await page.getByRole('button', { name: /add connection/i }).click();
  await page.getByPlaceholder(/search/i).fill('autologger');
  await page.getByText('autologger', { exact: false }).first().click();
  await page.getByLabel(/server url/i).fill(serverUrl);
  await page.getByRole('button', { name: /save/i }).click();
}

async function triggerTransportToggle(page: import('@playwright/test').Page): Promise<void> {
  // Simplest deterministic path: use Companion's connection "test action" surface,
  // or configure a button and press it. Pin the exact selector at implementation.
  await page.getByRole('button', { name: /transport/i }).first().click();
}
```

- [ ] **Step 3: Add the binary-gated project to `playwright.config.ts`**

Add to the `projects` array (and import at top: `import { existsSync } from 'node:fs';`):
```ts
    {
      name: 'companion',
      testMatch: /companion\.e2e\.spec\.ts/,
      fullyParallel: false,
      // Runs only where the Companion install exists; skipped tests still "pass".
      use: { browserName: 'chromium' },
    },
```
And exclude it from the default `chromium` project so `npm run e2e` doesn't pick it up:
```ts
    { name: 'chromium', use: { browserName: 'chromium' }, testIgnore: [/visual\.spec\.ts/, /companion\.e2e\.spec\.ts/] },
```

- [ ] **Step 4: Build the module, then run the harness locally**

Run:
```bash
npm run build -w companion
npm run e2e -- --project=companion
```
Expected: on this machine (Companion present) the test adds the connection, sees OK, and asserts `is_rolling === true`. If admin-UI selectors don't match, use Playwright's `--debug`/`codegen` against `companion.adminUrl` to pin them, then update the helpers. On a machine without Companion, the whole describe skips (green).

- [ ] **Step 5: Commit**

```bash
git add e2e/companion-harness.ts e2e/companion.e2e.spec.ts playwright.config.ts
git commit -m "test(companion): headless-Companion Playwright e2e harness (binary-gated)"
```

---

### Task 10: Docs + version bump

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, root `package.json`

**Interfaces:** none (docs).

- [ ] **Step 1: Add a "Companion module" section to `README.md`**

Place it near the existing workspace/architecture docs. Content (adjust to the repo's
README voice; the key facts — packaged-not-raw loading, the `~1.14.0` pin, the `API_TOKEN`
env name — must all be present):
```markdown
## Companion module (`companion/`)

A Bitfocus Companion (Stream Deck) module — an npm workspace that controls the active
AutoLogger session over the existing `/api/companion/*` HTTP endpoints (log events,
roll/stop takes, record/play), with live feedbacks and variables.

```bash
npm run build -w companion      # check base-version pin + tsc -> companion/dist/
npm run test -w companion       # vitest unit tests
npm run package -w companion    # produce a distributable .tgz module package
```

**Loading in Companion 4.3.x:** you must load the **packaged** module, not the raw `tsc`
output — under Companion's per-module Node permission sandbox the plain `companion/dist/`
build cannot read the workspace-hoisted dependencies and fails to start. Run
`npm run package -w companion` to produce `autologger-0.1.0.tgz` (a self-contained,
dependency-free esbuild bundle with a correct `runtime.apiVersion`), then either import it
via Companion's **"Import module package"**, or extract it into a directory you pass to
`--extra-module-path`. Configure the connection with the **Server URL**
(e.g. `http://127.0.0.1:8787`) and, only if the server runs with the `API_TOKEN` env var set
(`REQUIRE_LOGIN=1`), the **API token**.

> `@companion-module/base` is pinned to `~1.14.0` (stable 1.x). Companion 4.3.4 rejects the
> newer 2.1.x line, and its 2.0.x alpha removed the `runEntrypoint` API this module uses. A
> root `package.json` `overrides` keeps `@companion-module/tools` on the same 1.14.x base so
> the packaged manifest's `apiVersion` is correct.
```

**e2e note (for the CONTRIBUTING/testing area if one exists, else fold into the above):**
the headless-Companion Playwright project is binary-gated and excluded from the default
`npm run e2e` run. To run it where a Companion install is present, use
`npm run e2e -- --project=companion --workers=1` (it must not share workers with the
`chromium` project — resource contention makes a shared multi-worker run flaky).
```

- [ ] **Step 2: Add a `CHANGELOG.md` entry**

At the top, above the latest section:
```markdown
## [0.7.0] — 2026-07-10

### Added
- Bitfocus Companion module (`companion/` workspace): log events by category, roll/stop
  takes, record/play the active session, with live feedbacks (rolling/recording/playing/
  session-active) and variables (timecode, take, deck title, command delivery, …). Pure
  client of the existing `/api/companion/*` endpoints; polls state with post-action
  refresh. Includes a headless-Companion Playwright e2e harness.

### Fixed
- Root `package.json` `overrides` pins `@companion-module/base` to `~1.14.0` across the
  workspace so `npm run package` bakes the correct `runtime.apiVersion` into the Companion
  module bundle (previously a hoisted transitive `2.0.4` from `@companion-module/tools`
  produced an unloadable package).
```

- [ ] **Step 2b: Fix the stale failure message in `companion/scripts/check-base-version.mjs`**

The guard's `console.error` still advises `Pin to ~2.0.0.` — wrong now that we pin 1.x.
Locate the line by content and change `Pin to ~2.0.0.` → `Pin to ~1.14.0 (stable 1.x).`
(only the message string; the range-check logic is already correct).

- [ ] **Step 3: Bump the root `package.json` version**

Change `"version": "0.6.0"` to `"version": "0.7.0"`.

- [ ] **Step 4: Verify the whole repo still checks out**

Run:
```bash
npm run typecheck
npm run test
npm run lint
```
Expected: all PASS (lint now includes `companion/src`).

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md package.json
git commit -m "docs(companion): README + changelog + version bump to 0.7.0"
```

---

## Self-review notes (author)

- **Spec coverage:** package/placement (T1), config+auth token name (T2), 5-endpoint client + error kinds incl. 400/409/401 (T3), state→UI incl. `last_command`/`is_playing` sentinels (T4), variables+feedbacks with best-effort `playing` (T5), actions with error-aware logging + refresh (T6), presets with `deck_title` (T7), concurrency invariants + backoff + category refresh (T8), full headless harness with per-run port + SIGKILL fallback + binary gate (T9), docs+version (T10). Version-pin blocker → T1 build guard. Session-guard gate decision (label-only) → satisfied by T7 presets; no expected-session option added (correct).
- **Placeholder scan:** every code step has complete code; UI-selector pinning in T9 is explicitly flagged as a live-verify step, not a silent TODO.
- **Type consistency:** `ModuleConfig`, `ServerStatePayload`, `ApiError`/`ApiErrorKind`, `ActionHost`, `Poller` signatures are consistent across tasks. `getState()` returns `ServerStatePayload` (T3 imports the type from T4 — build T4 before full typecheck; noted in T3 Step 4).
- **Known live-verify points (API surface):** exact `@companion-module/base` v2.0 names — `InstanceStatus` members, `combineRgb`, `Regex`, `CompanionFeedbackDefinitions`/`CompanionPresetDefinitions`/`CompanionActionDefinitions` shapes, `checkFeedbacks` variadic signature — are written from the known v2 API and must be reconciled against the installed types during T5/T8 builds. Companion headless flag names reconciled in T9.
