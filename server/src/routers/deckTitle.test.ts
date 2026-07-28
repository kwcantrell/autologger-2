// Output-equality pinning for task 2.1 (code-health-tail, finding 2.4): the two
// deleted per-router deck-title copies — events.ts `sessionDeckFromRow` and
// companion.ts `deckTitle` — must produce byte-identical output to the canonical
// `sessionDeckDisplayTitle` under each call site's exact argument mapping. The
// reference implementations below are verbatim copies of the deleted code.

import { describe, expect, it } from 'vitest';
import { sessionDeckDisplayTitle } from '../studio';

/** Verbatim copy of the deleted events.ts helper. */
function referenceSessionDeckFromRow(
  row: { title?: unknown },
  showCode: string | null,
  episode: string,
): string {
  const sc = String(showCode ?? '').trim();
  if (sc) return `${sc} - ${episode.trim() || '1'}`;
  const t = String(row.title ?? '').trim();
  return t || '—';
}

/** Verbatim copy of the deleted companion.ts helper. */
function referenceDeckTitle(row: Record<string, unknown>): string {
  const sc = String(row.show_code ?? '').trim();
  if (sc) return `${sc} - ${String(row.episode ?? '').trim() || '1'}`;
  const t = String(row.title ?? '').trim();
  return t || '—';
}

const SHOW_CODES: (string | null)[] = ['TS', ' TS ', '', '   ', null];
const EPISODES: (string | null)[] = ['001', ' 7 ', '', '   ', null];
const TITLES: unknown[] = ['My Session', '  padded  ', '', '   ', null, undefined];

describe('sessionDeckDisplayTitle output-equality with the deleted copies', () => {
  it('matches events.ts sessionDeckFromRow under the /status call-site mapping', () => {
    // Call site: showCode = (row.show_code as string | null) ?? null;
    //            episode  = String(row.episode ?? '');
    //            storedTitle = String(row.title ?? '')
    for (const show_code of SHOW_CODES) {
      for (const rawEpisode of EPISODES) {
        for (const title of TITLES) {
          const showCode = show_code ?? null;
          const episode = String(rawEpisode ?? '');
          expect(
            sessionDeckDisplayTitle({ showCode, episode, storedTitle: String(title ?? '') }),
          ).toBe(referenceSessionDeckFromRow({ title }, showCode, episode));
        }
      }
    }
  });

  it('matches companion.ts deckTitle under the /state call-site mapping', () => {
    // Call site reads the joined row directly: show_code / episode / title.
    for (const show_code of SHOW_CODES) {
      for (const episode of EPISODES) {
        for (const title of TITLES) {
          const row: Record<string, unknown> = { show_code, episode, title };
          expect(
            sessionDeckDisplayTitle({
              showCode: String(row.show_code ?? ''),
              episode: String(row.episode ?? ''),
              storedTitle: String(row.title ?? ''),
            }),
          ).toBe(referenceDeckTitle(row));
        }
      }
    }
  });
});
