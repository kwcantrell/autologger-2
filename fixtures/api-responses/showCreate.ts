// GENERATED — DO NOT EDIT BY HAND.
//
// Captured from a real `POST /api/shows` response by
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
  "show": {
    "id": "########-####-####-####-############",
    "studio_id": "test-studios",
    "name": "All The Smoke",
    "show_code": "ATS",
    "next_episode": 1,
    "categories": [
      {
        "id": "########-####-####-####-############",
        "name": "Scene",
        "color": "#4a9fd4",
        "type": "BUTTON",
        "dropdown_options": [],
        "on_label": "",
        "off_label": ""
      },
      {
        "id": "########-####-####-####-############",
        "name": "Audio issue",
        "color": "#a86bdc",
        "type": "DROPDOWN",
        "dropdown_options": [
          {
            "label": "Lav",
            "needs_context": false
          },
          {
            "label": "Boom",
            "needs_context": false
          }
        ],
        "on_label": "",
        "off_label": ""
      },
      {
        "id": "########-####-####-####-############",
        "name": "Note",
        "color": "#6bcf7a",
        "type": "TEXT",
        "dropdown_options": [],
        "on_label": "",
        "off_label": ""
      }
    ],
    "event_palette": [
      "#64748b",
      "#e53935",
      "#fb8c00",
      "#fdd835",
      "#43a047",
      "#00acc1",
      "#1e88e5",
      "#8e24aa",
      "#ec407a"
    ],
    "event_palette_preset": "custom",
    "event_palette_custom": [
      "#64748b",
      "#e53935",
      "#fb8c00",
      "#fdd835",
      "#43a047",
      "#00acc1",
      "#1e88e5",
      "#8e24aa",
      "#ec407a"
    ]
  }
} as const;

export const showCreate = captured as Mutable<typeof captured>;
