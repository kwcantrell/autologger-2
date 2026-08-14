// GENERATED — DO NOT EDIT BY HAND.
//
// Captured from a real `GET /api/shows?studio_id=…` response by
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
  "shows": [
    {
      "id": "########-####-####-####-############",
      "studio_id": "test-studios",
      "name": "All The Smoke",
      "show_code": "ATS",
      "title_suffix": "date",
      "categories": [
        {
          "id": "cam",
          "name": "Camera",
          "color": "#112233",
          "type": "BUTTON",
          "dropdown_options": [],
          "on_label": "",
          "off_label": ""
        },
        {
          "id": "mic",
          "name": "Mic",
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
          "name": "Tally",
          "color": "#ff8800",
          "type": "ON_OFF",
          "dropdown_options": [],
          "on_label": "ON",
          "off_label": "OFF"
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
    },
    {
      "id": "show-autolog-test",
      "studio_id": "test-studios",
      "name": "Autolog Test Show",
      "show_code": "ATS",
      "title_suffix": "episode",
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
        "#4a9fd4",
        "#a86bdc",
        "#6bcf7a",
        "#64748b",
        "#64748b",
        "#64748b",
        "#64748b",
        "#64748b",
        "#64748b"
      ],
      "event_palette_preset": "custom",
      "event_palette_custom": [
        "#4a9fd4",
        "#a86bdc",
        "#6bcf7a",
        "#64748b",
        "#64748b",
        "#64748b",
        "#64748b",
        "#64748b",
        "#64748b"
      ]
    }
  ]
} as const;

export const showsList = captured as Mutable<typeof captured>;
