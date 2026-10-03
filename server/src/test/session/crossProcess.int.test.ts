// Two server processes on one session (session-tables design D7, A5; core-ports-architecture
// "Writes from two processes equal a serial order"): two registries over two adapter instances,
// so the hubs share no in-process lock and serialize only through the session's row lock.

import { PostgresCatalogDb } from '@autologger/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { testDatabase } from '../harness';
import { createSessionRow, sessionDb, testRegistry } from './sessionRows';

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
