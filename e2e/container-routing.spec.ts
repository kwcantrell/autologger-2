import net from 'node:net';
import os from 'node:os';
import { expect, test } from '@playwright/test';
import {
  backNetwork,
  COMPARED_HEADERS,
  composeProject,
  docker,
  dockerOk,
  rawHttp,
  rawSocket,
  requireEnv,
  routerUrl,
  seedContainerSession,
  singleProcessUrl,
  summarize,
  upgradeRequest,
} from './containerHarness';

// container-routing.spec.ts (containerize-split-images, task 5.4)
//
// Runs ONLY in the `container` Playwright project (playwright.config.ts), against a live compose
// stack reached through the router (ROUTER_URL) plus a single-process reference server built
// from the same commit (SINGLE_PROCESS_URL). Covers every container-deployment router scenario,
// the api-contract-freeze token/traversal scenarios and the topology scenarios. Every case is a
// separate test whose title names the request, so a routing regression names the request that
// diverged (task 5.5). Use `npm run e2e:container`.
//
// SEAM: the differential's reference is the EXTERNAL consumer -- the single-process server's own
// behaviour -- not a hand-written expectation table. The router is right when it matches that.

const ROUTER = () => routerUrl();
const REFERENCE = () => singleProcessUrl();
const API_TOKEN = () => requireEnv('E2E_API_TOKEN');

test.setTimeout(60_000);

// -------------------------------------------------------------------------------------------
// Shell served by web
// -------------------------------------------------------------------------------------------
test.describe('shell served by web', () => {
  for (const path of ['/', '/teams', '/sessions/abc', '/sessions/a%2Fb', '/admin/users']) {
    test(`GET ${path} -> 200 shell HTML, no Set-Cookie`, async () => {
      const r = await rawHttp(ROUTER(), 'GET', path);
      expect(r.status, `GET ${path}`).toBe(200);
      expect(r.headers['content-type'] ?? '', `GET ${path}`).toContain('text/html');
      expect(r.setCookie, `GET ${path} Set-Cookie`).toEqual([]);
    });
  }
});

// -------------------------------------------------------------------------------------------
// Differential parity with the single-process server (also web-frontend-platform "Same shell
// from both topologies")
// -------------------------------------------------------------------------------------------
test.describe('differential parity with the single-process server', () => {
  test.beforeAll(() => {
    // Never silently pass without the reference: requireEnv throws a clear message.
    requireEnv('SINGLE_PROCESS_URL');
  });

  interface Row {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  }

  async function assetPaths(base: string): Promise<{ js: string }> {
    const shell = (await rawHttp(base, 'GET', '/teams')).body.toString('utf8');
    const m = shell.match(/\/_next\/static\/[^"'\s\\]+\.js/);
    if (!m) throw new Error(`no /_next/static/*.js chunk in the shell served by ${base}`);
    return { js: m[0] };
  }

  const rows: Row[] = [];
  for (const path of ['/', '/teams', '/sessions/abc', '/admin/users', '/admin/logs']) {
    rows.push({ method: 'GET', path }, { method: 'HEAD', path });
  }
  rows.push(
    { method: 'GET', path: '/teams', headers: { RSC: '1' } }, // RSC flight request
    { method: 'GET', path: '/static/fonts/inter-latin-var.woff2' },
    { method: 'GET', path: '/static/fonts/league-gothic-latin.woff2' },
    { method: 'GET', path: '/_next/image?url=/static/logo-autologger-app.png&w=64&q=75' },
    { method: 'GET', path: '/sessions' },
    { method: 'GET', path: '/sessions/a/b' },
    { method: 'GET', path: '/sessions/a%2F' },
    { method: 'GET', path: '/teams/' },
    { method: 'HEAD', path: '/teams/' },
    { method: 'GET', path: '/nope' },
    {
      method: 'POST',
      path: '/sessions/abc',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    },
    { method: 'GET', path: '/api/does-not-exist' },
    { method: 'GET', path: '/API/profile' },
    { method: 'GET', path: '/%61pi/profile' },
  );

  for (const row of rows) {
    const title = `${row.method} ${row.path}${row.headers?.RSC ? ' (RSC flight)' : ''}`;
    test(`${title} matches the single-process server`, async () => {
      const [viaRouter, viaReference] = await Promise.all([
        rawHttp(ROUTER(), row.method, row.path, row.headers, row.body),
        rawHttp(REFERENCE(), row.method, row.path, row.headers, row.body),
      ]);
      const a = summarize(viaRouter);
      const b = summarize(viaReference);
      // Compared as one object so a divergence prints the request and every differing field.
      expect({ request: title, ...a }, `${title}: router vs single-process`).toEqual({
        request: title,
        ...b,
      });
    });
  }

  test('GET /_next/static/<chunk> (asset referenced by each shell) matches', async () => {
    const [r, s] = await Promise.all([assetPaths(ROUTER()), assetPaths(REFERENCE())]);
    const [a, b] = await Promise.all([
      rawHttp(ROUTER(), 'GET', r.js),
      rawHttp(REFERENCE(), 'GET', s.js),
    ]);
    expect(a.status).toBe(200);
    expect(summarize(a), 'GET /_next/static/<chunk>').toEqual(summarize(b));
  });

  test('every compared header name is part of the summary (guard against a silent no-op)', () => {
    expect(COMPARED_HEADERS.length).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------------------------------
// Stray upgrade writes nothing
// -------------------------------------------------------------------------------------------
test.describe('stray upgrade writes nothing', () => {
  const strays: { path: string; upgrade?: string }[] = [
    { path: '/teams' },
    { path: '/teams', upgrade: 'h2c' },
    { path: '/' },
    { path: '/auth/x' },
    { path: '/%61pi/sessions/x/ws' },
  ];
  for (const s of strays) {
    test(`Upgrade (${s.upgrade ?? 'websocket'}) on ${s.path} -> closed, 0 bytes, no status line`, async () => {
      const { received, closedByPeer } = await rawSocket(
        ROUTER(),
        upgradeRequest(s.path, {}, s.upgrade),
      );
      expect(received.toString('latin1'), `Upgrade ${s.path}`).toBe('');
      expect(closedByPeer, `Upgrade ${s.path}: peer closes the connection`).toBe(true);
    });
  }

  test('control: Upgrade on /api/sessions/x/ws IS proxied (a status line comes back)', async () => {
    // Guards against a vacuous pass: the raw-socket helper does see responses.
    const { received } = await rawSocket(
      ROUTER(),
      upgradeRequest('/api/sessions/x/ws?role=browser'),
    );
    expect(received.toString('latin1')).toMatch(/^HTTP\/1\.1 \d{3}/);
  });

  test('the single-process reference closes a stray /teams upgrade with nothing written', async () => {
    const { received } = await rawSocket(REFERENCE(), upgradeRequest('/teams'));
    expect(received.toString('latin1')).toBe('');
  });
});

// -------------------------------------------------------------------------------------------
// Traversal cannot reach a non-Companion route
// -------------------------------------------------------------------------------------------
test.describe('traversal cannot reach a non-Companion route', () => {
  const traversal = [
    '/api/companion/%2e%2e/sessions/x',
    '/api/companion/.%2E/admin/users',
    '/api/companion/state/..%2Fsessions',
    '/api/companion/%2e%2e/sessions',
    '/api/companion/%2E%2e/sessions',
    '/api/companion/../sessions',
    '/api/companion/./state',
    '/api//companion/state',
    '/api/sessions%2Fx',
    '/api/companion/state%5Cx',
    '/auth/google%2fstart',
  ];

  let cookie = '';
  test.beforeAll(() => {
    cookie = seedContainerSession('traversal', [
      { studioId: 'test-studios', role: 'admin' },
    ]).cookie;
  });

  async function serverOwn404(
    method: string,
  ): Promise<{ status: number; type: string; body: string }> {
    // The server's own notFound() as the router delivers it for an ordinary non-inventory,
    // api-bound request (trailing slash -> api).
    const r = await rawHttp(ROUTER(), method, '/teams/');
    return { status: r.status, type: r.headers['content-type'] ?? '', body: r.body.toString() };
  }

  for (const path of traversal) {
    test(`GET ${path} with a valid API_TOKEN -> the server's own 404`, async () => {
      const own = await serverOwn404('GET');
      expect(own.status).toBe(404);
      const r = await rawHttp(ROUTER(), 'GET', path, { authorization: `Bearer ${API_TOKEN()}` });
      expect({
        request: `GET ${path}`,
        status: r.status,
        type: r.headers['content-type'],
        body: r.body.toString(),
      }).toEqual({
        request: `GET ${path}`,
        status: 404,
        type: own.type,
        body: own.body,
      });
    });

    test(`GET ${path} with a valid session cookie -> the server's own 404`, async () => {
      const own = await serverOwn404('GET');
      const r = await rawHttp(ROUTER(), 'GET', path, { cookie });
      expect({ request: `GET ${path}`, status: r.status, body: r.body.toString() }).toEqual({
        request: `GET ${path}`,
        status: 404,
        body: own.body,
      });
    });
  }

  test('POST /api/companion/%2e%2e/sessions (non-GET) -> 404 as well', async () => {
    const r = await rawHttp(
      ROUTER(),
      'POST',
      '/api/companion/%2e%2e/sessions',
      { cookie, 'content-type': 'application/json' },
      '{}',
    );
    expect(r.status).toBe(404);
  });

  test('control: the same cookie DOES open GET /api/sessions (the cookie is valid)', async () => {
    const r = await rawHttp(ROUTER(), 'GET', '/api/sessions', { cookie });
    expect(r.status).toBe(200);
  });

  test('a query string cannot smuggle a dot-segment past the rule (?x=/../)', async () => {
    const r = await rawHttp(ROUTER(), 'GET', '/api/profile?x=/../y');
    expect(r.status).toBe(200);
  });
});

// -------------------------------------------------------------------------------------------
// Companion token scope through the router (api-contract-freeze)
// -------------------------------------------------------------------------------------------
test.describe('API_TOKEN scope through the router', () => {
  const bearer = () => ({ authorization: `Bearer ${API_TOKEN()}` });

  test('GET /api/companion/state with the token -> 200 state shape', async () => {
    const r = await rawHttp(ROUTER(), 'GET', '/api/companion/state', bearer());
    expect(r.status).toBe(200);
    expect(typeof JSON.parse(r.body.toString())).toBe('object');
  });

  test('GET /api/sessions with the token -> 401 Login required.', async () => {
    const r = await rawHttp(ROUTER(), 'GET', '/api/sessions', bearer());
    expect(r.status).toBe(401);
    expect(JSON.parse(r.body.toString())).toEqual({ detail: 'Login required.' });
  });

  test('GET /api/admin/users with the API_TOKEN -> handled exactly as anonymous', async () => {
    const [withToken, anon] = await Promise.all([
      rawHttp(ROUTER(), 'GET', '/api/admin/users', bearer()),
      rawHttp(ROUTER(), 'GET', '/api/admin/users'),
    ]);
    expect(withToken.status).toBe(anon.status);
    expect(withToken.body.toString()).toBe(anon.body.toString());
  });

  test('WS /api/sessions/x/ws?role=companion with the token is refused exactly as unauthenticated', async () => {
    const path = '/api/sessions/x/ws?role=companion';
    const withToken = await rawSocket(ROUTER(), upgradeRequest(path, bearer()));
    const anon = await rawSocket(ROUTER(), upgradeRequest(path));
    const head = (b: Buffer) =>
      b
        .toString('latin1')
        .split('\r\n\r\n')[0]
        ?.split('\r\n')
        .filter((l) => !/^date:/i.test(l))
        .join('\n');
    expect(head(withToken.received)).toMatch(/^HTTP\/1\.1 401/);
    expect(head(withToken.received)).toBe(head(anon.received));
  });
});

// -------------------------------------------------------------------------------------------
// Session WebSocket upgrades through the router (signed-in browser)
// -------------------------------------------------------------------------------------------
test.describe('session WebSocket through the router', () => {
  test('a signed-in browser opens /api/sessions/<id>/ws?role=browser; live frames arrive', async ({
    browser,
    baseURL,
  }) => {
    const seeded = seedContainerSession('ws', [{ studioId: 'test-studios', role: 'admin' }]);
    const context = await browser.newContext();
    try {
      const url = new URL(baseURL as string);
      await context.addCookies([
        {
          name: 'autologger_sid',
          value: seeded.token,
          domain: url.hostname,
          path: '/',
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ]);
      const page = await context.newPage();
      await page.goto('/teams');

      const created = await context.request.post('/api/sessions', {
        data: {
          show_id: 'show-autolog-test',
          title: `container ws ${Date.now()}`,
          frame_rate: 24,
          start_offset_frames: 0,
        },
      });
      expect(created.status(), await created.text()).toBe(200);
      const { id } = (await created.json()) as { id: string };

      const frames = await page.evaluate(
        async ({ sid }) => {
          const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
          const ws = new WebSocket(
            `${proto}//${location.host}/api/sessions/${sid}/ws?role=browser`,
          );
          const got: string[] = [];
          await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error('WebSocket handshake through the router failed'));
          });
          ws.onmessage = (m) => got.push(String(m.data));
          const res = await fetch(`/api/sessions/${sid}/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ category: 'internal', message: 'container-ws-probe' }),
          });
          if (!res.ok) throw new Error(`POST events -> ${res.status}`);
          for (let i = 0; i < 100 && !got.some((g) => g.includes('event.changed')); i++) {
            await new Promise((r) => setTimeout(r, 100));
          }
          ws.close();
          return got;
        },
        { sid: id },
      );
      expect(
        frames.some((f) => f.includes('event.changed')),
        `frames: ${frames.join(' | ')}`,
      ).toBe(true);
    } finally {
      await context.close();
    }
  });
});

// -------------------------------------------------------------------------------------------
// gzip / identity parity: router vs a throwaway container on `back` addressing api directly
// -------------------------------------------------------------------------------------------
test.describe('API encoding passes through untouched', () => {
  const FETCH_SCRIPT = `
const http = require('node:http');
const [path, enc, cookie] = process.argv.slice(1);
const headers = { cookie };
if (enc !== '-') headers['accept-encoding'] = enc;
http.get({ host: 'api', port: 8787, path, headers, agent: false }, (res) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => process.stdout.write(JSON.stringify({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('base64') })));
});
`;

  const IGNORED = new Set(['date', 'connection', 'keep-alive']);
  const norm = (h: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(h)
        .filter(([k]) => !IGNORED.has(k))
        .map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]),
    );

  for (const enc of ['gzip', '-'] as const) {
    test(`GET /api/profile (${enc === '-' ? 'identity' : 'Accept-Encoding: gzip'}) -> router == api addressed directly`, async () => {
      const seeded = seedContainerSession(`gzip-${enc}`, [
        { studioId: 'test-studios', role: 'admin' },
      ]);
      // Make the authenticated profile comfortably larger than the 1024-byte compress threshold.
      for (let i = 0; i < 12; i++) {
        const r = await rawHttp(
          ROUTER(),
          'POST',
          '/api/shows',
          { cookie: seeded.cookie, 'content-type': 'application/json' },
          JSON.stringify({
            studio_id: 'test-studios',
            name: `Encoding parity show ${i} ${Date.now()}`,
          }),
        );
        expect(r.status, r.body.toString()).toBeLessThan(300);
      }
      const path = '/api/profile';
      const direct = JSON.parse(
        dockerOk([
          'run',
          '--rm',
          '--network',
          backNetwork(),
          'node:22-bookworm-slim',
          'node',
          '-e',
          FETCH_SCRIPT,
          path,
          enc,
          seeded.cookie,
        ]),
      ) as { status: number; headers: Record<string, unknown>; body: string };
      const viaRouter = await rawHttp(ROUTER(), 'GET', path, {
        cookie: seeded.cookie,
        ...(enc === '-' ? {} : { 'accept-encoding': enc }),
      });

      expect(direct.status).toBe(200);
      if (enc === 'gzip') {
        expect(direct.headers['content-encoding'], 'the api itself gzips this response').toBe(
          'gzip',
        );
      } else {
        expect(direct.headers['content-encoding']).toBeUndefined();
      }
      expect(direct.headers.vary, 'api sets Vary').toBeTruthy();
      expect(
        Buffer.from(direct.body, 'base64').length,
        'over the compress threshold',
      ).toBeGreaterThan(200);
      expect(viaRouter.status).toBe(direct.status);
      expect(norm(viaRouter.headers), `GET ${path} ${enc}: headers`).toEqual(norm(direct.headers));
      expect(
        viaRouter.body.equals(Buffer.from(direct.body, 'base64')),
        `GET ${path} ${enc}: body bytes`,
      ).toBe(true);
    });
  }
});

// -------------------------------------------------------------------------------------------
// Compose topology
// -------------------------------------------------------------------------------------------
test.describe('compose topology', () => {
  test('only the router publishes a host port, bound to loopback; web and api publish none', () => {
    const ps = JSON.parse(
      `[${dockerOk(['compose', 'ps', '--format', 'json']).trim().split('\n').join(',')}]`,
    ) as { Service: string; Publishers?: { URL: string; PublishedPort: number }[] }[];
    const by = Object.fromEntries(ps.map((p) => [p.Service, p.Publishers ?? []]));
    expect(by.web?.filter((p) => p.PublishedPort)).toEqual([]);
    expect(by.api?.filter((p) => p.PublishedPort)).toEqual([]);
    const published = (by.router ?? []).filter((p) => p.PublishedPort);
    expect(published.length).toBeGreaterThan(0);
    for (const p of published)
      expect(p.URL, 'router port bound to host loopback').toBe('127.0.0.1');
  });

  test('web cannot open a connection to api (by name or by address)', () => {
    const ip = dockerOk([
      'inspect',
      '-f',
      `{{ (index .NetworkSettings.Networks "${backNetwork()}").IPAddress }}`,
      'autologger-api',
    ]).trim();
    expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    const probe = (host: string) =>
      docker([
        'compose',
        'exec',
        '-T',
        'web',
        'node',
        '-e',
        `const s=require('net').connect({host:${JSON.stringify(host)},port:8787,timeout:3000});` +
          `s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});` +
          `s.on('error',e=>{console.log('ERR '+e.code);process.exit(2)});` +
          `s.on('timeout',()=>{console.log('ERR TIMEOUT');process.exit(2)});`,
      ]);
    for (const host of ['api', 'autologger-api', ip]) {
      const r = probe(host);
      expect(r.stdout, `web -> ${host}:8787`).not.toContain('CONNECTED');
      expect(r.stdout, `web -> ${host}:8787`).toMatch(/ERR/);
    }
  });

  test('docker compose up --scale api=2 is refused; still exactly one api container', () => {
    const r = docker(['compose', 'up', '-d', '--no-recreate', '--no-build', '--scale', 'api=2']);
    const out = `${r.stdout}${r.stderr}`;
    const count = dockerOk([
      'ps',
      '-q',
      '--filter',
      `label=com.docker.compose.project=${composeProject()}`,
      '--filter',
      'label=com.docker.compose.service=api',
    ])
      .trim()
      .split('\n')
      .filter(Boolean).length;
    expect(count, `api containers after --scale api=2 (compose said: ${out})`).toBe(1);
    expect(out, 'compose reports the container_name conflict').toMatch(
      /container name|container_name|scale/i,
    );
  });

  test('the loopback-only port is not reachable on a non-loopback host address', async () => {
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal);
    test.skip(!lan, 'host has no non-loopback IPv4 address to probe');
    const port = new URL(ROUTER()).port;
    const connectable = await new Promise<boolean>((resolve) => {
      const s = net.connect({
        host: (lan as { address: string }).address,
        port: Number(port),
        timeout: 3000,
      });
      s.on('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.on('error', () => resolve(false));
      s.on('timeout', () => {
        s.destroy();
        resolve(false);
      });
    });
    expect(connectable).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------
// Forged X-Forwarded-For
//
// Observable surface: with IP_ALLOWLIST set to an address nothing uses, the server answers
// /api/* with a 403 whose body names "client IP '<addr>'" -- the address effectiveClientIp()
// resolved (with TRUST_PROXY=1 that is the FIRST X-Forwarded-For hop the api receives, else the
// socket address). compose.e2e.yaml lets us recreate `api` with such an allowlist; it is restored
// afterwards.
//
// What "untrusted peer" means: the router trusts forwarded headers only from the two bridge
// gateways (172.28.10.1 / 172.28.11.1). A request from a host process reaches the router via the
// published port, i.e. it arrives from a gateway address => a TRUSTED peer (the same path Newt/
// Pangolin uses; README notes any host process can reach the loopback port). So:
//   - from the host, the upstream proxy's behaviour is modelled by sending the header the proxy
//     would send (`<client-supplied>, <real client>`): the rightmost untrusted hop wins;
//   - a genuinely untrusted peer is a throwaway container on `back` talking to router:8080.
// Recorded, observed values are written to the test annotations.
// -------------------------------------------------------------------------------------------
test.describe('forged X-Forwarded-For is not adopted', () => {
  test.setTimeout(240_000);
  const BLOCK = '203.0.113.9';

  const composeUpApi = (env: Record<string, string>) =>
    dockerOk(
      ['compose', 'up', '-d', '--force-recreate', '--no-deps', '--wait', '--no-build', 'api'],
      { env },
    );

  test.afterAll(() => {
    composeUpApi({ E2E_IP_ALLOWLIST: '' });
  });

  test('client IP resolved by the api, per source of the request', async () => {
    const testInfo = test.info();
    composeUpApi({ E2E_IP_ALLOWLIST: BLOCK });

    const resolved = async (headers: Record<string, string>): Promise<string> => {
      const r = await rawHttp(ROUTER(), 'GET', '/api/profile', headers);
      expect(r.status, r.body.toString()).toBe(403);
      const m = r.body.toString().match(/client IP '([^']*)'/);
      if (!m) throw new Error(`no client IP in body: ${r.body.toString()}`);
      return m[1] as string;
    };

    // (a) host, no XFF: the api sees the gateway that NATs the published port.
    const noXff = await resolved({});
    // (b) host = trusted gateway peer sending a bare forged value: documented limitation
    //     (README: any host process is as trusted as the upstream proxy).
    const bareForgedFromHost = await resolved({ 'x-forwarded-for': '1.2.3.4' });
    // (c) what the upstream proxy does: it APPENDS the real client address to the client's
    //     own header. The client-supplied leftmost value must not be adopted.
    const throughProxyModel = await resolved({ 'x-forwarded-for': '1.2.3.4, 198.51.100.7' });
    // (d) untrusted peer: a container on `back` (not a gateway) sends a forged header directly.
    const fromUntrustedPeer = (xff: string) => {
      const out = dockerOk([
        'run',
        '--rm',
        '--network',
        backNetwork(),
        'node:22-bookworm-slim',
        'node',
        '-e',
        `require('http').get({host:'router',port:8080,path:'/api/profile',headers:{'x-forwarded-for':${JSON.stringify(xff)}},agent:false},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>console.log(JSON.stringify({s:r.statusCode,b})))})`,
      ]);
      const parsed = JSON.parse(out) as { s: number; b: string };
      expect(parsed.s).toBe(403);
      return parsed.b.match(/client IP '([^']*)'/)?.[1] as string;
    };
    const untrusted1 = fromUntrustedPeer('1.2.3.4');
    const untrusted2 = fromUntrustedPeer('1.2.3.4, 5.6.7.8');
    const ownIp = dockerOk([
      'run',
      '--rm',
      '--network',
      backNetwork(),
      'node:22-bookworm-slim',
      'node',
      '-e',
      `console.log(require('os').networkInterfaces().eth0[0].address)`,
    ]).trim();

    const observed = {
      noXff,
      bareForgedFromHost,
      throughProxyModel,
      untrusted1,
      untrusted2,
      untrustedPeerOwnIpExample: ownIp,
    };
    testInfo.annotations.push({
      type: 'observed-client-ip',
      description: JSON.stringify(observed),
    });
    // eslint-disable-next-line no-console
    console.log(`OBSERVED api-resolved client IPs: ${JSON.stringify(observed)}`);

    expect(noXff).toBe('172.28.11.1');
    expect(bareForgedFromHost, 'documented: a host process is a trusted peer').toBe('1.2.3.4');
    expect(
      throughProxyModel,
      'client-supplied leftmost hop is not adopted; the proxy-appended address is',
    ).toBe('198.51.100.7');
    expect(throughProxyModel).not.toBe('1.2.3.4');
    for (const v of [untrusted1, untrusted2]) {
      expect(v, 'untrusted peer: forged header ignored').not.toBe('1.2.3.4');
      expect(v).toMatch(/^172\.28\.11\.\d+$/);
      expect(v).not.toBe('172.28.11.1');
    }
  });
});

// -------------------------------------------------------------------------------------------
// State survives recreation (runs last: it recreates api from a different tag)
// -------------------------------------------------------------------------------------------
test.describe('state survives recreation of api', () => {
  test.setTimeout(240_000);

  test('a session, ~/.claude/ and ~/.claude.json written before recreation are present after', async () => {
    const image = (
      JSON.parse(dockerOk(['compose', 'config', '--format', 'json'])) as {
        services: { api: { image: string } };
      }
    ).services.api.image;
    const [repo, tag] = [
      image.slice(0, image.lastIndexOf(':')),
      image.slice(image.lastIndexOf(':') + 1),
    ];
    const newTag = `${tag}-recreated`;
    const seeded = seedContainerSession('recreate', [{ studioId: 'test-studios', role: 'admin' }]);

    const created = await rawHttp(
      ROUTER(),
      'POST',
      '/api/sessions',
      { cookie: seeded.cookie, 'content-type': 'application/json' },
      JSON.stringify({
        show_id: 'show-autolog-test',
        title: `survives ${Date.now()}`,
        frame_rate: 24,
        start_offset_frames: 0,
      }),
    );
    expect(created.status, created.body.toString()).toBe(200);
    const { id } = JSON.parse(created.body.toString()) as { id: string };
    dockerOk([
      'compose',
      'exec',
      '-T',
      'api',
      'sh',
      '-c',
      'echo e2e-credential > "$HOME/.claude/e2e-marker" && echo \'{"e2e":true}\' > "$HOME/.claude.json"',
    ]);

    dockerOk(['tag', image, `${repo}:${newTag}`]);
    try {
      dockerOk(
        ['compose', 'up', '-d', '--force-recreate', '--no-deps', '--wait', '--no-build', 'api'],
        { env: { API_TAG: newTag } },
      );
      const running = dockerOk(['inspect', '-f', '{{.Config.Image}}', 'autologger-api']).trim();
      expect(running, 'api was recreated from the new tag').toBe(`${repo}:${newTag}`);

      const after = await rawHttp(ROUTER(), 'GET', `/api/sessions/${id}`, {
        cookie: seeded.cookie,
      });
      expect(after.status, 'session written before recreation is still there').toBe(200);
      const files = dockerOk([
        'compose',
        'exec',
        '-T',
        'api',
        'sh',
        '-c',
        'cat "$HOME/.claude/e2e-marker" "$HOME/.claude.json"',
      ]);
      expect(files).toContain('e2e-credential');
      expect(files).toContain('"e2e":true');
    } finally {
      dockerOk([
        'compose',
        'up',
        '-d',
        '--force-recreate',
        '--no-deps',
        '--wait',
        '--no-build',
        'api',
      ]);
      docker(['rmi', `${repo}:${newTag}`]);
    }
  });
});
