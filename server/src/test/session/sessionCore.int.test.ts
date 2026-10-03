// SessionCore against a fake SessionRuntime — proves the seam is substitutable:
// in-memory SQL (no database file), fake sockets, captured alarms. Domain
// stores run unmodified on the fake substrate. The typed fake runtime this
// file established now lives in ./fakeCore (code-health-tail task 5.2; moved
// to the server with the DB-backed session tests, session-tables D12) so the
// store tests share it.

import { EventStore } from '@autologger/session-core/eventStore';
import { TopicStore } from '@autologger/session-core/topicStore';
import { describe, expect, it } from 'vitest';
import { fakeRuntime } from './fakeCore';

describe('SessionCore on a fake runtime', () => {
  it('initSchema is idempotent and seeds the revision counter', async () => {
    const { core } = await fakeRuntime();
    await core.initSchema(); // second run must not throw
    expect(await core.revision()).toBe(0);
    await core.bumpRevision();
    expect(await core.revision()).toBe(1);
  });

  it('initSchema creates the enrichment tables + ordinal indexes, empty, and re-init is idempotent', async () => {
    const { core } = await fakeRuntime();

    const tableNames = (
      await core.db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_transcript_paragraphs', 'session_transcript_sentiment')",
      )
    )
      .map((r) => r.name)
      .sort();
    expect(tableNames).toEqual(['session_transcript_paragraphs', 'session_transcript_sentiment']);

    const indexNames = (
      await core.db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_paragraphs_ordinal', 'idx_sentiment_ordinal')",
      )
    )
      .map((r) => r.name)
      .sort();
    expect(indexNames).toEqual(['idx_paragraphs_ordinal', 'idx_sentiment_ordinal']);

    expect(await core.db.all('SELECT * FROM session_transcript_paragraphs')).toEqual([]);
    expect(await core.db.all('SELECT * FROM session_transcript_sentiment')).toEqual([]);

    // Re-running initSchema on an already-existing DB (the registry's reopen path) must not
    // throw and must leave the tables intact and still empty.
    await core.initSchema();
    expect(await core.db.all('SELECT * FROM session_transcript_paragraphs')).toEqual([]);
    expect(await core.db.all('SELECT * FROM session_transcript_sentiment')).toEqual([]);
  });

  it('broadcast fans out to the fake sockets', async () => {
    const { core, sent } = await fakeRuntime();
    core.broadcast({ type: 'x', v: 1 });
    expect(sent.map((d) => JSON.parse(d))).toEqual([{ type: 'x', v: 1 }]);
  });

  it('setAlarm reaches the fake scheduler', async () => {
    const { core, alarms } = await fakeRuntime();
    core.setAlarm(12345);
    expect(alarms).toEqual([12345]);
  });

  it('domain stores work over the fake runtime (events + topics)', async () => {
    const { core, sent } = await fakeRuntime();
    const events = new EventStore(core);
    const added = await events.addEvent({
      category: 'mark',
      message: 'hello',
      metadataJson: '{}',
      markedAtUtc: null,
      ctx: { frameRate: 30, startOffsetFrames: 0 },
    });
    expect(added.event.message).toBe('hello');
    expect((await core.projection()).event_count).toBe(1);
    expect(sent.length).toBeGreaterThan(0); // events.changed fan-out happened

    const topics = new TopicStore(core);
    const t = await topics.insertTopic({
      session_time: '00:00:01',
      duration_sec: 5,
      topic_level: 1,
      summary: 's',
    });
    expect(await topics.deleteTopic(t.id)).toBe(true);
    expect(await topics.deleteTopic(t.id)).toBe(false); // affected-row count drives the miss
  });

  // topic-generation design D3's crash-safe swap primitive: deleteTopics must
  // remove ONLY the given ids and leave every other topic row byte-for-byte
  // untouched (same id/ordinal/summary/created_at) -- this is load-bearing
  // for "prior topics untouched" on the swap's failure path.
  it('deleteTopics bulk-deletes only the given ids, leaving the others untouched', async () => {
    const { core } = await fakeRuntime();
    const topics = new TopicStore(core);
    const a = await topics.insertTopic({
      session_time: '00:00:01',
      duration_sec: 5,
      topic_level: 1,
      summary: 'a',
    });
    const b = await topics.insertTopic({
      session_time: '00:00:02',
      duration_sec: 5,
      topic_level: 1,
      summary: 'b',
    });
    const c = await topics.insertTopic({
      session_time: '00:00:03',
      duration_sec: 5,
      topic_level: 1,
      summary: 'c',
    });

    await topics.deleteTopics([b.id]);

    const remaining = await topics.listTopics();
    expect(remaining.map((t) => t.id).sort()).toEqual([a.id, c.id].sort());
    // The surviving rows are byte-for-byte unchanged, not just present.
    expect(remaining.find((t) => t.id === a.id)).toEqual(a);
    expect(remaining.find((t) => t.id === c.id)).toEqual(c);
    expect(remaining.find((t) => t.id === b.id)).toBeUndefined();

    // Empty array is a no-op: nothing is deleted.
    await topics.deleteTopics([]);
    expect(await topics.listTopics()).toHaveLength(2);
  });

  // Phase-9 fix-wave (finding 1): SessionHub.anchorImportedTake's composite
  // relies on this to keep its per-write broadcasts out of the in-transaction
  // path — DB write still applies, only the broadcast is skipped.
  it('addEvent({ suppressBroadcast: true }) still persists and bumps revision but broadcasts nothing', async () => {
    const { core, sent } = await fakeRuntime();
    const events = new EventStore(core);
    const added = await events.addEvent({
      category: 'internal',
      message: 'Recording 1 Started',
      metadataJson: '{}',
      markedAtUtc: null,
      ctx: { frameRate: 30, startOffsetFrames: 0 },
      suppressBroadcast: true,
    });
    expect(added.event.message).toBe('Recording 1 Started');
    expect((await core.projection()).event_count).toBe(1);
    expect(await core.revision()).toBe(1); // revision still bumped
    expect(sent).toEqual([]); // no event.changed reached the socket
  });

  // code-health-tail D10: the core owns the event-count SQL; both consumers
  // (EventStore.listEvents, TransportStore.statusLive) pin the same semantics
  // over a real core in their own suites.
  it('eventCounts: total counts all rows, logged excludes internal (case/space-insensitively)', async () => {
    const { core } = await fakeRuntime();
    const categories = ['mark', 'internal', ' Internal ', 'INTERNAL', 'internally'];
    for (const [i, cat] of categories.entries()) {
      await core.db.run(
        `INSERT INTO events (id, wall_time_utc, frame_rate, category, message)
         VALUES (?, ?, ?, ?, ?)`,
        `e${i}`,
        '2026-06-25T00:00:00.000Z',
        30,
        cat,
        `m${i}`,
      );
    }
    expect(await core.eventCounts()).toEqual({ total: 5, logged: 2 });
  });

  it('presence counts fake sockets by role', async () => {
    const { core, sockets } = await fakeRuntime();
    sockets.add({ send: () => {}, role: 'companion' });
    expect(core.presence()).toEqual({ browsers: 1, companions: 1 });
  });
});

// code-health-consolidation task 2.1 (design D1): post-commit broadcast queue
// mechanics at the core seam — enqueue while a hold scope is open, flush in
// enqueue order on outermost success, discard the whole queue on an escaping
// throw. The queue belongs to the transaction (async-session-hub D3): a core
// bound to a transaction holds its broadcasts until the hub flushes them after
// COMMIT (`flushHeldBroadcasts`) or discards them on failure
// (`discardHeldBroadcasts`); `withBroadcastsHeld` nests a scope inside it. The
// real commit placement (flush strictly after the adapter commits) is pinned at
// the hub level in SessionHub.test.ts.
describe('SessionCore.withBroadcastsHeld (post-commit broadcast queue, D1)', () => {
  it('outside any hold scope, broadcast sends immediately (composite pairs / broadcastCommand path)', async () => {
    const { core, sent } = await fakeRuntime();
    core.broadcast({ type: 'x', v: 1 });
    expect(sent.map((d) => JSON.parse(d))).toEqual([{ type: 'x', v: 1 }]);
  });

  it('holds broadcasts during the scope and flushes them in enqueue order after it succeeds', async () => {
    const { core, sent } = await fakeRuntime();
    const tx = core.forTransaction(core.db);
    await tx.withBroadcastsHeld(async () => {
      tx.broadcast({ type: 'a', n: 1 });
      tx.broadcast({ type: 'b', n: 2 });
      // Nothing reaches a socket while the scope (i.e. the transaction) is open.
      expect(sent).toEqual([]);
    });
    tx.flushHeldBroadcasts(); // the hub, after COMMIT
    expect(sent.map((d) => JSON.parse(d))).toEqual([
      { type: 'a', n: 1 },
      { type: 'b', n: 2 },
    ]);
  });

  it('discards the queue on a mid-scope throw — no frame for a rolled-back write', async () => {
    const { core, sent } = await fakeRuntime();
    const tx = core.forTransaction(core.db);
    await expect(
      tx.withBroadcastsHeld(async () => {
        tx.broadcast({ type: 'a' });
        throw new Error('simulated commit failure');
      }),
    ).rejects.toThrow('simulated commit failure');
    tx.discardHeldBroadcasts(); // the hub, after ROLLBACK
    expect(sent).toEqual([]);
    // The queue is empty, not deferred: a later successful scope emits only its own frames.
    await tx.withBroadcastsHeld(async () => tx.broadcast({ type: 'b' }));
    tx.flushHeldBroadcasts();
    expect(sent.map((d) => JSON.parse(d))).toEqual([{ type: 'b' }]);
  });

  it('nested scopes flush at the OUTERMOST successful exit only', async () => {
    const { core, sent } = await fakeRuntime();
    const tx = core.forTransaction(core.db);
    await tx.withBroadcastsHeld(async () => {
      await tx.withBroadcastsHeld(async () => tx.broadcast({ type: 'inner' }));
      // Inner scope exited successfully, but the outer is still open: no flush yet.
      expect(sent).toEqual([]);
      tx.broadcast({ type: 'outer' });
    });
    tx.flushHeldBroadcasts();
    expect(sent.map((d) => JSON.parse(d))).toEqual([{ type: 'inner' }, { type: 'outer' }]);
  });

  it('a throw escaping nested scopes discards the WHOLE queue, inner enqueues included', async () => {
    const { core, sent } = await fakeRuntime();
    const tx = core.forTransaction(core.db);
    await expect(
      tx.withBroadcastsHeld(async () => {
        await tx.withBroadcastsHeld(async () => tx.broadcast({ type: 'inner' }));
        throw new Error('outer failure');
      }),
    ).rejects.toThrow('outer failure');
    tx.discardHeldBroadcasts();
    expect(sent).toEqual([]);
  });

  it('a broadcast through the root core is not held by an open transaction (a relayed command, D3)', async () => {
    const { core, sent } = await fakeRuntime();
    const tx = core.forTransaction(core.db);
    tx.broadcast({ type: 'held' });
    core.broadcastCommand('record-start');
    expect(sent.map((d) => JSON.parse(d))).toEqual([{ type: 'command', command: 'record-start' }]);
    tx.discardHeldBroadcasts();
    expect(sent.map((d) => JSON.parse(d))).toEqual([{ type: 'command', command: 'record-start' }]);
  });

  it('flush preserves per-socket isolation: one throwing socket does not abort delivery of remaining queued frames to healthy sockets', async () => {
    const { core, sent, sockets } = await fakeRuntime();
    const healthy2: string[] = [];
    sockets.add({
      send: () => {
        throw new Error('socket going away');
      },
      role: 'browser',
    });
    sockets.add({ send: (d) => healthy2.push(d), role: 'companion' });
    const tx = core.forTransaction(core.db);
    await tx.withBroadcastsHeld(async () => {
      tx.broadcast({ type: 'a' });
      tx.broadcast({ type: 'b' });
    });
    tx.flushHeldBroadcasts();
    // Both healthy sockets received BOTH queued frames despite the bad socket
    // throwing on every send in between.
    expect(sent.map((d) => JSON.parse(d))).toEqual([{ type: 'a' }, { type: 'b' }]);
    expect(healthy2.map((d) => JSON.parse(d))).toEqual([{ type: 'a' }, { type: 'b' }]);
  });
});
