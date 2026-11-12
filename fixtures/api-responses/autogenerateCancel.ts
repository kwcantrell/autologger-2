// GENERATED — DO NOT EDIT BY HAND.
//
// Captured from a real `POST /api/teams/:teamId/autogenerate-jobs/:jobId/cancel` response by
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
  "job": {
    "id": "########-####-####-####-############",
    "team_id": "batch-crew",
    "status": "cancelled",
    "stop_reason": "cancelled",
    "scope": "shows",
    "show_ids": [
      "########-####-####-####-############"
    ],
    "steps": [
      "transcript"
    ],
    "wiki_mode": "pending",
    "initiator_id": "########-####-####-####-############",
    "initiator_name": "Test User",
    "cancel_requested_by_name": "Test User",
    "cancel_requested_at_utc": "####-##-##T##:##:##.###Z",
    "created_at_utc": "####-##-##T##:##:##.###Z",
    "started_at_utc": null,
    "finished_at_utc": "####-##-##T##:##:##.###Z",
    "sessions": 2,
    "counts": {
      "pending": 0,
      "running": 0,
      "done": 0,
      "skipped": 0,
      "failed": 0,
      "cancelled": 2
    },
    "current": null
  }
} as const;

export const autogenerateCancel = captured as Mutable<typeof captured>;
