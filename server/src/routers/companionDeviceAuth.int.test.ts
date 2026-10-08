// Companion device-token scope (companion-devices D2, task 4.2; api-contract-freeze "Companion
// device tokens authenticate only the Companion surface" and "Login is required on every API
// route"). Converted from the API_TOKEN scope matrix (containerize-split-images D10; D9 category
// 1): the same scope assertions, with a per-device token in place of the shared API_TOKEN, plus the
// device cases (revoked, disabled user, idle expiry, the retired API_TOKEN, cookie + Bearer, audit
// lines).

import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type ServerType, serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { wireApp } from '../app';
import type { AppEnv } from '../appEnv';
import { hashCompanionDeviceToken } from '../auth/companionDeviceToken';
import { anonApp, defaultUser, env, envWith } from '../test/harness';
import {
  catalogFor,
  loginCookie,
  seedCompanionDevice,
  seededSession,
  seedUser,
  setCompanionPresence,
  testDb,
} from '../test/helpers';

const withLogin = envWith({});
const LOGIN_REQUIRED = { detail: 'Login required.' };
const DAY = 86_400_000;
const J = { 'content-type': 'application/json' };

async function lastUsed(deviceId: string): Promise<string | null> {
  const row = await testDb().first<{ last_used_at_utc: string | null }>(
    'SELECT last_used_at_utc FROM companion_devices WHERE id = ?',
    deviceId,
  );
  return row?.last_used_at_utc ?? null;
}

function state(headers: Record<string, string>, e = withLogin) {
  return anonApp.request('/api/companion/state', { headers }, e);
}

describe('device-token requests (no cookie)', () => {
  it('GET /api/companion/state is 200 with the frozen state shape', async () => {
    const { bearer } = await seedCompanionDevice();
    const res = await state(bearer);
    expect(res.status).toBe(200);
    expect(Object.keys((await res.json()) as object).sort()).toEqual([
      'active_session_id',
      'connected_clients',
      'last_command',
      'session',
    ]);
  });

  it("passes on the five Companion routes, answered for the device's user", async () => {
    const { bearer } = await seedCompanionDevice();
    const s = (await seededSession()).sessionId;
    await setCompanionPresence('c1', s);
    const H = { ...J, ...bearer };
    const st = await state(bearer);
    expect(st.status).toBe(200);
    expect(((await st.json()) as { active_session_id: string }).active_session_id).toBe(s);
    const cats = await anonApp.request('/api/companion/categories', { headers: bearer }, withLogin);
    expect(cats.status).toBe(200);
    const log = await anonApp.request(
      '/api/companion/log',
      { method: 'POST', headers: H, body: JSON.stringify({ category_id: 'cam', message: 'Cut' }) },
      withLogin,
    );
    expect(log.status).toBe(200);
    const transport = await anonApp.request(
      '/api/companion/transport',
      { method: 'POST', headers: H, body: JSON.stringify({ action: 'start' }) },
      withLogin,
    );
    expect(transport.status).toBe(200);
    const command = await anonApp.request(
      '/api/companion/command',
      { method: 'POST', headers: H, body: JSON.stringify({ type: 'play-toggle' }) },
      withLogin,
    );
    expect(command.status).toBe(200);
  });

  it('GET /api/sessions is 401 "Login required." (a device token opens no other API route)', async () => {
    const { bearer } = await seedCompanionDevice();
    const res = await anonApp.request('/api/sessions', { headers: bearer }, withLogin);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(LOGIN_REQUIRED);
  });

  it('GET /api/companion-devices is 401 "Login required." with only a device token', async () => {
    const { bearer } = await seedCompanionDevice();
    const res = await anonApp.request('/api/companion-devices', { headers: bearer }, withLogin);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(LOGIN_REQUIRED);
  });

  it('anonymous GET /api/sessions is 401 "Login required." (baseline)', async () => {
    const res = await anonApp.request('/api/sessions', {}, withLogin);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(LOGIN_REQUIRED);
  });

  it('records the use as last_used_at_utc', async () => {
    const { id, bearer } = await seedCompanionDevice();
    expect(await lastUsed(id)).toBeNull();
    expect((await state(bearer)).status).toBe(200);
    await vi.waitFor(async () => expect(await lastUsed(id)).not.toBeNull());
  });
});

describe('refused device tokens get 401 "Login required." and no handler runs', () => {
  it('an unknown token, and a bare or empty Bearer', async () => {
    await seedCompanionDevice();
    for (const headers of [
      { Authorization: 'Bearer ald_not-a-device' },
      { Authorization: 'Bearer ' },
      { Authorization: 'Bearer' },
    ]) {
      const res = await state(headers);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual(LOGIN_REQUIRED);
    }
  });

  it('a deleted device', async () => {
    const { id, bearer } = await seedCompanionDevice();
    expect((await state(bearer)).status).toBe(200);
    expect(await env.ports.companionDevices.delete((await defaultUser()).id, id)).toBe(true);
    const res = await state(bearer);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(LOGIN_REQUIRED);
  });

  it('a disabled user', async () => {
    const u = await seedUser();
    const { bearer } = await seedCompanionDevice(u);
    expect((await state(bearer)).status).toBe(200);
    await catalogFor().auth.authSetUserDisabled(u, true);
    const res = await state(bearer);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(LOGIN_REQUIRED);
  });

  it('the retired API_TOKEN value, even when the env still sets it', async () => {
    await seedCompanionDevice();
    const e = envWith({ API_TOKEN: 'test-api-token' });
    const res = await state({ Authorization: 'Bearer test-api-token' }, e);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(LOGIN_REQUIRED);
  });

  it('a log post with a refused token writes nothing', async () => {
    const { bearer } = await seedCompanionDevice();
    const s = (await seededSession()).sessionId;
    await setCompanionPresence('c1', s);
    const res = await anonApp.request(
      '/api/companion/log',
      {
        method: 'POST',
        headers: { ...J, Authorization: 'Bearer ald_unknown' },
        body: JSON.stringify({ category_id: 'cam', message: 'Cut' }),
      },
      withLogin,
    );
    expect(res.status).toBe(401);
    // The live device still sees no event in the session.
    const ok = await anonApp.request('/api/companion/state', { headers: bearer }, withLogin);
    const body = (await ok.json()) as { session: { logged_event_count: number } };
    expect(body.session.logged_event_count).toBe(0);
  });
});

describe('idle expiry (90 days)', () => {
  it('a device never used for 90 days gets 401; one used 80 days ago passes and is renewed', async () => {
    const stale = await seedCompanionDevice();
    await testDb().run(
      'UPDATE companion_devices SET created_at_utc = ? WHERE id = ?',
      new Date(Date.now() - 90 * DAY - 1000).toISOString(),
      stale.id,
    );
    const res = await state(stale.bearer);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(LOGIN_REQUIRED);
    expect(await lastUsed(stale.id)).toBeNull();

    const live = await seedCompanionDevice((await defaultUser()).id);
    const eighty = new Date(Date.now() - 80 * DAY).toISOString();
    await testDb().run(
      'UPDATE companion_devices SET created_at_utc = ?, last_used_at_utc = ? WHERE id = ?',
      new Date(Date.now() - 120 * DAY).toISOString(),
      eighty,
      live.id,
    );
    expect((await state(live.bearer)).status).toBe(200);
    await vi.waitFor(async () => expect(await lastUsed(live.id)).not.toBe(eighty));
    expect(Date.parse((await lastUsed(live.id)) as string)).toBeGreaterThan(Date.now() - DAY);
  });
});

describe('a Bearer on /api/companion/* decides the caller, and the cookie is ignored', () => {
  it('a valid cookie with an unknown Bearer is 401', async () => {
    const { cookie } = await defaultUser();
    const res = await state({ cookie, Authorization: 'Bearer ald_unknown' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(LOGIN_REQUIRED);
  });

  it("a valid cookie with a live device's Bearer runs as the device's user", async () => {
    const s = (await seededSession()).sessionId;
    await setCompanionPresence('c1', s); // the default user's presence
    const other = await seedUser();
    const cookie = await loginCookie(other);
    const { bearer } = await seedCompanionDevice(); // the default user's device
    const asCookie = await state({ cookie });
    expect(((await asCookie.json()) as { active_session_id: unknown }).active_session_id).toBe(
      null,
    );
    const both = await state({ cookie, ...bearer });
    expect(both.status).toBe(200);
    expect(((await both.json()) as { active_session_id: unknown }).active_session_id).toBe(s);
  });

  it('with no Bearer the cookie authenticates, as before', async () => {
    const { cookie } = await defaultUser();
    expect((await state({ cookie })).status).toBe(200);
  });

  it('outside /api/companion/ a Bearer is ignored and the cookie still authenticates', async () => {
    const { cookie } = await defaultUser();
    const res = await anonApp.request(
      '/api/sessions',
      { headers: { cookie, Authorization: 'Bearer ald_unknown' } },
      withLogin,
    );
    expect(res.status).toBe(200);
  });
});

describe('audit lines', () => {
  afterEach(() => vi.restoreAllMocks());

  it("one line on a device's first use, with the user and device ids and never the token", async () => {
    const lines: string[] = [];
    const record =
      (level: string) =>
      (...args: unknown[]) => {
        lines.push(
          `${level} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`,
        );
      };
    for (const level of ['info', 'warn', 'log', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation(record(level));
    }
    const userId = (await defaultUser()).id;
    const { id, token, bearer } = await seedCompanionDevice();
    expect((await state(bearer)).status).toBe(200);
    await vi.waitFor(async () => expect(await lastUsed(id)).not.toBeNull());
    expect((await state(bearer)).status).toBe(200);
    const firstUse = () => lines.filter((l) => l.includes(id) && l.includes(userId));
    await vi.waitFor(() => expect(firstUse()).toHaveLength(1));
    expect(firstUse()[0]).toMatch(/^info /);
    expect(firstUse()[0]).toMatch(/first use/i);
    const hash = hashCompanionDeviceToken(token);
    for (const l of lines) {
      expect(l).not.toContain(token);
      expect(l).not.toContain(hash);
    }
  });
});

describe('/auth/* and /api/admin/* with a device token', () => {
  it('POST /auth/logout is handled identically with and without the token', async () => {
    const { bearer } = await seedCompanionDevice();
    const anon = await anonApp.request('/auth/logout', { method: 'POST' }, withLogin);
    const tok = await anonApp.request(
      '/auth/logout',
      { method: 'POST', headers: bearer },
      withLogin,
    );
    expect(tok.status).toBe(anon.status);
    expect(await tok.text()).toBe(await anon.text());
  });

  it('/api/admin/users: a device token is not the admin token (401); ADMIN_TOKEN still works', async () => {
    const { bearer } = await seedCompanionDevice();
    const e = envWith({ ADMIN_TOKEN: 'right' });
    const asDevice = await anonApp.request('/api/admin/users', { headers: bearer }, e);
    expect(asDevice.status).toBe(401);
    const asAdmin = await anonApp.request(
      '/api/admin/users',
      { headers: { Authorization: 'Bearer right' } },
      e,
    );
    expect(asAdmin.status).toBe(200);
  });
});

describe('AI v2 dashboard with a device token', () => {
  const dash = (id: string) => `/api/sessions/${id}/ai/v2/dashboard`;
  const aiEnv = () => envWith({ AI_V2_ENABLED: '1', HOST: '127.0.0.1' });

  it('device-token-only is 401 "Login required." like anonymous', async () => {
    const { bearer } = await seedCompanionDevice();
    const s = (await seededSession()).sessionId;
    const res = await anonApp.request(dash(s), { headers: bearer }, aiEnv());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(LOGIN_REQUIRED);
  });

  it('anonymous is 401', async () => {
    const s = (await seededSession()).sessionId;
    const res = await anonApp.request(dash(s), {}, aiEnv());
    expect(res.status).toBe(401);
  });
});

describe('session WebSocket upgrade with a device token', () => {
  let server: ServerType;
  let port: number;

  beforeAll(async () => {
    const a = new Hono<AppEnv>();
    const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: a });
    wireApp(a, upgradeWebSocket, { bindings: withLogin });
    port = await new Promise<number>((resolve) => {
      server = serve({ fetch: a.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) =>
        resolve(info.port),
      );
      injectWebSocket(server);
    });
  });
  afterAll(() => server.close());

  /** Raw upgrade attempt: resolves 101 on upgrade, else the HTTP status. */
  function attempt(sessionId: string, role: string, headers: Record<string, string>) {
    return new Promise<number>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        path: `/api/sessions/${sessionId}/ws?role=${role}`,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          // RFC 6455's sample nonce, computed so it reads as no secret.
          'Sec-WebSocket-Key': Buffer.from('the sample nonce').toString('base64'),
          ...headers,
        },
      });
      req.on('upgrade', (_res, socket) => {
        socket.destroy();
        resolve(101);
      });
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('anonymous companion-role upgrade is refused 401 (baseline)', async () => {
    const s = (await seededSession()).sessionId;
    expect(await attempt(s, 'companion', {})).toBe(401);
  });

  it('device-token-only companion-role upgrade is refused exactly as for anonymous (401)', async () => {
    const { bearer } = await seedCompanionDevice();
    const s = (await seededSession()).sessionId;
    expect(await attempt(s, 'companion', bearer)).toBe(401);
  });

  it('device-token-only browser-role upgrade is refused (401)', async () => {
    const { bearer } = await seedCompanionDevice();
    const s = (await seededSession()).sessionId;
    expect(await attempt(s, 'browser', bearer)).toBe(401);
  });

  /** Raw HTTP GET over the socket; the request-target is sent byte for byte. */
  function get(path: string, headers: Record<string, string> = {}) {
    return new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, headers });
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
  }

  // gate-decoded-path 3.2: the same encoded spellings over a real socket, as the router forwards them.
  it('encoded /api spellings get the literal path’s answer over real HTTP', async () => {
    const { bearer } = await seedCompanionDevice();
    expect(await get('/api/sessions')).toBe(401);
    expect(await get('/%61pi/sessions')).toBe(401);
    expect(await get('/a%70i/sessions')).toBe(401);
    expect(await get('/%61pi/companion/state')).toBe(401);
    expect(await get('/%61pi/companion/state', bearer)).toBe(200);
    expect(await get('/api/%63ompanion/state', bearer)).toBe(200);
    expect(await get('/%61pi/companion/state', { Authorization: 'Bearer ald_unknown' })).toBe(401);
    expect(await get('/%61pi/sessions', bearer)).toBe(401);
    expect(await get('/%61pi/profile')).toBe(200);
  });
});
