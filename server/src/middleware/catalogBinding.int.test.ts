// catalog-roles task 5.2 (design D9, D10, D12; core-ports-architecture "Every catalog call is
// bound to a caller"): the request catalog is resolved as `system:auth-resolve`, handed to routes
// bound to the signed-in user, unbound with no user, and every system call site names its reason.
// A recording `GatedCatalog` (a `CatalogRoot` wrapper) logs each statement with its binding.

import { KvStore, PostgresCatalogDb } from '@autologger/storage';
import { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wireApp } from '../app';
import type { AppEnv } from '../appEnv';
import { GatedCatalog } from '../test/gatedCatalog';
import { anonApp, defaultUser, env, envWith, resetTestEnv } from '../test/harness';
import { seedCompanionDevice, seededSession, seedMemberStudio } from '../test/helpers';

const REGISTRY = /FROM studio_definitions ORDER BY/;
const USER_READ = /^SELECT \* FROM users WHERE id = \? AND disabled_at_utc IS NULL$/;

function recording() {
  const gated = new GatedCatalog(env.ports.catalog);
  const kv = new KvStore(gated.bindSystem('kv'), env.ports.clock);
  return { gated, e: envWith({}, { catalog: gated, kv }) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the request catalog is bound (catalog-roles D9)', () => {
  it('a signed-in GET /api/profile resolves as system and runs every route statement as its user', async () => {
    const { id, cookie } = await defaultUser();
    const { gated, e } = recording();
    const res = await anonApp.request('/api/profile', { headers: { cookie } }, e);
    expect(res.status).toBe(200);
    const log = gated.bindings;
    const userRead = log.findIndex((s) => USER_READ.test(s.sql));
    expect(userRead).toBeGreaterThan(0);
    // The middleware: the registry and the user read as auth-resolve, the KV lookup as kv.
    for (const s of log.slice(0, userRead + 1)) {
      expect(s.binding, s.sql).toBe(/FROM kv/.test(s.sql) ? 'system:kv' : 'system:auth-resolve');
    }
    expect(log.slice(0, userRead).some((s) => REGISTRY.test(s.sql))).toBe(true);
    expect(log.slice(0, userRead).some((s) => /FROM kv/.test(s.sql))).toBe(true);
    // The route.
    const route = log.slice(userRead + 1);
    expect(route.length).toBeGreaterThan(0);
    for (const s of route) expect(s.binding, s.sql).toBe(`user:${id}`);
  });

  it('a signed-out GET /api/profile is 200 with the same body and sends no route statement', async () => {
    const plain = await anonApp.request('/api/profile', {}, env);
    const { gated, e } = recording();
    const res = await anonApp.request('/api/profile', {}, e);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(await plain.json());
    expect(gated.bindings.length).toBeGreaterThan(0);
    for (const s of gated.bindings) {
      expect(s).toEqual({ binding: 'system:auth-resolve', sql: expect.stringMatching(REGISTRY) });
    }
  });

  it('a route that queries the request catalog with no user answers 500, logs CatalogUnboundError and sends nothing', async () => {
    const stub = (() => async () =>
      new Response(null, { status: 426 })) as unknown as UpgradeWebSocket;
    const app = wireApp(new Hono<AppEnv>(), stub);
    // POST: wireApp's GET catch-all, registered first, would answer a GET here with 404.
    app.post('/api/admin/__unbound', async (c) =>
      c.json(await c.get('catalog').auth.authGetUserById('nobody')),
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { gated, e } = recording();
    const res = await app.request('/api/admin/__unbound', { method: 'POST' }, e);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ detail: 'Internal Server Error' });
    const logged = errors.mock.calls.find((c) => c[0] === 'unhandled error');
    expect((logged?.[1] as Error | undefined)?.name).toBe('CatalogUnboundError');
    for (const s of gated.bindings) expect(s.binding).toBe('system:auth-resolve');
    expect(gated.bindings.some((s) => /FROM users/.test(s.sql))).toBe(false);
  });
});

describe('system call sites name their reason (catalog-roles D10)', () => {
  const routeStatements = (g: GatedCatalog) =>
    g.bindings.filter((s) => s.binding !== 'system:kv' && !(s.binding === 'system:auth-resolve'));

  it('/api/admin/* with ADMIN_TOKEN runs as system:support-plane', async () => {
    const { gated, e } = recording();
    const res = await anonApp.request(
      '/api/admin/users',
      { headers: { authorization: 'Bearer test-admin-token' } },
      e,
    );
    expect(res.status).toBe(200);
    const route = routeStatements(gated);
    expect(route.length).toBeGreaterThan(0);
    for (const s of route) expect(s.binding, s.sql).toBe('system:support-plane');
  });

  // companion-devices D9 category 3: a device call runs as its user, not as a system task.
  it("a device-token GET /api/companion/state runs every route statement as the device's user", async () => {
    const { sessionId } = await seededSession();
    await env.ports.presence.upsert('c-bind', {
      user_id: (await defaultUser()).id,
      session_id: sessionId,
      visible: true,
      is_playing: false,
      updated: env.ports.clock.now(),
    });
    const { gated, e } = recording();
    const res = await anonApp.request(
      '/api/companion/state',
      { headers: (await seedCompanionDevice()).bearer },
      e,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { active_session_id: string }).active_session_id).toBe(sessionId);
    const route = routeStatements(gated);
    expect(route.length).toBeGreaterThan(0);
    const id = (await defaultUser()).id;
    for (const s of route) expect(s.binding, s.sql).toBe(`user:${id}`);
  });

  it('the team-create and invite transactions run as system:team-create / system:team-invite', async () => {
    const { cookie } = await defaultUser();
    const { gated, e } = recording();
    const created = await anonApp.request(
      '/api/teams',
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'bound-team', display_name: 'Bound Team' }),
      },
      e,
    );
    expect(created.status).toBeLessThan(300);
    const inserts = gated.bindings.filter((s) => /INSERT INTO studio_definitions/.test(s.sql));
    expect(inserts.length).toBeGreaterThan(0);
    for (const s of inserts) expect(s.binding).toBe('system:team-create');
    const counted = gated.bindings.filter((s) => /role = 'owner'/.test(s.sql));
    for (const s of counted) expect(s.binding).toBe('system:team-create');

    const team = await seedMemberStudio();
    const invite = recording();
    const res = await anonApp.request(
      `/api/teams/${team}/invites`,
      {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nobody-yet@example.com' }),
      },
      invite.e,
    );
    expect(res.status).toBe(200);
    const writes = invite.gated.bindings.filter((s) => /INSERT INTO team_invites/.test(s.sql));
    expect(writes.length).toBe(1);
    expect(writes[0]?.binding).toBe('system:team-invite');
    const lookups = invite.gated.bindings.filter((s) => s.sql === 'SELECT * FROM users');
    expect(lookups.length).toBeGreaterThan(0);
    for (const s of lookups) expect(s.binding).toBe('system:team-invite');
  });

  // session-tables D2/D8: the mirror and its `session-mirror` binding are retired.
  // session-content-policies D4 (task 3.2, owner 2026-10-03): the session adapter binds each call
  // to its caller, so the composition root makes no `session-hub` binding.
  it('the composition root builds KV on system:kv and makes no session-hub binding', async () => {
    const spy = vi.spyOn(PostgresCatalogDb.prototype, 'bindSystem');
    await resetTestEnv();
    const reasons = spy.mock.calls.map((c) => c[0]);
    expect(reasons).toContain('kv');
    expect(reasons).not.toContain('session-hub');
    expect(reasons).not.toContain('session-mirror');
  });
});
