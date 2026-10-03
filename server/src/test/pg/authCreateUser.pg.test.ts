// gotrue-sign-in D4: the account id is the Supabase Auth user id, so concurrent first sign-ins
// insert the same id and subject, and an id GoTrue linked to another Google account clashes on the
// primary key. Neither may surface as a 23505: the insert returns null and the router re-reads.
import { AuthStore } from '@autologger/catalog';
import type { CatalogDb } from '@autologger/ports';
import { PostgresCatalogDb } from '@autologger/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../test/pg/testDb';

const open: PostgresCatalogDb[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});
/** Two adapters on one fresh database, as two server requests would see it; each as a
 * `system:test` handle (catalog-roles D12). */
async function twoAdapters(): Promise<[CatalogDb, CatalogDb]> {
  const { app } = await createTestDatabase();
  const pair: [PostgresCatalogDb, PostgresCatalogDb] = [
    new PostgresCatalogDb(app),
    new PostgresCatalogDb(app),
  ];
  open.push(...pair);
  return [pair[0].bindSystem('test'), pair[1].bindSystem('test')];
}
const user = (id: string, googleSub: string) => ({
  id,
  googleSub,
  email: `${googleSub}@example.com`,
  givenName: 'A',
  familyName: 'B',
  pictureUrl: '',
});

describe('authCreateUserGoogle with the Supabase Auth id', () => {
  it('an id already held by another Google account returns null, not a unique violation', async () => {
    const [db] = await twoAdapters();
    const store = new AuthStore(db);
    expect(await store.authCreateUserGoogle(user('gt-1', 'sub-a'))).toBe('gt-1');
    expect(await store.authCreateUserGoogle(user('gt-1', 'sub-b'))).toBeNull();
  });

  it('two overlapping first sign-ins for one account: one gets the id, the other null', async () => {
    const [a, b] = await twoAdapters();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let inserted!: () => void;
    const didInsert = new Promise<void>((r) => {
      inserted = r;
    });
    const first = a.tx(async (t) => {
      const id = await new AuthStore(t).authCreateUserGoogle(user('gt-twin', 'sub-twin'));
      inserted();
      await gate;
      return id;
    });
    await didInsert;
    const second = b.tx((t) => new AuthStore(t).authCreateUserGoogle(user('gt-twin', 'sub-twin')));
    await new Promise((r) => setTimeout(r, 100)); // the second insert is now waiting on the first
    release();
    expect(await first).toBe('gt-twin');
    expect(await second).toBeNull();
  });
});
