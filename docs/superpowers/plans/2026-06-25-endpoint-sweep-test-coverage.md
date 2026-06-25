# Remaining-Endpoint Integration Sweep — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integration-test the ~30 remaining routes (sessions, shows, profile/studio, admin, transcribe/topics) — happy path + one key branch each — reusing the established harness.

**Architecture:** Four new `*.int.test.ts` files (one per router group), driving `app.request(path, init, env)` with the existing helpers. No production code changes.

**Tech Stack:** Vitest 2.1.9 + `@cloudflare/vitest-pool-workers`, Hono.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-25-endpoint-sweep-test-coverage-design.md`.
- **Branch:** `test/endpoint-sweep` (already checked out).
- **No production-code changes.** Assert current status codes / response shapes.
- **Helpers:** `seedStudio/seedUser/seedShow/seedSession`, `loginCookie`, `adminHeader` from `../test/helpers`; `app` is the default export of `../index`.
- **Env overrides:** literal-typed vars → `envWith(o) = ({ ...env, ...o }) as unknown as typeof env`.
- **Auth modes:** session-scoped happy paths run anonymous (`{ ...env }`); tenancy-404 branches use `envWith({ REQUIRE_LOGIN: '1' })` + `loginCookie(nonMember)`; admin routes use `adminHeader(TOKEN)` + `envWith({ ADMIN_TOKEN: TOKEN })`.
- **Active-studio gotcha:** `GET/POST /api/sessions` and `/api/shows` resolve the *effective* studio. For anonymous that's the builtin default. To create a show the active studio accepts, FIRST read the active studio id from `GET /api/studio` (`{ id, ... }`) and seed the show under it. Session-scoped routes (`PUT`/`archive`/`restore`/`DELETE`/transcribe/topics) work on ANY seeded session via `requireSession` (anonymous skips tenancy).
- **Verified response shapes** (from the routers): `POST /api/sessions` → `{ id, title, frame_rate, start_offset_frames, show_id, episode, notes }`; `PUT` → `{ id, title, frame_rate, start_offset_frames }`; archive/restore → `{ ok, archived }`; delete → `{ ok, hidden }`; `GET /api/sessions` → `{ active: [], archived: [] }`; `GET /api/shows` → `{ shows: [] }`; `POST /api/shows` → `{ show: {...} }`; `GET /api/studio` → studio dict with `id`; admin create → `{ studio: {...} }`, others → `{ ok: true }` / `GET users` → `{ studios_catalog, users }`; transcript-word create → 201 `{ ...word, session_id }`, list → `{ words: [] }`, delete → 204; topic create → 201, list → `{ topics: [] }`, delete → 204; `transcribe.csv`/`*/generate`/`youtube-import` → 503.
- **Runner:** `npx vitest run --project workers src/routers/<file>`; full `npm run test`; typecheck `npm run typecheck`.
- **Commit style:** Conventional Commits (`test:`).

---

### Task 1: `sessions.int.test.ts`

**Files:** Create `src/routers/sessions.int.test.ts`.

- [ ] **Step 1: Write the file**

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import app from '../index';
import { loginCookie, seedSession, seedShow, seedStudio, seedUser } from '../test/helpers';

const envWith = (o: Record<string, string>): typeof env =>
  ({ ...env, ...o }) as unknown as typeof env;

async function activeStudioId(): Promise<string> {
  const res = await app.request('/api/studio', { method: 'GET' }, { ...env });
  return ((await res.json()) as { id: string }).id;
}
async function seededSession(): Promise<string> {
  const studio = await seedStudio();
  const show = await seedShow({ studioId: studio });
  return seedSession({ showId: show });
}

describe('GET /api/sessions', () => {
  it('returns the active/archived shape', async () => {
    const res = await app.request('/api/sessions', { method: 'GET' }, { ...env });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active: unknown[]; archived: unknown[] };
    expect(Array.isArray(body.active)).toBe(true);
    expect(Array.isArray(body.archived)).toBe(true);
  });
});

describe('POST /api/sessions', () => {
  it('creates a session under the active studio’s show', async () => {
    const show = await seedShow({ studioId: await activeStudioId() });
    const res = await app.request(
      '/api/sessions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ show_id: show, episode: '007', frame_rate: 24 }),
      },
      { ...env },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBeTruthy();
  });

  it('422 on an invalid create body (missing show_id)', async () => {
    const res = await app.request(
      '/api/sessions',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ episode: '1' }),
      },
      { ...env },
    );
    expect(res.status).toBe(422);
  });
});

describe('session lifecycle (PUT / archive / restore / delete)', () => {
  it('PUT renames and updates the start offset', async () => {
    const session = await seededSession();
    const res = await app.request(
      `/api/sessions/${session}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Renamed', start_offset_frames: 5 }),
      },
      { ...env },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string; start_offset_frames: number };
    expect(body.title).toBe('Renamed');
    expect(body.start_offset_frames).toBe(5);
  });

  it('archive then restore toggles the flag', async () => {
    const session = await seededSession();
    const a = await app.request(`/api/sessions/${session}/archive`, { method: 'POST' }, { ...env });
    expect(a.status).toBe(200);
    expect((await a.json()) as { archived: boolean }).toMatchObject({ archived: true });
    const r = await app.request(`/api/sessions/${session}/restore`, { method: 'POST' }, { ...env });
    expect((await r.json()) as { archived: boolean }).toMatchObject({ archived: false });
  });

  it('DELETE hides the session', async () => {
    const session = await seededSession();
    const res = await app.request(`/api/sessions/${session}`, { method: 'DELETE' }, { ...env });
    expect(res.status).toBe(200);
    expect((await res.json()) as { hidden: boolean }).toMatchObject({ hidden: true });
  });

  it('youtube-import is 503', async () => {
    const session = await seededSession();
    const res = await app.request(
      `/api/sessions/${session}/youtube-import`,
      { method: 'POST' },
      { ...env },
    );
    expect(res.status).toBe(503);
  });
});

describe('tenancy', () => {
  it('404 on PUT for a logged-in non-member', async () => {
    const studioA = await seedStudio();
    const studioB = await seedStudio();
    const show = await seedShow({ studioId: studioB });
    const session = await seedSession({ showId: show });
    const cookie = await loginCookie(await seedUser({ studios: [studioA] }));
    const res = await app.request(
      `/api/sessions/${session}`,
      {
        method: 'PUT',
        headers: { Cookie: cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'x', start_offset_frames: 0 }),
      },
      envWith({ REQUIRE_LOGIN: '1' }),
    );
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run + typecheck**

Run: `npx vitest run --project workers src/routers/sessions.int.test.ts && npm run typecheck`
Expected: PASS. If `POST /api/sessions` 400s ("Show does not belong to the active team"), the active-studio resolution differs — confirm `activeStudioId()` returns the studio the anonymous effective resolver uses; adjust by seeding the show under that exact id (read `getEffectiveStudioForUser` in `src/db/profileAssembler.ts`/`d1.ts` if needed). Do not change production.

- [ ] **Step 3: Commit**

```bash
git add src/routers/sessions.int.test.ts
git commit -m "test: sessions endpoints (CRUD lifecycle, 503 youtube, tenancy 404)"
```

---

### Task 2: `shows-profile.int.test.ts`

**Files:** Create `src/routers/shows-profile.int.test.ts`.

- [ ] **Step 1: Write the file**

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import app from '../index';

async function activeStudioId(): Promise<string> {
  const res = await app.request('/api/studio', { method: 'GET' }, { ...env });
  return ((await res.json()) as { id: string }).id;
}

describe('GET /api/studio + /api/profile', () => {
  it('GET /api/studio returns a studio dict with an id', async () => {
    const res = await app.request('/api/studio', { method: 'GET' }, { ...env });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBeTruthy();
  });

  it('GET /api/profile returns the profile payload object', async () => {
    const res = await app.request('/api/profile', { method: 'GET' }, { ...env });
    expect(res.status).toBe(200);
    expect(typeof (await res.json())).toBe('object');
  });
});

describe('PUT /api/profile', () => {
  it('sets the active studio (anonymous)', async () => {
    const sid = await activeStudioId();
    const res = await app.request(
      '/api/profile',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ active_studio_id: sid }),
      },
      { ...env },
    );
    expect(res.status).toBe(200);
  });

  it('400 when active_studio_id is missing (anonymous)', async () => {
    const res = await app.request(
      '/api/profile',
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' },
      { ...env },
    );
    expect(res.status).toBe(400);
  });
});

describe('shows', () => {
  it('GET /api/shows returns a shows array for the active studio', async () => {
    const sid = await activeStudioId();
    const res = await app.request(
      `/api/shows?studio_id=${sid}`,
      { method: 'GET' },
      { ...env },
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(((await res.json()) as { shows: unknown[] }).shows)).toBe(true);
  });

  it('POST /api/shows creates a show under the active studio', async () => {
    const sid = await activeStudioId();
    const res = await app.request(
      '/api/shows',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ studio_id: sid, name: 'Sweep Show', show_code: 'SW' }),
      },
      { ...env },
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { show: { id: string } }).toHaveProperty('show.id');
  });

  it('422 on POST /api/shows with a missing name', async () => {
    const sid = await activeStudioId();
    const res = await app.request(
      '/api/shows',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ studio_id: sid }),
      },
      { ...env },
    );
    expect(res.status).toBe(422);
  });
});
```

- [ ] **Step 2: Run + typecheck**

Run: `npx vitest run --project workers src/routers/shows-profile.int.test.ts && npm run typecheck`
Expected: PASS. If `POST /api/shows` returns 400 ("Unknown studio id"), the active studio isn't `isKnownStudio` in that request — confirm `activeStudioId()` returns a builtin/known id (it should, since `/api/studio` resolves the effective studio). Reconcile against `src/routers/shows.ts` if a status differs.

- [ ] **Step 3: Commit**

```bash
git add src/routers/shows-profile.int.test.ts
git commit -m "test: shows + profile/studio endpoints (happy + 400/422 branches)"
```

---

### Task 3: `admin.int.test.ts`

**Files:** Create `src/routers/admin.int.test.ts`.

- [ ] **Step 1: Write the file**

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import app from '../index';
import { adminHeader, seedUser } from '../test/helpers';

const TOKEN = 'sweep-admin-token';
const envWith = (o: Record<string, string>): typeof env =>
  ({ ...env, ...o }) as unknown as typeof env;
const ADMIN_ENV = envWith({ ADMIN_TOKEN: TOKEN });
const H = { ...adminHeader(TOKEN), 'content-type': 'application/json' };

describe('admin auth', () => {
  it('401 with a wrong token', async () => {
    const res = await app.request(
      '/api/admin/users',
      { method: 'GET', headers: adminHeader('nope') },
      ADMIN_ENV,
    );
    expect(res.status).toBe(401);
  });

  it('GET /api/admin/users returns studios_catalog + users', async () => {
    const res = await app.request('/api/admin/users', { method: 'GET', headers: H }, ADMIN_ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { studios_catalog: unknown[]; users: unknown[] };
    expect(Array.isArray(body.studios_catalog)).toBe(true);
    expect(Array.isArray(body.users)).toBe(true);
  });
});

describe('admin studios', () => {
  it('creates then deletes a studio', async () => {
    const create = await app.request(
      '/api/admin/studios',
      { method: 'POST', headers: H, body: JSON.stringify({ id: 'sweep-team', display_name: 'Sweep' }) },
      ADMIN_ENV,
    );
    expect(create.status).toBe(200);
    expect((await create.json()) as { studio: { id: string } }).toMatchObject({
      studio: { id: 'sweep-team' },
    });
    const del = await app.request(
      '/api/admin/studios/sweep-team',
      { method: 'DELETE', headers: H },
      ADMIN_ENV,
    );
    expect(del.status).toBe(200);
    expect((await del.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });

  it('422 on an invalid studio id (too short)', async () => {
    const res = await app.request(
      '/api/admin/studios',
      { method: 'POST', headers: H, body: JSON.stringify({ id: 'a', display_name: 'X' }) },
      ADMIN_ENV,
    );
    expect(res.status).toBe(422);
  });
});

describe('admin user memberships + disable/enable', () => {
  it('adds and removes a membership for a known builtin studio', async () => {
    const user = await seedUser({});
    const add = await app.request(
      `/api/admin/users/${user}/memberships`,
      { method: 'POST', headers: H, body: JSON.stringify({ studio_id: 'test-studios' }) },
      ADMIN_ENV,
    );
    expect(add.status).toBe(200);
    const del = await app.request(
      `/api/admin/users/${user}/memberships/test-studios`,
      { method: 'DELETE', headers: H },
      ADMIN_ENV,
    );
    expect(del.status).toBe(200);
  });

  it('disable then enable a user', async () => {
    const user = await seedUser({});
    const d = await app.request(
      `/api/admin/users/${user}/disable`,
      { method: 'POST', headers: H },
      ADMIN_ENV,
    );
    expect(d.status).toBe(200);
    const e = await app.request(
      `/api/admin/users/${user}/enable`,
      { method: 'POST', headers: H },
      ADMIN_ENV,
    );
    expect(e.status).toBe(200);
  });

  it('404 disabling an unknown user', async () => {
    const res = await app.request(
      '/api/admin/users/no-such-user/disable',
      { method: 'POST', headers: H },
      ADMIN_ENV,
    );
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run + typecheck**

Run: `npx vitest run --project workers src/routers/admin.int.test.ts && npm run typecheck`
Expected: PASS. `test-studios` is a builtin studio (`BUILTIN_STUDIO_ORDER`), so `isKnownStudio` is true after `authContext`'s per-request `init()`. If membership add 400s ("Unknown team id"), confirm the builtin id against `src/studio.ts` and adjust.

- [ ] **Step 3: Commit**

```bash
git add src/routers/admin.int.test.ts
git commit -m "test: admin endpoints (users/studios/memberships/disable-enable + 401/404/422)"
```

---

### Task 4: `transcribe.int.test.ts`

**Files:** Create `src/routers/transcribe.int.test.ts`.

- [ ] **Step 1: Write the file**

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import app from '../index';
import { seedSession, seedShow, seedStudio } from '../test/helpers';

async function seededSession(): Promise<string> {
  const studio = await seedStudio();
  const show = await seedShow({ studioId: studio });
  return seedSession({ showId: show });
}
const J = { 'content-type': 'application/json' };

describe('unavailable endpoints (503)', () => {
  it('transcribe.csv, transcript-words/generate, topics/generate are 503', async () => {
    const s = await seededSession();
    for (const path of [
      `/api/sessions/${s}/transcribe.csv`,
      `/api/sessions/${s}/transcript-words/generate`,
      `/api/sessions/${s}/topics/generate`,
    ]) {
      const method = path.endsWith('.csv') ? 'GET' : 'POST';
      const res = await app.request(path, { method }, { ...env });
      expect(res.status).toBe(503);
    }
  });
});

describe('transcript-words CRUD', () => {
  it('create → list → patch → delete', async () => {
    const s = await seededSession();
    const create = await app.request(
      `/api/sessions/${s}/transcript-words`,
      { method: 'POST', headers: J, body: JSON.stringify({ speaker: 'Host', word: 'hello' }) },
      { ...env },
    );
    expect(create.status).toBe(201);
    const wordId = ((await create.json()) as { id: string }).id;

    const list = await app.request(
      `/api/sessions/${s}/transcript-words`,
      { method: 'GET' },
      { ...env },
    );
    expect(((await list.json()) as { words: unknown[] }).words.length).toBe(1);

    const patch = await app.request(
      `/api/sessions/${s}/transcript-words/${wordId}`,
      { method: 'PATCH', headers: J, body: JSON.stringify({ word: 'world' }) },
      { ...env },
    );
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { word: string }).word).toBe('world');

    const del = await app.request(
      `/api/sessions/${s}/transcript-words/${wordId}`,
      { method: 'DELETE' },
      { ...env },
    );
    expect(del.status).toBe(204);
  });

  it('404 patching an unknown word', async () => {
    const s = await seededSession();
    const res = await app.request(
      `/api/sessions/${s}/transcript-words/nope`,
      { method: 'PATCH', headers: J, body: JSON.stringify({ word: 'x' }) },
      { ...env },
    );
    expect(res.status).toBe(404);
  });
});

describe('topics CRUD', () => {
  it('create → list → patch → delete', async () => {
    const s = await seededSession();
    const create = await app.request(
      `/api/sessions/${s}/topics`,
      { method: 'POST', headers: J, body: JSON.stringify({ summary: 'Intro', topic_level: 1 }) },
      { ...env },
    );
    expect(create.status).toBe(201);
    const topicId = ((await create.json()) as { id: string }).id;

    const list = await app.request(`/api/sessions/${s}/topics`, { method: 'GET' }, { ...env });
    expect(((await list.json()) as { topics: unknown[] }).topics.length).toBe(1);

    const patch = await app.request(
      `/api/sessions/${s}/topics/${topicId}`,
      { method: 'PATCH', headers: J, body: JSON.stringify({ summary: 'Outro' }) },
      { ...env },
    );
    expect(patch.status).toBe(200);

    const del = await app.request(
      `/api/sessions/${s}/topics/${topicId}`,
      { method: 'DELETE' },
      { ...env },
    );
    expect(del.status).toBe(204);
  });

  it('404 deleting an unknown topic', async () => {
    const s = await seededSession();
    const res = await app.request(
      `/api/sessions/${s}/topics/nope`,
      { method: 'DELETE' },
      { ...env },
    );
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run + typecheck**

Run: `npx vitest run --project workers src/routers/transcribe.int.test.ts && npm run typecheck`
Expected: PASS. The create responses return the new row including `id` (transcript word: `{ ...word, session_id }`; topic: the topic row). If `id` is named differently, read the DO `insertTranscriptWord`/`insertTopic` return shape in `src/durable/transcriptStore.ts`/`topicStore.ts` and adjust.

- [ ] **Step 3: Commit**

```bash
git add src/routers/transcribe.int.test.ts
git commit -m "test: transcript-words + topics CRUD and 503 generate/csv endpoints"
```

---

### Task 5: Full-suite verification

**Files:** none.

- [ ] **Step 1: Run both projects + typecheck**

Run: `npm run test && npm run typecheck`
Expected: every file green across `unit` + `workers`; `tsc --noEmit` clean. Confirm the total rose from 121 by the sweep's new tests.

- [ ] **Step 2: Commit (only if reconciling edits were needed)**

```bash
git add -A && git commit -m "test: reconcile endpoint sweep to green" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**
- sessions (7 routes + 422 + tenancy 404) → Task 1.
- shows (2) + profile/studio (3) + 400/422 → Task 2.
- admin (7 routes + 401/404/422) → Task 3.
- transcribe/topics (11 routes incl. three 503s + 404 branches) → Task 4.
- Verification → Task 5.
- Deferred (companion, WebSocket routes) → not in any task, by design.

**Placeholder scan:** No TODO/TBD. Each task's Step 2 names the exact source file to reconcile against if a status/shape differs — complete code is provided for every case.

**Type consistency:** `envWith`, `activeStudioId`, `seededSession`, `adminHeader`/`seedUser`/`seedStudio`/`seedShow`/`seedSession`/`loginCookie` are used consistently; response casts (`{ id }`, `{ shows }`, `{ words }`, `{ topics }`, `{ ok }`, `{ studio }`) match the verified router shapes in Global Constraints.
