import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE, normalizePalette9 } from './palette9';

// Reconciliation test for the single-sourced palette-9 normalizer
// (code-health-tail task 4.5, finding 2.7, D12/W5). HomeSettingsModal and
// EventButtonsTable previously carried slightly different implementations of
// the same function; both are reproduced VERBATIM below (only renamed) and the
// shared util is asserted output-equal to BOTH across valid / invalid / short /
// long / mixed-case palette inputs — the explicit evidence that the two prior
// implementations agreed (same 9 default values, same /^#[0-9a-f]{6}$/ regex,
// same lowercase-then-validate order, same modulo fallback) and that the kept
// map-over-fixed-indices shape changes nothing.

// ── Verbatim prior implementation 1: HomeSettingsModal.tsx (for-loop shape) ──
function legacyHomeSettingsNormalizePalette9(arr: string[]): string[] {
  const defaults = [
    '#64748b',
    '#e53935',
    '#fb8c00',
    '#fdd835',
    '#43a047',
    '#00acc1',
    '#1e88e5',
    '#8e24aa',
    '#ec407a',
  ];
  const out: string[] = [];
  for (let i = 0; i < 9; i++) {
    const h = (arr[i] ?? '').toLowerCase();
    out.push(/^#[0-9a-f]{6}$/.test(h) ? h : defaults[i % defaults.length]);
  }
  return out;
}

// ── Verbatim prior implementation 2: EventButtonsTable.tsx (map shape) ───────
const LEGACY_EBT_DEFAULT_PALETTE = [
  '#64748b',
  '#e53935',
  '#fb8c00',
  '#fdd835',
  '#43a047',
  '#00acc1',
  '#1e88e5',
  '#8e24aa',
  '#ec407a',
];
const LEGACY_EBT_SLOT_INDICES = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;
function legacyEventButtonsNormalizePalette9(arr: string[]): string[] {
  return LEGACY_EBT_SLOT_INDICES.map((i) => {
    const h = (arr[i] ?? '').toLowerCase();
    return /^#[0-9a-f]{6}$/.test(h)
      ? h
      : LEGACY_EBT_DEFAULT_PALETTE[i % LEGACY_EBT_DEFAULT_PALETTE.length];
  });
}

const CASES: Record<string, string[]> = {
  'valid full palette': [
    '#111111',
    '#222222',
    '#333333',
    '#444444',
    '#555555',
    '#666666',
    '#777777',
    '#888888',
    '#999999',
  ],
  'empty input': [],
  'short input (3 entries)': ['#abcdef', '#012345', '#fedcba'],
  'long input (11 entries, extras ignored)': [
    '#101010',
    '#202020',
    '#303030',
    '#404040',
    '#505050',
    '#606060',
    '#707070',
    '#808080',
    '#909090',
    '#a0a0a0',
    '#b0b0b0',
  ],
  'invalid entries fall back per slot': [
    'red',
    '#12345',
    '#1234567',
    '#GGGGGG',
    '',
    ' #abcdef',
    '#abc',
    'rgb(1,2,3)',
    '#abcdefff',
  ],
  'mixed-case hex is lowercased': [
    '#ABCDEF',
    '#AbCdEf',
    '#abcdef',
    '#FFFFFF',
    '#ffffff',
    '#FfFfFf',
    '#000000',
    '#0A0B0C',
    '#D1E2F3',
  ],
  'sparse validity (alternating)': [
    '#111111',
    'bad',
    '#333333',
    'bad',
    '#555555',
    'bad',
    '#777777',
    'bad',
    '#999999',
  ],
};

describe('normalizePalette9', () => {
  for (const [name, input] of Object.entries(CASES)) {
    it(`matches BOTH prior implementations: ${name}`, () => {
      const got = normalizePalette9(input);
      expect(got).toEqual(legacyHomeSettingsNormalizePalette9(input));
      expect(got).toEqual(legacyEventButtonsNormalizePalette9(input));
    });
  }

  it('always yields exactly 9 lowercase #rrggbb entries', () => {
    for (const input of Object.values(CASES)) {
      const got = normalizePalette9(input);
      expect(got).toHaveLength(9);
      for (const h of got) expect(h).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('fills invalid/missing slots from DEFAULT_PALETTE positionally', () => {
    expect(normalizePalette9([])).toEqual(DEFAULT_PALETTE);
    const short = normalizePalette9(['#abcdef']);
    expect(short[0]).toBe('#abcdef');
    expect(short.slice(1)).toEqual(DEFAULT_PALETTE.slice(1));
  });
});
