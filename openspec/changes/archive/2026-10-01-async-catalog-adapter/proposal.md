# Async catalog adapter: an asynchronous catalog port and SQLite adapter, with KV moved onto it

Tier: 2
Tier reason: a new storage port contract, transaction semantics, a per-connection lock (concurrency), and the composition root's KV wiring.

Approved-by: Kalen 2026-10-01

## Why

This is ADR 0021 slice 3c, the third of four top-down PRs that make the storage ports async while
they still run on SQLite:
- 3a and 3b (merged) made every server caller await the catalog;
- this change builds the asynchronous catalog port and its SQLite adapter, and moves `KvStore`
  onto it;
- 3d moves the catalog stores onto it, converts the transaction bodies, and deletes the
  synchronous port.

better-sqlite3's `db.transaction(fn)` refuses an async `fn`, and the catalog runs on one
connection. On one connection an open transaction captures every statement issued on it, from
any request. An async transaction therefore needs a lock that holds every other statement on that
connection back until it commits or rolls back. `KvStore` shares the connection, so it must go
through the same lock before 3d opens the first async transaction.

## What Changes

**A new port, `AsyncCatalogDb`** (design D1), in `packages/ports/src/catalogDb.ts`:
- `all`, `first` and `run` return promises;
- `tx(async (t) => …)` passes the body a handle `t` scoped to the transaction;
- `t.tx(…)` joins the enclosing transaction; it opens no savepoint (owner, 2026-10-01);
- any error inside the transaction, even one the body catches, fails the whole transaction, which
  rolls back and rejects with the first error. Postgres behaves the same way.

**A SQLite adapter, `AsyncSqliteCatalogDb`** (design D2-D4), in `packages/storage`:
- one first-in-first-out lock per connection: a transaction holds it across its awaits, and every
  root statement or transaction waits for it;
- `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`, with the lock always released;
- a transaction deadline (default 10 seconds) that rolls back and releases the lock if a body
  never settles;
- if a rollback itself fails, the adapter stops serving rather than leaving the connection inside
  a dead transaction.

**Misuse fails fast instead of deadlocking or leaking writes** (design D4):
- the root handle used from inside an open transaction rejects (it would wait for its own lock);
- a handle used after its transaction ended rejects;
- a transaction whose body returns while a joined body is still running rolls back and rejects;
- the adapter refuses to work on a connection left inside a transaction it did not open.

**`KvStore` moves onto the adapter** (design D5, owner 2026-10-01). It takes an `AsyncCatalogDb`
instead of the raw better-sqlite3 handle, and `server/src/node/config.ts` builds one adapter over
the catalog connection for it. No async transaction exists yet, so KV behaviour is unchanged.

## Non-goals

- No change to the catalog stores, the `Catalog` facade, or any transaction body (3d).
- No change to the test seed helpers or migrations, which keep the raw handle.
- No postgres.js adapter and no SQL dialect change (slice 4).
- No HTTP or WebSocket change.

## Impact

- **Code:**
  - `packages/ports/src/catalogDb.ts` (new interface);
  - `packages/storage/src/asyncCatalogStore.ts` (new);
  - `packages/storage/src/kvStore.ts`;
  - `packages/storage/src/index.ts`;
  - `server/src/node/config.ts`;
  - tests: `asyncCatalogStore.test.ts`, `kvStore.test.ts`.
- **Specs:** `core-ports-architecture` gains two requirements.
  - "The catalog transaction contract" holds on any engine.
  - "The SQLite catalog adapter serialises each connection" holds until slice 4 removes it.

  The existing "Catalog persistence is synchronous…" requirement describes the seam the catalog
  stores are wired to. The two coexist until 3d modifies it.
- **ADR 0021:** the 3c entry, and what 3d inherits (design D6).
