// The CompanionDeviceStore on `catalog.companion_devices` (companion-devices D2, D5; api-contract-
// freeze "Companion device tokens authenticate only the Companion surface") against the catalog
// adapter as the app's least-privilege role on a cloned test database. Users are seeded on a test
// system handle; the store binds its own `companion-device` reason. Times come from a fake clock.
import type { CatalogDb } from '@autologger/ports';
import { afterEach, describe, expect, it } from 'vitest';
import {
  COMPANION_DEVICE_CAP,
  COMPANION_DEVICE_IDLE_MS,
  PostgresCompanionDeviceStore,
} from './companionDevices';
import { PostgresCatalogDb } from './postgresCatalogStore';
import { createTestDatabase } from './test/pgDb';

const DAY = 86_400_000;
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
  return { db, store, clock, tick, rows, create };
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
});
