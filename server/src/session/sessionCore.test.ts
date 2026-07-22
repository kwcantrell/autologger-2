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

  it('presence counts fake sockets by role', () => {
    const { core, sockets } = fakeRuntime();
    sockets.add({ send: () => {}, role: 'companion' });
    expect(core.presence()).toEqual({ browsers: 1, companions: 1 });
  });
});
