# Session tables: session content moves into Postgres, with the live projection in the same transaction

Tier: 2
Tier reason: a migration (nine new tables in schema `catalog`, row-level security, and a reset of
every session's live projection), concurrency (the session hub's serialization moves from the
per-session SQLite file to a Postgres row lock under `READ COMMITTED`, with deadlock retries and
read snapshots), a storage port contract (`SessionSql` and the registry's construction), the
catalog adapter's connections (a new 4-connection session pool), and frozen API behaviour (a projection failure now fails the
session write it belongs to; NUL text in session content is refused). It touches
`supabase/migrations/**` and `server/src/routers/**`, both high-risk paths. ADR 0021 slice 7b-1.

Approved-by: Kalen 2026-10-03

## Why

Session content (events, transport, audio metadata, transcript, topics, dashboards and the
session's key/value meta) still lives in one SQLite file per session under `DATA_DIR/sessions/`.
That keeps the app single-process (slice 8 needs several), keeps session rows out of the
database's backups and policies, and forces a second, eventually consistent copy of each
session's live projection into `catalog.sessions` through an in-process mirror chain whose
failures are logged and dropped (slice 4 hazards 3, 4 and 17). Slice 7a made the hub
asynchronous behind `SessionSql` so this slice changes storage only.

## Owner decisions (owner, 2026-10-03)

Plan of record `parsed-honking-lobster.md`:
1. **Split 7b like 6b.** This change (7b-1) builds the tables, the Postgres session adapter, the
   wiring and the projection inside the hub's write transaction, retiring the mirror chain. Every
   session statement runs as the system task `session-hub` against allow-all system policies, so
   behaviour does not change for serial requests. 7b-2 adds the content policies (show access, as
   in 6a) and binds hub calls to the calling user.
2. **Serialization by row lock under `READ COMMITTED`.** Every session write transaction first
   locks the session's `catalog.sessions` row (`FOR UPDATE`). A read that needs several
   statements runs in one `REPEATABLE READ READ ONLY` snapshot. The in-process FIFO lock stays,
   to keep broadcast order, until slice 9.
3. **Start empty**, as 4c did. The old `sessions/*.db` files stay untouched for slice 11's
   import, and the live projection of every existing session resets to match its empty content.
4. **Backups** (slice 1.3, `pg_dump` + restic) were never built. ADR 0021 records them as a
   cutover blocker, done as their own change before slice 11, not in 7b.

Binding from earlier decisions: a faithful port (4a style: `text collate "C"`, `bigint`,
`double precision`, text timestamps, JSON as text); per-row versions and opt-in checks are 7c.

## After the adversarial panel (owner, 2026-10-03)

The three-reviewer panel found no critical issue and eight major ones (`panel.md`). The owner
decided (plan of record amended, "Owner decisions after the panel"):
1. **S4/S5 are fixed in this change:** `anchorImportedTake` re-checks `is_rolling` inside its
   transaction and refuses; each import route answers its existing `409` rolling detail and rolls
   the segment back exactly as its post-blob rolling refusal does today (design D7).
2. **The stop rule is confirmed:** a median `addEvent` above 5 ms, or the 31,621-word replace
   above 10 s, measured in the stack (design D11). After task 8.2 measured 5.4-5.6 ms, the owner
   raised the `addEvent` limit to 10 ms (owner, 2026-10-03; design D11).
3. **A projection failure fails the write;** the api-contract-freeze REMOVED requirement stands.
4. **Session calls get their own pool:** 4 connections beside the catalog's 3 root and 5
   transaction connections, 12 of the role's 20; heavy session traffic can only slow session
   calls, never sign-in or catalog writes (design D2).

Panel fixes folded in without a scope change:
- the unbounded `recording_ordinal` query value and an unbounded sheet log hour, the only inputs
  that could reach a session `bigint` out of range, are treated as absent and unparseable as their
  malformed forms already are, so no response changes (design A11, D5); the first draft's
  "event timecode beyond the 64-bit range" item was wrong (the `PUT` value is 8 characters) and is
  dropped;
- the 7b-2 constraints are stated (design D2, D14): the binding passed per call, the lock and
  projection under the caller's policy with missing access told apart from a missing session, and
  system bindings for background writers;
- a hub call on another session from inside a hub transaction is refused (the adapter's guard),
  and the spec scenario and the 7a test say so (design D12);
- the `fakeRuntime()` tests move to a named bound-core harness (design D12);
- NUL inside a JSON set bind is documented (design D5), and stale "per-session database" wording
  in unmodified specs is a hand edit at archive (task 8.4).

## For the approver

- **A failed projection write now fails the session write** (design D8). Today a session change
  commits in the session file and the catalog copy is written afterwards; if that copy fails, the
  route still answers success and logs a warning (api-contract-freeze "Catalog mirror failures
  don't fail saved session changes"). Now the projection is written in the same transaction, so
  a failure rolls the whole change back and the route answers its existing error (`500`; `502`
  for a YouTube import, whose segment is rolled back as on any other anchor failure). There is no
  longer a state where the change is saved and the list is stale, and no client retry repeats a
  saved change. The requirement is retired and the YouTube table's wording changes accordingly
  (delta below). Confirmed by the owner after the panel.
- **NUL in session text is refused with `400`** (design D5). Session statements now go through
  the catalog adapter, which refuses U+0000 before sending (api-contract-freeze "Text containing
  NUL is refused"). An event message, transcript word, topic or other session text containing
  NUL was stored by SQLite; it is now a `400` with no change saved. The requirement is extended
  to session content (delta below).
- **The session create seeds its rows when its hub opens, not in the create transaction** (design
  D9). The plan put the seed rows in the create's catalog transaction, but that transaction runs
  as the signed-in user, and 7b-1 gives `catalog_user` no privilege on session tables. The create
  route already opens the hub right after the transaction ("so its transport row exists"), and
  every hub open seeds idempotently, as `initSchema` does today.
- **The race windows of 7a's documented sequences widen** (design D13). S1, S2, S7, S8 and S11
  were splittable only when two handlers resumed in one tick; with real I/O they can split on any
  concurrent request. Each remains a combination of committed states with unchanged shapes and
  statuses. S4/S5, the one that could write from a stale read, is fixed (owner decision 1): a take
  started between an import's rolling check and its anchor now gets the route's existing `409`
  instead of being clobbered.
- **One busy member can slow other sessions** (design D2, Risks): the 4-connection session pool
  is shared by every session in the process; a session call that waits past its 10-second
  deadline answers the generic `500` with nothing saved. Catalog and sign-in calls are unaffected.
- **Every existing session reads as empty** (owner decision 3): events, takes, transcript, topics,
  audio list and dashboards, and the list's counts read 0. Audio blobs stay on disk; slice 11
  re-attaches the content.

## What Changes

- **Migration** `supabase/migrations/20261008000000_session_tables.sql` (design D1): the nine
  session tables in schema `catalog` (`session_events`, `session_transport`,
  `session_audio_segments`, `session_transcript_words`, `session_topics`,
  `session_transcript_paragraphs`, `session_transcript_sentiment`, `session_dashboards`,
  `session_meta`), each with `session_id` referencing `catalog.sessions` (no action) and every key
  and index led by it; row-level security with the `_system_all` policy only, and `catalog_user`'s
  privileges revoked; the projection columns of existing sessions reset. The recorded schema test
  gains the nine tables.
- **A Postgres session adapter** in `@autologger/storage` (design D2, D3): a session transaction
  mode on the catalog adapter's own connections (`READ COMMITTED`, the session row lock pipelined
  with `BEGIN` and the bindings preamble, retry on deadlock only, the 10-second deadline), a
  read-only snapshot mode (`REPEATABLE READ READ ONLY`), and `PostgresSessionDb`, which hands out
  a `SessionSql` per session over a `bindSystem('session-hub')` handle. Session calls run on their
  own pool of 4 connections (12 of the role's 20 per process); the integration test container's
  role limit rises from 200 to 280.
- **The `SessionSql` seam** (design D3): `all`, `run`, `tx` keep their contract; `snapshot(fn)` is
  added for multi-statement reads; `exec` (DDL only) is removed. A write transaction takes the
  session's row lock before its body runs and fails with a named error when the session does not
  exist.
- **session-core** (design D4-D7, D9): every statement names `session_id`, carried by the
  runtime; the SQLite dialect becomes Postgres (table names, JSON predicates, upserts, casts,
  `ORDER BY` where SQLite relied on row order, set-valued parameters as one JSON text bind, the
  transcript replace as one statement per table); `initSchema` becomes idempotent seed rows run
  when the hub opens; the hub owns no connection (no file, pragma or `mkdir`; eviction frees
  memory; a failed rollback retires the adapter's connection instead of closing the hub); every
  hub read runs in one snapshot; the lease alarm and the broadcasts are applied after commit,
  once per committed attempt; `anchorImportedTake` refuses a rolling transport inside its
  transaction (S4/S5). The SQLite adapter and `better-sqlite3` leave session-core.
- **Bounded integer inputs** (design A11, D5): a `recording_ordinal` that is not a safe integer is
  treated as absent, and a sheet log hour too large for a safe frame count makes the row
  unparseable, as their malformed forms already do.
- **The live projection commits with the write** (design D8): a hub write that changed events or
  the transport updates the six `catalog.sessions` columns in one statement inside its
  transaction. `SessionMirror`, `ports.mirror`, its eleven call sites, the log import's
  `projectLive`, `SessionIndexStore.projectSessionLive` and the `session-mirror` binding are
  removed.
- **Wiring and scripts** (design D10): the composition root builds the registry over the
  adapter and stops creating `DATA_DIR/sessions`; `merge-session-audio.ts` reads segments from
  Postgres; `copyDataDir.ts` keeps copying the legacy files; the README storage sections change.
- **Tests** (design D12): a shared `SessionSql` contract suite on the adapter; the DB-backed
  session-core tests, and the package tests that need a real hub, move to the server's
  integration project (the catalog's precedent, catalog-on-postgres D6) and run on Postgres
  clones; new cross-process, isolation, projection, foreign-key, reset, rolling-anchor,
  pool-isolation and bounded-input tests; a repo test that every session statement names
  `session_id`.
- **ADR 0021** (design D14): the 7b entry (the split, the decisions, 7a's hazards resolved or
  carried), and backups as a cutover blocker.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `catalog-database`:
  - MODIFIED "The catalog schema lives in Postgres schema `catalog`": the nine session tables join
    the recorded expectation.
  - ADDED "Session content tables": per-session keys, the foreign key, start-empty and the
    projection reset.
  - MODIFIED "Row-level security is enabled on every catalog table": the session tables have the
    system policy and no `catalog_user` privilege until 7b-2.
  - REMOVED "Session live projection is mirrored in order", ADDED "The session live projection
    commits with the session write".
- `core-ports-architecture`:
  - REMOVED "Session runtime is an asynchronous, per-session serialized, substitutable port",
    ADDED "Session runtime is an asynchronous, per-session serialized port on Postgres": the
    storage seam (`tx` with the row lock, `snapshot`, no DDL path), retries with one-time
    effects, session scoping, and the observables with new scenarios for two processes, one-state
    reads, isolation, an unknown session, a retried transaction and a hung one. Its "Schema init
    retains a multi-statement path" and "SessionCore is testable with a fake runtime" scenarios
    cannot stay, and OpenSpec refuses a MODIFIED block that drops a scenario.
  - ADDED "The Postgres session adapter": the catalog adapter's connections, `READ COMMITTED` with
    the row lock, deadlock-only retries, read-only snapshots, the shared deadline, exact floats.
  - MODIFIED "Every catalog call is bound to a caller": `session-hub` replaces `session-mirror`.
- `api-contract-freeze`:
  - REMOVED "Catalog mirror failures don't fail saved session changes".
  - MODIFIED "YouTube import endpoint behavior": the success row no longer mentions a mirror write.
  - MODIFIED "Text containing NUL is refused": covers session content.
- `auto-event-generation`: MODIFIED "Generated events append, bounded and attributable": the
  projection is current when the route responds because it commits with each insert and the
  regenerate's delete, and the mirror's log-and-succeed wording goes.
- `transcript-generation`: MODIFIED "Enrichment persistence and internal read": the two tables are
  session tables in the catalog schema, not tables of a per-session schema init.
- `package-architecture`: MODIFIED "Runtime dependencies checked by nominal identity are never
  duplicated": only `@autologger/storage` declares `better-sqlite3`.

- `youtube-audio-import`: MODIFIED "Import is refused while a recording is live": the anchor
  transaction re-checks the transport, so a take started during the import gets the same `409`
  (owner decision 1). (Its requirements never mention the mirror; the YouTube success wording lives
  in api-contract-freeze, modified above.)

## Non-goals

- **Content policies and user-bound hub calls** (7b-2).
- **Revisions, version checks, `409`s, the overwrite dialog, the audit** (7c).
- **Importing the legacy `sessions/*.db` files** (slice 11), and **backups** (their own change,
  before slice 11).
- **A typed schema** (`timestamptz`, `jsonb`, `boolean`): a post-migration follow-up, as for the
  catalog.
- **Retiring the in-process FIFO lock** (slice 9) and **session leases across processes**
  (slice 8). The lease stays in `session_meta` with its in-process alarm.
- **Making S1, S2, S7, S8 and S11 atomic.** They stay documented snapshot sequences (design D13).
- **A change to the app role's connection limit** (20; the session pool fits within it).
- **New runtime dependencies.**

## Impact

- **Code:**
  - `supabase/migrations/20261008000000_session_tables.sql`;
  - `packages/storage/src`: `postgresCatalogStore.ts` (the session and snapshot modes),
    new `postgresSessionSql.ts`, `index.ts`;
  - `packages/session-core/src`: `sessionCore.ts`, `SessionHub.ts`, the seven stores,
    `storeHelpers.ts`, `index.ts`; `asyncSessionSql.ts` loses its SQLite adapter (the errors and
    the misuse guard stay); `test/fakeCore.ts` is deleted; `package.json` drops `better-sqlite3`;
  - `packages/catalog/src/sessionIndexStore.ts` (`projectSessionLive` removed);
  - `packages/log-import/src`: `runSessionLogImport.ts` (`projectLive` removed), `sheetTimecode.ts`
    (an oversized hour is unparseable);
  - `server/src`: `node/config.ts`, `appEnv.ts`, `sessionMirror.ts` (deleted), routers
    `events.ts`, `companion.ts`, `sessions.ts` (the anchor's rolling refusal), `audio.ts` (the
    `recording_ordinal` bound), `logImport.ts`; `server/scripts/merge-session-audio.ts`;
    `test/pgIntegrationSetup.ts` (role limit 280);
  - tests: the storage contract suite; 13 session-core test files (and part of a fourteenth) and 5 package test files move to
    `server/src/test/session/`; `catalogSchema.pg.test.ts`, `catalogSystem.repo.test.ts`,
    `packageBoundaries.repo.test.ts`, the mirror tests (`sessionMirror.test.ts`,
    `mirrorFailure.int.test.ts` and the mirror cases of `SessionHub.int.test.ts`,
    `events.generate.int.test.ts` and `logImport.int.test.ts`).
- **Specs:** the deltas above.
- **Docs:** README storage sections; ADR 0021's slice 7 entry.
- **Operators:** the migration runs with `make <env>-up`, as every migration does. Existing
  sessions read as empty until slice 11. `DATA_DIR/sessions/` is no longer written. No new env
  var.
- **Performance:** a session write becomes a Postgres transaction with a WAL flush (design A7,
  A0b: about 1 ms in the stack for an event add); design D11 states the stop rule.
- **Connections:** 12 per server process (3 root, 5 catalog transaction, 4 session), within the
  app role's 20.

## After merge

Outside tasks.md, because they need the merged branch or `make stage-up` permission:
- **Dev live check** (`make dev-up`, which applies the migration): the 7a checklist (log, edit and
  delete events with a second tab open; start and stop takes; Companion log and transport
  toggle; topic and event generation; a local audio import); existing sessions load empty and
  their list counts read 0; the list's `event_count` and live badge update right after a change;
  `psql` shows the rows in `catalog.session_events`, and a `catalog_user` statement on them is
  refused.
- **Stage live check**, with the owner's permission for `make stage-up`: the same walk-through.
- **Prod:** prod runs `main` until slice 11's cutover, so no prod step here.
