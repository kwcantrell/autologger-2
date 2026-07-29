// GENERATED — DO NOT EDIT BY HAND.
//
// Captured from a real `GET /api/sessions/:id/show-categories` response by
// `server/src/routers/apiResponseFixtures.int.test.ts` and re-asserted
// against the live handler on every server test run
// (web-api-shape-conformance, design D2/D3).
//
// Regenerate with:  npm run fixtures:capture -w server
//
// Emitted as a `.ts` module rather than `.json` because the client type this
// fixture checks contains a string-literal union: a JSON import widens
// `"admin"` to `string` and would fail the conformance assignment for a
// reason that has nothing to do with the server (design D4's verified
// wrinkle). `as const` preserves the literal; `Mutable` puts back the
// mutability `as const` takes away.
//
// Unstable values (uuids, timestamps, clock readouts) are redacted to `#` by
// the capture helper — see `server/src/test/apiFixtures.ts` for why they are
// redacted in place rather than deleted or wildcarded.

import type { Mutable } from './_mutable';

const captured = {
  "categories": [
    {
      "id": "cam",
      "label": "Camera",
      "color": "#112233",
      "type": "BUTTON",
      "dropdown_options": [],
      "on_label": "",
      "off_label": ""
    },
    {
      "id": "mic",
      "label": "Mic",
      "color": "#7cb7ff",
      "type": "DROPDOWN",
      "dropdown_options": [
        {
          "label": "Lav",
          "needs_context": false
        },
        {
          "label": "Boom",
          "needs_context": true
        }
      ],
      "on_label": "",
      "off_label": ""
    },
    {
      "id": "tally",
      "label": "Tally",
      "color": "#ff8800",
      "type": "ON_OFF",
      "dropdown_options": [],
      "on_label": "ON",
      "off_label": "OFF"
    }
  ],
  "show_name": "All The Smoke",
  "show_code": "ATS",
  "auto_instructions_present": false
} as const;

export const showCategories = captured as Mutable<typeof captured>;
