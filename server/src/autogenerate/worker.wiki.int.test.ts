// batch-autogenerate task 4.7 (design D12; show-wiki "A batch job accepts suggestions as its
// initiator"; owner decision 8a): in `accept` mode the job accepts, as its initiator and with the
// batch note, only new pages and additions-only rewrites its own run stored; everything else, a
// page edited after the run and a new-page title clash stay pending; `pending` mode accepts nothing;
// no suggestion of another run is accepted and none is dismissed. Real Postgres, stubbed AI SDK
// provider.

import { afterEach, describe, expect, it } from 'vitest';
import { type AgWorld, agWorld, scripted } from '../test/autogenerateWorld';
import { callTools } from '../test/fakeLlm';
import { closeFakes } from '../test/generationFixtures';
import { testDb } from '../test/helpers';

afterEach(closeFakes);

interface Pages {
  adds: string;
  changes: string;
  drops: string;
  titled: string;
  aliased: string;
  stale: string;
  other: string;
}

const proposals = (pg: Pages) =>
  [
    { kind: 'topic', title: 'Brand New', aliases: [], body_md: 'Fresh.\n' },
    { kind: 'topic', title: 'Late Clash', aliases: [], body_md: 'Clash.\n' },
    { page_id: pg.adds, title: 'Adds', aliases: [], body_md: 'A\nB\nnew' },
    { page_id: pg.changes, title: 'Changes', aliases: [], body_md: 'A\nB more' },
    { page_id: pg.drops, title: 'Drops', aliases: [], body_md: 'A' },
    { page_id: pg.titled, title: 'Titled Renamed', aliases: [], body_md: 'A\nB\nnew' },
    { page_id: pg.aliased, title: 'Aliased', aliases: [], body_md: 'A\nB\nnew' },
    { page_id: pg.stale, title: 'Stale', aliases: [], body_md: 'A\nB\nnew' },
  ].map((args) => ({
    name: 'propose_page',
    args: { ...args, rationale: 'Comes up in this session.' },
  }));

async function world(mode: 'accept' | 'pending') {
  const pages = {} as Pages;
  const script = scripted((kind, _t, round) =>
    kind === 'wiki' && round === 1 ? callTools(2, proposals(pages)) : undefined,
  );
  const w = await agWorld({ sessions: 1, steps: ['wiki'], wikiMode: mode, script });
  const create = async (title: string, aliases: string[] = []) =>
    (await w.p.catalog.wiki.createPage(w.showId, { kind: 'topic', title, bodyMd: 'A\nB', aliases }))
      .id;
  pages.adds = await create('Adds');
  pages.changes = await create('Changes');
  pages.drops = await create('Drops');
  pages.titled = await create('Titled');
  pages.aliased = await create('Aliased', ['al']);
  pages.stale = await create('Stale');
  pages.other = await create('Other');
  // A pending suggestion of another run, on a page this job does not target.
  await w.p.catalog.wiki.saveRun(w.showId, w.sessions[0] as string, 'another-run', [
    {
      target: { type: 'page', pageId: pages.other, baseRevision: 1 },
      kind: 'topic',
      title: 'Other',
      aliases: [],
      bodyMd: 'A\nB\nmore',
      rationale: 'Another run.',
    },
  ]);
  return { w, pages };
}

/** Runs the job; between the run's store and the accepts, a person edits the stale page and a
 * page takes the new page's title. */
async function run(w: AgWorld, pages: Pages) {
  const { worker, ports } = w.worker('w1');
  const accept = ports.steps.acceptWiki.bind(ports.steps);
  ports.steps = {
    ...ports.steps,
    acceptWiki: async (...a) => {
      await w.p.catalog.wiki.updatePage(pages.stale, {
        expectedRevision: 1,
        bodyMd: 'A\nB\nperson',
      });
      await w.p.catalog.wiki.createPage(w.showId, { kind: 'topic', title: 'Late Clash' });
      return accept(...a);
    },
  };
  await worker.tick();
}

const byTitle = async (w: AgWorld) =>
  Object.fromEntries(
    (
      await testDb().all<{
        title: string;
        status: string;
        run_id: string;
        resolved_by: string | null;
      }>(
        'SELECT title, status, run_id, resolved_by FROM wiki_suggestions WHERE show_id = ?',
        w.showId,
      )
    ).map((r) => [r.title, r]),
  );

describe('wiki auto-accept, safe changes only (design D12)', () => {
  it('accepts a new page and an additions-only rewrite as the initiator with the batch note; leaves the rest pending', async () => {
    const { w, pages } = await world('accept');
    await run(w, pages);
    const s = await byTitle(w);
    expect(s['Brand New']).toMatchObject({ status: 'accepted', resolved_by: w.uid });
    expect(s.Adds).toMatchObject({ status: 'accepted', resolved_by: w.uid });
    for (const t of ['Changes', 'Drops', 'Titled Renamed', 'Aliased', 'Stale', 'Late Clash']) {
      expect(s[t]?.status, t).toBe('pending');
    }
    // Another run's suggestion is untouched; nothing is dismissed.
    expect(s.Other).toMatchObject({ status: 'pending', run_id: 'another-run' });
    expect(Object.values(s).some((x) => x.status === 'dismissed')).toBe(false);
    expect(await w.item(w.sessions[0] as string, 'wiki')).toMatchObject({
      status: 'done',
      wiki_accepted: 2,
      wiki_pending: 6,
    });
    const revs = await testDb().all<{ title: string; author_user_id: string; note: string }>(
      `SELECT r.title, r.author_user_id, r.note FROM wiki_revisions r
       JOIN wiki_pages p ON p.id = r.page_id
       WHERE p.show_id = ? AND r.note LIKE '%(batch %'`,
      w.showId,
    );
    expect(revs.map((r) => r.title).sort()).toEqual(['Adds', 'Brand New']);
    for (const r of revs) {
      expect(r.author_user_id).toBe(w.uid);
      expect(r.note).toMatch(
        new RegExp(`^(accepted|created from) suggestion [0-9a-f-]+ \\(batch ${w.jobId}\\)$`),
      );
    }
    expect(revs.find((r) => r.title === 'Adds')?.note).toMatch(/^accepted suggestion /);
    expect(revs.find((r) => r.title === 'Brand New')?.note).toMatch(/^created from suggestion /);
  });

  it('pending mode leaves every suggestion pending', async () => {
    const { w, pages } = await world('pending');
    await run(w, pages);
    const s = await byTitle(w);
    expect(Object.values(s).every((x) => x.status === 'pending')).toBe(true);
    expect(await w.item(w.sessions[0] as string, 'wiki')).toMatchObject({
      status: 'done',
      wiki_accepted: 0,
      wiki_pending: 8,
    });
  });
});
