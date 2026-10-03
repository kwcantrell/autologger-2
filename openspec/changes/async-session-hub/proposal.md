# Async session hub: the session hub goes async on SQLite, serialized per session

Tier: 2
Tier reason: concurrency (the session hub's whole concurrency model moves from "a synchronous
body cannot interleave" to a per-session lock, an explicit transaction protocol and five new
atomic hub methods), a
storage port contract (`SessionSql` and the `SessionHubFacade`/`SessionHubRegistryFacade`
interfaces), process lifecycle (hub open, eviction and shutdown), and this repo's ports spec;
touches `server/src/routers/**` (a high-risk path) in 10 routers. ADR 0021 slice 7a.

Approved-by: Kalen 2026-10-03

## Why

`SessionHub` is the last synchronous storage seam. Its concurrency model rests on better-sqlite3
being synchronous: RPC bodies contain zero `await`s, `inTxn` is
`withBroadcastsHeld(db.transaction(fn))`, and broadcasts flush only after the commit returns
(`packages/session-core/src/SessionHub.ts:5-9`, `:353-364`). The `core-ports-architecture`
requirement "Session runtime is a synchronous, substitutable port" pins this. Slice 7 moves the
session tables to Postgres, where every statement is I/O, so the call graph has to go async
first. Converting it while the store is still SQLite keeps 7b's diff to storage alone, as slice 3
did for the catalog (3a-3d before 4a-4e).

## Owner decisions (owner, 2026-10-03)

The owner split ADR 0021 slice 7 into three changes, async first (plan of record
`parsed-honking-lobster.md`):
1. **7a `async-session-hub` (this change):** the hub goes async, still on SQLite, with no
   HTTP or WebSocket change for serial requests.
2. **7b:** the session tables in Postgres schema `catalog`, ported faithfully as 4a ported the
   catalog; the postgres.js session adapter and the wiring; the `sessions` projection written
   inside the hub's write transaction, retiring the mirror chain (ADR 0021 slice 4 hazards 3, 4
   and 17, and the `live_revision` follow-up); row-level security on the content tables.
3. **7c:** `sessions.revision`, per-row versions, opt-in version checks (a request without a
   version keeps today's last-writer-wins), `409` with the current row, the overwrite dialog and
   the audit. A contract delta; Companion routes stay unchecked.

Further owner decisions that bind 7b and 7c, recorded in ADR 0021 by this change: per-row
versions, opt-in checks, and a faithful port.

## After the adversarial panel (owner, 2026-10-03)

The owner decided the design's open questions after the three-reviewer panel:
1. **Fix the five read-then-write sequences in 7a.** The panel showed the original premise wrong:
   under a per-call lock, two handlers that resume in the same tick alternate between their hub
   calls (two same-tick Companion toggles started the take twice and left it rolling). Each
   sequence becomes one hub method, tested by firing the conflicting pair at once (design D7):
   - S3: the PUT event metadata merge moves inside `updateEvent`'s transaction;
   - S4: the import's recording-ordinal read and the segment insert become one method;
   - S6: a new `toggleTake()`, used by the Companion transport toggle;
   - S9: transcript generation's anchors read, remap and replace become one method;
   - S10: the log import's duplicate check and insert become one method per row, keeping
     today's per-row commits and counts.

   The remaining sequences (S1, S2, S5, S7, S8, S11) are snapshots or windows; design D7 states
   their 7a window and ADR 0021 carries them as 7b hazards.
2. **No transaction deadline.** ADR 0021 records a revisit item: a hub transaction that hangs
   holds the session's lock and soft-locks that session.
3. **A failed lease alarm logs and re-arms** with a backoff doubling from 1 s, capped at the lease
   stale threshold (40 s).
4. **The spec states observables only.** Whether 7b keeps an in-process lock is 7b's choice.

Panel fixes, folded in without a scope change:
- The `core-ports-architecture` requirement states observables (no dirty read, broadcasts in
  commit order, atomic read-then-write methods, no self-deadlock, a named error on a closed hub),
  not 7a's lock, FIFO order, single-flight open or eviction (design D3 keeps those as 7a facts).
- A failed `ROLLBACK` no longer stops the server: it rejects the call and closes the hub, and the
  next `get` reopens a fresh connection. The fatal or retire policy is 7b's adapter's (design D2,
  D6).
- The spike and the benchmark are pinned in this change (`spike/spike7a.mjs`,
  `spike/bench7a.mts`). The benchmark runs the identical sequence before and after.
- The nested-transaction tests that call a public hub method inside `inTxn` are rewritten, and a
  test pins that such a call rejects without deadlock (design D12).
- The lease alarm is armed outside the transaction's async context and has a real-timer test
  (design D6, D12).
- Promise hygiene reports `return <promise>` without `await` inside a `try` with a `catch` or
  `finally` (`generateTranscript.ts` would otherwise release its lock before the replace
  commits). Three existing violations in `aiMcpServer.ts` are fixed by reshaping that code, not
  by relaxing the check (design D9).
- `ai-topics-chat` gets the same hub-at-call-time wording as `core-ports-architecture`.

## For the approver

- **Race-only response differences remain for the documented snapshots** (design D10). For any
  serial order of requests nothing changes. When two handlers resume in one tick, a response
  built from S1, S2, S7 or S11 can combine two committed states. No shape, status or frame
  changes, so there is no `api-contract-freeze` delta.
- **Three failure paths change, none observable over HTTP** (design D6):
  - a lease-alarm failure is logged and retried instead of crashing the process;
  - a failed `ROLLBACK` closes the hub instead of leaving it serving a connection inside a dead
    transaction;
  - a call on a closed hub rejects with `SessionHubClosedError` instead of a `TypeError` (both
    a `500`).
- **The broadcast queue moves from the hub to the transaction** (design D3). Its contract is
  unchanged. A frame issued outside the transaction (a relayed Companion command) is no longer
  held by it.
- **Four requirements are removed and re-added instead of modified** (Capabilities), because
  OpenSpec will not drop a scenario from a MODIFIED block and their synchronous scenarios cannot
  stay.

## What Changes

- **An async SQL seam** (design D2). `SessionSql`'s `all`, `run` and `exec` return promises, and
  `tx(fn)` passes its body a handle scoped to the transaction. A `tx` on that handle joins the
  enclosing transaction (no savepoint), and any error inside the transaction fails all of it.
  The SQLite adapter (`sqliteSessionSql`) runs `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` on the
  hub's better-sqlite3 connection, because `db.transaction(fn)` refuses an async `fn`. Only the
  adapter wraps synchronous calls in promises.
- **Per-session serialization** (design D3, D4). Each hub owns one FIFO lock, and every storage
  call takes it, reads included, one at a time per session in arrival order. A write runs
  `BEGIN → body → COMMIT → flush broadcasts` before it releases the lock; a read runs its
  statements under the lock without a transaction. A write's broadcasts flush in enqueue order
  after its commit and before the next call on that session starts; a failed call discards them. The
  broadcast queue belongs to the transaction, so a Companion command relayed from a socket is
  never held or dropped by someone else's transaction. A hub method called from inside its own
  hub's transaction rejects at once instead of deadlocking.
- **Five read-then-write sequences become single hub methods** (design D5, D7):
  `updateEvent` merges the stored metadata in its transaction, `addImportedAudioSegment` picks
  the recording ordinal and inserts the segment, `toggleTake` reads the transport and starts or
  stops the take, `replaceTranscriptWordsRemapped` reads the anchors, remaps and replaces, and
  `addEventAtTotalFramesIfAbsent` checks for a duplicate and inserts one imported row.
- **An async hub API** (design D5).
  - Every `SessionHubFacade` storage method returns a promise. The socket methods
    (`attachSocket`, `detachSocket`, `handleSocketMessage`, `broadcastCommand`, and the
    registry's `closeUserSockets`) stay synchronous.
  - The seven stores and the `SessionCore` helpers become async.
  - Opening moves out of the constructor: `SessionHub.open(path, clock)` runs `initSchema` and
    the stale-lease cleanup through the lock. `SessionHubRegistry.get(id)` returns
    `Promise<SessionHubFacade>`, and concurrent `get`s for one id share one opening.
- **Hub lifecycle** (design D6).
  - Every call counts as in flight and touches the hub. `evictIdle` skips a hub with a call in
    flight or queued, and a call on a closed hub rejects with `SessionHubClosedError` instead of
    a raw better-sqlite3 `TypeError`.
  - `closeAll` (shutdown) refuses new `get`s and waits for queued calls to finish.
  - The lease alarm is armed outside any transaction's context, runs through the lock, and on
    failure logs and re-arms with a backoff (1 s doubling, capped at 40 s).
  - A failed `ROLLBACK` rejects the call and closes the hub; the next `get` opens a fresh one.
- **Callers await** (design D7). 75 hub resolutions and 87 storage calls in 10 routers,
  `server/src/node/config.ts` (the `SessionMirror` snapshot), `server/src/sessionMirror.ts`, and
  five package files: `log-import/runSessionLogImport.ts`,
  `transcription/generateTranscript.ts`, and `ai-runtime`'s `aiMcpServer.ts`, `mcpTools.ts`
  and `topicGenerate.ts`. The WebSocket route resolves its hub in the upgrade's async
  `createEvents` callback.
- **The `create_event` cap is reserved before the first `await`** (design D8). The handler can no
  longer be await-free, so the cap check and a reservation run synchronously first, as the
  `auto-event-generation` spec requires before any `await` enters that handler. A failed insert
  releases its reservation. The created count still counts successful inserts only.
- **The hub-across-await rule is rewritten** (design D6, D7). Holding a hub across its own calls
  is allowed. A reference held idle across a long non-hub `await` (an AI turn, a download) is
  re-resolved afterwards, as the routes already do. The comments that say "never hold a hub
  across an await" are reworded to say this.
- **Promise hygiene widens** (design D9). `server/src/promiseHygiene.repo.test.ts` also scans the
  production sources of `packages/session-core`, `log-import`, `transcription` and
  `ai-runtime`, and checks `expect()` in the session-core tests, with mutation fixtures for the
  new roots. It also reports a `return <promise>` without `await` inside a `try` that has a
  `catch` or `finally`. Three existing violations in `aiMcpServer.ts` are fixed by reshaping that
  code.
- **No change for serial requests** (design D1, D10). Status codes, bodies, headers and
  WebSocket frames stay byte-identical for any serial order of requests, and the existing route
  and WebSocket suites pass without changed expectations. Requests whose handlers resume in
  different ticks still do not interleave. Handlers that resume in the same tick can alternate
  between hub calls, which is why the five sequences above become single methods. A new
  integration test fires a mixed concurrent load at one session (frame order, final state, before
  and after) and each conflicting pair at once (a serial-order result).
- **Docs:** ADR 0021 gains the slice 7 entry: the 7a/7b/7c split, the owner decisions, the 7a
  notes, the deadline revisit item, and a hazard list for 7b in the slice 3 style (design D11).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `core-ports-architecture`:
  - REMOVED "Session runtime is a synchronous, substitutable port", and ADDED "Session runtime
    is an asynchronous, per-session serialized, substitutable port" in its place: the async
    seam and its transaction contract, plus observables only (no dirty read, broadcasts in commit
    order, atomic read-then-write hub methods with a serial-order scenario for each of the five
    pairs, no self-deadlock, a named error on a closed hub). It keeps the old requirement's seam
    scenarios. (OpenSpec
    refuses a MODIFIED block that drops a scenario, and "Hub methods contain no awaits" cannot
    stay.)
  - MODIFIED "Persistence facades are consumed through package-exported interfaces": the
    registry's `get` resolves to the hub facade.
  - MODIFIED "AI tool bodies consume the session facade directly; no tool port is interposed":
    tool bodies still resolve the hub at call time, and may use it across that invocation's own
    hub calls.
  - MODIFIED "Server code never drops or misuses a promise": the scan covers session-core and
    the hub-calling packages, reports an un-awaited promise returned inside `try`, and the
    event-generation window starts once the snapshot read resolves.
- `ai-topics-chat`: MODIFIED "Session-scoped MCP toolset": `create_topic` resolves the hub at
  call time with the same wording as `core-ports-architecture`.
- `auto-event-generation`:
  - REMOVED "Anchored event insert is transactional", ADDED "Anchored event insert is one
    serialized transaction": the per-session order replaces "zero `await`".
  - REMOVED "The create_event handler is await-free", ADDED "The create_event cap is reserved
    before any await", as the removed requirement asked of any change adding an `await`.
- `youtube-audio-import`: REMOVED "Downloaded audio is ingested as a single supported-container
  segment", ADDED "Downloaded audio is ingested as one supported-container segment through a
  transactional hub RPC": the same text, with a transactional hub RPC instead of a synchronous
  one.
- `transcript-generation`: MODIFIED "Regeneration replaces the transcript atomically", "Failure
  mapping", and "Enrichment persistence and internal read": the synchronous wording goes, and
  the remap runs inside the replace transaction against the anchors it reads; the
  single-transaction replace, the router-side provider pipeline and the re-acquire after a long
  `await` stay.
- `topic-generation`: MODIFIED "One-shot transcript delivery is paged, complete, and
  snapshot-stable": the word list is captured once, before the turn registers, instead of
  "synchronously, before any `await`".

`api-contract-freeze` needs no delta (design D10): "Broadcast atomicity with the owning
transaction" holds unchanged, nothing changes for serial requests, and the remaining race-only
snapshot combinations change no shape, status or frame. `sheets-log-import` "Duplicate skip"
holds unchanged under the per-row check (design D7).

## Non-goals

- **Postgres session tables, the session adapter, the projection inside the write transaction,
  retiring the mirror chain, RLS on content tables** (7b).
- **Revisions, version checks, `409`s, the overwrite dialog, the audit** (7c).
- **Making the snapshot sequences S1, S2, S5, S7, S8 and S11 atomic** (design D7). They are
  documented with their 7a window, and ADR 0021 carries them as 7b hazards.
- **A transaction deadline** (owner, 2026-10-03). Bodies await only the hub's own SQL (design
  D4); ADR 0021 records a revisit item.
- **Any change to the hub's SQL, schema, or the per-session database files.** `registry.get`
  still creates a session's `.db` file on first use, read paths included.
- **Session leases (slice 8), Realtime (slice 9), blobs (slice 10).**
- **New runtime dependencies.** `AsyncLocalStorage` is Node's own.

## Impact

- **Code:**
  - `packages/session-core/src`: `sessionCore.ts`, `SessionHub.ts`, the seven stores,
    `storeHelpers.ts`, `index.ts`, and their tests, plus `test/fakeCore.ts`;
  - `server/src/routers`: `_helpers.ts`, `events.ts`, `sessions.ts`, `companion.ts`,
    `transcribe.ts`, `audio.ts`, `aiV2.ts`, `logImport.ts`, `exports.ts`, `sessionWs.ts`;
  - `server/src/node/config.ts`, `server/src/sessionMirror.ts`;
  - packages: `log-import/src/runSessionLogImport.ts`,
    `transcription/src/generateTranscript.ts`,
    `ai-runtime/src/{aiMcpServer,mcpTools,topicGenerate}.ts`;
  - tests: about 151 session-core tests become async, with unchanged assertions except where
    design D12 says otherwise; about 20 server and package test files that call hubs directly; a
    new interleaving integration test; `promiseHygiene.repo.test.ts`;
    `eventsGenerateWindow.test.ts`; the `create_event` zero-await test in `aiMcpServer.test.ts`.
- **Specs:** the deltas above; no `api-contract-freeze` delta.
- **ADR 0021:** the slice 7 entry.
- **Operators:** nothing new. No env var, no migration, no data change. Two new log lines can
  appear: `[hub] lease expiry failed; retrying in <ms> ms` and `[hub] close after failed rollback
  failed`.
- **Performance:** every hub call adds a few microtasks and a lock hand-off. The hub's SQL does
  not change. Design D10 states the stop rule.

## After merge

These are outside tasks.md, because they need the merged branch or `make stage-up` permission:
- **Dev live check** (`make dev-up`, then the app in a browser and a second tab):
  - log events and edit them; the second tab gets the `event.changed` refresh;
  - start and stop takes;
  - Companion log, transport toggle and a relayed command;
  - generate topics and events;
  - a local audio import;
  - the app log shows no `SessionHubClosedError`, `SessionTxMisuseError` or unhandled rejection.
- **Stage live check**, with the owner's permission for `make stage-up`: the same walk-through.
- **Prod:** prod runs `main` until slice 11's cutover, so no prod step here.
