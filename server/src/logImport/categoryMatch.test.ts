import { describe, expect, it } from 'vitest';
import { type CategoryLike, mapLogCategory } from './categoryMatch';

const cats: CategoryLike[] = [
  { id: 'edit', name: 'EDIT', type: 'BUTTON', dropdown_options: [], on_label: '', off_label: '' },
  { id: 'other', name: 'OTHER', type: 'BUTTON', dropdown_options: [], on_label: '', off_label: '' },
  { id: 'promo', name: 'PROMO', type: 'BUTTON', dropdown_options: [], on_label: '', off_label: '' },
  {
    id: 'seg',
    name: 'SEGMENT',
    type: 'DROPDOWN',
    dropdown_options: [{ label: 'INTRO' }, { label: 'TEST SEGMENT' }],
    on_label: '',
    off_label: '',
  },
];

describe('mapLogCategory', () => {
  it('blank type → OTHER', () => {
    expect(mapLogCategory('', 'hello', cats)).toEqual({
      categoryId: 'other',
      message: 'hello',
      importOption: null,
    });
  });

  it('PROMO matches button name', () => {
    expect(mapLogCategory('PROMO', 'note', cats).categoryId).toBe('promo');
  });

  it('unmatched appends to message', () => {
    expect(mapLogCategory('laugh', 'funny', cats)).toEqual({
      categoryId: 'other',
      message: 'funny - laugh',
      importOption: null,
    });
  });

  it('prefers longest dropdown label', () => {
    const r = mapLogCategory('TEST SEGMENT', 'x', cats);
    expect(r.categoryId).toBe('seg');
    expect(r.importOption).toBe('TEST SEGMENT');
  });
});
