// SessionCore against a fake SessionRuntime — proves the seam is substitutable:
// in-memory SQL (no database file), fake sockets, captured alarms. Domain
// stores run unmodified on the fake substrate.

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { sqliteSessionSql } from './SessionHub';
import { SessionCore } from './sessionCore';
import type { AttachedSocket, SessionRuntime } from './sessionCore';
import { EventStore } from './eventStore';
import { TopicStore } from './topicStore';

function fakeRuntime(): {
  core: SessionCore;
  sent: string[];
  alarms: number[];
  sockets: Set<AttachedSocket>;
  time: { now: number };
} {
  const sent: string[] = [];
  const alarms: number[] = [];
  const time = { now: 1_000_000 };
  const sockets = new Set<AttachedSocket>();
  sockets.add({ send: (d) => sent.push(d), role: 'browser' });
  const runtime: SessionRuntime = {
    sql: sqliteSessionSql(new Database(':memory:')),
    clock: { now: () => time.now },
    sockets: () => sockets,
    setAlarm: (atMs) => alarms.push(atMs),
  };
  const core = new SessionCore(runtime);
  core.initSchema();
  return { core, sent, alarms, sockets, time };
}

describe('SessionCore on a fake runtime', () => {
  it('initSchema is idempotent and seeds the revision counter', () => {
    const { core } = fakeRuntime();
    core.initSchema(); // second run must not throw
    expect(core.revision()).toBe(0);
    core.bumpRevision();
    expect(core.revision()).toBe(1);
  });

  it('initSchema creates the enrichment tables + ordinal indexes, empty, and re-init is idempotent', () => {
    const { core } = fakeRuntime();

    const tableNames = core.db
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_transcript_paragraphs', 'session_transcript_sentiment')",
      )
      .map((r) => r.name)
      .sort();
    expect(tableNames).toEqual(['session_transcript_paragraphs', 'session_transcript_sentiment']);

    const indexNames = core.db
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_paragraphs_ordinal', 'idx_sentiment_ordinal')",
      )
      .map((r) => r.name)
      .sort();
    expect(indexNames).toEqual(['idx_paragraphs_ordinal', 'idx_sentiment_ordinal']);

    expect(core.db.all('SELECT * FROM session_transcript_paragraphs')).toEqual([]);
    expect(core.db.all('SELECT * FROM session_transcript_sentiment')).toEqual([]);

    // Re-running initSchema on an already-existing DB (the registry's reopen path) must not
    // throw and must leave the tables intact and still empty.
    core.initSchema();
    expect(core.db.all('SELECT * FROM session_transcript_paragraphs')).toEqual([]);
    expect(core.db.all('SELECT * FROM session_transcript_sentiment')).toEqual([]);
  });

  it('broadcast fans out to the fake sockets', () => {
    const { core, sent } = fakeRuntime();
    core.broadcast({ type: 'x', v: 1 });
    expect(sent.map((d) => JSON.parse(d))).toEqual([{ type: 'x', v: 1 }]);
  });

  it('setAlarm reaches the fake scheduler', () => {
    const { core, alarms } = fakeRuntime();
    core.setAlarm(12345);
    expect(alarms).toEqual([12345]);
  });

  it('domain stores work over the fake runtime (events + topics)', () => {
    const { core, sent } = fakeRuntime();
    const events = new EventStore(core);
    const added = events.addEvent({
      category: 'mark',
      message: 'hello',
      metadataJson: '{}',
      markedAtUtc: null,
      ctx: { frameRate: 30, startOffsetFrames: 0 },
    });
    expect(added.event.message).toBe('hello');
    expect(core.projection().event_count).toBe(1);
    expect(sent.length).toBeGreaterThan(0); // events.changed fan-out happened

    const topics = new TopicStore(core);
    const t = topics.insertTopic({
      session_time: '00:00:01',
      duration_sec: 5,
      topic_level: 1,
      summary: 's',
    });
    expect(topics.deleteTopic(t.id)).toBe(true);
    expect(topics.deleteTopic(t.id)).toBe(false); // affected-row count drives the miss
  });

  // topic-generation design D3's crash-safe swap primitive: deleteTopics must
  // remove ONLY the given ids and leave every other topic row byte-for-byte
  // untouched (same id/ordinal/summary/created_at) -- this is load-bearing
  // for "prior topics untouched" on the swap's failure path.
  it('deleteTopics bulk-deletes only the given ids, leaving the others untouched', () => {
    const { core } = fakeRuntime();
    const topics = new TopicStore(core);
    const a = topics.insertTopic({
      session_time: '00:00:01',
      duration_sec: 5,
      topic_level: 1,
      summary: 'a',
    });
    const b = topics.insertTopic({
      session_time: '00:00:02',
      duration_sec: 5,
      topic_level: 1,
      summary: 'b',
    });
    const c = topics.insertTopic({
      session_time: '00:00:03',
      duration_sec: 5,
      topic_level: 1,
      summary: 'c',
    });

    topics.deleteTopics([b.id]);

    const remaining = topics.listTopics();
    expect(remaining.map((t) => t.id).sort()).toEqual([a.id, c.id].sort());
    // The surviving rows are byte-for-byte unchanged, not just present.
    expect(remaining.find((t) => t.id === a.id)).toEqual(a);
    expect(remaining.find((t) => t.id === c.id)).toEqual(c);
    expect(remaining.find((t) => t.id === b.id)).toBeUndefined();

    // Empty array is a no-op: nothing is deleted.
    topics.deleteTopics([]);
    expect(topics.listTopics()).toHaveLength(2);
  });

  // Phase-9 fix-wave (finding 1): SessionHub.anchorImportedTake's composite
  // relies on this to keep its per-write broadcasts out of the in-transaction
  // path — DB write still applies, only the broadcast is skipped.
  it('addEvent({ suppressBroadcast: true }) still persists and bumps revision but broadcasts nothing', () => {
    const { core, sent } = fakeRuntime();
    const events = new EventStore(core);
    const added = events.addEvent({
      category: 'internal',
      message: 'Recording 1 Started',
      metadataJson: '{}',
      markedAtUtc: null,
      ctx: { frameRate: 30, startOffsetFrames: 0 },
      suppressBroadcast: true,
    });
    expect(added.event.message).toBe('Recording 1 Started');
    expect(core.projection().event_count).toBe(1);
    expect(core.revision()).toBe(1); // revision still bumped
    expect(sent).toEqual([]); // no event.changed reached the socket
  });

  // code-health-tail D10: the core owns the event-count SQL; both consumers
  // (EventStore.listEvents, TransportStore.statusLive) pin the same semantics
  // over a real core in their own suites.
  it('eventCounts: total counts all rows, logged excludes internal (case/space-insensitively)', () => {
    const { core } = fakeRuntime();
    const categories = ['mark', 'internal', ' Internal ', 'INTERNAL', 'internally'];
    categories.forEach((cat, i) => {
      core.db.run(
        `INSERT INTO events (id, wall_time_utc, frame_rate, category, message)
         VALUES (?, ?, ?, ?, ?)`,
        `e${i}`,
        '2026-06-25T00:00:00.000Z',
        30,
        cat,
        `m${i}`,
      );
    });
    expect(core.eventCounts()).toEqual({ total: 5, logged: 2 });
  });

  it('presence counts fake sockets by role', () => {
    const { core, sockets } = fakeRuntime();
    sockets.add({ send: () => {}, role: 'companion' });
    expect(core.presence()).toEqual({ browsers: 1, companions: 1 });
  });
});

// code-health-consolidation task 2.1 (design D1): post-commit broadcast queue
// mechanics at the core seam — enqueue while a hold scope is open, flush in
// enqueue order on outermost success, discard the whole queue on an escaping
// throw. The real commit placement (flush strictly after better-sqlite3
// commits) is pinned at the hub level in SessionHub.test.ts.
describe('SessionCore.withBroadcastsHeld (post-commit broadcast queue, D1)', () => {
  it('outside any hold scope, broadcast sends immediately (composite pairs / broadcastCommand path)', () => {
    const { core, sent } = fakeRuntime();
    core.broadcast({ type: 'x', v: 1 });
    expect(sent.map((d) => JSON.parse(d))).toEqual([{ type: 'x', v: 1 }]);
  });

  it('holds broadcasts during the scope and flushes them in enqueue order after it succeeds', () => {
    const { core, sent } = fakeRuntime();
    core.withBroadcastsHeld(() => {
      core.broadcast({ type: 'a', n: 1 });
      core.broadcast({ type: 'b', n: 2 });
      // Nothing reaches a socket while the scope (i.e. the transaction) is open.
      expect(sent).toEqual([]);
    });
    expect(sent.map((d) => JSON.parse(d))).toEqual([
      { type: 'a', n: 1 },
      { type: 'b', n: 2 },
    ]);
  });

  it('discards the queue on a mid-scope throw — no frame for a rolled-back write', () => {
    const { core, sent } = fakeRuntime();
    expect(() =>
      core.withBroadcastsHeld(() => {
        core.broadcast({ type: 'a' });
        throw new Error('simulated commit failure');
      }),
    ).toThrow('simulated commit failure');
    expect(sent).toEqual([]);
    // The queue is empty, not deferred: a later successful scope emits only its own frames.
    core.withBroadcastsHeld(() => core.broadcast({ type: 'b' }));
    expect(sent.map((d) => JSON.parse(d))).toEqual([{ type: 'b' }]);
  });

  it('nested scopes flush at the OUTERMOST successful exit only', () => {
    const { core, sent } = fakeRuntime();
    core.withBroadcastsHeld(() => {
      core.withBroadcastsHeld(() => core.broadcast({ type: 'inner' }));
      // Inner scope exited successfully, but the outer is still open: no flush yet.
      expect(sent).toEqual([]);
      core.broadcast({ type: 'outer' });
    });
    expect(sent.map((d) => JSON.parse(d))).toEqual([{ type: 'inner' }, { type: 'outer' }]);
  });

  it('a throw escaping nested scopes discards the WHOLE queue, inner enqueues included', () => {
    const { core, sent } = fakeRuntime();
    expect(() =>
      core.withBroadcastsHeld(() => {
        core.withBroadcastsHeld(() => core.broadcast({ type: 'inner' }));
        throw new Error('outer failure');
      }),
    ).toThrow('outer failure');
    expect(sent).toEqual([]);
  });

  it('flush preserves per-socket isolation: one throwing socket does not abort delivery of remaining queued frames to healthy sockets', () => {
    const { core, sent, sockets } = fakeRuntime();
    const healthy2: string[] = [];
    sockets.add({
      send: () => {
        throw new Error('socket going away');
      },
      role: 'browser',
    });
    sockets.add({ send: (d) => healthy2.push(d), role: 'companion' });
    core.withBroadcastsHeld(() => {
      core.broadcast({ type: 'a' });
      core.broadcast({ type: 'b' });
    });
    // Both healthy sockets received BOTH queued frames despite the bad socket
    // throwing on every send in between.
    expect(sent.map((d) => JSON.parse(d))).toEqual([{ type: 'a' }, { type: 'b' }]);
    expect(healthy2.map((d) => JSON.parse(d))).toEqual([{ type: 'a' }, { type: 'b' }]);
  });
});
