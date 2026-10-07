// src/routers/sessionWs.commands.int.test.ts — a browser socket's relayed commands
// (session-frame-bus D4, ADR 0021 slice 9a), on a real listening @hono/node-ws server like
// companion-ws.int.test.ts. The route hands each socket to the hub, so the 10-per-second limit
// applies per socket: one socket's flood does not drop another socket's command. A command that is
// not a contract command is dropped.

import type { AddressInfo } from 'node:net';
import { type ServerType, serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wireApp } from '../app';
import type { AppEnv } from '../appEnv';
import { defaultUser, env } from '../test/harness';
import { seededSession } from '../test/helpers';

let server: ServerType;
let port: number;

beforeAll(async () => {
  const app = new Hono<AppEnv>();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  wireApp(app, upgradeWebSocket, { bindings: env });
  port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) =>
      resolve(info.port),
    );
    injectWebSocket(server);
  });
});

afterAll(() => server.close());

/** A session socket as the default signed-in member, with every message it received. */
async function connect(sessionId: string): Promise<{ ws: WebSocket; messages: string[] }> {
  const { cookie } = await defaultUser();
  const messages: string[] = [];
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${sessionId}/ws`, {
      headers: { cookie },
    } as unknown as string[]);
    w.addEventListener('open', () => resolve(w));
    w.addEventListener('error', (e) => reject(e));
  });
  ws.addEventListener(
    'message',
    (e) => void messages.push(typeof e.data === 'string' ? e.data : ''),
  );
  return { ws, messages };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const command = (c: string) => JSON.stringify({ type: 'command', command: c });

describe('relayed commands per socket (session-frame-bus D4)', () => {
  it("one socket's flood is limited to 10, and another socket's command still goes out", async () => {
    const s = (await seededSession()).sessionId;
    const flooder = await connect(s);
    const other = await connect(s);
    const watcher = await connect(s);
    for (let i = 0; i < 12; i += 1) flooder.ws.send(command('record-toggle'));
    flooder.ws.send(command('self-destruct'));
    other.ws.send(command('play-toggle'));
    await until(
      () =>
        watcher.messages.some((m) => m.includes('play-toggle')) &&
        watcher.messages.filter((m) => m.includes('record-toggle')).length >= 10,
    );
    // The flooder's last messages share its connection, so they are handled within the settle;
    // a marker through the hub's own path then closes the window.
    await new Promise((r) => setTimeout(r, 100));
    (await env.ports.sessions.get(s)).broadcastCommand('record-stop');
    await until(() => watcher.messages.some((m) => m.includes('record-stop')));
    const got = watcher.messages.map((m) => JSON.parse(m).command);
    expect(got.filter((c) => c === 'record-toggle')).toHaveLength(10);
    expect(got).toContain('play-toggle');
    expect(got).not.toContain('self-destruct');
    for (const x of [flooder, other, watcher]) x.ws.close();
  });
});
