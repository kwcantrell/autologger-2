// src/routers/companion-ws.int.test.ts — companion WS relay on a real
// listening @hono/node-ws server (Node 22 global WebSocket client). Bindings
// reach the WS-upgrade path via wireApp(app, upgradeWebSocket, { bindings: env }):
// env is a lazy Proxy that resolves per-test, and wireApp's injection
// middleware spreads it at request time, so each test sees its own fresh
// bindings — including on the upgrade path, which bypasses any serve({fetch})
// wrapper.

import type { AddressInfo } from 'node:net';
import { type ServerType, serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wireApp } from '../app';
import { env } from '../test/harness';
import { seededSession, setCompanionPresence } from '../test/helpers';
import type { AppEnv } from '../types';

let server: ServerType;
let port: number;

beforeAll(async () => {
  const app = new Hono<AppEnv>();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  // env is a Proxy resolving per-test; wireApp's injection middleware spreads it
  // at request time, so both HTTP and WS-upgrade paths see the current bindings.
  wireApp(app, upgradeWebSocket, { bindings: env });
  port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) =>
      resolve(info.port),
    );
    // Match src/main.ts: inject synchronously right after serve() returns the
    // server handle, not deferred inside the listening callback.
    injectWebSocket(server);
  });
});

afterAll(() => server.close());

function connect(sessionId: string): Promise<WebSocket> {
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

describe('companion WebSocket relay (Node)', () => {
  it('delivers a posted command over the session WebSocket', async () => {
    const s = seededSession().sessionId;
    const ws = await connect(s);
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

  it('re-broadcasts a command sent BY a connected client', async () => {
    const s = seededSession().sessionId;
    const sender = await connect(s);
    const receiver = await connect(s);
    const got = nextMessage(receiver);
    sender.send(JSON.stringify({ type: 'command', command: 'play-toggle' }));
    expect(JSON.parse(await got)).toMatchObject({ type: 'command', command: 'play-toggle' });
    sender.close();
    receiver.close();
  });

  it('rejects the upgrade for an unknown session (404 before upgrade)', async () => {
    await expect(connect('does-not-exist')).rejects.toBeTruthy();
  });
});
