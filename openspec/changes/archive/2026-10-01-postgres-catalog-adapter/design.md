# Design: postgres-catalog-adapter

## Context

The `CatalogDb` port (`packages/ports/src/catalogDb.ts`) has one implementation today,
`AsyncSqliteCatalogDb` (`packages/storage/src/asyncCatalogStore.ts`). It works like this:

- **Lock.** A FIFO lock over one connection.
- **Transactions.** `tx` runs `BEGIN IMMEDIATE`, then the body with a `TxHandle`. Its `TxState`
  enforces the contract:
  - first error wins;
  - a caught error still fails;
  - joined `tx` calls are counted;
  - a body that returns before its joined work is misuse;
  - a handle used after its transaction ended is refused.
- **Deadline.** A 10 s deadline releases a stalled transaction.
- **Broken connection.** A failed `ROLLBACK` marks the connection broken.
- **Root guard.** An `AsyncLocalStorage` guard refuses the root handle inside an open
  transaction.

Postgres runs callers concurrently, so the lock goes. The rest of the contract carries over.

**Owner decisions (2026-10-01):**
- a postgres.js pool;
- every `tx` `SERIALIZABLE`;
- the body re-run on `40001`/`40P01`, at most 3 tries;
- int8 parsed to a number;
- after the panel, one PR over the size budget instead of a split (D8).

**Environment.** The 4a harness (`test/pg/`) gives each test its own clone of the migrated
catalog. The app role `autologger_app`:
- may open 20 connections;
- has `search_path = catalog`;
- has `statement_timeout` 30 s and `idle_in_transaction_session_timeout` 15 s;
- gets DML on new `catalog` tables through default privileges.

## Goals / Non-Goals

**Goals:**
- An adapter that passes the same contract suite as the SQLite one.
- Bounded retry.
- Every step bounded in time.
- No path, connection loss included, that sends a statement outside its transaction, crashes
  the process, or leaks a connection.

**Non-Goals:** wiring and store dialect (4c), the ADR hazards (4d), removing SQLite (4e).

## Assumptions and evidence

The author's probes ran against the pinned image `supabase/postgres:17.6.1.136` as a
non-superuser role, using postgres.js 3.4.9. They are in `<scratchpad>/4b-probe.log` and
`probe4b*.mjs`. The panel's probes are in `panel-at/` and `panel-fa/`.

| # | Assumption | Command | Observed |
| --- | --- | --- | --- |
| A1 | `types.bigint = {to:20, from:[20], parse:Number, serialize:String}` makes int8 a number. A result's `count` is the affected-row count | `select count(*)`; `insert` | `count type number`; `insert count 1` (panel: `default count type string`, `override … number`) |
| A2 | Number and string binds are sent untyped and inferred by the server. `undefined` throws. An untyped `?` with nothing to infer from comes back as text | `insert … ($1,$2)` with `['a', 5]`; `select ? as v` with `5` | `insert count 1`; `UNDEFINED_VALUE`; `{"v":"5"} string`. Casting fixes it: `?::bigint` |
| A3 | Concurrent read-then-write under `SERIALIZABLE` raises `40001`. The read, gate, increment test is deterministic. `RAISE … ERRCODE` forces any code as the app role | two transactions incrementing one row; `do $$ … raise exception using errcode='40001'` | `40001`; panel p7: 50 runs, `deviations 0`, each 3 bodies, +2; forced: `runs 3`. A check-then-insert race gives `40001`, not `23505` (p10) |
| A4 | `cancel()` stops an in-flight statement or lock wait. **It returns `null`, so it can't be awaited, and a late cancel can hit the next statement on that connection** | `q.cancel()`; 300 rounds of cancel, `ROLLBACK`, next transaction on the same client | `57014 203 ms`; `cancel() return value: null` (query.js:53); `next tx on same slot failed: {"57014":3,"25P02":1}` |
| A5 | **After its socket closes, a `reserve()`d connection crashes the process on any statement, `ROLLBACK` included and released or not** | kill the reserved backend, wait 300 ms, `rollback` | `TypeError: Cannot read properties of null (reading 'write') at connection.js:255` |
| A6 | `release()` returns a connection still inside a transaction | `reserve(); begin; release()`, then a pool query | `runs inside it = true` |
| A7 | **`sql.begin()` is no safer: after a loss, it sends `COMMIT` on the dead connection once the body returns, which crashes the process and hangs the pool, even if the body sends nothing** | `probe4b6`/`probe4b7`: `begin(fn)`, kill the backend, body returns without a statement | `C1 begin rejects CONNECTION_CLOSED`, then `UNCAUGHT Cannot read properties of null (reading 'write')`, then the pool `HUNG` |
| A8 | A `max: 1` client's own `onclose` fires on a loss, and the client reconnects on its own. **An unguarded later statement autocommits on the new connection.** About half the time, a statement sent right after the kill goes out before `onclose` and rejects with `CONNECTION_CLOSED` | `begin; insert p1`, kill, `insert p2`; panel p5, 40 runs | `p1 rolled back, p2 leaked`; `closedBeforeNext 22/40; not-yet-closed outcomes {"CONNECTION_CLOSED":18}; leaked rows 0` |
| A9 | **`onclose` also fires for the adapter's own `end()`, about 3 ms after `end()` resolves, and its argument is a connection id, not an error** | panel p4/p6 | `right after end(): 0`; `50ms after end(): [["onclose","number","3ms"]]` |
| A10 | `end({timeout: 0})` rolls the transaction back only once the backend exits. **A backend running a statement keeps going, holding its locks and a role connection, until the statement ends**, unless `client_connection_check_interval` is set | panel p3, p8, p4 | `end() returned after 2 ms`; at +5006 ms the backend is still `active … locks 3`; `53300 too many connections for role` at 20; with `client_connection_check_interval: '1s'`: `backend gone after 835 ms` |
| A11 | **A `COMMIT` sent on an aborted transaction resolves without an error. Its command tag is `ROLLBACK`** | panel-fa p1: `t.run` not awaited, failing with `23505`, then `COMMIT` | `P1 dropped rejects 23505`, `P1 commit resolved command= ROLLBACK`, `P1 rows 0` |
| A12 | A lost `COMMIT` reply leaves the outcome unknown. A `ROLLBACK` sent afterwards runs on a reconnected socket and proves nothing | panel-fa p1 | `P3 rollback after commit resolves command= ROLLBACK` |
| A13 | A statement in flight on a killed backend rejects with `CONNECTION_CLOSED` and doesn't hang. A paused server leaves it pending with no client-side timeout. postgres.js's `connect_timeout` defaults to 30 s | `pg_sleep(5)`, killed after 100 ms; container paused; index.js:453 | `CONNECTION_CLOSED 116 ms`; unresolved after 5 s; `connect_timeout : 30` |
| A14 | `unsafe()` ignores the client option `prepare: true`. It defaults to `prepare: false` per call, and with no binds uses the simple protocol, which accepts several statements in one string | index.js:119-126; panel p2 | `prepare: false, ...options, simple: … args.length === 0`; per-call `{prepare:true}`: 200 calls in 26 ms vs 108 ms |
| A15 | `max_lifetime: null` and `idle_timeout: 0` turn both timers off | panel p2; connection.js `timer` | `opts null 0 true`; `if (!seconds) return {cancel:noop,start:noop}` |
| A16 | Tables a test creates must be in `catalog`. Default privileges then grant them to the app | panel p1 | unqualified as app: `42P01`; `catalog.t insert as app ok (default privileges)` |
| A17 | `SUM`/`AVG` over `bigint` return `numeric` (oid 1700) as a string, which the int8 parser doesn't cover | panel p2 | `s:1700, m:20, a:1700` (4c item) |
| A18 | No store SQL has a quoted `?`, `/* */`, `$$`, `E''` or a camelCase alias | greps over `packages/catalog/src` and `kvStore.ts` | no hits |
| A19 | 16 production `tx` call sites exist, and none is proven free of non-database effects | `grep -rn "\.tx(" packages server/src` | 14 in `packages/catalog/src`, plus `auth.ts:197` and `teams.ts:127`. A 4c item |

## D1. Shape and options

`packages/storage/src/postgresCatalogStore.ts` exports `PostgresCatalogDb implements CatalogDb`,
plus a new error, `CatalogCommitUnknownError`. It reuses `CatalogTxMisuseError`,
`CatalogTxTimeoutError` and `CatalogAdapterBrokenError` from `asyncCatalogStore.ts`.

```ts
{ host, port, user, password, database,
  rootMax = 3, txSlots = 5,   // 8 of the role's 20 connections; one adapter per process (D7)
  txTimeoutMs = 10_000, maxTries = 3,
  connect?: (opts) => PgClient }   // seam: the postgres.js factory, for fault-injection unit tests
```

Every client is built with:
- `types.bigint` set as in A1;
- `onnotice: () => {}`;
- `max_lifetime: null` and `idle_timeout: 0` (A15);
- `connect_timeout: 5`, below the deadline (A13);
- `connection: { client_connection_check_interval: '1s' }` (A10).

Every statement is `unsafe(text, binds, { prepare: true })` (A14).

## D2. Statements and placeholders

`toPg(sql)` turns each `?` into `$1…$n` in order. It skips `'…'` (with `''` escapes), `"…"` and
`-- …` to end of line, and caches results in a `Map` keyed by the SQL text.

- `all()` returns `[...rows]`.
- `first()` returns `rows[0] ?? null`.
- `run()` returns `{ changes: result.count }`.

Root statements use an ordinary pool of `rootMax`. Each statement autocommits, and the pool
reconnects on its own.

## D3. Transaction slots: one client per slot, never `reserve()` or `begin()`

A5-A7 rule out both of postgres.js's own transaction paths. The adapter keeps `txSlots` slots,
each holding one `max: 1` client.

- **Close detection matched by identity (A9).** Each client is created with an `onclose` that
  closes over that client object. When it fires, the handler acts only if:
  - the slot still holds that same client, and
  - the adapter didn't start the close itself (each client carries an `ending` flag).

  If both hold, it fails the attempt that holds the slot with a connection-lost error and sets
  `lost`.
- **The waiter queue.** Slots are handed out in FIFO order. A waiter whose deadline passes is
  removed from the queue and rejects with `CatalogTxTimeoutError`. A slot is never granted to a
  waiter that has already rejected.
- **Release.** A slot goes back to the queue only after a `COMMIT` with tag `COMMIT`, or a
  confirmed `ROLLBACK`, with `lost` false and no cancel sent on it.
- **Recycle.** In every other case, the adapter sets `ending`, calls `end({ timeout: 0 })`
  without awaiting it, and puts a fresh client in the slot. The server rolls back once the
  backend exits. That takes at most about 1 s for a backend that is still running a statement
  (A10).
- **Recycling stops after `close()`.** A slot then closes for good instead of being replaced.

## D4. The attempt

1. Take a slot, within the deadline.
2. Send `BEGIN ISOLATION LEVEL SERIALIZABLE`, bounded (D6).
3. Run the body with a `TxHandle` and an `AttemptState`: the SQLite adapter's `TxState` plus
   `lost`, `chain` and `inFlight`.
4. **Per-attempt chain.** Statements on the handle go out one at a time, each after the previous
   one settles. Before sending, the chain checks that the handle is usable and that `lost` is
   false.
   - A `CONNECTION_*` rejection also sets `lost`. A8 shows the reject can arrive before
     `onclose`.
   - The chain is what stops a statement from being sent to a reconnected socket, where it would
     autocommit (A8). It isn't about throughput.
5. **End protocol.** It runs once, on whichever settles first: the body or the deadline.
   - It sets `open = false`.
   - It **waits for the chain to drain**, so a statement the body dropped can still fail the
     attempt (A11), and then re-checks `failed`.
   - It applies the joined-body misuse rule.
   - If nothing failed, it sends `COMMIT`, bounded. The command tag must be `COMMIT`; any other
     tag fails the attempt with the error the transaction already carries, or with a misuse error
     naming the tag (A11).
   - **The `COMMIT` outcome is unknown when its reply never arrives**, because of a connection
     error or the bound expiring. The attempt then rejects with `CatalogCommitUnknownError`,
     carrying the original error as `cause`, and the slot is recycled. No `ROLLBACK` is sent
     (A12), and there is no retry.
   - Otherwise, on failure, it sends `ROLLBACK`, bounded, unless `lost` is set or a cancel was
     sent.
   - Then it releases or recycles the slot (D3).

The **root guard** (`AsyncLocalStorage`) is kept. A root statement inside a transaction would
escape it, so the guard rejects it, naming the transaction handle. Leftover root calls from a
failed attempt also reject.

## D5. Retry

An attempt is **retryable** when its first error, or the `COMMIT` error, has `code` `40001` or
`40P01` (A3). `CatalogCommitUnknownError`, connection loss, the deadline and every other error
are not retried.

- A retry starts at once, with fresh state, a fresh handle and any free slot. There's no backoff:
  the losing attempt only sees `40001` after the winner has committed.
- Earlier handles are dead.
- After `maxTries`, `tx` rejects with the last serialization error.
- A joined `tx` never retries on its own.
- The port's doc comment says a `tx` body may run more than once. Making that safe is a 4c item
  (A19).

## D6. Time bounds

One `txTimeoutMs` budget starts at `tx()`. It covers the slot wait, every `BEGIN`, every body and
every `COMMIT`.

- **`BEGIN` and `COMMIT`** are bounded by what remains of the budget, plus a 1 s grace for
  `COMMIT`.
- **`ROLLBACK`** is bounded by 1 s.
- **When a bound expires,** the slot is recycled. An expired `COMMIT` is outcome unknown (D4).
- **At the deadline,** while a statement is in flight:
  - the adapter calls `inFlight.cancel()`, in a `try`, for its side effect only. Its return value
    is never used (A4);
  - the attempt rejects with `CatalogTxTimeoutError`;
  - the slot is always recycled, never reused. A late cancel could otherwise hit the next
    caller's statement (A4).
- **At the deadline, with nothing in flight,** a bounded `ROLLBACK` runs and the slot is
  released.
- **Server-side backstops:** `statement_timeout` (30 s) and
  `idle_in_transaction_session_timeout` (15 s).

## D7. `close()` and connections

- **`close()`** marks the adapter closed. Then:
  - queued slot waiters and new calls reject with `CatalogAdapterBrokenError("closed")`;
  - in-flight attempts finish on their own bounds, with no retries and no recycling;
  - every client is ended, and `close()` resolves when they have closed.
- **Connection budget.** `rootMax + txSlots = 8`. A recycle can briefly hold one more connection
  until the old backend exits (about 1 s). That stays well under the role's 20 for one adapter
  per process. 4c must keep the catalog stores and `KvStore` on one instance, as the SQLite
  requirement already does. A `53300` on `BEGIN` is not retried, and the caller sees it.
- **The retired `onBroken` path.** The Postgres adapter never breaks: a failed `ROLLBACK` costs
  one recycled connection. 4c must therefore drop the `onBroken` wiring when it switches the
  catalog to Postgres. The SQLite requirement "A broken connection stops a supervised server"
  stays until 4e.

## D8. Tests (written first) and size

**The shared suite, `src/test/catalogDbContract.ts`.** It exports
`describeCatalogDbContract(name, make)`. `make()` returns:

```ts
{ db,
  rows(table): Promise<number>,
  uniqueViolation: string,   // SQLite 'SQLITE_CONSTRAINT_PRIMARYKEY', Postgres '23505'
  txTimeoutMs: number,       // short, adapter-specific; Postgres 300
  close(): Promise<void> }
```

Tables are `t (k text primary key, v bigint)` and `log (who text not null)`. Postgres creates
them as `catalog.t` and `catalog.log` (A16).

It carries the existing cases that aren't specific to SQLite:
- statements;
- commit;
- writes then throws;
- a constraint violation;
- a caught statement error;
- joined commit, joined throw, a body returning early, first error wins;
- root misuse;
- a handle after the end;
- detached root work;
- the deadline;
- the 300-operation stress test.

Plus two new cases:
- **a dropped statement then return:** the body calls `t.run(duplicate)` without awaiting it and
  returns. `tx` rejects with the unique-violation code, and no row persists (A11);
- **a failed deferred-FK `COMMIT`.**

`asyncCatalogStore.test.ts` calls the suite and keeps its SQLite-only cases: the lock, FIFO, two
adapters, a raw transaction, `RAISE(ROLLBACK)`, broken, and `onBroken`.

**`postgresCatalogStore.pg.test.ts`** (pg project, one test database each, `afterEach` always
closes):
- the suite;
- int8 as a number;
- `select '?' as q, ?::bigint as v` gives `{q:'?', v:5}`;
- the `40001` retry: read, gate, increment ends at +2 after 3 runs;
- the `40P01` retry via `RAISE … ERRCODE '40P01'` on the first run only, giving 2 runs;
- exhaustion via `RAISE … '40001'` every run: exactly 3 runs, rejecting with `40001`;
- no retry for a `23505`: exactly 1 run;
- the deadline over `pg_sleep(60)` with `txTimeoutMs: 300`: rejects within 2 s with no row, the
  backend is gone within 3 s (via `pg_stat_activity` as admin), and the next `tx` commits;
- connection loss: admin terminates the attempt's backend while the body awaits a gate. The next
  write rejects and is never sent, no row persists, and `txSlots + 1` later transactions commit;
- a slot waiter times out while all slots are held, and `txSlots` transactions then commit;
- `close()` while a `tx` is in flight: the `tx` settles, a queued `tx` rejects as closed, and no
  app connection remains (via `pg_stat_activity`).

**`postgresCatalogStore.test.ts`** (unit, through the `connect` seam):
- the `toPg` cases;
- a `ROLLBACK` rejects: the client is ended and replaced, and the next `tx` uses the replacement;
- a `COMMIT` that rejects with `CONNECTION_CLOSED`, and one that hangs past its bound: each gives
  `CatalogCommitUnknownError`, no `ROLLBACK` is sent, and the slot is recycled;
- a `COMMIT` tag of `ROLLBACK` fails the transaction;
- a recycled client's late `onclose` doesn't fail the next attempt on its slot (A9);
- `cancel()` returning `null` doesn't throw, and the slot is recycled.

**`vitest.config.ts`** has two projects: `unit` (excluding `*.pg.test.ts`) and `pg`
(`globalSetup: ['../../test/pg/globalSetup.ts']`).

**Size.** About 450 production lines:

| What | Lines (est.) |
| --- | --- |
| Adapter | ~410 |
| Config, exports, `package.json`, the port comment | ~40 |

That is over the 400 budget. The owner chose one PR over a split (2026-10-01), so the PR needs
the human-applied `size-override` label. The SQLite `TxState` logic is duplicated, not extracted.
Moving it would add about 200 counted lines, and 4e deletes the SQLite adapter anyway.

## Risks / Trade-offs

- **Transaction capacity.** Each transaction holds a whole connection for up to about 10 s, and 5
  slots cap concurrent transactions. Further callers wait inside their own deadline.
- **Re-run bodies.** A body with non-database effects repeats them on retry. Auditing that is a
  4c item (A19).
- **Outcome-unknown commits.** A lost `COMMIT` reply surfaces as `CatalogCommitUnknownError`.
  Callers that create rows must treat it as "may have happened". 4c maps it to a 5xx and 4d's
  sign-up race handling covers it.
- **`57P01` on root statements.** A root statement racing a connection loss can fail once with
  `57P01`. Root statements autocommit, so nothing leaks.
- **postgres.js internals.** The design relies on `onclose` timing (A8, A9), `cancel()` (A4), the
  `COMMIT` tag (A11), and postgres.js silently re-running a `RevalidateCachedQuery` (harmless
  inside an aborted transaction). The pg and unit tests pin each one, so a postgres.js upgrade
  that changes them fails CI.
- **4c items:**
  - audit the `tx` bodies (A19);
  - `numeric` aggregates come back as strings (A17);
  - drop `onBroken` (D7);
  - one adapter per process (D7).
