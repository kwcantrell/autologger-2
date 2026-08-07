// GENERATED — DO NOT EDIT BY HAND.
//
// Captured from a real `GET /api/sessions` response by
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
  "active": [
    {
      "id": "########-####-####-####-############",
      "title": "ATS - 2",
      "deck_title": "ATS - 2",
      "show_id": "########-####-####-####-############",
      "show_code": "ATS",
      "show_name": "All The Smoke",
      "episode": "002",
      "notes": "",
      "session_status": "active",
      "frame_rate": 24,
      "start_offset_frames": 0,
      "created_at_utc": "####-##-##T##:##:##.###Z",
      "episode_date": null,
      "event_count": 0,
      "is_rolling": false,
      "current_take": 0,
      "rolling_timecode": "##:##:##:##",
      "total_runtime_hms": "##:##:##",
      "archived": false
    }
  ],
  "archived": [
    {
      "id": "########-####-####-####-############",
      "title": "ATS - 1",
      "deck_title": "ATS - 1",
      "show_id": "########-####-####-####-############",
      "show_code": "ATS",
      "show_name": "All The Smoke",
      "episode": "001",
      "notes": "",
      "session_status": "archived",
      "frame_rate": 24,
      "start_offset_frames": 0,
      "created_at_utc": "####-##-##T##:##:##.###Z",
      "episode_date": null,
      "event_count": 0,
      "is_rolling": false,
      "current_take": 0,
      "rolling_timecode": "##:##:##:##",
      "total_runtime_hms": "##:##:##",
      "archived": true
    }
  ]
} as const;

export const sessionsList = captured as Mutable<typeof captured>;
