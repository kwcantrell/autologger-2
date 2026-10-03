// The session pool cannot starve the catalog (session-tables design D2, D12, panel finding 6;
// core-ports-architecture "Saturated session connections do not delay the catalog"): with all four
// session connections held by slow snapshots on the server's own adapter, a profile update and a
// session create's catalog transaction finish in under a second, and a fifth session call waits
// for a session connection and completes once one frees.

import { describe, expect, it } from 'vitest';
import { app, env } from '../harness';
import { seededSession, testDb } from '../helpers';
import { createSessionRow, sessionDb } from './sessionRows';

/** Holds `n` session connections with open snapshots until `release`. */
async function holdSessionSlots(n: number) {
  const db = sessionDb();
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  const held = await Promise.all(Array.from({ length: n }, async () => createSessionRow())).then(
    (ids) =>
      ids.map((id) =>
        db.forSession(id).snapshot(async (t) => {
          await t.all('SELECT 1 AS x FROM session_meta WHERE session_id = ?', id);
          entered += 1;
          await released;
        }),
      ),
  );
  const deadline = Date.now() + 5000;
  while (entered < n) {
    if (Date.now() > deadline) throw new Error('the session slots were never all held');
    await new Promise((r) => setTimeout(r, 5));
  }
  return {
    async release() {
      release();
      await Promise.all(held);
    },
  };
}

describe('saturated session connections', () => {
  it('a profile update and a session create transaction finish within a second; a fifth session call waits for a slot', async () => {
    const { studioId, showId } = await seededSession();
    const slots = await holdSessionSlots(4);
    try {
      let t0 = Date.now();
      const profile = await app.request(
        '/api/profile',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ active_studio_id: studioId, given_name: 'Pooled' }),
        },
        { ...env },
      );
      expect(profile.status).toBe(200);
      expect(Date.now() - t0).toBeLessThan(1000);

      t0 = Date.now();
      const create = app.request(
        '/api/sessions',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ show_id: showId, episode: '042', frame_rate: 24 }),
        },
        { ...env },
      );
      const created = async () =>
        (
          await testDb().first<{ n: number }>(
            'SELECT COUNT(*) AS n FROM sessions WHERE show_id = ?',
            showId,
          )
        )?.n ?? 0;
      // The seeded session is the show's first; the create adds the second.
      while ((await created()) < 2) {
        if (Date.now() - t0 > 1000) throw new Error('the create transaction took over a second');
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(Date.now() - t0).toBeLessThan(1000);

      let fifthDone = false;
      const fifthId = await createSessionRow();
      const fifth = sessionDb()
        .forSession(fifthId)
        .tx((t) =>
          t.run("INSERT INTO session_meta (session_id, key, value) VALUES (?, 'k', 'v')", fifthId),
        )
        .finally(() => {
          fifthDone = true;
        });
      await new Promise((r) => setTimeout(r, 200));
      expect(fifthDone).toBe(false);

      await slots.release();
      expect(await fifth).toEqual({ changes: 1 });
      // The create's response follows its hub open, a session call once the slots are free.
      expect((await create).status).toBe(200);
    } finally {
      await slots.release();
    }
  });
});
