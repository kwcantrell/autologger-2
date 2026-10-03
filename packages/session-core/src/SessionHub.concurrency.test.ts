// The async hub's concurrency contract (async-session-hub design D3-D6, D12): per-session
// serialization with broadcasts in commit order, reads that never see an open write, rollback
// with dropped broadcasts, joins, misuse without deadlock, the relayed command, each atomic D5
// method against its conflicting twin, eviction, draining close, single-flight open and the
// failed-ROLLBACK close. Every hub here runs on a SQL that yields to a timer before each
// statement (test/slowSql.ts), so calls really overlap. An unhandled rejection fails the file;
// every "promptly" case races a 200 ms timer.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventRpc } from '@autologger/domain';
import type Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionHubClosedError, SessionTxMisuseError, sqliteSessionSql } from './asyncSessionSql';
import type { EventStore } from './eventStore';
import { SessionHub, SessionHubRegistry } from './SessionHub';
import type { SessionCore } from './sessionCore';
import { type SlowSql, slowSql } from './test/slowSql';

const unhandled: unknown[] = [];
const trap = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeAll(() => {
  process.on('unhandledRejection', trap);
});
afterAll(() => {
  process.off('unhandledRejection', trap);
  expect(unhandled).toEqual([]);
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autologger-hub-conc-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CTX = { frameRate: 24, startOffsetFrames: 0 };

/** Settles as `p` does, or rejects if `p` takes longer than 200 ms. */
function promptly<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('not settled within 200 ms')), 200);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** The stores a hub transaction body receives (design D3); `tx` joins the transaction. */
interface TxStores {
  core: SessionCore;
  events: EventStore;
  tx<U>(fn: (t: TxStores) => Promise<U>): Promise<U>;
}
type TxHub = { inTxn<T>(fn: (t: TxStores) => Promise<T>): Promise<T> };

const clock = { now: () => Date.now() };

async function slowHub(name = 's1') {
  let sql!: SlowSql;
  const hub = await SessionHub.open(join(dir, `${name}.db`), clock, {
    sql: (db: Database.Database) => {
      sql = slowSql(sqliteSessionSql(db));
      return sql;
    },
  });
  const frames: Record<string, unknown>[] = [];
  hub.attachSocket({ send: (d: string) => void frames.push(JSON.parse(d)) }, 'browser');
  return { hub, frames, sql, tx: hub as unknown as TxHub };
}

const event = (message: string) => ({
  category: 'cam',
  message,
  metadataJson: '{}',
  markedAtUtc: null,
  ctx: CTX,
});

describe('serialization', () => {
  it('two writes on one hub serialize in call order, and broadcasts follow commit order', async () => {
    const { hub, frames } = await slowHub();
    const order: string[] = [];
    await Promise.all([
      hub.addEvent(event('a')).then(() => order.push('a')),
      hub.addEvent(event('b')).then(() => order.push('b')),
    ]);
    expect(order).toEqual(['a', 'b']);
    expect(frames).toEqual([
      { type: 'event.changed', revision: 1 },
      { type: 'event.changed', revision: 2 },
    ]);
    const listed = await hub.listEvents({ limit: 10, offset: 0 });
    expect(listed.events.map((e) => e.message).sort()).toEqual(['a', 'b']);
    await hub.close();
  });

  it('a read issued during a write resolves after it, with the committed state', async () => {
    const { hub } = await slowHub();
    const write = hub.addEvent(event('a'));
    const read = hub.listEvents({ limit: 10, offset: 0 });
    const [, listed] = await Promise.all([write, read]);
    expect(listed.total).toBe(1);
    expect(listed.revision).toBe(1);
    await hub.close();
  });

  it('a read issued during a write that rolls back sees the prior state', async () => {
    const { hub, tx } = await slowHub();
    const write = tx.inTxn(async (t) => {
      await t.events.addEvent(event('doomed'));
      throw new Error('body failed');
    });
    const read = hub.listEvents({ limit: 10, offset: 0 });
    await expect(write).rejects.toThrow('body failed');
    const listed = await read;
    expect(listed.total).toBe(0);
    expect(listed.revision).toBe(0);
    await hub.close();
  });
});

describe('rollback and dropped broadcasts', () => {
  it('a body that throws after awaiting rolls back and drops its broadcasts', async () => {
    const { hub, frames, tx } = await slowHub();
    await expect(
      tx.inTxn(async (t) => {
        await t.events.addEvent(event('x'));
        throw new Error('after await');
      }),
    ).rejects.toThrow('after await');
    expect(frames).toEqual([]);
    expect((await hub.ensure()).event_count).toBe(0);
    await hub.close();
  });

  it('a body that catches a statement error still rolls back, and the call rejects with it', async () => {
    const { hub, frames, tx } = await slowHub();
    await expect(
      tx.inTxn(async (t) => {
        await t.events.addEvent(event('x'));
        await t.core.db.run('INSERT INTO no_such_table VALUES (1)').catch(() => {});
        return 'went on';
      }),
    ).rejects.toThrow('no_such_table');
    expect(frames).toEqual([]);
    expect((await hub.ensure()).event_count).toBe(0);
    await hub.close();
  });
});

describe('joins', () => {
  it('a nested tx joins: an inner failure rolls back the outer writes', async () => {
    const { hub, frames, tx } = await slowHub();
    await expect(
      tx.inTxn(async (t) => {
        await t.events.addEvent(event('outer'));
        await t.tx(async (inner) => {
          await inner.events.addEvent(event('inner'));
          throw new Error('inner failure');
        });
      }),
    ).rejects.toThrow('inner failure');
    expect(frames).toEqual([]);
    expect((await hub.ensure()).event_count).toBe(0);
    await hub.close();
  });

  it('a hub delegate inside its own transaction rejects promptly with SessionTxMisuseError; the outer still commits, and another hub works', async () => {
    const { hub, tx } = await slowHub('a');
    const other = await slowHub('b');
    await tx.inTxn(async (t) => {
      await expect(promptly(hub.addEvent(event('self')))).rejects.toBeInstanceOf(
        SessionTxMisuseError,
      );
      await expect(promptly(hub.listEvents({ limit: 1, offset: 0 }))).rejects.toBeInstanceOf(
        SessionTxMisuseError,
      );
      const { event: added } = await other.hub.addEvent(event('elsewhere'));
      expect(added.message).toBe('elsewhere');
      await t.events.addEvent(event('own'));
    });
    const listed = await hub.listEvents({ limit: 10, offset: 0 });
    expect(listed.events.map((e) => e.message)).toEqual(['own']);
    await hub.close();
    await other.hub.close();
  });
});

describe('the relayed command', () => {
  it('a command relayed during an open transaction is sent at once and survives its rollback', async () => {
    const { hub, frames, tx } = await slowHub();
    let opened!: () => void;
    const isOpen = new Promise<void>((resolve) => {
      opened = resolve;
    });
    let fail!: () => void;
    const failed = new Promise<void>((resolve) => {
      fail = resolve;
    });
    const write = tx.inTxn(async (t) => {
      await t.events.addEvent(event('x'));
      opened();
      await failed;
      throw new Error('rolled back');
    });
    await isOpen;
    hub.handleSocketMessage(JSON.stringify({ type: 'command', command: 'record-start' }));
    expect(frames).toEqual([{ type: 'command', command: 'record-start' }]);
    fail();
    await expect(write).rejects.toThrow('rolled back');
    expect(frames).toEqual([{ type: 'command', command: 'record-start' }]);
    await hub.close();
  });
});

describe('each atomic method against its conflicting twin equals a serial order', () => {
  it('two toggleTake calls from a stopped transport: one start, one stop, ends stopped', async () => {
    const { hub, frames } = await slowHub();
    const [first, second] = await Promise.all([hub.toggleTake(CTX), hub.toggleTake(CTX)]);
    expect(first.state.started).toBe(true);
    expect(second.state.stopped).toBe(true);
    const status = await hub.statusLive(CTX);
    expect(status.is_rolling).toBe(false);
    expect(status.current_take).toBe(1);
    expect(frames).toEqual([
      { type: 'transport.changed', is_rolling: true, current_take: 1 },
      { type: 'transport.changed', is_rolling: false, current_take: 1 },
    ]);
    await hub.close();
  });

  it('two updateEvent merges of one event keep both merges', async () => {
    const { hub } = await slowHub();
    const { event: added } = await hub.addEvent({ ...event('m'), metadataJson: '{"base":0}' });
    const update = (key: string, message: string) =>
      hub.updateEvent({
        eventId: added.event_id,
        category: 'cam',
        message,
        wallTimeUtc: added.wall_time_utc,
        timecodeTotalFrames: 10,
        mergeMetadata: (stored) => JSON.stringify({ ...JSON.parse(stored), [key]: true }),
      });
    const [a, b] = await Promise.all([update('a', 'first'), update('b', 'second')]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const stored = await hub.getEvent(added.event_id);
    expect(JSON.parse(stored?.metadata_json ?? '{}')).toEqual({ base: 0, a: true, b: true });
    expect(stored?.message).toBe('second');
    await hub.close();
  });

  it('updateEvent on a missing event returns null and never calls the merge', async () => {
    const { hub } = await slowHub();
    const merge = vi.fn((stored: string) => stored);
    const result = await hub.updateEvent({
      eventId: 'missing',
      category: 'cam',
      message: 'x',
      wallTimeUtc: '2026-10-03T00:00:00.000Z',
      timecodeTotalFrames: 0,
      mergeMetadata: merge,
    });
    expect(result).toBeNull();
    expect(merge).not.toHaveBeenCalled();
    await hub.close();
  });

  it('two addImportedAudioSegment calls get two different consecutive recording ordinals', async () => {
    const { hub } = await slowHub();
    const input = {
      sessionId: 's1',
      mimeType: 'audio/mpeg',
      startedAtUtc: '2026-10-03T00:00:00.000Z',
      endedAtUtc: '2026-10-03T00:00:05.000Z',
    };
    const [a, b] = await Promise.all([
      hub.addImportedAudioSegment(input),
      hub.addImportedAudioSegment(input),
    ]);
    expect([a.recordingOrdinal, b.recordingOrdinal]).toEqual([1, 2]);
    expect([a.segment.recording_ordinal, b.segment.recording_ordinal]).toEqual([1, 2]);
    expect(a.segment.ordinal).not.toBe(b.segment.ordinal);
    await hub.close();
  });

  it('addImportedAudioSegment counts internal Recording N events, and ignores logged ones', async () => {
    const { hub } = await slowHub();
    await hub.addEvent({ ...event('Recording 7 Started'), category: 'cam' });
    await hub.addEvent({ ...event('Recording 3 Stopped'), category: 'internal' });
    const { recordingOrdinal } = await hub.addImportedAudioSegment({
      sessionId: 's1',
      mimeType: 'audio/mpeg',
      startedAtUtc: null,
      endedAtUtc: null,
    });
    expect(recordingOrdinal).toBe(4);
    await hub.close();
  });

  it('replaceTranscriptWordsRemapped sees the anchors either before or after a concurrent imported take', async () => {
    const { hub } = await slowHub();
    const seen: EventRpc[][] = [];
    const remap = (events: EventRpc[]) => {
      seen.push(events);
      const internal = events.filter((e) => e.category === 'internal').length;
      return {
        words: [
          {
            session_time: '00:00:00:00',
            speaker: '0',
            word: `anchors-${internal}`,
            start_sec: 0,
            end_sec: 1,
          },
        ],
        enrichment: { paragraphs: [], sentiment: [] },
      };
    };
    await Promise.all([
      hub.anchorImportedTake({ recordingOrdinal: 1, durationS: 5, ctx: CTX }),
      hub.replaceTranscriptWordsRemapped(remap),
    ]);
    expect(seen).toHaveLength(1);
    const internal = seen[0].filter((e) => e.category === 'internal').length;
    expect([0, 2]).toContain(internal);
    expect((await hub.listTranscriptWords()).map((w) => w.word)).toEqual([`anchors-${internal}`]);
    await hub.close();
  });

  it('a remap that throws writes nothing', async () => {
    const { hub } = await slowHub();
    await hub.insertTranscriptWord({ session_time: '00:00:00:00', speaker: '0', word: 'kept' });
    await expect(
      hub.replaceTranscriptWordsRemapped(() => {
        throw new Error('no_speech');
      }),
    ).rejects.toThrow('no_speech');
    expect((await hub.listTranscriptWords()).map((w) => w.word)).toEqual(['kept']);
    await hub.close();
  });

  it('two addEventAtTotalFramesIfAbsent calls for one row store it once', async () => {
    const { hub, frames } = await slowHub();
    const row = {
      category: 'cam',
      message: 'imported',
      metadataJson: '{"imported_from_sheets":true}',
      timecodeTotalFrames: 48,
      ctx: CTX,
    };
    const results = await Promise.all([
      hub.addEventAtTotalFramesIfAbsent(row),
      hub.addEventAtTotalFramesIfAbsent(row),
    ]);
    expect(results.map((r) => r.created)).toEqual([true, false]);
    expect((await hub.exportEvents()).map((e) => e.message)).toEqual(['imported']);
    expect(frames).toEqual([{ type: 'event.changed', revision: 1 }]);
    await hub.close();
  });

  it('addEventAtTotalFramesIfAbsent compares categories case-insensitively and ignores internal rows', async () => {
    const { hub } = await slowHub();
    const row = { message: 'm', metadataJson: '{}', timecodeTotalFrames: 24, ctx: CTX };
    await hub.addEventAtTotalFrames({ ...row, category: 'INTERNAL' });
    const first = await hub.addEventAtTotalFramesIfAbsent({ ...row, category: 'cam' });
    expect(first.created).toBe(true);
    const second = await hub.addEventAtTotalFramesIfAbsent({ ...row, category: 'other' });
    expect(second.created).toBe(false);
    await hub.close();
  });
});

describe('lifecycle', () => {
  function registry(opts: { now?: () => number } = {}) {
    const time = { now: 1_000_000 };
    const sqls: SlowSql[] = [];
    const reg = new SessionHubRegistry(
      dir,
      { now: opts.now ?? (() => time.now) },
      {
        sql: (db: Database.Database) => {
          const s = slowSql(sqliteSessionSql(db));
          sqls.push(s);
          return s;
        },
      },
    );
    return { reg, time, sqls };
  }

  it('evictIdle skips a hub with a call in flight or queued, and closes it once idle', async () => {
    const { reg, time } = registry();
    const hub = await reg.get('sess-a');
    const inFlight = hub.addEvent(event('a'));
    const queued = hub.addEvent(event('b'));
    time.now += 11 * 60_000;
    reg.evictIdle();
    await Promise.all([inFlight, queued]);
    expect(await reg.get('sess-a')).toBe(hub);
    time.now += 11 * 60_000;
    reg.evictIdle();
    await expect(hub.listEvents({ limit: 1, offset: 0 })).rejects.toBeInstanceOf(
      SessionHubClosedError,
    );
    const reopened = await reg.get('sess-a');
    expect(reopened).not.toBe(hub);
    expect((await reopened.ensure()).event_count).toBe(2);
    await reg.closeAll();
  });

  it('every call touches the hub, so a reference used steadily is never idle', async () => {
    const { reg, time } = registry();
    const hub = await reg.get('sess-a');
    time.now += 9 * 60_000;
    await hub.ensure();
    time.now += 9 * 60_000;
    reg.evictIdle();
    expect(await reg.get('sess-a')).toBe(hub);
    await reg.closeAll();
  });

  it('close() lets admitted calls finish and rejects new ones with SessionHubClosedError', async () => {
    const { hub } = await slowHub();
    const admitted = hub.addEvent(event('a'));
    const closing = hub.close();
    await expect(promptly(hub.addEvent(event('late')))).rejects.toBeInstanceOf(
      SessionHubClosedError,
    );
    const { event: added } = await admitted;
    expect(added.message).toBe('a');
    await closing;
    const again = hub.close();
    expect(again === closing).toBe(true);
    await again;
    await expect(hub.ensure()).rejects.toBeInstanceOf(SessionHubClosedError);
  });

  it('concurrent gets for one id open once', async () => {
    const { reg } = registry();
    const open = vi.spyOn(SessionHub, 'open');
    const [a, b] = await Promise.all([reg.get('sess-a'), reg.get('sess-a')]);
    expect(a).toBe(b);
    expect(open).toHaveBeenCalledTimes(1);
    open.mockRestore();
    await reg.closeAll();
  });

  it('a failed open leaves nothing behind and the next get retries', async () => {
    const { reg } = registry();
    const open = vi.spyOn(SessionHub, 'open').mockRejectedValueOnce(new Error('open failed'));
    await expect(reg.get('sess-a')).rejects.toThrow('open failed');
    const hub = await reg.get('sess-a');
    expect((await hub.ensure()).event_count).toBe(0);
    expect(open).toHaveBeenCalledTimes(2);
    open.mockRestore();
    await reg.closeAll();
  });

  it('get rejects a path-hostile id, and rejects with SessionHubClosedError after closeAll', async () => {
    const { reg } = registry();
    await expect(reg.get('../escape')).rejects.toThrow('Invalid session id for hub storage');
    const hub = await reg.get('sess-a');
    await reg.closeAll();
    await expect(reg.get('sess-a')).rejects.toBeInstanceOf(SessionHubClosedError);
    await expect(hub.ensure()).rejects.toBeInstanceOf(SessionHubClosedError);
  });

  it('a failed ROLLBACK rejects that call, closes the hub for queued calls, drops it from the registry, and the next get opens a fresh hub', async () => {
    const { reg, sqls } = registry();
    const hub = await reg.get('sess-a');
    await hub.addEvent(event('kept'));
    sqls[0].failNextRollback();
    const failing = hub.saveDashboard({
      id: 'primary',
      config: { widgets: [{ id: 'w', type: 'no_such_widget' }], interactions: [] },
      createdBy: null,
      createdByTurnId: null,
    });
    const queued = hub.addEvent(event('queued'));
    await expect(failing).rejects.toThrow();
    await expect(queued).rejects.toBeInstanceOf(SessionHubClosedError);
    await expect(hub.ensure()).rejects.toBeInstanceOf(SessionHubClosedError);
    const fresh = await reg.get('sess-a');
    expect(fresh).not.toBe(hub);
    const listed = await fresh.listEvents({ limit: 10, offset: 0 });
    expect(listed.events.map((e) => e.message)).toEqual(['kept']);
    await fresh.addEvent(event('after'));
    expect((await fresh.ensure()).event_count).toBe(2);
    await reg.closeAll();
  });
});
