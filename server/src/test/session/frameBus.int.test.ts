// The Postgres frame bus across two server processes (session-frame-bus D1-D3, D8; ADR 0021 slice
// 9a; core-ports-architecture "Session frames reach every process in commit order"). Two
// `createBindings({ frameBus: 'postgres' })` instances over the test database stand in for two
// processes: each has its own catalog adapter, registry and bus, and a socket is a recording stand-in
// attached to a process's hub. Every process, the writer included, delivers from its listener.
// The 300-session revoke is task 5.1's (sessionWs.access.int.test.ts). The `1012` cases
// (api-contract-freeze "Session sockets close after live updates were interrupted", D6) serve
// process B's bindings on a real listening server and terminate only B's listener, by the backend
// pid the bus exposes, so no other file's listener is touched.

import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SessionHubEntry, systemCaller } from '@autologger/session-core';
import { type ServerType, serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono } from 'hono';
import postgres from 'postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connOptions } from '../../../../test/pg/testDb';
import { wireApp } from '../../app';
import type { AppEnv } from '../../appEnv';
import { createBindings } from '../../node/config';
import { defaultUser, testDatabase } from '../harness';
import { seededSession } from '../helpers';
import { catalogRoot, createSessionRow } from './sessionRows';

const CTX = { frameRate: 24, startOffsetFrames: 0 };
const SECRET = 'x'.repeat(40);
const CALLER = systemCaller('test-frame-bus');

type Made = ReturnType<typeof createBindings>;
const made: Array<{ m: Made; dir: string }> = [];
afterEach(async () => {
  for (const { m, dir } of made.splice(0)) {
    await m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** One server process on the test database, with the Postgres bus started. */
async function process_(): Promise<Made> {
  const db = testDatabase();
  const dir = mkdtempSync(join(tmpdir(), 'autologger-bus-'));
  const m = createBindings(
    {
      DATA_DIR: dir,
      // As the harness's env (test/harness.ts), so a route served on these bindings admits the
      // harness's signed-in users.
      PUBLIC_BASE_URL: 'https://example.com',
      GOOGLE_CLIENT_ID: 'test-client-id',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      BOOTSTRAP_OWNER_EMAIL: 'bootstrap-owner@example.com',
      SESSION_COOKIE: 'autologger_sid',
      SESSION_DAYS: '14',
      PGHOST: db.host,
      PGPORT: String(db.port),
      PGUSER: db.user,
      PGPASSWORD: db.password,
      PGDATABASE: db.database,
      FRAME_BUS_SECRET: SECRET,
    },
    { frameBus: 'postgres' },
  );
  made.push({ m, dir });
  await m.startFrameBus();
  return m;
}

async function twoProcesses(): Promise<[Made, Made]> {
  return [await process_(), await process_()];
}

/** A recording socket: every frame parsed, and every close code. */
function socket() {
  const frames: Array<Record<string, unknown>> = [];
  const closes: number[] = [];
  return {
    frames,
    closes,
    send: (d: string) => void frames.push(JSON.parse(d)),
    close: (code?: number) => void closes.push(code ?? 0),
  };
}

async function hubOf(p: Made, sessionId: string): Promise<SessionHubEntry> {
  return p.bindings.ports.sessions.get(sessionId);
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for frames');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const addEvent = (hub: SessionHubEntry, message: string) =>
  hub
    .as(CALLER)
    .addEvent({ category: 'cam', message, metadataJson: '{}', markedAtUtc: null, ctx: CTX });

async function storedRevision(sessionId: string): Promise<number> {
  const [row] = await catalogRoot()
    .bindSystem('test')
    .all<{ revision: number }>('SELECT revision FROM sessions WHERE id = ?', sessionId);
  return Number(row?.revision);
}

const eventFrames = (s: ReturnType<typeof socket>) =>
  s.frames.filter((f) => f.type === 'event.changed');

describe('the Postgres frame bus across two processes (session-frame-bus D3)', () => {
  it('a write through A reaches a socket on B exactly once, and the writer’s own socket once', async () => {
    const id = await createSessionRow();
    const [a, b] = await twoProcesses();
    const onA = socket();
    const onB = socket();
    (await hubOf(a, id)).attachSocket(onA, 'browser');
    (await hubOf(b, id)).attachSocket(onB, 'browser');
    await addEvent(await hubOf(a, id), 'one');
    const revision = await storedRevision(id);
    await until(() => eventFrames(onA).length > 0 && eventFrames(onB).length > 0);
    // A later write's frame arriving shows no duplicate of the first is still in flight.
    await addEvent(await hubOf(b, id), 'two');
    await until(() => eventFrames(onA).length > 1 && eventFrames(onB).length > 1);
    for (const s of [onA, onB]) {
      expect(eventFrames(s)).toEqual([
        { type: 'event.changed', revision },
        { type: 'event.changed', revision: revision + 1 },
      ]);
    }
  });

  it('publishing does not advance the revision: one write, one step, the frame carries it', async () => {
    const id = await createSessionRow();
    const [a, b] = await twoProcesses();
    const onB = socket();
    (await hubOf(b, id)).attachSocket(onB, 'browser');
    const hubA = await hubOf(a, id);
    const before = await storedRevision(id);
    await addEvent(hubA, 'one');
    expect(await storedRevision(id)).toBe(before + 1);
    await until(() => eventFrames(onB).length === 1);
    expect(eventFrames(onB)).toEqual([{ type: 'event.changed', revision: before + 1 }]);
  });

  it('2×100 interleaved writes arrive on every socket in commit order', async () => {
    const id = await createSessionRow();
    const [a, b] = await twoProcesses();
    const sockets = [socket(), socket(), socket(), socket()];
    const [hubA, hubB] = [await hubOf(a, id), await hubOf(b, id)];
    hubA.attachSocket(sockets[0] ?? socket(), 'browser');
    hubA.attachSocket(sockets[1] ?? socket(), 'browser');
    hubB.attachSocket(sockets[2] ?? socket(), 'browser');
    hubB.attachSocket(sockets[3] ?? socket(), 'browser');
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        Promise.all([addEvent(hubA, `a${i}`), addEvent(hubB, `b${i}`)]),
      ),
    );
    await until(() => sockets.every((s) => eventFrames(s).length >= 200), 15_000);
    for (const s of sockets) {
      const revisions = eventFrames(s).map((f) => Number(f.revision));
      expect(revisions).toHaveLength(200);
      for (let i = 1; i < revisions.length; i += 1) {
        expect(revisions[i]).toBeGreaterThan(revisions[i - 1] ?? Number.POSITIVE_INFINITY);
      }
    }
  }, 60_000);

  it('a rolled-back write publishes nothing', async () => {
    const id = await createSessionRow();
    const [a, b] = await twoProcesses();
    const onB = socket();
    (await hubOf(b, id)).attachSocket(onB, 'browser');
    const hubA = await hubOf(a, id);
    // The hub's private write entry, for a body that broadcasts and then fails.
    const write = (
      hubA as unknown as {
        call(
          c: typeof CALLER,
          m: 'write',
          b: (s: { core: { broadcast(m: object): void } }) => Promise<unknown>,
        ): Promise<unknown>;
      }
    ).call.bind(hubA);
    await expect(
      write(CALLER, 'write', async (s) => {
        s.core.broadcast({ type: 'transport.changed', rolled_back: true });
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    await addEvent(hubA, 'after');
    await until(() => eventFrames(onB).length === 1);
    expect(onB.frames.map((f) => f.type)).toEqual(['event.changed']);
  });

  it('a command relayed through A reaches a browser on B', async () => {
    const id = await createSessionRow();
    const [a, b] = await twoProcesses();
    const sender = socket();
    const onB = socket();
    const hubA = await hubOf(a, id);
    hubA.attachSocket(sender, 'browser');
    (await hubOf(b, id)).attachSocket(onB, 'browser');
    hubA.handleSocketMessage(JSON.stringify({ type: 'command', command: 'record-start' }), sender);
    await until(() => onB.frames.length > 0);
    expect(onB.frames).toEqual([{ type: 'command', command: 'record-start' }]);
  });

  it('a forged pg_notify from a role without the secret is dropped and logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const id = await createSessionRow();
      const [a, b] = await twoProcesses();
      const onA = socket();
      const onB = socket();
      (await hubOf(a, id)).attachSocket(onA, 'browser');
      (await hubOf(b, id)).attachSocket(onB, 'browser');
      // Another database role, without the secret: the migrations user, on the same database.
      const admin = postgres({
        ...connOptions('postgres', testDatabase().database),
        max: 1,
        onnotice: () => {},
      });
      try {
        const body = {
          f: JSON.stringify({ type: 'command', command: 'record-start' }),
          k: 'frame',
          n: 1,
          s: id,
          v: 1,
        };
        const unsigned = JSON.stringify(body);
        const h = createHmac('sha256', 'not-the-secret-not-the-secret-000')
          .update(unsigned)
          .digest('hex');
        const wrongKey = JSON.stringify({ ...body, h });
        for (const payload of [unsigned, wrongKey]) {
          await admin`select pg_notify('autologger_session_frames', ${payload})`;
        }
      } finally {
        await admin.end();
      }
      // A genuine command after the forgeries: once it arrives, the forgeries were handled.
      (await hubOf(a, id)).broadcastCommand('play-toggle');
      await until(() => onA.frames.length > 0 && onB.frames.length > 0);
      for (const s of [onA, onB]) {
        expect(s.frames).toEqual([{ type: 'command', command: 'play-toggle' }]);
      }
      const lines = warn.mock.calls.map((c) => c.join(' '));
      expect(lines.filter((l) => l.includes('frame bus: dropped unsigned message'))).toHaveLength(
        2,
      );
      expect(lines.filter((l) => l.includes('frame bus: dropped bad signature'))).toHaveLength(2);
      expect(lines.join('\n')).not.toContain('record-start');
    } finally {
      warn.mockRestore();
    }
  });
});

const servers: ServerType[] = [];
const clients: WebSocket[] = [];
afterEach(async () => {
  // Every client socket is closed first, so a failed case cannot keep a server open; a server's
  // close is waited for at most 2 s.
  for (const ws of clients.splice(0)) ws.close();
  for (const srv of servers.splice(0)) {
    await Promise.race([new Promise((r) => srv.close(r)), new Promise((r) => setTimeout(r, 2000))]);
  }
});

/** Serves `p`'s bindings on a real listening server, as main.ts does; returns its port. */
async function serveProcess(p: Made): Promise<number> {
  const app = new Hono<AppEnv>();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  wireApp(app, upgradeWebSocket, { bindings: p.bindings });
  return new Promise<number>((resolve) => {
    const srv = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) =>
      resolve(info.port),
    );
    injectWebSocket(srv);
    servers.push(srv);
  });
}

/** A browser socket on `sessionId` through the server on `port`, as the default user. */
async function browser(port: number, sessionId: string) {
  const { cookie } = await defaultUser();
  const messages: Array<Record<string, unknown>> = [];
  const closes: number[] = [];
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${sessionId}/ws`, {
      headers: { cookie },
    } as unknown as string[]);
    w.addEventListener('open', () => resolve(w));
    w.addEventListener('error', (e) => reject(e));
  });
  clients.push(ws);
  ws.addEventListener('message', (e) => void messages.push(JSON.parse(String(e.data))));
  ws.addEventListener('close', (e) => void closes.push(e.code));
  return { ws, messages, closes };
}

/** Terminates `p`'s listener backend only, as the migrations user. */
async function killListener(p: Made): Promise<number> {
  const pid = p.frameBus?.listenerPid;
  if (!pid) throw new Error('the frame bus has no listener pid');
  const admin = postgres({
    ...connOptions('postgres', testDatabase().database),
    max: 1,
    onnotice: () => {},
  });
  try {
    const [r] = await admin`select pg_terminate_backend(${pid}) as ok`;
    expect(r?.ok).toBe(true);
  } finally {
    await admin.end();
  }
  return pid;
}

describe('sockets close after live updates were interrupted (session-frame-bus D6)', () => {
  it('B’s sockets close with 1012 once when its listener comes back, and the reconnect is admitted', async () => {
    const { sessionId } = await seededSession();
    const [a, b] = await twoProcesses();
    const [portA, portB] = [await serveProcess(a), await serveProcess(b)];
    const onA = await browser(portA, sessionId);
    const onB = [await browser(portB, sessionId), await browser(portB, sessionId)];
    const before = await killListener(b);
    await until(() => onB.every((s) => s.closes.length > 0), 15_000);
    expect(b.frameBus?.listenerPid).not.toBe(before);
    for (const s of onB) expect(s.closes).toEqual([1012]);
    // A's listener was not touched: its socket is still open and gets the next frame.
    expect(onA.closes).toEqual([]);
    const again = await browser(portB, sessionId);
    expect(again.ws.readyState).toBe(WebSocket.OPEN);
    await addEvent(await hubOf(a, sessionId), 'after');
    await until(() => onA.messages.length > 0 && again.messages.length > 0);
    // Once per loss: nothing else closed meanwhile.
    for (const s of onB) expect(s.closes).toEqual([1012]);
    expect([onA.closes, again.closes]).toEqual([[], []]);
  }, 30_000);

  it('after the reconnect, a write through A reaches the browser on B', async () => {
    const { sessionId } = await seededSession();
    const [a, b] = await twoProcesses();
    const portB = await serveProcess(b);
    const first = await browser(portB, sessionId);
    await killListener(b);
    await until(() => first.closes.length > 0, 15_000);
    const again = await browser(portB, sessionId);
    await addEvent(await hubOf(a, sessionId), 'after reconnect');
    await until(() => again.messages.some((m) => m.type === 'event.changed'));
    expect(again.messages.filter((m) => m.type === 'event.changed')).toHaveLength(1);
    expect(first.closes).toEqual([1012]);
  }, 30_000);
});
