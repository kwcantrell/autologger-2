// The local frame bus (session-frame-bus D1, D3, D4, D8): a write's frames are delivered after its
// transaction commits, in issue order, and only the committed attempt's; a relayed command is
// checked against the contract's values and rate-limited per socket (per hub without one); a close
// reaches the user's sockets; a supplied bus gets the transaction's raw handle. The storage is a stand-in that runs the body over a handle answering every statement
// with no rows, so no database is needed.

import { describe, expect, it } from 'vitest';
import {
  type BusMessage,
  LocalFrameBus,
  SESSION_COMMANDS,
  SESSION_FRAME_TYPES,
  type SessionFrameBus,
} from './frameBus';
import { SessionHub, SessionHubRegistry } from './SessionHub';
import { type SessionCaller, systemCaller } from './sessionCaller';
import type { SessionCore, SessionSql, SessionStorage } from './sessionCore';

const CALLER = systemCaller('test-frame-bus');

/** A handle that answers every read with no rows and every write with no change. */
const emptyHandle = (): SessionSql => {
  const h: SessionSql = {
    all: async () => [],
    run: async () => ({ changes: 0 }),
    tx: (fn) => fn(h),
  };
  return h;
};

/** Runs each write body `attempts` times (a deadlock re-run before the last), then commits, or
 * fails after the body when `failCommit` is set. */
function fakeStorage(
  opts: { attempts?: number; failCommit?: () => boolean; handles?: SessionSql[] } = {},
): SessionStorage {
  const handle = () => {
    const h = emptyHandle();
    opts.handles?.push(h);
    return h;
  };
  return {
    async tx(_caller, fn) {
      const attempts = opts.attempts ?? 1;
      for (let i = 1; i < attempts; i += 1) await fn(handle());
      const value = await fn(handle());
      if (opts.failCommit?.()) throw new Error('commit failed');
      return value;
    },
    snapshot: (_caller, fn) => fn(emptyHandle()),
  };
}

type WriteBody = (s: { core: SessionCore }) => Promise<unknown>;
/** The hub's private write entry (one transaction under the hub's lock), for bodies that only
 * broadcast. */
const write = (hub: SessionHub, body: WriteBody) =>
  (hub as unknown as { call(c: SessionCaller, m: 'write', b: WriteBody): Promise<unknown> }).call(
    CALLER,
    'write',
    body,
  );

function recordingSocket() {
  const got: Array<Record<string, unknown>> = [];
  const closes: number[] = [];
  return {
    got,
    closes,
    send: (d: string) => void got.push(JSON.parse(d)),
    close: (code?: number) => void closes.push(code ?? 0),
  };
}

describe('LocalFrameBus', () => {
  it('delivers nothing in the transaction and everything after commit, in issue order', async () => {
    const delivered: BusMessage[] = [];
    const bus = new LocalFrameBus((m) => delivered.push(m));
    const msgs: BusMessage[] = [
      { k: 'frame', s: 's1', f: '{"type":"event.changed","revision":1}' },
      { k: 'frame', s: 's1', f: '{"type":"transport.changed"}' },
    ];
    await bus.publishInTx(emptyHandle(), msgs);
    expect(delivered).toEqual([]);
    bus.afterCommit(msgs);
    expect(delivered).toEqual(msgs);
  });

  it('publishNow delivers before it returns', () => {
    const delivered: BusMessage[] = [];
    const bus = new LocalFrameBus((m) => delivered.push(m));
    const msg: BusMessage = {
      k: 'frame',
      s: 's1',
      f: '{"type":"command","command":"play-toggle"}',
    };
    void bus.publishNow(msg);
    expect(delivered).toEqual([msg]);
  });
});

describe('the hub on the local bus', () => {
  it('a write delivers its frames after commit, in issue order', async () => {
    const reg = new SessionHubRegistry({ storage: () => fakeStorage() });
    const hub = await reg.get('s1');
    const ws = recordingSocket();
    hub.attachSocket(ws, 'browser');
    await write(hub, async (s) => {
      s.core.broadcast({ type: 'event.changed', revision: 1 });
      s.core.broadcast({ type: 'transport.changed' });
      expect(ws.got).toEqual([]);
    });
    expect(ws.got).toEqual([{ type: 'event.changed', revision: 1 }, { type: 'transport.changed' }]);
    await reg.closeAll();
  });

  it('a retried transaction delivers only the committed attempt’s frames', async () => {
    const reg = new SessionHubRegistry({ storage: () => fakeStorage({ attempts: 3 }) });
    const hub = await reg.get('s1');
    const ws = recordingSocket();
    hub.attachSocket(ws, 'browser');
    let attempt = 0;
    await write(hub, async (s) => {
      attempt += 1;
      s.core.broadcast({ type: 'audio.changed', attempt });
    });
    expect(ws.got).toEqual([{ type: 'audio.changed', attempt: 3 }]);
    await reg.closeAll();
  });

  it('a failed transaction delivers nothing', async () => {
    let fail = false;
    const reg = new SessionHubRegistry({ storage: () => fakeStorage({ failCommit: () => fail }) });
    const hub = await reg.get('s1');
    const ws = recordingSocket();
    hub.attachSocket(ws, 'browser');
    fail = true;
    await expect(
      write(hub, async (s) => s.core.broadcast({ type: 'lease.changed' })),
    ).rejects.toThrow('commit failed');
    await expect(
      write(hub, async (s) => {
        s.core.broadcast({ type: 'lease.changed' });
        throw new Error('body failed');
      }),
    ).rejects.toThrow('body failed');
    expect(ws.got).toEqual([]);
    await reg.closeAll();
  });

  it('a hub opened on its own delivers to its own sockets', async () => {
    const hub = await SessionHub.open('s1', fakeStorage());
    const ws = recordingSocket();
    hub.attachSocket(ws, 'browser');
    await write(hub, async (s) => s.core.broadcast({ type: 'transport.changed' }));
    hub.broadcastCommand('record-start');
    expect(ws.got).toEqual([
      { type: 'transport.changed' },
      { type: 'command', command: 'record-start' },
    ]);
    await hub.close();
  });

  it('relays only the contract’s commands', async () => {
    expect([...SESSION_COMMANDS].sort()).toEqual([
      'play-toggle',
      'record-start',
      'record-stop',
      'record-toggle',
    ]);
    const reg = new SessionHubRegistry({ storage: () => fakeStorage() });
    const hub = await reg.get('s1');
    const sender = recordingSocket();
    const ws = recordingSocket();
    hub.attachSocket(sender, 'browser');
    hub.attachSocket(ws, 'browser');
    hub.handleSocketMessage(JSON.stringify({ type: 'command', command: 'self-destruct' }), sender);
    hub.handleSocketMessage(JSON.stringify({ type: 'command', command: 'record-stop' }), sender);
    hub.broadcastCommand('format-disk');
    hub.broadcastCommand('play-toggle');
    expect(ws.got).toEqual([
      { type: 'command', command: 'record-stop' },
      { type: 'command', command: 'play-toggle' },
    ]);
    await reg.closeAll();
  });

  it('drops a socket’s 11th command within one second, and not another socket’s', async () => {
    let now = 1_000_000;
    const clock = { now: () => now };
    const reg = new SessionHubRegistry({ storage: () => fakeStorage(), clock });
    const hub = await reg.get('s1');
    const flooder = recordingSocket();
    const other = recordingSocket();
    const ws = recordingSocket();
    for (const s of [flooder, other, ws]) hub.attachSocket(s, 'browser');
    const cmd = JSON.stringify({ type: 'command', command: 'record-toggle' });
    for (let i = 0; i < 11; i += 1) {
      hub.handleSocketMessage(cmd, flooder);
      now += 50; // 11 commands in 550 ms
    }
    expect(ws.got).toHaveLength(10);
    hub.handleSocketMessage(cmd, other);
    expect(ws.got).toHaveLength(11);
    now += 1000; // the bucket refills
    hub.handleSocketMessage(cmd, flooder);
    expect(ws.got).toHaveLength(12);
    // The Companion route's command is not rate-limited here (D4).
    for (let i = 0; i < 15; i += 1) hub.broadcastCommand('play-toggle');
    expect(ws.got).toHaveLength(27);
    await reg.closeAll();
  });

  it('without a socket, one bucket per hub limits the commands', async () => {
    let now = 1_000_000;
    const reg = new SessionHubRegistry({ storage: () => fakeStorage(), clock: { now: () => now } });
    const hub = await reg.get('s1');
    const ws = recordingSocket();
    hub.attachSocket(ws, 'browser');
    const cmd = JSON.stringify({ type: 'command', command: 'play-toggle' });
    for (let i = 0; i < 11; i += 1) hub.handleSocketMessage(cmd);
    expect(ws.got).toHaveLength(10);
    // A socket's own bucket is separate from the hub's.
    hub.handleSocketMessage(cmd, recordingSocket());
    expect(ws.got).toHaveLength(11);
    now += 1000;
    hub.handleSocketMessage(cmd);
    expect(ws.got).toHaveLength(12);
    await reg.closeAll();
  });

  it('a close reaches the user’s sockets on the named sessions', async () => {
    const reg = new SessionHubRegistry({ storage: () => fakeStorage() });
    const [one, two] = await Promise.all([reg.get('s1'), reg.get('s2')]);
    const m1 = recordingSocket();
    const m2 = recordingSocket();
    const other = recordingSocket();
    one.attachSocket(m1, 'browser', 'user-m');
    two.attachSocket(m2, 'browser', 'user-m');
    one.attachSocket(other, 'browser', 'user-x');
    reg.bus.afterCommit([{ k: 'close', u: 'user-m', s: ['s1'], c: 4403 }]);
    expect(m1.closes).toEqual([4403]);
    expect(m2.closes).toEqual([]);
    expect(other.closes).toEqual([]);
    reg.bus.afterCommit([{ k: 'close', u: 'user-m', s: 'all', c: 4403 }]);
    expect(m2.closes).toEqual([4403]);
    // Detached at once: a later frame no longer reaches the closed sockets.
    await write(one, async (s) => s.core.broadcast({ type: 'event.changed', revision: 1 }));
    expect(m1.got).toEqual([]);
    expect(other.got).toEqual([{ type: 'event.changed', revision: 1 }]);
    await reg.closeAll();
  });

  it('closeAllSockets closes every socket of every live hub with the code', async () => {
    const reg = new SessionHubRegistry({ storage: () => fakeStorage() });
    const [one, two] = await Promise.all([reg.get('s1'), reg.get('s2')]);
    const a = recordingSocket();
    const b = recordingSocket();
    one.attachSocket(a, 'browser', 'user-a');
    two.attachSocket(b, 'companion');
    expect(reg.closeAllSockets(1012)).toBe(2);
    expect([a.closes, b.closes]).toEqual([[1012], [1012]]);
    expect(reg.closeAllSockets(1012)).toBe(0);
    await reg.closeAll();
  });
});

describe('the hub on a supplied bus', () => {
  function spyBus(failPublish: () => boolean = () => false) {
    const calls: Array<
      | { op: 'publishInTx'; t: SessionSql; msgs: readonly BusMessage[] }
      | { op: 'afterCommit'; msgs: readonly BusMessage[] }
      | { op: 'publishNow'; msg: BusMessage }
    > = [];
    const bus: SessionFrameBus = {
      async publishInTx(t, msgs) {
        calls.push({ op: 'publishInTx', t, msgs });
        if (failPublish()) throw new Error('notify failed');
      },
      afterCommit: (msgs) => void calls.push({ op: 'afterCommit', msgs }),
      publishNow: async (msg) => void calls.push({ op: 'publishNow', msg }),
    };
    return { bus, calls };
  }

  it('publishes each attempt’s frames on that attempt’s raw handle, then hands over the committed ones', async () => {
    const handles: SessionSql[] = [];
    const { bus, calls } = spyBus();
    const reg = new SessionHubRegistry({
      storage: () => fakeStorage({ attempts: 2, handles }),
      bus,
    });
    const hub = await reg.get('s1');
    calls.length = 0;
    handles.length = 0;
    let attempt = 0;
    await write(hub, async (s) => {
      attempt += 1;
      s.core.broadcast({ type: 'event.changed', attempt });
    });
    const frame = (n: number): BusMessage => ({
      k: 'frame',
      s: 's1',
      f: JSON.stringify({ type: 'event.changed', attempt: n }),
    });
    expect(calls).toEqual([
      { op: 'publishInTx', t: handles[0], msgs: [frame(1)] },
      { op: 'publishInTx', t: handles[1], msgs: [frame(2)] },
      { op: 'afterCommit', msgs: [frame(2)] },
    ]);
    // The raw handles the storage gave, not the core's counting handle.
    expect(calls[0]?.op === 'publishInTx' && calls[0].t).toBe(handles[0]);
    await reg.closeAll();
  });

  it('a failed publish fails the write and hands nothing over; a write with no frames publishes nothing', async () => {
    let failPublish = false;
    const { bus, calls } = spyBus(() => failPublish);
    const reg = new SessionHubRegistry({ storage: () => fakeStorage(), bus });
    const hub = await reg.get('s1');
    calls.length = 0;
    await write(hub, async () => undefined);
    expect(calls).toEqual([]);
    failPublish = true;
    await expect(
      write(hub, async (s) => s.core.broadcast({ type: 'lease.changed' })),
    ).rejects.toThrow('notify failed');
    expect(calls.map((c) => c.op)).toEqual(['publishInTx']);
    await reg.closeAll();
  });

  it('a relayed command is published at once, as a command frame of the session', async () => {
    const { bus, calls } = spyBus();
    const reg = new SessionHubRegistry({ storage: () => fakeStorage(), bus });
    const hub = await reg.get('s1');
    calls.length = 0;
    hub.handleSocketMessage(JSON.stringify({ type: 'command', command: 'record-start' }));
    hub.broadcastCommand('play-toggle');
    expect(calls).toEqual([
      {
        op: 'publishNow',
        msg: { k: 'frame', s: 's1', f: '{"type":"command","command":"record-start"}' },
      },
      {
        op: 'publishNow',
        msg: { k: 'frame', s: 's1', f: '{"type":"command","command":"play-toggle"}' },
      },
    ]);
    expect([...SESSION_FRAME_TYPES].sort()).toEqual([
      'audio.changed',
      'command',
      'event.changed',
      'lease.changed',
      'transport.changed',
    ]);
    await reg.closeAll();
  });
});
