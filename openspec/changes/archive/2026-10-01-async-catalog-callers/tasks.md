# Tasks

The first commit on `supabase-3b-async-catalog-callers` is `openspec/changes/async-catalog-callers/`
only. The PR targets `supabase-migration`. Gates run with `GITHUB_BASE_REF=supabase-migration`.
Keep the full output of every test and gate run in a log file, because of the intermittent web
`vitest` failure noted in slice 3a.

## 1. Close the promise-hygiene gaps first

- [x] 1.1 Extend `server/src/promiseHygiene.repo.test.ts` (design D4).
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
  - Evidence: `npx vitest run src/promiseHygiene.repo.test.ts` before the checks -> `× flags a
    promise as the whole c.json body` … `× flags a named async function where a void callback is
    expected`, `Tests 7 failed | 8 passed (15)`; after -> `Tests 15 passed (15)` (includes the
    real-tree case, before any conversion).

## 2. Conversion

- [x] 2.1 Teams (design D1, D2).
  - `requireTeamMember`, `requireTeamAdmin` and `countOwnedNonBuiltinTeams` become async, and
    their callers await them.
  - Await the 17 catalog calls outside the transaction-reachable code.
  - `mutate: (catalog: CatalogFacade) => undefined`, and the three arrows become block bodies.
  - `guardedAgainstLastAdmin` and `wouldStripLastEnabledAdmin` stay synchronous.
  - Evidence: temporarily making the `/leave` mutate arrow `async` -> `teams.ts(313,47): error
    TS2345: Argument of type '(cat: CatalogFacade) => Promise<void>' is not assignable to
    parameter of type '(catalog: CatalogFacade) => undefined'`; restored, `tsc` clean.
- [x] 2.2 Profile (15), admin (12) and shows (8): await every non-D3 catalog call.
  - Evidence: `git diff --stat` -> `profile.ts | 30`, `admin.ts | 24`, `shows.ts | 19`; the
    probe in 2.4 reports no finding in these files.
- [x] 2.3 Auth (design D2).
  - In `auth.ts`, await `authGetUserByGoogleSubAny` and `authUpdateUserProfile`. The sign-up
    transaction body is unchanged.
  - `middleware/auth.ts`: `await catalog.init()`.
  - `identity.ts`: `await catalog.auth.authGetUserById`.
  - Evidence: `git diff --stat` -> `routers/auth.ts | 4`, `middleware/auth.ts | 2`,
    `auth/identity.ts | 2`; the sign-up `tx` body is untouched.
- [x] 2.4 Checks.
  - `npx tsc --noEmit -p server` and the promise-hygiene test pass.
  - `npm test -w server` passes, and `git diff -- '*.int.test.ts'` shows no changed expectation.
  - **Completeness probe (design D4), not committed:**
    - locally retype the catalog facade and store methods (except the D3 getters) to return
      `Promise<…>`;
    - run `tsc` and the hygiene test;
    - record that findings appear only at the D2 transaction-reachable sites;
    - revert, and confirm `git status` is clean of the probe.
  - Evidence: `npx tsc --noEmit -p server` -> exit 0; `npm test -w server` -> `Test Files 60
    passed | 2 skipped (62)`, `Tests 833 passed | 3 skipped (836)`; `git diff --stat --
    '*.int.test.ts'` -> empty.
  - Evidence (probe: `CatalogFacade` fields mapped to `Promise`-returning methods except the D3
    getters, `init: () => Promise<void>`): server `tsc` errors only at `routers/auth.ts(197,5)`,
    `(206,9)`, `(219,30)`, `(220,50)` and `routers/teams.ts(105,7)`, `(106,9)`, `(110,10)`;
    hygiene test -> `auth.ts:205 dropped promise`, `auth.ts:220 dropped promise`, `teams.ts:105
    promise used in a comparison`, `teams.ts:284`, `:303`, `:314 dropped promise`. All are D2
    sites (sign-up `tx` body, `wouldStripLastEnabledAdmin`, the three `mutate` bodies).
    `git checkout -- packages/catalog/src/catalog.ts`; `git status --short` lists only the eight
    server files of this change.

## 3. Docs and verification

- [x] 3.1 ADR 0021: add the eight design D6 entries to the slice 4 hazard list, and record the 3b
  boundary (transaction-reachable code and D3 getters stay synchronous; 3d converts the former).
  - Evidence: `git diff --stat -- docs/decisions` -> `0021-….md`; hazards 8-15 added under
    "Slice 4 hazards", and the 3b entry names the synchronous boundary.
- [x] 3.2 Run `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook`, with
  the size at most 400.
  - Evidence: `PASS openspec`, `PASS change tier 2`, `PASS risk-floor 6 high-risk path(s)
    touched`, `PASS evidence`, `PASS size 169/400 changed lines`, `PASS commands ran
    ['typecheck', 'test']`; exit 0.
- [x] 3.3 Live check: `make dev-restart`, then through the dev gate:
  - `GET /api/profile`;
  - `GET /api/shows?studio_id=…`;
  - `GET /api/teams` (anonymous dev returns 401, as before);
  - an admin route with no token returns its unchanged refusal.
  - Evidence: `make dev-restart` exit 0; via `127.0.0.1:8787`: `GET /api/profile 200`, `GET
    /api/studio 200`, `GET /api/shows?studio_id=test-studios 200` (2 shows), `GET
    /api/shows/<id> 200`, `GET /api/shows/nope 404`, `GET /api/teams/x 401 {"detail":"Login
    required."}`, `GET /api/admin/users 503 {"detail":"Set ADMIN_TOKEN …"}` (dev has no
    `ADMIN_TOKEN`). There is no `GET /api/teams` route (it answers `404` before and after), so
    the anonymous `401` was checked on `GET /api/teams/:id`.
- [x] 3.4 Consistency read, archive (sync specs), commit.
  - Evidence: consistency read appended to `panel.md` (no scope change; one minor: task 3.3's
    nonexistent `GET /api/teams`). The MODIFIED requirement replaces "Server code never drops
    or misuses a promise" in `openspec/specs/core-ports-architecture/spec.md`; `openspec
    validate --all --strict` -> `Totals: 27 passed, 0 failed`; the change moved to
    `archive/2026-10-01-async-catalog-callers`.
