import { describe, expect, it } from 'vitest';
import {
  blobToProfile,
  categoryIsInstructionBearing,
  defaultSettingsBlob,
  freshCategoryIds,
  normalizeEventButtonNameForRelink,
  normalizeEventPaletteNine,
  paletteFromCategories,
  studioConfigKey,
  suggestedShowCode,
  ValidationError,
  validateCategoriesList,
  validateEventPalette,
  validateEventPalettePreset,
} from './studio';

describe('event palette', () => {
  it('defaults when input is null/empty', () => {
    expect(validateEventPalette(null).length).toBeGreaterThan(0);
    expect(validateEventPalette([]).length).toBeGreaterThan(0);
  });
  it('normalizeEventPaletteNine always returns 9 slots', () => {
    expect(normalizeEventPaletteNine(['#111111'])).toHaveLength(9);
    expect(normalizeEventPaletteNine([])).toHaveLength(9);
  });
  it('clamps a longer custom palette to at most 9', () => {
    const many = Array(20).fill('#123456');
    expect(validateEventPalette(many).length).toBeLessThanOrEqual(9);
  });
  it('validateEventPalettePreset returns a string', () => {
    expect(typeof validateEventPalettePreset('custom')).toBe('string');
  });
});

describe('categories', () => {
  it('freshCategoryIds assigns a NEW id to every category (no shared refs)', () => {
    const cats = validateCategoriesList([
      { name: 'A', type: 'BUTTON', color: '#111111' },
      { name: 'B', type: 'TEXT', color: '#222222' },
    ]);
    const a = freshCategoryIds(cats);
    const b = freshCategoryIds(cats);
    const aIds = a.map((c) => c.id);
    expect(new Set(aIds).size).toBe(aIds.length); // unique within
    expect(a[0].id).not.toBe(b[0].id); // unique across calls
  });
  it('validateCategoriesList coerces an unknown kind to BUTTON', () => {
    const cats = validateCategoriesList([{ name: 'X', type: 'WeIrD', color: '#abcdef' }]);
    expect(cats[0].type).toBe('BUTTON');
  });
  it('paletteFromCategories returns an array', () => {
    const cats = validateCategoriesList([{ name: 'X', type: 'BUTTON', color: '#abcdef' }]);
    expect(Array.isArray(paletteFromCategories(cats))).toBe(true);
  });
});

describe('auto_instruction carry-through (validateCategoriesList)', () => {
  it('carries a trimmed category-level auto_instruction on BUTTON / TEXT / DROPDOWN', () => {
    const cats = validateCategoriesList([
      { name: 'Slate', type: 'BUTTON', color: '#111111', auto_instruction: '  log every slate  ' },
      { name: 'Note', type: 'TEXT', color: '#222222', auto_instruction: 'summarize notes' },
      {
        name: 'Audio',
        type: 'DROPDOWN',
        color: '#333333',
        auto_instruction: 'audio problems',
        dropdown_options: ['Lav', 'Boom'],
      },
    ]);
    expect(cats[0].auto_instruction).toBe('log every slate');
    expect(cats[1].auto_instruction).toBe('summarize notes');
    expect(cats[2].auto_instruction).toBe('audio problems');
  });

  it('carries a trimmed option-level auto_instruction on DROPDOWN options', () => {
    const cats = validateCategoriesList([
      {
        name: 'Audio',
        type: 'DROPDOWN',
        color: '#333333',
        dropdown_options: [
          { label: 'Lav', needs_context: false, auto_instruction: '  lav rustle  ' },
          { label: 'Boom', needs_context: true },
        ],
      },
    ]);
    expect(cats[0].dropdown_options[0].auto_instruction).toBe('lav rustle');
    expect(cats[0].dropdown_options[0].needs_context).toBe(false);
    expect('auto_instruction' in cats[0].dropdown_options[1]).toBe(false);
  });

  it('omits the key when absent or empty/whitespace-only (category and option level)', () => {
    const cats = validateCategoriesList([
      { name: 'A', type: 'BUTTON', color: '#111111' },
      { name: 'B', type: 'BUTTON', color: '#222222', auto_instruction: '   ' },
      {
        name: 'C',
        type: 'DROPDOWN',
        color: '#333333',
        dropdown_options: [
          { label: 'X', auto_instruction: '' },
          { label: 'Y', auto_instruction: '   ' },
        ],
      },
    ]);
    expect('auto_instruction' in cats[0]).toBe(false);
    expect('auto_instruction' in cats[1]).toBe(false);
    expect('auto_instruction' in cats[2].dropdown_options[0]).toBe(false);
    expect('auto_instruction' in cats[2].dropdown_options[1]).toBe(false);
  });

  it('accepts exactly 2000 chars and rejects 2001 with ValidationError (category level)', () => {
    const ok = validateCategoriesList([
      { name: 'A', type: 'BUTTON', color: '#111111', auto_instruction: 'x'.repeat(2000) },
    ]);
    expect(ok[0].auto_instruction).toHaveLength(2000);
    expect(() =>
      validateCategoriesList([
        { name: 'A', type: 'BUTTON', color: '#111111', auto_instruction: 'x'.repeat(2001) },
      ]),
    ).toThrow(ValidationError);
  });

  it('rejects an over-long option-level auto_instruction with ValidationError', () => {
    expect(() =>
      validateCategoriesList([
        {
          name: 'Audio',
          type: 'DROPDOWN',
          color: '#333333',
          dropdown_options: [{ label: 'Lav', auto_instruction: 'x'.repeat(2001) }, 'Boom'],
        },
      ]),
    ).toThrow(ValidationError);
  });

  it('drops auto_instruction on ON_OFF categories without erroring', () => {
    const cats = validateCategoriesList([
      {
        name: 'Rolling',
        type: 'ON_OFF',
        color: '#111111',
        on_label: 'ON',
        off_label: 'OFF',
        auto_instruction: 'never carried',
      },
    ]);
    expect(cats[0].type).toBe('ON_OFF');
    expect('auto_instruction' in cats[0]).toBe(false);
  });

  it('round-trips verbatim through the profile update path (stringify → parse)', () => {
    // profile.ts stores JSON.stringify(validateCategoriesList(...)) into
    // categories_json; profile reads parse that column back verbatim
    // (showsStore categoriesListFromShowRow). Simulate that persistence hop.
    const input = [
      { name: 'Slate', type: 'BUTTON', color: '#111111', auto_instruction: 'log every slate' },
      {
        name: 'Audio',
        type: 'DROPDOWN',
        color: '#333333',
        auto_instruction: 'whole-button context',
        dropdown_options: [
          { label: 'Lav', needs_context: false, auto_instruction: 'lav rustle' },
          'Boom',
        ],
      },
    ];
    const stored = JSON.parse(JSON.stringify(validateCategoriesList(input)));
    expect(stored[0].auto_instruction).toBe('log every slate');
    expect(stored[1].auto_instruction).toBe('whole-button context');
    expect(stored[1].dropdown_options[0].auto_instruction).toBe('lav rustle');
    expect('auto_instruction' in stored[1].dropdown_options[1]).toBe(false);
    // Re-normalizing the stored shape is stable (settings re-save path).
    const again = validateCategoriesList(stored);
    expect(JSON.parse(JSON.stringify(again))).toEqual(stored);
  });
});

describe('categoryIsInstructionBearing', () => {
  it('true when the category own auto_instruction is non-empty', () => {
    const cats = validateCategoriesList([
      { name: 'A', type: 'BUTTON', color: '#111111', auto_instruction: 'hit' },
    ]);
    expect(categoryIsInstructionBearing(cats[0])).toBe(true);
  });

  it('true for an option-only DROPDOWN (no button-level instruction)', () => {
    const cats = validateCategoriesList([
      {
        name: 'Audio',
        type: 'DROPDOWN',
        color: '#333333',
        dropdown_options: [{ label: 'Lav', auto_instruction: 'lav rustle' }, 'Boom'],
      },
    ]);
    expect(categoryIsInstructionBearing(cats[0])).toBe(true);
  });

  it('false when no instruction anywhere', () => {
    const cats = validateCategoriesList([
      { name: 'A', type: 'BUTTON', color: '#111111' },
      { name: 'B', type: 'DROPDOWN', color: '#222222', dropdown_options: ['X', 'Y'] },
    ]);
    expect(categoryIsInstructionBearing(cats[0])).toBe(false);
    expect(categoryIsInstructionBearing(cats[1])).toBe(false);
  });

  it('never true for ON_OFF, even with a stale instruction on raw parsed JSON', () => {
    // Raw (un-normalized) stored JSON could carry the field; the definition
    // still excludes ON_OFF in any casing.
    expect(categoryIsInstructionBearing({ type: 'ON_OFF', auto_instruction: 'stale' })).toBe(false);
    expect(categoryIsInstructionBearing({ type: 'on_off', auto_instruction: 'stale' })).toBe(false);
  });

  it('false on whitespace-only instructions and non-object inputs', () => {
    expect(categoryIsInstructionBearing({ type: 'BUTTON', auto_instruction: '   ' })).toBe(false);
    expect(
      categoryIsInstructionBearing({
        type: 'DROPDOWN',
        dropdown_options: [{ label: 'X', auto_instruction: '  ' }, 'Y'],
      }),
    ).toBe(false);
    expect(categoryIsInstructionBearing(null)).toBe(false);
    expect(categoryIsInstructionBearing('BUTTON')).toBe(false);
  });
});

describe('profile + misc helpers', () => {
  it('defaultSettingsBlob → blobToProfile round-trips id/name', () => {
    const blob = defaultSettingsBlob('studio-x');
    const profile = blobToProfile('studio-x', 'Studio X', blob);
    expect(profile).toMatchObject({ id: 'studio-x', name: 'Studio X' });
    expect(Array.isArray(profile.categories)).toBe(true);
  });
  it('studioConfigKey contains the studio id', () => {
    expect(studioConfigKey('abc')).toContain('abc');
  });
  it('suggestedShowCode derives a non-empty string from a name', () => {
    const code = suggestedShowCode('My Great Show');
    expect(typeof code).toBe('string');
    expect(code.length).toBeGreaterThan(0);
  });
  it('normalizeEventButtonNameForRelink trims to a stable key', () => {
    expect(normalizeEventButtonNameForRelink('  Cam 1 ')).toBe(
      normalizeEventButtonNameForRelink('Cam 1'),
    );
  });
});
