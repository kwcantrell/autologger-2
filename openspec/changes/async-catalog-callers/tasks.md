# Tasks

The first commit on `supabase-3b-async-catalog-callers` is `openspec/changes/async-catalog-callers/`
only. The PR targets `supabase-migration`. Gates run with `GITHUB_BASE_REF=supabase-migration`.
Keep the full output of every test and gate run in a log file, because of the intermittent web
`vitest` failure noted in slice 3a.

## 1. Close the promise-hygiene gaps first

- [ ] 1.1 Extend `server/src/promiseHygiene.repo.test.ts` (design D4).
  - **In-memory fixtures that must be flagged:**
    - `c.json(promise)`;
    - `c.json({ members })` where `members` is a promise;
    - `promise === null`;
    - an async arrow passed to a `(x) => void` parameter.
  - **Fixtures that must be accepted:**
    - `c.json(await p)`;
    - a sync block-bodied callback to a void parameter;
    - comparing an awaited value.
  - **Check:** the new fixture cases fail before the checks exist, and the real tree passes once
    they do.

## 2. Conversion

- [ ] 2.1 Teams (design D1, D2).
  - `requireTeamMember`, `requireTeamAdmin` and `countOwnedNonBuiltinTeams` become async, and
    their callers await them.
  - Await the 17 catalog calls outside the transaction-reachable code.
  - `mutate: (catalog: CatalogFacade) => undefined`, and the three arrows become block bodies.
  - `guardedAgainstLastAdmin` and `wouldStripLastEnabledAdmin` stay synchronous.
- [ ] 2.2 Profile (15), admin (12) and shows (8): await every non-D3 catalog call.
- [ ] 2.3 Auth (design D2).
  - In `auth.ts`, await `authGetUserByGoogleSubAny` and `authUpdateUserProfile`. The sign-up
    transaction body is unchanged.
  - `middleware/auth.ts`: `await catalog.init()`.
  - `identity.ts`: `await catalog.auth.authGetUserById`.
- [ ] 2.4 Checks.
  - `npx tsc --noEmit -p server` and the promise-hygiene test pass.
  - `npm test -w server` passes, and `git diff -- '*.int.test.ts'` shows no changed expectation.
  - **Completeness probe (design D4), not committed:**
    - locally retype the catalog facade and store methods (except the D3 getters) to return
      `Promise<…>`;
    - run `tsc` and the hygiene test;
    - record that findings appear only at the D2 transaction-reachable sites;
    - revert, and confirm `git status` is clean of the probe.

## 3. Docs and verification

- [ ] 3.1 ADR 0021: add the eight design D6 entries to the slice 4 hazard list, and record the 3b
  boundary (transaction-reachable code and D3 getters stay synchronous; 3d converts the former).
- [ ] 3.2 Run `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook`, with
  the size at most 400.
- [ ] 3.3 Live check: `make dev-restart`, then through the dev gate:
  - `GET /api/profile`;
  - `GET /api/shows?studio_id=…`;
  - `GET /api/teams` (anonymous dev returns 401, as before);
  - an admin route with no token returns its unchanged refusal.
- [ ] 3.4 Consistency read, archive (sync specs), commit.
