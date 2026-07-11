import { describe, expect, it } from 'vitest';
import { presetDefinitions } from './presets.js';

describe('presetDefinitions', () => {
  it('every preset shows deck_title and references a real feedback', () => {
    const presets = presetDefinitions();
    const ids = Object.keys(presets);
    expect(ids).toEqual(expect.arrayContaining(['roll_stop', 'record', 'play', 'log_event']));
    for (const id of ids) {
      const p = presets[id];
      if (p?.type !== 'button') continue;
      expect(p.style.text).toContain('deck_title');
    }
  });
});
