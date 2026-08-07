// session-title-suffix (design D5, gate ruling 2026-08-02): `deck_title` now
// equals the trimmed stored session `title` everywhere (Companion state,
// session list/detail, session status), falling back to `"—"` only when the
// title is blank. It no longer derives `{show_code} - {episode}` — this file
// used to pin output-equality against that derivation (the deleted
// per-router `sessionDeckFromRow`/`deckTitle` copies). Phase 3 (Unit B review
// F4) trimmed the dead `showCode`/`episode` params off the helper's signature
// entirely once no call site needed them — this file now pins the
// single-param shape.

import { sessionDeckDisplayTitle } from '@autologger/domain';
import { describe, expect, it } from 'vitest';

const TITLES: unknown[] = ['My Session', '  padded  ', '', '   ', null, undefined];

describe('sessionDeckDisplayTitle — deck_title equals stored title (D5)', () => {
  it('is the trimmed stored title', () => {
    for (const title of TITLES) {
      const storedTitle = String(title ?? '');
      const expected = storedTitle.trim() || '—';
      expect(sessionDeckDisplayTitle({ storedTitle })).toBe(expected);
    }
  });

  it('falls back to "—" when the stored title is blank', () => {
    expect(sessionDeckDisplayTitle({ storedTitle: '   ' })).toBe('—');
    expect(sessionDeckDisplayTitle({ storedTitle: '' })).toBe('—');
  });

  it('returns the stored title verbatim (trimmed)', () => {
    expect(sessionDeckDisplayTitle({ storedTitle: 'HD_260802' })).toBe('HD_260802');
  });
});
