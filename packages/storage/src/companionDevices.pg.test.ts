// The CompanionDeviceStore on `catalog.companion_devices` (companion-devices D2, D5; api-contract-
// freeze "Companion device tokens authenticate only the Companion surface") against the catalog
// adapter as the app's least-privilege role on a cloned test database. Users are seeded on a test
// system handle; the store binds its own `companion-device` reason. Times come from a fake clock.
import type { CatalogDb } from '@autologger/ports';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogTxTimeoutError } from './catalogErrors';
import {
  COMPANION_DEVICE_CAP,
  COMPANION_DEVICE_IDLE_MS,
  PostgresCompanionDeviceStore,
} from './companionDevices';
import { PostgresCatalogDb } from './postgresCatalogStore';
import { createTestDatabase } from './test/pgDb';

const DAY = 86_400_000;

/** Polls `cond` every 10 ms; rejects if it is still false after `ms`. */
async function waitFor(cond: () => Promise<boolean>, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > until) throw new Error(`condition still false after ${ms} ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const open: PostgresCatalogDb[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

/** `maxTries: 1` turns off the adapter's serialization retries, so a create that counted from a
 * stale snapshot shows as the 40001 it gets instead of a re-run. */
async function env(opts: { maxTries?: number; txTimeoutMs?: number } = {}) {
  const testDb = await createTestDatabase();
  const root = new PostgresCatalogDb({ ...testDb.app, ...opts });
  open.push(root);
  const db: CatalogDb = root.bindSystem('test');
  for (const id of ['ua', 'ub']) {
    await db.run(
      `INSERT INTO users (id, google_sub, email, given_name, family_name, picture_url, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      `${id}-sub`,
      `${id}@example.com`,
      `Given ${id}`,
      `Family ${id}`,
      `https://example.com/${id}.png`,
      'now',
    );
  }
  let now = Date.parse('2026-10-08T12:00:00.000Z');
  const clock = { now: () => now };
  const tick = (ms: number) => {
    now += ms;
  };
  const store = new PostgresCompanionDeviceStore(root, clock);
  const rows = () =>
    db.all<Record<string, unknown>>(
      `SELECT id, user_id, name, token_hash, created_at_utc, last_used_at_utc
         FROM companion_devices ORDER BY created_at_utc, id`,
    );
  const create = async (user: string, name: string, hash: string) => {
    const r = await store.create(user, name, hash);
    if (r.kind !== 'created') throw new Error(`expected a device, got ${r.kind}`);
    return r.device;
  };
  return { testDb, root, db, store, clock, tick, rows, create };
}

describe('PostgresCompanionDeviceStore (companion-devices D2, D5)', () => {
  it("lookup by hash returns the device and its enabled user's row", async () => {
    const { store, clock, rows, create } = await env();
    const d = await create('ua', 'Booth A', 'h-a');
    expect(d).toEqual({
      id: expect.any(String),
      name: 'Booth A',
      created_at_utc: new Date(clock.now()).toISOString(),
      last_used_at_utc: null,
      expired: false,
    });
    expect(await rows()).toEqual([
      {
        id: d.id,
        user_id: 'ua',
        name: 'Booth A',
        token_hash: 'h-a',
        created_at_utc: d.created_at_utc,
        last_used_at_utc: null,
      },
    ]);
    expect(await store.lookup('h-a')).toEqual({
      deviceId: d.id,
      user: {
        id: 'ua',
        email: 'ua@example.com',
        google_sub: 'ua-sub',
        given_name: 'Given ua',
        family_name: 'Family ua',
        picture_url: 'https://example.com/ua.png',
      },
    });
    expect(await store.lookup('h-unknown')).toBeNull();
    expect(await store.lookup('')).toBeNull();
  });

  it('a disabled user misses', async () => {
    const { db, store, create } = await env();
    await create('ua', 'Booth A', 'h-a');
    await db.run("UPDATE users SET disabled_at_utc = 'then' WHERE id = 'ua'");
    expect(await store.lookup('h-a')).toBeNull();
    await db.run("UPDATE users SET disabled_at_utc = NULL WHERE id = 'ua'");
    expect(await store.lookup('h-a')).not.toBeNull();
  });

  it('a device idle 90 days misses (and is listed as expired); a use renews it', async () => {
    const { store, tick, create } = await env();
    const d = await create('ua', 'Booth A', 'h-a');
    tick(COMPANION_DEVICE_IDLE_MS - 1);
    expect(await store.lookup('h-a')).toEqual(expect.objectContaining({ deviceId: d.id }));
    expect((await store.list('ua'))[0].expired).toBe(false);
    tick(1); // exactly 90 days since creation, never used
    expect(await store.lookup('h-a')).toBeNull();
    expect(await store.list('ua')).toEqual([expect.objectContaining({ id: d.id, expired: true })]);

    const e = await create('ua', 'Booth B', 'h-b');
    tick(80 * DAY);
    expect(await store.lookup('h-b')).not.toBeNull();
    expect(await store.touch(e.id)).toEqual({ firstUse: true });
    tick(40 * DAY); // 120 days since creation, 40 since the last use
    expect(await store.lookup('h-b')).toEqual(expect.objectContaining({ deviceId: e.id }));
    expect((await store.list('ua')).find((x) => x.id === e.id)?.expired).toBe(false);
    tick(50 * DAY); // 90 days since the last use
    expect(await store.lookup('h-b')).toBeNull();
  });

  it('touch sets last use at most once a minute, and says when it is the first use', async () => {
    const { store, clock, tick, rows, create } = await env();
    const d = await create('ua', 'Booth A', 'h-a');
    const t0 = new Date(clock.now()).toISOString();
    expect(await store.touch(d.id)).toEqual({ firstUse: true });
    expect((await rows())[0].last_used_at_utc).toBe(t0);
    tick(30_000);
    expect(await store.touch(d.id)).toBeNull();
    tick(30_000); // exactly 60 s after the last update: still throttled
    expect(await store.touch(d.id)).toBeNull();
    expect((await rows())[0].last_used_at_utc).toBe(t0);
    tick(1);
    expect(await store.touch(d.id)).toEqual({ firstUse: false });
    expect((await rows())[0].last_used_at_utc).toBe(new Date(clock.now()).toISOString());
    expect(await store.touch('no-such-device')).toBeNull();
    const listed = await store.list('ua');
    expect(listed[0].last_used_at_utc).toBe(new Date(clock.now()).toISOString());
  });

  it('two concurrent first touches report one first use', async () => {
    const { store, create } = await env();
    const d = await create('ua', 'Booth A', 'h-a');
    const results = await Promise.all([store.touch(d.id), store.touch(d.id)]);
    expect(results.filter((r) => r?.firstUse === true)).toHaveLength(1);
  });

  it('list is scoped by user id, newest first', async () => {
    const { store, tick, create } = await env();
    const a1 = await create('ua', 'A one', 'h-a1');
    tick(1000);
    const a2 = await create('ua', 'A two', 'h-a2');
    const b1 = await create('ub', 'B one', 'h-b1');
    expect((await store.list('ua')).map((d) => d.id)).toEqual([a2.id, a1.id]);
    expect((await store.list('ub')).map((d) => d.id)).toEqual([b1.id]);
    expect(await store.list('nobody')).toEqual([]);
    for (const d of await store.list('ua'))
      expect(Object.keys(d).sort()).toEqual([
        'created_at_utc',
        'expired',
        'id',
        'last_used_at_utc',
        'name',
      ]);
  });

  it("delete is scoped by user id: another user's id changes nothing", async () => {
    const { store, rows, create } = await env();
    const a = await create('ua', 'A', 'h-a');
    const b = await create('ub', 'B', 'h-b');
    expect(await store.delete('ub', a.id)).toBe(false);
    expect(await store.delete('ua', 'no-such-device')).toBe(false);
    expect((await rows()).map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(await store.delete('ua', a.id)).toBe(true);
    expect((await rows()).map((r) => r.id)).toEqual([b.id]);
    expect(await store.lookup('h-a')).toBeNull();
    expect(await store.delete('ua', a.id)).toBe(false);
  });

  it('create refuses the 11th device of a user with cap-reached, and creates nothing', async () => {
    const { store, rows, create } = await env();
    expect(COMPANION_DEVICE_CAP).toBe(10);
    for (let i = 0; i < 10; i++) await create('ua', `A ${i}`, `h-a${i}`);
    expect(await store.create('ua', 'A 10', 'h-a10')).toEqual({ kind: 'cap-reached' });
    expect(await rows()).toHaveLength(10);
    // Another user's count is separate.
    await create('ub', 'B', 'h-b');
    // A revoke frees a slot.
    const first = (await store.list('ua'))[0];
    expect(await store.delete('ua', first.id)).toBe(true);
    await create('ua', 'A 10', 'h-a10');
  });

  it('concurrent creates never leave more than 10 devices', async () => {
    const { store, rows } = await env();
    const results = await Promise.all(
      Array.from({ length: 14 }, (_, i) => store.create('ua', `A ${i}`, `h-c${i}`)),
    );
    expect(results.filter((r) => r.kind === 'created')).toHaveLength(10);
    expect(results.filter((r) => r.kind === 'cap-reached')).toHaveLength(4);
    expect((await rows()).filter((r) => r.user_id === 'ua')).toHaveLength(10);
  });

  // A serializable transaction's snapshot is taken by its first statement, before the per-user
  // advisory lock is granted, so a create that waited behind another counted a stale snapshot and
  // got a serialization failure once that one committed; under contention the five runs could run
  // out (a 500 in "14 concurrent creates from none leave exactly 10"). The store's creates for one
  // user now start their transactions one at a time, so none waits inside a transaction behind
  // another of this process. No retries here: any 40001 fails the test.
  it("a user's creates in this process never count a stale snapshot (no serialization retry)", async () => {
    // A long transaction timeout: X's transaction stays open on the lock through both waits below.
    const { testDb, store, rows, create } = await env({ maxTries: 1, txTimeoutMs: 120_000 });
    for (let i = 0; i < 9; i++) await create('ua', `A ${i}`, `h-a${i}`);
    const other = postgres({ ...testDb.admin, max: 1, onnotice: () => {} });
    const lockKey = "hashtextextended('companion-device:' || 'ua', 0)";
    try {
      // Another connection holds the user's key, so the creates already in a transaction queue on
      // it; both did on the code before the fix.
      await other.unsafe(`select pg_advisory_lock(${lockKey})`);
      const pending = [store.create('ua', 'X', 'h-x'), store.create('ua', 'Y', 'h-y')];
      const waiting = async () =>
        (
          await other<{ n: number }[]>`
            select count(*)::int as n from pg_locks
             where locktype = 'advisory' and not granted and database = (
               select oid from pg_database where datname = current_database())`
        )[0].n;
      // X's transaction queues on the lock (bounded generously for a loaded CI; X's 120 s deadline
      // outlasts both waits). Y then gets up to 2 s to queue too: it always did before the fix, and
      // never does now, since Y waits in the store until X's transaction ends.
      await waitFor(async () => (await waiting()) >= 1, 20_000);
      await waitFor(async () => (await waiting()) >= 2, 2_000).catch(() => {});
      await other.unsafe(`select pg_advisory_unlock(${lockKey})`);
      const results = await Promise.all(pending);
      expect(results.map((r) => r.kind).sort()).toEqual(['cap-reached', 'created']);
      expect((await rows()).filter((r) => r.user_id === 'ua')).toHaveLength(10);
    } finally {
      await other.end();
    }
  });

  it('rounds of 14 concurrent creates leave exactly 10 devices, with no serialization retry', async () => {
    const { db, store } = await env({ maxTries: 1 });
    for (let round = 0; round < 8; round++) {
      const user = `ur${round}`;
      await db.run(
        `INSERT INTO users (id, google_sub, email, given_name, family_name, picture_url, created_at_utc)
         VALUES (?, ?, ?, '', '', '', 'now')`,
        user,
        `${user}-sub`,
        `${user}@example.com`,
      );
      const results = await Promise.all(
        Array.from({ length: 14 }, (_, i) => store.create(user, `R ${i}`, `h-${user}-${i}`)),
      );
      expect(results.filter((r) => r.kind === 'created')).toHaveLength(10);
      expect(results.filter((r) => r.kind === 'cap-reached')).toHaveLength(4);
      const n = await db.first<{ n: number }>(
        'SELECT count(*)::int AS n FROM companion_devices WHERE user_id = ?',
        user,
      );
      expect(n?.n).toBe(10);
    }
  });

  // The queue wait is bounded like a transaction: a create that cannot start its transaction
  // within the adapter's transaction timeout (overridden small here) fails with the adapter's
  // timeout error and never inserts, and the user's later creates still run.
  it('a create queued past the timeout fails like a transaction timeout and never inserts', async () => {
    const { testDb, root, clock, rows } = await env();
    const store = new PostgresCompanionDeviceStore(root, clock, { queueTimeoutMs: 200 });
    const other = postgres({ ...testDb.admin, max: 1, onnotice: () => {} });
    const lockKey = "hashtextextended('companion-device:' || 'ua', 0)";
    try {
      await other.unsafe(`select pg_advisory_lock(${lockKey})`);
      const first = store.create('ua', 'First', 'h-first');
      const queued = store.create('ua', 'Queued', 'h-queued');
      await expect(queued).rejects.toBeInstanceOf(CatalogTxTimeoutError);
      await other.unsafe(`select pg_advisory_unlock(${lockKey})`);
      expect((await first).kind).toBe('created');
      expect((await store.create('ua', 'Later', 'h-later')).kind).toBe('created');
      // Give a wrongly still-queued create time to run before checking it never did.
      await new Promise((r) => setTimeout(r, 300));
      expect((await rows()).map((r) => r.name).sort()).toEqual(['First', 'Later']);
    } finally {
      await other.end();
    }
  });

  it('the queue timeout defaults to the adapter transaction timeout', async () => {
    const { root, clock } = await env();
    expect(root.txTimeoutMs).toBe(10_000);
    expect(new PostgresCompanionDeviceStore(root, clock).queueTimeoutMs).toBe(root.txTimeoutMs);
  });

  it('a create whose clock read throws rejects, and the queue and later creates are unaffected', async () => {
    const { root, clock, rows } = await env();
    let failNext = true;
    const store = new PostgresCompanionDeviceStore(root, {
      now: () => {
        if (failNext) {
          failNext = false;
          throw new Error('clock failed');
        }
        return clock.now();
      },
    });
    const settled = (p: Promise<unknown>) =>
      Promise.race([
        p.then(
          () => 'resolved',
          (e: Error) => `rejected: ${e.message}`,
        ),
        new Promise((r) => setTimeout(() => r('never settled'), 2000)),
      ]);
    expect(await settled(store.create('ua', 'Broken', 'h-broken'))).toBe('rejected: clock failed');
    expect(await settled(store.create('ua', 'Next', 'h-next'))).toBe('resolved');
    await new Promise((r) => setTimeout(r, 0));
    expect((store as unknown as { creating: Map<string, unknown> }).creating.size).toBe(0);
    expect((await rows()).map((r) => r.name)).toEqual(['Next']);
  });

  it("a queued create's created_at_utc is read when its turn comes", async () => {
    const { testDb, store, clock, tick } = await env({ txTimeoutMs: 120_000 });
    const t0 = new Date(clock.now()).toISOString();
    const other = postgres({ ...testDb.admin, max: 1, onnotice: () => {} });
    const lockKey = "hashtextextended('companion-device:' || 'ua', 0)";
    try {
      await other.unsafe(`select pg_advisory_lock(${lockKey})`);
      const first = store.create('ua', 'First', 'h-first');
      const queued = store.create('ua', 'Queued', 'h-queued');
      await waitFor(
        async () =>
          (
            await other<{ n: number }[]>`
              select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`
          )[0].n >= 1,
        20_000,
      );
      tick(3_600_000);
      await other.unsafe(`select pg_advisory_unlock(${lockKey})`);
      const [a, b] = await Promise.all([first, queued]);
      expect(a.kind === 'created' && a.device.created_at_utc).toBe(t0);
      expect(b.kind === 'created' && b.device.created_at_utc).toBe(
        new Date(clock.now()).toISOString(),
      );
    } finally {
      await other.end();
    }
  });
});
