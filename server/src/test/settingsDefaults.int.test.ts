// catalog-database "Settings defaults are race-free and never recreate a deleted team"
// (catalog-concurrency-hazards D4).

import { Catalog } from '@autologger/catalog';
import { describe, expect, it } from 'vitest';
import { seedStudio, testDb } from './helpers';

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

describe('studio settings defaults', () => {
  it('five concurrent first reads all succeed and store one row', async () => {
    const team = await seedStudio();
    const cats = await Promise.all([1, 2, 3, 4, 5].map(() => initedCatalog()));
    const blobs = await Promise.all(cats.map((c) => c.studios.getStudioSettingsBlob(team)));
    expect(blobs).toHaveLength(5);
    for (const b of blobs) expect(Array.isArray(b.categories)).toBe(true);
    expect(await settingsRows(team)).toHaveLength(1);
  });

  it('a read through a snapshot taken before the team was deleted stores nothing', async () => {
    const team = await seedStudio();
    const stale = await initedCatalog(); // knows the team
    await (await initedCatalog()).studios.adminDeleteStudio(team);
    const blob = await stale.studios.getStudioSettingsBlob(team);
    expect(Array.isArray(blob.categories)).toBe(true);
    expect(await settingsRows(team)).toEqual([]);
  });

  it('a corrupt blob is replaced once with defaults', async () => {
    const team = await seedStudio();
    await testDb().run(
      'INSERT INTO app_settings (key, value) VALUES (?, ?)',
      `studio_config:${team}`,
      '{not json',
    );
    const cat = await initedCatalog();
    const blob = await cat.studios.getStudioSettingsBlob(team);
    expect(Array.isArray(blob.categories)).toBe(true);
    const rows = await settingsRows(team);
    expect(rows).toHaveLength(1);
    expect(() => JSON.parse(String(rows[0]?.value))).not.toThrow();
  });
});
