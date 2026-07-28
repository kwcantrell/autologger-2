// GENERATED — DO NOT EDIT BY HAND.
//
// Captured from a real `GET /api/profile (anonymous, oauth unconfigured)` response by
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
  "active_studio_id": "test-studios",
  "active_show_id": "########-####-####-####-############",
  "active_studio": {
    "id": "test-studios",
    "name": "Test Studio",
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
          "Lav",
          "Boom"
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
    ]
  },
  "studios": [
    {
      "id": "test-studios",
      "name": "Test Studio"
    },
    {
      "id": "test-studio-2",
      "name": "Test Studio 2"
    }
  ],
  "studio_settings": {
    "test-studios": {
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
      "show_title_format": "ATS",
      "default_frame_rate": 24
    },
    "test-studio-2": {
      "categories": [
        {
          "id": "########-####-####-####-############",
          "name": "Note",
          "color": "#7cb7ff",
          "type": "TEXT",
          "dropdown_options": [],
          "on_label": "",
          "off_label": ""
        },
        {
          "id": "########-####-####-####-############",
          "name": "Mark",
          "color": "#f4a82e",
          "type": "BUTTON",
          "dropdown_options": [],
          "on_label": "",
          "off_label": ""
        }
      ],
      "show_title_format": "",
      "default_frame_rate": 24
    }
  },
  "shows": [
    {
      "id": "########-####-####-####-############",
      "studio_id": "test-studios",
      "name": "All The Smoke",
      "show_code": "ATS",
      "next_episode": 1,
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
    },
    {
      "id": "show-the-something-podcast",
      "studio_id": "test-studio-2",
      "name": "The Something Podcast",
      "show_code": "TSP",
      "next_episode": 1,
      "categories": [
        {
          "id": "########-####-####-####-############",
          "name": "Note",
          "color": "#7cb7ff",
          "type": "TEXT",
          "dropdown_options": [],
          "on_label": "",
          "off_label": ""
        },
        {
          "id": "########-####-####-####-############",
          "name": "Mark",
          "color": "#f4a82e",
          "type": "BUTTON",
          "dropdown_options": [],
          "on_label": "",
          "off_label": ""
        }
      ],
      "event_palette": [
        "#7cb7ff",
        "#f4a82e",
        "#64748b",
        "#64748b",
        "#64748b",
        "#64748b",
        "#64748b",
        "#64748b",
        "#64748b"
      ],
      "event_palette_preset": "custom",
      "event_palette_custom": [
        "#7cb7ff",
        "#f4a82e",
        "#64748b",
        "#64748b",
        "#64748b",
        "#64748b",
        "#64748b",
        "#64748b",
        "#64748b"
      ]
    }
  ],
  "new_session_defaults": {
    "title_prefix": "ATS - Episode ",
    "default_frame_rate": 24
  },
  "admin": {
    "restart_supported": false,
    "restart_needs_token": true
  },
  "auth": {
    "logged_in": false,
    "user": null,
    "oauth_configured": false
  }
} as const;

export const profileAnonymous = captured as Mutable<typeof captured>;
