// Row versions (session-row-versions design D3; api-contract-freeze "Session content rows carry
// their version"): events, transcript words and topics start at version 1, and every committed
// change to a row advances its version by exactly one, whoever makes it. A word patch with no fields
// changes nothing and leaves the version.

import { UI_SNAPSHOT_LABEL_KEY } from '@autologger/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { createSessionRow, insertRaw, openTestHub, rawRows, testStorage } from './sessionRows';

const CTX = { frameRate: 24, startOffsetFrames: 0 };
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

async function hubFor() {
  const id = await createSessionRow();
  const hub = await openTestHub(id, testStorage(id));
  closers.push(() => hub.close());
  return { id, hub, storage: testStorage(id) };
}

async function storedVersion(
  storage: ReturnType<typeof testStorage>,
  table: string,
  rowId: string,
): Promise<number> {
  const [r] = await rawRows(storage, table, { columns: 'version', where: 'id = ?', binds: [rowId] });
  return Number(r?.version);
}

describe('row versions (design D3)', () => {
  it('an event starts at 1 and each update, the route path and the orphan relink, advances it by one', async () => {
    const { hub, storage } = await hubFor();
    const { event } = await hub.addEvent({
      category: 'cam',
      message: 'm',
      metadataJson: JSON.stringify({ [UI_SNAPSHOT_LABEL_KEY]: 'Camera' }),
      markedAtUtc: null,
      ctx: CTX,
    });
    expect(event.version).toBe(1);
    const update = (message: string, category = 'cam') =>
      hub.updateEvent({
        eventId: event.event_id,
        category,
        message,
        wallTimeUtc: event.wall_time_utc,
        timecodeTotalFrames: 0,
        mergeMetadata: (m) => m,
      });
    expect((await update('two'))?.event.version).toBe(2);
    expect((await update('three', 'gone'))?.event.version).toBe(3);
    expect(await hub.maybeRelinkOrphans({ validIds: ['cam'], labelToIds: { camera: ['cam'] } })).toBe(1);
    expect(await storedVersion(storage, 'session_events', event.event_id)).toBe(4);
    const listed = await hub.listEvents({ limit: 10, offset: 0 });
    expect(listed.events.map((e) => e.version)).toEqual([4]);
  });

  it('a transcript word starts at 1, a patch advances it, and an empty patch leaves it', async () => {
    const { hub, storage } = await hubFor();
    const word = await hub.insertTranscriptWord({ session_time: '', speaker: 'a', word: 'x' });
    expect(word.version).toBe(1);
    expect((await hub.updateTranscriptWord(word.id, { word: 'y' }))?.version).toBe(2);
    expect((await hub.updateTranscriptWord(word.id, {}))?.version).toBe(2);
    expect(await storedVersion(storage, 'session_transcript_words', word.id)).toBe(2);
    expect((await hub.listTranscriptWords()).map((w) => w.version)).toEqual([2]);
  });

  it('a topic starts at 1 and each patch advances it', async () => {
    const { hub, storage } = await hubFor();
    const topic = await hub.insertTopic({
      session_time: '',
      duration_sec: 0,
      topic_level: 1,
      summary: 's',
    });
    expect(topic.version).toBe(1);
    expect((await hub.updateTopic(topic.id, { summary: 't' }))?.version).toBe(2);
    expect((await hub.updateTopic(topic.id, { topic_level: 2 }))?.version).toBe(3);
    expect(await storedVersion(storage, 'session_topics', topic.id)).toBe(3);
    expect((await hub.listTopics()).map((t) => t.version)).toEqual([3]);
  });

  it('rows written outside the hub read back with their stored version', async () => {
    const { hub, storage } = await hubFor();
    await insertRaw(storage, 'session_topics', {
      id: 'raw',
      ordinal: 0,
      created_at_utc: '2026-10-10T00:00:00.000Z',
      version: 7,
    });
    expect((await hub.listTopics()).map((t) => [t.id, t.version])).toEqual([['raw', 7]]);
  });
});
