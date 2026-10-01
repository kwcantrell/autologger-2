# Tasks

The first commit on `supabase-4b-postgres-catalog-adapter` is
`openspec/changes/postgres-catalog-adapter/` only. The PR targets `supabase-migration`. Gates run
with `GITHUB_BASE_REF=supabase-migration`. The PR needs the owner's `size-override` label (design
D8).

Logs: keep the full output of every test and gate run under the session scratchpad as
`4b-<task>-<red|green>.log`, and name the log in each `Evidence:` line.

## 1. Test setup and the shared contract suite (design D8)

- [ ] 1.1 Add `packages/storage/vitest.config.ts` with the `unit` and `pg` projects, and
  `postgres` 3.4.9 as a `@autologger/storage` dependency.

  Test first: move the SQLite adapter's contract cases into `src/test/catalogDbContract.ts`
  (`describeCatalogDbContract(name, make)`), with `rows`, `uniqueViolation`, `txTimeoutMs` and
  `close`. Add two new cases: a dropped failing statement, and a failed deferred-FK `COMMIT`.
  `asyncCatalogStore.test.ts` calls the suite and keeps its SQLite-only cases.

  Green: the SQLite case count is the old count plus 2, all passing under `--project unit`.
  Record both counts.

## 2. Unit tests through the `connect` seam (design D2-D7)

- [ ] 2.1 Test first: `src/postgresCatalogStore.test.ts`.
  - The `toPg` cases: `'?'`, `"?"`, `-- ?`, `''` escapes, no placeholders, and numbering in
    order.
  - A failed `ROLLBACK` causes a recycle, and the next `tx` runs on the replacement.
  - A `COMMIT` that is lost (`CONNECTION_CLOSED`) or hangs past its bound gives
    `CatalogCommitUnknownError`: no `ROLLBACK`, no retry, and a recycle.
  - A `COMMIT` tag of `ROLLBACK` fails the transaction.
  - A recycled client's late `onclose` doesn't fail the next attempt.
  - `cancel()` returning `null` doesn't throw, and the slot is recycled.

  Red: module missing.

- [ ] 2.2 Write `toPg`, the slots (`onclose` matched by identity, release and recycle, the FIFO
  waiter queue with timeout removal), and the bounded `BEGIN`/`COMMIT`/`ROLLBACK`. Green.

## 3. The Postgres adapter against the real image (design D1-D7)

- [ ] 3.1 Test first: `src/postgresCatalogStore.pg.test.ts`. The factory creates `catalog.t` and
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

- [ ] 3.2 Finish `PostgresCatalogDb`:
  - the root pool and the root guard;
  - `AttemptState` with its chain (`CONNECTION_*` sets `lost`);
  - the end protocol: drain, tag check, outcome unknown;
  - immediate retry on `40001`/`40P01`;
  - one deadline with `cancel()` in a `try`, followed by a recycle;
  - `close()`.

  Export it from `src/index.ts`. Green: pg and unit.

## 4. Docs and the port comment

- [ ] 4.1 `packages/ports/src/catalogDb.ts`: the header names both adapters and says that a `tx`
  body may run more than once on Postgres, so it must have only database effects.
- [ ] 4.2 ADR 0021, the slice 4 list:
  - "an async `close()`" moves from 4c's open items to 4b;
  - 4c gains:
    - audit the 16 `tx` bodies for non-database effects before wiring;
    - drop the `onBroken` wiring;
    - `numeric` aggregates come back as strings;
    - map `CatalogCommitUnknownError` to a response;
    - one adapter per process, shared with `KvStore`.

## 5. Verify

- [ ] 5.1 `npm test -w packages/storage`, root `npm run typecheck`, and `npm run lint`: all green.
- [ ] 5.2 `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook`: green apart
  from the size WARN, with the counted size recorded.
- [ ] 5.3 Consistency read appended to `panel.md`.
