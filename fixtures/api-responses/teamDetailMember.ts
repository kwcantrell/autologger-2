// GENERATED — DO NOT EDIT BY HAND.
//
// Captured from a real `GET /api/teams/:id (caller is a plain member)` response by
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
  "id": "my-crew",
  "name": "My Crew",
  "role": "member",
  "enabled_admin_count": 1,
  "members": [
    {
      "id": "########-####-####-####-############",
      "email": "ann@example.com",
      "given_name": "Test",
      "family_name": "User",
      "role": "admin"
    },
    {
      "id": "########-####-####-####-############",
      "email": "bo@example.com",
      "given_name": "Test",
      "family_name": "User",
      "role": "member"
    }
  ]
} as const;

export const teamDetailMember = captured as Mutable<typeof captured>;
