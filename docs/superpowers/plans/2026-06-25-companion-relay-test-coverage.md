# Companion Relay Test Coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cover the 8 `/api/companion/*` routes (happy + branches) and prove the end-to-end WebSocket command relay (spike-gated).

**Architecture:** A `setCompanionPresence` KV helper drives `primarySession`. One HTTP integration file (`app.request`) and one WebSocket file (`SELF.fetch` upgrade). No production-code changes.

**Tech Stack:** Vitest 2.1.9 + `@cloudflare/vitest-pool-workers` (`SELF`, `env`), Hono, Durable Objects.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-25-companion-relay-test-coverage-design.md`.
- **Branch:** `test/companion-relay` (already checked out).
- **No production-code changes.** Characterize current behavior — including the global/unscoped `primarySession` (the audit's finding).
- **Helpers:** existing `seedStudio/seedShow/seedSession`, plus the new `setCompanionPresence`. `seedShow` already seeds a `cam` BUTTON category (`SEED_CATEGORY_ID`).
- **Presence model:** KV key `companion:presence:<client_id>`, metadata `{ session_id, visible, is_playing, updated }`, fresh ≤ 15s; `primarySession` prefers visible then freshest.
- **Verified shapes** (from `companion.ts`): presence → `{ ok:true }`; state → `{ connected_clients, active_session_id, session|null, last_command|null }`; log → enriched event (200), **409** no active session, **400** unknown category; transport → `{ ok, is_rolling, current_take }`; command → `{ ok, command_id, active_session_id }`; categories → `{ session_id, show_id, show_name, show_code, categories }` (**409** if the show has no categories); `commands/wait?timeout=0` → `{ commands: [] }`; ack → `{ ok:true }` on id match else `{ ok:false }`. The `/ws` route (`events.ts:104`) delegates to `getSessionDO(...).fetch(req)`; the DO broadcasts `{ type:'command', command }` to all `getWebSockets()`.
- **Runner:** `npx vitest run --project workers src/routers/<file>`; full `npm run test`; typecheck `npm run typecheck`.
- **Commit style:** Conventional Commits (`test:`).

---

### Task 1: `setCompanionPresence` helper

**Files:** Modify `src/test/helpers.ts`.

**Interfaces:** Produces `setCompanionPresence(clientId: string, sessionId: string, opts?: { visible?: boolean; is_playing?: boolean }): Promise<void>`.

- [ ] **Step 1: Append the helper to `src/test/helpers.ts`**

```ts
/** Write a companion presence KV entry so primarySession() resolves to sessionId. */
export async function setCompanionPresence(
  clientId: string,
  sessionId: string,
  opts: { visible?: boolean; is_playing?: boolean } = {},
): Promise<void> {
  await env.AUTH.put(`companion:presence:${clientId}`, '1', {
    expirationTtl: 60,
    metadata: {
      session_id: sessionId,
      visible: opts.visible ?? true,
      is_playing: opts.is_playing ?? false,
      updated: Date.now(),
    },
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean (`env` is already imported in `helpers.ts`).

- [ ] **Step 3: Commit**

```bash
git add src/test/helpers.ts
git commit -m "test: setCompanionPresence KV helper for companion relay tests"
```

---

### Task 2: `companion.int.test.ts` (HTTP routes)

**Files:** Create `src/routers/companion.int.test.ts`.

- [ ] **Step 1: Write the file**

```ts
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import app from '../index';
import { seedSession, seedShow, seedStudio, setCompanionPresence } from '../test/helpers';

const J = { 'content-type': 'application/json' };

async function seededSession(categoriesJson?: string): Promise<string> {
  const studio = await seedStudio();
  const show = await seedShow({ studioId: studio, categoriesJson });
  return seedSession({ showId: show });
}
async function state(): Promise<Record<string, unknown>> {
  const res = await app.request('/api/companion/state', { method: 'GET' }, { ...env });
  return (await res.json()) as Record<string, unknown>;
}

describe('presence + state', () => {
  it('a registered presence surfaces in state', async () => {
    const s = await seededSession();
    await setCompanionPresence('c1', s, { visible: true });
    const body = await state();
    expect(Number(body.connected_clients)).toBeGreaterThanOrEqual(1);
    expect(body.active_session_id).toBe(s);
    expect((body.session as { id: string }).id).toBe(s);
    expect(body.last_command).toBeNull();
  });

  it('POST presence with closing:true removes it', async () => {
    const s = await seededSession();
    await setCompanionPresence('c1', s);
    await app.request(
      '/api/companion/presence',
      { method: 'POST', headers: J, body: JSON.stringify({ client_id: 'c1', closing: true }) },
      { ...env },
    );
    expect((await state()).active_session_id).toBeNull();
  });
});

describe('log', () => {
  it('logs an event by category_id for the active session', async () => {
    const s = await seededSession();
    await setCompanionPresence('c1', s);
    const res = await app.request(
      '/api/companion/log',
      { method: 'POST', headers: J, body: JSON.stringify({ category_id: 'cam', message: 'Cut' }) },
      { ...env },
    );
    expect(res.status).toBe(200);
  });

  it('409 when there is no active session', async () => {
    const res = await app.request(
      '/api/companion/log',
      { method: 'POST', headers: J, body: JSON.stringify({ category_id: 'cam', message: 'x' }) },
      { ...env },
    );
    expect(res.status).toBe(409);
  });

  it('400 on an unknown category', async () => {
    const s = await seededSession();
    await setCompanionPresence('c1', s);
    const res = await app.request(
      '/api/companion/log',
      { method: 'POST', headers: J, body: JSON.stringify({ category_id: 'nope', message: 'x' }) },
      { ...env },
    );
    expect(res.status).toBe(400);
  });
});

describe('transport', () => {
  it('start then stop flips is_rolling', async () => {
    const s = await seededSession();
    await setCompanionPresence('c1', s);
    const start = await app.request(
      '/api/companion/transport',
      { method: 'POST', headers: J, body: JSON.stringify({ action: 'start' }) },
      { ...env },
    );
    expect((await start.json()) as Record<string, unknown>).toMatchObject({
      ok: true,
      is_rolling: true,
      current_take: 1,
    });
    const stop = await app.request(
      '/api/companion/transport',
      { method: 'POST', headers: J, body: JSON.stringify({ action: 'stop' }) },
      { ...env },
    );
    expect(((await stop.json()) as { is_rolling: boolean }).is_rolling).toBe(false);
  });
});

describe('command + ack', () => {
  it('records last_command and acks by id', async () => {
    const s = await seededSession();
    await setCompanionPresence('c1', s);
    const cmd = await app.request(
      '/api/companion/command',
      { method: 'POST', headers: J, body: JSON.stringify({ type: 'record-start' }) },
      { ...env },
    );
    const commandId = ((await cmd.json()) as { command_id: string }).command_id;
    expect(commandId).toBeTruthy();
    expect(((await state()).last_command as { id: string }).id).toBe(commandId);

    const ack = await app.request(
      `/api/companion/commands/${commandId}/ack`,
      { method: 'POST', headers: J, body: JSON.stringify({ client_id: 'c1', ok: true }) },
      { ...env },
    );
    expect((await ack.json()) as { ok: boolean }).toMatchObject({ ok: true });

    const bad = await app.request(
      '/api/companion/commands/wrong-id/ack',
      { method: 'POST', headers: J, body: JSON.stringify({ client_id: 'c1', ok: true }) },
      { ...env },
    );
    expect((await bad.json()) as { ok: boolean }).toMatchObject({ ok: false });
  });
});

describe('categories + commands/wait', () => {
  it('returns the active session show categories', async () => {
    const s = await seededSession();
    await setCompanionPresence('c1', s);
    const res = await app.request('/api/companion/categories', { method: 'GET' }, { ...env });
    expect(res.status).toBe(200);
    expect(Array.isArray(((await res.json()) as { categories: unknown[] }).categories)).toBe(true);
  });

  it('commands/wait with timeout=0 returns empty immediately', async () => {
    const res = await app.request(
      '/api/companion/commands/wait?timeout=0',
      { method: 'GET' },
      { ...env },
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { commands: unknown[] }).toMatchObject({ commands: [] });
  });
});

describe('primarySession is global / unscoped (current behavior)', () => {
  it('selects the visibly-fresher session regardless of studio', async () => {
    const showA = await seedShow({ studioId: await seedStudio() });
    const sA = await seedSession({ showId: showA });
    const showB = await seedShow({ studioId: await seedStudio() });
    const sB = await seedSession({ showId: showB });
    await setCompanionPresence('cA', sA, { visible: false });
    await setCompanionPresence('cB', sB, { visible: true });
    expect((await state()).active_session_id).toBe(sB);
  });
});
```

- [ ] **Step 2: Run + typecheck**

Run: `npx vitest run --project workers src/routers/companion.int.test.ts && npm run typecheck`
Expected: PASS. Reconcile notes if a case fails:
- **categories**: if `GET /api/companion/categories` returns 409 for a `cam`-category show, `getSessionShowCategories` may key off a different field — read `src/db/d1.ts`/`sessionIndexStore.ts` and adjust (or seed a richer show). Conversely a no-category 409 case can be added with `seededSession('[]')` if that returns null categories.
- **log by label**: not asserted here (category id is robust); if you add a by-label case, first `GET /api/companion/categories` and log by the returned `categories[0].label`.
- **KV metadata visibility**: if `state` shows `connected_clients: 0` right after `setCompanionPresence`, Miniflare isn't surfacing `list` metadata — switch the helper to also store the meta JSON in the value body and have the test not depend on it (test-only change).

- [ ] **Step 3: Commit**

```bash
git add src/routers/companion.int.test.ts
git commit -m "test: companion HTTP routes (presence/state/log/transport/command/ack/categories + global-selection characterization)"
```

---

### Task 3: `companion-ws.int.test.ts` (WebSocket relay — SPIKE-GATED)

**Files:** Create `src/routers/companion-ws.int.test.ts`.

**If the spike (Step 2) cannot be made green**, apply the spec's fallback: delete this file, add a `command` test to Task 2 asserting `POST /api/companion/command` → 200 + `state.last_command.id` set (delivery uncovered), and note the limitation in the commit. STOP and report before deciding.

- [ ] **Step 1: Write the WS relay spike**

```ts
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { seedSession, seedShow, seedStudio, setCompanionPresence } from '../test/helpers';

async function seededSession(): Promise<string> {
  const show = await seedShow({ studioId: await seedStudio() });
  return seedSession({ showId: show });
}
const ORIGIN = 'https://example.com';

function nextMessage(ws: WebSocket, ms = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws message timeout')), ms);
    ws.addEventListener('message', (e) => {
      clearTimeout(t);
      resolve(typeof e.data === 'string' ? e.data : '');
    });
  });
}

describe('companion WebSocket relay', () => {
  it('delivers a posted command over the session WebSocket', async () => {
    const s = await seededSession();
    const wsRes = await SELF.fetch(`${ORIGIN}/api/sessions/${s}/ws`, {
      headers: { Upgrade: 'websocket' },
    });
    expect(wsRes.status).toBe(101);
    const ws = wsRes.webSocket;
    expect(ws).toBeTruthy();
    ws!.accept();
    const got = nextMessage(ws!);

    await setCompanionPresence('c1', s);
    const cmd = await SELF.fetch(`${ORIGIN}/api/companion/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'record-start' }),
    });
    expect(cmd.status).toBe(200);

    expect(JSON.parse(await got)).toMatchObject({ type: 'command', command: 'record-start' });
    ws!.close();
  });
});
```

- [ ] **Step 2: Run the spike (GATE)**

Run: `npx vitest run --project workers src/routers/companion-ws.int.test.ts`
Expected: PASS — the socket receives the broadcast command. If `SELF.fetch` does not return `status 101` / a `webSocket`, or the message never arrives, the WS harness isn't viable here: STOP, apply the fallback above, and record the decision.

- [ ] **Step 3: Add the webSocketMessage round-trip (only if Step 2 passed)**

Append to the `describe`:

```ts
  it('re-broadcasts a command sent BY a connected client', async () => {
    const s = await seededSession();
    const open = async () => {
      const r = await SELF.fetch(`${ORIGIN}/api/sessions/${s}/ws`, {
        headers: { Upgrade: 'websocket' },
      });
      const w = r.webSocket as WebSocket;
      w.accept();
      return w;
    };
    const sender = await open();
    const receiver = await open();
    const got = nextMessage(receiver);
    sender.send(JSON.stringify({ type: 'command', command: 'play-toggle' }));
    expect(JSON.parse(await got)).toMatchObject({ type: 'command', command: 'play-toggle' });
    sender.close();
    receiver.close();
  });
```

- [ ] **Step 4: Run + typecheck + commit**

Run: `npx vitest run --project workers src/routers/companion-ws.int.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

```bash
git add src/routers/companion-ws.int.test.ts
git commit -m "test: companion WebSocket command relay (delivery + client re-broadcast)"
```

---

### Task 4: Full-suite verification

**Files:** none.

- [ ] **Step 1: Run both projects + typecheck**

Run: `npm run test && npm run typecheck`
Expected: every file green across `unit` + `workers`; `tsc --noEmit` clean. Confirm the total rose from 148.

- [ ] **Step 2: Commit (only if reconciling edits were needed)**

```bash
git add -A && git commit -m "test: reconcile companion relay suite to green" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**
- `setCompanionPresence` helper → Task 1.
- presence/state, log (+409/+400), transport, command/ack, categories, commands/wait, global-selection characterization → Task 2.
- WS relay spike (delivery) + client re-broadcast, with HTTP-only fallback → Task 3.
- Verification → Task 4.
- Deferred (long-poll waiting, hibernation, multi-socket fan-out) → not in any task, by design.

**Placeholder scan:** No TODO/TBD. Task 2/3 Step 2 reconcile notes name exact files/contracts; complete code is provided for every case.

**Type consistency:** `setCompanionPresence`, `seededSession`, `state()`, `nextMessage`, and the existing `seedStudio/seedShow/seedSession` are used consistently; `SELF`/`env` from `cloudflare:test`; response casts match the verified companion shapes in Global Constraints.
