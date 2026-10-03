// catalog-database "Settings defaults are race-free and never recreate a deleted team", as
// MODIFIED by catalog-policies (design D7): a settings read writes nothing (missing or corrupt
// blobs read as the defaults), and team creation on both planes stores the default row in its
// transaction, replacing any row left under a reused id.

import { Catalog } from '@autologger/catalog';
import { defaultSettingsBlob, validateSettingsBlob } from '@autologger/domain';
import { describe, expect, it } from 'vitest';
import { anonApp, env } from './harness';
import { adminHeader, loginCookie, seedStudio, seedUser, testDb } from './helpers';

async function initedCatalog(): Promise<Catalog> {
  const cat = new Catalog(testDb());
  await cat.init();
  return cat;
}
const settingsRows = async (team: string) =>
  testDb().all<{ value: string }>(
    'SELECT value FROM app_settings WHERE key = ?',
    `studio_config:${team}`,
  );

type Blob = { categories: { id: string }[] } & Record<string, unknown>;
const withoutIds = (b: Blob) => ({ ...b, categories: b.categories.map(({ id: _, ...c }) => c) });
const DEFAULT_SHAPE = withoutIds(
  validateSettingsBlob(
    defaultSettingsBlob('x') as unknown as Record<string, unknown>,
    'x',
    () => true,
  ) as unknown as Blob,
);
const ids = (b: Record<string, unknown>) => (b as Blob).categories.map((c) => c.id);

/** The team's one stored row, which must hold default settings. */
async function expectOneDefaultRow(team: string): Promise<void> {
  const rows = await settingsRows(team);
  expect(rows, team).toHaveLength(1);
  expect(withoutIds(JSON.parse(String(rows[0]?.value)) as Blob), team).toEqual(DEFAULT_SHAPE);
}

describe('studio settings defaults', () => {
  it('five concurrent first loads return the same ids, and the one row is the creation row', async () => {
    const team = await seedStudio();
    const created = await settingsRows(team);
    expect(created).toHaveLength(1);
    const cats = await Promise.all([1, 2, 3, 4, 5].map(() => initedCatalog()));
    const blobs = await Promise.all(cats.map((c) => c.studios.getStudioSettingsBlob(team)));
    expect(blobs).toHaveLength(5);
    const first = ids(blobs[0] as Record<string, unknown>);
    for (const b of blobs) expect(ids(b)).toEqual(first);
    expect(await settingsRows(team)).toEqual(created);
  });

  it('a read with the row missing returns the defaults and writes nothing', async () => {
    const team = await seedStudio();
    await testDb().run('DELETE FROM app_settings WHERE key = ?', `studio_config:${team}`);
    const blob = await (await initedCatalog()).studios.getStudioSettingsBlob(team);
    expect(withoutIds(blob as Blob)).toEqual(withoutIds(defaultSettingsBlob(team) as unknown as Blob));
    expect(await settingsRows(team)).toEqual([]);
  });

  it('a corrupt blob reads as the defaults and stays as it is', async () => {
    const team = await seedStudio();
    await testDb().run(
      'UPDATE app_settings SET value = ? WHERE key = ?',
      '{not json',
      `studio_config:${team}`,
    );
    const blob = await (await initedCatalog()).studios.getStudioSettingsBlob(team);
    expect(withoutIds(blob as Blob)).toEqual(withoutIds(defaultSettingsBlob(team) as unknown as Blob));
    expect(await settingsRows(team)).toEqual([{ value: '{not json' }]);
  });

  it('a read through a snapshot taken before the team was deleted stores nothing', async () => {
    const team = await seedStudio();
    const stale = await initedCatalog(); // knows the team
    await (await initedCatalog()).studios.adminDeleteStudio(team);
    const blob = await stale.studios.getStudioSettingsBlob(team);
    expect(Array.isArray(blob.categories)).toBe(true);
    expect(await settingsRows(team)).toEqual([]);
  });

  it('POST /api/teams stores exactly one default row, replacing a leftover under a reused id', async () => {
    const cookie = await loginCookie(await seedUser());
    await testDb().run(
      'INSERT INTO app_settings (key, value) VALUES (?, ?)',
      'studio_config:reused-self',
      '{"x":1}',
    );
    for (const id of ['fresh-self', 'reused-self']) {
      const res = await anonApp.request(
        '/api/teams',
        {
          method: 'POST',
          headers: { Cookie: cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ id, display_name: id }),
        },
        env,
      );
      expect(res.status, id).toBe(200);
      await expectOneDefaultRow(id);
    }
  });

  it('POST /api/admin/studios stores exactly one default row, replacing a leftover under a reused id', async () => {
    await testDb().run(
      'INSERT INTO app_settings (key, value) VALUES (?, ?)',
      'studio_config:reused-admin',
      '{"x":1}',
    );
    for (const id of ['fresh-admin', 'reused-admin']) {
      const res = await anonApp.request(
        '/api/admin/studios',
        {
          method: 'POST',
          headers: { ...adminHeader('test-admin-token'), 'content-type': 'application/json' },
          body: JSON.stringify({ id, display_name: id }),
        },
        env,
      );
      expect(res.status, id).toBe(200);
      await expectOneDefaultRow(id);
    }
  });
});
