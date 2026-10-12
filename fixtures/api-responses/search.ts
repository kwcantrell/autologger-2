// GENERATED — DO NOT EDIT BY HAND.
//
// Captured from a real `GET /api/search` response by
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
  "q": "beacon",
  "shows": [
    {
      "id": "########-####-####-####-############",
      "name": "Beacon Show",
      "studio_id": "search-studio"
    }
  ],
  "moments": [
    {
      "id": "event-1",
      "sec": null,
      "kind": "event",
      "show_id": "########-####-####-####-############",
      "snippet": "beacon on camera",
      "speaker": "",
      "session_id": "########-####-####-####-############",
      "session_title": "Beacon session"
    },
    {
      "id": "topic-1",
      "sec": null,
      "kind": "topic",
      "show_id": "########-####-####-####-############",
      "snippet": "Talk about the beacon",
      "speaker": "",
      "session_id": "########-####-####-####-############",
      "session_title": "Beacon session"
    },
    {
      "id": "0",
      "sec": 12,
      "kind": "transcript",
      "show_id": "########-####-####-####-############",
      "snippet": "beacon tonight",
      "speaker": "Ann",
      "session_id": "########-####-####-####-############",
      "session_title": "Beacon session"
    }
  ],
  "studios": [
    {
      "id": "search-studio",
      "name": "Beacon Studio"
    }
  ],
  "sessions": [
    {
      "id": "########-####-####-####-############",
      "match": "title",
      "title": "Beacon session",
      "episode": "007",
      "show_id": "########-####-####-####-############",
      "snippet": null,
      "archived": false,
      "studio_id": "search-studio",
      "started_at_utc": "####-##-##T##:##:##.###Z"
    }
  ],
  "moment_sessions": [
    {
      "total": 3,
      "session_id": "########-####-####-####-############"
    }
  ]
} as const;

export const search = captured as Mutable<typeof captured>;
