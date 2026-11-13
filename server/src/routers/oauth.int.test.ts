// MCP OAuth discovery and registration routes (custom session dashboards J2; design
// docs/design/custom-session-dashboards.md sections 4.2, 4.3 and 10.4; mcp-authorization;
// api-contract-freeze "MCP OAuth discovery and registration routes").
//
// With CUSTOM_DASHBOARDS_ENABLED on: the two metadata documents field for field, the registration
// rules and refusals, the per-address window (IPv4 alone, IPv6 by /64) and the live-client cap.
// With it off: every new path answers exactly what an unmounted path answers today, through the
// frontend bridge (GET, HEAD) or Hono's 404 (any other method), with and without a frontend.

import type { ServerResponse } from 'node:http';
import { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { wireApp } from '../app';
import type { AppEnv, Bindings } from '../appEnv';
import { anonApp, envWith } from '../test/harness';
import { testDb } from '../test/helpers';

const ON = { CUSTOM_DASHBOARDS_ENABLED: '1', TRUST_PROXY: '1' };
const ISSUER = 'https://example.com'; // the harness's PUBLIC_BASE_URL
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

const PRM = {
  resource: `${ISSUER}/mcp`,
  authorization_servers: [ISSUER],
  scopes_supported: ['dashboards'],
  bearer_methods_supported: ['header'],
  resource_name: 'AutoLogger',
};
const AS = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}/oauth/token`,
  registration_endpoint: `${ISSUER}/oauth/register`,
  revocation_endpoint: `${ISSUER}/oauth/revoke`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  revocation_endpoint_auth_methods_supported: ['none'],
  scopes_supported: ['dashboards'],
  authorization_response_iss_parameter_supported: true,
};

/** A JSON response body as a plain object. */
const bodyOf = async (res: Response) => (await res.json()) as Record<string, unknown>;

let ipCounter = 0;
/** A fresh IPv4 address per call, so tests don't share a window. */
const freshIp = () => {
  ipCounter += 1;
  return `198.51.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
};

function register(body: unknown, ip: string, env: Bindings = envWith(ON), raw?: string) {
  return anonApp.request(
    '/oauth/register',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: raw ?? JSON.stringify(body),
    },
    env,
  );
}

const clientRows = () =>
  testDb().all<Record<string, unknown>>(
    'SELECT id, client_name, redirect_uris_json, registered_from, created_at_utc, last_authorized_at_utc FROM mcp_clients ORDER BY created_at_utc, id',
  );

describe('discovery metadata with the flag on (design 4.2)', () => {
  it.each(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'])(
    'GET %s answers the PRM document exactly',
    async (path) => {
      const res = await anonApp.request(path, {}, envWith(ON));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await bodyOf(res)).toStrictEqual(PRM);
    },
  );

  it('GET /.well-known/oauth-authorization-server answers the AS document exactly', async () => {
    const res = await anonApp.request('/.well-known/oauth-authorization-server', {}, envWith(ON));
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toStrictEqual(AS);
  });

  it('builds every URL from PUBLIC_BASE_URL without its trailing slash', async () => {
    const env = envWith({ ...ON, PUBLIC_BASE_URL: 'https://logs.example.net/' });
    const prm = await bodyOf(
      await anonApp.request('/.well-known/oauth-protected-resource', {}, env),
    );
    expect(prm.resource).toBe('https://logs.example.net/mcp');
    expect(prm.authorization_servers).toEqual(['https://logs.example.net']);
    const as = await bodyOf(
      await anonApp.request('/.well-known/oauth-authorization-server', {}, env),
    );
    expect(as.issuer).toBe('https://logs.example.net');
    expect(as.registration_endpoint).toBe('https://logs.example.net/oauth/register');
  });

  it('needs no cookie and ignores a Bearer', async () => {
    const res = await anonApp.request(
      '/.well-known/oauth-protected-resource/mcp',
      { headers: { authorization: 'Bearer alm_whatever' } },
      envWith(ON),
    );
    expect(res.status).toBe(200);
  });
});

describe('POST /oauth/register with the flag on (design 4.3)', () => {
  it('registers a public client: 201, the client information, no secret, no-store', async () => {
    const ip = freshIp();
    const res = await register(
      {
        client_name: 'Claude',
        redirect_uris: [CALLBACK, 'http://127.0.0.1:33418/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        logo_uri: 'https://evil.example/logo.png',
      },
      ip,
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const body = await bodyOf(res);
    expect(Object.keys(body).sort()).toEqual(
      [
        'client_id',
        'client_id_issued_at',
        'client_name',
        'grant_types',
        'redirect_uris',
        'response_types',
        'token_endpoint_auth_method',
      ].sort(),
    );
    expect(body.client_id).toMatch(/^alc_[A-Za-z0-9_-]{22}$/);
    expect(body).toMatchObject({
      client_name: 'Claude',
      redirect_uris: [CALLBACK, 'http://127.0.0.1:33418/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
    expect(Number.isInteger(body.client_id_issued_at)).toBe(true);
    const rows = await clientRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: body.client_id,
      client_name: 'Claude',
      registered_from: ip,
      last_authorized_at_utc: null,
    });
    expect(JSON.parse(String(rows[0]?.redirect_uris_json))).toEqual(body.redirect_uris);
    expect(Math.floor(Date.parse(String(rows[0]?.created_at_utc)) / 1000)).toBe(
      body.client_id_issued_at,
    );
  });

  it('echoes application_type when given', async () => {
    const res = await register(
      {
        client_name: 'Claude Code',
        redirect_uris: ['http://localhost/cb'],
        application_type: 'native',
      },
      freshIp(),
    );
    expect(res.status).toBe(201);
    expect((await bodyOf(res)).application_type).toBe('native');
  });

  it.each([
    [
      'an http non-loopback redirect',
      { client_name: 'x', redirect_uris: ['http://evil.example/cb'] },
    ],
    ['a fragment', { client_name: 'x', redirect_uris: [`${CALLBACK}#f`] }],
    ['no redirect URIs', { client_name: 'x', redirect_uris: [] }],
    ['six redirect URIs', { client_name: 'x', redirect_uris: Array(6).fill(CALLBACK) }],
    ['a custom scheme', { client_name: 'x', redirect_uris: ['myapp://cb'] }],
  ])('%s: 400 invalid_redirect_uri, nothing stored', async (_l, body) => {
    const res = await register(body, freshIp());
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const json = await bodyOf(res);
    expect(Object.keys(json).sort()).toEqual(['error', 'error_description']);
    expect(json.error).toBe('invalid_redirect_uri');
    expect(await clientRows()).toEqual([]);
  });

  it.each([
    ['no client_name', { redirect_uris: [CALLBACK] }],
    ['a 101-character name', { client_name: 'n'.repeat(101), redirect_uris: [CALLBACK] }],
    ['a control character in the name', { client_name: 'a\u0007b', redirect_uris: [CALLBACK] }],
    ['NUL in the name', { client_name: 'a\u0000b', redirect_uris: [CALLBACK] }],
    [
      'a confidential client',
      {
        client_name: 'x',
        redirect_uris: [CALLBACK],
        token_endpoint_auth_method: 'client_secret_basic',
      },
    ],
    [
      'a token response type',
      { client_name: 'x', redirect_uris: [CALLBACK], response_types: ['token'] },
    ],
    [
      'an unknown grant type',
      {
        client_name: 'x',
        redirect_uris: [CALLBACK],
        grant_types: ['authorization_code', 'password'],
      },
    ],
    ['a JSON array body', [{ client_name: 'x', redirect_uris: [CALLBACK] }]],
  ])('%s: 400 invalid_client_metadata, nothing stored', async (_l, body) => {
    const res = await register(body, freshIp());
    expect(res.status).toBe(400);
    expect((await bodyOf(res)).error).toBe('invalid_client_metadata');
    expect(await clientRows()).toEqual([]);
  });

  it('a body that is not JSON, or is over 64 KiB, is 400 invalid_client_metadata', async () => {
    const bad = await register(undefined, freshIp(), envWith(ON), '{not json');
    expect(bad.status).toBe(400);
    expect((await bodyOf(bad)).error).toBe('invalid_client_metadata');
    const big = JSON.stringify({
      client_name: 'x',
      redirect_uris: [CALLBACK],
      pad: 'p'.repeat(65_536),
    });
    const huge = await register(undefined, freshIp(), envWith(ON), big);
    expect(huge.status).toBe(400);
    expect((await bodyOf(huge)).error).toBe('invalid_client_metadata');
    expect(await clientRows()).toEqual([]);
  });

  it('the 11th registration in an hour from one IPv4 address gets 429; another address does not', async () => {
    const ip = freshIp();
    const ok = { client_name: 'Claude', redirect_uris: [CALLBACK] };
    for (let i = 0; i < 10; i++) expect((await register(ok, ip)).status).toBe(201);
    const res = await register(ok, ip);
    expect(res.status).toBe(429);
    const seconds = Number(res.headers.get('retry-after'));
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(seconds).toBeLessThanOrEqual(3600);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await bodyOf(res)).toEqual({ detail: `Rate limit exceeded; retry in ${seconds} s.` });
    expect(await clientRows()).toHaveLength(10);
    expect((await register(ok, freshIp())).status).toBe(201);
  });

  it('two addresses in one IPv6 /64 share a window: the 11th between them gets 429', async () => {
    const ok = { client_name: 'Claude', redirect_uris: [CALLBACK] };
    for (let i = 0; i < 5; i++) {
      expect((await register(ok, '2001:db8:aa:bb::1')).status).toBe(201);
      expect((await register(ok, '2001:db8:aa:bb:ffff:1:2:3')).status).toBe(201);
    }
    expect((await register(ok, '2001:db8:aa:bb::99')).status).toBe(429);
    // Another /64 has its own window.
    expect((await register(ok, '2001:db8:aa:bc::1')).status).toBe(201);
    const sources = new Set((await clientRows()).map((r) => r.registered_from));
    expect(sources).toEqual(new Set(['2001:db8:aa:bb::/64', '2001:db8:aa:bc::/64']));
  });

  it('a refused registration still counts towards the window', async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) {
      expect((await register({ client_name: 'x', redirect_uris: [] }, ip)).status).toBe(400);
    }
    expect((await register({ client_name: 'x', redirect_uris: [CALLBACK] }, ip)).status).toBe(429);
  });

  it('a new window starts after the hour', async () => {
    const ip = freshIp();
    let now = Date.parse('2026-11-13T10:00:00.000Z');
    const clock = { now: () => now };
    const env = envWith(ON, { clock });
    // The store reads its own clock, so swap in one built on this test's clock.
    const { PostgresMcpOAuthStore } = await import('@autologger/storage');
    const store = new PostgresMcpOAuthStore(
      env.ports.catalog as unknown as ConstructorParameters<typeof PostgresMcpOAuthStore>[0],
      clock,
    );
    const timed = envWith(ON, { clock, mcpOAuth: store });
    const ok = { client_name: 'Claude', redirect_uris: [CALLBACK] };
    for (let i = 0; i < 10; i++) expect((await register(ok, ip, timed)).status).toBe(201);
    now += 59 * 60_000;
    const late = await register(ok, ip, timed);
    expect(late.status).toBe(429);
    expect(late.headers.get('retry-after')).toBe('60');
    now += 60_000;
    expect((await register(ok, ip, timed)).status).toBe(201);
  });

  it('past 10,000 live clients registration answers 429 and stores nothing', async () => {
    await testDb().run(
      `INSERT INTO mcp_clients (id, client_name, redirect_uris_json, registered_from, created_at_utc)
       SELECT 'alc_seed' || g, 'seed', '[]', 'seed', '2026-11-13T00:00:00.000Z'
         FROM generate_series(1, 9999) g`,
    );
    const ok = { client_name: 'Claude', redirect_uris: [CALLBACK] };
    expect((await register(ok, freshIp())).status).toBe(201);
    const res = await register(ok, freshIp());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeNull();
    expect(await bodyOf(res)).toEqual({ detail: 'Too many registered clients; try again later.' });
    const n = await testDb().first<{ n: number }>('SELECT count(*)::int AS n FROM mcp_clients');
    expect(n?.n).toBe(10_000);
  });
});

// ── Flag off: nothing changes (design 10.4) ──────────────────────────────────────────────────

const upgradeStub = (() => async (c: { text(b: string, s: number): Response }) =>
  c.text('WebSocket unavailable in HTTP tests', 426)) as unknown as UpgradeWebSocket;

function fakeOutgoing(): ServerResponse {
  return { headersSent: false, writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse;
}

const NEW_PATHS = [
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
  '/oauth/register',
];
/** Unmounted look-alikes: what the new paths answered before J2 is what these answer now. */
const CONTROL_PATHS = ['/.well-known/not-a-route', '/oauth/not-a-route'];
const OFF_VALUES = [{}, { CUSTOM_DASHBOARDS_ENABLED: '0' }, { CUSTOM_DASHBOARDS_ENABLED: 'off' }];

async function snapshot(res: Response) {
  return {
    status: res.status,
    headers: [...res.headers.entries()].sort(),
    body: await res.text(),
  };
}

describe('with the flag off every new path answers as an unmounted path does (design 10.4)', () => {
  const handle = vi.fn(async (_i: unknown, outgoing: ServerResponse) => {
    (outgoing as unknown as { headersSent: boolean }).headersSent = true;
  });
  const bridged = wireApp(new Hono<AppEnv>(), upgradeStub, { frontend: { handle } });
  afterEach(() => handle.mockClear());

  it.each(OFF_VALUES)('GET and HEAD reach the frontend bridge (flag %j)', async (flag) => {
    for (const path of [...NEW_PATHS, ...CONTROL_PATHS]) {
      for (const method of ['GET', 'HEAD']) {
        handle.mockClear();
        const env = {
          ...envWith(flag),
          incoming: {},
          outgoing: fakeOutgoing(),
        } as unknown as Bindings;
        const res = await bridged.request(path, { method }, env);
        expect(handle, `${method} ${path}`).toHaveBeenCalledTimes(1);
        expect(res.headers.get('x-hono-already-sent'), `${method} ${path}`).toBe('true');
        expect(res.headers.get('cache-control'), `${method} ${path}`).toBeNull();
      }
    }
  });

  it.each(OFF_VALUES)(
    'every method answers byte for byte what an unmounted path answers, API-only (flag %j)',
    async (flag) => {
      const env = envWith(flag);
      const control = await snapshot(
        await anonApp.request('/oauth/not-a-route', { method: 'POST' }, env),
      );
      expect(control.status).toBe(404);
      for (const path of NEW_PATHS) {
        for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
          const res = await anonApp.request(
            path,
            {
              method,
              headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.1' },
              ...(method === 'GET' || method === 'HEAD'
                ? {}
                : { body: JSON.stringify({ client_name: 'x', redirect_uris: [CALLBACK] }) }),
            },
            env,
          );
          const got = await snapshot(res);
          const want = method === 'HEAD' ? { ...control, body: '' } : control;
          expect(got, `${method} ${path}`).toEqual(want);
        }
      }
      // Nothing was registered or counted.
      expect(await clientRows()).toEqual([]);
      const w = await testDb().first<{ n: number }>(
        'SELECT count(*)::int AS n FROM mcp_rate_windows',
      );
      expect(w?.n).toBe(0);
    },
  );
});
