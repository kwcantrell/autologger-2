import { describe, expect, it } from 'vitest';
import { allocateTitleForBase, dateSuffixBase, padEpisodeToken } from './sessionTitleDerivation';

describe('padEpisodeToken (D4)', () => {
  it('pads single/double-digit values to width 4', () => {
    expect(padEpisodeToken('1')).toBe('0001');
    expect(padEpisodeToken('12')).toBe('0012');
  });

  it('pads 0 to 0000', () => {
    expect(padEpisodeToken('0')).toBe('0000');
  });

  it('leaves 9999 unchanged (already width 4)', () => {
    expect(padEpisodeToken('9999')).toBe('9999');
  });

  it('re-pads a leading-zero digit string by integer value', () => {
    expect(padEpisodeToken('00001')).toBe('0001');
    expect(padEpisodeToken('007')).toBe('0007');
  });

  it('leaves values > 9999 unchanged, including leading-zero forms', () => {
    expect(padEpisodeToken('10000')).toBe('10000');
    expect(padEpisodeToken('10001')).toBe('10001');
    expect(padEpisodeToken('00010000')).toBe('00010000');
  });

  it('leaves non-numeric tokens unchanged', () => {
    expect(padEpisodeToken('Pilot')).toBe('Pilot');
    expect(padEpisodeToken('S2E1')).toBe('S2E1');
    expect(padEpisodeToken('')).toBe('');
  });
});

describe('dateSuffixBase (D2 — UTC calendar date)', () => {
  it('formats CODE_YYMMDD from a UTC instant', () => {
    // 2026-08-02T12:00:00.000Z
    const ms = Date.UTC(2026, 7, 2, 12, 0, 0);
    expect(dateSuffixBase('HD', ms)).toBe('HD_260802');
  });

  it('zero-pads single-digit month/day', () => {
    const ms = Date.UTC(2026, 0, 5, 0, 0, 0); // 2026-01-05
    expect(dateSuffixBase('HD', ms)).toBe('HD_260105');
  });

  it('uses UTC fields regardless of local wall-clock time near midnight', () => {
    // 2026-08-02T23:59:00.000Z — a moment that would read as 2026-08-03 in
    // positive-offset local zones if the implementation used local getters.
    const ms = Date.UTC(2026, 7, 2, 23, 59, 0);
    expect(dateSuffixBase('HD', ms)).toBe('HD_260802');
  });

  it('wraps the 2-digit year via mod 100', () => {
    const ms = Date.UTC(2000, 0, 1, 0, 0, 0);
    expect(dateSuffixBase('HD', ms)).toBe('HD_000101');
    const ms2 = Date.UTC(2099, 11, 31, 0, 0, 0);
    expect(dateSuffixBase('HD', ms2)).toBe('HD_991231');
  });
});

describe('allocateTitleForBase (D3 — max-occupied-slot + 1)', () => {
  const base = 'HD_260802';

  it('returns the bare base when nothing occupies it', () => {
    expect(allocateTitleForBase([], base)).toBe(base);
    expect(allocateTitleForBase(['OTHER_TITLE'], base)).toBe(base);
  });

  it('returns _002 when only the bare base is occupied', () => {
    expect(allocateTitleForBase([base], base)).toBe(`${base}_002`);
  });

  it('uses max-occupied-slot + 1 after a gap left by a rename', () => {
    expect(allocateTitleForBase([base, `${base}_003`], base)).toBe(`${base}_004`);
  });

  it('ignores non-digit suffixes', () => {
    expect(allocateTitleForBase([base, `${base}_00a`, `${base}_x`], base)).toBe(`${base}_002`);
  });

  it('computes the max slot even when the bare base row is absent', () => {
    expect(allocateTitleForBase([`${base}_005`], base)).toBe(`${base}_006`);
  });

  it('keeps full decimal width for slots >= 1000 (no truncation to 3)', () => {
    expect(allocateTitleForBase([base, `${base}_1000`], base)).toBe(`${base}_1001`);
  });

  it('treats leading-zero suffix digits by integer value', () => {
    expect(allocateTitleForBase([base, `${base}_0002`], base)).toBe(`${base}_003`);
  });

  it('does not match a title lacking the separating underscore', () => {
    expect(allocateTitleForBase([`${base}002`], base)).toBe(base);
  });

  it('matches literally — a show code containing "_" is not a SQL wildcard hazard', () => {
    const underscoreBase = 'A_B_260802';
    expect(allocateTitleForBase([underscoreBase, `${underscoreBase}_002`], underscoreBase)).toBe(
      `${underscoreBase}_003`,
    );
    // A title that would spuriously LIKE-match "A_B_260802_%" (any single
    // char for each "_") but is not a literal match must NOT count.
    expect(allocateTitleForBase(['AxBx260802_002'], underscoreBase)).toBe(underscoreBase);
  });

  it('escapes regex-special characters in the base (defense in depth)', () => {
    const dottedBase = 'A.B_260802';
    expect(allocateTitleForBase(['AXB_260802_002'], dottedBase)).toBe(dottedBase);
    expect(allocateTitleForBase([dottedBase, `${dottedBase}_002`], dottedBase)).toBe(
      `${dottedBase}_003`,
    );
  });
});
