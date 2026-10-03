// Two server processes on one session (session-tables design D7, A5; core-ports-architecture
// "Writes from two processes equal a serial order"): two registries over two adapter instances,
// so the hubs share no in-process lock and serialize only through the session's row lock.

import { PostgresCatalogDb } from '@autologger/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { testDatabase } from '../harness';
import { catalogRoot, createSessionRow, sessionDb, testRegistry } from './sessionRows';

const CTX = { frameRate: 24, startOffsetFrames: 0 };

const others: PostgresCatalogDb[] = [];
afterEach(async () => {
  for (const db of others.splice(0)) await db.close();
});

/** The harness's registry and one over a second adapter instance (a second process). */
function twoProcesses() {
  const second = new PostgresCatalogDb(testDatabase());
  others.push(second);
  return [testRegistry(), testRegistry({ db: sessionDb(second) })] as const;
}

describe('two processes on one session', () => {
  it('100 concurrent toggle pairs end as a serial order leaves the transport', async () => {
    const id = await createSessionRow();
    const [one, two] = twoProcesses();
    const [hubOne, hubTwo] = await Promise.all([one.get(id), two.get(id)]);
    await Promise.all(
      Array.from({ length: 100 }, () =>
        Promise.all([hubOne.toggleTake(CTX), hubTwo.toggleTake(CTX)]),
      ),
    );
    const status = await hubOne.statusLive(CTX);
    expect(status.is_rolling).toBe(false);
    expect(status.current_take).toBe(100);
    expect((await hubTwo.transportSnapshot(CTX)).current_take).toBe(100);
    await Promise.all([one.closeAll(), two.closeAll()]);
  });

  // catalog-database "Concurrent writes leave the last state" (design D8): the projection is
  // written inside each write's transaction, under the row lock, so the last commit's state wins.
  it('concurrent writes from two processes leave the last committed state in the catalog', async () => {
    const id = await createSessionRow();
    const [one, two] = twoProcesses();
    const [hubOne, hubTwo] = await Promise.all([one.get(id), two.get(id)]);
    const add = (hub: typeof hubOne, i: number) =>
      hub.addEvent({
        category: 'cam',
        message: `m${i}`,
        metadataJson: '{}',
        markedAtUtc: null,
        ctx: CTX,
      });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        Promise.all([
          add(hubOne, i),
          add(hubTwo, i),
          hubOne.toggleTake(CTX),
          hubTwo.toggleTake(CTX),
        ]),
      ),
    );
    await hubTwo.toggleTake(CTX); // the last commit: B's state is rolling
    const [row] = await catalogRoot()
      .bindSystem('test')
      .all<{ event_count: number; is_rolling: number; current_take: number }>(
        'SELECT event_count, is_rolling, current_take FROM sessions WHERE id = ?',
        id,
      );
    const last = await hubOne.ensure();
    expect(last.event_count).toBe(40);
    expect(last.is_rolling).toBe(true);
    expect(last.current_take).toBe(21); // 41 toggles: take 21 started and rolling
    expect({
      event_count: Number(row.event_count),
      is_rolling: Boolean(Number(row.is_rolling)),
      current_take: Number(row.current_take),
    }).toEqual({
      event_count: last.event_count,
      is_rolling: last.is_rolling,
      current_take: last.current_take,
    });
    await Promise.all([one.closeAll(), two.closeAll()]);
  });

  it('two concurrent addImportedAudioSegment calls get distinct consecutive ordinals', async () => {
    const id = await createSessionRow();
    const [one, two] = twoProcesses();
    const [hubOne, hubTwo] = await Promise.all([one.get(id), two.get(id)]);
    const input = { sessionId: id, mimeType: 'audio/mpeg', startedAtUtc: null, endedAtUtc: null };
    const [a, b] = await Promise.all([
      hubOne.addImportedAudioSegment(input),
      hubTwo.addImportedAudioSegment(input),
    ]);
    expect([a.recordingOrdinal, b.recordingOrdinal].sort()).toEqual([1, 2]);
    expect([a.segment.ordinal, b.segment.ordinal].sort()).toEqual([1, 2]);
    await Promise.all([one.closeAll(), two.closeAll()]);
  });
});
