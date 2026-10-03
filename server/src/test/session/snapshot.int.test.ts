// One snapshot per hub read (session-tables design D6; core-ports-architecture "A multi-statement
// read sees one state"): a listEvents whose statements are interleaved, through slowStorage, with
// another connection's committed insert returns the page, the counts and the revision of one state.

import { AsyncResource } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import { slowStorage } from './slowStorage';
import { createSessionRow, TEST_CALLER, testRegistry, testStorage } from './sessionRows';

const CTX = { frameRate: 24, startOffsetFrames: 0 };

describe('a hub read is one snapshot', () => {
  it('listEvents interleaved with a committed insert describes one state', async () => {
    const id = await createSessionRow();
    let armed = false;
    let statements = 0;
    const elsewhere = testStorage(id);
    // The hook runs inside the snapshot's transaction; the insert runs from the test's own async
    // context, as another request would, on another session connection.
    const outside = new AsyncResource('another-request');
    const registry = testRegistry({
      wrap: (storage) =>
        slowStorage(storage, {
          hooks: {
            async beforeStatement() {
              if (!armed) return;
              statements += 1;
              if (statements !== 2) return;
              // After the page was read: another connection commits an event and its revision.
              armed = false;
              await outside.runInAsyncScope(() =>
                elsewhere.tx(TEST_CALLER, async (t) => {
                  await t.run(
                    `INSERT INTO session_events (session_id, id, wall_time_utc, frame_rate, category, message)
                   VALUES (?, ?, ?, ?, ?, ?)`,
                    id,
                    'elsewhere',
                    '2026-10-03T00:00:00.000Z',
                    24,
                    'cam',
                    'committed elsewhere',
                  );
                  await t.run(
                    "UPDATE session_meta SET value = (value::bigint + 1)::text WHERE session_id = ? AND key = 'events_stream_revision'",
                    id,
                  );
                }),
              );
            },
          },
        }),
    });
    const hub = await registry.get(id);
    await hub.addEvent({
      category: 'cam',
      message: 'a',
      metadataJson: '{}',
      markedAtUtc: null,
      ctx: CTX,
    });

    armed = true;
    const listed = await hub.listEvents({ limit: 100, offset: 0 });
    expect(statements).toBeGreaterThanOrEqual(2);
    expect(listed.events.map((e) => e.message)).toEqual(['a']);
    expect(listed.total).toBe(1);
    expect(listed.loggedTotal).toBe(1);
    expect(listed.revision).toBe(1);

    const after = await hub.listEvents({ limit: 100, offset: 0 });
    expect(after.total).toBe(2);
    expect(after.revision).toBe(2);
    await registry.closeAll();
  });
});
