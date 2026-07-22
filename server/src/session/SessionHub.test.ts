import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_DASHBOARDS_PER_SESSION } from '../aiV2/catalog';
import { DashboardBoundsError, DashboardValidationError } from './dashboardStore';
import { SessionHub, SessionHubRegistry } from './SessionHub';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'autologger-hub-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CTX = { frameRate: 24, startOffsetFrames: 0 };

describe('SessionHub', () => {
  it('ensure() initializes the schema and returns an empty projection', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    expect(hub.ensure()).toMatchObject({ event_count: 0, is_rolling: false, current_take: 0 });
    hub.close();
  });

  it('addEvent persists atomically with its revision bump', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    const { event, projection } = hub.addEvent({
      category: 'cam',
      message: 'hello',
      metadataJson: '{}',
      markedAtUtc: null,
      ctx: CTX,
    });
    expect(event.message).toBe('hello');
    expect(projection.event_count).toBe(1);
    // Revision bumped in the same transaction as the insert.
    expect(hub.statusLive(CTX).events_stream_revision).toBe(1);
    hub.close();
  });

  it('state survives close + reopen (persisted on disk)', () => {
    const p = join(dir, 's1.db');
    const hub = new SessionHub(p);
    hub.addEvent({ category: 'cam', message: 'x', metadataJson: '{}', markedAtUtc: null, ctx: CTX });
    hub.close();
    const hub2 = new SessionHub(p);
    expect(hub2.ensure().event_count).toBe(1);
    hub2.close();
  });

  it('broadcasts to attached sockets and counts presence by role', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    const got: string[] = [];
    const ws = { send: (d: string) => void got.push(d) };
    hub.attachSocket(ws, 'browser');
    hub.attachSocket({ send: () => {} }, 'companion');
    expect(hub.presence()).toEqual({ browsers: 1, companions: 1 });
    hub.broadcastCommand('record-start');
    expect(JSON.parse(got[0])).toMatchObject({ type: 'command', command: 'record-start' });
    hub.detachSocket(ws);
    expect(hub.presence()).toEqual({ browsers: 0, companions: 1 });
    hub.close();
  });

  it('handleSocketMessage re-broadcasts client commands and ignores garbage', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    const got: string[] = [];
    hub.attachSocket({ send: (d: string) => void got.push(d) }, 'browser');
    hub.handleSocketMessage('not json');
    hub.handleSocketMessage(JSON.stringify({ type: 'ping' }));
    hub.handleSocketMessage(JSON.stringify({ type: 'command', command: 'play-toggle' }));
    expect(got).toHaveLength(1);
    expect(JSON.parse(got[0])).toMatchObject({ type: 'command', command: 'play-toggle' });
    hub.close();
  });

  describe('lease timer (single-slot, fake time)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('expires a stale lease via the timer 40s after the last heartbeat', () => {
      const hub = new SessionHub(join(dir, 's1.db'));
      expect(hub.claimLease('client-a')).toBe(true);
      expect(hub.leaseStatus().lease_alive).toBe(true);
      vi.advanceTimersByTime(41_000);
      expect(hub.leaseStatus().lease_alive).toBe(false);
      expect(hub.leaseStatus().holder_client_id).toBeNull();
      hub.close();
    });

    it('heartbeats re-arm the single slot instead of stacking timers', () => {
      const hub = new SessionHub(join(dir, 's1.db'));
      hub.claimLease('client-a');
      vi.advanceTimersByTime(30_000);
      hub.heartbeatLease('client-a');
      vi.advanceTimersByTime(30_000); // 60s after claim, 30s after heartbeat
      expect(hub.leaseStatus().lease_alive).toBe(true); // old timer must not have fired a kill
      vi.advanceTimersByTime(11_000);
      expect(hub.leaseStatus().lease_alive).toBe(false);
      hub.close();
    });

    it('a lease already stale at instantiation is cleaned up (expireIfStale on open)', () => {
      const p = join(dir, 's1.db');
      const hub = new SessionHub(p);
      hub.claimLease('client-a');
      hub.close(); // process "dies" holding the lease
      vi.advanceTimersByTime(60_000);
      const hub2 = new SessionHub(p);
      expect(hub2.leaseStatus().holder_client_id).toBeNull(); // meta rows purged, not just lazily masked
      hub2.close();
    });
  });
});

// youtube-audio-import design D10-D13: composite anchor RPC that synthesizes a
// recorded-take shape (Started → advance → Stopped) around imported audio.
describe('SessionHub.anchorImportedTake (composite anchor RPC)', () => {
  it('anchors Recording N Started at position P and Recording N Stopped at P + trunc(durationS*frameRate)', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    // Establish a non-zero starting position P (via the plain stopTakeWithDuration
    // delegate) so Started/Stopped land at provably distinct timecodes, not both at 0.
    hub.stopTakeWithDuration({ durationS: 3, ctx: CTX }); // P = trunc(3 * 24) = 72

    const { started, stopped, projection } = hub.anchorImportedTake({
      recordingOrdinal: 1,
      durationS: 5,
      ctx: CTX,
    });

    expect(started.category).toBe('internal');
    expect(started.message).toBe('Recording 1 Started');
    expect(started.timecode_total_frames).toBe(72);
    expect(stopped.message).toBe('Recording 1 Stopped');
    expect(stopped.timecode_total_frames).toBe(72 + 120); // 5s @ 24fps = 120 frames
    expect(projection.transport_elapsed_frames).toBe(192);
    expect(projection.is_rolling).toBe(false);
    hub.close();
  });

  it('emits event.changed and transport.changed exactly once each, after commit (Phase-9 fix-wave finding 1)', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    const got: string[] = [];
    hub.attachSocket({ send: (d: string) => void got.push(d) }, 'browser');

    hub.anchorImportedTake({ recordingOrdinal: 1, durationS: 5, ctx: CTX });

    const parsed = got.map((d) => JSON.parse(d));
    // Exactly once each — the composite suppresses the two per-addEvent
    // broadcasts and the stopTakeWithDuration broadcast, then fires ONE
    // event.changed + ONE transport.changed after inTxn commits (design D11:
    // "broadcasts once after commit").
    expect(parsed.filter((m) => m.type === 'event.changed')).toHaveLength(1);
    expect(parsed.filter((m) => m.type === 'transport.changed')).toHaveLength(1);
    // Exact recorded-take shape stopTake emits — stopTakeWithDuration previously
    // broadcast nothing at all.
    expect(parsed).toContainEqual({ type: 'transport.changed', is_rolling: false, current_take: 0 });
    hub.close();
  });

  it('is atomic: a mid-transaction throw on the third write (Stopped) persists none of the three anchor writes AND broadcasts nothing', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    const before = hub.ensure();
    const beforeEvents = hub.listEvents({ limit: 10, offset: 0 });
    const got: string[] = [];
    hub.attachSocket({ send: (d: string) => void got.push(d) }, 'browser');

    // Reach into the store the hub composes to force a synchronous throw on the
    // SECOND addEvent call (the "Stopped" write) — after the "Started" insert and
    // the transport advance have already run inside the same transaction. This
    // proves the whole txn rolls back, not just that the failing statement no-ops.
    const eventsStore = (hub as unknown as { events: { addEvent: (...a: unknown[]) => unknown } })
      .events;
    const original = eventsStore.addEvent.bind(eventsStore);
    let calls = 0;
    const spy = vi.spyOn(eventsStore, 'addEvent').mockImplementation((...args: unknown[]) => {
      calls += 1;
      if (calls === 2) throw new Error('simulated disk-full');
      return original(...args);
    });

    expect(() =>
      hub.anchorImportedTake({ recordingOrdinal: 1, durationS: 5, ctx: CTX }),
    ).toThrow('simulated disk-full');
    spy.mockRestore();

    // DB-persistence check: the Started event and the transport advance, both
    // already applied pre-throw, must be rolled back along with the
    // never-attempted Stopped insert — no dangling Started event, no partial
    // transport advance.
    expect(hub.ensure()).toEqual(before);
    expect(hub.listEvents({ limit: 10, offset: 0 })).toEqual(beforeEvents);
    // Broadcast-suppression check (Phase-9 fix-wave finding 1 — the actual
    // point of this fix): the composite's per-write broadcasts are suppressed
    // and the single post-commit broadcast is only reached when `inTxn`
    // returns successfully, so a mid-transaction throw must reach the
    // subscribed socket with NO event.changed/transport.changed at all —
    // not merely "the DB rolled back".
    expect(got).toEqual([]);
    hub.close();
  });
});

describe('SessionHub.replaceTranscriptWords', () => {
  it('inserts words with start_sec/end_sec and contiguous ordinals from 0', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    const result = hub.replaceTranscriptWords([
      { session_time: '00:00:01:00', speaker: '0', word: 'hello', start_sec: 1, end_sec: 1.4 },
      { session_time: '00:00:02:00', speaker: '1', word: 'world', start_sec: 2, end_sec: 2.5 },
    ]);
    expect(result.map((w) => ({ ...w, id: undefined, created_at_utc: undefined }))).toEqual([
      {
        id: undefined,
        session_time: '00:00:01:00',
        speaker: '0',
        word: 'hello',
        start_sec: 1,
        end_sec: 1.4,
        ordinal: 0,
        created_at_utc: undefined,
      },
      {
        id: undefined,
        session_time: '00:00:02:00',
        speaker: '1',
        word: 'world',
        start_sec: 2,
        end_sec: 2.5,
        ordinal: 1,
        created_at_utc: undefined,
      },
    ]);
    expect(hub.listTranscriptWords()).toEqual(result);
    hub.close();
  });

  it('deletes the prior word set atomically (delete-then-insert replaces, not merges)', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    hub.insertTranscriptWord({ session_time: '00:00:00:00', speaker: '0', word: 'stale' });
    const result = hub.replaceTranscriptWords([
      { session_time: '00:00:05:00', speaker: '0', word: 'fresh', start_sec: 5, end_sec: 5.5 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].word).toBe('fresh');
    expect(result[0].ordinal).toBe(0);
    expect(hub.listTranscriptWords().map((w) => w.word)).toEqual(['fresh']);
    hub.close();
  });

  it('replacing with an empty list clears all existing words', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    hub.insertTranscriptWord({ session_time: '00:00:00:00', speaker: '0', word: 'gone' });
    const result = hub.replaceTranscriptWords([]);
    expect(result).toEqual([]);
    expect(hub.listTranscriptWords()).toEqual([]);
    hub.close();
  });
});

const WORDS = [
  { session_time: '00:00:01:00', speaker: '0', word: 'hello', start_sec: 1, end_sec: 1.4 },
];
const PARAGRAPHS = [{ start_sec: 1, end_sec: 5, speaker: '0', text: 'hello there' }];
const SENTIMENT = [
  { start_sec: 1, end_sec: 5, sentiment: 'positive', sentiment_score: 0.9, text: 'hello there' },
];

describe('SessionHub enrichment persistence (single atomic replace)', () => {
  it('never-generated session reads listTranscriptEnrichment as empty arrays, not error', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    expect(hub.listTranscriptEnrichment()).toEqual({ paragraphs: [], sentiment: [] });
    hub.close();
  });

  it('one call delete-then-inserts words + paragraphs + sentiment together', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    hub.replaceTranscriptWords(WORDS, { paragraphs: PARAGRAPHS, sentiment: SENTIMENT });
    expect(hub.listTranscriptWords()).toHaveLength(1);
    const enrichment = hub.listTranscriptEnrichment();
    expect(enrichment.paragraphs).toMatchObject(PARAGRAPHS);
    expect(enrichment.sentiment).toMatchObject(SENTIMENT);
    expect(enrichment.paragraphs[0].ordinal).toBe(0);
    expect(enrichment.sentiment[0].ordinal).toBe(0);
    hub.close();
  });

  it('a replace with EMPTY enrichment (default) clears prior enrichment', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    hub.replaceTranscriptWords(WORDS, { paragraphs: PARAGRAPHS, sentiment: SENTIMENT });
    hub.replaceTranscriptWords(WORDS); // no enrichment arg — must default to empty
    expect(hub.listTranscriptEnrichment()).toEqual({ paragraphs: [], sentiment: [] });
    hub.close();
  });

  it('preserves NULL start_sec/end_sec through the round trip (never coerced to 0)', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    hub.replaceTranscriptWords(WORDS, {
      paragraphs: [{ start_sec: null, end_sec: null, speaker: '0', text: 'unanchored' }],
      sentiment: [
        { start_sec: null, end_sec: null, sentiment: 'neutral', sentiment_score: 0, text: 'x' },
      ],
    });
    const enrichment = hub.listTranscriptEnrichment();
    expect(enrichment.paragraphs[0].start_sec).toBeNull();
    expect(enrichment.paragraphs[0].end_sec).toBeNull();
    expect(enrichment.sentiment[0].start_sec).toBeNull();
    expect(enrichment.sentiment[0].end_sec).toBeNull();
    hub.close();
  });

  it('lists enrichment in ordinal order (array-position order, not re-sorted)', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    const paragraphs = [
      { start_sec: 5, end_sec: 6, speaker: '0', text: 'second' },
      { start_sec: 1, end_sec: 2, speaker: '0', text: 'first' },
    ];
    hub.replaceTranscriptWords(WORDS, { paragraphs, sentiment: [] });
    expect(hub.listTranscriptEnrichment().paragraphs.map((p) => p.text)).toEqual([
      'second',
      'first',
    ]);
    hub.close();
  });

  it('rolls back words, paragraphs, AND sentiment together when an insert throws mid-transaction (single writer, no partial write)', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    hub.replaceTranscriptWords(WORDS, { paragraphs: PARAGRAPHS, sentiment: SENTIMENT });
    const priorWords = hub.listTranscriptWords();
    const priorEnrichment = hub.listTranscriptEnrichment();

    // `sentiment: null as unknown as string` violates the NOT NULL column
    // constraint on session_transcript_sentiment.sentiment, throwing partway
    // through the single transaction — after words + paragraphs would
    // already have been deleted-and-reinserted.
    expect(() =>
      hub.replaceTranscriptWords(
        [{ session_time: '00:00:09:00', speaker: '0', word: 'new', start_sec: 9, end_sec: 9.5 }],
        {
          paragraphs: [{ start_sec: 9, end_sec: 10, speaker: '0', text: 'new para' }],
          sentiment: [
            {
              start_sec: 9,
              end_sec: 10,
              sentiment: null as unknown as string,
              sentiment_score: 0.1,
              text: 'bad row',
            },
          ],
        },
      ),
    ).toThrow();

    expect(hub.listTranscriptWords()).toEqual(priorWords);
    expect(hub.listTranscriptEnrichment()).toEqual(priorEnrichment);
    hub.close();
  });
});

// --- ai-v2-dashboards task 5.1/5.2/5.3: dashboard persistence (design D5
// ruled session DB, D5a whole-config validation, D5b write-authz/bounds) ---
describe('SessionHub dashboard persistence', () => {
  function validConfig(overrides: Partial<{ title: string }> = {}) {
    return {
      widgets: [
        {
          id: 'w1',
          type: 'session_duration',
          title: overrides.title ?? 'Duration',
          x: 0,
          y: 0,
          w: 4,
          h: 2,
        },
      ],
      interactions: [],
    };
  }

  it('getDashboard returns null for a session with nothing saved', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    expect(hub.getDashboard('primary')).toBeNull();
    hub.close();
  });

  it('saveDashboard then getDashboard round-trips the exact config and records created_by + turn', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    const saved = hub.saveDashboard({
      id: 'primary',
      config: validConfig(),
      createdBy: 'user-1',
      createdByTurnId: 'turn-1',
    });
    expect(saved.config).toEqual(validConfig());
    expect(saved.createdBy).toBe('user-1');
    expect(saved.createdByTurnId).toBe('turn-1');

    const loaded = hub.getDashboard('primary');
    expect(loaded?.config).toEqual(validConfig());
    expect(loaded?.createdBy).toBe('user-1');
    expect(loaded?.createdByTurnId).toBe('turn-1');
    hub.close();
  });

  it('a direct edit (re-save of the same id) updates the config but PRESERVES the original created_by/turn', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    hub.saveDashboard({
      id: 'primary',
      config: validConfig(),
      createdBy: 'user-1',
      createdByTurnId: 'turn-1',
    });
    // A direct-manipulation edit carries no principal/turn of its own in
    // this test (mirrors the route's turnId:null default) — provenance must
    // still point at the ORIGINAL creator, not this edit.
    const edited = hub.saveDashboard({
      id: 'primary',
      config: validConfig({ title: 'Renamed' }),
      createdBy: null,
      createdByTurnId: null,
    });
    expect(edited.config.widgets[0].title).toBe('Renamed');
    expect(edited.createdBy).toBe('user-1');
    expect(edited.createdByTurnId).toBe('turn-1');
    hub.close();
  });

  it('deleteDashboard removes it (removable/replaceable through the interface, design D5b)', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    hub.saveDashboard({
      id: 'primary',
      config: validConfig(),
      createdBy: 'user-1',
      createdByTurnId: null,
    });
    expect(hub.deleteDashboard('primary')).toBe(true);
    expect(hub.getDashboard('primary')).toBeNull();
    expect(hub.deleteDashboard('primary')).toBe(false); // already gone
    hub.close();
  });

  it('rejects (throws DashboardValidationError) an unknown widget type — nothing is stored', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    expect(() =>
      hub.saveDashboard({
        id: 'primary',
        config: { widgets: [{ ...validConfig().widgets[0], type: 'custom_widget' }], interactions: [] },
        createdBy: 'user-1',
        createdByTurnId: null,
      }),
    ).toThrow(DashboardValidationError);
    expect(hub.getDashboard('primary')).toBeNull();
    hub.close();
  });

  it('rejects (throws DashboardValidationError) a javascript: URI title — nothing is stored', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    expect(() =>
      hub.saveDashboard({
        id: 'primary',
        config: validConfig({ title: 'javascript:alert(1)' }),
        createdBy: 'user-1',
        createdByTurnId: null,
      }),
    ).toThrow(DashboardValidationError);
    expect(hub.getDashboard('primary')).toBeNull();
    hub.close();
  });

  it('stores an HTML-bearing title as literal text (allowed — renders inert, task 4.5)', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    const saved = hub.saveDashboard({
      id: 'primary',
      config: validConfig({ title: '<b>Bold</b> title' }),
      createdBy: 'user-1',
      createdByTurnId: null,
    });
    expect(saved.config.widgets[0].title).toBe('<b>Bold</b> title');
    hub.close();
  });

  it('enforces the per-session dashboard-COUNT bound (design D5b): the (MAX+1)th distinct id is rejected, nothing new is stored', () => {
    const hub = new SessionHub(join(dir, 's1.db'));
    for (let i = 0; i < MAX_DASHBOARDS_PER_SESSION; i += 1) {
      hub.saveDashboard({
        id: `dash-${i}`,
        config: validConfig(),
        createdBy: 'user-1',
        createdByTurnId: null,
      });
    }
    expect(hub.listDashboards()).toHaveLength(MAX_DASHBOARDS_PER_SESSION);

    expect(() =>
      hub.saveDashboard({
        id: 'one-too-many',
        config: validConfig(),
        createdBy: 'user-1',
        createdByTurnId: null,
      }),
    ).toThrow(DashboardBoundsError);
    expect(hub.getDashboard('one-too-many')).toBeNull();
    expect(hub.listDashboards()).toHaveLength(MAX_DASHBOARDS_PER_SESSION);

    // Re-saving an EXISTING id, though, is an update — never counted as a
    // new dashboard, so it must NOT trip the count bound even at capacity.
    expect(() =>
      hub.saveDashboard({
        id: 'dash-0',
        config: validConfig({ title: 'Updated at capacity' }),
        createdBy: 'user-1',
        createdByTurnId: null,
      }),
    ).not.toThrow();
    expect(hub.getDashboard('dash-0')?.config.widgets[0].title).toBe('Updated at capacity');
    hub.close();
  });
});

describe('SessionHubRegistry', () => {
  it('returns the same hub per session id and isolates sessions', () => {
    const reg = new SessionHubRegistry(dir);
    const a = reg.get('sess-a');
    expect(reg.get('sess-a')).toBe(a);
    a.addEvent({ category: 'cam', message: 'x', metadataJson: '{}', markedAtUtc: null, ctx: CTX });
    expect(reg.get('sess-b').ensure().event_count).toBe(0);
    reg.closeAll();
  });

  it('rejects path-hostile session ids', () => {
    const reg = new SessionHubRegistry(dir);
    expect(() => reg.get('../escape')).toThrow();
    expect(() => reg.get('a/b')).toThrow();
    reg.closeAll();
  });

  it('evictIdle closes idle hubs (no sockets, no alarm) and they reopen lazily', () => {
    vi.useFakeTimers();
    const reg = new SessionHubRegistry(dir);
    const a = reg.get('sess-a');
    a.addEvent({ category: 'cam', message: 'x', metadataJson: '{}', markedAtUtc: null, ctx: CTX });
    vi.advanceTimersByTime(11 * 60_000);
    reg.evictIdle();
    const reopened = reg.get('sess-a');
    expect(reopened).not.toBe(a);
    expect(reopened.ensure().event_count).toBe(1);
    reg.closeAll();
    vi.useRealTimers();
  });

  it('does not evict a hub with a live socket or an armed lease', () => {
    vi.useFakeTimers();
    const reg = new SessionHubRegistry(dir);
    const withSocket = reg.get('sess-a');
    withSocket.attachSocket({ send: () => {} }, 'browser');
    const withLease = reg.get('sess-b');
    withLease.claimLease('c1');
    vi.advanceTimersByTime(11 * 60_000);
    reg.evictIdle();
    expect(reg.get('sess-a')).toBe(withSocket);
    // sess-b's lease expired at 40s (timer fired), so by 11min it MAY be evictable;
    // re-arm it and check within the armed window instead:
    const armed = reg.get('sess-c');
    armed.claimLease('c2');
    vi.advanceTimersByTime(20_000);
    reg.evictIdle(1); // idleMs=1 → everything idle is evictable, but armed alarm blocks
    expect(reg.get('sess-c')).toBe(armed);
    reg.closeAll();
    vi.useRealTimers();
  });
});
