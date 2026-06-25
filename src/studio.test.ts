import { describe, expect, it } from 'vitest';
import {
  blobToProfile,
  defaultSettingsBlob,
  freshCategoryIds,
  normalizeEventButtonNameForRelink,
  normalizeEventPaletteNine,
  paletteFromCategories,
  studioConfigKey,
  suggestedShowCode,
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
