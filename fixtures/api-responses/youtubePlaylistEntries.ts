// GENERATED — DO NOT EDIT BY HAND.
//
// Captured from a real `POST /api/youtube/playlist-entries` response by
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
  "playlist": {
    "id": "PLBB231211A4F62143",
    "title": "Team Fortress 2 [2010 Version]",
    "url": "https://www.youtube.com/playlist?list=PLBB231211A4F62143"
  },
  "entries": [
    {
      "index": 1,
      "video_id": "RlJy2Kt8Be0",
      "url": "https://www.youtube.com/watch?v=RlJy2Kt8Be0",
      "title": "Let's Play Team Fortress 2 [2010] - Intro",
      "duration_s": 629,
      "importable": true,
      "reason": null
    },
    {
      "index": 2,
      "video_id": "me4As6zyJk4",
      "url": "https://www.youtube.com/watch?v=me4As6zyJk4",
      "title": null,
      "duration_s": null,
      "importable": false,
      "reason": "unavailable"
    },
    {
      "index": 3,
      "video_id": "SvtxuD_Abf0",
      "url": "https://www.youtube.com/watch?v=SvtxuD_Abf0",
      "title": "Let's Play Team Fortress 2 [2010] - Medic [3/4]",
      "duration_s": 16606,
      "importable": false,
      "reason": "too_long"
    }
  ],
  "truncated": false
} as const;

export const youtubePlaylistEntries = captured as Mutable<typeof captured>;
