import { MAX_DASHBOARDS_PER_SESSION } from '@autologger/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DashboardBoundsError,
  DashboardValidationError,
} from '@autologger/session-core/dashboardStore';
import { EventStore } from '@autologger/session-core/eventStore';
import { catalogRoot, createSessionRow, DRIVER_SAFE_FAKE_TIMERS, openTestHub, testRegistry, testStorage } from './sessionRows';

// One session per test (session-tables D12): a hub over its storage; reopening is a second hub on
// the same session.
let sessionId: string;
beforeEach(async () => {
  sessionId = await createSessionRow();
});
const openHub = () => openTestHub(sessionId, testStorage(sessionId));

const CTX = { frameRate: 24, startOffsetFrames: 0 };

/** The transaction-bound stores a hub body receives (design D3); `tx` joins the transaction. */
interface TxStores {
  events: EventStore;
  tx<U>(fn: (t: TxStores) => Promise<U>): Promise<U>;
}
type TxHub = { inTxn<T>(fn: (t: TxStores) => Promise<T>): Promise<T> };

describe('SessionHub', () => {
  it('ensure() initializes the schema and returns an empty projection', async () => {
    const hub = await openHub();
    expect(await hub.ensure()).toMatchObject({
      event_count: 0,
      is_rolling: false,
      current_take: 0,
    });
    await hub.close();
  });

  it('addEvent persists atomically with its revision bump', async () => {
    const hub = await openHub();
    const { event, projection } = await hub.addEvent({
      category: 'cam',
      message: 'hello',
      metadataJson: '{}',
      markedAtUtc: null,
      ctx: CTX,
    });
    expect(event.message).toBe('hello');
    expect(projection.event_count).toBe(1);
    // Revision bumped in the same transaction as the insert.
    expect((await hub.statusLive(CTX)).events_stream_revision).toBe(1);
    await hub.close();
  });

  it('state survives close + reopen (persisted in the database)', async () => {
    const hub = await openHub();
    await hub.addEvent({
      category: 'cam',
      message: 'x',
      metadataJson: '{}',
      markedAtUtc: null,
      ctx: CTX,
    });
    await hub.close();
    const hub2 = await openHub();
    expect((await hub2.ensure()).event_count).toBe(1);
    await hub2.close();
  });

  it('broadcasts to attached sockets and counts presence by role', async () => {
    const hub = await openHub();
    const got: string[] = [];
    const ws = { send: (d: string) => void got.push(d) };
    hub.attachSocket(ws, 'browser');
    hub.attachSocket({ send: () => {} }, 'companion');
    expect(hub.presence()).toEqual({ browsers: 1, companions: 1 });
    hub.broadcastCommand('record-start');
    expect(JSON.parse(got[0])).toMatchObject({ type: 'command', command: 'record-start' });
    hub.detachSocket(ws);
    expect(hub.presence()).toEqual({ browsers: 0, companions: 1 });
    await hub.close();
  });

  it('handleSocketMessage re-broadcasts client commands and ignores garbage', async () => {
    const hub = await openHub();
    const got: string[] = [];
    hub.attachSocket({ send: (d: string) => void got.push(d) }, 'browser');
    hub.handleSocketMessage('not json');
    hub.handleSocketMessage(JSON.stringify({ type: 'ping' }));
    hub.handleSocketMessage(JSON.stringify({ type: 'command', command: 'play-toggle' }));
    expect(got).toHaveLength(1);
    expect(JSON.parse(got[0])).toMatchObject({ type: 'command', command: 'play-toggle' });
    await hub.close();
  });

  describe('lease timer (single-slot, fake time)', () => {
    beforeEach(() => vi.useFakeTimers(DRIVER_SAFE_FAKE_TIMERS));
    afterEach(() => vi.useRealTimers());

    it('expires a stale lease via the timer 40s after the last heartbeat', async () => {
      const hub = await openHub();
      expect(await hub.claimLease('client-a')).toBe(true);
      expect((await hub.leaseStatus()).lease_alive).toBe(true);
      vi.advanceTimersByTime(41_000);
      expect((await hub.leaseStatus()).lease_alive).toBe(false);
      expect((await hub.leaseStatus()).holder_client_id).toBeNull();
      await hub.close();
    });

    it('heartbeats re-arm the single slot instead of stacking timers', async () => {
      const hub = await openHub();
      await hub.claimLease('client-a');
      vi.advanceTimersByTime(30_000);
      await hub.heartbeatLease('client-a');
      vi.advanceTimersByTime(30_000); // 60s after claim, 30s after heartbeat
      expect((await hub.leaseStatus()).lease_alive).toBe(true); // old timer must not have fired a kill
      vi.advanceTimersByTime(11_000);
      expect((await hub.leaseStatus()).lease_alive).toBe(false);
      await hub.close();
    });

    it('a lease already stale at instantiation is cleaned up (expireIfStale on open)', async () => {
      const hub = await openHub();
      await hub.claimLease('client-a');
      await hub.close(); // process "dies" holding the lease
      vi.advanceTimersByTime(60_000);
      const hub2 = await openHub();
      expect((await hub2.leaseStatus()).holder_client_id).toBeNull(); // meta rows purged, not just lazily masked
      await hub2.close();
    });
  });
});

// youtube-audio-import design D10-D13: composite anchor RPC that synthesizes a
// recorded-take shape (Started → advance → Stopped) around imported audio.
describe('SessionHub.anchorImportedTake (composite anchor RPC)', () => {
  it('anchors Recording N Started at position P and Recording N Stopped at P + trunc(durationS*frameRate)', async () => {
    const hub = await openHub();
    // Establish a non-zero starting position P (via the plain stopTakeWithDuration
    // delegate) so Started/Stopped land at provably distinct timecodes, not both at 0.
    await hub.stopTakeWithDuration({ durationS: 3, ctx: CTX }); // P = trunc(3 * 24) = 72

    const { started, stopped, projection } = await hub.anchorImportedTake({
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
    await hub.close();
  });

  it('emits event.changed and transport.changed exactly once each, after commit (Phase-9 fix-wave finding 1)', async () => {
    const hub = await openHub();
    const got: string[] = [];
    hub.attachSocket({ send: (d: string) => void got.push(d) }, 'browser');

    await hub.anchorImportedTake({ recordingOrdinal: 1, durationS: 5, ctx: CTX });

    const parsed = got.map((d) => JSON.parse(d));
    // Exactly once each — the composite suppresses the two per-addEvent
    // broadcasts and the stopTakeWithDuration broadcast, then fires ONE
    // event.changed + ONE transport.changed after inTxn commits (design D11:
    // "broadcasts once after commit").
    expect(parsed.filter((m) => m.type === 'event.changed')).toHaveLength(1);
    expect(parsed.filter((m) => m.type === 'transport.changed')).toHaveLength(1);
    // Exact recorded-take shape stopTake emits — stopTakeWithDuration previously
    // broadcast nothing at all.
    expect(parsed).toContainEqual({
      type: 'transport.changed',
      is_rolling: false,
      current_take: 0,
    });
    await hub.close();
  });

  it('is atomic: a mid-transaction throw on the third write (Stopped) persists none of the three anchor writes AND broadcasts nothing', async () => {
    const hub = await openHub();
    const before = await hub.ensure();
    const beforeEvents = await hub.listEvents({ limit: 10, offset: 0 });
    const got: string[] = [];
    hub.attachSocket({ send: (d: string) => void got.push(d) }, 'browser');

    // Reach into the store the hub composes (each transaction builds its own, so
    // through the class) to force a throw on the SECOND addEvent call (the
    // "Stopped" write) — after the "Started" insert and the transport advance
    // have already run inside the same transaction. This proves the whole txn
    // rolls back, not just that the failing statement no-ops.
    const original = EventStore.prototype.addEvent;
    let calls = 0;
    const spy = vi.spyOn(EventStore.prototype, 'addEvent').mockImplementation(function (
      this: EventStore,
      ...args
    ) {
      calls += 1;
      if (calls === 2) throw new Error('simulated disk-full');
      return original.apply(this, args);
    });

    await expect(
      hub.anchorImportedTake({ recordingOrdinal: 1, durationS: 5, ctx: CTX }),
    ).rejects.toThrow('simulated disk-full');
    spy.mockRestore();

    // DB-persistence check: the Started event and the transport advance, both
    // already applied pre-throw, must be rolled back along with the
    // never-attempted Stopped insert — no dangling Started event, no partial
    // transport advance.
    expect(await hub.ensure()).toEqual(before);
    expect(await hub.listEvents({ limit: 10, offset: 0 })).toEqual(beforeEvents);
    // Broadcast-suppression check (Phase-9 fix-wave finding 1 — the actual
    // point of this fix): the composite's per-write broadcasts are suppressed
    // and the single post-commit broadcast is only reached when `inTxn`
    // returns successfully, so a mid-transaction throw must reach the
    // subscribed socket with NO event.changed/transport.changed at all —
    // not merely "the DB rolled back".
    expect(got).toEqual([]);
    await hub.close();
  });
});

// code-health-consolidation task 1.2: pin the EXACT success-path WS broadcast
// frames — types, payload shapes/values (where deterministic), and relative
// order — for one representative mutation per broadcasting store (events,
// transport, audio, lease) plus the ONE composite RPC (anchorImportedTake).
// These are the byte-identity gate the post-commit broadcast-queue change
// (phase 2) MUST keep green: a frame-count, ordering, or payload regression on
// the success path fails here. `toEqual` on the whole captured array is
// deliberate — it pins the frame COUNT (extra/missing frames fail) as well as
// each frame's shape and their order.
describe('SessionHub broadcast frame pins (success-path byte-identity gate)', () => {
  async function capturingHub() {
    const hub = await openHub();
    const frames: Record<string, unknown>[] = [];
    // Attach AFTER construction so the constructor's expireIfStale txn (no
    // holder → no broadcast) can never colour the capture.
    hub.attachSocket({ send: (d: string) => void frames.push(JSON.parse(d)) }, 'browser');
    return { hub, frames };
  }

  it('events: addEvent emits exactly one event.changed carrying the bumped revision', async () => {
    const { hub, frames } = await capturingHub();
    await hub.addEvent({
      category: 'cam',
      message: 'hi',
      metadataJson: '{}',
      markedAtUtc: null,
      ctx: CTX,
    });
    expect(frames).toEqual([{ type: 'event.changed', revision: 1 }]);
    await hub.close();
  });

  it('transport: startTake emits exactly one transport.changed (rolling, take incremented)', async () => {
    const { hub, frames } = await capturingHub();
    await hub.startTake(CTX);
    expect(frames).toEqual([{ type: 'transport.changed', is_rolling: true, current_take: 1 }]);
    await hub.close();
  });

  it('audio: addAudioSegment emits exactly one audio.changed (no payload)', async () => {
    const { hub, frames } = await capturingHub();
    await hub.addAudioSegment({
      sessionId: 's1',
      mimeType: 'audio/webm',
      startedAtUtc: null,
      endedAtUtc: null,
      recordingOrdinal: null,
    });
    expect(frames).toEqual([{ type: 'audio.changed' }]);
    await hub.close();
  });

  it('lease: claimLease emits exactly one lease.changed (no payload)', async () => {
    const { hub, frames } = await capturingHub();
    await hub.claimLease('client-a');
    expect(frames).toEqual([{ type: 'lease.changed' }]);
    await hub.close();
  });

  it('composite: anchorImportedTake emits exactly [event.changed(final revision), transport.changed] in that order and NO intermediate store frames', async () => {
    const { hub, frames } = await capturingHub();
    // Two internal events (Started + Stopped) in one transaction advance the revision once, to 1
    // (session-row-versions D2); the two
    // per-addEvent event.changed frames and stopTakeWithDuration's
    // transport.changed are suppressed inside the txn, and the composite
    // manually emits ONE of each after commit (design D1: atomicity from the
    // queue, frame-count/order from the retained suppressBroadcast flags).
    await hub.anchorImportedTake({ recordingOrdinal: 1, durationS: 5, ctx: CTX });
    expect(frames).toEqual([
      { type: 'event.changed', revision: 1 },
      { type: 'transport.changed', is_rolling: false, current_take: 0 },
    ]);
    await hub.close();
  });
});

// code-health-consolidation phase 2 (design D1, delta "Broadcast atomicity with
// the owning transaction"): the post-commit broadcast queue at the REAL seam —
// the session storage transactions under SessionHub.inTxn.
describe('SessionHub post-commit broadcast queue (D1)', () => {
  async function capturingHub() {
    const hub = await openHub();
    const frames: Record<string, unknown>[] = [];
    hub.attachSocket({ send: (d: string) => void frames.push(JSON.parse(d)) }, 'browser');
    return { hub, frames };
  }

  // Task 2.2 — delta scenario 1 ("Failed commit emits no broadcast"). Hook-free
  // proxy for a commit-step failure: the store call runs for real (insert +
  // revision bump + broadcast enqueue, nothing suppressed), then a throw
  // escapes the transaction before commit — from the queue seam's point of
  // view this is indistinguishable from the adapter's COMMIT itself failing
  // (both reject the transaction). No failure-injection hooks in production
  // inTxn.
  it('a throw escaping the transaction after a broadcast-enqueueing store call emits NO broadcast and persists nothing', async () => {
    const { hub, frames } = await capturingHub();
    const original = EventStore.prototype.addEvent;
    const spy = vi.spyOn(EventStore.prototype, 'addEvent').mockImplementation(async function (
      this: EventStore,
      ...args
    ) {
      await original.apply(this, args); // real write + real (unsuppressed) broadcast enqueue
      throw new Error('simulated commit-step failure');
    });

    await expect(
      hub.addEvent({
        category: 'cam',
        message: 'doomed',
        metadataJson: '{}',
        markedAtUtc: null,
        ctx: CTX,
      }),
    ).rejects.toThrow('simulated commit-step failure');
    spy.mockRestore();

    // The enqueued event.changed was discarded with the rollback: clients see
    // NO notification for the rolled-back write...
    expect(frames).toEqual([]);
    // ...and the write itself is gone (rollback, not just silence).
    expect((await hub.ensure()).event_count).toBe(0);
    expect((await hub.statusLive(CTX)).events_stream_revision).toBe(0);
    await hub.close();
  });

  // Task 2.1 — nested-txn semantics at the real seam. A public hub delegate
  // inside inTxn is refused (design D4), so the inner write goes through a
  // joined `t.tx` on the transaction-bound stores: flush at OUTERMOST commit only.
  it('nested transactions flush at the outermost commit only', async () => {
    const { hub, frames } = await capturingHub();
    await (hub as unknown as TxHub).inTxn(async (t) => {
      // Joined transaction on the bound stores; its broadcast is enqueued.
      await t.tx(async (inner) => {
        await inner.events.addEvent({
          category: 'cam',
          message: 'x',
          metadataJson: '{}',
          markedAtUtc: null,
          ctx: CTX,
        });
      });
      // The joined body finished, but the outermost transaction is still
      // open: nothing may reach a socket yet.
      expect(frames).toEqual([]);
    });
    // Outermost commit: the queued frame flushes, byte-identical to today's.
    expect(frames).toEqual([{ type: 'event.changed', revision: 1 }]);
    await hub.close();
  });

  // Task 2.1 — a throw escaping the outermost transaction discards the WHOLE
  // queue, including frames enqueued by a joined body that had finished.
  it('a throw escaping the outermost transaction discards inner-savepoint broadcasts along with the writes', async () => {
    const { hub, frames } = await capturingHub();
    await expect(
      (hub as unknown as TxHub).inTxn(async (t) => {
        await t.tx(async (inner) => {
          await inner.events.addEvent({
            category: 'cam',
            message: 'x',
            metadataJson: '{}',
            markedAtUtc: null,
            ctx: CTX,
          });
        });
        throw new Error('outer failure');
      }),
    ).rejects.toThrow('outer failure');
    expect(frames).toEqual([]); // no frame for the rolled-back write
    expect((await hub.ensure()).event_count).toBe(0); // joined write rolled back with the outer txn
    await hub.close();
  });
});

describe('SessionHub.replaceTranscriptWords', () => {
  it('inserts words with start_sec/end_sec and contiguous ordinals from 0', async () => {
    const hub = await openHub();
    const result = await hub.replaceTranscriptWords([
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
    expect(await hub.listTranscriptWords()).toEqual(result);
    await hub.close();
  });

  it('deletes the prior word set atomically (delete-then-insert replaces, not merges)', async () => {
    const hub = await openHub();
    await hub.insertTranscriptWord({ session_time: '00:00:00:00', speaker: '0', word: 'stale' });
    const result = await hub.replaceTranscriptWords([
      { session_time: '00:00:05:00', speaker: '0', word: 'fresh', start_sec: 5, end_sec: 5.5 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].word).toBe('fresh');
    expect(result[0].ordinal).toBe(0);
    expect((await hub.listTranscriptWords()).map((w) => w.word)).toEqual(['fresh']);
    await hub.close();
  });

  it('replacing with an empty list clears all existing words', async () => {
    const hub = await openHub();
    await hub.insertTranscriptWord({ session_time: '00:00:00:00', speaker: '0', word: 'gone' });
    const result = await hub.replaceTranscriptWords([]);
    expect(result).toEqual([]);
    expect(await hub.listTranscriptWords()).toEqual([]);
    await hub.close();
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
  it('never-generated session reads listTranscriptEnrichment as empty arrays, not error', async () => {
    const hub = await openHub();
    expect(await hub.listTranscriptEnrichment()).toEqual({ paragraphs: [], sentiment: [] });
    await hub.close();
  });

  it('one call delete-then-inserts words + paragraphs + sentiment together', async () => {
    const hub = await openHub();
    await hub.replaceTranscriptWords(WORDS, { paragraphs: PARAGRAPHS, sentiment: SENTIMENT });
    expect(await hub.listTranscriptWords()).toHaveLength(1);
    const enrichment = await hub.listTranscriptEnrichment();
    expect(enrichment.paragraphs).toMatchObject(PARAGRAPHS);
    expect(enrichment.sentiment).toMatchObject(SENTIMENT);
    expect(enrichment.paragraphs[0].ordinal).toBe(0);
    expect(enrichment.sentiment[0].ordinal).toBe(0);
    await hub.close();
  });

  it('a replace with EMPTY enrichment (default) clears prior enrichment', async () => {
    const hub = await openHub();
    await hub.replaceTranscriptWords(WORDS, { paragraphs: PARAGRAPHS, sentiment: SENTIMENT });
    await hub.replaceTranscriptWords(WORDS); // no enrichment arg — must default to empty
    expect(await hub.listTranscriptEnrichment()).toEqual({ paragraphs: [], sentiment: [] });
    await hub.close();
  });

  it('preserves NULL start_sec/end_sec through the round trip (never coerced to 0)', async () => {
    const hub = await openHub();
    await hub.replaceTranscriptWords(WORDS, {
      paragraphs: [{ start_sec: null, end_sec: null, speaker: '0', text: 'unanchored' }],
      sentiment: [
        { start_sec: null, end_sec: null, sentiment: 'neutral', sentiment_score: 0, text: 'x' },
      ],
    });
    const enrichment = await hub.listTranscriptEnrichment();
    expect(enrichment.paragraphs[0].start_sec).toBeNull();
    expect(enrichment.paragraphs[0].end_sec).toBeNull();
    expect(enrichment.sentiment[0].start_sec).toBeNull();
    expect(enrichment.sentiment[0].end_sec).toBeNull();
    await hub.close();
  });

  it('lists enrichment in ordinal order (array-position order, not re-sorted)', async () => {
    const hub = await openHub();
    const paragraphs = [
      { start_sec: 5, end_sec: 6, speaker: '0', text: 'second' },
      { start_sec: 1, end_sec: 2, speaker: '0', text: 'first' },
    ];
    await hub.replaceTranscriptWords(WORDS, { paragraphs, sentiment: [] });
    expect((await hub.listTranscriptEnrichment()).paragraphs.map((p) => p.text)).toEqual([
      'second',
      'first',
    ]);
    await hub.close();
  });

  it('rolls back words, paragraphs, AND sentiment together when an insert throws mid-transaction (single writer, no partial write)', async () => {
    const hub = await openHub();
    await hub.replaceTranscriptWords(WORDS, { paragraphs: PARAGRAPHS, sentiment: SENTIMENT });
    const priorWords = await hub.listTranscriptWords();
    const priorEnrichment = await hub.listTranscriptEnrichment();

    // `sentiment: null as unknown as string` violates the NOT NULL column
    // constraint on session_transcript_sentiment.sentiment, throwing partway
    // through the single transaction — after words + paragraphs would
    // already have been deleted-and-reinserted.
    await expect(
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
    ).rejects.toThrow();

    expect(await hub.listTranscriptWords()).toEqual(priorWords);
    expect(await hub.listTranscriptEnrichment()).toEqual(priorEnrichment);
    await hub.close();
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

  it('getDashboard returns null for a session with nothing saved', async () => {
    const hub = await openHub();
    expect(await hub.getDashboard('primary')).toBeNull();
    await hub.close();
  });

  it('saveDashboard then getDashboard round-trips the exact config and records created_by + turn', async () => {
    const hub = await openHub();
    const saved = await hub.saveDashboard({
      id: 'primary',
      config: validConfig(),
      createdBy: 'user-1',
      createdByTurnId: 'turn-1',
    });
    expect(saved.config).toEqual(validConfig());
    expect(saved.createdBy).toBe('user-1');
    expect(saved.createdByTurnId).toBe('turn-1');

    const loaded = await hub.getDashboard('primary');
    expect(loaded?.config).toEqual(validConfig());
    expect(loaded?.createdBy).toBe('user-1');
    expect(loaded?.createdByTurnId).toBe('turn-1');
    await hub.close();
  });

  it('a direct edit (re-save of the same id) updates the config but PRESERVES the original created_by/turn', async () => {
    const hub = await openHub();
    await hub.saveDashboard({
      id: 'primary',
      config: validConfig(),
      createdBy: 'user-1',
      createdByTurnId: 'turn-1',
    });
    // A direct-manipulation edit carries no principal/turn of its own in
    // this test (mirrors the route's turnId:null default) — provenance must
    // still point at the ORIGINAL creator, not this edit.
    const edited = await hub.saveDashboard({
      id: 'primary',
      config: validConfig({ title: 'Renamed' }),
      createdBy: null,
      createdByTurnId: null,
    });
    expect(edited.config.widgets[0].title).toBe('Renamed');
    expect(edited.createdBy).toBe('user-1');
    expect(edited.createdByTurnId).toBe('turn-1');
    await hub.close();
  });

  it('deleteDashboard removes it (removable/replaceable through the interface, design D5b)', async () => {
    const hub = await openHub();
    await hub.saveDashboard({
      id: 'primary',
      config: validConfig(),
      createdBy: 'user-1',
      createdByTurnId: null,
    });
    expect(await hub.deleteDashboard('primary')).toBe(true);
    expect(await hub.getDashboard('primary')).toBeNull();
    expect(await hub.deleteDashboard('primary')).toBe(false); // already gone
    await hub.close();
  });

  it('rejects (throws DashboardValidationError) an unknown widget type — nothing is stored', async () => {
    const hub = await openHub();
    await expect(
      hub.saveDashboard({
        id: 'primary',
        config: {
          widgets: [{ ...validConfig().widgets[0], type: 'custom_widget' }],
          interactions: [],
        },
        createdBy: 'user-1',
        createdByTurnId: null,
      }),
    ).rejects.toThrow(DashboardValidationError);
    expect(await hub.getDashboard('primary')).toBeNull();
    await hub.close();
  });

  it('rejects (throws DashboardValidationError) a javascript: URI title — nothing is stored', async () => {
    const hub = await openHub();
    await expect(
      hub.saveDashboard({
        id: 'primary',
        config: validConfig({ title: 'javascript:alert(1)' }),
        createdBy: 'user-1',
        createdByTurnId: null,
      }),
    ).rejects.toThrow(DashboardValidationError);
    expect(await hub.getDashboard('primary')).toBeNull();
    await hub.close();
  });

  it('stores an HTML-bearing title as literal text (allowed — renders inert, task 4.5)', async () => {
    const hub = await openHub();
    const saved = await hub.saveDashboard({
      id: 'primary',
      config: validConfig({ title: '<b>Bold</b> title' }),
      createdBy: 'user-1',
      createdByTurnId: null,
    });
    expect(saved.config.widgets[0].title).toBe('<b>Bold</b> title');
    await hub.close();
  });

  it('enforces the per-session dashboard-COUNT bound (design D5b): the (MAX+1)th distinct id is rejected, nothing new is stored', async () => {
    const hub = await openHub();
    for (let i = 0; i < MAX_DASHBOARDS_PER_SESSION; i += 1) {
      await hub.saveDashboard({
        id: `dash-${i}`,
        config: validConfig(),
        createdBy: 'user-1',
        createdByTurnId: null,
      });
    }
    expect(await hub.listDashboards()).toHaveLength(MAX_DASHBOARDS_PER_SESSION);

    await expect(
      hub.saveDashboard({
        id: 'one-too-many',
        config: validConfig(),
        createdBy: 'user-1',
        createdByTurnId: null,
      }),
    ).rejects.toThrow(DashboardBoundsError);
    expect(await hub.getDashboard('one-too-many')).toBeNull();
    expect(await hub.listDashboards()).toHaveLength(MAX_DASHBOARDS_PER_SESSION);

    // Re-saving an EXISTING id, though, is an update — never counted as a
    // new dashboard, so it must NOT trip the count bound even at capacity.
    await expect(
      hub.saveDashboard({
        id: 'dash-0',
        config: validConfig({ title: 'Updated at capacity' }),
        createdBy: 'user-1',
        createdByTurnId: null,
      }),
    ).resolves.not.toThrow();
    expect((await hub.getDashboard('dash-0'))?.config.widgets[0].title).toBe('Updated at capacity');
    await hub.close();
  });
});

describe('SessionHubRegistry', () => {
  it('returns the same hub per session id and isolates sessions', async () => {
    const reg = testRegistry({ autoCreate: true });
    const a = await reg.get('sess-a');
    expect(await reg.get('sess-a')).toBe(a);
    await a.addEvent({
      category: 'cam',
      message: 'x',
      metadataJson: '{}',
      markedAtUtc: null,
      ctx: CTX,
    });
    expect((await (await reg.get('sess-b')).ensure()).event_count).toBe(0);
    await reg.closeAll();
  });

  it('rejects path-hostile session ids', async () => {
    const reg = testRegistry({ autoCreate: true });
    await expect(reg.get('../escape')).rejects.toThrow();
    await expect(reg.get('a/b')).rejects.toThrow();
    await reg.closeAll();
  });

  it('evictIdle closes idle hubs (no sockets, no alarm) and they reopen lazily', async () => {
    vi.useFakeTimers(DRIVER_SAFE_FAKE_TIMERS);
    const reg = testRegistry({ autoCreate: true });
    const a = await reg.get('sess-a');
    await a.addEvent({
      category: 'cam',
      message: 'x',
      metadataJson: '{}',
      markedAtUtc: null,
      ctx: CTX,
    });
    vi.advanceTimersByTime(11 * 60_000);
    reg.evictIdle();
    const reopened = await reg.get('sess-a');
    expect(reopened).not.toBe(a);
    expect((await reopened.ensure()).event_count).toBe(1);
    await reg.closeAll();
    vi.useRealTimers();
  });

  it('does not evict a hub with a live socket or an armed lease', async () => {
    vi.useFakeTimers(DRIVER_SAFE_FAKE_TIMERS);
    const reg = testRegistry({ autoCreate: true });
    const withSocket = await reg.get('sess-a');
    withSocket.attachSocket({ send: () => {} }, 'browser');
    const withLease = await reg.get('sess-b');
    await withLease.claimLease('c1');
    vi.advanceTimersByTime(11 * 60_000);
    reg.evictIdle();
    expect(await reg.get('sess-a')).toBe(withSocket);
    // sess-b's lease expired at 40s (timer fired), so by 11min it MAY be evictable;
    // re-arm it and check within the armed window instead:
    const armed = await reg.get('sess-c');
    await armed.claimLease('c2');
    vi.advanceTimersByTime(20_000);
    reg.evictIdle(1); // idleMs=1 → everything idle is evictable, but armed alarm blocks
    expect(await reg.get('sess-c')).toBe(armed);
    await reg.closeAll();
    vi.useRealTimers();
  });
});

describe('SessionHubRegistry.closeUserSockets (show-grants D20)', () => {
  it("'all' closes that user's sockets on every live hub (the fail-closed path)", async () => {
    const reg = testRegistry({ autoCreate: true });
    const m1 = fakeWs();
    const m3 = fakeWs();
    const other1 = fakeWs();
    (await reg.get('sess-1')).attachSocket(m1, 'browser', 'user-m');
    (await reg.get('sess-3')).attachSocket(m3, 'browser', 'user-m');
    (await reg.get('sess-1')).attachSocket(other1, 'browser', 'user-o');

    expect(reg.closeUserSockets('user-m', 'all', 4403)).toBe(2);
    expect(m1.closed).toEqual([4403]);
    expect(m3.closed).toEqual([4403]);
    expect(other1.closed).toEqual([]);
  });

  type FakeWs = {
    send(d: string): void;
    close(code?: number): void;
    got: string[];
    closed: number[];
  };
  const fakeWs = (): FakeWs => {
    const ws: FakeWs = {
      got: [],
      closed: [],
      send: (d: string) => void ws.got.push(d),
      close: (code?: number) => void ws.closed.push(code ?? 1000),
    };
    return ws;
  };

  it('attachSocket records the user id; only that user’s sockets on the named live sessions close', async () => {
    const reg = testRegistry({ autoCreate: true });
    const s1 = await reg.get('sess-1');
    const s3 = await reg.get('sess-3');
    const m1 = fakeWs(); // M on sess-1: closes
    const m3 = fakeWs(); // M on sess-3 (not named): stays
    const other1 = fakeWs(); // another user on sess-1: stays
    const anon1 = fakeWs(); // attached with no user id: stays
    s1.attachSocket(m1, 'browser', 'user-m');
    s3.attachSocket(m3, 'browser', 'user-m');
    s1.attachSocket(other1, 'browser', 'user-o');
    s1.attachSocket(anon1, 'companion');

    const closed = reg.closeUserSockets('user-m', new Set(['sess-1', 'sess-never']), 4403);

    expect(closed).toBe(1);
    expect(m1.closed).toEqual([4403]);
    expect(m3.closed).toEqual([]);
    expect(other1.closed).toEqual([]);
    expect(anon1.closed).toEqual([]);
    // The closed socket gets no further broadcasts; the others still do.
    s1.broadcastCommand('record-start');
    expect(m1.got).toEqual([]);
    expect(other1.got).toHaveLength(1);
    expect(anon1.got).toHaveLength(1);
    expect(s1.presence()).toEqual({ browsers: 1, companions: 1 });
    // A session with no live hub is never instantiated (no seed rows are written).
    expect(
      await catalogRoot()
        .bindSystem('test')
        .all('SELECT 1 FROM session_transport WHERE session_id = ?', 'sess-never'),
    ).toEqual([]);
    await reg.closeAll();
  });

  it('closes nothing for a user with no sockets, and an empty session set closes nothing', async () => {
    const reg = testRegistry({ autoCreate: true });
    const ws = fakeWs();
    (await reg.get('sess-1')).attachSocket(ws, 'browser', 'user-m');
    expect(reg.closeUserSockets('user-x', new Set(['sess-1']), 4403)).toBe(0);
    expect(reg.closeUserSockets('user-m', new Set(), 4403)).toBe(0);
    expect(ws.closed).toEqual([]);
    await reg.closeAll();
  });
});
