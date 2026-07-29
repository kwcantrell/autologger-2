// auto-generate-event-logs task 1.2 — the additive top-level
// `auto_instructions_present` boolean on `GET /api/sessions/:id/show-categories`
// (delta spec "Per-button generation instructions persist on the show",
// scenario "Feed client learns instruction presence; Companion unchanged").
//
// The boolean is computed in the events router from the show's categories via
// the single instruction-bearing definition (`categoryIsInstructionBearing`,
// `server/src/studio.ts`); the shared `showCategoriesApiShape` projection is
// NOT extended, so `categories` entries carry no instruction fields — asserted
// here by exact key set. The Companion byte-shape pin lives in
// `companion.int.test.ts` beside the rest of that route's suite.

import { describe, expect, it } from 'vitest';
import { app, env } from '../test/harness';
import { seededSession } from '../test/helpers';

/** A DROPDOWN whose only instruction sits on an option — the option-only case
 * the spec scenario singles out (button-level `auto_instruction` absent). */
const OPTION_ONLY_DROPDOWN_JSON = JSON.stringify([
  {
    id: 'cam',
    name: 'Camera',
    color: '#112233',
    type: 'BUTTON',
    dropdown_options: [],
    on_label: '',
    off_label: '',
  },
  {
    id: 'mic',
    name: 'Mic',
    color: '#7cb7ff',
    type: 'DROPDOWN',
    dropdown_options: [
      { label: 'Lav', needs_context: false, auto_instruction: 'log every lav handoff' },
      { label: 'Boom', needs_context: true },
    ],
    on_label: '',
    off_label: '',
  },
]);

/** An ON_OFF carrying a stale `auto_instruction` (reachable only by writing
 * categories JSON directly — normalization drops it), which must never make
 * the show instruction-bearing. */
const ON_OFF_STALE_JSON = JSON.stringify([
  {
    id: 'tally',
    name: 'Tally',
    color: '#ff8800',
    type: 'ON_OFF',
    dropdown_options: [],
    on_label: 'ON',
    off_label: 'OFF',
    auto_instruction: 'stale — ON_OFF never participates',
  },
]);

async function getShowCategories(sessionId: string): Promise<Record<string, unknown>> {
  const res = await app.request(
    `/api/sessions/${sessionId}/show-categories`,
    { method: 'GET' },
    { ...env },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe('GET /api/sessions/:id/show-categories — auto_instructions_present', () => {
  it('is true for an option-only DROPDOWN, with no instruction fields on the entries', async () => {
    const { sessionId } = seededSession({ categoriesJson: OPTION_ONLY_DROPDOWN_JSON });
    const body = await getShowCategories(sessionId);
    expect(body.auto_instructions_present).toBe(true);

    // The shared projection is untouched: same key set as ever, no
    // `auto_instruction` at category or option level.
    const categories = body.categories as Array<Record<string, unknown>>;
    expect(categories).toHaveLength(2);
    for (const cat of categories) {
      expect(Object.keys(cat).sort()).toEqual([
        'color',
        'dropdown_options',
        'id',
        'label',
        'off_label',
        'on_label',
        'type',
      ]);
      for (const opt of cat.dropdown_options as Array<Record<string, unknown>>) {
        expect(Object.keys(opt).sort()).toEqual(['label', 'needs_context']);
      }
    }
  });

  it('is false when no category carries an instruction', async () => {
    const { sessionId } = seededSession(); // default seed: one plain BUTTON
    const body = await getShowCategories(sessionId);
    expect(body.auto_instructions_present).toBe(false);
  });

  it('is false when only an ON_OFF carries a stale instruction', async () => {
    const { sessionId } = seededSession({ categoriesJson: ON_OFF_STALE_JSON });
    const body = await getShowCategories(sessionId);
    expect(body.auto_instructions_present).toBe(false);
  });
});
