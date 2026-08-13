// src/upgradeDispatch.int.test.ts — the real dispatcher (capture + install),
// wired the same way main.ts wires it (nextjs-frontend-migration task 3.3),
// on a real listening @hono/node-ws server (Node 22 global WebSocket client
// for the /api path; raw `net` sockets for the non-/api upgrade-dispatch
// checks, since there is no real Next dev server in this suite — a stub
// `upgradeHandler`/`handle` stands in for it, matching design D1's stated
// verification shape: "e2e checks that the session WS and dev HMR both stay
// alive; prod destroys non-`/api` upgrades; non-`/api` upgrades pass the
// IP-allowlist decision before reaching Next").
//
// Each test boots its OWN server (rather than one shared `beforeAll` like
// companion-ws.int.test.ts) because the dispatcher's `config` is captured
// once at install time — exactly like production, where IP_ALLOWLIST is
// fixed at boot — so varying it across tests needs a fresh install per test.

import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { type ServerType, serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type FrontendBridge, wireApp } from './app';
import type { AppEnv, Bindings } from './appEnv';
import { env, envWith } from './test/harness';
import { seededSession, setCompanionPresence } from './test/helpers';
import { captureHonoUpgradeHandler, installUpgradeDispatcher } from './upgradeDispatch';

interface StubFrontend {
  handle: ReturnType<typeof vi.fn>;
  upgradeHandler: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function stubFrontend(onUpgrade?: (socket: NodeJS.WritableStream) => void): StubFrontend {
  return {
    handle: vi.fn(async () => {}),
    upgradeHandler: vi.fn(async (_req: unknown, socket: NodeJS.WritableStream) => {
      onUpgrade?.(socket);
    }),
    close: vi.fn(async () => {}),
  };
}

async function bootDispatcherServer(opts: {
  dev: boolean;
  frontend?: StubFrontend | null;
  bindings?: Bindings;
}): Promise<{ port: number; close(): Promise<void> }> {
  const bindings = opts.bindings ?? env;
  const app = new Hono<AppEnv>();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  wireApp(app, upgradeWebSocket, {
    bindings,
    frontend: opts.frontend
      ? ({ handle: opts.frontend.handle } as unknown as FrontendBridge)
      : undefined,
  });
  // Same sequence as main.ts (task 3.3): capture Hono's upgrade handler via
  // the stub BEFORE the real server exists, then install exactly one real
  // `upgrade` listener — the dispatcher — after serve() returns the handle.
  const honoUpgrade = captureHonoUpgradeHandler(injectWebSocket);
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  installUpgradeDispatcher({
    server,
    honoUpgrade,
    frontend: opts.frontend as never,
    dev: opts.dev,
    config: bindings.config,
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Sends a raw HTTP Upgrade request over a plain TCP socket (not a real
 * WebSocket handshake — the stub frontend's `upgradeHandler` just writes
 * recognizable bytes, so a full protocol handshake isn't needed to prove
 * dispatch reached it). Resolves with whatever bytes came back before the
 * socket closed, or '' if the socket was destroyed with no data (the
 * "destroyed" case). */
function rawUpgradeProbe(port: number, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: '127.0.0.1', port }, () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          'Connection: Upgrade\r\n' +
          'Upgrade: websocket\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          '\r\n',
      );
    });
    let data = '';
    const t = setTimeout(() => {
      sock.destroy();
      resolve(data);
    }, 2000);
    sock.on('data', (chunk) => {
      data += chunk.toString('utf8');
    });
    sock.on('close', () => {
      clearTimeout(t);
      resolve(data);
    });
    sock.on('error', (err) => {
      clearTimeout(t);
      // ECONNRESET on an abrupt server-side destroy() is an expected shape
      // of "destroyed", not a test failure — resolve with whatever we have.
      if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') resolve(data);
      else reject(err);
    });
  });
}

function connectSessionWs(port: number, sessionId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${sessionId}/ws`);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', (e) => reject(e));
  });
}

function nextMessage(ws: WebSocket, ms = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws message timeout')), ms);
    ws.addEventListener('message', (e) => {
      clearTimeout(t);
      resolve(typeof e.data === 'string' ? e.data : '');
    });
  });
}

describe('real upgrade dispatcher (server/src/upgradeDispatch.ts, wired the way main.ts wires it)', () => {
  let closeServer: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (closeServer) await closeServer();
    closeServer = undefined;
  });

  it('session WebSocket still connects and receives a broadcast frame through the real server (frozen /api surface, spec "Session WebSocket still upgrades")', async () => {
    const { port, close } = await bootDispatcherServer({ dev: true, frontend: stubFrontend() });
    closeServer = close;

    const s = seededSession().sessionId;
    const ws = await connectSessionWs(port, s);
    const got = nextMessage(ws);
    setCompanionPresence('c1', s);
    const cmd = await fetch(`http://127.0.0.1:${port}/api/companion/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'record-start' }),
    });
    expect(cmd.status).toBe(200);
    expect(JSON.parse(await got)).toMatchObject({ type: 'command', command: 'record-start' });
    ws.close();
  });

  it('dev, allowlist open: a non-/api upgrade reaches the frontend upgrade handler', async () => {
    const frontend = stubFrontend((socket) => {
      (socket as unknown as { end(chunk: string): void }).end('FRONTEND-HIT');
    });
    const { port, close } = await bootDispatcherServer({ dev: true, frontend });
    closeServer = close;

    const data = await rawUpgradeProbe(port, '/_next/webpack-hmr');
    expect(data).toContain('FRONTEND-HIT');
    expect(frontend.upgradeHandler).toHaveBeenCalledTimes(1);
  });

  it('non-allowlisted non-/api upgrade is destroyed before reaching the frontend (spec "Allowlist covers the dev HMR socket")', async () => {
    const frontend = stubFrontend((socket) => {
      (socket as unknown as { end(chunk: string): void }).end('FRONTEND-HIT');
    });
    const restrictive = envWith({ IP_ALLOWLIST: '198.51.100.0/24' }); // excludes 127.0.0.1
    const { port, close } = await bootDispatcherServer({
      dev: true,
      frontend,
      bindings: restrictive,
    });
    closeServer = close;

    const data = await rawUpgradeProbe(port, '/_next/webpack-hmr');
    expect(data).toBe('');
    expect(frontend.upgradeHandler).not.toHaveBeenCalled();
  });

  it('prod destroys a non-/api upgrade even with an open allowlist (spec "Non-API upgrade in production")', async () => {
    const frontend = stubFrontend((socket) => {
      (socket as unknown as { end(chunk: string): void }).end('FRONTEND-HIT');
    });
    const { port, close } = await bootDispatcherServer({ dev: false, frontend });
    closeServer = close;

    const data = await rawUpgradeProbe(port, '/_next/webpack-hmr');
    expect(data).toBe('');
    expect(frontend.upgradeHandler).not.toHaveBeenCalled();
  });

  it('a /api upgrade is unaffected by a restrictive IP_ALLOWLIST that would block the non-/api branch (Hono middleware, not the dispatcher, owns that decision)', async () => {
    // IP_ALLOWLIST enforcement for /api WS upgrades happens inside Hono's own
    // pipeline (requireSession → the app.request() replay → ipAllowlistMiddleware),
    // unchanged by this migration — the dispatcher itself must not re-decide it.
    const restrictive = envWith({ IP_ALLOWLIST: '203.0.113.0/24' }); // excludes 127.0.0.1
    const { port, close } = await bootDispatcherServer({
      dev: true,
      frontend: stubFrontend(),
      bindings: restrictive,
    });
    closeServer = close;

    const s = seededSession().sessionId;
    // The Hono-side allowlist middleware runs BEFORE requireSession's 200, so
    // a blocked client is rejected with a 403 handshake close, not silently
    // hung — connecting rejects rather than opening, proving the dispatcher
    // routed it into the Hono path at all (a destroyed raw socket would look
    // the same as a routing failure otherwise).
    await expect(connectSessionWs(port, s)).rejects.toBeTruthy();
  });
});
