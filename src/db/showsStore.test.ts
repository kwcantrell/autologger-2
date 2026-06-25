import { describe, expect, it } from 'vitest';
import { showApiDict, showCategoriesApiShape } from './d1';

describe('showApiDict', () => {
  it('shapes a full show row with a custom palette', () => {
    const row = {
      id: 'sh1',
      studio_id: 'st1',
      name: 'My Show',
      show_code: 'MS',
      next_episode: 3,
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
      next_episode: 3,
      categories: [{ label: 'Cue', type: 'BUTTON', color: '#ff0000' }],
      // normalizeEventPaletteNine pads to 9 slots from a default fill sequence
      event_palette: [
        '#111111', '#222222', '#64748b', '#e53935', '#fb8c00', '#fdd835', '#43a047',
        '#00acc1', '#1e88e5',
      ],
      event_palette_preset: 'custom',
      event_palette_custom: [
        '#333333', '#64748b', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#00acc1',
        '#1e88e5', '#8e24aa',
      ],
    });
  });

  it('defaults next_episode to 1 and empty palettes/categories on bad JSON', () => {
    const row = {
      id: 'sh2',
      studio_id: 'st2',
      name: 'Bare',
      show_code: 'BR',
      next_episode: 0,
      categories_json: 'not json',
      event_palette_json: 'not json',
      event_palette_preset: '',
      event_palette_custom_json: 'not json',
    };
    const out = showApiDict(row);
    expect(out.next_episode).toBe(1);
    expect(out.categories).toEqual([]);
    // empty palette → full default fill sequence
    const defaultFill = [
      '#64748b', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#00acc1', '#1e88e5',
      '#8e24aa', '#ec407a',
    ];
    expect(out.event_palette).toEqual(defaultFill);
    // empty custom falls back to a copy of the (filled) palette
    expect(out.event_palette_custom).toEqual(defaultFill);
    expect(out.event_palette_preset).toBe('custom');
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
