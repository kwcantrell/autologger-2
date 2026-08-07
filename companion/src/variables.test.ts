import { describe, expect, it } from 'vitest';
import { variableDefinitions } from './variables.js';

// session-title-suffix (task 2.4, Unit B review finding F2): `deck_title` now mirrors the
// stored session title everywhere (design D5), not `{show_code} - {episode}` — the Companion
// variable label was updated to match (06c08e4) but had no test pinning it. This closes that
// gap the way `presets.test.ts` / `state.test.ts` pin their own Companion surfaces.
describe('variableDefinitions', () => {
  it('labels deck_title as the session name, not show + episode', () => {
    const defs = variableDefinitions();
    const deckTitle = defs.find((d) => d.variableId === 'deck_title');
    expect(deckTitle?.name).toBe('Deck title (session name)');
  });
});
