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

- [x] 1.1 **Promise hygiene** (design D6), in `server/src/promiseHygiene.repo.test.ts`:
  - Evidence: `3d-1.1.log`: first run -> `src/node/presence.test.ts:19 promise passed to expect()`
    (an intentional `expect(op).toBeInstanceOf(Promise)`; the rule now allows exactly that chain);
    final `Tests 16 passed (16)`, with a `packages/catalog/src` file asserted in the scan.
  - fixtures: `expect(promise)` is flagged; `expect(await p)`, `expect(p).resolves` and
    `expect(p).rejects` are accepted;
  - the real-tree assertion includes at least one `packages/catalog/src` file.

  The test-file pass is red against today's tree only if such an assertion already exists.
  Record either way.
- [x] 1.2 **`KvStore.take`** (design D4), in `packages/storage/src/kvStore.test.ts`:
  - Evidence: `3d-1.2-red.log` -> `× returns a live value once and removes it` … `× two takes
    queued behind a held transaction`, `Tests 4 failed | 10 passed (14)`; green in
    `3d-2.2-green.log` (`Tests 58 passed (58)`).
  - a live entry is returned once and removed;
  - a second take returns `null`;
  - an expired entry returns `null` and is removed;
  - two takes issued while a held adapter transaction keeps the lock: exactly one gets the value.

  Red before 2.2.
- [x] 1.3 **OAuth replay** (design D4), in `server/src/routers/auth.int.test.ts`:
  - Evidence: `3d-1.3-red.log` -> received `[ "/", "/?login_error=token_invalid" ]`: both
    callbacks passed the state check (the second failed only later at token verification); green
    in `3d-1.x-green.log`.
  - two callbacks with the same valid state, issued while a held adapter transaction keeps the
    lock;
  - exactly one reaches sign-in, and the other redirects to `/?login_error=state_invalid`.

  Red before 2.4: get-then-delete lets both queued gets see the state.
- [x] 1.4 **Transactions** (design D2, D3), in `server/src/test/catalog.int.test.ts` and
  `teams.int.test.ts`:
  - Evidence: `3d-1.4-red.log` -> `× a store transaction joins a failing route transaction…`, `×
    interleaved create-if-missing calls do not collide`, and the last-admin characterization
    passing before the change (`Tests 2 failed | 1 passed`); the sign-up atomicity test gained the
    invite-pending and no-member assertions; green in `3d-1.x-green.log` (`Test Files 4 passed`,
    `Tests 101 passed (101)`).
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
- [x] 1.5 **Broken stops the server** (design D5), in
  `packages/storage/src/asyncCatalogStore.test.ts`: `onBroken` is called exactly once, after the
  failing call has rejected with its own error, and a throwing `onBroken` doesn't affect the
  adapter. Red before 2.2.
  - Evidence: `3d-1.5-red.log` -> `× is called once, after the failing call rejects with its own
    error`, `Tests 1 failed | 24 passed (25)`; green in `3d-2.2-green.log`.

## 2. Conversion

- [x] 2.1 **Ports** (design D1, D4): rename `AsyncCatalogDb` to `CatalogDb` (the synchronous one
  is deleted), and add `KvStore.take`.
  - Evidence: `npx tsc --noEmit -p packages/ports` exit 0; `AsyncCatalogDb` no longer exists
    (`grep -rn AsyncCatalogDb packages server/src` -> none).
- [x] 2.2 **Storage** (design D1, D4, D5):
  - Evidence: `3d-2.2-green.log` -> `npm test -w @autologger/storage`: `Test Files 5 passed (5)`,
    `Tests 58 passed (58)`; `catalogStore.ts` and its test deleted with `git rm`.
  - delete `catalogStore.ts` and its test;
  - `KvStore.take`;
  - the adapter's `onBroken` option;
  - the exports and the barrel comment.
- [x] 2.3 **Catalog stores** (design D2, D3):
  - Evidence: `npx tsc --noEmit -p packages/catalog` exit 0; the hygiene test scans
    `packages/catalog/src` and passes. Beyond the five planned wraps, `updateSessionIndex`
    (read-merge-write) and `authConsumeInvitesForEmail` (select-then-delete) also run in a
    transaction, so the code matches the spec's read-then-write rule (consistency read).
  - async methods (except the getters), awaited internal calls, async facade members;
  - `withDb` in each store, with `SessionIndexStore` rebinding its dependencies;
  - the 6 existing store transactions on `withDb`;
  - the five read-then-write sequences wrapped in transactions;
  - `Catalog.init()` async, `Catalog.tx` with a `#db` field and a copied snapshot.
- [x] 2.4 **Server** (design D1, D3, D4, D5):
  - Evidence: `npx tsc --noEmit -p server` (production) clean after converting exactly the 3b
    probe's sites (`auth.ts:197-220`, `teams.ts:105-130`); `main.ts` now calls `process.exit()` so
    `exitCode = 1` survives the graceful path.
  - `config.ts`: one adapter for `Ports.catalog` and `KvStore`, plus the `onBroken` option;
  - `main.ts`: the `onBroken` callback (error log, `exitCode = 1`, `SIGTERM`);
  - sign-up and the teams guard on `catalog.tx`, with `mutate` async;
  - `takeOauthState` uses `take`;
  - the stale comments in `config.ts` and `events.ts` (the slot release before the mirror is
    still safe, because the adapter yields only microtasks; this is slice 4 hazard 4).
- [x] 2.5 **Tests** (design D6, D7):
  - Evidence: A subagent converted the test call sites (37 files) by codemod; `tsc` 0 errors (was
    675). Normalised against HEAD (stripping
    `await`/`async`/`Promise`/`.resolves`/`.rejects`/parentheses), the converted files are
    identical except `migrations.int.test.ts` (`expect(() => p).not.toThrow()` -> `await
    expect(p).resolves.not.toThrow()`, which would otherwise pass vacuously). One old test opened
    a raw-root transaction and used root stores inside it; the guard rejected it, and it now uses
    `cat.tx(async (c) => …)`.
  - the hygiene filter widens;
  - the test-file rule;
  - async seed helpers, and awaits at the 606 seed calls, 116 `catalogFor()` uses, 12 direct
    port reads and 3 `init()` sites;
  - helper lambdas become async;
  - the `#db` field keeps `catalog.test.ts` unchanged.

## 3. Docs and verification

- [x] 3.1 **Docs:**
  - Evidence: `git diff --stat -- README.md docs` -> README tree (`asyncCatalogStore.ts` replaces
    `catalogStore.ts`), ADR 0021 (3d entry; hazard preface states latent through slice 3; hazard 1
    done, 13 half-closed, 15 remedy constraint, new 16).
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
- [x] 3.2 **Checks:**
  - Evidence: `3d-3.2-typecheck.log` exit 0; `3d-3.2-test.log` -> server `Tests 838 passed | 3
    skipped (841)`, web `Tests 1384 passed (1384)`, every package workspace passed;
    `3d-3.2-hook.log` -> all PASS except `WARN size 904 changed lines > budget 400` (above the D8
    estimate of 650-750; the store facade types and signatures were larger than estimated; the
    `size-override` label is owner-approved). Removed expectation lines in `*.int.test.ts` differ
    only by `await` (normalised comparison above).
  - `npm run typecheck` and `npm test` (all workspaces), including the hygiene test;
  - `git diff -- '*.int.test.ts'` shows only `await` and async conversions, the seed changes and
    the new cases, with no changed expected status, body or header;
  - `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook`, where the size gate
    is expected to WARN (record the number).
- [x] 3.3 **Live check:** `make dev-restart`, then through the dev gate:
  - Evidence: `3d-3.3-live.log`: `make dev-restart` exit 0, `listening`, no purge failure; `GET
    /api/profile 200`, `GET /api/studio 200`, `GET /api/shows 200 count 2`, `GET /api/shows/:id
    200`, `PUT /api/profile (settings save) 200`, `POST /api/shows (scratch) 200`, `POST
    /api/sessions … 200 title L3D_261001`, presence/command/state/ack all `200` with `last_command
    matches true` and ack `{"ok":true}`, `GET /api/admin/users 503`, `GET /api/teams/x (anon)
    401`. Scratch show `live3d scratch show` and its session are left in dev data (disposable).
  - `GET /api/profile`, `/api/studio`, the shows list and a show;
  - `PUT /api/profile` (a settings save);
  - `POST /api/shows` (a scratch show);
  - `POST /api/sessions` (a scratch session, through `createSessionForShow`'s transaction);
  - the companion presence, command, state and ack round trip;
  - `GET /api/admin/users` unchanged (`503`).
- [x] 3.4 **Consistency read, archive** (sync specs), commit.
  - Evidence: consistency read appended to `panel.md` (no scope change; six minor items). The
    spec is synced: one requirement renamed and modified, four more modified, and the Purpose
    reworded. The scenario set compared to HEAD lost none and gained six. `openspec validate
    --all --strict` -> `Totals: 27 passed, 0 failed`. The change moved to
    `archive/2026-10-01-async-catalog-stores`.
