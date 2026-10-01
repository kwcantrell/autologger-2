# Tasks

The first commit on `supabase-3c-async-catalog-adapter` is `openspec/changes/async-catalog-adapter/`
only. The PR targets `supabase-migration`. Gates run with `GITHUB_BASE_REF=supabase-migration`.

Logs: keep the full output of every test and gate run under the session scratchpad as
`3c-<task>-<red|green>.log`, and name the log in each `Evidence:` line.

## 1. Port and adapter (test-first)

- [x] 1.1 Add `AsyncCatalogDb` to `packages/ports/src/catalogDb.ts` (design D1), beside
  `CatalogDb`. It is not added to `Ports`.
  - Evidence: `npx tsc --noEmit -p packages/ports` -> exit 0 (log: inline); `ports.ts` unchanged.
- [x] 1.2 Write `packages/storage/src/asyncCatalogStore.test.ts` first, against in-memory
  databases.
  - **Red run:** it must fail (missing module) before 1.3.
  - **Unhandled-rejection trap:** a `process.on('unhandledRejection')` trap fails the file.
  - **Hang check:** every "promptly" or "no deadlock" case races the call against a 200 ms
    timer, so a hang fails with a message rather than a timeout.
  - Evidence: `3c-1.2-red.log` -> `Error: Cannot find module './asyncCatalogStore'`, `Tests no
    tests`. 23 cases are written; the "release after a failing BEGIN" case uses a raw `BEGIN`
    left open, which makes the adapter refuse before its own `BEGIN`, then recover.

  Cases:
  - **parity:** `all`, `first` (a row and `null`) and `run().changes` match the synchronous
    adapter;
  - **commit:** `tx` returns the body's value, and its writes persist;
  - **rollback:**
    - a body that writes, then throws, persists nothing and rejects with that same error;
    - a constraint violation mid-body does the same;
  - **caught error:**
    - a body that catches a failed statement and goes on writing persists nothing, and rejects
      with the statement's error;
    - a `RAISE(ROLLBACK)` trigger (an auto-rollback) caught by the body does the same, and the
      later write does not autocommit;
  - **failed COMMIT:** a deferred foreign-key violation makes `COMMIT` fail, the transaction rolls
    back, and the call rejects;
  - **join:** `t.tx` writes commit with the outer; a joined body that throws rolls back the outer
    writes too, even when the outer body catches it;
  - **un-awaited join:**
    - a body that returns while a `t.tx` is still running rejects with `CatalogTxMisuseError`;
    - nothing persists, and the unfinished body's later write rejects;
    - the unhandled-rejection trap stays silent;
  - **first error wins:** in `Promise.all([t.tx(a), t.tx(b)])`, where `a` throws a domain error
    while `b` is still running, the call rejects with `a`'s error and nothing persists;
  - **misuse:**
    - the root handle (statement and `tx`) used inside a transaction rejects with
      `CatalogTxMisuseError` promptly;
    - a handle used after its transaction rejects;
  - **detached work:** a root call from a promise started inside a transaction, but run after it
    ended, succeeds;
  - **wait:** a root read issued while a transaction is awaiting resolves only after it ends, and
    sees the committed rows (or none after a rollback);
  - **FIFO:** a transaction, a root write and a second transaction called in that order apply in
    that order;
  - **shared lock:** two adapters on one `Database` serialise; adapters on two databases do not
    block each other;
  - **release:** after a failed transaction, and after a failing `BEGIN` (raw connection left in
    `BEGIN`), the next root statement and transaction run;
  - **raw transaction:** with the raw connection left inside `BEGIN`, a root statement and a root
    `tx` reject;
  - **deadline:** a body that never settles, with `txTimeoutMs: 50`:
    - rejects with `CatalogTxTimeoutError`;
    - its writes are rolled back;
    - its later handle call and root call both reject;
    - the next caller proceeds;
    - when the timed-out body settles after the next transaction has begun, that next
      transaction still commits (the end protocol runs once);
  - **detached after failure:** a root call from work started inside a transaction that then
    failed rejects, citing that error as `cause`; one from a committed transaction succeeds;
  - **broken:** a failing `ROLLBACK` (a raw iterator left open) makes that call and a queued call
    reject with `CatalogAdapterBrokenError`;
  - **stress:** 300 interleaved operations with random throws and awaits leave no orphan rows,
    `inTransaction` false, and the lock free.
- [x] 1.3 Implement `AsyncSqliteCatalogDb` and its three error classes in
  `packages/storage/src/asyncCatalogStore.ts` (design D2-D4), and export them from
  `packages/storage/src/index.ts`, until 1.2 passes.
  - Evidence: `3c-1.3-green.log`, `3c-1.3-reruns.log` -> `Tests 23 passed (23)`, five reruns
    `23 passed` each; the unhandled-rejection trap stayed empty. The broken-connection cases
    open the raw iterator inside the body: one opened before the transaction makes `BEGIN`
    itself fail busy (probe: `TypeError: This database connection is busy executing a query`).

## 2. KvStore onto the adapter (design D5)

- [x] 2.1 Change `packages/storage/src/kvStore.test.ts` first, so it builds `KvStore` over an
  `AsyncSqliteCatalogDb`. It fails to typecheck or run before 2.2. Add two cases:
  - a KV write issued while an adapter transaction is awaiting lands only after that transaction
    ends, and survives its rollback;
  - an expired key re-put between `get`'s SELECT and its expiry DELETE survives (the delete is
    conditional).
  - Evidence: `3c-2.1-red.log` -> `Tests 10 failed (10)`; `tsc` -> `error TS2345: Argument of
    type 'AsyncSqliteCatalogDb' is not assignable to parameter of type 'Database'`.
- [x] 2.2 `KvStore` takes an `AsyncCatalogDb` and keeps the same SQL. `server/src/node/config.ts`
  passes `new AsyncSqliteCatalogDb(catalog)`.
  - Evidence: `3c-2.2-green.log` -> `npm test -w @autologger/storage` -> `Test Files 6 passed
    (6)`, `Tests 56 passed (56)`; `npx tsc --noEmit -p packages/storage` and `-p server` -> exit 0.

## 3. Docs and verification

- [x] 3.1 ADR 0021: the 3c entry, and the design D6 items 3d inherits, including moving the
  OAuth atomic take from the slice 4 list to a 3d prerequisite (D6.7).
  - Evidence: `git diff --stat -- docs/decisions` -> `0021-….md`. The 3c entry is written, the
    3d entry lists the six inherited items, and slice 4 hazard 1 points to the 3d prerequisite.
- [x] 3.2 Checks:
  - `npx tsc --noEmit -p server`;
  - `npm test -w @autologger/storage`;
  - `npm test -w server` (including the package-boundary and promise-hygiene tests);
  - `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook`, with the size at
    most 400.
  - Evidence: `npx tsc --noEmit -p packages/storage` and `-p server` -> exit 0;
    `3c-2.2-green.log` -> `Tests 56 passed (56)`; `3c-3.2-server.log` -> `Test Files 60 passed |
    2 skipped (62)`, `Tests 833 passed | 3 skipped (836)`; `3c-3.2-hook.log` plus a re-run ->
    `PASS evidence`, `PASS size 359/400 changed lines`, every other gate `PASS`. The size is
    above the D7 estimate of 160-190: the adapter file alone counts 294 lines with its comments.
- [x] 3.3 Live check: `make dev-restart`. The app boots (the startup KV purge runs through the
  adapter). Then through the dev gate, with the API token piped from the container environment
  and never printed:
  - `POST /api/companion/command` stores a command;
  - `GET /api/companion/state` returns it;
  - `GET /api/profile` returns `200`.
  - Evidence: `3c-3.3-live.log`. `make dev-restart` exit 0, and the app logged `listening` with
    no `startup KV purge failed`. Dev sets no `API_TOKEN`, so the companion routes were called
    without one. The active show had no session, so a scratch session `live3c scratch` was
    created through the API. Results: `GET /api/profile 200`, `POST /api/sessions (scratch)
    200`, `POST presence 200`, `POST command 200`, `GET state 200 last_command id matches:
    true`, `POST ack 200 {"ok":true}`, `GET state after ack: ok true delivered_to matches:
    true`.
- [x] 3.4 Consistency read, archive (sync specs), commit.
  - Evidence: consistency read appended to `panel.md` (no scope change; four minor items). Both
    ADDED requirements are appended to `openspec/specs/core-ports-architecture/spec.md`;
    `openspec validate --all --strict` -> `Totals: 27 passed, 0 failed`; the change moved to
    `archive/2026-10-01-async-catalog-adapter`.
