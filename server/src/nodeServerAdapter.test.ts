// src/nodeServerAdapter.test.ts — unit tier, but on a real listening socket:
// pins the @hono/node-server behavior the server relies on, wired the way
// src/main.ts wires it (serve() + @hono/node-ws captured through
// captureHonoUpgradeHandler + installUpgradeDispatcher as the one real
// `upgrade` listener). No bindings, no database: a tiny Hono app stands in
// for wireApp so this runs on the host without the dev stack.
//
// Why it exists: @hono/node-server 2.x reimplemented the request/response
// bridge for speed and added its own WebSocket support. The HTTP/WS contract
// is frozen, so the adapter-level semantics below must not move with it:
// - the installed adapter is the 2.x major this repo declares;
// - serve() without a `websocket` option installs no `upgrade` listener of its
//   own (main.ts's dispatcher must stay the only one);
// - RESPONSE_ALREADY_SENT (the frontend bridge's sentinel, src/app.ts) leaves
//   the raw response exactly as written and never leaks its marker header;
// - status, headers, bodies and Range responses pass through unchanged;
// - null-body responses (204, c.redirect) carry no content-type. 1.x added
//   `text/plain; charset=UTF-8` to them; dropping it is the one observable
//   change of the 2.x upgrade, accepted by the human for job 009
//   (api-contract-freeze "Null-body responses carry no Content-Type");
// - @hono/node-ws upgrades still open, echo and reject as before.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import type { Config } from '@autologger/ports';
import { type ServerType, serve } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureHonoUpgradeHandler, installUpgradeDispatcher } from './upgradeDispatch';

type RawEnv = { Bindings: { incoming?: IncomingMessage; outgoing?: ServerResponse } };

// Only IP_ALLOWLIST/TRUST_PROXY are read on the upgrade path; the rest is filler.
const config = new Proxy({ IP_ALLOWLIST: '', TRUST_PROXY: '' } as Record<string, string>, {
  get: (t, k: string) => t[k] ?? '',
}) as unknown as Config;

const RANGE_BODY = '0123456789abcdef';

let server: ServerType;
let base: string;
let port: number;
let upgradeListenersFromServe = -1;

beforeAll(async () => {
  const app = new Hono<RawEnv>();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // Raw write + sentinel, the shape of src/app.ts's frontend bridge.
  app.get('/raw', (c) => {
    const { outgoing } = c.env;
    if (!outgoing) return c.notFound();
    outgoing.writeHead(203, { 'content-type': 'text/x-raw', 'x-raw': 'yes' });
    outgoing.end('written raw');
    return RESPONSE_ALREADY_SENT;
  });
  app.get('/api/json', (c) => {
    c.header('x-custom', 'kept');
    c.header('set-cookie', 'a=1; Path=/');
    c.header('set-cookie', 'b=2; Path=/', { append: true });
    return c.json({ ok: true, n: 1 }, 201);
  });
  app.get('/api/empty', (c) => c.body(null, 204));
  app.get('/api/redirect', (c) => c.redirect('/?login_error=provider_error'));
  app.get('/api/range', (c) => {
    // Same shape as the audio/export routers' 206 responses.
    const m = /^bytes=(\d+)-(\d+)$/.exec(c.req.header('range') ?? '');
    if (!m) return c.body(RANGE_BODY, 200, { 'accept-ranges': 'bytes' });
    const start = Number(m[1]);
    const end = Number(m[2]);
    return c.body(RANGE_BODY.slice(start, end + 1), 206, {
      'accept-ranges': 'bytes',
      'content-range': `bytes ${start}-${end}/${RANGE_BODY.length}`,
      'content-length': String(end - start + 1),
    });
  });
  app.get('/api/stream', () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(enc.encode('chunk1,'));
        ctrl.enqueue(enc.encode('chunk2'));
        ctrl.close();
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/plain' } });
  });
  app.post('/api/echo', async (c) => c.json(await c.req.json()));
  app.get('/api/ws/denied', (c) => c.text('nope', 401));
  app.get(
    '/api/ws',
    upgradeWebSocket(() => ({
      onMessage(evt, ws) {
        ws.send(`echo:${String(evt.data)}`);
      },
    })),
  );

  const honoUpgrade = captureHonoUpgradeHandler(injectWebSocket);
  port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) =>
      resolve(info.port),
    );
    upgradeListenersFromServe = (server as Server).listenerCount('upgrade');
    installUpgradeDispatcher({ server, honoUpgrade, frontend: null, dev: false, config });
  });
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  (server as Server).closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('@hono/node-server adapter', () => {
  it('is the 2.x major', () => {
    const req = createRequire(import.meta.url);
    const entry = req.resolve('@hono/node-server');
    const pkg = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    expect(pkg.name).toBe('@hono/node-server');
    expect(pkg.version.split('.')[0]).toBe('2');
  });

  it('serve() without a websocket option installs no upgrade listener of its own', () => {
    expect(upgradeListenersFromServe).toBe(0);
    // Only main.ts's dispatcher.
    expect((server as Server).listenerCount('upgrade')).toBe(1);
  });

  it('RESPONSE_ALREADY_SENT keeps the raw response and never leaks its marker header', async () => {
    const res = await fetch(`${base}/raw`);
    expect(res.status).toBe(203);
    expect(res.headers.get('content-type')).toBe('text/x-raw');
    expect(res.headers.get('x-raw')).toBe('yes');
    expect(res.headers.get('x-hono-already-sent')).toBeNull();
    expect(await res.text()).toBe('written raw');
  });

  it('passes status, headers, multiple set-cookie and JSON bodies through unchanged', async () => {
    const res = await fetch(`${base}/api/json`);
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('x-custom')).toBe('kept');
    expect(res.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect(await res.json()).toEqual({ ok: true, n: 1 });
  });

  it('keeps a 204 empty', async () => {
    const res = await fetch(`${base}/api/empty`);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('sends a 204 with no content-type', async () => {
    const res = await fetch(`${base}/api/empty`);
    expect(res.status).toBe(204);
    expect(res.headers.get('content-type')).toBeNull();
  });

  it('sends a c.redirect 302 with its Location and no content-type', async () => {
    const res = await fetch(`${base}/api/redirect`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?login_error=provider_error');
    expect(res.headers.get('content-type')).toBeNull();
    expect(await res.text()).toBe('');
  });

  it('passes 206 range responses through with their content-range and length', async () => {
    const res = await fetch(`${base}/api/range`, { headers: { range: 'bytes=2-5' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 2-5/${RANGE_BODY.length}`);
    expect(res.headers.get('content-length')).toBe('4');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(await res.text()).toBe('2345');
  });

  it('streams a ReadableStream body in full', async () => {
    const res = await fetch(`${base}/api/stream`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('chunk1,chunk2');
  });

  it('reads request bodies (the 2.x fast path for json())', async () => {
    const res = await fetch(`${base}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: [1, 2], b: 'x' }),
    });
    expect(await res.json()).toEqual({ a: [1, 2], b: 'x' });
  });

  it('opens and echoes on an /api WebSocket through the dispatcher', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
    const reply = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws timeout')), 3000);
      ws.addEventListener('open', () => ws.send('hi'));
      ws.addEventListener('message', (e) => {
        clearTimeout(t);
        resolve(String(e.data));
      });
      ws.addEventListener('error', () => reject(new Error('ws error')));
    });
    ws.close();
    expect(reply).toBe('echo:hi');
  });

  it('rejects an upgrade the route answers without upgrading, with that status', async () => {
    const head = await rawUpgrade('/api/ws/denied');
    expect(head.split('\r\n')[0]).toBe('HTTP/1.1 401 Unauthorized');
  });

  it('destroys a non-/api upgrade in production mode', async () => {
    expect(await rawUpgrade('/not-api')).toBe('');
  });
});

/** Sends a WebSocket upgrade by hand and returns whatever the server wrote before closing. */
function rawUpgrade(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\n` +
          'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
          `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`,
      );
    });
    let out = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      out += d;
    });
    sock.on('close', () => resolve(out));
    sock.on('error', (e) =>
      (e as NodeJS.ErrnoException).code === 'ECONNRESET' ? resolve(out) : reject(e),
    );
    sock.setTimeout(3000, () => {
      sock.destroy();
      reject(new Error('raw upgrade timeout'));
    });
  });
}
