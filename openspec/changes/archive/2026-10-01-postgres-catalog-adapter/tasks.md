# Tasks

The first commit on `supabase-4b-postgres-catalog-adapter` is
`openspec/changes/postgres-catalog-adapter/` only. The PR targets `supabase-migration`. Gates run
with `GITHUB_BASE_REF=supabase-migration`. The PR needs the owner's `size-override` label (design
D8).

Logs: keep the full output of every test and gate run under the session scratchpad as
`4b-<task>-<red|green>.log`, and name the log in each `Evidence:` line.

## 1. Test setup and the shared contract suite (design D8)

- [x] 1.1 Add `packages/storage/vitest.config.ts` with the `unit` and `pg` projects, and
  `postgres` 3.4.9 as a `@autologger/storage` dependency.
  Evidence: `4b-1.1-before.log`: `npx vitest run src/asyncCatalogStore.test.ts` -> `Tests  25
  passed (25)`; `4b-1.1-green.log`: `npx vitest run --project unit` -> `Tests  59 passed (59)`,
  and the SQLite file has 26 (16 shared + 10 SQLite-only). That is +1, not +2: the deferred-FK
  case already existed and moved into the suite; only the dropped-statement case is new.
  `npx tsc --noEmit -p packages/storage` -> clean.

  Test first: move the SQLite adapter's contract cases into `src/test/catalogDbContract.ts`
  (`describeCatalogDbContract(name, make)`), with `rows`, `uniqueViolation`, `txTimeoutMs` and
  `close`. Add two new cases: a dropped failing statement, and a failed deferred-FK `COMMIT`.
  `asyncCatalogStore.test.ts` calls the suite and keeps its SQLite-only cases.

  Green: the SQLite case count is the old count plus 2, all passing under `--project unit`.
  Record both counts.

## 2. Unit tests through the `connect` seam (design D2-D7)

- [x] 2.1 Test first: `src/postgresCatalogStore.test.ts`.
  Evidence: `4b-2.1-red.log`: `npx vitest run --project unit src/postgresCatalogStore.test.ts` ->
  `Cannot find module './postgresCatalogStore'`, `Tests  no tests`.
  - The `toPg` cases: `'?'`, `"?"`, `-- ?`, `''` escapes, no placeholders, and numbering in
    order.
  - A failed `ROLLBACK` causes a recycle, and the next `tx` runs on the replacement.
  - A `COMMIT` that is lost (`CONNECTION_CLOSED`) or hangs past its bound gives
    `CatalogCommitUnknownError`: no `ROLLBACK`, no retry, and a recycle.
  - A `COMMIT` tag of `ROLLBACK` fails the transaction.
  - A recycled client's late `onclose` doesn't fail the next attempt.
  - `cancel()` returning `null` doesn't throw, and the slot is recycled.

  Red: module missing.

- [x] 2.2 Write `toPg`, the slots (`onclose` matched by identity, release and recycle, the FIFO
  Evidence: `4b-2.2-green.log`: `npx vitest run --project unit` -> `Tests  71 passed (71)` (12 in
  `postgresCatalogStore.test.ts`). Mutation check `4b-mutation-onclose.log`: with the `onclose`
  identity guard removed, `late onclose` fails with `Error: catalog transaction connection lost`.
  waiter queue with timeout removal), and the bounded `BEGIN`/`COMMIT`/`ROLLBACK`. Green.

## 3. The Postgres adapter against the real image (design D1-D7)

- [x] 3.1 Test first: `src/postgresCatalogStore.pg.test.ts`. The factory creates `catalog.t` and
  Evidence: `4b-3.1-red.log`: `npx vitest run --project pg` -> `Cannot find module
  './postgresCatalogStore'`, `Tests  no tests`.
  `catalog.log` as admin in a `createTestDatabase()` clone, connects as `autologger_app`, and
  always closes in `afterEach`. Cases:
  - the shared suite;
  - int8 as a number;
  - `select '?' as q, ?::bigint as v`;
  - the `40001` retry: +2 after 3 runs;
  - `40P01` on the first run: 2 runs;
  - `40001` every run: exactly 3 runs, then rejects;
  - `23505`: 1 run;
  - the deadline over `pg_sleep(60)`: rejects within 2 s, no row, backend gone within 3 s, and
    the next `tx` commits;
  - connection loss: the refused write is never sent, no row persists, and `txSlots + 1` later
    commits succeed;
  - a queued waiter times out, then `txSlots` commits succeed;
  - `close()` with one `tx` running and one queued: the running one settles, the queued one
    rejects, and no app connection remains.

  Red: failing.

- [x] 3.2 Finish `PostgresCatalogDb`:
  Evidence: `4b-3.2-pg-green-{1,2,3}.log`: `npx vitest run --project pg` three runs -> `Tests  23
  passed (23)` each. Mutation check `4b-mutation-drain.log`: with the end-protocol drain removed,
  the dropped-statement case fails `promise resolved "'returned early'" instead of rejecting`;
  restored, `npx vitest run -t dropped` -> `Tests  2 passed` (both adapters). The pg test uses a
  package-local copy of the test/pg helper (`src/test/pgDb.ts`), because the packages/* boundary
  test forbids imports outside `src/`. `src/test/catalogDbContract.ts` and `pgDb.ts` are added
  to that test's reviewed test-infrastructure exemptions (`server/src/packageBoundaries.repo.test.ts`
  -> `Tests  82 passed (82)`).
  - the root pool and the root guard;
  - `AttemptState` with its chain (`CONNECTION_*` sets `lost`);
  - the end protocol: drain, tag check, outcome unknown;
  - immediate retry on `40001`/`40P01`;
  - one deadline with `cancel()` in a `try`, followed by a recycle;
  - `close()`.

  Export it from `src/index.ts`. Green: pg and unit.

## 4. Docs and the port comment

- [x] 4.1 `packages/ports/src/catalogDb.ts`: the header names both adapters and says that a `tx`
  Evidence: `git diff packages/ports/src/catalogDb.ts` -> `+// On Postgres a \`tx\` body may run
  more than once …`; `npx tsc --noEmit -p packages/storage` -> clean.
  body may run more than once on Postgres, so it must have only database effects.
- [x] 4.2 ADR 0021, the slice 4 list:
  Evidence: `git diff docs/decisions/0021-*.md` -> 4b gains `an async \`close()\``; 4c gains
  `first, audit the 16 \`tx\` bodies…`, `numeric`, `CatalogCommitUnknownError`, `onBroken`,
  `one adapter per process`.
  - "an async `close()`" moves from 4c's open items to 4b;
  - 4c gains:
    - audit the 16 `tx` bodies for non-database effects before wiring;
    - drop the `onBroken` wiring;
    - `numeric` aggregates come back as strings;
    - map `CatalogCommitUnknownError` to a response;
    - one adapter per process, shared with `KvStore`.

## 5. Verify

- [x] 5.1 `npm test -w packages/storage`, root `npm run typecheck`, and `npm run lint`: all green.
  Evidence: `4b-5.1-storage.log`: `Test Files  7 passed (7)`, `Tests  94 passed (94)`;
  `4b-5.1-typecheck.log`: exit 0. `4b-5.1-lint.log`: the new and changed files are clean after
  `biome format`; root `npm run lint` still exits 1 on files this change doesn't touch
  (`packages/catalog/src/{authStore,profileAssembler,sessionIndexStore}.ts` formatting,
  `server/src/routers/compression.int.test.ts` noNonNullAssertion).
- [x] 5.2 `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook`: green apart
  Evidence: `4b-5.2-hook.log`: exit 0; every gate PASS except `WARN size 584 changed lines >
  budget 400` (the adapter is 537 lines, against the ~410 estimate in design D8). The first run
  failed once on the unrelated web test `AiV2Design.test.tsx:382` (`waitFor` timing); that file
  alone passed 3/3, and the re-run was green.
  from the size WARN, with the counted size recorded.
- [x] 5.3 Consistency read appended to `panel.md`.
  Evidence: `panel.md` `## Consistency read 2026-10-01` -> `Scope change: no`; 4 minors (2 open, for
  the owner: size 584 vs ~450, and no client-side bound on root statements).
