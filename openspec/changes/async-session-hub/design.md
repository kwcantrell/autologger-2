# Design: async-session-hub

## Context

See proposal.md for why. The current state this design changes:

- **The seam.** `SessionSql` (`packages/session-core/src/sessionCore.ts:25-30`) is synchronous:
  `all`, `run`, `exec`. `sqliteSessionSql` (`SessionHub.ts:297-307`) is its only production
  adapter, over prepared statements on one better-sqlite3 connection per session.
- **The model.** `SessionHub.ts:5-9` states it: RPC bodies have zero `await`s, so a body cannot
  interleave with anything. Every mutating RPC runs in `inTxn` (`:362-364`):
  `core.withBroadcastsHeld(() => db.transaction(fn)())`. `withBroadcastsHeld`
  (`sessionCore.ts:266-278`) keeps one hold depth and one pending queue per core. It flushes in
  enqueue order when the outermost scope returns, which is after better-sqlite3's commit, and
  drops the queue on a throw. Nested `inTxn` calls become savepoints (only a test nests them;
  the composites call store methods directly, `SessionHub.ts:505-511`, `:584-600`). Reads
  (`listEvents`, `statusLive`, `leaseStatus`, `exportEvents` …) run outside any transaction.
- **Lifecycle.** The constructor (`:324-351`) opens the file, sets the pragmas, runs `initSchema`
  and `inTxn(expireIfStale)`. `SessionHubRegistry.get` (`:781-792`) builds hubs lazily and
  synchronously. `evictIdle` (`:808-816`) closes a hub with no socket, no armed alarm and 10
  idle minutes since the last `get`. `closeAll` (`:823-827`) closes every hub synchronously; the
  composition root calls it at shutdown after `mirror.close()` (`server/src/node/config.ts:147-155`).
  The lease alarm (`:369-379`) calls `inTxn(expireIfStale)` from a timer.
- **Callers.** 75 hub resolutions and 87 storage calls in production code (D7 lists them), plus
  the `SessionMirror` snapshot. Comments in `aiMcpServer.ts:22-24`, `mcpTools.ts:19-24`,
  `events.ts:587-594,616-623`, `sessions.ts:525` and `topicGenerate.ts:100-106` rely on "no
  await, so nothing interleaves", or on "never hold a hub across an await". Five handler
  sequences read and then write across several hub calls and are atomic today only because the
  calls are synchronous (D7 S3, S4, S6, S9, S10).
- **Specs that pin synchronous behaviour:** `core-ports-architecture` ("Session runtime is a
  synchronous, substitutable port", the AI-tool and promise-hygiene requirements),
  `ai-topics-chat` ("Session-scoped MCP toolset"), `auto-event-generation` ("Anchored event
  insert is transactional", "The create_event handler is await-free"), `youtube-audio-import`,
  `transcript-generation`, `topic-generation`. The proposal's Capabilities section lists each
  delta.
- **Precedent.** Slice 3 converted the catalog the same way: 3a/3b awaited the callers, 3c built
  the async SQLite adapter (a per-connection FIFO lock, a transaction-scoped handle, joins, any
  error fails the whole transaction, misuse rejects), and 3d moved the stores. 3c's adapter was
  deleted in 4e (`git show 676ab79^:packages/storage/src/asyncCatalogStore.ts`), and its design
  is the model for D2-D4 here.

## Owner decisions after the panel (owner, 2026-10-03)

1. **Fix the five read-then-write sequences in 7a** (former OQ1): S3, S4, S6, S9 and S10 each
   become one hub method (D7), with concurrency tests that fire each conflicting pair at once and
   assert a serial-order result.
2. **No transaction deadline** (former OQ2), with a revisit item in ADR 0021 and in Risks (D4).
3. **A failed lease alarm logs and re-arms with a bounded backoff** (former OQ3, D6).
4. **The spec states observables only** (former OQ4): whether 7b keeps an in-process lock is
   7b's choice, as long as the observables in the core-ports delta hold.

## Goals / Non-Goals

**Goals:**
- One mechanism, the per-hub lock, replaces "a synchronous body cannot interleave" while the
  session store is embedded, and every read-then-write sequence that has to be atomic is one hub
  method, so the guarantee does not depend on the lock surviving into 7b.
- Every caller awaits, and a dropped or misused hub promise fails the build.
- The `SessionSql` seam has the shape 7b's postgres.js adapter implements, so 7b changes the
  adapter and the wiring, not the stores or the callers.
- No change for any serial order of requests (D10).

**Non-Goals:**
- Changing the remaining snapshot sequences S1, S2, S5, S7, S8 and S11 (D7). They are documented
  with their 7a window and carried as 7b hazards.
- Changing the SQL, the schema, the eviction timeout or the sweeper interval.

## Assumptions and evidence

The spike and the benchmark are pinned in this change: `spike/spike7a.mjs` and
`spike/bench7a.mts` (paths relative to `openspec/changes/async-session-hub/`). Spike run with
`node openspec/changes/async-session-hub/spike/spike7a.mjs` on node v24.21.0 and better-sqlite3
12.11.1 (the server workspace's copy). CI and the images run node 22; task 1.1 re-runs the spike
there.

| # | Assumption | Command | Observed |
|---|---|---|---|
| A1 | better-sqlite3's `db.transaction` refuses an async body | `node …/spike/spike7a.mjs` | `A1 Transaction function cannot return a promise rows 0 inTx false` |
| A2 | Raw `BEGIN IMMEDIATE` works, and a statement from any other caller on the connection joins the open transaction | same | `A2 inTx after BEGIN true`, `A2 other caller sees uncommitted 1`, `A2 after ROLLBACK 0 inTx false` |
| A3 | A chain of awaits on already-resolved promises finishes before a macrotask queued when it started | same | `A3 order chain,immediate` (1,000 awaits) |
| A4 | Two chains started in the same tick interleave | same | `A3b same-tick a0,b0,a1,b1,a2,b2` |
| A5 | Without a lock, a same-tick write lands inside another caller's open transaction and is lost with its rollback | same | `A3c rows after a rolled back []` (b's insert of 20 vanished) |
| A6 | `AsyncLocalStorage` survives awaits, is absent outside `run`, and follows detached work, timers included | same | `A5 inside {"id":1} outside undefined detached timer {"id":1}` |
| A7 | A closed connection fails with a raw `TypeError` | same | `A6 TypeError The database connection is not open` |
| A8 | `ROLLBACK` can fail and leave the connection inside the transaction | same | `A7 This database connection is busy executing a query inTx true` (an open iterator; session-core opens none) |
| A9 | Handlers that resume in different macrotasks do not interleave: 200 concurrent HTTP requests running 50-await microtask chains | same | `A8 requests 200 interleavings 0` |
| A10 | Under a per-call lock, two read-then-write chains resumed in one tick alternate between calls (the panel's finding, modelled) | same | `A9 sync two toggles: starts 1 rolling false \| async per-call lock: starts 2 rolling true` |
| A11 | A timer armed inside `als.run` inherits the context; one armed through `als.exit` does not | same | `A10 timer in run: {"hub":1,"open":true} \| timer via als.exit: undefined` |
| A12 | Hono awaits an async `createEvents` before upgrading, so the WebSocket route can await `get` | `sed -n 33,41p node_modules/hono/dist/helper/websocket/index.js` | `const result = await handler(c, await createEvents(c), options);` (hono 4.13.11) |
| A13 | No store catches a SQL error, so "any error fails the whole transaction" changes no outcome | `grep -n "try {" packages/session-core/src/*Store.ts` | Only `eventStore.ts:281` and `audioStore.ts:25`, both around `JSON.parse` |
| A14 | Production code never nests `inTxn` | `grep -n "inTxn(" packages/session-core/src/SessionHub.ts` | Every `inTxn` body calls store methods, never a hub delegate; the nested case is `SessionHub.test.ts:338-372` only, which calls the public `hub.addEvent` inside `inTxn` |
| A15 | Production call sites and test construction sites | `grep -rnE "\.(addEvent\|…\|deleteDashboard)\(" server/src packages` (method names from `SessionHubFacade`), the `get`/`getSessionHub` grep, `grep -rn "new SessionHub(" packages server/src` | 87 storage calls and 75 resolutions in 15 files (D7); `new SessionHub(` 32 times in `SessionHub.test.ts`, 2 in `fakeClock.test.ts` |
| A16 | Widening promise hygiene to the four package roots finds existing violations | the panel's run of the widened scan | 3, all in `aiMcpServer.ts`: `:950` `if (this.startPromise)`, `:1112` `singletonPromise ??= …`, `:1127` `if (p !== null)` |
| A17 | Today's micro-benchmark baseline (informational; task 1.3 records the real one) | `npx tsx openspec/changes/async-session-hub/spike/bench7a.mts` | `addEvent us/call … median 180.0`, `listEvents us/call … median 430.7` (node 24, host) |

A2 and A5 are why reads and writes must both take the lock (D3). A10 is why the lock alone is
not enough: a handler's read-then-write sequence across two hub calls is no longer atomic, so
each one that must be is a single hub method (D7). A11 is why the alarm is armed outside the
transaction's context (D6).

## D1. What an awaited SQLite hub changes

`await hub.m()` with the SQLite adapter resolves through microtasks only: the lock hand-off,
`BEGIN`, the body's awaited statements (each a synchronous better-sqlite3 call wrapped in a
resolved promise), `COMMIT` and the flush.

- **Handlers that resume in different macrotasks do not interleave** (A3, A9). A request arrives
  on an I/O callback, and its chain of hub calls finishes before the next callback runs.
- **Handlers that resume in the same tick do** (A4, A10). This happens when two requests' catalog
  replies (Postgres since slice 4) resolve in one socket callback, when one handler runs hub calls
  under `Promise.all`, or when two MCP tool calls arrive together. Every hub call is then a lock
  acquisition, and the two handlers alternate between their calls. Today each handler's hub
  calls form one synchronous block that nothing can split.

So two things are needed, and this change does both:
- the per-hub lock (D3) makes each *call* atomic and keeps reads off uncommitted rows (A2, A5);
- every *sequence* of calls that must be atomic becomes one hub method (D7: S3, S4, S6, S9, S10,
  plus the existing `createAnchoredEvent` and `anchorImportedTake`).

The remaining multi-call sequences (S1, S2, S5, S7, S8, S11) are snapshots or windows that D7
describes. In 7a they can split only when two handlers resume in one tick. In 7b, when every
statement is I/O, they can split on any request.

Tests force interleaving with a test `SessionSql` that yields to a timer between statements
(`src/test/slowSql.ts`), so they exercise what 7b will do on every call.

## D2. The async SQL seam and its SQLite adapter

```ts
export interface SessionSql {
  all<T = Row>(sql: string, ...binds: SqlValue[]): Promise<T[]>;
  run(sql: string, ...binds: SqlValue[]): Promise<{ changes: number }>;
  /** Multi-statement DDL (initSchema); zero binds, no result. */
  exec(multiStatementSql: string): Promise<void>;
  /** All-or-nothing. `t` is scoped to this transaction; `t.tx` joins it. */
  tx<T>(fn: (t: SessionSql) => Promise<T>): Promise<T>;
}
```

The transaction contract is the catalog's ("The catalog transaction contract"), so 7b's
postgres.js adapter has one shape to meet:
- **Joins, no savepoints.** `t.tx(fn)` runs `fn(t)` inside the same transaction. No production
  code nests (A14). Joining keeps no second scope that could outlive its parent (3c D1).
- **Any error fails the whole transaction**, even one the body catches: a statement error, a
  joined body's error, or the body's own error. The transaction rolls back and rejects with the
  first error. That is Postgres's behaviour, and no store catches SQL errors today (A13).
- **Misuse rejects** instead of escaping the transaction (`SessionTxMisuseError`):
  - a handle used after its transaction ended;
  - a body that returns while a joined body is still running;
  - a root statement while the adapter's own transaction is open on the connection (it would
    join it, A2).
- **Protocol** (`sqliteSessionSql`): `BEGIN IMMEDIATE`, body, then `COMMIT`. If the body or a
  statement failed, `ROLLBACK` when `db.inTransaction`. If `COMMIT` throws and the transaction
  is still open, `ROLLBACK`, then reject with the commit error. Every promise a handle returns is
  marked handled before it is returned, so an orphaned one cannot crash the process; its error
  still fails the transaction (3c D4).
- **A failed `ROLLBACK`** (A8; only possible with an open iterator, which session-core never
  opens) rejects the call with the first error, the rollback error attached as `cause`, and
  reports `rollbackFailed` to the hub. The hub then closes itself (D6), and the next `get` opens a
  fresh connection. There is no process exit here. Whether an unconfirmed rollback retires the
  connection or stops the process is 7b's adapter policy, as the catalog adapter's "an
  unconfirmed rollback retires the connection" is.
- **Only the adapter wraps synchronous calls in promises.** Stores and callers never write
  `async` around a synchronous call, the 3c adapter rule.

The adapter holds no lock; the hub's lock (D3) covers every call on the connection.

## D3. Per-hub serialization (7a's mechanism while the session store is embedded)

The spec delta states observables only (no dirty read, broadcasts in commit order, atomic
read-then-write methods, no self-deadlock). This section is how 7a meets them on SQLite; 7b may
meet them differently.

**Where the lock lives: in the hub.** One `SessionHub` owns one connection, so a per-hub lock is
the per-connection lock 3c had. Putting it in the hub, not the adapter, lets the hub hold it
across the commit *and* the broadcast flush. If the adapter released the lock at `COMMIT`, the
next transaction could start before the flush, and two calls' frames could leave out of commit
order. `SessionCore` stays lock-free and storage-agnostic.

**The lock** is a promise-chain FIFO mutex that never rejects (3c D2, measured FIFO there). Every
storage call runs through one private entry point:
1. Reject with `SessionHubClosedError` if the hub is closing or closed.
2. Reject with `SessionTxMisuseError` if this async context is already inside an open
   transaction of *this* hub (D4). This is checked before queueing, so it never deadlocks.
3. Count the call in flight and set `lastTouchedMs`.
4. Acquire the lock. Once acquired, check closed again.
5. **Write:** `sql.tx(async (t) => body(storesFor(core.forTransaction(t))))`. On success, flush
   the transaction's held broadcasts in enqueue order, then release. On failure, drop them,
   release, and reject with the error.
   **Read:** run the body against the root stores (no `BEGIN`), then release. Under the lock
   nothing else touches the connection, so a multi-statement read (`listEvents`' count and
   page, `projection`, `statusLive`) sees one state.
6. Decrement the in-flight count in a `finally`.

**Reads take the lock.** One connection serves the session, so a read issued while a write
transaction is open on it reads that transaction's uncommitted rows (A2), which may then roll
back. A read that waits sees only committed state.

**Broadcast queue per transaction** (the async form of `withBroadcastsHeld`). Today the queue
and its hold depth belong to the hub's one `SessionCore`, so any broadcast issued while a
transaction is open is held, including a Companion command relayed from a socket
(`handleSocketMessage` → `broadcastCommand`). With async bodies that window is real: a relayed
command would be held by an unrelated transaction, and dropped if it rolled back. So
`core.forTransaction(t)` returns a core bound to the transaction's handle with its own held
queue. Broadcasts through it are held; the hub flushes them after `COMMIT` or drops them on
failure. Broadcasts through the root core (`broadcastCommand`) are sent at once. The contract of
`withBroadcastsHeld` is unchanged: held while the transaction is open, flushed in enqueue order
only after commit, discarded on an escaping error, and inner-catch-and-continue unsupported.
`sessionCore.test.ts`'s queue tests move onto the bound core.

**Composites.** `anchorImportedTake` broadcasts its two frames once, after commit, today by
sending them after `inTxn` returns. Now its body ends by putting the same two frames on the
transaction's queue, after the three suppressed store calls. They flush after commit, before the
lock is released, and never on a rollback: the same frames, payloads and order. The
`event.changed` revision is read inside the body after the last bump, which is the value today's
post-commit read returns.

**Nested `inTxn` joins the outer transaction.** A hub body runs on stores bound to the handle,
and `inTxn` on a bound handle joins.

## D4. Reentrancy, misuse and the deadline

**Explicit handles, not ambient state.** A body never reaches the connection through the hub or
a global: it gets stores built over a core bound to its transaction handle, as 3d's
`CatalogFacade.tx` binds a body's stores to `t`. 7b needs exactly this, because on postgres.js a
statement must go out on the transaction's connection.

**`AsyncLocalStorage` only detects misuse** (A6), as in 3c D4. While a body runs, the hub's
context holds `{ hub, open: true }`; it is set with `als.run`, never `enterWith`. A storage call
on the same hub from inside that context would wait for the lock its own transaction holds, a
deadlock, so step 2 of D3 rejects it with `SessionTxMisuseError` before it queues. Work detached
from a transaction that has since ended (`open: false`) is allowed and simply queues. A call on
a *different* hub is allowed: hubs do not share connections or locks. The lease alarm is armed
outside this context (D6, A11).

**No transaction deadline** (owner, 2026-10-03). 3c had a 10-second deadline because catalog
transaction bodies were route code that could await anything. Hub bodies are package-internal:
they await only their own handle, which resolves in microtasks on SQLite, and the promise-hygiene
scan (D9) now covers session-core. The new hub methods' callbacks (D7) are synchronous by type.
The residual risk is recorded, not fixed: a hub transaction that hangs and never resolves holds
the session's lock and soft-locks that session, since every later call queues forever. ADR 0021's
slice 7 entry carries it as a revisit item (a deadline or a lock-wait timeout).

## D5. The async hub API

- **`SessionHubFacade`:** every storage member returns a promise of today's result type, for
  example `addEvent: (input) => Promise<{ event: EventRpc; projection: SessionProjection }>`.
  `attachSocket`, `detachSocket`, `handleSocketMessage` and `broadcastCommand` stay synchronous;
  they touch no SQL. Members stay property-style function types, so `strictFunctionTypes` still
  checks the class against the facade.
- **New and reshaped hub methods** (D7; each one transaction, each callback synchronous by type
  so it cannot await):
  - `updateEvent({ eventId, category, message, wallTimeUtc, timecodeTotalFrames,
    mergeMetadata })`: `mergeMetadata: (storedMetadataJson: string) => string` replaces
    `metadataJson`. The stored row is read, merged and written in one transaction; a missing
    event returns `null` as today (S3).
  - `addImportedAudioSegment({ sessionId, mimeType, startedAtUtc, endedAtUtc })` returns
    `{ segment, recordingOrdinal }`. It computes the next ordinal with today's
    `nextRecordingOrdinal` rule (the highest segment `recording_ordinal` and internal
    `Recording N Started/Stopped` event number, plus one) and inserts the segment with it, in one
    transaction. The rule moves from `sessions.ts:341` into session-core (S4; the YouTube import
    uses it too).
  - `toggleTake(ctx)` returns `{ state, projection }`: it reads the transport and starts or stops
    the take in one transaction, with exactly the frames `startTake` or `stopTake` emits (S6).
  - `replaceTranscriptWordsRemapped(remap)`: `remap: (events: EventRpc[]) => { words; enrichment }`
    runs on the events read in the same transaction, then the words and enrichment are replaced
    in it. A `remap` that throws (for example the zero-word guard's `no_speech`) rolls back and
    writes nothing (S9).
  - `addEventAtTotalFramesIfAbsent(input)` returns `{ created: false }` or
    `{ created: true, event, projection }`. In one transaction it checks for a non-internal
    event (category compared with JavaScript `toLowerCase()`, as today) with the same
    `timecode_total_frames` and message, and inserts only if there is none (S10). One
    transaction per row keeps today's per-row commits, frames and counts.
- **`SessionHubRegistryFacade`:** `get: (sessionId) => Promise<SessionHubFacade>`.
  `closeUserSockets`, `evictIdle` and `startSweeper` keep their synchronous signatures.
- **The stores and `SessionCore`:** every method that reaches SQL is `async` and awaits each
  statement. Pure helpers (`audioRowToMeta`, `buildPatch`, `eventAnchors`, `audioSeamParts`)
  stay synchronous. `nextOrdinal` becomes async. `presence()` and the socket fan-out stay
  synchronous.
- **Opening.** `SessionHub.open(dbPath, clock): Promise<SessionHub>` replaces the public
  constructor, so no caller can use a hub that has not run `initSchema`. It opens the connection
  and sets the pragmas as today, then, through the lock, runs `initSchema` (root `exec`, DDL in
  autocommit, idempotent) and then `expireIfStale` in a write transaction. If either fails, it
  closes the connection and rejects.
- **The registry's `get`:**
  - the id is checked as today, and a bad id rejects with today's message;
  - an open hub is touched and returned;
  - an id being opened returns the pending promise, so concurrent `get`s open once;
  - otherwise `SessionHub.open` runs, and the hub joins the map only once it is open. A failed
    open leaves nothing behind, and the next `get` tries again;
  - after `closeAll` starts, `get` rejects with `SessionHubClosedError`.

## D6. Lifecycle: eviction, closing, the alarm, a failed rollback

- **In flight.** A call counts as in flight from step 3 to step 6 of D3, so queued calls count
  too. `lastTouchedMs` is set on every call, not only on `get`. A reference used steadily is
  never idle.
- **`evictIdle`** keeps its rule (no sockets, no armed alarm, idle longer than `idleMs`) and adds
  "no call in flight". It removes the hub from the map, then calls `close()` without awaiting
  it, since an idle hub has nothing to drain. It stays synchronous on the facade.
- **`close(): Promise<void>`** (off the facade, as today):
  - it marks the hub closing, so new calls reject with `SessionHubClosedError`;
  - it clears the alarm;
  - it waits for the lock, so calls already admitted finish;
  - it closes the connection.

  It is idempotent and returns the same promise. A call on a closed hub rejects with
  `SessionHubClosedError`, not the raw `TypeError` (A7). Both answer the route's generic `500`,
  as today.
- **`closeAll(): Promise<void>`** marks the registry closed, so `get` rejects. It stops the
  sweeper, waits for hubs still opening, then closes every hub and awaits them. The composition
  root awaits it after `mirror.close()`. `main.ts`'s 5-second failsafe bounds shutdown, as
  today.
- **A failed `ROLLBACK`** (D2): the hub rejects that call, marks itself closed (queued and later
  calls reject with `SessionHubClosedError`), asks the registry to drop it from the map, and
  closes the connection; SQLite rolls back an open transaction when its connection closes. If the
  close itself fails, the error is logged (`[hub] close after failed rollback failed`). The next
  `get` opens a fresh hub. The process keeps serving.
- **Holding a hub across awaits.** Holding a reference across that hub's own calls is safe: each
  call is in flight and touches it. A reference held *idle* for longer than the eviction timeout
  (10 minutes) across a non-hub `await` can find the hub closed. The routes that make such awaits
  already re-resolve afterwards: the events generate delete and `finally`, the YouTube import
  after the download, topics generate after the turn, `generateTranscript`'s `getHub()`, and the
  log-import job's `getHub()`. The comments that say "never hold a hub across an await" are
  reworded to this rule. Its spec form is the AI-tool requirement's delta and the matching
  `ai-topics-chat` delta.
- **The lease alarm** (owner, 2026-10-03):
  - **Armed outside the transaction context.** `LeaseStore` calls `setAlarm` inside a
    transaction body, and a timer armed there would inherit that body's `AsyncLocalStorage`
    context (A11). `armAlarm` therefore arms the timer inside `als.exit(…)`, so the callback runs
    with no transaction context. Fake timers do not propagate `AsyncLocalStorage`, so this is
    covered by a real-timer test (D12).
  - **It runs through the lock** as a write, counted in flight, and does nothing if the hub is
    closing.
  - **On failure it logs and re-arms with a bounded backoff.** The log line is
    `[hub] lease expiry failed; retrying in <ms> ms`. The first retry is after 1 s, each later
    consecutive failure doubles it, and the delay is capped at the lease stale threshold
    (`LeaseStore.LEASE_STALE_MS`, 40 s). A successful run resets the backoff, and the normal
    re-arm from `expireIfStale` takes over. Today a throw from the timer callback is an uncaught
    exception that stops the process. This is a failure-path change with no HTTP effect.
  - An alarm armed inside a transaction that then rolls back stays armed, as today; its expiry
    run re-reads the lease and re-arms or does nothing.

## D7. Callers

**Mechanics.**
- `getSessionHub(c, id)` (`routers/_helpers.ts:20`) becomes `async` and returns
  `Promise<SessionHubFacade>`. Call sites use `const hub = await getSessionHub(c, id)` and then
  `await hub.m(…)`.
- `ReturnType<typeof hub.saveDashboard>` (`aiV2.ts:497`) becomes `Awaited<…>`.
- `nextRecordingOrdinal` (`sessions.ts:341`) is deleted; its rule moves into
  `addImportedAudioSegment` (D5).
- `SessionMirrorDeps.snapshot` returns `Promise<SessionProjection>`. The snapshot call is already
  inside `write`'s `try`, so a failed snapshot only warns, as a failed write does.
- `sessionWs.ts` awaits `get` in the async `createEvents` callback (A12). The socket callbacks
  stay synchronous.
- `ensureTimedTranscript`, `timedTranscriptTokens`, `seamPartsForSession` and the injected
  `getHub` (now `() => Promise<SessionHubFacade>`) become async.

**Resolution and storage call sites** (A15; line numbers as of 5f9684e):

| File | Resolutions | Storage calls |
|---|---|---|
| `server/src/routers/_helpers.ts` | 21 | — |
| `server/src/routers/events.ts` | 103, 144, 158, 166, 173, 181, 193, 233, 466, 516, 597, 655, 695 | 104, 105, 144, 158, 166, 173, 181, 195, 197, 207, 233, 466, 526, 597, 656, 678, 695 |
| `server/src/routers/sessions.ts` | 229, 397, 424, 428, 443, 447, 453, 459, 515, 541, 558, 567, 568, 579, 586 | 229, 343, 348, 397, 424, 433, 443, 447, 453, 459, 515, 546, 558, 567, 568, 579, 586 |
| `server/src/routers/transcribe.ts` | 139, 155, 185, 197, 205, 215, 251, 274, 291, 343, 361, 369 | 139, 185, 197, 205, 215, 251, 275, 292, 306, 307, 314, 343, 361, 369 |
| `server/src/routers/audio.ts` | 179, 200, 211, 232, 246, 312 | 179, 200, 211, 233, 238, 246, 312 |
| `server/src/routers/companion.ts` | 159, 211, 226, 256 | 160, 161, 211, 229, 232 (×2) |
| `server/src/routers/aiV2.ts` | 469, 496, 517 | 470, 499, 518 |
| `server/src/routers/logImport.ts` | 59, 74, 191, 206 | via `log-import` |
| `server/src/routers/exports.ts` | 23 | 23 |
| `server/src/routers/sessionWs.ts` | 23 | — (socket methods only) |
| `server/src/node/config.ts` | 54 | 54 |
| `packages/ai-runtime/src/aiMcpServer.ts` | 738, 753, 769, 800, 889 | 738, 753, 769, 800, 890 |
| `packages/ai-runtime/src/mcpTools.ts` | 124, 154, 173, 199, 236 | 124, 155, 156, 173, 200, 201, 236 |
| `packages/ai-runtime/src/topicGenerate.ts` | 108 | 109 |
| `packages/transcription/src/generateTranscript.ts` | 101, 157, 182 | 101, 157, 182 |
| `packages/log-import/src/runSessionLogImport.ts` | — | 17, 29, 31, 77, 96 |

`companion.ts:256` (`broadcastCommand`) and `sessionWs.ts:28-42` stay synchronous calls on an
awaited hub. `aiTurn.ts` only passes the registry on. `sessions.ts:443` already writes `await`
on today's synchronous call, a no-op that becomes real.

**Multi-call sequences that relied on "nothing interleaves".** Today each is one synchronous block
(apart from the real I/O named). After this change, a sequence that spans several hub calls can
split whenever two handlers resume in one tick (D1, A10); in 7b, on any request.

| # | Site | Sequence | 7a action | Remaining 7a window, and 7b |
|---|---|---|---|---|
| S1 | `events.ts:193-207` GET events | `maybeRelinkOrphans` (write), `listEvents`, `hasAutoGeneratedEvents` | Documented | The page and `has_auto_generated` can come from two committed states when another handler resumes in the same tick |
| S2 | `events.ts:103-105`, `companion.ts:159-161` | `statusLive`, `leaseStatus` | Documented | Transport and lease fields from two committed states, same condition |
| S3 | `events.ts:655-678` PUT event | `getEvent`, merge the stored metadata, `updateEvent` | **Fixed:** `updateEvent` with `mergeMetadata` (D5) | None; two concurrent edits equal a serial order |
| S4 | `sessions.ts:424-459` local import | `nextRecordingOrdinal` (two reads), `addAudioSegment`; blob put; rolling re-check, `anchorImportedTake`, `appendAudioSeamParts` | **Fixed** for the ordinal: `addImportedAudioSegment` (D5) | The rolling re-check and the anchor stay two calls: a take can start between them when another handler resumes in the same tick (as S5) |
| S5 | `sessions.ts:515-588` YouTube import | the same, under the per-session import guard | Ordinal via `addImportedAudioSegment`; the rest documented | Rolling re-check → `anchorImportedTake` window, same condition |
| S6 | `companion.ts:226-232` transport toggle | `transportSnapshot`, then `startTake`/`stopTake` | **Fixed:** `toggleTake` (D5) | None |
| S7 | `audio.ts:232-238` sync | `syncAudioFromBlobs`, `listAudioSegments` | Documented | `has_audio` from a later committed state |
| S8 | `transcribe.ts:273-314` topics generate | `listTopics` before the turn, then after it `listTopics`, `deleteTopics`, `listTopics` | Documented | A manual insert between the after-read and the delete survives; harmless |
| S9 | `generateTranscript.ts:157-182` | `exportEvents` (anchors), remap, `replaceTranscriptWords` | **Fixed:** `replaceTranscriptWordsRemapped` (D5) | None; the remap and the replace see one set of anchors |
| S10 | `runSessionLogImport.ts:77-106` | `exportEvents` (dedupe keys), then `addEventAtTotalFrames` per row | **Fixed:** `addEventAtTotalFramesIfAbsent` per row (D5) | None; per-row commits and the created/skipped counts as today |
| S11 | `events.ts:466,526` generate | word snapshot, `exportEvents` | Documented | The run's word and event snapshots can come from two committed states (accepted snapshot semantics) |
| S12 | `aiMcpServer.ts:856-900` `create_event` | cap check, `createAnchoredEvent`, count | **Fixed** (D8) | None |
| S13 | `aiMcpServer.ts:889-890` `create_event` | anchor read, filter, insert | Already one method, `createAnchoredEvent` | None |

**S10 keeps the sheets-log-import "Duplicate skip" behaviour.** Today `existingKeys` is read once
and grown as rows are created; a later identical row in the same batch is skipped. The per-row
check reads the table inside each row's transaction, so it sees rows this import already created
and skips the same rows, and also sees rows a concurrent import created. The result line
(`Created N, skipped M duplicate(s).`) and the per-row frames are unchanged.

**S3's two `404`s become one.** Today a missing event answers `404 Event not found.` from
`getEvent` or from `updateEvent`; now from `updateEvent` only, with the same body.

`anchorImportedTake` and `appendAudioSeamParts` (S4) are two transactions today; a failure in
the second leaves the anchors. This change keeps that.

**`registry.get` creates the session's `.db` file** on first use, read paths included (for
example a GET on a session whose hub was never opened). That is existing behaviour and unchanged.

## D8. `create_event` reserves its cap before the first `await`

`auto-event-generation` "The create_event handler is await-free" says a change that adds an
`await` there must first move cap reservation into the synchronous prologue. The handler now
awaits `registry.get` and `createAnchoredEvent`, so:
- the counter becomes `{ count: number; reserved: number }`;
- synchronously, before the first `await`, the handler refuses when `count + reserved >= cap` and
  otherwise increments `reserved`;
- after a successful insert it increments `count`; a `finally` decrements `reserved`. A failed
  insert therefore frees its slot, and `createdEvents()` still reports successful inserts only.

The tool's error text, the cap check's position among the other validations, and the
`{created, cap_hit}` response are unchanged. The zero-await test in `aiMcpServer.test.ts`
(`describe('create_event handler — zero-await invariant …')`) becomes a test that the cap check
and the reservation precede the first `await`. The concurrency test ("cap holds under concurrent
calls") runs against a hub whose SQL yields to a timer, so the calls really overlap.

## D9. Promise hygiene widens

`server/src/promiseHygiene.repo.test.ts` already builds the server program, which reaches every
package the server imports.
- **Roots.** The production-file filter adds `packages/session-core/src`,
  `packages/log-import/src`, `packages/transcription/src` and `packages/ai-runtime/src` beside
  `server/src` and `packages/catalog/src`. The test asserts that named key files are scanned
  (`SessionHub.ts`, `sessionCore.ts`, `runSessionLogImport.ts`, `generateTranscript.ts`,
  `aiMcpServer.ts`), so a root that stops being reached fails loudly. The `expect()` check also
  runs over the session-core tests, through a second program from
  `packages/session-core/tsconfig.json`.
- **A new rule: `return await` inside `try`.** A `return <promise>` without `await` inside a
  `try` block that has a `catch` or `finally` is reported (typescript-eslint `return-await`'s
  "in-try-catch" semantics). Without it, the `finally` runs before the promise settles:
  `generateTranscript.ts:182` returns the replace's promise from a `try` whose `finally` releases
  `transcriptGenerationLock`, so once the replace is async the lock would be released before the
  replace commits. The code changes to `return await` (it becomes the S9 method's call).
- **Existing violations** (A16). The widened scan reports three in `aiMcpServer.ts`. The checker
  is not relaxed; the code is reshaped so the same checker passes:
  - `:950` `if (this.startPromise)`: the listener keeps `private started: { promise:
    Promise<void> } | null`, and the check tests the wrapper object, not the promise;
  - `:1112` `singletonPromise ??= (async () => …)()` and `:1127` `if (p !== null)`: the module
    keeps `let singleton: { promise: Promise<AiMcpListener> } | null`. `getAiMcpListener` checks
    the wrapper, stores a new one whose promise clears `singleton` on rejection (only if it is
    still the same wrapper), and `__resetAiMcpListenerForTests` reads and clears the wrapper.
  Behaviour is unchanged: one start for concurrent first callers, a retry after a failed start.
- **Fixtures.** New in-memory fixtures prove it fires through the hub facade:
  - a dropped `hub.addEvent(…)`;
  - `if (!hub.claimLease(id))`, a promise as a condition;
  - `c.json({ topics: hub.listTopics() })`, a promise in a response;
  - `expect(hub.listTopics()).toEqual([])` in a test;
  - `try { return hub.replaceTranscriptWords(w); } finally { lock.release(); }` (reported) and
    the same with `return await` (not reported);
  - the wrapper-object pattern of the `aiMcpServer.ts` reshape (not reported).

## D10. No change for serial requests, and the measurement

- **No `api-contract-freeze` delta.** "Broadcast atomicity with the owning transaction" pins
  observables only: no frame for a rolled-back write, and identical frames on success. D3 keeps
  both, including the composite's frames. For any serial order of requests, status codes,
  bodies, headers and frames do not change.
- **Race-only differences.** Two remain, both only when two handlers resume in one tick:
  - a response built from a documented snapshot sequence (S1, S2, S7, S11) can combine two
    committed states. Each field is still one a serial order produces, and no shape or status
    changes;
  - an import's rolling re-check can pass just before a take starts (S4, S5), as it could already
    when the take started during the blob put.

  The five sequences that wrote from what they read (S3, S4's ordinal, S6, S9, S10) are fixed and
  tested, so none of them can produce an outcome no serial order gives. The freeze pins response
  shapes, statuses and frames, which these races leave unchanged, so this change adds no
  `api-contract-freeze` requirement for them. The panel and the owner can overrule this.
- **Failure paths.** A lease-alarm failure is logged and retried (D6) where today it crashes the
  process. A failed `ROLLBACK` closes the hub (D6) where today the hub kept serving a connection
  inside a dead transaction. Neither has a defined HTTP outcome today.
- **Existing suites pass unchanged.** The session route, WebSocket and companion suites keep
  their expectations. Test code changes only to `await` hub calls it makes directly.
- **Interleaving test, before and after** (tasks 1.2 and 6.1). A new integration test,
  `server/src/routers/sessionHub.interleave.int.test.ts`, has two parts:
  - **The mixed load.** It opens a WebSocket on one session and fires 200 concurrent requests:
    event adds, event updates and deletes on seeded events, transport start/stop, event and status
    GETs, and one event generation through the fake CLI the generate suite uses. It asserts that
    each response's status is the one a serial order gives, that `event.changed` frames arrive
    with strictly increasing revisions ending at the final `events_stream_revision`, and the final
    event set.
  - **The conflicting pairs** (owner decision 1), each fired together through the in-process app
    (`Promise.all` of two requests, so both handlers start in one tick). Whether a pair actually
    splits over HTTP depends on when its catalog replies resolve, so the assertion is written to
    hold either way; the session-core pair tests (D12), on SQL that yields to a timer, are the ones
    that force the split every run. Each asserts a serial-order result:
    - two Companion toggles from a stopped transport: one start and one stop, the transport ends
      stopped;
    - two PUTs of one event: the stored metadata equals one of the two serial orders;
    - two local audio imports: two different consecutive recording ordinals on the segments and
      on the `Recording N` events;
    - a transcript generation (the fake provider `transcribe.int.test.ts` uses) against a local
      import that adds a take: the stored words are remapped against the anchors either before or
      after the take;
    - two log imports of the same sheet (the fake sheet `logImport.int.test.ts` uses): each row
      stored once, and the created counts sum to the distinct rows.

  The mixed load runs on the base commit first (the baseline). The pairs are written in group 5
  with the methods that fix them: on the base they pass only because nothing splits a synchronous
  block, so the after-run is what they guard. The hub also counts, for tests only, the lock
  acquisitions that had to wait; the after-run records that number as data.
- **The benchmark** (`spike/bench7a.mts`) runs the identical sequence before and after: every
  call is awaited (a no-op on today's synchronous values), every run starts from a fresh temp
  directory, and the event count grows the same way, so `addEvent`'s per-call `COUNT(*)` cost is
  equal on both sides. The panel saw a fake 1.8× from comparing runs with different event counts.
- **Stop rule.** Stop and ask the owner if any existing route or WebSocket expectation has to
  change, if the mixed load's observables differ from the baseline, if a conflicting pair's result
  matches no serial order, or if the benchmark's per-call median is more than 2× slower than
  task 1.3's.

## D11. ADR 0021: the slice 7 entry and the 7b hazards

Slice 7's line becomes an entry in the slice 3 style:
- the 7a/7b/7c split and the owner decisions (proposal "Owner decisions", design "Owner
  decisions after the panel");
- 7a's mechanism in one paragraph (the lock, reads included; the per-transaction queue; joins;
  misuse; the five atomic methods; a failed `ROLLBACK` closes the hub; the alarm's backoff);
- **revisit (owner, 2026-10-03):** a hub transaction that hangs and never resolves holds the
  session's lock and soft-locks that session (every later call queues forever); revisit a
  deadline or a lock-wait timeout;
- **7b hazards** (live once session statements do I/O):
  1. the spec's observables (core-ports delta) must hold without the embedded lock: every write
     transaction takes the `sessions` row lock first, and a multi-statement read needs one snapshot
     (one statement, or a `REPEATABLE READ` read transaction);
  2. broadcast flush order versus commit order across two transactions on one session (keep a
     per-session ordering gate, or order frames by revision);
  3. the documented sequences S1, S2, S5, S7, S8 and S11 of design D7, which split on any
     request once statements do I/O;
  4. a hub body re-run after a `40001` retry must have only database effects: drop the held
     broadcasts per attempt; `setAlarm` inside the lease bodies re-arms on every run (harmless,
     one slot); the D5 callbacks (`mergeMetadata`, `remap`) must stay pure;
  5. a `create_event` insert still in flight when its turn ends is not counted in `created`;
  6. the registry stops owning connections: eviction, `open()`, `.db` creation on read paths and
     the failed-rollback close change meaning, and the adapter sets the unconfirmed-rollback
     policy;
  7. the mirror chain retires (slice 4 hazards 3, 4 and 17, and the `live_revision` follow-up);
- slice 4 hazard 7 ("never hold a session hub across an await") is struck through and points to
  7a's rule (D6).

## D12. Tests

- **session-core (about 151 tests):** every test awaits its hub, store and core calls. Assertions
  are unchanged except:
  - `new SessionHub(path)` becomes `await SessionHub.open(path)` (32 sites in
    `SessionHub.test.ts`, 2 in `fakeClock.test.ts`);
  - `sessionSql.test.ts`'s "throws" becomes "rejects";
  - **the nested-transaction tests** (`SessionHub.test.ts:338-372`) call the public
    `hub.addEvent` inside `inTxn`, which D4 now rejects. They are rewritten so the inner write goes
    through the transaction-bound stores (`t.events.addEvent`) or a joined `t.tx`, and keep their
    assertions (flush at the outermost commit only; an outer failure drops the inner frames and
    rows);
  - `withBroadcastsHeld`'s tests run on a transaction-bound core (D3);
  - the store tests for `updateEvent` pass a `mergeMetadata` that returns their old
    `metadataJson`.
- **New session-core tests** (`SessionHub.concurrency.test.ts`, written first; they run on a hub
  whose SQL yields to a timer between statements, so calls really overlap):
  - two writes on one hub serialize, and the broadcast order equals the commit order;
  - a read issued during a write resolves after it, with the committed state, or the prior state
    after a rollback;
  - a body that throws after awaiting rolls back and drops its broadcasts; a body that catches a
    statement error still rolls back;
  - a nested `inTxn` joins: an inner failure rolls back the outer writes;
  - a hub delegate (`hub.addEvent`) called inside `inTxn` rejects with `SessionTxMisuseError`
    promptly (raced against a 200 ms timer), with no deadlock, and the outer transaction can
    still commit its own writes; a call on another hub succeeds;
  - a relayed command (`handleSocketMessage`) during an open transaction is sent at once and
    survives the transaction's rollback;
  - each D5 method against its conflicting twin, fired together: two `toggleTake`s, two
    `updateEvent`s with merges, two `addImportedAudioSegment`s, `replaceTranscriptWordsRemapped`
    against `anchorImportedTake`, two `addEventAtTotalFramesIfAbsent` for the same row; each
    result equals a serial order;
  - `evictIdle` skips a hub with a call in flight or queued, and closes it once idle;
  - `close()` lets admitted calls finish and rejects new ones with `SessionHubClosedError`;
  - concurrent `get`s for one id open once; a failed open leaves nothing and the next `get`
    retries; `get` after `closeAll` rejects;
  - a failed `ROLLBACK` (injected through the test SQL) rejects that call, rejects the queued
    ones with `SessionHubClosedError`, drops the hub from the registry, and the next `get` opens a
    fresh hub that works.
- **New lease-alarm tests** (`SessionHub.alarm.test.ts`):
  - **real timers:** a hub on a temp file with an injected clock. A lease is claimed at clock
    `T`; the clock moves to `T + 39,990` and the hub is reopened, so `expireIfStale` re-arms the
    alarm about 10 ms ahead; the clock moves past `T + 40,000`; within 500 ms of real time the
    holder is cleared and `lease.changed` is sent. It also asserts the callback ran with no
    transaction context (it was armed inside `als.exit`, A11);
  - **backoff:** with a test SQL whose alarm transaction fails twice, the alarm logs and re-arms
    after 1 s and then 2 s, succeeds on the third run, and resets; a run of failures stops
    doubling at 40 s (fake timers are fine here, since only the delays are checked).
- **server and packages:** about 20 test files that call hubs directly await them. The
  integration suite's session tests pass unchanged (D10). `eventsGenerateWindow.test.ts` anchors
  its window after the awaited snapshot statement. The `create_event` tests change as D8 says.
  The log-import, transcription and companion tests cover the new methods through their callers.
- **Repo tests:** promise hygiene (D9) with the new rule and fixtures.

## Risks / Trade-offs

- [A missed `await` turns a value into a promise that type-checks somewhere loose, for example a
  `JSON.stringify` or a template] → the promise-hygiene scan (D9) catches conditions, responses,
  templates, dropped calls and un-awaited returns in `try`, across every hub-calling root; the
  route suites check bodies.
- [A multi-call sequence not in D7's table splits when two handlers resume in one tick] → D7's
  table came from the full call-site list (A15), and the panel re-checked it; anything found later
  becomes a hub method, as S3-S10 did.
- [The documented sequences S1, S2, S5, S7, S8, S11 can combine two committed states] → race-only
  and shape-preserving (D10); 7b hazard 3.
- [A body calls its own hub and deadlocks] → rejected before queueing (D4), with a test.
- [A hub transaction that never resolves soft-locks its session: every later call on it queues
  forever] → accepted for 7a (owner, 2026-10-03): bodies await only their own SQL and callbacks
  are synchronous by type; ADR 0021 carries a revisit item for a deadline or a lock-wait timeout.
- [Every hub call is slower by a lock hand-off and a few microtasks] → measured (tasks 1.3 and
  6.1); stop rule in D10.
- [The failure-path behaviours change (alarm failure logged and retried, a failed `ROLLBACK`
  closes the hub, `SessionHubClosedError` replaces a `TypeError`)] → all are crash or `500` paths
  today; listed for the approver.
- [The per-transaction queue changes which frames a transaction holds] → only a frame issued
  outside the hub's transaction; covered by a test.
- [Large mechanical diff across 15 production files and about 30 test files] → groups land
  green one at a time (tasks.md), and the panel checks D7's table against the code.

## Migration Plan

No data, schema or configuration change. Deploy is the new image; rollback is the previous
image. Per-session `.db` files are untouched and read identically by both.

## Open Questions

None. The four questions the panel round raised were decided by the owner (design "Owner
decisions after the panel").
