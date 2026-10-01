# Postgres catalog adapter: `CatalogDb` on postgres.js, not wired yet

Tier: 2
Tier reason: a new persistence adapter under the catalog transaction contract, with concurrency, retries and connection-loss handling. Everything the catalog writes will run through it from 4c.

Approved-by: Kalen 2026-10-01

## Why

ADR 0021 slice 4 moves the catalog to Postgres in five PRs (owner, 2026-10-01). 4a merged:
- the schema, in Postgres schema `catalog`;
- the `autologger_app` role and the `catalog` network;
- the test Postgres harness.

This change, 4b, adds the adapter that 4c will wire in: a postgres.js implementation of the
unchanged `CatalogDb` port, held to the same transaction contract as the SQLite adapter. The
contract is proven by one shared test suite run against both adapters.

## What Changes

- **`PostgresCatalogDb`** in `@autologger/storage`. The app's composition root doesn't use it
  yet; that is 4c.
  - **Statements** (`all`, `first`, `run`):
    - run on a postgres.js pool;
    - the `?` placeholders the stores use become `$n`, and quoted text and comments are left
      alone;
    - `bigint` values (`COUNT(*)`, every catalog integer) come back as numbers, as from SQLite;
    - `run()` returns the affected-row count.
  - **Transactions** (`tx`):
    - every transaction runs `SERIALIZABLE` (owner);
    - a serialization failure or deadlock (`40001`, `40P01`) re-runs the body, at most 3 tries in
      total (owner);
    - one deadline (10 s) covers the whole transaction, and every step that waits on the server
      is bounded;
    - a transaction resolves only on a confirmed commit. A commit whose reply is lost rejects
      with a distinct outcome-unknown error, which is never retried;
    - every rule in "The catalog transaction contract" holds as in SQLite: all-or-nothing, first
      error wins, joined `tx` calls, misuse refused.
  - **Connections.** A connection is reused only after its transaction is confirmed ended. A
    lost connection, one whose rollback can't be confirmed, or one with a cancel pending, is
    closed and never reused. Probes showed that postgres.js 3.4.9 crashes the whole process
    when a statement goes to a closed connection, through both `reserve()` and `begin()` (design
    A5-A7). So transactions use single-connection clients that the adapter manages itself.
  - **Close.** An async `close()` rejects waiting and new calls and ends every connection.
- **Dependency.** `postgres` (postgres.js 3.4.9) becomes a runtime dependency of
  `@autologger/storage`. It is already a root dev dependency for `test/pg`.
- **Tests.** The SQLite adapter's contract tests move into a shared suite, which runs against
  both adapters. `packages/storage` gains a `pg` vitest project that uses the 4a harness.
- **The port's doc comment** says that a `tx` body can run more than once.
- **Size.** About 450 production lines, over the 400 budget. After the panel, the owner chose one
  PR over a split (2026-10-01). The PR needs the human-applied `size-override` label.

## Non-goals

- **Wiring is 4c.** That covers `createBindings`, `KvStore` on Postgres, the server test harness,
  the store dialect fixes (`INSERT OR IGNORE`, `COLLATE NOCASE`), and NUL bytes. So is the audit
  that every `tx` body has only database effects, which retry makes necessary. It is recorded in
  ADR 0021 as 4c's first item, along with:
  - dropping the `onBroken` wiring;
  - `numeric` aggregates coming back as strings;
  - mapping the outcome-unknown error to a response;
  - one adapter per process.
- **The ADR's concurrency hazards are 4d.**
- **Deleting the SQLite adapter is 4e.**
- **No schema, role, network or secret changes.** 4a covered those.
- **The HTTP/WS contract is unaffected.**

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `core-ports-architecture`: ADDED requirement "The Postgres catalog adapter". "The catalog
  transaction contract" is unchanged; the new adapter must meet it.

## Impact

- New: `packages/storage/src/postgresCatalogStore.ts`, `packages/storage/vitest.config.ts`, and
  the tests.
- Changed: `packages/storage/package.json` (the dependency), `packages/storage/src/index.ts` (the
  export), `packages/ports/src/catalogDb.ts` (the comment), and `package-lock.json`.
- `docs/decisions/0021-*.md`: the 4c items above, and "an async `close()`" moves from 4c's open
  items to 4b.
- `npm test -w packages/storage` now needs docker, as the server tests already do.
