# Design: async-catalog-adapter

## Context

- 3a and 3b made every server catalog caller `await`. The catalog itself is still synchronous:
  `CatalogDb` (`packages/ports/src/catalogDb.ts`) over better-sqlite3
  (`packages/storage/src/catalogStore.ts`), with `tx(fn)` built on `db.transaction(fn)`.
- `KvStore` (`packages/storage/src/kvStore.ts`) writes through the same raw connection
  (`config.ts:44`).
- There are 7 transaction sites: 5 in the stores (`studioRegistry.ts:219`,
  `sessionIndexStore.ts:142,200`, `authStore.ts:119,176`, `showsStore.ts:226`) and 2 in routers
  (`teams.ts:130`, `auth.ts:197`). **None nests at runtime.** The router bodies call only store
  methods without an internal `tx`. The store methods with one (`authUpdateUserProfile`,
  `updateShowFields`, `adminDeleteStudio`) are called only outside a transaction. The comments
  at `authStore.ts:117` and `showsStore.ts:224` only say nesting would be possible (scope
  reviewer, finding 1).
- Owner decisions (2026-10-01):
  - `tx(async (t) => …)` with a transaction-scoped handle, the same shape as postgres.js
    `sql.begin`, run under a FIFO lock;
  - a nested `t.tx` joins the enclosing transaction and any error fails the whole transaction;
  - `KvStore` moves onto the adapter in this change.

## Assumptions and evidence

Spike `spike3c.mjs` (session scratchpad), node v24.21.0. The assumption tester re-ran the
equivalent probes on node v22.23.3 inside `autologger-dev-app` (better-sqlite3 12.11.1, SQLite
3.53.2) with identical output. CI and both images use node 22.

| # | Assumption | Observed |
|---|---|---|
| A1 | Raw `BEGIN IMMEDIATE` works and `db.inTransaction` tracks it | `A1 inTransaction after BEGIN: true`; nested `BEGIN` -> `cannot start a transaction within a transaction` |
| A2 | On one connection, another caller's statement during an open transaction joins it | `A2 other caller sees uncommitted row: 1`; after `ROLLBACK`: `0` |
| A5 | An ordinary constraint error leaves the transaction open | `A5 SQLITE_CONSTRAINT_PRIMARYKEY inTx still true` |
| A5' | Some errors roll back the whole transaction | `SQLITE_FULL inTx after false`; `RAISE(ROLLBACK)` -> `inTx false`; a caught one followed by more writes persisted them in autocommit: `persisted rows [ 'a', 'd' ]` |
| A6 | `AsyncLocalStorage` survives awaits, is absent outside, and follows detached promises | `A6 store after awaits: { id: 1 }`, `outside run: undefined`, `detached sees: { id: 1 }`; a concurrent unrelated request sees no context: `G3 … 'reqB ctx=undefined'` |
| A7 | `db.transaction` refuses an async body | `A7 Transaction function cannot return a promise` |
| A8 | A failed `COMMIT` can leave the transaction open | Deferred FK: `COMMIT err SQLITE_CONSTRAINT_FOREIGNKEY inTx after failed COMMIT true` |
| A9 | `ROLLBACK` can fail and leave the transaction open | With a raw iterator open: `ROLLBACK … throws This database connection is busy executing a query inTx true` |
| A10 | A promise-chain lock is FIFO and releases on every path | 500 mixed operations, about 30% failing: `applied 439 monotonic (FIFO): true inTx at end false` |
| A11 | postgres.js fails the whole transaction on any query error, even a caught one | `q.catch(e => uncaughtError \|\| (uncaughtError = e))` … `if (uncaughtError) throw uncaughtError` (postgres 3.4.9 `cjs/src/index.js:251-290`) |

A2 is why the lock is required, and why `KvStore` must share it. A5' is why any error fails the
whole transaction (D3).

## D1. The port

```ts
export interface AsyncCatalogDb {
  all<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, ...binds: unknown[]): Promise<T | null>;
  run(sql: string, ...binds: unknown[]): Promise<{ changes: number }>;
  /** All-or-nothing. `t` is scoped to this transaction; `t.tx` joins it. */
  tx<T>(fn: (t: AsyncCatalogDb) => Promise<T>): Promise<T>;
}
```

- `t` has the same interface as the root, so a store or `Catalog` built over `t` works unchanged,
  and a store method with an internal `tx` joins the caller's transaction.
- **Joining, not savepoints.** No call site nests (Context). A savepoint is a second open scope
  that can outlive its parent. All three reviewers showed savepoint writes leaking into the next
  request's transaction when a parent ended first. Joining has no second scope.
- **Engine-neutral semantics, which slice 4 keeps:**
  - an error fails the whole transaction (A11);
  - the root handle is refused inside a transaction. On postgres.js the root silently uses another
    pool connection and escapes the transaction, so the slice 4 adapter keeps the same
    `AsyncLocalStorage` guard.
- Added beside `CatalogDb`, not to `Ports`. 3d renames it to `CatalogDb` and deletes the
  synchronous interface.
- Shape mapping to postgres.js: root = `sql`, `tx` = `sql.begin`. Bind syntax is slice 4's job
  (`?` versus tagged templates).

## D2. One connection, one FIFO lock

`AsyncSqliteCatalogDb` wraps one better-sqlite3 `Database`.

- **The lock belongs to the connection**, kept in a module-level `WeakMap<Database, Lock>`.
  - Two adapters over one `Database` share it, so A2 cannot come back through a second instance.
  - Separate databases (parallel tests) never block each other.
- **The lock** is a promise chain that never rejects. Each acquirer waits for its predecessor's
  release, so callers are served in the order they called the root handle (A10).
- **Root `all`/`first`/`run`** acquire the lock, run the statement, and release it.
- **Root `tx(fn)`** acquires the lock and keeps it until the transaction ends.
- **Handle statements** run immediately, because their transaction holds the lock. Concurrent
  handle statements in one transaction (`Promise.all`) are fine: each is one synchronous call.
- The raw-transaction check (D4) runs **after** the lock is acquired. Before that, `inTransaction`
  is legitimately true while another adapter transaction holds the lock.

## D3. Transaction protocol

- **Begin.** Acquire the lock, then `BEGIN IMMEDIATE`, inside the `try`/`finally` that releases
  the lock. A failing `BEGIN` therefore still releases it. IMMEDIATE takes the write lock up
  front, so the transaction never fails half-way on a lock upgrade.
- **Body.** Run `fn(t)` inside `AsyncLocalStorage.run(state)` (D4), raced against the deadline.
- **Failure state.** A transaction is *failed* once any of these happens:
  - a handle statement throws;
  - a handle statement finds `db.inTransaction` false (an auto-rollback, A5');
  - a joined `t.tx` body throws;
  - the body throws;
  - the deadline passes.

  The first error is kept. After that every handle call rejects, citing it as `cause`.
- **End, exactly once.** The end protocol runs on one path, whichever comes first: the body
  settling or the deadline. A body that settles later is ignored. `inTransaction` describes the
  connection, not this transaction, so a second run could roll back the next caller's
  transaction.
  - If not failed and no joined body is still running, `COMMIT`. If `COMMIT` throws (A8), the
    transaction becomes failed.
  - If failed, `ROLLBACK` only when `inTransaction`, then reject with the first error. A rollback
    error never replaces it.
  - Everything happens before the lock is released.
- **Joined body still running at the end** (an un-awaited `t.tx`): roll back. If the transaction
  had not otherwise failed, reject with `CatalogTxMisuseError`; otherwise **the first error
  wins**, so a domain error (a 409 or 400 from a body) is never turned into a misuse error. The
  unfinished body's later handle calls reject because the handle is closed, so nothing escapes
  into autocommit.
- **Close.** The handle is closed before the lock is released, on every path.
- **Rollback failure (A9).** The adapter marks the connection broken (kept beside its lock).
  Every later call rejects with `CatalogAdapterBrokenError`, including waiters already queued: each
  checks the flag once it acquires the lock, before touching the connection. So no caller writes
  into the dead transaction and none hangs. Recovery means restarting the process; 3d's wiring
  makes the error fatal.
- **Deadline.** `txTimeoutMs`, a constructor option, defaults to 10000.
  - On expiry the transaction fails with `CatalogTxTimeoutError`, rolls back, closes the handle
    and releases the lock.
  - The body may keep running. Its handle calls reject, and so do its root calls (D4).
  - The timer is `unref()`ed and cleared when the transaction ends, so it never delays process
    exit.
  - A body that touches only the database resolves entirely in microtasks, so the timer cannot
    fire against any of today's 7 bodies.

## D4. Misuse guards

Each handle object holds its own state: which transaction it belongs to, whether that
transaction is open, and whether it has failed. `AsyncLocalStorage` (`als.run`, never
`enterWith`) is used only to detect root misuse. It carries the root transaction's state object,
which has no savepoint frames to walk.

| Misuse | Without a guard | Guard |
|---|---|---|
| The root handle (statement or `tx`) called while the context's transaction is open | Deadlock on its own lock | Reject with `CatalogTxMisuseError`, before joining the queue |
| A handle used after its transaction ended | Runs outside the lock, in autocommit | Reject |
| The body returns while a joined body is still running | That body's writes would autocommit after `COMMIT` | Roll back, reject (D3) |
| The connection is inside a transaction the adapter did not open | The adapter would commit or roll back someone else's work | Reject, checked after the lock is acquired |

- Root work detached from a transaction that has since **committed** is allowed and simply waits
  for the lock (A6).
- Root work from a transaction that ended **failed or timed out** is rejected, citing that
  transaction's error as `cause`. Otherwise a timed-out body could go on writing through the root
  in autocommit while its handle writes were rolled back.
- Fire-and-forget root work that runs while its originating transaction is still open is
  rejected, even though waiting would be safe. The rejection goes to that call's own promise. Code
  that drops it is already a hygiene violation (3d extends that test to `packages/catalog`).
- Misuse always rejects the caller's promise and never throws asynchronously elsewhere. The
  adapter's internal promises never reject unobserved.
- **Every promise a handle returns is marked handled** (`p.catch(() => {})` before it is
  returned) from `t.tx`, `t.all`, `t.first` and `t.run`. A caller that awaits it still gets the
  rejection. One the body dropped, such as an orphaned `t.tx` whose handle closed, cannot crash
  the process with an unhandled rejection. Its error is not lost: any handle error fails the
  transaction, whose own promise carries it.
- The error classes live in `packages/storage`, because `@autologger/ports` exports no runtime
  values (`packages/ports/src/index.test.ts`).

## D5. KvStore moves onto the adapter (owner, 2026-10-01)

- `KvStore` takes an `AsyncCatalogDb` and uses `first`/`run` on the root handle.
- The lazy-expiry delete in `get` becomes conditional
  (`DELETE … WHERE key = ? AND expires_at <= ?`). The SELECT and the DELETE are now separate lock
  acquisitions, so this keeps a value re-put in between from being deleted. The rest of the SQL is
  unchanged.
- `config.ts` builds `new AsyncSqliteCatalogDb(catalog)` once and passes it to `KvStore`. The
  synchronous `CatalogDb` keeps serving the stores.
- **Why this is safe now.** No async transaction exists in 3c. Each KV call holds the lock for
  one synchronous statement, and a synchronous `db.transaction` can never be open across that
  call's await. So KV results and ordering are unchanged, and the raw-transaction check can't
  fire.
- **What stops holding in 3d.** Today two KV steps, such as `takeOauthState`'s `get` then
  `delete` (`server/src/auth/identity.ts:41-47`), can't interleave with another request. Each
  statement runs at call time, and nothing holds the lock across a macrotask. Once 3d's
  transactions hold the lock across awaits, two callbacks carrying the same OAuth state can both
  queue their `get` ahead of either `delete`, so both succeed and the state stops being
  single-use. Evidence: re-panel `node kvtake.mjs` (lock held across a 10 ms timer) ->
  `take A true take B true`.
  - The atomic take is auth work and the owner's decision, so it is not changed here.
  - ADR 0021 moves it from the slice 4 list to a **prerequisite of 3d** (D6.7).
- **Why now.** It removes 3d's biggest hidden obligation. Without it, a KV write during a 3d
  async transaction would join it (A2). It also gives the adapter a production consumer and a
  live check.

## D6. What 3d inherits (recorded in ADR 0021)

1. **Transaction bodies run on stores bound to `t`.** Router bodies use the per-request facade,
   which is built over the root, so they would hit the root guard. Store-internal transactions
   call `this.*` helpers bound to the store's own handle (`authStore.ts:117-121`,
   `showsStore.ts:226`). 3d therefore gives the facade a `tx` that builds a `Catalog` over `t`.
   It also has to settle how that catalog's `StudioRegistry` snapshot is initialised and how the
   request's facade sees registry changes afterwards.
2. **Extend the promise-hygiene test to `packages/catalog/src`.** Five of the 7 bodies live there.
   An un-awaited handle call or `t.tx` is caught at runtime (D3), but should fail the build.
3. **Transaction bodies await only the handle.** The deadline (D3) bounds a stall at 10 seconds
   but does not prevent it.
4. **Shutdown.** `config.ts` `close()` closes the raw connection synchronously. An in-flight
   transaction rolls back (atomic), but its body and any queued waiters get a raw `TypeError`.
   3d adds an adapter `close()` that refuses new work and waits, with a bound, for the holder.
   It also makes `CatalogAdapterBrokenError` fatal.
5. **Size.** The stores have 62 `this.db.` sites. Adding the method signatures, the facade
   interfaces, the 7 bodies and the sync port deletion puts 3d plausibly over 400 lines. 3d
   measures this with a retype probe and splits before proposing if needed.
6. **Migrations and the test seed helpers** keep the raw handle. Both run before any request,
   so they never interleave with an adapter transaction.
7. **The OAuth atomic take must land before or with 3d** (D5), as the owner decides: for example a
   single `DELETE … RETURNING`, or `delete` reporting `changes` with `takeOauthState` keyed on
   it. It was on the slice 4 list. 3d is where it becomes reachable.
8. **The synchronous stores bypass the lock until they move.** A synchronous `tx` run during an
   adapter transaction would nest inside it. This can't happen in 3c (no adapter transaction is
   opened), and 3d moves every store at once.

## D7. Size

About 160-190 counted lines:
- the interface: about 10;
- the adapter: about 130;
- `KvStore`: about 15;
- `config.ts`, the export: about 5.

Tests are not counted.
