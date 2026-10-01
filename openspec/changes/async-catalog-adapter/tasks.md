# Tasks

The first commit on `supabase-3c-async-catalog-adapter` is `openspec/changes/async-catalog-adapter/`
only. The PR targets `supabase-migration`. Gates run with `GITHUB_BASE_REF=supabase-migration`.

Logs: keep the full output of every test and gate run under the session scratchpad as
`3c-<task>-<red|green>.log`, and name the log in each `Evidence:` line.

## 1. Port and adapter (test-first)

- [ ] 1.1 Add `AsyncCatalogDb` to `packages/ports/src/catalogDb.ts` (design D1), beside
  `CatalogDb`. It is not added to `Ports`.
- [ ] 1.2 Write `packages/storage/src/asyncCatalogStore.test.ts` first, against in-memory
  databases.
  - **Red run:** it must fail (missing module) before 1.3.
  - **Unhandled-rejection trap:** a `process.on('unhandledRejection')` trap fails the file.
  - **Hang check:** every "promptly" or "no deadlock" case races the call against a 200 ms
    timer, so a hang fails with a message rather than a timeout.

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
- [ ] 1.3 Implement `AsyncSqliteCatalogDb` and its three error classes in
  `packages/storage/src/asyncCatalogStore.ts` (design D2-D4), and export them from
  `packages/storage/src/index.ts`, until 1.2 passes.

## 2. KvStore onto the adapter (design D5)

- [ ] 2.1 Change `packages/storage/src/kvStore.test.ts` first, so it builds `KvStore` over an
  `AsyncSqliteCatalogDb`. It fails to typecheck or run before 2.2. Add two cases:
  - a KV write issued while an adapter transaction is awaiting lands only after that transaction
    ends, and survives its rollback;
  - an expired key re-put between `get`'s SELECT and its expiry DELETE survives (the delete is
    conditional).
- [ ] 2.2 `KvStore` takes an `AsyncCatalogDb` and keeps the same SQL. `server/src/node/config.ts`
  passes `new AsyncSqliteCatalogDb(catalog)`.

## 3. Docs and verification

- [ ] 3.1 ADR 0021: the 3c entry, and the design D6 items 3d inherits, including moving the
  OAuth atomic take from the slice 4 list to a 3d prerequisite (D6.7).
- [ ] 3.2 Checks:
  - `npx tsc --noEmit -p server`;
  - `npm test -w @autologger/storage`;
  - `npm test -w server` (including the package-boundary and promise-hygiene tests);
  - `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook`, with the size at
    most 400.
- [ ] 3.3 Live check: `make dev-restart`. The app boots (the startup KV purge runs through the
  adapter). Then through the dev gate, with the API token piped from the container environment
  and never printed:
  - `POST /api/companion/command` stores a command;
  - `GET /api/companion/state` returns it;
  - `GET /api/profile` returns `200`.
- [ ] 3.4 Consistency read, archive (sync specs), commit.
