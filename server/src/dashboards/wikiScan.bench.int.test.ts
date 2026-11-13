// The rule 2 scan of design 5.4, measured (custom session dashboards J5; section 13.3 item 4: no
// citation index until a measurement says the scan is slow). Off by default; run with
// RUN_WIKI_SCAN_BENCH=1. It fills one show with 2,000 live pages (the wiki list cap) of about
// 10,000 characters each, `citing` of which cite the session, and times `associatedPages`, the
// read every `list_wiki_pages`, `get_wiki_page` and `get_session` call runs.

import { describe, expect, it } from 'vitest';
import { catalogFor, seedSession, seedShow, seedStudio, seedUser, testDb } from '../test/helpers';
import { associatedPages, type QueryCaller } from './query';

const PAGES = 2000;
const BODY_CHARS = 10_000;

async function fill(showId: string, sessionId: string, citing: number) {
  const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(
    Math.ceil(BODY_CHARS / 57),
  );
  const now = new Date().toISOString();
  for (let i = 0; i < PAGES; i++) {
    const cite = i < citing ? ` [quote](cite:${sessionId}@${i}) ` : ' ';
    const body = (filler.slice(0, BODY_CHARS / 2) + cite + filler.slice(0, BODY_CHARS / 2)).slice(
      0,
      BODY_CHARS + 60,
    );
    await testDb().run(
      `INSERT INTO wiki_pages (id, show_id, kind, title, body_md, revision, created_by,
         created_by_name, created_at_utc, updated_by, updated_by_name, updated_at_utc)
       VALUES (?, ?, 'topic', ?, ?, 1, 'u', 'U', ?, 'u', 'U', ?)`,
      `bench-${citing}-${i}`,
      showId,
      `Page ${i}`,
      body,
      now,
      now,
    );
  }
}

describe.skipIf(process.env.RUN_WIKI_SCAN_BENCH !== '1')('rule 2 scan time (design 5.4)', () => {
  it.each([20, 200, 2000])(
    '2,000 pages of 10,000 characters, %i citing the session',
    async (citing) => {
      const studioId = await seedStudio();
      const showId = await seedShow({ studioId });
      const sessionId = await seedSession({ showId });
      const userId = await seedUser({ studios: [studioId], role: 'admin' });
      await fill(showId, sessionId, citing);
      const catalog = catalogFor().forUser(userId);
      await catalog.init();
      const q = { userId, catalog } as unknown as QueryCaller;
      const times: number[] = [];
      for (let run = 0; run < 5; run++) {
        const t0 = performance.now();
        const pages = await associatedPages(q, sessionId, showId);
        times.push(performance.now() - t0);
        expect(pages.length).toBe(citing);
      }
      times.sort((a, b) => a - b);
      process.stderr.write(
        `RULE2_SCAN pages=${PAGES} body_chars=${BODY_CHARS} citing=${citing} ` +
          `median_ms=${times[2]?.toFixed(1)} min_ms=${times[0]?.toFixed(1)} max_ms=${times[4]?.toFixed(1)}\n`,
      );
    },
    600_000,
  );
});
