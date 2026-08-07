// session-title-suffix (design D5, gate ruling 2026-08-02): `deck_title` now
// equals the trimmed stored session `title` everywhere (Companion state,
// session list/detail, session status), falling back to `"—"` only when the
// title is blank. It no longer derives `{show_code} - {episode}` — this file
// used to pin output-equality against that derivation (the deleted
// per-router `sessionDeckFromRow`/`deckTitle` copies); it now pins the NEW
// invariant across every call-site argument shape, including the cases that
// used to matter under the old derivation (a present show code) to confirm
// they no longer influence the result.

import { describe, expect, it } from 'vitest';
import { sessionDeckDisplayTitle } from '../studio';

const SHOW_CODES: (string | null)[] = ['TS', ' TS ', '', '   ', null];
const EPISODES: (string | null)[] = ['001', ' 7 ', '', '   ', null];
const TITLES: unknown[] = ['My Session', '  padded  ', '', '   ', null, undefined];

describe('sessionDeckDisplayTitle — deck_title equals stored title (D5)', () => {
  it('is the trimmed stored title regardless of showCode/episode', () => {
    for (const showCode of SHOW_CODES) {
      for (const episode of EPISODES) {
        for (const title of TITLES) {
          const storedTitle = String(title ?? '');
          const expected = storedTitle.trim() || '—';
          expect(sessionDeckDisplayTitle({ showCode, episode, storedTitle })).toBe(expected);
        }
      }
    }
  });

  it('falls back to "—" when the stored title is blank, even with a show code present', () => {
    expect(sessionDeckDisplayTitle({ showCode: 'HD', episode: '7', storedTitle: '   ' })).toBe('—');
    expect(sessionDeckDisplayTitle({ showCode: 'HD', episode: '7', storedTitle: '' })).toBe('—');
  });

  it('returns the stored title verbatim (trimmed) when a show code is present', () => {
    expect(
      sessionDeckDisplayTitle({ showCode: 'HD', episode: '7', storedTitle: 'HD_260802' }),
    ).toBe('HD_260802');
  });
});
