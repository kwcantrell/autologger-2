// Store SQL that SQLite accepted and Postgres refuses (catalog-on-postgres D4): the show list's
// case-insensitive order and the membership inserts that ignore an existing row.

import { describe, expect, it } from 'vitest';
import { env } from './harness';
import { catalogFor, seedShow, seedStudio, seedUser } from './helpers';

describe('catalog store dialect on Postgres (catalog-on-postgres D4)', () => {
  it('lists a team’s shows by name ignoring ASCII case, ties bytewise (catalog-database spec)', async () => {
    const studioId = await seedStudio();
    for (const name of ['b', 'A', 'a']) await seedShow({ studioId, name });
    const names = (await catalogFor().shows.listShowsForStudio(studioId)).map((r) => r.name);
    expect(names).toEqual(['A', 'a', 'b']);
  });

  it('re-adding an existing membership is a no-op, on both insert paths', async () => {
    const studioId = await seedStudio();
    const userId = await seedUser({ studios: [studioId] });
    const cat = catalogFor();
    await cat.auth.authAddMemberships(userId, [studioId]);
    await cat.auth.authAddMembershipWithRole(userId, studioId, 'admin');
    const rows = await env.ports.catalog.all<{ role: string }>(
      'SELECT role FROM user_studio_memberships WHERE user_id = ? AND studio_id = ?',
      userId,
      studioId,
    );
    // One row, and the existing role is preserved (the invite path never upgrades a member).
    expect(rows).toEqual([{ role: 'member' }]);
  });
});
