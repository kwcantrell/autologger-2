// API_TOKEN scope characterization (containerize-split-images task 2.1).
// Pins the CURRENT behaviour of a token-only request (valid API_TOKEN bearer,
// no session cookie) across the surfaces design D10 will re-scope. Written
// against unmodified code; task 2.2 rewrites the non-companion expectations.

import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type ServerType, serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wireApp } from '../app';
import type { AppEnv } from '../appEnv';
import { app, envWith } from '../test/harness';
import { seededSession } from '../test/helpers';

const TOKEN = 'test-api-token';
const bearer: Record<string, string> = { Authorization: `Bearer ${TOKEN}` };
const withLogin = envWith({ REQUIRE_LOGIN: '1' });
const openLogin = envWith({ REQUIRE_LOGIN: '0' });

describe('token-only requests, REQUIRE_LOGIN=1 (characterization)', () => {
  it('GET /api/companion/state is 200', async () => {
    const res = await app.request('/api/companion/state', { headers: bearer }, withLogin);
    expect(res.status).toBe(200);
  });

  it('GET /api/sessions is 200', async () => {
    const res = await app.request('/api/sessions', { headers: bearer }, withLogin);
    expect(res.status).toBe(200);
  });

  it('anonymous GET /api/sessions is 401 "Login required." (baseline)', async () => {
    const res = await app.request('/api/sessions', {}, withLogin);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: 'Login required.' });
  });
});

describe('/auth/* and /api/admin/* with an API_TOKEN bearer', () => {
  it('POST /auth/logout is handled identically with and without the token', async () => {
    for (const e of [withLogin, openLogin]) {
      const anon = await app.request('/auth/logout', { method: 'POST' }, e);
      const tok = await app.request('/auth/logout', { method: 'POST', headers: bearer }, e);
      expect(tok.status).toBe(anon.status);
      expect(await tok.text()).toBe(await anon.text());
    }
  });

  it('/api/admin/users: API_TOKEN is not the admin token (401); ADMIN_TOKEN still works', async () => {
    const e = envWith({ REQUIRE_LOGIN: '1', ADMIN_TOKEN: 'right' });
    const asApi = await app.request('/api/admin/users', { headers: bearer }, e);
    expect(asApi.status).toBe(401);
    const asAdmin = await app.request(
      '/api/admin/users',
      { headers: { Authorization: 'Bearer right' } },
      e,
    );
    expect(asAdmin.status).toBe(200);
  });
});

describe('AI v2 dashboard with an API_TOKEN bearer (characterization)', () => {
  const dash = (id: string) => `/api/sessions/${id}/ai/v2/dashboard`;
  const aiEnv = (login: '0' | '1') =>
    envWith({ AI_V2_ENABLED: '1', HOST: '127.0.0.1', REQUIRE_LOGIN: login });

  it('REQUIRE_LOGIN=0: token-only is refused 404 "Session not found"', async () => {
    const s = seededSession().sessionId;
    const res = await app.request(dash(s), { headers: bearer }, aiEnv('0'));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { detail: string }).detail).toBe('Session not found');
  });

  it('REQUIRE_LOGIN=0: an anonymous request is served (200)', async () => {
    const s = seededSession().sessionId;
    const res = await app.request(dash(s), {}, aiEnv('0'));
    expect(res.status).toBe(200);
  });

  it('REQUIRE_LOGIN=1: token-only passes the login gate and is refused 404', async () => {
    const s = seededSession().sessionId;
    const res = await app.request(dash(s), { headers: bearer }, aiEnv('1'));
    expect(res.status).toBe(404);
  });

  it('REQUIRE_LOGIN=1: anonymous is 401', async () => {
    const s = seededSession().sessionId;
    const res = await app.request(dash(s), {}, aiEnv('1'));
    expect(res.status).toBe(401);
  });
});

describe('session WebSocket upgrade with an API_TOKEN bearer, REQUIRE_LOGIN=1', () => {
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
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
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
    const s = seededSession().sessionId;
    expect(await attempt(s, 'companion', {})).toBe(401);
  });

  it('token-only companion-role upgrade succeeds (101)', async () => {
    const s = seededSession().sessionId;
    expect(await attempt(s, 'companion', bearer)).toBe(101);
  });
});
