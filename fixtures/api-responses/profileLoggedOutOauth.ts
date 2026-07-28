// GENERATED — DO NOT EDIT BY HAND.
//
// Captured from a real `GET /api/profile (logged out, oauth configured)` response by
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
  "active_studio_id": "",
  "active_show_id": "",
  "active_studio": {
    "id": "",
    "name": "",
    "categories": []
  },
  "studios": [],
  "studio_settings": {},
  "shows": [],
  "new_session_defaults": {
    "title_prefix": "Episode ",
    "default_frame_rate": 24
  },
  "admin": {
    "restart_supported": false,
    "restart_needs_token": true
  },
  "auth": {
    "logged_in": false,
    "user": null,
    "oauth_configured": true
  }
} as const;

export const profileLoggedOutOauth = captured as Mutable<typeof captured>;
