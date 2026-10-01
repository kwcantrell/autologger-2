# Async catalog stores: the catalog runs on the asynchronous adapter, and the synchronous port is deleted

Tier: 2
Tier reason: the catalog persistence contract, every catalog transaction (including Google sign-up and the last-admin guard), the OAuth state check (auth), and the composition root.

Approved-by: Kalen 2026-10-01

## Why

This is ADR 0021 slice 3d, the last of four top-down PRs that make the storage ports async while
they still run on SQLite:
- 3a and 3b made every server caller await the catalog;
- 3c built the asynchronous port and its SQLite adapter, and moved `KvStore` onto it;
- this change moves the five catalog stores onto that adapter, and deletes the synchronous port.

After it, slice 4 can swap SQLite for postgres.js behind the same port without touching a store,
a router, a seed helper or a test call site.

## What Changes

**The port** (design D1):
- `CatalogDb` in `@autologger/ports` becomes the asynchronous interface (`AsyncCatalogDb` is
  renamed to it).
- The synchronous interface and its better-sqlite3 class are deleted.
- `Ports.catalog` and `KvStore` share one `AsyncSqliteCatalogDb`.

**The stores** (design D2):
- Every store method that touches the database returns a promise, and every internal call
  awaits.
- The memory-only registry getters stay synchronous. `Catalog.init()` becomes async.
- Five store read-then-write sequences now run in a transaction: `authEnsurePrefsRow`,
  `authSeedPrefsFromGlobals`, `adminCreateStudio`, `adminDeleteStudio`'s show count, and the
  `getStudioSettingsBlob` self-heal. They were atomic only because each store method ran in one
  synchronous call.

**Transactions** (design D3):
- `CatalogFacade` gains `tx(async (cat) => …)`, which runs the body on a `Catalog` bound to the
  transaction handle.
- Store methods with their own transaction (6 today, 11 after the bullet above) run on a copy of
  the store bound to the handle, so they join an enclosing transaction.
- Google sign-up and the teams last-admin guard move onto `catalog.tx`, and the guard's
  `mutate` callback becomes async inside the transaction.

**OAuth state** (design D4, owner 2026-10-01):
- `KvStore.take(key)` is one `DELETE … RETURNING` statement.
- `takeOauthState` uses it, so of two concurrent callbacks carrying one state, exactly one
  proceeds.

**A failed rollback stops the server** (design D5): `createBindings` takes an `onBroken`
callback, and `main.ts` passes one that logs at error level, sets exit code 1 and sends
`SIGTERM`.

**Promise hygiene** (design D6):
- The test also scans `packages/catalog/src`.
- A new rule over test files flags `expect(promise)` without `.resolves`/`.rejects`, so a
  missed `await` on a test read can't pass vacuously.

**Tests** (design D7, owner 2026-10-01): the seed helpers become async and call the real store
methods, and every seed call and test catalog read awaits. This is test-only and not counted
against the size budget.

## Size

About 650 counted lines (design D8), over the 400 budget. The owner chose one atomic PR with the
`size-override` label (2026-10-01). Splitting would leave synchronous stores outside the lock,
or would need throwaway synchronous twins.

## Concurrency, honestly stated

The SQLite adapter only ever yields microtasks (design A7). So in a running server, a request's
run of catalog awaits still completes before another request's I/O callback runs, as it does
today. The ADR 0021 check-then-act hazards stay latent until slice 4, and HTTP behaviour is
unchanged.

The new concurrency tests force interleaving, in the same tick or with a held transaction. They
guard the slice 4 behaviour; they do not reproduce today's production behaviour.

## Non-goals

- No SQL or schema change, and no Postgres (slice 4).
- No session hub change (slice 7).
- No adapter `close()` (deferred to slice 4's adapter, design D5).
- No change to the authorisation logic. The router-level check-then-act hazards in ADR 0021
  stay listed for slice 4.
- No HTTP or WebSocket change. The one exception is that a concurrent OAuth replay is refused
  with `state_invalid`, as the frozen contract already requires.

## Impact

- **Code:**
  - `packages/ports/src/{catalogDb,kvStore}.ts`;
  - `packages/storage/src/{asyncCatalogStore,kvStore,index}.ts` (`catalogStore.ts` deleted);
  - `packages/catalog/src/*.ts`;
  - `server/src/node/config.ts`, `server/src/main.ts`;
  - `server/src/routers/{auth,teams,events}.ts` (`events.ts` is a comment only);
  - `server/src/auth/identity.ts`, `server/src/middleware/auth.ts`;
  - `README.md` (architecture tree).
- **Tests:**
  - `server/src/test/helpers.ts` and every integration test that seeds or reads the catalog;
  - `server/src/promiseHygiene.repo.test.ts`;
  - `packages/storage` tests;
  - `packages/catalog/src/catalog.test.ts`.
- **Specs** (`core-ports-architecture`): one requirement renamed and modified, and four more
  modified (design D9).
- **ADR 0021:** slice 3 is done. The hazard list notes that the hazards stay latent through 3d
  and go live in slice 4, and hazard 1 (the OAuth take) is closed.
