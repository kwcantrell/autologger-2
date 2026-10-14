// GENERATED — DO NOT EDIT BY HAND.
//
// Captured from a real `POST /api/wiki/suggestions/:suggestionId/accept` response by
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
  "page": {
    "id": "########-####-####-####-############",
    "show_id": "########-####-####-####-############",
    "kind": "person",
    "title": "Christina Ramos",
    "body_md": "Co-host. [She opens the show](cite:########-####-####-####-############@12).",
    "aliases": [
      "Tina"
    ],
    "session_id": null,
    "revision": 2,
    "merged_into": null,
    "deleted": false,
    "created_at_utc": "####-##-##T##:##:##.###Z",
    "created_by_name": "Default User",
    "updated_at_utc": "####-##-##T##:##:##.###Z",
    "updated_by_name": "Default User"
  },
  "suggestion": {
    "id": "########-####-####-####-############",
    "show_id": "########-####-####-####-############",
    "session_id": "########-####-####-####-############",
    "status": "accepted",
    "page_id": "########-####-####-####-############",
    "base_revision": 1,
    "kind": "person",
    "title": "Christina Ramos",
    "aliases": [
      "Tina"
    ],
    "rationale": "She opens this session.",
    "page": {
      "title": "Christina Ramos",
      "revision": 2,
      "state": "live"
    },
    "stale": true,
    "created_at_utc": "####-##-##T##:##:##.###Z",
    "created_by_name": "Default User",
    "resolved_at_utc": "####-##-##T##:##:##.###Z",
    "resolved_by_name": "Default User",
    "resolved_revision": 2
  }
} as const;

export const wikiSuggestionAccept = captured as Mutable<typeof captured>;
