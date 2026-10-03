// catalog-policies design D10 (owner decision A): cross-team contention. Two team owners each run
// one user-bound transaction through the server's adapter (`bindUser(...).tx`, so its retry loop
// applies) on a clone with planner statistics (`ANALYZE` after seeding). Each reads its own
// membership `FOR SHARE`, updates a session, creates a show and renames its team, and a barrier
// keeps either from committing before both have written. Either may abort with `40001`; the test
// asserts that both commit within the retry budget and prints the retries counted (D11). It does
// not assert that no retry occurred.
import { Catalog } from '@autologger/catalog';
import { PostgresCatalogDb } from '@autologger/storage';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../test/pg/testDb';
import { RetryCountingRoot } from '../retryCounter';

const open: PostgresCatalogDb[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

const TEAMS = ['t', 'u'] as const;
const MAX_TRIES = 5; // the adapter's default

describe('cross-team contention (catalog-policies D10)', () => {
  it('two owners of different teams both commit through the retry loop on an analyzed clone', async () => {
    const { app, admin } = await createTestDatabase();
    const adapter = new PostgresCatalogDb(app);
    open.push(adapter);

    // Seed as catalog_system through the real stores: an owner, a show and a session per team.
    const seed = new Catalog(adapter.bindSystem('test-seed'));
    const ids: Record<string, { owner: string; session: string }> = {};
    for (const team of TEAMS) {
      const owner = `owner-${team}`;
      await seed.auth.authCreateUserGoogle({
        id: owner,
        email: `${owner}@example.com`,
        googleSub: `${owner}-sub`,
        givenName: 'Owner',
        familyName: team,
        pictureUrl: '',
      });
      await seed.studios.adminCreateStudio(`team-${team}`, `Team ${team}`);
      await seed.auth.authAddMembershipWithRole(owner, `team-${team}`, 'owner');
      const showId = await seed.shows.createShow({
        studioId: `team-${team}`,
        name: `Show ${team}`,
        showCode: `S${team}`,
        categoriesJson: '[]',
        paletteJson: '[]',
        paletteCustomJson: '[]',
      });
      const now = new Date().toISOString();
      const session = await seed.sessions.createSessionIndex({
        showId,
        title: `Session ${team}`,
        frameRate: 24,
        startOffsetFrames: 0,
        episode: '001',
        notes: '',
        startedAtUtc: now,
        createdAtUtc: now,
      });
      ids[team] = { owner, session };
    }

    const sql = postgres({ ...admin, max: 1, onnotice: () => {} });
    try {
      await sql.unsafe('analyze');
    } finally {
      await sql.end();
    }

    // Neither transaction commits before both have written (in some run of their bodies).
    const arrived = new Set<string>();
    let open_!: () => void;
    const barrier = new Promise<void>((r) => {
      open_ = r;
    });
    const arrive = async (team: string): Promise<void> => {
      arrived.add(team);
      if (arrived.size === TEAMS.length) open_();
      // A safety net, so a body that failed before arriving cannot hang the other forever.
      await Promise.race([barrier, new Promise((r) => setTimeout(r, 5_000))]);
    };

    const counting = new RetryCountingRoot(adapter);
    const run = (team: string) =>
      counting.bindUser(ids[team].owner).tx(async (t) => {
        const cat = new Catalog(t);
        const role = await cat.auth.authGetMembershipRoleForShare(ids[team].owner, `team-${team}`);
        if (role !== 'owner') throw new Error(`${team}: owner membership not readable`);
        const upd = await t.run(
          'UPDATE sessions SET title = ? WHERE id = ?',
          `Written ${team}`,
          ids[team].session,
        );
        if (upd.changes !== 1) throw new Error(`${team}: session update changed ${upd.changes}`);
        await cat.shows.createShow({
          studioId: `team-${team}`,
          name: `New ${team}`,
          showCode: `N${team}`,
          categoriesJson: '[]',
          paletteJson: '[]',
          paletteCustomJson: '[]',
        });
        await t.run(
          'UPDATE studio_definitions SET display_name = ? WHERE id = ?',
          `Renamed ${team}`,
          `team-${team}`,
        );
        await arrive(team);
      });

    const results = await Promise.allSettled(TEAMS.map((team) => run(team)));
    const retries = counting.calls.reduce((sum, c) => sum + c.runs - 1, 0);
    // Written past vitest's console capture so the line lands in the run's log.
    process.stdout.write(
      `${JSON.stringify({
        contention: true,
        calls: counting.calls.length,
        runs: counting.calls.map((c) => c.runs),
        codes: counting.calls.flatMap((c) => c.codes),
        retries,
        rate: retries / counting.calls.length,
        exhausted: counting.calls.filter((c) => c.exhausted).length,
      })}\n`,
    );

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(counting.calls).toHaveLength(2);
    for (const c of counting.calls) {
      expect(c.exhausted).toBe(false);
      expect(c.runs).toBeLessThan(MAX_TRIES);
    }

    const check = adapter.bindSystem('test-seed');
    for (const team of TEAMS) {
      expect(
        await check.first('SELECT title FROM sessions WHERE id = ?', ids[team].session),
      ).toEqual({ title: `Written ${team}` });
      expect(
        await check.first('SELECT display_name FROM studio_definitions WHERE id = ?', `team-${team}`),
      ).toEqual({ display_name: `Renamed ${team}` });
      expect(
        await check.all('SELECT studio_id FROM shows WHERE name = ?', `New ${team}`),
      ).toEqual([{ studio_id: `team-${team}` }]);
    }
  });
});
