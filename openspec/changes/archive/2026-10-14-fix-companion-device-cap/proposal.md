# Queue a user's Companion device creates so none counts a stale snapshot

Tier: 2
Tier reason: a fix to concurrency, locking and retry behavior (risk-tier: "Concurrency, locking,
retries or ordering guarantees"), inside one store (`packages/storage/src/companionDevices.ts`) and
its tests. No contract, schema, migration or spec requirement changes; the owner may set tier 1.

Approved-by:

## Why

`server/src/routers/companionDevices.int.test.ts` "the per-user cap of 10 > 14 concurrent creates
from none leave exactly 10" fails at random (`expected [409, 409] to have length 4`: ten 201s, two
409s and two other answers). `create()` takes `pg_advisory_xact_lock` keyed on the user, counts,
and inserts, inside a catalog transaction. Catalog transactions are `SERIALIZABLE`, and the
snapshot is taken by the first statement (the adapter's preamble, pipelined with `BEGIN`), before
the lock is granted. A create that waited on the lock counts without the device the holder just
committed. Serializable isolation catches it, so the cap holds (no run ever stored more than 10),
but the waiter fails with 40001 and re-runs, and every commit dooms every create still waiting. A
probe of 30 rounds of 14 concurrent creates counted 665 serialization failures for 420 creates
(1 736 with two other users creating at the same time). The adapter allows five runs, so under load
a create runs out of them (or past its deadline) and the route answers 500.

## What Changes

- **`packages/storage/src/companionDevices.ts`.** `create()` queues a user's creates in this
  process: each starts its transaction after the previous one for that user ended, so it never
  waits inside a transaction behind one of its own process. The transaction itself (advisory lock,
  count, insert) is unchanged; across processes it still keeps the cap, a race there costing a
  re-run as today. Queue entries are dropped when a user's last create settles. A create that
  has not started its transaction within the adapter's transaction timeout (`txTimeoutMs`, now
  readable on `PostgresCatalogDb`; the store takes that adapter and an optional
  `queueTimeoutMs` override for tests) rejects with the adapter's `CatalogTxTimeoutError`, the
  error and HTTP answer a transaction timeout gives today, and leaves the queue without
  inserting. The transaction then has its own deadline, so a create is bounded by twice the
  timeout. `created_at_utc` is read when the create's turn comes, so it follows the queue order.
  The store port has no request abort signal, so a create whose client went away still waits its
  turn (bounded as above) and inserts a device whose token nobody received; it is listed and can
  be revoked like any other.
- **`packages/storage/src/postgresCatalogStore.ts`.** `txTimeoutMs` becomes a public read-only
  field, so the store reuses the configured value.
- **`packages/storage/src/companionDevices.pg.test.ts`.** Two tests on an adapter with
  `maxTries: 1` (no re-runs, so a stale count shows as its 40001): two creates with 9 devices while
  another connection holds the user's lock key give one `created` and one `cap-reached`; and 8
  rounds of 14 concurrent creates each give exactly 10 `created` and 4 `cap-reached`. Both fail on
  the current code with `could not serialize access due to read/write dependencies among
  transactions`. A third test: with a 200 ms queue timeout and the first create held on the
  lock, a queued create rejects with `CatalogTxTimeoutError`, never inserts, and a later create
  still succeeds; a fourth pins the default to the adapter's `txTimeoutMs`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

None. The `api-contract-freeze` cap requirement (at most 10 devices, 409 on the 11th) and the
`core-ports-architecture` transaction contract (`tx()` is `SERIALIZABLE`, five runs) are unchanged.
`skip_specs: true`.

## Non-goals

- A cross-process fix. The queue is valid only while the API is one process (`server/src/node/
  config.ts` builds one store per process; the data-dir lock keeps one server per data dir). A
  second API process falls back to serializable retries; the cap still holds.
  Removing the retries across processes as well: taking the count's snapshot after the lock needs a `READ COMMITTED`
  transaction (the catalog `tx()` contract forbids one) or a `catalog` function called as a root
  statement (a migration and a `catalog-database` privilege change). Both are larger changes.
- Serialization failures between different users' creates (predicate locks on shared pages of the
  small table); they remain and are retried.
- Other stores: no other `pg_advisory_xact_lock` caller exists in `packages/` or `server/src/`.

## Impact

- `packages/storage/src/companionDevices.ts`, `companionDevices.pg.test.ts`, the `txTimeoutMs` field of `postgresCatalogStore.ts`, and one route test in `server/src/routers/companionDevices.int.test.ts` (a high-risk path; test only).
