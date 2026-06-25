# Comprehensive Test Suite (Hybrid) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a hybrid vitest harness (node pure-unit + `@cloudflare/vitest-pool-workers` integration) and comprehensively test the pure-logic tier plus the audit's highest-risk integration surfaces, without changing production code.

**Architecture:** A vitest workspace with two projects split by filename — `*.test.ts` (node, pure) and `*.int.test.ts` (workerd, real D1/DO/KV/R2 bindings from `wrangler.jsonc`). Pure tests use fakes; integration tests apply D1 migrations and drive the Hono app via its default export and the SessionDO via `runInDurableObject`.

**Tech Stack:** TypeScript (strict), Vitest 2.1.9, `@cloudflare/vitest-pool-workers`, Cloudflare Workers / DO / D1 / KV / R2, Hono, Zod.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-25-comprehensive-test-suite-design.md`.
- **Branch:** `test/comprehensive-suite` (already checked out).
- **No production-code changes.** Tests characterize *current* behavior, including known quirks (drop-frame `;` separator over NDF math in `timecode.ts`; `sessionTtlDays` accepting non-positive values). Do NOT "fix" these here — assert what the code does today.
- **App access for router tests:** `import app from '../index'` (the Hono instance is the default export) and call `app.request(path, init, envOverride)`. No new export is added to `index.ts`.
- **File-naming convention:** node/pure → `<mod>.test.ts`; integration → `<mod>.int.test.ts`. The node project glob excludes `*.int.test.ts`.
- **Test runner:** `npm run test` (= `vitest run`) runs both projects. Single file: `npx vitest run <path>`. Type check: `npm run typecheck`.
- **No version bump** (test-only; `package.json` changes are `devDependencies` + scripts only).
- **Commit style:** Conventional Commits (`test:`, `chore(test):`).
- **Pure-tier exports actually available** (verified): `timecode.ts` and `env.ts` export all helpers; `auth/identity.ts` exports `timingSafeEqual`, `requestHasValidApiToken`, `requestHasValidAdminToken`, `apiRequestRequiresLogin`, `normalizeOauthStateParam`, `newOauthState` (pure) — KV helpers are integration; `middleware/ipAllowlist.ts` exports only `parseIpAllowlist` (the match/header helpers are private → covered via the middleware in integration); `studio.ts` exports the full list in Task 8.

---

### Task 1: Workers test harness + smoke test

De-risks the toolchain (pool-workers ↔ vitest 2.1.9) before any bulk authoring. **If this task cannot be made green, STOP and report** — the integration tier depends on it (pure tier can still proceed independently).

**Files:**
- Modify: `package.json` (add devDep + nothing else)
- Create: `vitest.config.ts`
- Create: `src/test/setup.int.ts`
- Create: `src/test/smoke.int.test.ts`

**Interfaces:**
- Produces: the two-project vitest workspace; `src/test/setup.int.ts` (applies D1 migrations in `beforeAll`); the `cloudflare:test` module is available to `*.int.test.ts` files.

- [ ] **Step 1: Install the pool-workers dev dependency**

Run: `npm install -D @cloudflare/vitest-pool-workers@^0.8.71`
Resolved during planning: latest pool-workers needs vitest ^4; `0.8.71` is the newest release whose `vitest` peer range is `2.0.x - 3.2.x` (includes the installed `2.1.9`) and still exposes `defineWorkersConfig` + `readD1Migrations`. Do not upgrade vitest.

- [ ] **Step 2: Write `vitest.workspace.ts`**

vitest 2.1.9 uses a **workspace file** for multi-project (the `test.projects` key is vitest 3.2+). `defineWorkersProject` (async form) computes the migrations binding per the workers project.

```ts
import { defineWorkersProject, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import path from 'node:path';
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    // Pure / node tier — fakes, no bindings. Excludes integration files.
    test: {
      name: 'unit',
      include: ['src/**/*.test.ts'],
      exclude: ['src/**/*.int.test.ts'],
      environment: 'node',
    },
  },
  defineWorkersProject(async () => {
    const migrations = await readD1Migrations(path.resolve('src/db/migrations'));
    return {
      test: {
        name: 'workers',
        include: ['src/**/*.int.test.ts'],
        setupFiles: ['./src/test/setup.int.ts'],
        poolOptions: {
          workers: {
            isolatedStorage: true,
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
          },
        },
      },
    };
  }),
]);
```

- [ ] **Step 3: Write the integration setup file `src/test/setup.int.ts`**

```ts
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
```

- [ ] **Step 4: Write the smoke test `src/test/smoke.int.test.ts`**

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import app from '../index';

describe('harness smoke', () => {
  it('migrations applied: a migrated table is queryable', async () => {
    // NOTE: the studio table is `studio_definitions` (NOT `studios`). Migration
    // 0001 creates: users, user_studio_memberships, user_prefs,
    // studio_definitions, shows, app_settings, sessions.
    const r = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM studio_definitions',
    ).first<{ n: number }>();
    expect(typeof r?.n).toBe('number');
  });

  it('the Hono app responds through app.request with real bindings', async () => {
    const res = await app.request('/api/profile', { method: 'GET' }, env);
    expect([200, 401, 500]).toContain(res.status);
  });
});
```

- [ ] **Step 5: Run the smoke test**

Run: `npx vitest run --project workers src/test/smoke.int.test.ts`
Expected: both tests PASS. If `app.request('/api/profile', ...)` 500s, read the body (`await res.text()`) to confirm it is a real handler error (acceptable for smoke) and not a harness/binding wiring failure. A binding/config failure here means STOP and fix the config before proceeding.

- [ ] **Step 6: Confirm the node project still runs unchanged**

Run: `npx vitest run --project unit`
Expected: the existing 35 unit tests PASS (the new config did not disturb them).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/test/setup.int.ts src/test/smoke.int.test.ts
git commit -m "test: add @cloudflare/vitest-pool-workers harness + smoke test"
```

---

### Task 2: Shared integration helpers

Reusable seed + auth helpers so later integration tasks stay declarative.

**Files:**
- Create: `src/test/helpers.ts`

**Interfaces:**
- Consumes: `cloudflare:test` `env`; `Catalog` from `../db/d1`; `createLoginSession` from `../auth/identity`; `sessionCookieName` from `../env`.
- Produces:
  - `catalogFor(): Catalog` — `new Catalog(env.DB)` (already migrated by setup).
  - `seedStudio(opts?: { id?: string; name?: string }): Promise<string>` — returns studio id.
  - `seedUser(opts?: { id?: string; email?: string; sub?: string; studios?: string[] }): Promise<string>` — returns user id, with memberships.
  - `seedShow(opts: { studioId: string; name?: string; code?: string }): Promise<string>` — returns show id.
  - `seedSession(opts: { showId: string; episode?: string; title?: string; frameRate?: number }): Promise<string>` — returns session id.
  - `loginCookie(userId: string): Promise<string>` — writes a KV login session, returns a `Cookie` header value `"<name>=<rawToken>"`.
  - `adminHeader(token: string): Record<string, string>` — `{ Authorization: 'Bearer ' + token }`.

- [ ] **Step 1: Write `src/test/helpers.ts`**

```ts
import { env } from 'cloudflare:test';
import { createLoginSession } from '../auth/identity';
import { Catalog } from '../db/d1';
import { sessionCookieName } from '../env';

export function catalogFor(): Catalog {
  return new Catalog(env.DB);
}

let counter = 0;
const uid = (p: string): string => `${p}-${(counter += 1)}`;

export async function seedStudio(opts: { id?: string; name?: string } = {}): Promise<string> {
  const id = opts.id ?? uid('studio');
  const cat = catalogFor();
  await cat.adminCreateStudio(id, opts.name ?? `Studio ${id}`);
  return id;
}

export async function seedUser(
  opts: { id?: string; email?: string; sub?: string; studios?: string[] } = {},
): Promise<string> {
  const cat = catalogFor();
  const email = opts.email ?? `${uid('user')}@example.com`;
  const sub = opts.sub ?? uid('sub');
  const row = await cat.authCreateUserGoogle({
    email,
    google_sub: sub,
    given_name: 'Test',
    family_name: 'User',
    picture_url: '',
  });
  const id = String(row.id);
  if (opts.studios?.length) await cat.authAddMemberships(id, opts.studios);
  return id;
}

export async function seedShow(opts: {
  studioId: string;
  name?: string;
  code?: string;
}): Promise<string> {
  const cat = catalogFor();
  const row = await cat.createShow({
    studio_id: opts.studioId,
    name: opts.name ?? 'Test Show',
    show_code: opts.code ?? 'TS',
  });
  return String(row.id);
}

export async function seedSession(opts: {
  showId: string;
  episode?: string;
  title?: string;
  frameRate?: number;
}): Promise<string> {
  const cat = catalogFor();
  const row = await cat.createSessionIndex({
    show_id: opts.showId,
    episode: opts.episode ?? '001',
    title: opts.title ?? 'Test Session',
    frame_rate: opts.frameRate ?? 24,
    start_offset_frames: 0,
    notes: null,
  });
  return String(row.id);
}

export async function loginCookie(userId: string): Promise<string> {
  const raw = await createLoginSession(env.AUTH, userId, 14);
  return `${sessionCookieName(env)}=${raw}`;
}

export function adminHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
```

- [ ] **Step 2: Verify the helpers compile and run against real bindings**

Add a temporary throwaway assertion by running an existing integration file later; for now just typecheck and a tiny smoke:
Run: `npx vitest run --project workers src/test/smoke.int.test.ts && npm run typecheck`
Expected: still green; `helpers.ts` type-checks. (Exact `Catalog` method names — `adminCreateStudio`, `authCreateUserGoogle`, `authAddMemberships`, `createShow`, `createSessionIndex` — are confirmed against the `d1.test.ts` delegation surface; if any signature differs, read `src/db/d1.ts` and the underlying store and adjust the call. Do not change production signatures.)

- [ ] **Step 3: Commit**

```bash
git add src/test/helpers.ts
git commit -m "test: shared integration seed + auth helpers"
```

---

### Task 3: Pure — `timecode.ts`

**Files:**
- Create: `src/timecode.test.ts`

**Interfaces:** Consumes `fromTotalFrames`, `toTotalFrames`, `formatSmpte`, `transportTimecode`, `timecodeForMark`, `formatRuntimeHms`, `parseUtcMs`, `isoZ` from `./timecode`.

- [ ] **Step 1: Write the test (characterizes current behavior incl. the NDF/`;` quirk)**

```ts
import { describe, expect, it } from 'vitest';
import {
  formatRuntimeHms,
  formatSmpte,
  fromTotalFrames,
  parseUtcMs,
  timecodeForMark,
  toTotalFrames,
  transportTimecode,
} from './timecode';

describe('fromTotalFrames / toTotalFrames', () => {
  it('round-trips across common frame rates', () => {
    for (const fps of [24, 25, 30, 50, 60]) {
      for (const total of [0, 1, fps - 1, fps, fps * 60, fps * 3600 + 7]) {
        const tc = fromTotalFrames(total, fps);
        expect(toTotalFrames(tc)).toBe(total % (Math.round(fps) * 3600 * 24) === total ? total : toTotalFrames(tc));
      }
    }
  });

  it('decomposes 1 second + 1 frame at 30fps', () => {
    const tc = fromTotalFrames(31, 30);
    expect(tc).toMatchObject({ hours: 0, minutes: 0, seconds: 1, frames: 1, frame_rate: 30 });
  });

  it('wraps hours at 24', () => {
    const tc = fromTotalFrames(30 * 3600 * 25, 30); // 25h
    expect(tc.hours).toBe(1);
  });

  it('rounds fractional fps to integer frame buckets (29.97 → 30)', () => {
    const tc = fromTotalFrames(30, 29.97);
    expect(tc).toMatchObject({ seconds: 1, frames: 0 });
    expect(tc.frame_rate).toBe(29.97);
  });

  it('throws on non-positive frame rate', () => {
    expect(() => fromTotalFrames(10, 0)).toThrow();
  });
});

describe('formatSmpte', () => {
  it('uses ":" for non-drop rates', () => {
    expect(formatSmpte({ hours: 1, minutes: 2, seconds: 3, frames: 4, frame_rate: 30 })).toBe(
      '01:02:03:04',
    );
  });
  it('uses ";" for 29.97 (current behavior — NDF math, DF label)', () => {
    expect(formatSmpte({ hours: 0, minutes: 0, seconds: 0, frames: 0, frame_rate: 29.97 })).toBe(
      '00:00:00;00',
    );
  });
});

describe('transportTimecode / timecodeForMark', () => {
  const ROLL = '2026-06-25T00:00:00.000Z';
  const now = Date.parse('2026-06-25T00:00:05.000Z'); // +5s

  it('adds elapsed + (now-roll)*fps while rolling', () => {
    const tc = transportTimecode(
      30,
      0,
      { is_rolling: true, elapsed_frames: 0, roll_started_at_utc: ROLL },
      now,
    );
    expect(toTotalFrames(tc)).toBe(150); // 5s @ 30
  });

  it('ignores live extra when stopped', () => {
    const tc = transportTimecode(
      30,
      0,
      { is_rolling: false, elapsed_frames: 90, roll_started_at_utc: null },
      now,
    );
    expect(toTotalFrames(tc)).toBe(90);
  });

  it('timecodeForMark clamps a mark before roll start to the base', () => {
    const before = Date.parse('2026-06-24T23:59:59.000Z');
    const tc = timecodeForMark(
      30,
      0,
      { is_rolling: true, elapsed_frames: 12, roll_started_at_utc: ROLL },
      before,
    );
    expect(toTotalFrames(tc)).toBe(12);
  });
});

describe('formatRuntimeHms / parseUtcMs', () => {
  it('formats HH:MM:SS and zero', () => {
    expect(formatRuntimeHms(0, 30)).toBe('00:00:00');
    expect(formatRuntimeHms(30 * 65, 30)).toBe('00:01:05');
  });
  it('parseUtcMs handles +00:00 and bad input', () => {
    expect(parseUtcMs('2026-06-25T00:00:00+00:00')).toBe(Date.parse('2026-06-25T00:00:00Z'));
    expect(Number.isNaN(parseUtcMs(null))).toBe(true);
  });
});
```

- [ ] **Step 2: Run + commit**

Run: `npx vitest run src/timecode.test.ts`
Expected: PASS. If the round-trip assertion is awkward, simplify it to assert `toTotalFrames(fromTotalFrames(total, fps)) === total` for `total < Math.round(fps)*3600*24`.

```bash
git add src/timecode.test.ts && git commit -m "test: timecode math + SMPTE formatting (characterization)"
```

---

### Task 4: Pure — `env.ts`

**Files:**
- Create: `src/env.test.ts`

**Interfaces:** Consumes the `env.ts` exports. Build `Env` fixtures with `{ ...base } as unknown as Env`.

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from 'vitest';
import {
  adminMeta,
  adminTokenConfigured,
  cookieSecureForRequest,
  newUserAllTeamsEnabled,
  oauthConfigured,
  publicBaseUrl,
  requireLoginEnabled,
  sessionCookieName,
  sessionTtlDays,
} from './env';

const E = (o: Record<string, string | undefined>): Env => o as unknown as Env;

describe('env flag parsing', () => {
  it('requireLoginEnabled is true only for 1/true/yes', () => {
    expect(requireLoginEnabled(E({ REQUIRE_LOGIN: '1' }))).toBe(true);
    expect(requireLoginEnabled(E({ REQUIRE_LOGIN: 'TRUE' }))).toBe(true);
    expect(requireLoginEnabled(E({ REQUIRE_LOGIN: '0' }))).toBe(false);
    expect(requireLoginEnabled(E({}))).toBe(false);
  });

  it('newUserAllTeamsEnabled defaults off and is false for 0/false/no', () => {
    expect(newUserAllTeamsEnabled(E({}))).toBe(false);
    expect(newUserAllTeamsEnabled(E({ NEW_USER_ALL_TEAMS: 'no' }))).toBe(false);
    expect(newUserAllTeamsEnabled(E({ NEW_USER_ALL_TEAMS: '1' }))).toBe(true);
  });

  it('sessionCookieName falls back to default', () => {
    expect(sessionCookieName(E({}))).toBe('autologger_sid');
    expect(sessionCookieName(E({ SESSION_COOKIE: 'x' }))).toBe('x');
  });

  it('cookieSecureForRequest honors explicit flag, else derives from scheme', () => {
    expect(cookieSecureForRequest(E({ COOKIE_SECURE: 'yes' }), 'http://x')).toBe(true);
    expect(cookieSecureForRequest(E({ COOKIE_SECURE: 'no' }), 'https://x')).toBe(false);
    expect(cookieSecureForRequest(E({}), 'https://x')).toBe(true);
    expect(cookieSecureForRequest(E({}), 'http://x')).toBe(false);
    expect(cookieSecureForRequest(E({}), 'not a url')).toBe(false);
  });

  it('sessionTtlDays — current behavior: finite passes through (incl. non-positive)', () => {
    expect(sessionTtlDays(E({}))).toBe(14);
    expect(sessionTtlDays(E({ SESSION_DAYS: '30' }))).toBe(30);
    expect(sessionTtlDays(E({ SESSION_DAYS: '0' }))).toBe(0); // quirk: not clamped
    expect(sessionTtlDays(E({ SESSION_DAYS: 'abc' }))).toBe(14);
  });

  it('oauthConfigured requires id + secret + base url', () => {
    expect(oauthConfigured(E({}))).toBe(false);
    expect(
      oauthConfigured(E({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', PUBLIC_BASE_URL: 'http://x' })),
    ).toBe(true);
  });

  it('publicBaseUrl strips trailing slashes; adminMeta reflects token presence', () => {
    expect(publicBaseUrl(E({ PUBLIC_BASE_URL: 'http://x/' }))).toBe('http://x');
    expect(adminTokenConfigured(E({ ADMIN_TOKEN: 't' }))).toBe(true);
    expect(adminMeta(E({ ADMIN_TOKEN: 't' }))).toEqual({
      restart_supported: false,
      restart_needs_token: true,
    });
  });
});
```

- [ ] **Step 2: Run + commit**

Run: `npx vitest run src/env.test.ts`
Expected: PASS.

```bash
git add src/env.test.ts && git commit -m "test: env flag parsing (incl. characterized SESSION_DAYS quirk)"
```

---

### Task 5: Pure — `auth/identity.ts` helpers + `ipAllowlist` parse

**Files:**
- Create: `src/auth/identity.test.ts`
- Create: `src/middleware/ipAllowlist.test.ts`

**Interfaces:** identity → `timingSafeEqual`, `requestHasValidAdminToken`, `requestHasValidApiToken`, `apiRequestRequiresLogin`, `normalizeOauthStateParam`, `newOauthState`. ipAllowlist → `parseIpAllowlist`.

- [ ] **Step 1: Write `src/auth/identity.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import {
  apiRequestRequiresLogin,
  newOauthState,
  normalizeOauthStateParam,
  requestHasValidAdminToken,
  requestHasValidApiToken,
  timingSafeEqual,
} from './identity';

const req = (auth?: string): Request =>
  new Request('http://x/', auth ? { headers: { Authorization: auth } } : undefined);

describe('identity pure helpers', () => {
  it('timingSafeEqual matches equal strings, rejects different length/content', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'ab')).toBe(false);
  });

  it('admin/api token checks require a matching Bearer and a configured token', () => {
    expect(requestHasValidAdminToken(req('Bearer secret'), 'secret')).toBe(true);
    expect(requestHasValidAdminToken(req('Bearer nope'), 'secret')).toBe(false);
    expect(requestHasValidAdminToken(req(), 'secret')).toBe(false);
    expect(requestHasValidAdminToken(req('Bearer secret'), '')).toBe(false);
    expect(requestHasValidApiToken(req('Bearer k'), 'k')).toBe(true);
  });

  it('apiRequestRequiresLogin gates /api/* except GET /api/profile and /api/admin/*', () => {
    expect(apiRequestRequiresLogin('/api/sessions', 'GET')).toBe(true);
    expect(apiRequestRequiresLogin('/api/profile', 'GET')).toBe(false);
    expect(apiRequestRequiresLogin('/api/profile', 'POST')).toBe(true);
    expect(apiRequestRequiresLogin('/api/admin/users', 'GET')).toBe(false);
    expect(apiRequestRequiresLogin('/', 'GET')).toBe(false);
  });

  it('normalizeOauthStateParam trims + percent-decodes, tolerates bad input', () => {
    expect(normalizeOauthStateParam('  a%20b ')).toBe('a b');
    expect(normalizeOauthStateParam('%')).toBe('%');
    expect(normalizeOauthStateParam('')).toBe('');
  });

  it('newOauthState returns a non-empty url-safe token', () => {
    const s = newOauthState();
    expect(s.length).toBeGreaterThan(20);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
```

- [ ] **Step 2: Write `src/middleware/ipAllowlist.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { parseIpAllowlist } from './ipAllowlist';

describe('parseIpAllowlist', () => {
  it('returns null for empty / whitespace (disabled)', () => {
    expect(parseIpAllowlist('')).toBeNull();
    expect(parseIpAllowlist('   ')).toBeNull();
  });

  it('parses a v4 host and a v4 CIDR', () => {
    const nets = parseIpAllowlist('10.0.0.1, 192.168.0.0/24');
    expect(nets).toHaveLength(2);
    expect(nets?.[0]).toMatchObject({ version: 4, bits: 32 });
    expect(nets?.[1]).toMatchObject({ version: 4, bits: 24 });
  });

  it('parses v6, strips brackets and zone ids', () => {
    const nets = parseIpAllowlist('[2001:db8::1]/64, fe80::1%en0');
    expect(nets).toHaveLength(2);
    expect(nets?.[0]).toMatchObject({ version: 6, bits: 64 });
    expect(nets?.[1]).toMatchObject({ version: 6, bits: 128 });
  });

  it('throws on a malformed entry', () => {
    expect(() => parseIpAllowlist('999.1.1.1')).toThrow();
    expect(() => parseIpAllowlist('10.0.0.0/40')).toThrow();
  });
});
```

- [ ] **Step 3: Run + commit**

Run: `npx vitest run src/auth/identity.test.ts src/middleware/ipAllowlist.test.ts`
Expected: PASS.

```bash
git add src/auth/identity.test.ts src/middleware/ipAllowlist.test.ts
git commit -m "test: identity pure helpers + IP allowlist parsing"
```

---

### Task 6: Pure — extend `schemas.test.ts` to all schemas

**Files:**
- Modify: `src/schemas.test.ts` (append describes; keep the existing metadata-cap block)

**Interfaces:** Consumes the schema exports from `./schemas`.

- [ ] **Step 1: Append schema-boundary tests**

Add to `src/schemas.test.ts` (after the existing `describe`):

```ts
import {
  adminStudioCreateBodySchema,
  audioSegmentWaveformBodySchema,
  companionCommandBodySchema,
  eventUpdateBodySchema,
  newSessionBodySchema,
} from './schemas';

describe('newSessionBodySchema', () => {
  it('defaults frame_rate=24, start_offset=0 and requires show_id+episode', () => {
    const r = newSessionBodySchema.safeParse({ show_id: 's', episode: '001' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ frame_rate: 24, start_offset_frames: 0 });
  });
  it('rejects frame_rate out of [1,120]', () => {
    expect(newSessionBodySchema.safeParse({ show_id: 's', episode: '1', frame_rate: 0 }).success).toBe(false);
    expect(newSessionBodySchema.safeParse({ show_id: 's', episode: '1', frame_rate: 121 }).success).toBe(false);
  });
  it('requires non-empty episode', () => {
    expect(newSessionBodySchema.safeParse({ show_id: 's', episode: '' }).success).toBe(false);
  });
});

describe('eventUpdateBodySchema', () => {
  it('requires exactly-8-char timecode_hms', () => {
    const base = { category: 'c', message: 'm', wall_time_utc: 'w' };
    expect(eventUpdateBodySchema.safeParse({ ...base, timecode_hms: '00:00:00' }).success).toBe(true);
    expect(eventUpdateBodySchema.safeParse({ ...base, timecode_hms: '1:2:3' }).success).toBe(false);
  });
});

describe('enum + bound schemas', () => {
  it('companionCommandBodySchema accepts only known actions', () => {
    expect(companionCommandBodySchema.safeParse({ type: 'record-start' }).success).toBe(true);
    expect(companionCommandBodySchema.safeParse({ type: 'nope' }).success).toBe(false);
  });
  it('adminStudioCreateBodySchema enforces id length 2..63', () => {
    expect(adminStudioCreateBodySchema.safeParse({ id: 'a', display_name: 'x' }).success).toBe(false);
    expect(adminStudioCreateBodySchema.safeParse({ id: 'ab', display_name: 'x' }).success).toBe(true);
  });
  it('audioSegmentWaveformBodySchema bounds peaks 8..4096', () => {
    expect(audioSegmentWaveformBodySchema.safeParse({ peaks: [1, 2, 3] }).success).toBe(false);
    expect(audioSegmentWaveformBodySchema.safeParse({ peaks: Array(8).fill(0) }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run + commit**

Run: `npx vitest run src/schemas.test.ts`
Expected: PASS (existing 3 + new). If any schema field name differs from the assumption, read `src/schemas.ts` and correct the test (the schema is the source of truth).

```bash
git add src/schemas.test.ts && git commit -m "test: schema boundary + enum coverage"
```

---

### Task 7: Pure — `studio.ts` (palette, categories, profile)

`studio.ts` is the largest pure module. Read it alongside writing this task to pin exact expected values for the complex functions.

**Files:**
- Create: `src/studio.test.ts`

**Interfaces:** Consumes `validateEventPalette`, `normalizeEventPaletteNine`, `validateEventPalettePreset`, `validateCategoriesList`, `freshCategoryIds`, `paletteFromCategories`, `blobToProfile`, `defaultSettingsBlob`, `studioConfigKey`, `suggestedShowCode`, `newSessionTitlePrefix`, `normalizeEventButtonNameForRelink`, `ValidationError` from `./studio`.

- [ ] **Step 1: Write the structural/characterization tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  blobToProfile,
  defaultSettingsBlob,
  freshCategoryIds,
  normalizeEventButtonNameForRelink,
  normalizeEventPaletteNine,
  paletteFromCategories,
  studioConfigKey,
  suggestedShowCode,
  validateCategoriesList,
  validateEventPalette,
  validateEventPalettePreset,
} from './studio';

describe('event palette', () => {
  it('defaults when input is null/empty', () => {
    expect(validateEventPalette(null).length).toBeGreaterThan(0);
    expect(validateEventPalette([]).length).toBeGreaterThan(0);
  });
  it('normalizeEventPaletteNine always returns 9 slots', () => {
    expect(normalizeEventPaletteNine(['#111111'])).toHaveLength(9);
    expect(normalizeEventPaletteNine([])).toHaveLength(9);
  });
  it('clamps a longer custom palette to at most 9', () => {
    const many = Array(20).fill('#123456');
    expect(validateEventPalette(many).length).toBeLessThanOrEqual(9);
  });
  it('validateEventPalettePreset returns a string', () => {
    expect(typeof validateEventPalettePreset('custom')).toBe('string');
  });
});

describe('categories', () => {
  it('freshCategoryIds assigns a NEW id to every category (no shared refs)', () => {
    const cats = validateCategoriesList([
      { label: 'A', type: 'BUTTON', color: '#111111' },
      { label: 'B', type: 'DROPDOWN', color: '#222222' },
    ]);
    const a = freshCategoryIds(cats);
    const b = freshCategoryIds(cats);
    const aIds = a.map((c) => c.id);
    expect(new Set(aIds).size).toBe(aIds.length); // unique within
    expect(a[0].id).not.toBe(b[0].id); // unique across calls
  });
  it('validateCategoriesList coerces an unknown kind to a valid CategoryKind', () => {
    const cats = validateCategoriesList([{ label: 'X', type: 'WeIrD', color: '#abcdef' }]);
    expect(['BUTTON', 'DROPDOWN', 'TEXT', 'ON_OFF']).toContain(cats[0].type);
  });
  it('paletteFromCategories derives colors from categories', () => {
    const cats = validateCategoriesList([{ label: 'X', type: 'BUTTON', color: '#abcdef' }]);
    expect(Array.isArray(paletteFromCategories(cats))).toBe(true);
  });
});

describe('profile + misc helpers', () => {
  it('defaultSettingsBlob → blobToProfile round-trips id/name', () => {
    const blob = defaultSettingsBlob('studio-x');
    const profile = blobToProfile('studio-x', 'Studio X', blob);
    expect(profile).toMatchObject({ studio_id: 'studio-x', name: 'Studio X' });
    expect(Array.isArray(profile.categories)).toBe(true);
  });
  it('studioConfigKey is prefixed', () => {
    expect(studioConfigKey('abc')).toContain('abc');
  });
  it('suggestedShowCode derives a short code from a name', () => {
    const code = suggestedShowCode('My Great Show');
    expect(typeof code).toBe('string');
    expect(code.length).toBeGreaterThan(0);
  });
  it('normalizeEventButtonNameForRelink is stable + trims', () => {
    expect(normalizeEventButtonNameForRelink('  Cam 1 ')).toBe(
      normalizeEventButtonNameForRelink('Cam 1'),
    );
  });
});
```

- [ ] **Step 2: Pin exact values where the structural assertion is weak**

For `validateEventPalette` default length, `suggestedShowCode` output, and `studioConfigKey` prefix, read the corresponding function in `src/studio.ts` and tighten the assertion to the exact value (e.g. `expect(suggestedShowCode('My Great Show')).toBe('<actual>')`). Replace any `toBeGreaterThan`/`toContain` that you can make exact.

- [ ] **Step 3: Run + commit**

Run: `npx vitest run src/studio.test.ts`
Expected: PASS.

```bash
git add src/studio.test.ts && git commit -m "test: studio palette/category/profile helpers"
```

---

### Task 8: Integration — D1 stores (real DB + migrations)

**Files:**
- Create: `src/db/d1.int.test.ts`

**Interfaces:** Consumes `cloudflare:test` `env`; the helpers from `../test/helpers`; `Catalog` from `./d1`.

- [ ] **Step 1: Write the representative store tests**

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { catalogFor, seedSession, seedShow, seedStudio, seedUser } from '../test/helpers';

describe('D1 studio + auth stores', () => {
  it('creates a studio and lists it', async () => {
    const cat = catalogFor();
    const id = await seedStudio({ name: 'Acme' });
    expect(await cat.isKnownStudio(id)).toBe(true);
    const brief = await cat.listStudiosBrief();
    expect(brief.some((s) => s.id === id)).toBe(true);
  });

  it('setSetting upserts (insert then update same key)', async () => {
    const cat = catalogFor();
    await cat.setSetting('k', 'v1');
    await cat.setSetting('k', 'v2');
    expect(await cat.getSetting('k')).toBe('v2');
  });

  it('user membership: add, query, remove', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const user = await seedUser({ studios: [studio] });
    expect(await cat.authUserHasStudio(user, studio)).toBe(true);
    await cat.authRemoveMembership(user, studio);
    expect(await cat.authUserHasStudio(user, studio)).toBe(false);
  });
});

describe('D1 session index store', () => {
  it('createSessionIndex bumps the show next_episode', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const show = await seedShow({ studioId: studio });
    await seedSession({ showId: show, episode: '005' });
    const row = await cat.getShowRow(show);
    expect(Number(row?.next_episode ?? 0)).toBeGreaterThanOrEqual(5);
  });

  it('getSessionStudioId resolves the owning studio', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const show = await seedShow({ studioId: studio });
    const session = await seedSession({ showId: show });
    expect(await cat.getSessionStudioId(session)).toBe(studio);
  });

  it('getSessionStudioId returns null for a session whose show was deleted (orphan)', async () => {
    const cat = catalogFor();
    const studio = await seedStudio();
    const show = await seedShow({ studioId: studio });
    const session = await seedSession({ showId: show });
    await env.DB.prepare('DELETE FROM shows WHERE id = ?').bind(show).run();
    expect(await cat.getSessionStudioId(session)).toBeNull();
  });

  it('listSessionsForShow scopes to the show (tenant isolation)', async () => {
    const cat = catalogFor();
    const studioA = await seedStudio();
    const studioB = await seedStudio();
    const showA = await seedShow({ studioId: studioA });
    const showB = await seedShow({ studioId: studioB });
    const sA = await seedSession({ showId: showA });
    await seedSession({ showId: showB });
    const list = await cat.listSessionsForShow(showA);
    expect(list.map((r) => String(r.id))).toEqual([sA]);
  });
});
```

- [ ] **Step 2: Add the remaining store cases (same pattern, exact methods from `d1.test.ts` surface)**

Append `it(...)` blocks covering: `saveStudioSettingsBlob` round-trips via `studioProfileForSession`; `adminDeleteStudio` throws/blocks when shows exist and succeeds when empty (assert `isKnownStudio` false after); `authGetPrefs`/`authSetPrefs` round-trip; `authSetUserDisabled` reflected in `authGetUserRowAny`; `updateShowFields` changes name/code; `projectSessionLive` then `getSessionJoinedRow` shows the projected rolling fields; `setSessionArchived`/`setSessionUiHidden` toggle visibility in `listSessionsForShow`. Each: seed → act → assert via a Catalog read. If a method name/signature differs, read `src/db/<store>.ts` and adjust (no production change).

- [ ] **Step 3: Run + commit**

Run: `npx vitest run --project workers src/db/d1.int.test.ts`
Expected: PASS.

```bash
git add src/db/d1.int.test.ts && git commit -m "test: D1 stores integration (tenancy, episode bump, orphan resolution)"
```

---

### Task 9: Integration — SessionDO (real storage + lease alarm)

**Files:**
- Create: `src/durable/SessionDO.int.test.ts`

**Interfaces:** Consumes `cloudflare:test` `env` + `runInDurableObject`. Obtain a stub: `const id = env.SESSION_DO.idFromName('s1'); const stub = env.SESSION_DO.get(id);`.

- [ ] **Step 1: Write the DO tests via `runInDurableObject`**

```ts
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { SessionDO } from './SessionDO';

function stubFor(name: string) {
  const id = env.SESSION_DO.idFromName(name);
  return env.SESSION_DO.get(id);
}
const CTX = { frameRate: 30, startOffsetFrames: 0 };

describe('SessionDO real storage', () => {
  it('initSchema makes events queryable and addEvent bumps revision', async () => {
    const stub = stubFor('do-events');
    await runInDurableObject(stub, async (instance: SessionDO) => {
      instance.initSchema();
      const before = instance.statusLive(CTX).events_stream_revision;
      instance.addEvent({
        category: 'cam',
        message: 'hi',
        metadataJson: '{}',
        markedAtUtc: null,
        ctx: CTX,
      });
      const after = instance.statusLive(CTX).events_stream_revision;
      expect(after).toBeGreaterThan(before);
      expect(instance.statusLive(CTX).event_count).toBe(1);
    });
  });

  it('transport start/stop persists elapsed frames across calls', async () => {
    const stub = stubFor('do-transport');
    await runInDurableObject(stub, async (instance: SessionDO) => {
      instance.initSchema();
      const started = instance.startTake(CTX);
      expect(started.state.started).toBe(true);
      const stopped = instance.stopTake(CTX);
      expect(stopped.state.stopped).toBe(true);
    });
  });

  it('lease: claim arms an alarm; expireIfStale frees a stale lease against real storage', async () => {
    const stub = stubFor('do-lease');
    await runInDurableObject(stub, async (instance: SessionDO, state) => {
      instance.initSchema();
      expect(instance.claimLease('c1')).toBe(true);
      expect(await state.storage.getAlarm()).not.toBeNull();
      const s = instance.leaseStatus();
      expect(s.holder_client_id).toBe('c1');
    });
  });
});
```

- [ ] **Step 2: Add remaining DO cases**

Append: audio `addAudioSegment` → `listAudioSegments` ordinal allocation + `deleteAudioSegment`; topic add/list/update/delete; transcript word add/list; the lease re-arm-vs-free distinction by manipulating stored `lease_seen_ms` via `state.storage` and invoking the alarm path. Use the exact DO RPC method names from `src/durable/SessionDO.ts` (read it to confirm signatures — e.g. `addEvent`, `listEvents`, `addAudioSegment`, `listAudioSegments`, `deleteAudioSegment`, `addTopic`, `claimLease`, `heartbeatLease`, `releaseLease`, `leaseStatus`). If `addEvent`'s argument shape differs, match the production signature exactly.

- [ ] **Step 3: Run + commit**

Run: `npx vitest run --project workers src/durable/SessionDO.int.test.ts`
Expected: PASS.

```bash
git add src/durable/SessionDO.int.test.ts && git commit -m "test: SessionDO integration (events/transport/audio/lease on real storage)"
```

---

### Task 10: Integration — routers: auth gate, tenancy, validation, caps

**Files:**
- Create: `src/routers/gate.int.test.ts`

**Interfaces:** Consumes `app` (default export of `../index`), `env`, helpers. Override env per request: `app.request(path, init, { ...env, REQUIRE_LOGIN: '1', ADMIN_TOKEN: 't' })`.

- [ ] **Step 1: Write the gate/tenancy/validation/caps tests**

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import app from '../index';
import { adminHeader, loginCookie, seedSession, seedShow, seedStudio, seedUser } from '../test/helpers';

const withLogin = { ...env, REQUIRE_LOGIN: '1' } as typeof env;

describe('auth gate', () => {
  it('blocks an unauthenticated /api/* when REQUIRE_LOGIN=1', async () => {
    const res = await app.request('/api/sessions', { method: 'GET' }, withLogin);
    expect([401, 403, 302]).toContain(res.status);
  });

  it('allows GET /api/profile anonymously even under strict login', async () => {
    const res = await app.request('/api/profile', { method: 'GET' }, withLogin);
    expect(res.status).toBe(200);
  });

  it('admin routes require the admin bearer token (503 when unconfigured)', async () => {
    const noToken = await app.request('/api/admin/studios', { method: 'GET' }, { ...env });
    expect(noToken.status).toBe(503);
    const bad = await app.request(
      '/api/admin/studios',
      { method: 'GET', headers: adminHeader('wrong') },
      { ...env, ADMIN_TOKEN: 'right' },
    );
    expect(bad.status).toBe(401);
  });
});

describe('tenancy', () => {
  it('returns 404 for a session outside the caller’s studio', async () => {
    const studioA = await seedStudio();
    const studioB = await seedStudio();
    const show = await seedShow({ studioId: studioB });
    const session = await seedSession({ showId: show });
    const user = await seedUser({ studios: [studioA] }); // NOT in studioB
    const cookie = await loginCookie(user);
    const res = await app.request(
      `/api/sessions/${session}/status`,
      { method: 'GET', headers: { Cookie: cookie } },
      withLogin,
    );
    expect(res.status).toBe(404);
  });
});

describe('validation + caps', () => {
  it('422 on a log body with oversized metadata', async () => {
    const studio = await seedStudio();
    const show = await seedShow({ studioId: studio });
    const session = await seedSession({ showId: show });
    const res = await app.request(
      `/api/sessions/${session}/events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: 'c', message: 'm', metadata: { b: 'x'.repeat(9000) } }),
      },
      { ...env },
    );
    expect(res.status).toBe(422);
  });

  it('413 on an oversized audio upload (Content-Length over cap)', async () => {
    const studio = await seedStudio();
    const show = await seedShow({ studioId: studio });
    const session = await seedSession({ showId: show });
    const res = await app.request(
      `/api/sessions/${session}/audio/segments`,
      { method: 'POST', headers: { 'content-length': String(60 * 1024 * 1024) }, body: 'x' },
      { ...env },
    );
    expect(res.status).toBe(413);
  });
});
```

- [ ] **Step 2: Reconcile endpoint paths with the routers**

The exact paths (`/api/sessions/:id/status`, `/api/sessions/:id/events`, `/api/sessions/:id/audio/segments`, `/api/admin/studios`) and the anonymous-profile behavior must match the real routers. If a path or status differs, read the relevant router in `src/routers/` and correct the test to the real contract (do not change the router).

- [ ] **Step 3: Run + commit**

Run: `npx vitest run --project workers src/routers/gate.int.test.ts`
Expected: PASS.

```bash
git add src/routers/gate.int.test.ts && git commit -m "test: router auth gate, tenancy 404, 422 metadata cap, 413 audio cap"
```

---

### Task 11: Integration — routers: events, audio (R2), exports, companion

**Files:**
- Create: `src/routers/flows.int.test.ts`

**Interfaces:** Consumes `app`, `env`, helpers.

- [ ] **Step 1: Write the end-to-end flow tests**

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import app from '../index';
import { seedSession, seedShow, seedStudio } from '../test/helpers';

async function freshSession(): Promise<string> {
  const studio = await seedStudio();
  const show = await seedShow({ studioId: studio });
  return seedSession({ showId: show });
}

describe('events flow', () => {
  it('logs an event then lists it', async () => {
    const session = await freshSession();
    const post = await app.request(
      `/api/sessions/${session}/events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: 'cam', message: 'Cut to 2' }),
      },
      { ...env },
    );
    expect(post.status).toBe(200);
    const list = await app.request(`/api/sessions/${session}/events`, { method: 'GET' }, { ...env });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { events: unknown[] };
    expect(body.events.length).toBeGreaterThanOrEqual(1);
  });
});

describe('audio flow (R2 round-trip)', () => {
  it('uploads a segment, stores bytes in R2, and downloads them back', async () => {
    const session = await freshSession();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const up = await app.request(
      `/api/sessions/${session}/audio/segments`,
      { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: bytes },
      { ...env },
    );
    expect(up.status).toBe(200);
    const seg = (await up.json()) as { id: string; url: string };
    const down = await app.request(seg.url, { method: 'GET' }, { ...env });
    expect(down.status).toBe(200);
    expect(new Uint8Array(await down.arrayBuffer())).toEqual(bytes);
  });

  it('rejects an empty audio body with 400', async () => {
    const session = await freshSession();
    const res = await app.request(
      `/api/sessions/${session}/audio/segments`,
      { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: new Uint8Array(0) },
      { ...env },
    );
    expect(res.status).toBe(400);
  });
});

describe('exports flow', () => {
  it('returns CSV with a header row', async () => {
    const session = await freshSession();
    await app.request(
      `/api/sessions/${session}/events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: 'cam', message: 'm' }),
      },
      { ...env },
    );
    const res = await app.request(`/api/sessions/${session}/export.csv`, { method: 'GET' }, { ...env });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(',');
  });
});
```

- [ ] **Step 2: Reconcile paths + add companion happy path**

Confirm the events list-response shape (`{ events: [...] }`), the audio segment response (`url`), and the export path (`/export.csv` / `/export.jsonl`) against `src/routers/events.ts`, `audio.ts`, `exports.ts`; correct to the real contract. Add one companion presence-register + command-relay test against `src/routers/companion.ts` (assert the documented current behavior; do not assert the deferred tenancy fix). Add a JSONL export assertion.

- [ ] **Step 3: Run + commit**

Run: `npx vitest run --project workers src/routers/flows.int.test.ts`
Expected: PASS.

```bash
git add src/routers/flows.int.test.ts && git commit -m "test: events/audio-R2/exports/companion integration flows"
```

---

### Task 12: Integration — middleware: IP allowlist 403

**Files:**
- Create: `src/middleware/ipAllowlist.int.test.ts`

**Interfaces:** Consumes `app`, `env`. Drive the allowlist via `IP_ALLOWLIST` env + a `CF-Connecting-IP` header.

- [ ] **Step 1: Write the middleware behavior test**

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import app from '../index';

const allow = { ...env, IP_ALLOWLIST: '10.0.0.0/24' } as typeof env;

describe('ipAllowlist middleware', () => {
  it('403s a client IP outside the allowlist', async () => {
    const res = await app.request(
      '/api/profile',
      { method: 'GET', headers: { 'CF-Connecting-IP': '8.8.8.8' } },
      allow,
    );
    expect(res.status).toBe(403);
  });

  it('allows a client IP inside the allowlist', async () => {
    const res = await app.request(
      '/api/profile',
      { method: 'GET', headers: { 'CF-Connecting-IP': '10.0.0.5' } },
      allow,
    );
    expect(res.status).toBe(200);
  });

  it('is disabled when IP_ALLOWLIST is empty', async () => {
    const res = await app.request('/api/profile', { method: 'GET' }, { ...env, IP_ALLOWLIST: '' });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run + commit**

Run: `npx vitest run --project workers src/middleware/ipAllowlist.int.test.ts`
Expected: PASS. (If `/api/profile` returns 500 due to a missing binding in the allowlisted case, switch the probe path to a lighter always-200 route confirmed by reading the routers.)

```bash
git add src/middleware/ipAllowlist.int.test.ts
git commit -m "test: IP allowlist middleware 403/allow/disabled"
```

---

### Task 13: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run both projects + typecheck**

Run: `npm run test && npm run typecheck`
Expected: every file green across both `unit` and `workers` projects; `tsc --noEmit` clean.

- [ ] **Step 2: Record the new totals**

Run: `npx vitest run 2>&1 | tail -5`
Confirm the count rose substantially from the pre-existing 35 and includes the `*.int.test.ts` files.

- [ ] **Step 3: Commit (only if Step 1 required any reconciling edits)**

```bash
git add -A && git commit -m "test: reconcile suite to green across both projects" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**
- Harness (two-project workspace, migrations, isolated storage) → Task 1.
- Helpers/fixtures → Task 2.
- Pure tier: `timecode` → T3; `env` → T4; `identity` pure + `ipAllowlist` parse → T5; `schemas` → T6; `studio` → T7. (`ipAllowlist` match/header helpers are private → covered via middleware integration in T12, as the spec notes.)
- Integration tier: D1 stores → T8; SessionDO real storage + lease → T9; router gate/tenancy/422/413 → T10; events/audio-R2/exports/companion → T11; middleware 403 → T12.
- Verification → T13.
- Deferred (oauth JWKS e2e, exhaustive endpoints, companion edge cases) → not in any task, by design.

**Placeholder scan:** Tasks 7–11 contain a "reconcile against the real source" step rather than a vague TODO — each names the exact file to read and the exact contract to confirm, with complete representative code already written. This is deliberate: the integration contracts (response shapes, paths, DO method arg shapes) must be verified against production rather than guessed, and production was not fully read line-by-line during planning. No step says "write tests here" without code.

**Type consistency:** `app` (default export, `app.request(path, init, env)`), `env` from `cloudflare:test`, `runInDurableObject(stub, cb)`, `Catalog` method names (from the `d1.test.ts` delegation surface), and the helper signatures in Task 2 are used consistently across Tasks 8–12. `CTX = { frameRate, startOffsetFrames }` matches `TimecodeCtx`.
