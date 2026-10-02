# Tasks

The first commit on `hotfix-encoded-path-gate` holds only `openspec/changes/gate-decoded-path/`.
The PR targets `main` (owner-approved exception to the migration freeze). Logs go to the session
scratchpad as `hf-<task>-<red|green>.log`.

## 1. Regression tests first (design D2)

- [x] 1.1 Add the D2 cases to `server/src/routers/gate.int.test.ts` and `authz.int.test.ts`.
  Verify: the cases D2 names as red fail before 2.1 (for example, no-credential `/%61pi/sessions`
  gets 200; record the failure lines). The guard cases pass both before and after.
  Evidence: `cd server && npx vitest run src/routers/gate.int.test.ts src/routers/authz.int.test.ts`
  (`hf-1.1-red.log`) -> `Tests  9 failed | 16 passed (25)`:
  - `/%61pi/sessions with no credentials is 401` -> `expected 200 to be 401`, and the same for
    `/a%70i`, `/%61%70%69` and the authz token-only `/%61pi/sessions/<id>/status`;
  - `/api/%63ompanion/state` with the token -> `expected 401 to be 200`;
  - `GET /api/pro%66ile` -> `expected 401 to be 200`;
  - `/api/%61dmin/users` -> `{ detail: 'Login required.' }` instead of the admin-token detail;
  - the table case -> `expected 'GET /api/sessions/:sessionId/ws -> 404' to be '... -> 401'`.

  The encoded later segments of `profile` and `admin` were red too. The panel's probe predicted
  this (`oldGate: true`), although D2 listed them as guards. `/api/s%65ssions`, `/%61pi/profile`
  and `/%61pi/admin/users` passed before the fix (guards).

## 2. Fix (design D1)

- [x] 2.1 In `server/src/middleware/auth.ts`, use `c.req.path` for both the `API_TOKEN` scope and
  the login decision, and update the comment.
  Verify: 1.1 green, and the full server suite is green.
  Evidence:
  - `hf-2.1-green.log` -> `Tests  25 passed (25)`;
  - `cd server && npx vitest run` (`hf-2.1-suite.log`) -> `Test Files  54 passed | 2 skipped (56)`,
    `Tests  806 passed | 3 skipped (809)`;
  - `cd server && npx tsc --noEmit -p .` -> exit 0;
  - `npx biome check` on the 3 changed files -> `No fixes applied`.

## 3. Verification

- [x] 3.1 Run `scripts/check-change.sh --stage hook`; it is green.
  Evidence: `scripts/check-change.sh --stage hook` -> every gate PASS, including `size  4/400 changed
  lines` and `commands  ran ['typecheck', 'test']`. This was after the owner unpacked the pinned
  `@playwright/test`/`playwright`/`playwright-core` 1.61.1 into `node_modules` (it had been
  installed from `supabase-migration`, which dropped Playwright).
  `node -e "require('better-sqlite3')"` -> `better-sqlite3 ok`.
- [x] 3.2 Real-HTTP check. Stage runs the Supabase integration branch and can't be rebuilt from
  `main` without tearing it down, so this check uses a real socket instead. In
  `server/src/routers/apiToken.int.test.ts`, the real-server suite (`serve()` on 127.0.0.1)
  sends raw request-targets: `/api/sessions`, `/%61pi/sessions`, `/a%70i/sessions`,
  `/%61pi/companion/state` (with and without the token), `/api/%63ompanion/state` with the token,
  a token on `/%61pi/sessions`, and `/%61pi/profile`. The router's forwarding of encoded prefixes
  is unchanged and was already observed through the stage router (panel: `/%61pi/sessions -> 200`).
  Verify: red against the pre-fix `auth.ts`, green with the fix.
  Evidence:
  - with `auth.ts` from 8e74b53 (temporarily restored):
    `npx vitest run src/routers/apiToken.int.test.ts -t "real HTTP"` (`hf-3.2-red.log`) ->
    `AssertionError: expected 200 to be 401`, `Tests  1 failed | 11 skipped`;
  - with the fix restored: `npx vitest run src/routers/apiToken.int.test.ts`
    (`hf-3.2-green.log`) -> `Tests  12 passed (12)`;
  - `npx biome check` -> `No fixes applied`.
