// Version checks from two processes (session-row-versions design D4; core-ports-architecture
// "Concurrent same-version edits from two processes"): two registries over two adapter instances
// race updates of one event, each sending the version both read. The check and the write share the
// session's row lock, so every round has exactly one winner, and the final version is one plus the
// number of committed updates.

import { PostgresCatalogDb } from '@autologger/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { testDatabase } from '../harness';
import { createSessionRow, sessionDb, testRegistry } from './sessionRows';

const CTX = { frameRate: 24, startOffsetFrames: 0 };
const others: PostgresCatalogDb[] = [];
afterEach(async () => {
  for (const db of others.splice(0)) await db.close();
});

describe('same-version updates from two processes', () => {
  it('every round has exactly one winner, and the version counts the wins', async () => {
    const id = await createSessionRow();
    const second = new PostgresCatalogDb(testDatabase());
    others.push(second);
    const [one, two] = [testRegistry(), testRegistry({ db: sessionDb(second) })];
    const [hubOne, hubTwo] = await Promise.all([one.get(id), two.get(id)]);
    const { event } = await hubOne.addEvent({
      category: 'cam',
      message: 'm0',
      metadataJson: '{}',
      markedAtUtc: null,
      ctx: CTX,
    });
    const send = (hub: typeof hubOne, version: number, message: string) =>
      hub.updateEvent({
        eventId: event.event_id,
        category: 'cam',
        message,
        wallTimeUtc: event.wall_time_utc,
        timecodeTotalFrames: 0,
        mergeMetadata: (m) => m,
        expect: { version, overwrite: false },
      });
    let wins = 0;
    const badRounds: string[] = [];
    for (let round = 0; round < 200; round += 1) {
      const version = (await hubOne.getEvent(event.event_id))?.version as number;
      const results = await Promise.all([
        send(hubOne, version, `a${round}`),
        send(hubTwo, version, `b${round}`),
      ]);
      const won = results.filter((r) => r !== null && 'event' in r).length;
      const lost = results.filter((r) => r !== null && 'conflict' in r).length;
      if (won !== 1 || lost !== 1) badRounds.push(`round ${round}: ${won} won, ${lost} conflicted`);
      wins += won;
    }
    expect(badRounds).toEqual([]);
    expect((await hubTwo.getEvent(event.event_id))?.version).toBe(1 + wins);
    await Promise.all([one.closeAll(), two.closeAll()]);
    // 400 updates, each a Postgres transaction under the session row lock (crossProcess precedent).
  }, 60_000);
});
