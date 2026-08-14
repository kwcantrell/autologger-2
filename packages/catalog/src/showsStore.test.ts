import { describe, expect, it } from 'vitest';
import { showApiDict, showBriefApiDict, showCategoriesApiShape } from './showsStore';

describe('showApiDict', () => {
  it('shapes a full show row with a custom palette', () => {
    const row = {
      id: 'sh1',
      studio_id: 'st1',
      name: 'My Show',
      show_code: 'MS',
      title_suffix: 'episode',
      categories_json: '[{"label":"Cue","type":"BUTTON","color":"#ff0000"}]',
      event_palette_json: '["#111111","#222222"]',
      event_palette_preset: 'custom',
      event_palette_custom_json: '["#333333"]',
    };
    expect(showApiDict(row)).toEqual({
      id: 'sh1',
      studio_id: 'st1',
      name: 'My Show',
      show_code: 'MS',
      title_suffix: 'episode',
      categories: [{ label: 'Cue', type: 'BUTTON', color: '#ff0000' }],
      // normalizeEventPaletteNine pads to 9 slots from a default fill sequence
      event_palette: [
        '#111111',
        '#222222',
        '#64748b',
        '#e53935',
        '#fb8c00',
        '#fdd835',
        '#43a047',
        '#00acc1',
        '#1e88e5',
      ],
      event_palette_preset: 'custom',
      event_palette_custom: [
        '#333333',
        '#64748b',
        '#e53935',
        '#fb8c00',
        '#fdd835',
        '#43a047',
        '#00acc1',
        '#1e88e5',
        '#8e24aa',
      ],
    });
  });

  it('defaults title_suffix to "date" and empty palettes/categories on bad JSON', () => {
    const row = {
      id: 'sh2',
      studio_id: 'st2',
      name: 'Bare',
      show_code: 'BR',
      title_suffix: undefined,
      categories_json: 'not json',
      event_palette_json: 'not json',
      event_palette_preset: '',
      event_palette_custom_json: 'not json',
    };
    const out = showApiDict(row);
    expect(out.title_suffix).toBe('date');
    expect(out.categories).toEqual([]);
    // empty palette → full default fill sequence
    const defaultFill = [
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
    expect(out.event_palette).toEqual(defaultFill);
    // empty custom falls back to a copy of the (filled) palette
    expect(out.event_palette_custom).toEqual(defaultFill);
    expect(out.event_palette_preset).toBe('custom');
  });

  it('normalizes any non-"episode" title_suffix (case/whitespace-insensitive match) to "date"', () => {
    const base = {
      id: 'sh3',
      studio_id: 'st3',
      name: 'Weird',
      show_code: 'WD',
      categories_json: '[]',
      event_palette_json: '[]',
      event_palette_preset: 'custom',
      event_palette_custom_json: '[]',
    };
    expect(showApiDict({ ...base, title_suffix: ' Episode ' }).title_suffix).toBe('episode');
    expect(showApiDict({ ...base, title_suffix: 'garbage' }).title_suffix).toBe('date');
    expect(showApiDict({ ...base, title_suffix: '' }).title_suffix).toBe('date');
  });
});

describe('showBriefApiDict', () => {
  const row = {
    id: 'sh1',
    studio_id: 'st1',
    name: 'My Show',
    show_code: 'MS',
    title_suffix: ' Episode ',
    categories_json: '[{"label":"Cue","type":"BUTTON","color":"#ff0000"}]',
    event_palette_json: '["#111111","#222222"]',
    event_palette_preset: 'custom',
    event_palette_custom_json: '["#333333"]',
  };

  // `toEqual` on the whole object, not per-key presence checks: the point of
  // the brief shape is what it does NOT carry, so a re-added field has to fail
  // here (profile-shows-slimming).
  it('emits exactly the five identity/selection keys, dropping categories + palettes', () => {
    expect(showBriefApiDict(row)).toEqual({
      id: 'sh1',
      studio_id: 'st1',
      name: 'My Show',
      show_code: 'MS',
      // Same normalization as showApiDict — NewSessionModal branches on this
      // value at selection time, so it must be the wire enum, not the column.
      title_suffix: 'episode',
    });
  });

  it('normalizes title_suffix identically to showApiDict', () => {
    expect(showBriefApiDict({ ...row, title_suffix: 'garbage' }).title_suffix).toBe('date');
    expect(showBriefApiDict({ ...row, title_suffix: undefined }).title_suffix).toBe('date');
    const full = showApiDict({ ...row, title_suffix: 'EPISODE' });
    expect(showBriefApiDict({ ...row, title_suffix: 'EPISODE' }).title_suffix).toBe(
      full.title_suffix,
    );
  });

  it('is a strict projection of showApiDict — every brief key matches the full shape', () => {
    const brief = showBriefApiDict(row);
    const full = showApiDict(row);
    for (const [key, value] of Object.entries(brief)) {
      expect(full[key]).toEqual(value);
    }
  });
});

describe('showCategoriesApiShape', () => {
  it('shapes BUTTON and DROPDOWN categories, dropping non-objects', () => {
    const raw = [
      { id: 'c1', label: 'Mic', color: '#7cb7ff', type: 'button' },
      {
        id: 'c2',
        name: 'Scene',
        type: 'dropdown',
        dropdown_options: ['One', { label: 'Two', needs_context: true }, { name: '' }],
        on_label: 'ON',
        off_label: 'OFF',
      },
      'garbage',
      null,
    ];
    expect(showCategoriesApiShape(raw)).toEqual([
      {
        id: 'c1',
        label: 'Mic',
        color: '#7cb7ff',
        type: 'BUTTON',
        dropdown_options: [],
        on_label: '',
        off_label: '',
      },
      {
        id: 'c2',
        label: 'Scene',
        color: '#7cb7ff',
        type: 'DROPDOWN',
        dropdown_options: [
          { label: 'One', needs_context: false },
          { label: 'Two', needs_context: true },
        ],
        on_label: 'ON',
        off_label: 'OFF',
      },
    ]);
  });

  it('returns [] for non-array input', () => {
    expect(showCategoriesApiShape('nope')).toEqual([]);
    expect(showCategoriesApiShape(null)).toEqual([]);
  });
});
