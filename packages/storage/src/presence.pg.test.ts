// Companion presence on Postgres (companion-devices D4; core-ports-architecture "Companion presence
// is shared by every process") against the catalog adapter as the app's least-privilege role on a
// cloned test database. Users and sessions are seeded on a test system handle; the presence store
// binds its own `companion-presence` reason. Replaces server/src/node/presence.test.ts (D9
// category 2): freshness, refresh and remove move here, with the fake clock as the time base.
import type { CatalogDb } from '@autologger/ports';
import { PRESENCE_FRESH_MS } from '@autologger/ports/presenceRegistry';
import { afterEach, describe, expect, it } from 'vitest';
import { PostgresCatalogDb } from './postgresCatalogStore';
import { PostgresPresence } from './presence';
import { createTestDatabase } from './test/pgDb';

const open: PostgresCatalogDb[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

async function env() {
  const root = new PostgresCatalogDb((await createTestDatabase()).app);
  open.push(root);
  const db: CatalogDb = root.bindSystem('test');
  for (const id of ['ua', 'ub']) {
    await db.run(
      'INSERT INTO users (id, google_sub, email, created_at_utc) VALUES (?, ?, ?, ?)',
      id,
      `${id}-sub`,
      `${id}@example.com`,
      'now',
    );
  }
  for (const id of ['s1', 's2']) await db.run('INSERT INTO sessions (id) VALUES (?)', id);
  // A plain fake clock (no fake timers: the postgres client uses real ones).
  let now = 1_750_000_000_000;
  const clock = { now: () => now };
  const tick = (ms: number) => {
    now += ms;
  };
  const presence = new PostgresPresence(root, clock);
  const rows = () =>
    db.all<Record<string, unknown>>(
      `SELECT client_id, user_id, session_id, visible, is_playing, updated_at_ms
         FROM companion_presence ORDER BY client_id`,
    );
  const meta = (
    user: string,
    session: string | null,
    over: { visible?: boolean; is_playing?: boolean } = {},
  ) => ({
    user_id: user,
    session_id: session,
    visible: over.visible ?? true,
    is_playing: over.is_playing ?? false,
    updated: clock.now(),
  });
  return { presence, clock, tick, rows, meta };
}

describe('PostgresPresence (companion-devices D4)', () => {
  it('lists an upserted row with its client id within the window, and at exactly 15 s; not after', async () => {
    const { presence, clock, tick, meta } = await env();
    const t0 = clock.now();
    await presence.upsert('c1', meta('ua', 's1', { is_playing: true }));
    expect(await presence.list('ua')).toEqual([
      {
        client_id: 'c1',
        user_id: 'ua',
        session_id: 's1',
        visible: true,
        is_playing: true,
        updated: t0,
      },
    ]);
    tick(PRESENCE_FRESH_MS);
    expect(await presence.list('ua')).toHaveLength(1); // inclusive at the edge
    tick(1);
    expect(await presence.list('ua')).toEqual([]); // stale: excluded
  });

  it('an upsert by the same user refreshes the row; remove deletes it', async () => {
    const { presence, clock, tick, meta } = await env();
    await presence.upsert('c1', meta('ua', 's1'));
    tick(10_000);
    await presence.upsert('c1', meta('ua', 's2', { visible: false }));
    tick(10_000);
    expect(await presence.list('ua')).toEqual([
      expect.objectContaining({ client_id: 'c1', session_id: 's2', visible: false }),
    ]);
    expect((await presence.list('ua'))[0].updated).toBe(clock.now() - 10_000);
    await presence.remove('c1', 'ua');
    expect(await presence.list('ua')).toEqual([]);
  });

  it("list returns only that user's rows", async () => {
    const { presence, meta } = await env();
    await presence.upsert('ca', meta('ua', 's1'));
    await presence.upsert('cb', meta('ub', 's2'));
    expect((await presence.list('ua')).map((r) => r.client_id)).toEqual(['ca']);
    expect((await presence.list('ub')).map((r) => r.client_id)).toEqual(['cb']);
    expect(await presence.list('nobody')).toEqual([]);
  });

  it("an upsert for another user's live client id changes nothing, and that user's remove deletes nothing", async () => {
    const { presence, clock, tick, rows, meta } = await env();
    const t0 = clock.now();
    await presence.upsert('c1', meta('ua', 's1'));
    tick(PRESENCE_FRESH_MS); // still fresh (inclusive edge)
    await presence.upsert('c1', meta('ub', 's2', { visible: false }));
    await presence.remove('c1', 'ub');
    expect(await rows()).toEqual([
      {
        client_id: 'c1',
        user_id: 'ua',
        session_id: 's1',
        visible: true,
        is_playing: false,
        updated_at_ms: t0,
      },
    ]);
    expect(await presence.list('ub')).toEqual([]);
  });

  it("an upsert for another user's stale client id takes the row over", async () => {
    const { presence, clock, tick, rows, meta } = await env();
    await presence.upsert('c1', meta('ua', 's1'));
    tick(PRESENCE_FRESH_MS + 1);
    await presence.upsert('c1', meta('ub', 's2'));
    expect(await rows()).toEqual([
      expect.objectContaining({
        client_id: 'c1',
        user_id: 'ub',
        session_id: 's2',
        updated_at_ms: clock.now(),
      }),
    ]);
    expect((await presence.list('ub')).map((r) => r.client_id)).toEqual(['c1']);
  });

  it('stores the update time from its Clock, not from the caller', async () => {
    const { presence, clock, rows, meta } = await env();
    await presence.upsert('c1', { ...meta('ua', 's1'), updated: 1 });
    expect((await rows())[0].updated_at_ms).toBe(clock.now());
  });

  it('a null session id is stored as SQL NULL', async () => {
    const { presence, rows, meta } = await env();
    await presence.upsert('c1', meta('ua', null));
    expect((await rows())[0].session_id).toBeNull();
    expect((await presence.list('ua'))[0].session_id).toBeNull();
  });

  it('deleteOlderThan deletes only rows updated before the cutoff', async () => {
    const { presence, clock, tick, rows, meta } = await env();
    await presence.upsert('old', meta('ua', 's1'));
    tick(56_000);
    const cutoff = clock.now();
    await presence.upsert('edge', meta('ua', 's1'));
    tick(5_000);
    await presence.upsert('new', meta('ub', 's2'));
    await presence.deleteOlderThan(cutoff);
    expect((await rows()).map((r) => r.client_id)).toEqual(['edge', 'new']);
  });
});
