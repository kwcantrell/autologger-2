# Design: session-content-policies

## Context

See proposal.md for why. The current state this design changes:

- **The binding.** The composition root builds one session storage over one system handle:
  `new PostgresSessionDb(catalogDb.bindSystem('session-hub'))` and
  `new SessionHubRegistry({ storage: (id) => sessions.forSession(id), clock })`
  (`server/src/node/config.ts:54-58`). `PostgresSessionDb` (`packages/storage/src/postgresSessionSql.ts`,
  48 lines) holds that one handle; `forSession(id)` returns `{ tx, snapshot }` over
  `handle.sessionTx` and `handle.snapshot` (`postgresCatalogStore.ts:836-867`).
- **The hub** (`packages/session-core/src/SessionHub.ts`): the constructor pins one
  `SessionStorage` (`:445-456`); `open` seeds and runs `expireIfStale` in one write (`:461-481`);
  every storage call goes through `call(mode, body)` (`:488-512`) under the per-hub `FifoLock`;
  writes run `transaction()` (`:534-565`), which writes the projection before `COMMIT`
  (`sessionCore.ts:231-251`, `SessionProjectionError` unless one row changed); `runAlarm`
  (`:604-618`) runs `expireIfStale` through the same path. Hubs are cached and shared by every
  caller of a session (`SessionHubRegistry`, `:1092-1187`), so a binding cannot be per hub.
- **The seam** (`sessionCore.ts:27-41`): `SessionStorage.tx(fn)` / `snapshot(fn)` carry no
  caller. Storage redeclares the shape structurally (L1 siblings, package-architecture).
- **The adapter** (`postgresCatalogStore.ts`): `Binding` and `PREAMBLE` (`:194-210`) set
  `role` and `app.user_id` per transaction; `LOCK_SESSION` (`:161`) is pipelined with `BEGIN` and
  the preamble; a zero-row lock raises `SessionNotFoundError` without running the body
  (`:652-690`); `bindUser` (`:423`) returns `CatalogDb` (no `sessionTx`/`snapshot`), `bindSystem`
  (`:432`) the concrete `PostgresBoundHandle`. The port `CatalogRoot.bindUser` returns `CatalogDb`
  (`packages/ports/src/catalogDb.ts:29`). Errors: `CatalogForbiddenError` (`catalogErrors.ts:25`),
  `SessionNotFoundError` (`:46`).
- **The policies** (`supabase/migrations/20261007000000_catalog_policies.sql`): seven definer
  helpers (`:23-93`; owner `postgres`, `search_path = pg_catalog, pg_temp`, `enable_seqscan = off`,
  EXECUTE to `catalog_user` only); `sessions_user_select` uses `member_shows`, `sessions_user_update`
  `accessible_shows` (`:197-208`). The session tables have `_system_all` only and `catalog_user`'s
  privileges revoked (`20261008000000_session_tables.sql:131-143`).
- **The callers.** Every `/api/sessions/:id/*` route resolves its hub through `getSessionHub(c, id)`
  after `requireSession` (`server/src/routers/_helpers.ts:23-71`), which ignores the user. The
  Companion routes run token-only calls as `system('companion-token')` (`companion.ts:92-98`); a
  signed-in caller who cannot see the active session gets `409` from `categories`/`log`/
  `transport`/`command` (`requireActiveSession`, `:106-115`) and the masked `200` from `state`
  (`:146-160`; api-contract-freeze `spec.md:1604-1613`). AI tool bodies resolve the hub at call time
  (`aiMcpServer.ts:748-904`, `mcpTools.ts:125-237`); `registerTurn(sessionId, context)`
  (`aiMcpServer.ts:1013`) records no user; `aiTurn.ts:137` registers; aiV2 builds
  `buildAggregateMcpServer(sessionId, registry, …)` with `principalUserId` in scope
  (`aiV2.ts:260-315`); `generateTopicsTurn` resolves its hub (`topicGenerate.ts:107`). Transcript
  generation takes a `getHub` closure (`generateTranscript.ts:70`; `transcribe.ts:155`). The
  log-import job is detached (`logImport.ts:156-232`), builds `system('log-import-job')` for catalog
  reads, re-checks the creator per sheet (`:173`), and resolves hubs with
  `env.ports.sessions.get(sessionId)` (`:191`). `server/scripts/merge-session-audio.ts:62-68` uses
  `bindSystem('session-hub')`.
- **Undo steps** (owner decision P1): `audio.ts:212-216` (upload put failure),
  `sessions.ts:360-367` (`rollbackLocalAudioImportSegment`), `sessions.ts:411-414` (local put failure),
  `sessions.ts:527-531`, `:540-543`, `:555-563` (YouTube put failure, final guard, anchor failure),
  and `events.ts:594-598` (the regenerate's delete of the prior auto-generated snapshot after the
  turn created replacements). The YouTube route wraps any non-`ApiError` into `502`
  (`sessions.ts:586-594`).
- **The reviewed bindings** (`server/src/catalogSystem.repo.test.ts`): the scan matches
  `\.(?:system|bindSystem)\(` in `server/src` and `packages/*/src` production files against
  `ALLOWLIST` (which has `{ server/src/node/config.ts, session-hub }`), exempts the `IMPLEMENTING`
  files, and allows `.forUser(`/`.bindUser(` only in the auth middleware.
- **The 7b-1 hand-off** (session-tables design D2 "Constraints this leaves for 7b-2", D14; ADR 0021
  slice 7): the binding passed per call through the seam; the lock and projection under the
  caller's policy with missing access told apart from a missing session and answered as the
  routes already answer it; reviewed bindings for writers with no caller.

## Owner decisions

See proposal.md "Owner decisions (owner, 2026-10-03)": full show access on all nine tables; AI
turns and the log-import job run as their user; `session_exists` tells no access from no session;
one change. And "Owner decisions after the panel": P1, undo steps run as `session-undo` (D7); P2,
disabled accounts are out of scope (Non-goals, Risks).

## Goals / Non-Goals

**Goals:**
- The database refuses session content to a user without show access on every user-bound path,
  with the app's gate still deciding first. The exception is token-only Companion calls, which run
  as the system task `companion-token` for any session id until slice 9's credential.
- Every hub storage call runs under its caller's binding, chosen per call; no hub call is unbound.
- No status, body or frame changes for a request a serial order can produce; a racing request gets
  the answer the serial order "revoke, then request" gives, and leaves nothing it wrote.
- Every system session caller is reviewed like a system catalog binding.

**Non-Goals:**
- Changing the `sessions` row rules, the app's gates, or the Companion credential (slice 9).
- Disabled accounts (P2, proposal Non-goals).
- Making the remaining 7a snapshot sequences atomic (they stay as session-tables D13 left them).

## Assumptions and evidence

Two spikes are pinned in this change, each running the draft migration
`spike/20261009000000_session_content_policies.sql` and its probes inside one transaction that ends
in `ROLLBACK` against the dev database, with the command in its header (`{ echo 'begin; set local
role postgres;'; cat <draft> <spike>; } | docker exec -i autologger-dev-db-1 psql -U supabase_admin
-d postgres -X -v ON_ERROR_STOP=0`; the superuser only switches roles: the draft runs as `postgres`,
each probe as `catalog_user` or `catalog_system`):
- `spike/spike7b2.sql`: the fixture session `005e2862…` (show `show-autolog-test`, team
  `test-studios`) with five actors: its team owner; three members it creates (a grant, a
  `can_write = 0` grant, no grant); an outsider id with no membership. Log `spike7b2.log`.
- `spike/scale7b2.sql`: three policy forms at 300, 3,000 and 20,000 sessions in the owner's show
  (panel finding 4), each statement run twice under `explain (analyze, summary)`, the second
  reported (planning plus execution). Log `scale7b2.log`.

| # | Assumption | Command | Observed |
|---|---|---|---|
| A1 | The draft applies in the 6b-2 pattern: the helper owned by `postgres`, definer, pinned config, EXECUTE for `catalog_user` only; nine new policies, 32 `catalog_user` policies in all | `spike7b2.sql` A1 | `session_exists\|postgres\|t\|{"search_path=pg_catalog, pg_temp",enable_seqscan=off}\|t\|f\|f\|f`; `9\|9`; `32` |
| A2 | Per actor: sees the session row, locks it under the user binding, sees its events, inserts content, the projection statement's rows, the snapshot probe, `session_exists` | `spike7b2.sql` A2-A5 (row seen, events seen; locked; insert; meta update; projection; probe, exists real, exists missing) | owner `1\|5`, `1`, `INSERT 0 1`, `UPDATE 3`, `UPDATE 1`, `t\|t\|f`; granted the same; `can_write = 0` grant the same; member without a grant `1\|0`, `0`, `ERROR: new row violates row-level security policy for table "session_meta"`, `UPDATE 0`, `UPDATE 0`, `f\|t\|f`; outsider `0\|0`, `0`, the same error, `UPDATE 0`, `UPDATE 0`, `f\|t\|f` |
| A3 | A read-only snapshot cannot take `FOR SHARE`, so the read check is a probe, not a lock | `spike7b2.sql` A3 | `ERROR: 25006: cannot execute SELECT FOR SHARE in a read-only transaction` |
| A4 | A refused insert is `42501`, and an insert for a session id that does not exist is refused by the policy before the foreign key | `spike7b2.sql` A4 (with `\set VERBOSITY verbose` in a re-run) | `ERROR: 42501: new row violates row-level security policy for table "session_meta"` |
| A5 | The 7b-1 projection statement (session-tables D8) changes one row exactly when the lock succeeds | A2's projection column | `UPDATE 1` for the three actors that lock, `UPDATE 0` for the two that do not |
| A6 | The chosen policy form (`exists` on `sessions` by primary key against `accessible_shows`) is flat in the number of accessible sessions; the first draft's set form (`session_id in (select accessible_sessions(uid))`) is linear; a per-row definer boolean is flat but slow per row | `scale7b2.sql`, ms at 300 / 3,000 / 20,000 sessions | one-row `session_meta` insert: exists `0.45 / 0.45 / 0.46`, set `0.54 / 1.70 / 9.27`, definer `0.35 / 0.36 / 0.35`; 200-row events read plus count (250 events): exists `0.65 / 2.03 / 1.18`, set `1.00 / 3.31 / 18.27`, definer `28.44 / 28.25 / 28.36`; 31,621-row words insert: exists `237.7 / 251.3 / 241.5`, set `190.7 / 199.6 / 196.4`, definer `1949 / 1950 / 1954`. The first run of the spike measured the same shape (exists insert 0.44-0.45, set 0.51-9.11) |
| A7 | The hub's own storage calls are the open and the alarm; eviction, close and socket members send no statement | `grep -n "inTxn\|this.read(\|storage\." packages/session-core/src/SessionHub.ts \| sed -n 1,12p`; read `close` and `evictIdle` | `:472 await hub.inTxn(…)` (open), `:503 this.storage.snapshot(…)`, `:542 this.storage.tx(…)`, `:607 await this.inTxn((s) => s.lease.expireIfStale())` (alarm), then the public RPCs (`:714 this.read(…)`, `:719 this.inTxn(…)`, …); `close` (`:642`) runs `this.lock.run(() => undefined)`; `evictIdle` (`:1157`) reads only counters |
| A8 | Every production hub resolution is in these files; the router sites all go through `getSessionHub` | `grep -rn "getSessionHub(\|ports.sessions.get(\|sessions\.get(\|registry\.get(" server/src packages/*/src server/scripts --include=*.ts \| grep -v "test" \| cut -d: -f1 \| sort \| uniq -c` | `aiMcpServer.ts 6`, `mcpTools.ts 6`, `topicGenerate.ts 1`, `SessionHub.ts 2` (comments), `aiV2.ts 3`, `audio.ts 6`, `companion.ts 4`, `events.ts 13`, `exports.ts 1`, `_helpers.ts 2`, `logImport.ts 1`, `sessions.ts 15`, `sessionWs.ts 1`, `transcribe.ts 12` |
| A9 | The session create's hub call only instantiates the hub; its result is unused | `grep -n "ensure()" server/src/routers/*.ts \| grep -v test` | `sessions.ts:230: await (await getSessionHub(c, created.id)).ensure();` |
| A10 | The WebSocket upgrade only attaches sockets after `requireSession` | `grep -n "requireSession\|sessions.get\|hub\." server/src/routers/sessionWs.ts` | `:16 requireSession`, `:25 sessions.get(sessionId)`, then `attachSocket`, `handleSocketMessage`, `detachSocket` only |
| A11 | Background failure paths: `create_event` catches into an `isError` result; the other tools (`get_transcript_words`, `list_topics`, `create_topic`) let a hub error reach the MCP SDK, which returns the error's message to the model; a log-import sheet failure is caught, printed with the error's message unless it is a catalog or driver error, and the job continues | `grep -n "isError" packages/ai-runtime/src/aiMcpServer.ts`; `grep -n "createToolError(" <sdk>/dist/esm/server/mcp.js`; `sed -n 113,126p` and `sed -n 215,225p server/src/routers/logImport.ts` | `:342 An isError tool result — the never-throw shape every create_event …`; `:141 return this.createToolError(error instanceof Error ? error.message : String(error))`; `jobFailureDetail`: `if (typeof e?.code === 'string' \|\| String(e?.name ?? '').startsWith('Catalog')) { … return null }` `return err instanceof Error ? err.message : …`; `} catch (err) { sessionsFailed += 1; … Failed “${title}” … Continuing with remaining sheets…` |
| A12 | `app.onError` has no session error mapping today | `grep -n "SessionNotFoundError\|instanceof" server/src/app.ts` | only `ApiError`, `ValidationError`, `ZodError`, `InvalidRangeError`, `SyntaxError`, `CatalogInvalidTextError` |
| A13 | The merge script is the only binding outside `server/src` and `packages/*/src` | `grep -rn "bindSystem\|\.system(" server/scripts scripts` | `server/scripts/merge-session-audio.ts:63: … bindSystem('session-hub')` |
| A14 | The routers' catch blocks either rethrow unknown errors or wrap them; only the YouTube import wraps | `grep -n "catch (" server/src/routers/{sessions,events,audio,transcribe,aiV2,ai,companion}.ts`, reading each | `sessions.ts:586 if (err instanceof ApiError) throw err; … throw new ApiError(502, detail)`; `transcribe.ts:81 mapGenerateError` maps `TranscriptGenerateError` and rethrows the rest; `aiV2.ts:505`, `sessions.ts:224/266/411/429/527/557`, `audio.ts:160/212/267` rethrow |
| A15 | Only production code builds bindings from `kind` literals: the adapter | `grep -rnE "kind: ?'(system\|user)'" server/src packages/*/src server/scripts --include=*.ts \| grep -v test` | three lines, all `packages/storage/src/postgresCatalogStore.ts` (`:194`, `:427`, `:436`) |
| A16 | The facade-consumption check reads only `SessionHubFacade` | `sed -n 3030,3050p server/src/packageBoundaries.repo.test.ts` | `const members = facadeMembers(hubSource, 'SessionHubFacade');` |

A2 and A5 are why the lock decides access and the projection follows it (D5); A3 is why a user
snapshot uses a probe (D4); A4 is why a body cannot write after a refused lock; A6 is why the policy
is the `exists` form (D1) and the cost model for D11; A7 is why exactly two hub-internal system
callers exist (D6); A8-A10 are the caller list (D7); A11-A12 and A14 are the refusal paths (D8);
A13 and A15-A16 shape the scans (D9, D12).

## D1. The migration

`supabase/migrations/20261009000000_session_content_policies.sql` is the spike draft (A1):
- **Policies:** on each of the nine tables, `<table>_user_all for all to catalog_user` with using and
  with check `exists (select 1 from catalog.sessions s where s.id = session_id and s.show_id in
  (select catalog.accessible_shows(catalog.app_user_id())))`, and `grant select, insert, update,
  delete … to catalog_user`. The `_system_all` policies stay. The name follows 6b-2's naming for a
  single `for all` rule (`user_prefs_user_all`, `show_grants_user_all`).
  - The rule is `requireSession`'s by construction: `accessible_shows` is the helper behind
    `sessions_user_update` and `authCanAccessShow`'s predicate (owner decision 1). A `can_write = 0`
    grant reads and writes, as it does through `requireSession` today (A2).
  - `catalog.sessions`' own `catalog_user` read policy (`member_shows`) applies inside the `exists`.
    It is wider than `accessible_shows`, so it removes nothing; it costs one more hashed subplan per
    statement, included in A6.
  - The user id is read through `catalog.app_user_id()` inside the policy, the precedent of every
    6b-2 policy (`accessible_shows(catalog.app_user_id())`); no new helper takes a `uid`.
- **`catalog.session_exists(id) returns boolean`**, the `show_exists` shape (owner decision 3):
  owner `postgres`, `security definer`, `search_path = pg_catalog, pg_temp`, `enable_seqscan = off`,
  `revoke all … from public`, `grant execute … to catalog_user`.
- No data change and no new table, so the recorded schema expectation is unchanged; the RLS test,
  the helper list and the policy count change (D12).

**Alternatives** (measured, A6):
- *The first draft's set form*, `session_id in (select catalog.accessible_sessions(uid))`: one
  hashed subplan per statement, but the set is every session of every accessible show, so a
  one-row insert grew to 9.3 ms and a 200-row read to 18.3 ms at 20,000 sessions. Rejected (panel
  finding 4). It also needed a helper taking any `uid` (panel minor 14).
- *A per-row definer boolean*, `catalog.session_accessible(session_id)`: a definer function cannot
  be inlined and is not leakproof, so it runs once per row the statement touches before the
  statement's own filter: 28 ms for a 250-row session read, 1.95 s for the 31,621-row insert.
  Rejected.
- *A session-id setting checked by the policy* (`app.session_id`): rejected in 7b-1 (session-tables
  D4) and would still need an access check.

## D2. The session caller

```ts
declare const callerBrand: unique symbol;
/** Who a session hub call runs for. Only `userCaller` and `systemCaller` make one. */
export type SessionCaller =
  | { readonly kind: 'user'; readonly userId: string; readonly [callerBrand]: true }
  | { readonly kind: 'system'; readonly reason: string; readonly [callerBrand]: true };
export function userCaller(userId: string): SessionCaller;   // non-empty id, else TypeError
export function systemCaller(reason: string): SessionCaller; // [a-z][a-z0-9-]*, else TypeError
```

- New module `packages/session-core/src/sessionCaller.ts`, exported from the package. The brand
  makes an object literal a type error where a `SessionCaller` is expected, so in session-core and
  its consumers the two constructors are the only way to make a caller, and the scan (D9) sees
  every one.
- Storage declares the structural shape without the brand (`{ kind: 'user'; userId } | { kind:
  'system'; reason }`), as it already declares the seam; a branded caller is assignable to it, and
  the composition root's assignment stays the type check (L1 siblings). At that seam an object
  literal type-checks; D9's scan closes it (panel minor 7).
- The validation matches the adapter's `bindUser`/`bindSystem` checks, so a bad caller fails where
  it is made, not on first use.

**Alternative:** pass the catalog's bound handle as the caller. Rejected: session-core cannot import
storage or ports' concrete handles, and a handle carries connections, not just an identity.

## D3. The seam and the hub view

- **Seam** (`sessionCore.ts`): `SessionStorage.tx<T>(caller: SessionCaller, fn)` and
  `snapshot<T>(caller: SessionCaller, fn)`. `SessionSql` (the body's handle) is unchanged: a body
  runs under its transaction's binding and cannot switch it.
- **The hub** keeps one storage, one `FifoLock`, one socket set, one alarm, one root core. Its
  private `call(mode, body)` becomes `call(caller, mode, body)` and hands the caller to
  `storage.tx`/`storage.snapshot`; `transaction(caller, body)` likewise. Nothing else in the
  write path changes: the fresh bound core per attempt, the projection before `COMMIT`, the
  broadcasts and the alarm after it (session-tables D7, D8).
- **`hub.as(caller)`** returns a `SessionHubFacade`, the bound view: today's storage members (each
  calling the hub's internal method with the caller) plus the socket members (delegated, no
  caller). Views are cheap objects; any number of them share the hub's lock, so calls of different
  callers interleave in one FIFO order, and a view outliving an eviction rejects with
  `SessionHubClosedError` as the hub does today.
- **The registry's facade** `get(id)` resolves a `SessionHubEntry`: the socket members and
  `as(caller)`, and **no storage members**. A forgotten caller is a compile error, not a silent
  system call. `SessionHubFacade` keeps its name and members, so `runSessionLogImport`,
  `timedTranscriptTokens` and `generateTranscript`, which receive a hub, do not change, and the
  router call sites of `getSessionHub` do not change either (it returns the bound view): about 13
  production edits in all (A8; panel minor 6). `packageBoundaries.repo.test.ts` gains a
  `SessionHubEntry` consumption check beside `SessionHubFacade`'s (A16).
- **The insideOwnTransaction guard** (`SessionHub.ts:566-571`) is per hub, not per view, so a call
  through any view from inside the same hub's transaction is still refused.

**Alternatives.**
- *Unbound storage members kept on the hub, defaulting to a system caller:* the 7b-1 hole under a
  new name. Rejected.
- *Unbound members kept, throwing at run time:* the compiler would not find the call sites;
  rejected for the compile-time split.
- *`registry.get(id, caller)` returning a bound hub:* the same call opens the hub, and the open is
  not the caller's act (D6); a separate `as` keeps the two apart.

## D4. The adapter binds per call; no access vs no session

- **`PostgresSessionDb`** takes the concrete `PostgresCatalogDb` (the root) instead of one bound
  handle. `forSession(id)` returns `{ tx(caller, fn), snapshot(caller, fn) }`, binding each call:
  `root.bindUser(caller.userId)` or `root.bindSystem(caller.reason)`, then `sessionTx`/`snapshot`.
  A handle is a small object over the shared `ops`; binding per call allocates no connection.
- **`bindUser` returns `PostgresBoundHandle`** on the concrete class (a narrower return type still
  implements `CatalogRoot`). The `CatalogRoot` port in `@autologger/ports` is unchanged: only
  storage's own session adapter needs the session methods, and widening the port would put
  session transactions in reach of every catalog consumer.
- **A refused lock** (zero rows, A2): under a system binding the session does not exist
  (`catalog_system` sees every row), so `SessionNotFoundError` as in 7b-1. Under a user binding the
  attempt sends `select catalog.session_exists($1) as e` on the same connection, inside the same
  transaction, before rolling back, and fails with **`SessionAccessDeniedError`** when it is true,
  `SessionNotFoundError` when false. Neither is retried and the body never runs. The extra round
  trip is on the refusal path only.
- **`SessionAccessDeniedError`** (new in `catalogErrors.ts`) carries `sessionId` as a property, and
  its message is the neutral `access to the session was refused`, with no id: it can reach an AI
  model through the MCP SDK and a log-import job line (A11; panel minors 17, 19).
- **A user snapshot** sends one probe with `BEGIN` and the preamble, pipelined like the lock:
  `select exists (select 1 from sessions s where s.id = $1 and s.show_id in (select
  catalog.accessible_shows(catalog.app_user_id()))) as ok, catalog.session_exists($1) as e`
  (panel minor 11: both answers in one statement). `ok` false fails the snapshot with
  `SessionAccessDeniedError` or `SessionNotFoundError` by `e`, before the body runs. A read-only
  snapshot cannot take `FOR SHARE` (A3), and under the policies a read without access would return
  empty lists, a body no serial order produces (core-ports-architecture "Policy outcomes keep each
  route's status"). System snapshots send no probe (unchanged). The snapshot mode therefore gains
  the session id (`{ kind: 'snapshot', sessionId }`).
- **Everything else is 7b-1's:** the session pool, `READ COMMITTED` with the lock first, the
  `40P01`-only retry, the 10-second deadline, `CatalogForbiddenError` for a `42501`.

**Alternatives** (owner decision 3 chose the helper):
- *Lock under a system binding after an access check:* two bindings in one transaction, which the
  adapter forbids, and the content statements would still need the user's binding.
- *Pipeline `session_exists` with every lock:* one more statement on every write to save a round
  trip on a rare failure. Rejected; the snapshot probe carries it because it is one statement
  already.

## D5. The lock and the projection under the caller's policy

- **The lock decides.** `FOR UPDATE` on `catalog.sessions` needs `sessions_user_select`
  (`member_shows`) and `sessions_user_update` (`accessible_shows`); the second is the stricter,
  so the lock succeeds exactly when `show_id` is accessible (A2), and the projection statement then
  changes its row (A5): the content policy, `sessions_user_update` and the lock all reduce to
  `accessible_shows` on the same `show_id`, and the projection never changes `show_id`.
- **A revoke inside the body is not prevented.** The lock holds the `sessions` row, not the grant;
  a revoke commits concurrently, and under `READ COMMITTED` every later statement of the body takes
  a new snapshot. From then on (panel minor 13):
  - a read returns no rows, silently. A body that reads then decides (`updateEvent` and
    `deleteEvent` find no event) commits a no-op, and the route answers its own not-found
    (`404 Event not found`); nothing is written;
  - a write fails `42501` (`CatalogForbiddenError`) or the projection changes zero rows
    (`SessionProjectionError`); the whole write rolls back, no frame is sent, and the route answers
    the generic `500` (a policy refusal after a gate, core-ports-architecture "A forbidden error
    after an in-transaction gate is a 500");
  - an `UPDATE` that waited on a row lock re-checks the row under the new snapshot
    (EvalPlanQual), which can widen the window to that wait.
  Either way the session holds no partial write of that transaction. The window is one in-flight
  hub body (milliseconds). Tests pin the common case, a mid-body refused write and a mid-body no-op
  (D12).
- **Content statements** carry no extra check: the policy filters reads and refuses writes, and
  7b-1's repo test (every statement names `session_id`) still holds.

## D6. The hub's own calls: open and alarm

- **Open** (`SessionHub.open`: seed rows and `expireIfStale`) runs as
  `systemCaller('session-open')`. A hub opens on the first `get` of any caller, after a gate or
  in work a gated request started (an AI tool body, the log-import job; panel minor 16), and its
  effects are session-wide, not the caller's: seeding rows that every reader expects, and freeing
  a lease that went stale while the process was down. Binding it to whichever user happened to
  touch the session first would make the open fail for a caller without access although its writes
  are not that caller's, and the registry would then cache nothing. The open reads and writes no
  content a caller sees; the caller's own first call is checked.
- **The alarm** (`runAlarm`, `expireIfStale`) runs as `systemCaller('session-lease-alarm')`: no
  user makes it, and it must free a lease even if its holder lost access.
- **Eviction and close** send no statement (A7) and need no caller. **Broadcasts** are unchanged:
  they carry notifications of committed writes to the sockets attached after the upgrade's gate,
  and show-grants D20 already closes a user's sockets when they lose access.

## D7. The callers

| Caller | Today | 7b-2 |
|---|---|---|
| Session routes (`events`, `audio`, `sessions`, `transcribe`, `exports`, `aiV2`) | `getSessionHub(c, id)` | unchanged call sites; `getSessionHub(c, id)` returns `entry.as(sessionCaller(c))`, where `sessionCaller(c)` (`_helpers.ts`) is `userCaller(requireUser(c).id)` |
| Companion, signed in | `getSessionHub` | the same, through `companionHub(c, sid)` in `companion.ts` |
| Companion, token-only | `getSessionHub` (system hub) | `companionHub` binds `systemCaller('companion-token')` |
| Session create | `getSessionHub(…).ensure()` | `await c.env.ports.sessions.get(created.id)`: the open (D6) seeds; no user-bound call (A9) |
| WebSocket upgrade | `sessions.get(id)`, socket members | unchanged (the entry has the socket members, A10) |
| AI chat / generate (`driveAiTurn`) | `registerTurn(sessionId, context)` | `registerTurn(sessionId, caller, context)`: the turn record holds the route's caller; tool bodies resolve `(await registry.get(sessionId)).as(turn.caller)` at call time |
| aiV2 aggregate MCP server | `buildAggregateMcpServer(sessionId, registry, …)` | gains `caller` (the route's `sessionCaller(c)`); `mcpTools.ts` bodies bind with it |
| Topic generation | `generateTopicsTurn({ registry, sessionId, … })` | gains `caller`, passed to its hub resolution and to `registerTurn` |
| Transcript generation | `getHub: () => getSessionHub(c, id)` | unchanged code; the closure returns the bound view |
| Log-import job | `env.ports.sessions.get(sessionId)` | `(await env.ports.sessions.get(sessionId)).as(userCaller(job.createdByUserId))` in `logImport.ts` |
| Undo steps (P1) | `getSessionHub(c, id)` | `undoHub(c, id)`, a per-file helper binding `systemCaller('session-undo')`, at the seven sites in Context (`audio.ts`, `sessions.ts`, `events.ts`) |
| Lease alarm, hub open | the hub's one storage | `session-lease-alarm`, `session-open` (D6) |
| `merge-session-audio.ts` | `bindSystem('session-hub')` | `new PostgresSessionDb(catalogDb).forSession(id).snapshot(systemCaller('merge-audio-script'), …)` |

- **Undo steps** (owner decision P1). A request whose later step fails, or is refused after a
  revoke, must not leave its own earlier writes behind. Run as the user, its undo would itself be
  refused after a revoke, leaving an orphan segment and blob or a doubled set of generated events.
  Each `undoHub` call removes only rows the same request wrote (the segment id it just created) or,
  for the regenerate delete, the auto-generated snapshot ids the same request read before its turn
  and is replacing with the events its turn created; the ids come from the request, never from the
  client. The literal sits in each of the three router files, so each file's use is an allowlist
  entry (D9).
- The AI runtime receives a `SessionCaller`, never a user id, so `userCaller` is made only in two
  router files (`_helpers.ts`, `logImport.ts`), which the scan holds (D9). core-ports-architecture
  "AI tool bodies consume the session facade directly" still holds: bodies resolve the hub through
  the registry facade at call time and bind it there.
- A `driveAiTurn` that outlives its request keeps the user who started it (owner decision 2); the
  database applies that user's current memberships and grants to every statement. Disabled accounts
  are P2.

## D8. Refusals keep each route's status

- **`app.onError`** maps `SessionAccessDeniedError` to `404 {"detail":"Session not found"}`, beside
  its other mappings (A12). Every `/api/sessions/:id/…` route already answers that `404` for missing
  access (`requireSession`).
- **Catch-alls** (A14): the YouTube import's `502` wrapper (`sessions.ts:586`) rethrows
  `SessionAccessDeniedError` before wrapping, after its undo; `mapGenerateError` and the other catch
  blocks already rethrow it. A repo-wide rule is not added: the race tests in task 5.1 cover each
  importing route, and new catch-alls are reviewed.
- **The Companion routes** (api-contract-freeze `spec.md:1604-1613`): `categories`, `log`,
  `transport` and `command` map it to the `409` `No active session — open AutoLogger in a browser
  and open a session.`; `state` treats it as "cannot see the active session" and returns
  `active_session_id: null`, `session: null`, `last_command` re-masked when it names that session,
  and `connected_clients` unchanged, `200` (panel finding 1). Token-only calls are system calls and
  are never refused for access.
- **Background work** (A11): `create_event` returns its `isError` result; the other tools return
  the SDK's tool error, whose text is the neutral message (D4); a log-import sheet fails as
  `Failed “<title>”: access to the session was refused`, and the next sheet's re-check stops the job
  (`Access revoked; stopping.`).
- **Undo** (P1): a refused step is followed by the route's existing undo, as `session-undo`, before
  the refusal is answered.
- **`SessionNotFoundError`** keeps 7b-1's behaviour (a route never reaches it: `requireSession`
  first).
- No status, body or message is new; the outcomes are the serial order "revoke, then request".

## D9. Reviewed bindings

`server/src/catalogSystem.repo.test.ts`:
- **System reasons**: the pattern becomes `/\.(?:system|bindSystem)\(|\bsystemCaller\(/`, with the
  same single-quoted literal rule.
- **User callers**: `userCaller(` joins `.forUser(`/`.bindUser(` as a user binder, allowed only in
  `USER_SESSION_CALLERS = { server/src/routers/_helpers.ts, server/src/routers/logImport.ts }`.
- **The storage seam** (panel minor 7): `new PostgresSessionDb(` is allowed only in
  `server/src/node/config.ts` and `server/scripts/merge-session-audio.ts`, and a `kind: 'system'` or
  `kind: 'user'` object literal outside `IMPLEMENTING` fails (A15: none exists today).
- **Roots**: `server/scripts` joins (A13). **Exempt** (`IMPLEMENTING`): `sessionCaller.ts`,
  `postgresSessionSql.ts`, `postgresCatalogStore.ts`, `catalog.ts`.
- **The allowlist** (after commit 3b) loses `{ server/src/node/config.ts, session-hub }` and gains
  `{ packages/session-core/src/SessionHub.ts, session-open }`,
  `{ packages/session-core/src/SessionHub.ts, session-lease-alarm }`,
  `{ server/scripts/merge-session-audio.ts, merge-audio-script }`, and `session-undo` in
  `server/src/routers/audio.ts`, `sessions.ts` and `events.ts`; `{ server/src/routers/companion.ts,
  companion-token }` now covers the hub call too (its `why` says so). Commit 3a only moves
  `session-hub` to `SessionHub.ts` and adds `merge-audio-script` (tasks).
- **Mutation fixtures** (synthetic trees, as today): an unlisted `systemCaller('x')` fails; a
  `systemCaller(reason)` with a variable fails; a `userCaller(id)` outside the two files fails; a
  `new PostgresSessionDb(` elsewhere fails; a `{ kind: 'system', reason: 'x' }` literal fails; a
  stale `session-open` entry fails; a listed one passes.
- **LIMITS** (stated in the test, as today): aliases, computed members, dynamic imports, and a
  caller object built without a `kind` literal (for example spread from another object) slip past
  the textual scan. The brand (D2) closes object literals inside session-core's consumers; the
  database's policies are the backstop for a user caller, and a forged system caller is the one
  hole a reviewer must catch.

## D10. What does not change

- The session pool, the deadline, retries, snapshots per read, the FIFO lock, broadcast order,
  eviction timing, the projection statement, the 7a/7b-1 hazard statuses (session-tables D13).
- The `sessions` row rules and every app gate; api-contract-freeze and team-management.
- `serializeSessionEntry`'s masking of the list for members without a grant (it reads
  `catalog.sessions`, not content).

## D11. Measurement and the stop rule

- **Expected cost** (A6): each content statement under a user binding probes `sessions` by primary
  key per row it checks, plus two hashed subplans per statement (about 0.3 ms on a one-row insert
  in the spike, psql inside the db container); an `addEvent` sends the lock, a handful of content
  statements and the projection, so about 1 ms on 7b-1's 5.4-5.6 ms. The words insert costs about
  25% more than the set form's (238-251 ms against 191-200 ms), far below the 10 s limit.
- **Baseline** (task 1.2): 7b-1's pinned `bench7b.mts` on the base commit, twice.
- **`spike/bench7b2.mts`** (written in task 7.2, against the implemented API): 7b-1's bench with the
  storage built as `new PostgresSessionDb(catalogDb)` and every hub call made through
  `hub.as(userCaller(<an owner the bench creates>))`, so the measurement runs under the policies.
  Before measuring it seeds sessions in the owner's throwaway show, and runs the whole sequence at
  300 and again at 3,000 accessible sessions (the real catalog copy has 302, panel finding 4). It
  runs inside the dev app container after `make dev-up`, and deletes everything it created.
- **Stop rule (owner's current, ADR 0021 7b-1):** stop and ask the owner if, in the stack and at
  either session count, the median `addEvent` exceeds 10 ms or the 31,621-word replace exceeds
  10 s. A slower `listEvents` is recorded, not a stop.

## D12. Tests

Written first, red where today's code allows; any change to an existing expected value outside
this list is a stop.

**Database (`pg` project):**
- `catalogPolicies.pg.test.ts`: `RULES` gains the nine tables, every operation `accessibleShows`,
  checked for every actor through `policyFixture` content rows (one row per table for a session of
  S1 and of U's show); the count test becomes "no catalog_user policy is the constant true, and
  there are 32"; a `FOR UPDATE` case per actor; a grant-then-repeat case (catalog-database "A
  member without a grant sees no session content"); a `can_write = 0` grantee reads and writes.
- `catalogSchema.pg.test.ts`: the RLS test's session-table exception is inverted (each session
  table has `_system_all` and `_user_all`, and `catalog_user` holds the four privileges); "catalog_user
  is refused on every session table" becomes catalog-database "A user binding is refused on the
  session tables".
- `catalogPolicyHelpers.pg.test.ts`: `session_exists` joins the set and privilege/config checks.

**Adapter (`packages/storage`):** `sessionSqlContract.ts` passes a caller per call (every existing
case as a system caller, assertions unchanged) and adds: an ungranted user's `tx` rejects with
`SessionAccessDeniedError` and a missing id with `SessionNotFoundError`, the body never running; an
ungranted user's `snapshot` rejects the same way without running its body; a granted user's
snapshot sees the rows and its `tx` commits; a user `tx` and `snapshot` that succeed add no round
trip; `SessionAccessDeniedError`'s message names no id. The `pg` fixture seeds a team, a show, an
owner, a granted and an ungranted member.

**Hub (`server/src/test/session/`):**
- `callers.int.test.ts`: a binding recorder (a storage wrapper whose every `tx`/`snapshot` body
  first runs `select current_user, current_setting('app.user_id', true)` and records it with the
  call) shows that `hub.as(a)` and `hub.as(b)` on one hub run as `catalog_user`/a and
  `catalog_user`/b, interleaved in one FIFO order with broadcasts in commit order; that the open
  and the alarm run as `catalog_system` under `session-open` and `session-lease-alarm` (the reason
  recorded from the caller); and that a log-import job's and an AI tool's statements run as their
  starting user (panel minor 10). `registry.get(id)` exposes no storage member (an
  `@ts-expect-error` type case).
- `policyWindow.int.test.ts` (D5): the owner's write commits with its projection; a revoke
  committed through a second connection mid-body (`slowStorage`) makes a later insert fail with
  nothing saved and no frame; a revoke before an `updateEvent`'s read makes it commit as a no-op and
  the route answer `404 Event not found`.
- The bound-core harness and `sessionRows.ts` take a caller; existing session tests run as a
  `systemCaller('test-harness')` unless they test access (mechanical; assertions unchanged).

**Server races** (`server/src/routers/catalogPolicies.int.test.ts`, the precedent at `:357`, with a
session-storage gate in place of the catalog gate): a grant revoked between `requireSession` and the
hub call gives `404 Session not found`, writes nothing and sends no frame, for an event add, a
transport start, a transcript word edit, a dashboard save, and a read (`GET …/events`, not an empty
list); the local audio import and the YouTube import (fake `yt-dlp`) refused at their anchor answer
`404` (not `502`) with their segment and blob undone; the audio upload refused after its row and
blob, and event regenerate refused after its turn, are undone as `session-undo` (the undo runs; the
session holds none of the request's rows); the Companion cookie case gives `409` for `log` and the
masked `200` shape for `state`; an AI `create_event` after a revoke returns `isError` and
`list_topics` returns the neutral tool error, creating nothing (`aiMcpServer.int.test.ts`); a
log-import job whose creator is revoked after its per-sheet check reports `Failed “<title>”: access to
the session was refused` and stores no event, and the next sheet stops the job
(`logImport.int.test.ts`).

**Reviewed bindings:** `catalogSystem.repo.test.ts` per D9, and `packageBoundaries.repo.test.ts`'s
facade check extended to `SessionHubEntry` (A16).

**Green, unchanged:** `access.int.test.ts`, `authz.int.test.ts`, the Companion token-only and cookie
tests, `sessionWs` tests, `sessionHub.interleave.int.test.ts` (same observables: frames 143,
revisions 81 → 224, final events 104), and the full suites.

Test plumbing found in group 3 (post-approval; no scope change; the last bullet moves one approved assertion change, the others change no assertion):
- `packages/storage/src/postgresCatalogStore.pg.test.ts`'s pool-saturation case passes a session
  id to `PostgresBoundHandle.snapshot`, which now takes one (D4); its system binding sends no
  probe.
- `postgresSessionSql.pg.test.ts`'s `connect` seam also records, per statement, its connection's
  replies so far, which the round-trip case counts.
- `sessionRows.ts` exports `TEST_CALLER` (`systemCaller('test-harness')`), which its raw helpers,
  `boundCore.ts` and the direct storage calls in `alarmAfterCommit`, `poolIsolation` and `snapshot`
  (`*.int.test.ts`) pass.
- `catalogBinding.int.test.ts`'s composition-root case ("the composition root makes no
  `session-hub` binding") changes in commit 3a (task 3.2), not 3b (task 4.7), by owner decision
  (2026-10-03, after the 3.2 stop): commit 3a's `config.ts` already stops binding `session-hub`
  at construction, so the old assertion cannot hold there. Same assertion, earlier commit.

## D13. Specs, README and ADR 0021

- Specs: the deltas (catalog-database, core-ports-architecture). api-contract-freeze and
  team-management are unchanged (proposal). At archive, the old requirement name "Every catalog call
  is bound to a caller" is replaced where it is cited: `openspec/specs/core-ports-architecture/spec.md:85`
  ("Catalog facade exposes only role-scoped stores", a hand edit as 7b-1's), and in code comments
  at `server/src/catalogSystem.repo.test.ts:8` and `packages/catalog/src/catalog.ts:48` (task 3b).
- README: the "Show access" block gains one bullet (the database enforces the same rule on session
  content for signed-in callers; a request racing a revoke gets the same masked answer; token-only
  Companion calls are the exception until slice 9), and the SessionHub bullet says each hub call
  runs as its caller.
- ADR 0021 slice 7: the 7b-2 entry in the 7b-1 style: the owner decisions (including P1, P2), the
  mechanism, how each of the three 7b-1 constraints is met, and the measurement.

## Risks / Trade-offs

- [A revoke that commits during a hub body: a later write fails with the generic `500`, and a
  read-then-decide body commits a no-op and answers its own not-found] → no partial write of that
  transaction persists and no frame is sent (D5); the window is one in-flight body; tested.
- [Write latency rises by the policy's per-row probe] → flat in the number of sessions (A6);
  measured under a user binding at 300 and 3,000 sessions against the owner's stop rule (D11).
- [`session_exists` answers whether any session id exists to any signed-in user] → the adapter is
  its only caller and the routes mask both answers the same way; the helper set already holds
  `show_exists` and `studio_exists` on the same terms.
- [Undo steps run as a system task] → each removes only ids the same request produced (D7), at
  seven reviewed sites in three allowlisted files; tested per site.
- [An AI turn or log-import job keeps acting for a user whose access was narrowed but not removed,
  or whose account was disabled after it started] → the database applies the user's current
  memberships and grants to every statement (owner decision 2); disabled accounts are P2.
- [Token-only Companion calls bypass the policies for any session id] → pre-existing, slice 9's
  credential (Goals, README).
- [The read probe adds a statement to every user snapshot] → pipelined with `BEGIN` (no round
  trip); measured with `listEvents` (D11).
- [The test churn: hubs in about 33 test files are resolved through `as`] → a mechanical change by a
  test helper; no assertion changes outside D12.
- [The open runs as a system task, so a hub opens for a caller who then gets refused] → its effects
  are session-wide, and the caller's first storage call is refused (D6).

## Migration Plan

1. Merge into `supabase-migration`.
2. Dev: `make dev-up` applies `20261009000000_session_content_policies.sql`; the dev live check in
   proposal.md "After merge".
3. Stage: `make stage-up`, with the owner's permission.
4. Rollback: redeploy the previous image. Its hub runs as `system('session-hub')`, which the
   `_system_all` policies still admit, so the new policies and helper can stay; a down-migration is
   not needed.
5. Prod: unaffected until slice 11.

## Open Questions

None. The plan's four questions and the panel's two were decided by the owner (proposal "Owner
decisions" and "Owner decisions after the panel").
