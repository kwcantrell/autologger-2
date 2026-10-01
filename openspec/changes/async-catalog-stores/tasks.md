# Tasks

The first commit on `supabase-3d-async-catalog-stores` is `openspec/changes/async-catalog-stores/`
only. The PR targets `supabase-migration` and needs the `size-override` label (owner,
2026-10-01). Gates run with `GITHUB_BASE_REF=supabase-migration`.

Logs: keep the full output of every test and gate run under the session scratchpad as
`3d-<task>-<red|green>.log`, and name the log in each `Evidence:` line.

**Concurrency tests:** the production adapter yields only microtasks (design A7). The concurrency
tests below force interleaving, in the same tick or with a held transaction, so they guard slice 4
behaviour. Concurrent calls start from the test's own context, never inside a held transaction's
callback (design D7). A test marked *characterization* is green before the change and must stay
green; it doesn't fake a red.

## 1. Tests first

- [ ] 1.1 **Promise hygiene** (design D6), in `server/src/promiseHygiene.repo.test.ts`:
  - fixtures: `expect(promise)` is flagged; `expect(await p)`, `expect(p).resolves` and
    `expect(p).rejects` are accepted;
  - the real-tree assertion includes at least one `packages/catalog/src` file.

  The test-file pass is red against today's tree only if such an assertion already exists.
  Record either way.
- [ ] 1.2 **`KvStore.take`** (design D4), in `packages/storage/src/kvStore.test.ts`:
  - a live entry is returned once and removed;
  - a second take returns `null`;
  - an expired entry returns `null` and is removed;
  - two takes issued while a held adapter transaction keeps the lock: exactly one gets the value.

  Red before 2.2.
- [ ] 1.3 **OAuth replay** (design D4), in `server/src/routers/auth.int.test.ts`:
  - two callbacks with the same valid state, issued while a held adapter transaction keeps the
    lock;
  - exactly one reaches sign-in, and the other redirects to `/?login_error=state_invalid`.

  Red before 2.4: get-then-delete lets both queued gets see the state.
- [ ] 1.4 **Transactions** (design D2, D3), in `server/src/test/catalog.int.test.ts` and
  `teams.int.test.ts`:
  - **composition:** `catalog.tx` calls `auth.authUpdateUserProfile` (which has its own `tx`),
    then throws, and the update is rolled back; at top level the same method commits;
  - **interleaved create-if-missing:** `Promise.all` of two `auth.authEnsurePrefsRow(u)`, and of
    two `studios.adminCreateStudio(sameId)`. Neither fails with a constraint error, one row
    exists, and the second create gets the existing validation result;
  - **last admin (characterization):** a team with exactly two enabled admins, both calling
    `POST /api/teams/:id/leave` concurrently. One gets `200`, the other `409`, and an enabled
    admin remains;
  - **sign-up rollback:** convert the existing `'atomicity: a throw mid-materialization rolls
    back user creation'` (`auth.int.test.ts`), and add the assertions that no membership exists
    and the invite is still pending.

  Composition and create-if-missing are red, or don't compile, before 2.3.
- [ ] 1.5 **Broken stops the server** (design D5), in
  `packages/storage/src/asyncCatalogStore.test.ts`: `onBroken` is called exactly once, after the
  failing call has rejected with its own error, and a throwing `onBroken` doesn't affect the
  adapter. Red before 2.2.

## 2. Conversion

- [ ] 2.1 **Ports** (design D1, D4): rename `AsyncCatalogDb` to `CatalogDb` (the synchronous one
  is deleted), and add `KvStore.take`.
- [ ] 2.2 **Storage** (design D1, D4, D5):
  - delete `catalogStore.ts` and its test;
  - `KvStore.take`;
  - the adapter's `onBroken` option;
  - the exports and the barrel comment.
- [ ] 2.3 **Catalog stores** (design D2, D3):
  - async methods (except the getters), awaited internal calls, async facade members;
  - `withDb` in each store, with `SessionIndexStore` rebinding its dependencies;
  - the 6 existing store transactions on `withDb`;
  - the five read-then-write sequences wrapped in transactions;
  - `Catalog.init()` async, `Catalog.tx` with a `#db` field and a copied snapshot.
- [ ] 2.4 **Server** (design D1, D3, D4, D5):
  - `config.ts`: one adapter for `Ports.catalog` and `KvStore`, plus the `onBroken` option;
  - `main.ts`: the `onBroken` callback (error log, `exitCode = 1`, `SIGTERM`);
  - sign-up and the teams guard on `catalog.tx`, with `mutate` async;
  - `takeOauthState` uses `take`;
  - the stale comments in `config.ts` and `events.ts` (the slot release before the mirror is
    still safe, because the adapter yields only microtasks; this is slice 4 hazard 4).
- [ ] 2.5 **Tests** (design D6, D7):
  - the hygiene filter widens;
  - the test-file rule;
  - async seed helpers, and awaits at the 606 seed calls, 116 `catalogFor()` uses, 12 direct
    port reads and 3 `init()` sites;
  - helper lambdas become async;
  - the `#db` field keeps `catalog.test.ts` unchanged.

## 3. Docs and verification

- [ ] 3.1 **Docs:**
  - **ADR 0021:**
    - slice 3 is done, and the 3d decisions are recorded (one PR with `size-override`;
      `KvStore.take`; async seeds);
    - the hazard list's preface says the hazards stay latent through 3d, because the adapter
      yields only microtasks, and go live with slice 4's I/O;
    - hazard 1 is closed, and hazard 13 half-closed;
    - hazard 15's remedy must run outside the transaction or use
      `INSERT … ON CONFLICT DO NOTHING`;
    - add the `/auth/google/start` KV flood item.
  - **README:** in the architecture tree, `asyncCatalogStore.ts` replaces `catalogStore.ts`.
- [ ] 3.2 **Checks:**
  - `npm run typecheck` and `npm test` (all workspaces), including the hygiene test;
  - `git diff -- '*.int.test.ts'` shows only `await` and async conversions, the seed changes and
    the new cases, with no changed expected status, body or header;
  - `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook`, where the size gate
    is expected to WARN (record the number).
- [ ] 3.3 **Live check:** `make dev-restart`, then through the dev gate:
  - `GET /api/profile`, `/api/studio`, the shows list and a show;
  - `PUT /api/profile` (a settings save);
  - `POST /api/shows` (a scratch show);
  - `POST /api/sessions` (a scratch session, through `createSessionForShow`'s transaction);
  - the companion presence, command, state and ack round trip;
  - `GET /api/admin/users` unchanged (`503`).
- [ ] 3.4 **Consistency read, archive** (sync specs), commit.
