// The session revision (session-row-versions design D2; api-contract-freeze "The session revision
// advances once per session write"): `catalog.sessions.revision` advances by exactly one for each
// committed hub write transaction whose store statements changed a session row. The hub-open seed,
// the relink guard's bookkeeping, no-op writes and reads leave it; a retried transaction advances
// it once; frames carry the value of the transaction that sent them.

import { UI_SNAPSHOT_LABEL_KEY } from '@autologger/domain';
import type { EventStore } from '@autologger/session-core/eventStore';
import { LeaseStore } from '@autologger/session-core/leaseStore';
import { afterEach, describe, expect, it } from 'vitest';
import {
  catalogRoot,
  createSessionRow,
  insertRaw,
  openTestHub,
  rawRows,
  testRegistry,
  testStorage,
} from './sessionRows';
import { deadlock, type SlowStorage, slowStorage } from './slowStorage';

const CTX = { frameRate: 24, startOffsetFrames: 0 };
const T = '2026-10-10T00:00:00.000Z';
const DASHBOARD = {
  widgets: [{ id: 'w1', type: 'session_duration', title: 'Duration', x: 0, y: 0, w: 4, h: 2 }],
  interactions: [],
};

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

async function revision(sessionId: string): Promise<number> {
  const rows = await catalogRoot()
    .bindSystem('test-seed')
    .all<{ revision: number }>('SELECT revision FROM sessions WHERE id = ?', sessionId);
  return Number(rows[0]?.revision);
}

async function hubWithFrames(sessionId: string) {
  const hub = await openTestHub(sessionId, testStorage(sessionId));
  closers.push(() => hub.close());
  const frames: Array<Record<string, unknown>> = [];
  hub.attachSocket({ send: (d: string) => void frames.push(JSON.parse(d)) }, 'browser');
  const eventFrames = () => frames.filter((f) => f.type === 'event.changed');
  return { hub, frames, eventFrames };
}

const event = (message: string) => ({
  category: 'cam',
  message,
  metadataJson: '{}',
  markedAtUtc: null,
  ctx: CTX,
});

interface TxStores {
  events: EventStore;
}
type TxHub = { inTxn<R>(fn: (t: TxStores) => Promise<R>): Promise<R> };

describe('the session revision (design D2)', () => {
  it('(a) one transaction with two events advances it once, and both frames carry that value', async () => {
    const id = await createSessionRow();
    const { hub, eventFrames } = await hubWithFrames(id);
    expect(await revision(id)).toBe(0);
    await (hub as unknown as TxHub).inTxn(async (s) => {
      await s.events.addEvent(event('one'));
      await s.events.addEvent(event('two'));
    });
    expect(await revision(id)).toBe(1);
    expect(eventFrames()).toEqual([
      { type: 'event.changed', revision: 1 },
      { type: 'event.changed', revision: 1 },
    ]);
  });

  it('(b) a word patch, a topic patch, a dashboard save, and a waveform set each advance it by one, with no event.changed', async () => {
    const id = await createSessionRow();
    const { hub, eventFrames } = await hubWithFrames(id);
    const word = await hub.insertTranscriptWord({ session_time: '', speaker: 'a', word: 'x' });
    const topic = await hub.insertTopic({
      session_time: '',
      duration_sec: 0,
      topic_level: 1,
      summary: 's',
    });
    const seg = await hub.addAudioSegment({
      sessionId: id,
      mimeType: 'audio/webm',
      startedAtUtc: T,
      endedAtUtc: T,
      recordingOrdinal: null,
    });
    let r = await revision(id);
    const steps: Array<[string, () => Promise<unknown>]> = [
      ['word patch', () => hub.updateTranscriptWord(word.id, { word: 'y' })],
      ['topic patch', () => hub.updateTopic(topic.id, { summary: 't' })],
      [
        'dashboard save',
        () =>
          hub.saveDashboard({
            id: 'primary',
            config: DASHBOARD,
            createdBy: null,
            createdByTurnId: null,
          }),
      ],
      [
        'waveform set',
        () =>
          hub.setAudioSegmentWaveform({
            segmentId: seg.id as string,
            peaks: new Array(8).fill(0.5),
          }),
      ],
    ];
    for (const [name, step] of steps) {
      await step();
      expect(await revision(id), name).toBe(r + 1);
      r += 1;
    }
    expect(eventFrames()).toEqual([]);
  });

  it('(c) no-ops, reads, the hub-open seed and an idle relink leave it; a relink that changes an event advances it', async () => {
    const id = await createSessionRow();
    const { hub } = await hubWithFrames(id);
    // The hub has opened (its seed inserted the transport row): still 0.
    expect(await revision(id)).toBe(0);
    const word = await hub.insertTranscriptWord({ session_time: '', speaker: 'a', word: 'x' });
    const r = await revision(id);
    await hub.deleteEvent('no-such-event');
    await hub.updateTranscriptWord(word.id, {});
    await hub.listTranscriptWords();
    await hub.listTopics();
    await hub.listEvents({ limit: 50, offset: 0 });
    await hub.statusLive(CTX);
    const relink = { validIds: ['cam'], labelToIds: { camera: ['cam'] } };
    await hub.maybeRelinkOrphans(relink);
    await hub.maybeRelinkOrphans(relink);
    expect(await revision(id)).toBe(r);
    await insertRaw(testStorage(id), 'session_events', {
      id: 'orphan',
      wall_time_utc: T,
      frame_rate: 24,
      category: 'gone',
      message: 'm',
      metadata_json: JSON.stringify({ [UI_SNAPSHOT_LABEL_KEY]: 'Camera' }),
    });
    // The raw insert bypasses the hub; a real write moves the revision past the relink guard.
    await hub.insertTranscriptWord({ session_time: '', speaker: 'a', word: 'z' });
    const before = await revision(id);
    expect(await hub.maybeRelinkOrphans(relink)).toBe(1);
    expect(await revision(id)).toBe(before + 1);
    expect(await hub.maybeRelinkOrphans(relink)).toBe(0);
    expect(await revision(id)).toBe(before + 1);
  });

  it('(d) a write whose body throws after a change leaves it', async () => {
    const id = await createSessionRow();
    const { hub } = await hubWithFrames(id);
    await hub.addEvent(event('first'));
    const r = await revision(id);
    await expect(
      (hub as unknown as TxHub).inTxn(async (s) => {
        await s.events.addEvent(event('doomed'));
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await revision(id)).toBe(r);
  });

  it('(e) a write retried after a deadlock advances it once', async () => {
    const id = await createSessionRow();
    let slow!: SlowStorage;
    const registry = testRegistry({
      wrap: (storage) => {
        slow = slowStorage(storage);
        return slow;
      },
    });
    closers.push(() => registry.closeAll());
    const hub = await registry.get(id);
    const r = await revision(id);
    slow.failAfterBody(1, deadlock());
    await hub.addEvent(event('retried'));
    expect(await revision(id)).toBe(r + 1);
  });

  it('(f) an imported take advances it once, and its one frame carries the new value', async () => {
    const id = await createSessionRow();
    const { hub, eventFrames } = await hubWithFrames(id);
    const r = await revision(id);
    await hub.anchorImportedTake({ recordingOrdinal: 1, durationS: 5, ctx: CTX, startedAtUtc: T });
    expect(await revision(id)).toBe(r + 1);
    expect(eventFrames()).toEqual([{ type: 'event.changed', revision: r + 1 }]);
  });

  it('(g) the retired meta key is neither read nor written', async () => {
    const id = await createSessionRow();
    const storage = testStorage(id);
    await insertRaw(storage, 'session_meta', { key: 'events_stream_revision', value: '999' });
    const { hub } = await hubWithFrames(id);
    await hub.addEvent(event('one'));
    expect(await revision(id)).toBe(1);
    expect((await hub.statusLive(CTX)).events_stream_revision).toBe(1);
    expect(
      await rawRows(storage, 'session_meta', { where: "key = 'events_stream_revision'" }),
    ).toEqual([{ key: 'events_stream_revision', value: '999' }]);
  });

  it('(h) the lease: a claim, a release and an expiry advance it by one; a heartbeat, a refused claim and a foreign release leave it (session-leases D5)', async () => {
    const id = await createSessionRow();
    const time = { now: 1_750_000_000_000 };
    const hub = await openTestHub(id, testStorage(id), { now: () => time.now });
    closers.push(() => hub.close());
    let r = await revision(id);
    const steps: Array<[string, () => Promise<unknown>, number]> = [
      ['claim', () => hub.claimLease('client-a'), 1],
      ['heartbeat', () => hub.heartbeatLease('client-a'), 0],
      ['refused claim', () => hub.claimLease('client-b'), 0],
      ['foreign release', () => hub.releaseLease('client-b'), 0],
      ['release', () => hub.releaseLease('client-a'), 1],
      ['claim again', () => hub.claimLease('client-a'), 1],
    ];
    for (const [name, step, by] of steps) {
      time.now += 1_000;
      await step();
      expect(await revision(id), name).toBe(r + by);
      r += by;
    }
    time.now += LeaseStore.LEASE_STALE_MS;
    type LeaseHub = { inTxn<R>(fn: (t: { lease: LeaseStore }) => Promise<R>): Promise<R> };
    await (hub as unknown as LeaseHub).inTxn((s) => s.lease.expireIfStale());
    expect(await revision(id), 'expiry').toBe(r + 1);
  });
});
