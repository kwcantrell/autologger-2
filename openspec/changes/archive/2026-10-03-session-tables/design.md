# Design: session-tables

## Context

See proposal.md for why. The current state this design changes:

- **The seam.** `SessionSql` (`packages/session-core/src/sessionCore.ts:26-33`) has `all`, `run`,
  `exec` (DDL, zero binds) and `tx`. Its only adapter is `sqliteSessionSql`
  (`asyncSessionSql.ts`): `BEGIN IMMEDIATE`, a transaction-scoped handle, joins, misuse errors, and
  a `rollbackFailed` flag the hub reads. Neither `SessionCore` nor `SessionRuntime` knows the
  session id: the id is the file name.
- **The hub** (`SessionHub.ts`): `SessionHub.open(dbPath, clock, opts)` opens a better-sqlite3
  file, sets pragmas, runs `initSchema` (DDL plus `INSERT OR IGNORE` seeds) and `expireIfStale`
  (`:457-486`). Every storage call goes through `call()` (`:488-509`) under a per-hub FIFO lock;
  a write runs `transaction()` (`:528-550`), which flushes the bound core's broadcasts after
  `COMMIT` and closes the hub after a failed `ROLLBACK` (`closeAfterFailedRollback`, `:561-572`);
  a read runs on the root stores with no transaction. The lease alarm is armed outside the hub's
  ALS context (`:577-596`). `SessionHubRegistry` (`:1088-1188`) takes a sessions directory and
  `mkdir`s it, opens `<id>.db` on first `get` (read paths included), evicts idle hubs and closes
  them at shutdown.
- **The SQL** is SQLite dialect, unscoped (one file per session): `sessionCore.ts:95-180` (schema),
  `:195`, `:211`, `:215`, `:224`, `:229`, `:234`, `:345-358`; `storeHelpers.ts:34`;
  `eventStore.ts:101`, `:116`, `:148`, `:162`, `:168`, `:182-197`, `:203-205`, `:230`, `:250-256`,
  `:270-285`, `:305`; `SessionHub.ts:739-743`; `transportStore.ts:45`, `:73`, `:108`;
  `audioStore.ts:91`, `:102`, `:130-176`; `transcriptStore.ts:115-255` (with three unscoped
  `DELETE`s at `:191-193` and one `INSERT` per word); `topicStore.ts:35-101`;
  `dashboardStore.ts:81-146`.
- **The mirror.** After a hub write, eleven route call sites (`events.ts:174, 182, 241, 635, 696,
  706`; `companion.ts:218, 235`; `sessions.ts:432, 557`; `logImport.ts:212` via
  `runSessionLogImport.ts:50-57, 79, 104`) call `ports.mirror.mirror(sessionId)`
  (`server/src/sessionMirror.ts`), which reads the hub's projection and writes it into
  `catalog.sessions` through `SessionIndexStore.projectSessionLive`
  (`packages/catalog/src/sessionIndexStore.ts:349-373`) as `system('session-mirror')`
  (`server/src/node/config.ts:52-56`). A failed write only warns (api-contract-freeze "Catalog
  mirror failures don't fail saved session changes"). The only reader of those columns is
  `serializeSessionEntry` (`sessions.ts:64-131`), for `GET /api/sessions` and `/:id`.
- **The catalog adapter** (`packages/storage/src/postgresCatalogStore.ts`): root slots (3) and
  transaction slots (5), each a single-connection postgres.js client; `SERIALIZABLE`
  transactions retried on `40001`/`40P01` with jittered backoff (5 runs); one 10-second deadline
  per transaction; `CatalogCommitUnknownError`; a connection whose end is unconfirmed is
  recycled; the bindings preamble pipelined with `BEGIN`; `toPg` (`?` to `$n`); `checkText`
  (NUL refused); int8 parsed as a number. The app role allows 20 connections; the integration
  test container raises it to 200 (catalog-on-postgres D6).
- **Precedents.** 4a ported the catalog faithfully; 4b/4c built and wired the adapter; 4c moved
  DB-backed catalog tests into the server's integration project (catalog-on-postgres D6); 6b-1
  added the bindings and the allow-all policies; 7a made the hub async and listed the 7b hazards
  (async-session-hub D11, ADR 0021 slice 7).

## Owner decisions

See proposal.md "Owner decisions". They fix: the 7b-1/7b-2 split, the row lock under
`READ COMMITTED`, `REPEATABLE READ READ ONLY` snapshots for multi-statement reads, the FIFO lock
kept until slice 9, start empty with the projection reset, backups as a cutover blocker, a
faithful port.

## Owner decisions after the panel (owner, 2026-10-03)

The three-reviewer panel found no critical issue and eight major ones (`panel.md`). The owner
decided:
1. **Fold S4/S5 in** (former Open Question 1): `anchorImportedTake` re-checks `is_rolling` inside
   its transaction and refuses; each import route answers its existing `409` rolling detail and
   rolls the segment back exactly as its post-blob rolling refusal does today (D7, D13).
2. **The stop rule is confirmed** (former Open Question 2): a median `addEvent` above 5 ms, or the
   31,621-word replace above 10 s, measured in the stack (D11). Raised after task 8.2 to 10 ms
   for `addEvent` (owner, 2026-10-03; see D11).
3. **A projection failure fails the write** (former Open Question 3, D8); the api-contract-freeze
   REMOVED requirement stands.
4. **Session calls get their own pool** (panel finding 6): 4 connections beside the catalog's 3
   root and 5 transaction connections, 12 of the role's 20, so heavy session traffic can only slow
   session calls (D2).

## Goals / Non-Goals

**Goals:**
- Session content lives in schema `catalog`, one row set per session, isolated by `session_id`
  and serialized by the session row lock, so a second process (slice 8) could write safely.
- The 7a observables (core-ports-architecture) hold on Postgres, plus two new ones: cross-process
  serial order and session isolation.
- The live projection is never stale after a committed write, and the mirror chain is gone.
- No change for serial requests apart from the failure paths the proposal lists.

**Non-Goals:**
- Making the remaining snapshot sequences atomic (D13), a typed schema, content policies.
- Retiring the in-process lock, or changing eviction timing.

## Assumptions and evidence

The spike and the probe are pinned in this change: `spike/spike7b.mts` (with the draft migration
`spike/20261008000000_session_tables.sql`) and `spike/rtt7b.mjs`, paths relative to
`openspec/changes/session-tables/`. `spike7b.mts` starts the pinned image with the real
`migrate.sh` and the merged migrations plus the draft, and emulates the adapter's protocol with
postgres.js directly (the adapter does not exist yet): `npx tsx
openspec/changes/session-tables/spike/spike7b.mts` (node v24.21.0, host, through docker's
published port). `rtt7b.mjs` runs inside the dev app container against the dev database and
writes no row: `docker exec -i -w /app autologger-dev-app node --input-type=module - <
openspec/changes/session-tables/spike/rtt7b.mjs` (node v22.23.3).

| # | Assumption | Command | Observed |
|---|---|---|---|
| A1 | The pinned image is Postgres 17 (`pg_input_is_valid` exists), and the draft migration applies through `migrate.sh` with RLS on all nine tables | `spike7b.mts`; `grep x-image docker/supabase-db.yaml` | `A1 PostgreSQL 17.6`; `A1 session tables session_audio_segments:rls … session_transport:rls` (9 tables); `supabase/postgres:17.6.1.136@sha256:f371…` |
| A2 | A `jsonb` predicate keeps the pinned auto-generated parity corpus (`eventStore.test.ts:324-372`) and the relink pre-check | `spike7b.mts` | all 10 corpus rows agree across JS, SQLite and `pg-jsonb`; duplicate keys `{"auto_generated":false,"auto_generated":true}`: `js true sqlite false pg-jsonb true`; `{"auto_generated":true,"x":"\u0000"}`: `js true sqlite true pg-json error 22P05 pg-jsonb false`; relink corpus (7 rows) agrees between SQLite and `pg-jsonb`; `A2 relink sqlite on malformed json: malformed JSON` |
| A3 | `lower(trim(category)) <> 'internal'` under `COLLATE "C"` matches SQLite, non-ASCII included | `spike7b.mts` | `"\tinternal"`, `"ÍNTERNAL"`, `"İNTERNAL"` logged in both; `" Internal "`, `"INTERNAL"` internal in both |
| A4 | `FOR UPDATE` on a missing session row returns no row; a content row for an unknown session fails the foreign key; the seed is idempotent; `catalog_user` is refused on session tables; a write in a read-only snapshot fails; a fractional bind into `bigint` fails; a negative `LIMIT` fails; `count(*)` reads as a number | `spike7b.mts` | `A4 lock rows for a missing session 0`; `23503 session_meta_session_id_fkey`; `seed twice, rows 2 2`; `catalog_user select/insert/update/delete 42501`; `write in a read-only snapshot 25006`; `fractional into bigint 22P02`; `bigint compared with a fractional bind 22P02`; `negative LIMIT 2201W`; `count is a number ok number 2` |
| A5 | The row lock taken first serializes read-then-write transactions from two connections (two processes) under `READ COMMITTED`; without it updates are lost | `spike7b.mts` | `400 concurrent toggles from two connections: is_rolling 0 current_take 200 (serial: 0 and 200)`; `without the row lock: is_rolling 0 current_take 100` |
| A6 | A catalog `SERIALIZABLE` update of a `sessions` row that waits on a session write fails with `40001` after the session commits, and its retry succeeds | `spike7b.mts` | `A6 … after its commit: 40001`; `A6 its retry: ok` |
| A7 | Latency on the host test container (published port): an `addEvent`-shaped transaction, with and without the projection statement, and a `listEvents` snapshot | `spike7b.mts` | `A0 select 1 round trip us: median 107`; `addEvent tx without projection median 4347`; `with projection median 5754`; `listEvents snapshot (200 rows) median 3804`; `A7c one-row read transaction 262`, `one-row write transaction 1899` (the WAL flush on commit) |
| A0b | Latency where the app runs (dev app container to dev db): one round trip, a 9-round-trip read transaction shaped like `addEvent`, and a commit that flushes WAL | `rtt7b.mjs` | `select 1 round trip us: median 34`; `9-round-trip READ COMMITTED transaction us: median 638`; `3-round-trip transaction with a commit record (WAL flush) us: median 279` |
| A8 | The largest real transcript (31,621 words) replaced per row is slow on the host path; one `json_to_recordset` statement is fast; the other session's rows are untouched | `spike7b.mts` | `per-row: 4990 ms`, `4766 ms`; `json batch: 346 ms`, `299 ms`; rows `{"n":31621,"lo":0,"hi":31620}`; `the other session is untouched, words 0` |
| A9 | postgres.js serializes a parameter the server types as `json` with `JSON.stringify`, so a JSON text bind must be cast through `text` | spike run 4 (log `spike7b-run4.log`), then the `$2::text::json` form in run 5 | run 4: `PostgresError: cannot call json_to_recordset on a scalar` (`22023`); run 5: rows as A8 |
| A10 | The image's configuration sets `extra_float_digits = 0`, so a `double precision` reads back with 15 significant digits unless the connection sets it | spike run 5 `A8 float round trip`; a dev-container probe (`show extra_float_digits`, `pg_settings`) | `{"start_sec":3826.95,"end_sec":3827.15} expected {… "end_sec":3827.1499999999996}`; `extra_float_digits 0`, `source: 'configuration file'`, `boot_val: '1'`; with `connection: { extra_float_digits: 1 }`: `3827.1499999999996` |
| A11 | Every request or user-supplied number bound into a session `bigint` column is an in-range integer, except two inputs that D5 now treats as absent (panel findings 4, 5) | `grep -n "timecode_hms\|frame_rate\|topic_level" packages/contract/src/schemas.ts`; `sed -n 196,197p server/src/routers/audio.ts`; `sed -n 3,23p packages/log-import/src/sheetTimecode.ts`; `sed -n 327,339p server/src/routers/sessions.ts`; `sed -n 855,877p packages/ai-runtime/src/aiMcpServer.ts`; `grep -n "Math.trunc\|clampInt" packages/session-core/src/*.ts server/src/routers/events.ts`; `grep -rn "known.push" server/src/routers/audio.ts` | in range: the event `PUT`'s `timecode_hms` is exactly 8 characters and `frame_rate` at most 120 (at most about 4.3e9 frames); `topic_level` is an int 1..10; local import `duration_s` is bounded; AI `session_time` parses below 24 h; stores `Math.trunc` elapsed frames; sync ordinals are 4 digits; `listEvents` is clamped (`events.ts:190-191`). **Not bounded:** `POST …/audio/segments?recording_ordinal=` takes any digit string (`/^\d+$/.test(roRaw) ? Number(roRaw)`), so 20 digits reach `bigint` (`22003`) or arrive as an unsafe float; a sheet log timecode's hours are unbounded digits (`parseSheetTimecodeToSeconds`), so `secondsToTotalFrames` can exceed the `bigint` range |
| A12 | No catalog transaction body calls a session hub, and no hub body calls the catalog | `grep -rn "\.tx(async\|\.tx((" server/src packages --include=*.ts \| grep -v "\.test\.ts" \| grep -v server/src/test/ \| grep -v session-core` (56 bodies in 11 files), then `grep -rn "getSessionHub\|sessions\.get(" server/src/routers/{profile,auth,shows,admin,teams}.ts` | the bodies are in the catalog package and the routers `profile`, `sessions`, `auth`, `shows`, `admin`, `teams`; the last five never resolve a hub (empty grep), and the `sessions.ts` create body calls only `cat.auth` and `cat.sessions`. Hub bodies await only their handle (async-session-hub D4) |
| A13 | The session create's catalog transaction runs as the signed-in user | `sed -n 200,232p server/src/routers/sessions.ts` | `catalog.tx(async (cat) => { … authCanAccessShowForShare(user.id, …) … createSessionForShow(…) })` on `c.get('catalog')`, then `await (await getSessionHub(c, created.id)).ensure()` ("Instantiate the hub so its transport row exists") |
| A14 | `exportEvents` consumers do not depend on SQLite's row order | read each caller (`grep -rn "exportEvents()" server/src packages`) | `exports.ts:24` sorts; generate sorts in `existingEventsForGenerate` (`events.ts:417`); anchors sort (`eventAnchors.ts:70`); `nextRecordingOrdinal` takes a max; `mcpTools.ts:202` counts (only `byCategory`'s key order follows row order) |
| A15 | Row mappers pick named fields, so `session_id` in `SELECT *` reaches no wire object | `grep -n "function wordRow\|function topicRow\|function paragraphRow\|function sentimentRow\|function audioRowToMeta\|function dashboardRow\|function eventRowToRpc" -A10 packages/session-core/src/*.ts` | every mapper builds an object from named columns |
| A16 | Which tests need a real session database | `for f in packages/session-core/src/*.test.ts; do grep -l "fakeRuntime\|SessionHub\|better-sqlite3\|sqliteSessionSql\|slowSql" $f; done`; `grep -ln "SessionHubRegistry\|SessionHub.open" packages/*/src/*.test.ts` | session-core: 14 of 16 files reach a database, 13 wholly and `eventAnchors` in part (188 tests in the 14; `audioSeamParts` and `fifoLock` are pure); packages: `ai-runtime` (`aiMcpServer`, `mcpTools`, `topicGenerate`), `log-import` (`runSessionLogImport`), `transcription` (`generateTranscript.remap`) |
| A17 | A package test may not import `@autologger/storage` (L1 siblings) | `server/src/packageBoundaries.repo.test.ts:269-300` (`ALLOWED_LAYER_EDGES`, test files walked too); package-architecture "Layer-1 packages are siblings: no L1 package SHALL import another L1 package" | no `session-core -> storage` edge, and the walk includes `*.test.ts` |

A2 is why the predicates use `jsonb` (D5); A9 and A10 are adapter rules (D2, D5); A7/A0b are
why the stop rule is measured in the stack (D11); A8 is why the replace is one statement per
table (D5); A12 is why the slots can be shared (D2); A13 is why seeding moves to the hub open
(D9); A16/A17 are why the tests move to the server (D12).

## D1. The tables and the migration

`supabase/migrations/20261008000000_session_tables.sql` is the spike's draft
(`spike/20261008000000_session_tables.sql`), applied by A1:
- **Nine tables in schema `catalog`**, a faithful port of `initSchema`: `text collate "C"`,
  `INTEGER` to `bigint`, `REAL` to `double precision`, text timestamps, JSON as text, the same
  nullability and defaults. `events` and `meta` become `session_events` and `session_meta`
  (`events` and `meta` are too generic beside the catalog's tables); the other seven keep their
  names.
- **`session_id text collate "C" not null references catalog.sessions (id)`** on every table, no
  action (as `shows`; sessions are never deleted, and a delete with content now fails `23503`
  instead of orphaning it). Primary keys become `(session_id, id)` and `session_meta`'s
  `(session_id, key)`. `session_transport` drops its `id = 1` column and is keyed by
  `session_id`.
- **Indexes lead with `session_id`:** `idx_session_events_wall (session_id, wall_time_utc, id)`,
  `idx_session_audio_ordinal (session_id, ordinal)`, a new `idx_session_audio_r2_key (session_id,
  r2_key)` for `syncAudioFromBlobs`' per-blob lookup, `idx_session_words_ordinal`,
  `idx_session_topics_ordinal`, `idx_session_paragraphs_ordinal`,
  `idx_session_sentiment_ordinal` (each `(session_id, ordinal)`), and
  `idx_session_dashboards_created (session_id, created_at_utc)`. Names keep the `idx_` prefix the
  recorded-schema test reads.
- **Row-level security** on all nine with `<table>_system_all` (`for all to catalog_system using
  (true) with check (true)`), and `revoke all … from catalog_user`. catalog-database "Row-level
  security is enabled on every catalog table" requires a table without `catalog_user` policies to
  have its privileges revoked; the default privileges from `catalog_roles` would otherwise grant
  them. A user-bound statement therefore fails `42501` (A4) rather than silently matching no row.
  7b-2 grants them back with its policies.
- **The projection reset:** one `update catalog.sessions set event_count = 0,
  max_timecode_total_frames = null, is_rolling = 0, current_take = 0, transport_elapsed_frames =
  0, roll_started_at_utc = null`, the projection of an empty session (the column defaults).
- **No seed rows in the migration.** A hub open seeds its session (D9), so the migration need not
  know which sessions exist.
- `catalogSchema.pg.test.ts` gains the nine tables in `TABLES`, `KEY_COLUMN` and
  `EXPECTED_SCHEMA` (recorded from the migrated template in one run, as retire-sqlite-catalog D3
  did), and its RLS test states the rule "every table but `kv` and the session tables has
  `catalog_user` policies; the session tables have none and `catalog_user` holds no privilege on
  them".

**Alternatives.** A `public`-schema or separate `session` schema: rejected, the app role's
`search_path` and grants are `catalog` only, and 4a put everything there. Keeping the generic
names: rejected, `catalog.events` and `catalog.meta` read as catalog-wide. Seeding every session
in the migration: unnecessary (D9) and would race session creates during a deploy.

## D2. The adapter: a session pool, a session mode and a snapshot mode

**Shape.** The session adapter is a transaction mode of `PostgresCatalogDb`, not a second class,
with its own small pool of connections (owner, after the panel; below):
- `attempt()` and `runTx()` take a mode:
  - `catalog` (today): `BEGIN ISOLATION LEVEL SERIALIZABLE`, retry on `40001`/`40P01`;
  - `session(sessionId)`: `BEGIN ISOLATION LEVEL READ COMMITTED`, the bindings preamble, and
    `select 1 as locked from sessions where id = $1 for update`, all three sent together (one round
    trip, as the preamble is today). No row means the session does not exist: the attempt fails
    with `SessionNotFoundError` (new, in `catalogErrors.ts`), is rolled back and never retried.
    Retry on `40P01` only (`40001` cannot occur under `READ COMMITTED`);
  - `snapshot`: `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` with the preamble; no retry (a
    read-only transaction takes no row locks and cannot fail serialization).
- Session and snapshot transactions run on a third set of slots, the **session slots**, with
  their own FIFO wait queue; catalog transactions keep the transaction slots and root statements
  the root slots. The adapter's existing `pool(size, expired)` builds it, and closing, recycling
  and connection-loss handling are the existing per-slot code.
- Everything else is shared, unchanged: the 10-second deadline over the slot wait, every run and
  the commit; the jittered backoff; `toPg`;
  `checkText`; the int8 parser; `CatalogCommitUnknownError`; recycling a connection whose end is
  unconfirmed; the `AsyncLocalStorage` guard that refuses a root statement inside an open
  transaction.
- `bindSystem()` returns the concrete bound handle (`PostgresBoundHandle`, still a `CatalogDb`),
  which gains two methods off the port: `sessionTx(sessionId, fn)` and `snapshot(fn)`.
- `packages/storage/src/postgresSessionSql.ts` holds `PostgresSessionDb`, built over a bound
  handle, whose `forSession(sessionId)` returns the session-core seam's root (`{ tx, snapshot }`,
  D3), with body handles adapting `TxHandle` (`all`, `run` as `{ changes: count }`, joining
  `tx`). Storage does not import session-core (A17): it declares the same structural type, and
  the composition root's assignment is the type check.
- Every connection the adapter opens sets `extra_float_digits: 1` in its startup parameters (A10),
  so a `double precision` reads back exactly, as SQLite's `REAL` does. This also makes the
  catalog's `frame_rate` exact; no recorded catalog value changes (29.97 and 24 have short forms).

**The binding.** The composition root builds `new PostgresSessionDb(catalogDb.bindSystem('session-hub'))`.
`catalogSystem.repo.test.ts` gains `{ server/src/node/config.ts, session-hub }` and loses
`session-mirror` (D8); `postgresSessionSql.ts` joins `IMPLEMENTING` (it forwards the handle and
names no reason). 7b-2 replaces this binding with the caller's.

**Connections: a session pool of 4** (owner, after the panel, finding 6). The adapter opens
`sessionSlots` (default 4) single-connection clients beside the 3 root and 5 transaction ones: 12
of the role's 20 per process. All four are transaction slots: every hub call is a write transaction
or a snapshot (D6, D7), and hub code sends no root statement, so a root-equivalent slot would sit
unused. Consequences:
- heavy session traffic can only slow session calls; sign-in, catalog writes and key/value calls
  keep their own 8 connections and never wait behind a session transaction;
- the in-process FIFO lock runs one storage call per session at a time, so one session holds at
  most one session slot, and four sessions busy at once fill the pool; a fifth waits in the FIFO
  queue, inside its 10-second deadline;
- no transaction body nests the other kind (A12), and the existing guard turns any future nesting
  into a misuse error instead of a cross-pool deadlock. The same guard refuses a call on *another*
  session's hub from inside a hub transaction (it is an adapter call inside an open attempt) and
  fails that outer transaction; 7a allowed such a call. Production never makes one (A12), so the
  spec states the refusal and the 7a test that called another hub is rewritten (D12, panel
  finding 7);
- the integration test container's role limit rises from 200 to 280 (`pgIntegrationSetup.ts`;
  its `max_connections` is 300): 12 per bindings instance across up to 19 workers is 228 at the
  peak, above the old 200. The `pg` project's container keeps 20, which `catalogSchema.pg.test.ts`
  asserts.

**Alternative** (the first draft): share the 5 transaction slots. Rejected by the owner: a burst of
session work (a 0.3 s transcript replace, a run of event adds on several sessions) would delay
sign-in and catalog writes.

**Deadline: 10 seconds, as the catalog's.** This resolves the owner's 7a revisit item ("a hub
transaction that hangs holds the session's lock and soft-locks that session"): at the deadline the
adapter cancels the statement in flight, the transaction ends on the server, the call rejects with
`CatalogTxTimeoutError`, and the hub's FIFO lock is released with it, so later calls on the
session run. A body that never resolves can no longer reach the connection (its handle is closed).
The row-lock wait is inside the same deadline, and the role's 30-second `statement_timeout` backs
it.

**Retries and the body.** A `40P01` re-runs the body on a fresh attempt. The hub builds a new
transaction-bound core per run, so the first run's held broadcasts and alarm are dropped (D7);
7a's callbacks (`mergeMetadata`, `remap`) are pure, and ids drawn with `randomUUID` inside the body
are simply redrawn. A deadlock needs two lock orders; session transactions take the session row
first and touch only that session, so the realistic source is a catalog transaction on the same
`sessions` row, which A6 shows surfaces as `40001` in the catalog transaction (retried there), not
in the session one.

**An unconfirmed rollback** retires the connection (the catalog's policy, unchanged). The hub no
longer closes itself: there is no hub connection to distrust (D9).

**Constraints this leaves for 7b-2** (panel finding 3). 7b-1 binds every session statement as
`system('session-hub')`; 7b-2's per-user binding cannot be a one-line swap, because:
- **the seam carries no caller.** The registry builds one storage root per hub, and one hub serves
  every user on that session. 7b-2 has to pass the binding per call through the seam (each `tx`
  and `snapshot` takes the caller's binding, or the hub method receives a bound storage), not per
  hub;
- **the lock and the projection run under the caller's policy.** Under a user binding,
  `SELECT … FOR UPDATE` and the projection `UPDATE` on `catalog.sessions` go through
  `sessions_user_update` (`accessible_shows`). A writer without access then gets zero rows, which
  7b-1's adapter reports as `SessionNotFoundError`. 7b-2 must tell "no access" from "no session"
  (for example, lock under the system binding after an access check, or a definer helper), and
  answer the refusal the routes already give;
- **background writers have no caller**: the lease alarm, transcript generation, AI turns
  (`create_event`, `create_topic`, dashboards) and the log-import job. They need reviewed system
  bindings of their own, as 6b-1 gave detached catalog work.

## D3. The `SessionSql` seam

```ts
/** A body's handle, scoped to one transaction or snapshot (async-session-hub D2's contract). */
export interface SessionSql {
  all<T = Row>(sql: string, ...binds: SqlValue[]): Promise<T[]>;
  run(sql: string, ...binds: SqlValue[]): Promise<{ changes: number }>;
  /** Joins the enclosing transaction or snapshot. */
  tx<T>(fn: (t: SessionSql) => Promise<T>): Promise<T>;
}
/** One session's storage: every write is a transaction that holds the session's row lock; every
 * multi-statement read is one read-only snapshot. */
export interface SessionStorage {
  tx<T>(fn: (t: SessionSql) => Promise<T>): Promise<T>;
  snapshot<T>(fn: (t: SessionSql) => Promise<T>): Promise<T>;
}
```

- `exec` is removed: there is no DDL in session-core any more, and the seed is two `run`s (D9).
  The spec scenario "Schema init retains a multi-statement path" goes with it.
- There are no root `all`/`run` on `SessionStorage`: a root statement would bypass the row lock,
  and every hub call is a transaction or a snapshot (D6). `SessionCore`'s root instance has no SQL
  handle; only transaction- and snapshot-bound cores do.
- The transaction contract is 7a's (joins, any error fails the whole transaction, misuse rejects,
  handled promises) plus: the body runs only after the session row lock is held; a missing
  session rejects with `SessionNotFoundError` before the body runs; the body may run more than
  once (deadlock), so it must have only database effects.
- `SqlValue` stays `string | number | null`. Set-valued parameters are one JSON text bind
  (`?::text::json`, A9), not an array type: the seam stays scalar and each statement has one
  prepared text, whatever the set's size.
- The port stays in session-core (core-ports-architecture keeps it there); the delta restates the
  seam.

## D4. Session scoping and its guard

- **The runtime carries the id.** `SessionRuntime` gains `readonly sessionId: string`, and
  `SessionCore` exposes it. Every statement binds it explicitly: `WHERE session_id = ?` (first
  predicate, so every index serves it) or `session_id` as the first insert column. The hub, the
  storage root and the runtime are built from the same registry key, so the lock and the
  predicate name the same session.
- **Rejected: adapter-side scoping** (a `set_config('app.session_id', …)` plus views or policies
  that filter on it). It hides the predicate from the SQL a reviewer reads, needs policies 7b-1
  deliberately does not have, and still leaves inserts to name the column.
- **Guard 1, a repo test** (`server/src/sessionSql.repo.test.ts`, mutation-checked like the
  other repo tests): every SQL string or template literal in `packages/session-core/src`
  production files (a literal starting with `SELECT`, `INSERT`, `UPDATE`, `DELETE` or `WITH`)
  contains `session_id`. That includes the interpolated `nextOrdinal` template and the projection
  update.
- **Guard 2, a behaviour test** (D12 "isolation"): every hub write method runs on session A while
  session B holds rows in all nine tables, and B's rows are byte-identical afterwards; every hub
  read on A returns none of B's rows. It fails today's code on the three unscoped transcript
  `DELETE`s.

## D5. SQL translations and values

| Today (SQLite) | Postgres |
|---|---|
| `events`, `meta` | `session_events`, `session_meta` |
| `session_transport … WHERE id = 1` | `… WHERE session_id = ?` |
| every statement | `session_id = ?` first in `WHERE`, or first insert column (D4) |
| `initSchema` (DDL + `INSERT OR IGNORE`) | two `INSERT … ON CONFLICT DO NOTHING` seeds at hub open (D9) |
| `ON CONFLICT(key) DO UPDATE SET value = excluded.value` | `ON CONFLICT (session_id, key) DO UPDATE …`; dashboards `(session_id, id)` |
| `CAST(CAST(value AS INTEGER) + 1 AS TEXT)` | `(value::bigint + 1)::text` (the value is only ever written by this statement and the seed) |
| `json_valid` + `json_type(…, '$.auto_generated') = 'true'` | `coalesce(case when pg_input_is_valid(metadata_json, 'jsonb') then (metadata_json::jsonb -> 'auto_generated') = 'true'::jsonb end, false)` |
| `json_extract(metadata_json, '$.<key>') IS NOT NULL` (path bound) | `coalesce(case when pg_input_is_valid(metadata_json, 'jsonb') then jsonb_typeof(metadata_json::jsonb -> ?) <> 'null' end, false)` (key bound) |
| `lower(trim(category)) != 'internal'` | unchanged (A3) |
| `COALESCE(MAX(ordinal), -1) + 1` and `COALESCE(MAX(ordinal), 0) + 1` | unchanged, plus the session predicate; the row lock makes the read-then-insert safe across processes |
| `SELECT * FROM events` (rowid order) | `… ORDER BY wall_time_utc, id` (A14) |
| `ORDER BY ordinal` | `ORDER BY ordinal, id` (ordinals are unique per session; `id` only makes ties impossible to reorder) |
| `DELETE … WHERE id IN (?, …)` chunked by 500 (`deleteEventsByIds`), unbounded (`deleteTopics`) | `… AND id IN (select json_array_elements_text(?::text::json))`, one statement; `deleteEventsByIds` keeps one broadcast iff the total deleted count is > 0 |
| one `INSERT` per word, paragraph and sentiment row | one `INSERT … SELECT … FROM json_to_recordset(?::text::json)` per table, ids drawn in JavaScript, ordinals by array position, as today (A8) |
| `?` placeholders | unchanged; the adapter's `toPg` rewrites them. No statement may use the `jsonb` `?` operator, which `toPg` would rewrite |

Notes:
- **The JSON predicates** keep the pinned corpus (A2), so the route's JavaScript predicate and the
  SQL still agree on every corpus row. Two differences outside the corpus, both recorded in the
  test file as new corpus rows: duplicate keys now resolve to the last value, as JavaScript does
  (SQLite took the first); and metadata with a `\u0000` escape is not valid `jsonb`, so it reads
  as not auto-generated (JavaScript says yes). Generated events' metadata is built from catalog
  labels, which cannot hold NUL, so the second cannot arise for them. The relink pre-check no
  longer throws on a malformed metadata row (SQLite's `json_extract` does, A2); such a row is
  skipped, as the relink loop already skips it.
- **`changes`** is the server's affected-row count, so `deleteEventsByIds`,
  `setAudioSegmentWaveform`, `deleteTranscriptWord`, `deleteTopic` and `deleteDashboard` keep
  their not-found results.
- **Integers.** int8 reads as a number (the adapter's parser), so stored values compare as today.
  A fractional or out-of-range bind into a `bigint` fails (`22P02`/`22003`, A4) where SQLite stored
  a real. A11 finds two inputs that can carry one; each now follows the path its malformed input
  already takes, so no response changes for an in-range value and no new `4xx` is frozen:
  - `recording_ordinal` on `POST …/audio/segments`: a digit string whose number is not a safe
    integer (`!Number.isSafeInteger`) is treated as absent (`null`), as a non-digit value already
    is; the segment is stored and the response stays `200`;
  - a sheet log timecode whose seconds, at 120 frames a second, would not be a safe integer is
    unparseable (`parseSheetTimecodeToSeconds` returns `null`), so the row is dropped at fetch as
    any unparseable timecode row already is.
  Every other bigint bind is in range by construction (A11).
- **Floats.** `extra_float_digits: 1` on every connection (D2, A10).
- **NUL.** `checkText` refuses a bind with U+0000 before it is sent (`CatalogInvalidTextError`,
  which `app.onError` already answers with `400`). Inside a hub write this fails the transaction,
  so nothing is saved and no frame is sent. api-contract-freeze "Text containing NUL is refused"
  is extended to session content. Background writers (transcript generation, AI tools, the log
  import) get the same error from their hub call and report it through their existing failure
  paths.
- **NUL inside a JSON set bind** (panel minor). The transcript replace's words, paragraphs and
  sentiment and the id sets travel as one JSON text bind, where a NUL character appears as the
  escape `\u0000`, which `checkText` does not see. Postgres refuses it while de-escaping (`22P05`),
  mid-transaction, so the write still saves nothing and sends no frame; only the error class
  differs (a generic `500` instead of `400`). Only server-side sources fill these binds (provider
  words, the remap, ids the server minted), never a request body, so the `400` of the NUL
  requirement is not at stake. This is documented rather than detected: scanning JSON text for the
  escape would also refuse a literal backslash sequence a user typed.
- **`LIMIT`/`OFFSET`** are bound as today; the route clamps them (A11), so the negative-`LIMIT`
  difference (A4) is unreachable.

## D6. Reads: one snapshot per hub read

Every hub read runs its whole body in one `storage.snapshot()` (`REPEATABLE READ READ ONLY`) under
the FIFO lock, as 7a ran it under the lock with no transaction. This covers the multi-statement
reads (`ensure`/`projection`: 2 statements; `listEvents`: 4; `statusLive`: 4; `leaseStatus`: 2;
`listTranscriptEnrichment`: 2) and the single-statement ones alike. One rule is easier to check
than a per-method list, and the cost is one extra round trip per read (`BEGIN` and the preamble
are pipelined, A0b).

**Alternative:** single statements as root statements on the root slots, snapshots only where a
read has several statements. Rejected for 7b-1: it splits the reads across two kinds of slot and
two isolation paths for one round trip; it can be revisited from measurements.

The FIFO lock still serializes reads behind earlier writes in the process, so a read issued after
a write returns that write's state, as in 7a.

## D7. Writes: the row lock, retries, broadcasts and the alarm

- **Every hub write** (`inTxn`, the alarm's `expireIfStale`, the open's seed) runs in
  `storage.tx()`, which takes the session row lock before the body (D2). Two processes writing
  one session therefore serialize in the database (A5), and a read-then-write inside one hub
  method (the 7a methods, `MAX(ordinal) + 1`, the dashboard count check, the lease checks) sees
  the committed state of every earlier writer.
- **Per attempt.** The hub's `transaction()` callback runs once per attempt. It builds a fresh
  transaction-bound core each time and discards the previous attempt's held broadcasts and alarm
  first, so only the committed attempt's effects are applied (7b hazard 4).
- **The alarm is held like the broadcasts.** On a transaction-bound core, `setAlarm(at)` records
  the request (the last one wins, as the single slot does today); the hub arms it after `COMMIT`,
  with the flush, and drops it on failure. Two reasons:
  - a timer armed inside the adapter's attempt keeps the adapter's `AsyncLocalStorage` context
    (async-session-hub A11's mechanism), and if that attempt later failed, every alarm run would
    be refused by the adapter's "catalog call from a transaction that failed" guard, forever. Arming
    after `await storage.tx()` returns runs outside that context;
  - a rolled-back or retried lease body no longer leaves an alarm armed. 7a kept the old
    behaviour ("an alarm armed inside a transaction that rolls back stays armed"); its test changes
    to the new one (D12).
- **The imported take's anchor refuses a rolling transport** (owner decision 1, S4/S5).
  `anchorImportedTake` reads the transport inside its transaction, after the row lock, and if it is
  rolling throws `ImportWhileRollingError` (session-core) before writing anything. Both import
  routes already re-check `is_rolling` after the blob put; they map this error to the same outcome
  as that check: the local import calls `rollbackLocalAudioImportSegment` and answers `409`
  `LOCAL_AUDIO_IMPORT_ROLLING_DETAIL`; the YouTube import deletes the segment and answers `409`
  `YOUTUBE_IMPORT_ROLLING_DETAIL` (today an anchor failure there becomes a `502`, so the error is
  mapped before that catch). A take that starts after the anchor commits is unaffected, as today.
- **Flush order.** Broadcasts flush after `COMMIT` and before the FIFO lock is released, as in 7a.
  Within one process that keeps commit order. Across processes there is only one process per
  `DATA_DIR` until slice 8 (7b hazard 2 stays carried).

## D8. The live projection commits with the write; the mirror retires

- **Which writes.** A transaction-bound core marks itself projection-dirty in `bumpRevision()`
  (every events change bumps the revision: add, update, delete, delete-by-ids with a count > 0,
  relink) and in the three transport writers (`startTake`, `stopTake`, `stopTakeWithDuration`).
  After the body and before `COMMIT`, a dirty transaction runs one statement:

  ```sql
  UPDATE sessions s SET event_count = e.n, max_timecode_total_frames = e.mx,
    is_rolling = t.is_rolling, current_take = t.current_take,
    transport_elapsed_frames = t.elapsed_frames, roll_started_at_utc = t.roll_started_at_utc
  FROM (SELECT count(*) AS n, max(timecode_total_frames) AS mx
        FROM session_events WHERE session_id = ?) e, session_transport t
  WHERE s.id = ? AND t.session_id = ?
  ```

  It must change exactly one row; otherwise the transaction fails (`SessionProjectionError`, which
  can only mean a missing transport seed). The values are exactly `SessionCore.projection()`'s,
  which the mirror wrote. Cost: one round trip on top of the write (A7: about 1.4 ms on the host
  path including its share of the flush; in the stack one extra statement, A0b).
- **Alternatives.** Recomputing with `projection()` and a plain `UPDATE` (three round trips);
  incremental counters (`event_count + 1`): rejected, they re-derive what the events table already
  says and drift on any missed path. Writing after commit (keeping log-and-succeed): rejected by the
  owner's plan, it keeps the stale-list window and the out-of-order hazard.
- **Removed:** `server/src/sessionMirror.ts` and its test; `Ports.mirror`; the eleven call sites;
  `runSessionLogImport`'s `projectLive` input and `lastProjection` bookkeeping;
  `SessionIndexStore.projectSessionLive` and its facade member; the `session-mirror` binding and
  allowlist entry; `mirror.close()` in the composition root's `close`.
- **Observable differences** (all failure paths; none for a serial request that succeeds):
  - a projection failure, or any failure inside the write, fails the whole write: no change saved,
    no frame, the route's error status (`500`; `502` for a YouTube import, whose segment is rolled
    back by the route as on any anchor failure). Before, the change was saved, the route answered
    success, and a warning was logged. api-contract-freeze "Catalog mirror failures don't fail
    saved session changes" is retired, and the YouTube table's success row drops "or
    catalog-mirror". The episode-date write stays best-effort and is unchanged;
  - `GET /api/sessions` shows a write's counts as soon as the write's response is sent (before,
    once the awaited mirror write landed, or never if it failed);
  - the warning `[mirror] session … live projection not written` is gone.
- **Specs:** catalog-database "Session live projection is mirrored in order" is replaced by "The
  session live projection commits with the session write"; auto-event-generation's mirror wording
  is replaced (the run's inserts and the regenerate delete each commit their projection).

## D9. The hub and the registry without connections (7b hazard 6)

- **`SessionHub.open(sessionId, storage, clock)`** replaces `open(dbPath, clock, opts)`. In one
  write transaction (the row lock first) it seeds `session_transport (session_id)` and
  `session_meta (session_id, 'events_stream_revision', '0')` with `ON CONFLICT DO NOTHING`, then
  runs `expireIfStale`. No file, no pragma, no `mkdir`. A session with no `catalog.sessions` row
  rejects with `SessionNotFoundError`, and the registry keeps nothing.
- **Session create** seeds when the route's existing `ensure()` opens the hub, right after the
  create transaction (A13). The plan's "seed inside the create transaction" cannot work in 7b-1:
  that transaction is user-bound, and `catalog_user` holds no privilege on session tables (A4,
  D1). Seeding at open is what `initSchema` does today, and it covers sessions created before the
  migration (start empty). Between the create's commit and the open, the session has a catalog
  row and no seed rows; a hub read in that window (none exists: the route itself opens the hub)
  would see the same empty state `projection()` and `transportRow()` already default to.
- **`SessionHubRegistry({ storage: (sessionId) => SessionStorage, clock })`** replaces
  `(sessionsDir, clock, options)`. The id check (`SESSION_ID_RE`, today's message) stays. `get`
  for an unknown session rejects (it used to create an empty `.db`); every route reaches `get`
  only after `requireSession`, so no route sees that.
- **Eviction** keeps its rule and timing; it now frees memory (sockets, the alarm, the lock), not a
  file handle. `close()` stops the alarm and drains the FIFO lock; there is nothing else to close.
  `closeAll()` is unchanged in shape.
- **A failed `ROLLBACK`** is the adapter's concern (it recycles the connection, D2). The hub no
  longer reads `rollbackFailed`, and `closeAfterFailedRollback` and `onBroken` are removed: the
  next call simply gets another connection. `SessionHubClosedError` remains for calls on a closed
  hub.
- **The lease alarm** keeps its rule and backoff (7a D6) and is armed after commit (D7).
- **`SessionHubOptions.sql`** (the SQLite test seam) is replaced by wrapping `SessionStorage`:
  tests pass `(id) => slowStorage(db.forSession(id))` (D12).
- **The SQLite adapter and `better-sqlite3` leave session-core**: `sqliteSessionSql` and
  `SqliteSessionSql` are deleted; `SessionHubClosedError` and `SessionTxMisuseError` stay in
  `asyncSessionSql.ts`; `package.json` drops the peer and dev dependency. `@autologger/storage`
  keeps `better-sqlite3` for `dataDirLock.ts`.

## D10. Wiring, scripts and docs

- **`server/src/node/config.ts`:** `const sessions = new PostgresSessionDb(catalogDb.bindSystem('session-hub'))`;
  `new SessionHubRegistry({ storage: (id) => sessions.forSession(id), clock })`; no `mkdirSync(…
  'sessions')` (the directory, if present, is left as is); no mirror. `close()` awaits
  `registry.closeAll()` then `catalogDb.close()`, as today minus the mirror.
- **`server/src/appEnv.ts`:** `Ports.mirror` removed.
- **`server/scripts/merge-session-audio.ts`:** reads `ordinal, r2_key` from
  `session_audio_segments` through `PostgresSessionDb.forSession(id).snapshot(…)`, using the
  process's `PG*` settings (it runs in the dev shell, which has them). It no longer opens a `.db`
  or imports `better-sqlite3`, and it says "no audio segments" for an unknown session as it does
  today for a missing file.
- **`server/scripts/copyDataDir.ts`:** unchanged; it copies whatever legacy `*.db` files exist.
- **README:** the architecture blurb and diagram (`:10-12`, `:47`), the dashboard note (`:406`),
  the `DATA_DIR` layout (`:464-470`), the package map (`:596-604`), the env table's `DATA_DIR` row
  (`:880`) and the volume table (`:1076`) say session content is in Postgres and
  `sessions/*.db` is legacy, kept for slice 11. The backup and restore section (`:1191-1320`)
  describes prod, which still runs `main` with SQLite until cutover; it gains one sentence saying
  so, and nothing else.

## D11. Measurement and the stop rule

- **Where.** The app reaches Postgres over the stack's network: about 34 µs a round trip and
  about 0.3 ms for a flushed commit (A0b). From the host through docker's published port it is
  about 107 µs and 1.9 ms (A7), which would dominate. The stop rule is therefore measured in the
  stack.
- **`spike/bench7b.mts`** (added in task 1.3, pinned like the spike) runs inside the dev app
  container against the dev database after `make dev-up` has applied the migration. It creates a
  throwaway show and session through a system binding, runs 7a's sequence (5 runs × 5,000
  awaited `addEvent`, then 5,000 `listEvents({ limit: 200, offset: 0 })`, each run on a fresh
  session) and a 31,621-word `replaceTranscriptWords` three times, then deletes everything it
  created. It reports medians beside 7a's (166 µs and 426 µs, async-session-hub task 6.1). The
  host-path spike numbers (A7, A8) are the upper bound.
- **Expected** from A0b: an event add is about 11 round trips plus a flush, about 1 ms; a
  `listEvents` snapshot about 0.5 ms; the replace well under 1 s (A8's batch is 0.3 s on the slower
  path).
- **Stop rule (owner, confirmed after the panel):** stop and ask the owner if, in the
  stack, the median `addEvent` exceeds 5 ms or the 31,621-word replace exceeds 10 s (the
  transaction deadline). ADR 0021's "revisit if measured write latency hurts live recording"
  applies. A slower `listEvents` is recorded, not a stop.
- **Post-approval (owner, 2026-10-03, after task 8.2):** the in-stack median `addEvent` measured
  5.4-5.6 ms (7a SQLite 0.17 ms), mostly ~2.2 ms fixed per session transaction inside the adapter
  (probe: empty session tx 2182 µs; root `select 1` 412 µs vs raw 29 µs). Accepted as imperceptible
  for live logging; the `addEvent` limit is raised to 10 ms (the 10 s replace limit is unchanged);
  optimising the per-transaction overhead is a follow-up (ADR 0021 revisit list).

## D12. Tests

**Where they run.** The DB-backed session tests need the Postgres adapter, and no package may
import `@autologger/storage` (A17). As the catalog did (catalog-on-postgres D6), they move to the
server's `integration` project, which already gives every test its own clone and bindings
(`resetTestEnv`) and the integration container, whose role limit rises to 280 (D2):
- `server/src/test/session/` receives the 13 DB-backed session-core test files (about 190 tests)
  as `*.int.test.ts`, the DB part of `eventAnchors.test.ts`, and the hub-using package tests
  (`ai-runtime`'s `aiMcpServer`, `mcpTools`, `topicGenerate`; `log-import`'s
  `runSessionLogImport`; `transcription`'s `generateTranscript.remap`). They import the packages
  through their `@autologger/*` exports; package fixtures are addressed through the packages'
  exported path constants (package-architecture "A service package … owns its test fixtures").
- `server/src/test/session/sessionRows.ts` creates the `catalog.sessions` row (and a show) a test
  needs, and `rawRows(storage, table)` / `insertRaw(storage, table, row)` read and write raw rows
  with `session_id` filled in; `slowStorage.ts` replaces `slowSql.ts` (yields to a timer between
  statements, injects a failure); `fakeCore.ts` is deleted, and `packageBoundaries.repo.test.ts`'s
  exemption list drops it.
- **The bound-core harness** replaces `fakeRuntime()` (panel finding 8: 22 calls in 6 files, and
  about 27 raw `core.db.run`/`all`/`core.first` calls, which a root core can no longer make since it
  has no SQL handle). `boundCoreOn(storage, sessionId)` in `server/src/test/session/boundCore.ts`
  returns `{ core, run, broadcasts, alarms }`: `run(fn)` executes `fn(stores)` inside one
  `storage.tx`, over a transaction-bound core, then flushes its broadcasts into `broadcasts` and
  records an armed alarm in `alarms` after the commit, as the hub does (D7); a read uses
  `storage.snapshot` likewise. A test that called `store.method()` on a fake runtime calls
  `run((s) => s.events.method())`, with the same assertion.
- session-core keeps its pure tests (`audioSeamParts`, `fifoLock`, the pure part of
  `eventAnchors`).

**The contract suite** (`packages/storage/src/test/sessionSqlContract.ts`, run by
`postgresSessionSql.pg.test.ts` in storage's `pg` project): commit; rollback on a throw, including a
statement error the body catches; a joined `t.tx`; misuse (a handle after its transaction, a body
returning while a joined body runs, a root call inside an open transaction); the lock is held
before the body (a second connection's `FOR UPDATE` waits); a missing session rejects with
`SessionNotFoundError` and runs no body; a snapshot sees one state while another connection commits
between its statements, and refuses a write (`25006`); an unconfirmed rollback retires the
connection and the next call works; a `40P01` (injected through the adapter's `connect` seam) re-runs
the body and the caller sees one result; the deadline releases a hung body; NUL is refused; a
`double precision` reads back exactly (A10); a JSON text bind (A9).

**Domain tests on Postgres.** Assertions stay as they are, except this list; any other change to an
expected value is a stop:
- raw-row fixtures and raw `INSERT`s gain `session_id` and the new table names;
- `sqlite_master` checks become catalog checks (the seed rows exist after open);
- tests that opened a file path, reopened it for persistence, or counted `.db` files use a session
  id and a second registry over the same database;
- the failed-`ROLLBACK` tests (7a D6) assert the adapter's policy: the call rejects, the hub stays
  open, and the next call succeeds on another connection;
- 7a's statement that an alarm armed inside a transaction that rolls back stays armed
  (async-session-hub D6; no test pins it) is reversed, and a new test pins "is not armed" (D7);
- `eventStore.test.ts:210` ("chunks a 1,001-id delete into multiple statements") keeps its
  counts and its one broadcast; its title and comment drop the chunk boundary, which no longer
  exists;
- the mirror tests are deleted or rewritten to the projection (D8): `sessionMirror.test.ts`,
  `mirrorFailure.int.test.ts`, and the mirror cases in `SessionHub.int.test.ts`,
  `events.generate.int.test.ts:1019` and `logImport.int.test.ts:616`;
- the parity corpus gains the two rows of D5;
- the `fakeRuntime()` tests move to the bound-core harness (their calls are wrapped in `run`, and
  their raw `core.db` statements go through `rawRows`/`insertRaw`), with the same assertions;
- `SessionHub.concurrency.test.ts:170` ("a hub delegate inside its own transaction rejects …; the
  outer still commits, and another hub works") keeps its same-hub half; its other-hub half now
  asserts that a call on another session's hub from inside the transaction also rejects promptly,
  with the adapter's misuse error, and that the outer transaction then rolls back (panel finding 7:
  the adapter refuses any adapter call inside an open transaction, A12; production never nests).
- the promise-hygiene repo test (post-approval, task 4.1 stop; no scope change). Its "session-core
  has more than 10 test files" floor moves to the moved files: at least 10 files under
  `server/src/test/session/`, scanned by the server program. The three promise-identity checks in
  the moved `aiMcpServer` test (`expect(a).toBe(b)` on two promises) become
  `expect(a === b).toBe(true)`. The checker itself is unchanged.
- test plumbing found in group 5 (post-approval; no assertion changes, no scope change):
  - `sessionHub.interleave.int.test.ts` gets a 30 s timeout. With real database I/O it takes about
    3 s alone and up to 7 s under the parallel suite. Its observables are unchanged, and its lock
    waits are recorded as data;
  - fake timers in the moved tests leave postgres.js's timers real. Tests that only move time fake
    `Date` alone, and the hub timer tests use `DRIVER_SAFE_FAKE_TIMERS` (real `setImmediate`);
  - the opt-in real-CLI tests (`eventGenerate.real`, `topicGenerate.real`) get Postgres session
    storage from the process's PG* settings (`server/src/test/realSessionStorage.ts`).

**New tests** (written first, red where today's code allows):
- **cross-process serialization:** two registries over two adapter instances (two processes)
  toggle one session's take concurrently, 100 pairs; the transport ends as a serial order leaves it;
  two `addImportedAudioSegment`s through the two registries get distinct consecutive ordinals;
- **isolation** (D4 guard 2), red today on the unscoped transcript `DELETE`s;
- **the projection commits with the write:** after each projection-changing hub method the
  `catalog.sessions` row equals `ensure()`, read immediately; a write whose body fails after its
  insert leaves both the events and the projection unchanged; a forced projection failure fails the
  write;
- **foreign keys:** content rows for an unknown session are refused (`23503`), and `get` for an
  unknown session rejects with `SessionNotFoundError` and leaves nothing;
- **the migration:** in `catalogSchema.pg.test.ts`, a session row with a non-zero projection in a
  database migrated up to 20261007 reads zeros after `20261008` is applied; `catalog_user` is
  refused on all nine tables;
- **the guard:** `sessionSql.repo.test.ts` (D4) with its mutation fixtures;
- **the alarm** runs outside the adapter's async context (a real-timer test like 7a's);
- **the anchor refuses a rolling transport** (D7): a take started after a local import's, and after
  a YouTube import's, post-blob rolling check (forced through `slowStorage` between the route's check
  and the anchor) yields that route's existing `409` detail, no `Recording N` events, the transport
  still rolling, and the segment rolled back as the route's post-blob refusal does;
- **the session pool cannot starve the catalog** (D2): with all four session slots held by slow
  snapshots (`slowStorage`), a catalog transaction (`PUT /api/profile`, and a session create's
  catalog transaction) completes in under one second, and a fifth session call waits and then
  completes once a slot frees, or times out at 10 s;
- **bounded integer inputs** (D5): `POST …/audio/segments?recording_ordinal=` with a 20-digit value
  answers `200` and stores the segment with no recording ordinal; a sheet row with a 20-digit hour
  is dropped at fetch (`parseSheetTimecodeToSeconds` returns `null`).

**Server suites.** The integration suite (about 1,196 tests) passes; `sessionHub.interleave.int.test.ts`
passes with the same observables (frames strictly increasing, final revision, final event set, each
conflicting pair a serial order).

## D13. 7a's documented sequences and the 7b hazards

| 7b hazard (ADR 0021 slice 7) | Status after 7b-1 |
|---|---|
| 1. observables without the embedded lock | Resolved: the row lock first (D7, A5) and one snapshot per read (D6); the FIFO lock also stays |
| 2. broadcast order across transactions | Held in-process by the FIFO lock (D7); carried to slice 9 for several processes |
| 3. the sequences S1, S2, S5, S7, S8, S11 | S4/S5 resolved (the anchor re-checks inside its transaction); S1, S2, S7, S8, S11 carried, widened (below) |
| 4. a re-run body has only database effects | Resolved: broadcasts and the alarm per attempt (D7); `mergeMetadata`/`remap` stay pure |
| 5. a `create_event` insert in flight when its turn ends | Carried unchanged (7a D8 counts successful inserts only) |
| 6. the registry stops owning connections | Resolved (D9) |
| 7. the mirror chain retires | Resolved (D8), with slice 4 hazards 3, 4, 17 and the `live_revision` follow-up |

With every statement doing I/O, the documented sequences can split on any concurrent request, not
only when two handlers resume in one tick:
- **S1** (GET events: relink, page, `has_auto_generated`), **S2** (status and lease), **S7** (sync,
  then list), **S11** (generate's word and event snapshots): each response field is still one a
  serial order produces; shapes and statuses are unchanged. Documented.
- **S8** (topics generate's after-read, delete, read): a manual topic inserted in the window survives;
  harmless. Documented.
- **S4/S5** (local and YouTube import: the rolling re-check, then `anchorImportedTake`) were the
  one documented sequence that could write from a stale read: a take started between the two was
  clobbered by the anchor's `stopTakeWithDuration`. Resolved (owner decision 1): the anchor
  re-checks inside its transaction (D7). The route's earlier checks stay, so the common case still
  refuses before any work.

## D14. ADR 0021

Slice 7's entry gains a 7b-1 paragraph in the 7a style: the split into 7b-1/7b-2 and the owner
decisions, including those after the panel; the mechanism (tables in `catalog`, the session mode
on the catalog adapter with its own 4-connection pool, the row lock first, snapshots, `40P01`
retries, the 10-second deadline resolving the 7a revisit item, the projection in the transaction,
the anchor's rolling re-check); the hazard table of D13; and the 7b-2 scope with D2's three
constraints: the binding passed per call through the seam (not per hub), the lock and the
projection run under the caller's policy with missing access told apart from a missing session,
and reviewed system bindings for the background writers (the lease alarm, transcript generation,
AI turns, the log-import job).
The slice list's 1.3 `postgres-backups` line and the Consequences gain: **backups are a cutover
blocker** (owner, 2026-10-03), built as their own change before slice 11, because session content
now lives in Postgres and nothing backs it up yet.

## Risks / Trade-offs

- [Write latency: every session write is a Postgres transaction with a WAL flush, about 6x 7a's
  SQLite cost by A0b's estimate] → measured in the stack against the stop rule (D11); the ADR's
  revisit condition applies.
- [One member can saturate the 4-slot session pool (several sessions written at once, a burst of
  transcript replaces) and slow every other session's calls] → catalog, sign-in and key/value calls
  are unaffected (their own 8 connections, tested, D12); a session call that cannot get a slot
  within its 10-second deadline fails with `CatalogTxTimeoutError` ("waiting for a connection"),
  the route answers its generic `500`, and nothing is saved. ADR 0021's revisit list already holds
  the follow-up: a rate limit (on team writes there; it extends to session writes), and the
  pool size is one constructor option.
- [Catalog `SERIALIZABLE` transactions that update a `sessions` row now conflict with live session
  writes (A6) and retry more] → the session row is touched by few catalog writes (rename,
  archive, hide, episode date); retries are jittered; the contention test can include them.
- [A missed `session_id` predicate leaks or deletes another session's rows] → two guards (D4) and
  the isolation test; 7b-2's policies add a database-side check per user, not per session.
- [The projection now shares the write's fate: a projection failure fails the write] → an owner
  decision (proposal "For the approver"); the update is one statement on a row the transaction
  already holds, so the realistic failures (connection loss, deadline) fail the write anyway.
- [Existing sessions read as empty on dev and stage until slice 11] → owner decision (start empty);
  the files are untouched; no prod step.
- [No backups of session content in Postgres] → recorded as a cutover blocker (D14); dev and stage
  data are disposable copies (ADR 0022).
- [Moving about 17 test files changes where failures show] → assertions are unchanged except D12's
  list; the moved files keep their names with `.int.test.ts`.
- [`extra_float_digits` changes how every float reads] → reads become exact; the recorded catalog
  values have short forms; covered by the contract suite.
- [The documented snapshot sequences S1, S2, S7, S8, S11 widen from same-tick to any concurrent
  request] → each response field is still a serial order's; shapes and statuses are unchanged (D13).

## Migration Plan

1. Merge into `supabase-migration`.
2. Dev: `make dev-up` applies `20261008000000_session_tables.sql` (the migrate service) and starts
   the app; every session reads empty, list counts 0.
3. Stage: `make stage-up`, with the owner's permission.
4. Rollback: redeploy the previous image. The tables can stay (the old code never reads them); its
   per-session files are untouched, and their projection columns are rewritten by the old mirror on
   the next change. A down-migration is not needed for the rollback.
5. Prod: unaffected until slice 11.

## Open Questions

None. The three questions of the first draft were decided by the owner after the panel ("Owner
decisions after the panel").
