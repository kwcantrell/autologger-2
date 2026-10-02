// API_TOKEN scope (containerize-split-images tasks 2.1/2.2, design D10;
// api-contract-freeze "API_TOKEN authenticates only the Companion surface").
// Pins the behaviour of a token-only request (valid API_TOKEN bearer, no session
// cookie). Originally characterized against pre-change code (commit 956114c);
// the non-companion expectations now assert the token is inert.

import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type ServerType, serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wireApp } from '../app';
import type { AppEnv } from '../appEnv';
import { anonApp, envWith } from '../test/harness';
import { seededSession } from '../test/helpers';

const TOKEN = 'test-api-token';
const bearer: Record<string, string> = { Authorization: `Bearer ${TOKEN}` };
const withLogin = envWith({ REQUIRE_LOGIN: '1' });
const openLogin = envWith({ REQUIRE_LOGIN: '0' });

describe('token-only requests, REQUIRE_LOGIN=1', () => {
  it('GET /api/companion/state is 200 with the frozen state shape', async () => {
    const res = await anonApp.request('/api/companion/state', { headers: bearer }, withLogin);
    expect(res.status).toBe(200);
    expect(Object.keys((await res.json()) as object).sort()).toEqual([
      'active_session_id',
      'connected_clients',
      'last_command',
      'session',
    ]);
  });

  it('GET /api/sessions is 401 "Login required." (token no longer opens other API routes)', async () => {
    const res = await anonApp.request('/api/sessions', { headers: bearer }, withLogin);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: 'Login required.' });
  });

  it('anonymous GET /api/sessions is 401 "Login required." (baseline)', async () => {
    const res = await anonApp.request('/api/sessions', {}, withLogin);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: 'Login required.' });
  });
});

describe('/auth/* and /api/admin/* with an API_TOKEN bearer', () => {
  it('POST /auth/logout is handled identically with and without the token', async () => {
    for (const e of [withLogin, openLogin]) {
      const anon = await anonApp.request('/auth/logout', { method: 'POST' }, e);
      const tok = await anonApp.request('/auth/logout', { method: 'POST', headers: bearer }, e);
      expect(tok.status).toBe(anon.status);
      expect(await tok.text()).toBe(await anon.text());
    }
  });

  it('/api/admin/users: API_TOKEN is not the admin token (401); ADMIN_TOKEN still works', async () => {
    const e = envWith({ REQUIRE_LOGIN: '1', ADMIN_TOKEN: 'right' });
    const asApi = await anonApp.request('/api/admin/users', { headers: bearer }, e);
    expect(asApi.status).toBe(401);
    const asAdmin = await anonApp.request(
      '/api/admin/users',
      { headers: { Authorization: 'Bearer right' } },
      e,
    );
    expect(asAdmin.status).toBe(200);
  });
});

describe('AI v2 dashboard with an API_TOKEN bearer', () => {
  const dash = (id: string) => `/api/sessions/${id}/ai/v2/dashboard`;
  const aiEnv = (login: '0' | '1') =>
    envWith({ AI_V2_ENABLED: '1', HOST: '127.0.0.1', REQUIRE_LOGIN: login });

  it('REQUIRE_LOGIN=1: token-only is 401 "Login required." like anonymous', async () => {
    const s = (await seededSession()).sessionId;
    const res = await anonApp.request(dash(s), { headers: bearer }, aiEnv('1'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ detail: 'Login required.' });
  });

  it('REQUIRE_LOGIN=1: anonymous is 401', async () => {
    const s = (await seededSession()).sessionId;
    const res = await anonApp.request(dash(s), {}, aiEnv('1'));
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
    const s = (await seededSession()).sessionId;
    expect(await attempt(s, 'companion', {})).toBe(401);
  });

  it('token-only companion-role upgrade is refused exactly as for anonymous (401)', async () => {
    const s = (await seededSession()).sessionId;
    expect(await attempt(s, 'companion', bearer)).toBe(401);
  });

  it('token-only browser-role upgrade is refused (401)', async () => {
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
    expect(await get('/api/sessions')).toBe(401);
    expect(await get('/%61pi/sessions')).toBe(401);
    expect(await get('/a%70i/sessions')).toBe(401);
    expect(await get('/%61pi/companion/state')).toBe(401);
    expect(await get('/%61pi/companion/state', bearer)).toBe(200);
    expect(await get('/api/%63ompanion/state', bearer)).toBe(200);
    expect(await get('/%61pi/sessions', bearer)).toBe(401);
    expect(await get('/%61pi/profile')).toBe(200);
  });
});
