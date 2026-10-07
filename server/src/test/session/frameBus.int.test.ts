// The Postgres frame bus across two server processes (session-frame-bus D1-D3, D8; ADR 0021 slice
// 9a; core-ports-architecture "Session frames reach every process in commit order"). Two
// `createBindings({ frameBus: 'postgres' })` instances over the test database stand in for two
// processes: each has its own catalog adapter, registry and bus, and a socket is a recording stand-in
// attached to a process's hub. Every process, the writer included, delivers from its listener.
// The 300-session revoke is task 5.1's (sessionWs.access.int.test.ts).

import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SessionHubEntry, systemCaller } from '@autologger/session-core';
import postgres from 'postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connOptions } from '../../../../test/pg/testDb';
import { createBindings } from '../../node/config';
import { testDatabase } from '../harness';
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
