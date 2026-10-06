# Design: session-row-versions (ADR 0021 slice 7c-1)

## Context

Since 7b-1, session content lives in nine `catalog.session_*` tables. Every hub write transaction
runs `READ COMMITTED` and first locks the session's `catalog.sessions` row (`FOR UPDATE`,
`packages/storage/src/postgresCatalogStore.ts:173`), so writes to one session are serialized across
connections and processes. Since 7b-2, every hub call is bound to a `SessionCaller`: a user or a
reviewed system task (`packages/session-core/src/sessionCaller.ts`).

Today:
- **Revision.** `events_stream_revision` is a `session_meta` text row (`sessionCore.ts:142`, seed).
  `bumpRevision()` (`sessionCore.ts:196`) increments it on every event change, and also marks the
  projection dirty. `revision()` reads it. Event writes broadcast `{type:'event.changed', revision}`
  with the post-bump value (`eventStore.ts:116,214,233,257`). The value is also returned by the
  session status (`events.ts:141`), the event list and `/api/companion/state`. Only event writes
  move it. An imported take's two `Recording N` events move it twice, with the intermediate frame
  suppressed (`eventStore.ts` `suppressBroadcast`).
- **Edits.** `PUT /events/:id` (`events.ts:642`), `DELETE /events/:id` (`events.ts:702`),
  `PATCH|DELETE /transcript-words/:id` (`transcribe.ts:195,211`) and `PATCH|DELETE /topics/:id`
  (`transcribe.ts:356,375`) are last-writer-wins. Each runs one hub method in one transaction:
  `updateEvent` reads, merges metadata and writes; the word and topic patches check existence,
  then run a partial `UPDATE`.
- **Row shapes.** Events go through `eventRowToRpc` → `enrichEventRpc` (`packages/domain/src/
  studio.ts:466`, an explicit dict). Words go through `wordApiDict` (`transcribe.ts:66`, an
  explicit dict). Topics are the store's `Topic` object as-is (`topicStore.ts:19`). Exports build
  their own four columns (`exports.ts:23-37`).
- **Audit.** None exists anywhere in the catalog.

Owner decisions (proposal): scope is the three hand-edited row kinds; the split is 7c-1 server and
7c-2 web; the revision is unified into `catalog.sessions.revision`; an overwrite is a retry with
the fresh version plus `overwrite: true`.

## Goals / Non-Goals

**Goals:**
- `catalog.sessions.revision` advances by one per committed session write that changes a row. It
  replaces the meta counter, and the wire names stay.
- Per-row `version` on events, words and topics, advanced by every writer.
- Opt-in version checks on the six edit routes: a `409` carrying the current row, atomic with the
  write.
- Overwrites audited in the same transaction, by the user.

**Non-Goals:** see the proposal. In short: no web change, no new frames, no versions elsewhere, no
audit reader.

## Assumptions and evidence

| # | Assumption | Command | Observed |
| - | --- | --- | --- |
| A1 | Every write to the three tables is a session-core store statement inside a hub write transaction (so it holds the session row lock), apart from test fixtures | `grep -rn -i "update session_events\|update session_transcript_words\|update session_topics\|insert into session_…\|delete from session_…" --include=*.ts packages server \| grep -v "\.test\.ts"` | 15 hits. 12 are in `eventStore.ts` (103, 203, 228, 251, 330), `transcriptStore.ts` (139, 165, 176, 207, 215) and `topicStore.ts` (60, 92, 103, 118); the rest are the test-only `sessionSqlContract.ts:349` and `server/src/test/pg/policyFixture.ts:26,31,33` |
| A2 | Moving the revision from a `session_meta` text row to a `catalog.sessions` bigint costs no more per write. A write that did not bump before pays one extra round trip | `docker exec -i autologger-dev-db-1 psql …` on temp copies of `catalog.sessions` and a meta table inside `begin … rollback`, 5,000 iterations each, server-side time | `meta bump + read: 63.5 us/op`; `sessions.revision bump returning: 25.5 us/op`. The round trip itself is the 7b-1 measurement: a root `select 1` took 412 µs in the stack (ADR 0021, 7b-1 stop rule) |
| A3 | A new table in `catalog` gets full DML for both roles by default, so the migration must revoke `catalog_user`'s select, update and delete on the audit table explicitly | `sed -n 77,80p supabase/migrations/20261006000000_catalog_roles.sql` | `alter default privileges for role postgres in schema catalog grant select, insert, update, delete on tables to catalog_user, catalog_system;` |
| A4 | No in-repo consumer compares `events_stream_revision` values, so widening its meaning breaks no client in this repo | `grep -rn "events_stream_revision\|\.revision\b" web/src companion/src --include=*.ts --include=*.tsx \| grep -v test` | Only types and comments: `web/src/api/types.ts:464`, `companion/src/state.ts:12`, `useEvents.ts:15` (comment), `SessionWorkspace.tsx:332` (comment) |
| A5 | Validation failures already answer `422 {"detail": [issues]}`, so the new field bounds need no new status | `grep -n "ZodError" server/src/app.ts` | `223: if (err instanceof ZodError) return c.json({ detail: err.issues }, 422);` |
| A6 | `list_topics` (AI tool) is specified as "the hub row fields", so `version` appearing there is in-spec | `grep -n list_topics openspec/specs/ai-topics-chat/spec.md` | `169:- \`list_topics\` — returns the session's topics with the hub row fields.` |
| A7 | A caller's kind and user id are readable from the `SessionCaller` value, so the hub can refuse a system overwrite and record the user | `sed -n 10,13p packages/session-core/src/sessionCaller.ts` | `{ readonly kind: 'user'; readonly userId: string; … } \| { readonly kind: 'system'; readonly reason: string; … }` |

Latency is measured before and after during implementation (tasks 1.2 and 7.2) and recorded, with
no stop rule (owner, 2026-10-06: latency is accepted until observability exists after the
migration).

## D1. Migration

`supabase/migrations/20261010000000_session_row_versions.sql`, one transaction (the runner's):

```sql
alter table catalog.session_events           add column version bigint not null default 1;
alter table catalog.session_transcript_words add column version bigint not null default 1;
alter table catalog.session_topics           add column version bigint not null default 1;

alter table catalog.sessions add column revision bigint not null default 0;
update catalog.sessions s set revision = m.value::bigint
  from catalog.session_meta m
  where m.session_id = s.id and m.key = 'events_stream_revision' and m.value ~ '^[0-9]{1,18}$';
-- The meta rows stay (panel F-A3): the server stops reading and writing them, and a later cleanup
-- migration drops them once 7c-1 has settled, so a revert of this slice loses no data.

create table catalog.session_overwrites (
  session_id text collate "C" not null references catalog.sessions (id),
  id text collate "C" not null,
  table_name text not null check (table_name in
    ('session_events', 'session_transcript_words', 'session_topics')),
  row_id text collate "C" not null,
  user_id text collate "C" not null,
  at_utc text not null,
  replaced_version bigint not null,
  before_json text not null,
  after_json text,
  primary key (session_id, id)
);
alter table catalog.session_overwrites enable row level security;
create policy session_overwrites_system_all on catalog.session_overwrites
  for all to catalog_system using (true) with check (true);
create policy session_overwrites_user_insert on catalog.session_overwrites
  for insert to catalog_user with check (
    user_id = catalog.app_user_id()
    and exists (select 1 from catalog.sessions s where s.id = session_id
                and s.show_id in (select catalog.accessible_shows(catalog.app_user_id()))));
revoke select, update, delete on catalog.session_overwrites from catalog_user;
```

Notes:
- Adding a column with a constant default is metadata-only in Postgres 11+, so existing rows read
  `version` 1 without a rewrite.
- `ADD COLUMN` takes an `ACCESS EXCLUSIVE` lock briefly; the migration runs before the app starts
  (`make <env>-up`), as every earlier one did.
- `user_id` has no foreign key to `catalog.users`. An audit row outlives an account deletion,
  consistent with the "who" in ADR 0021.
- The id is a server UUID. Text JSON and text timestamps follow the faithful-port convention of
  the other session tables.
- The revision is held for each session, not for each table, so the `catalog.sessions` row the
  write already locks is the natural home.
- The meta regex skips any value that is not a plain non-negative integer: such a session starts
  at 0, which is safe because only increase is promised.
- The `events_stream_revision` meta rows are kept, not deleted. The new code never reads or writes
  them. If 7c-1 is reverted before the cleanup migration, the old code resumes from the
  pre-migration value, which can be lower than the revision clients saw meanwhile. That affects
  dev and stage only (prod runs `main` until cutover) and is accepted; it is far better than
  losing the counter. The cleanup migration is a follow-up, not part of this change.

## D2. The revision: once per write transaction, from the first changing statement

The value must be known in the middle of the body, because a frame is serialized when it is
enqueued (`sessionCore.ts` `broadcast`). So the bump cannot wait for the end of the transaction.

Mechanism, in `SessionCore` for a transaction-bound core (`forTransaction`):
- The bound core keeps two handles on the transaction: `raw` (the adapter's handle `t`) and
  `db`, a counting wrapper over it. The stores write only through `core.db`. After a `db.run`
  that reports `changes > 0`, if this transaction has not advanced the revision yet, the core
  sends `UPDATE sessions SET revision = revision + 1 WHERE id = ? RETURNING revision` on `raw`
  (through `all`, the seam's only row-returning call) and caches the value. No SQL text is
  matched.
- The core's own statements go through `raw`, so they never count: the bump, the projection
  update, and two bookkeeping writes that are not content:
  - `seed()`, the hub-open insert of the transport row (`ON CONFLICT DO NOTHING`). A new
    session's revision is 0 after open and 1 after its first event, as today.
  - the orphan relink's guard row `relink_checked_rev` (`eventStore.ts:288-291`, an upsert that
    reports `changes = 1` even when the value is unchanged). The relink's own event updates go
    through `db` and count, as they bump today.
- The guard keeps comparing against the session revision. It now goes stale after any session
  write, not only event writes, so the relink pre-check (one `LIMIT 1` probe, then a scan only
  when a snapshot label exists) runs on the next first-page list after, for example, a lease
  heartbeat. Its guard write stays uncounted, so a list never advances the revision (panel F1).
- `revision()` on a transaction-bound core returns the cached value if the revision was advanced,
  and otherwise reads `sessions.revision`. On a snapshot core it reads the column (the event list
  reads its page, counts and revision in one snapshot, as today).
- `bumpRevision()` is retired. Its callers (`eventStore.ts` five sites, `maybeRelinkOrphans`) keep
  only `markProjectionDirty()`. `seed()` stops inserting the meta row.
- **Retries.** Each attempt gets a fresh bound core (`SessionHub.transaction`), so the cache
  resets, and the database rollback undoes the earlier attempt's bump. One commit means one
  advance.
- **Row-level security.** User callers already update `catalog.sessions` for the projection, under
  `sessions_user_update` (accessible shows). The bump runs under the same binding. System callers
  are allow-all.
- **What counts as a change.** Any row a store changes in any session table, including lease meta
  writes (heartbeat). Not counted: the hub-open seed and the relink guard row (above). A no-op
  (deleting a missing id, a `PATCH` with no fields) does not advance it.
- **Imports.** `anchorImportedTake`'s two `Recording N` inserts now share one revision. Its single
  post-commit frame carries that value, so the suppressed intermediate revision no longer exists.
- **Rejected alternative:** fold the bump into the end-of-body projection statement. That saves a
  round trip for non-event writes, but the frames enqueued mid-body would need deferred
  serialization, which is a bigger change to the broadcast queue that 7a/7b proved out.
- **Rejected alternative:** read the revision with the row lock (`select revision … for update`)
  and write it at the end. This changes the adapter's lock protocol and the `SessionStorage` seam
  for a saving that only matters on non-event writes.

## D3. Versions

- **Inserts** rely on the column default (1). No insert statement changes.
- **Updates.** Every `UPDATE` of the three tables appends `version = version + 1`: `updateEvent`
  (`eventStore.ts:203`), the orphan relink (`eventStore.ts:330`), the word patch
  (`transcriptStore.ts:165`) and the topic patch (`topicStore.ts:92`). A repo test (D7) checks
  that every `UPDATE session_events|session_transcript_words|session_topics` statement in
  `packages/session-core/src` contains `version = version + 1`.
- **Mappers.** `eventRowToRpc` adds `version` (`EventRpc.version: number`, in `@autologger/
  domain`); `enrichEventRpc` copies it into its dict, after `metadata` and before the category
  fields. `wordRow`/`TranscriptWord`, `wordApiDict`, `topicRow`/`Topic` add `version`.
- **Exports** are untouched (`exports.ts` builds its own columns). The AI tool `list_topics`
  returns hub row fields (A6), so it gains the field. `get_transcript_words` returns its own
  bounded rendering (ai-topics-chat spec) and is unchanged.

## D4. The check

**Request schemas** (`packages/contract/src/schemas.ts`):
- A shared `expectedVersion = { version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
  .optional(), overwrite: z.boolean().optional() }` is spread into `eventUpdateBodySchema`,
  `transcriptWordUpdateSchema` and `topicUpdateSchema`, with a `refine` (`overwrite` requires
  `version`).
- A `deleteVersionQuerySchema` parses `version` (`/^[1-9][0-9]{0,15}$/` and the same max) and
  `overwrite` (`'1'` only).
- Unknown keys are still dropped (plain `z.object`), so old clients are unaffected.

**Hub.** `updateEvent`, `deleteEvent`, `updateTranscriptWord`, `deleteTranscriptWord`,
`updateTopic` and `deleteTopic` take an optional last argument `expect?: { version: number;
overwrite: boolean }`. Inside the existing transaction, after the store's existence read (which
now selects `version` too):
- If the row is missing, the result is the existing not-found result.
- If `expect` is given and the stored version differs from it, the store returns `{ conflict:
  <mapped row> }` and writes nothing.
- Otherwise it writes as today. With `overwrite`, it also writes the audit row (D5).

The row lock serializes every writer of the session (A1), so nothing can change the row between
the read and the write. Two same-version requests run one after the other: the second reads the
first's version and conflicts.

The result types become discriminated unions. Examples: `updateEvent` returns `{event, projection}
| {conflict: EventRpc} | null`; `deleteTopic` returns `true | false | {conflict: Topic}`. The
existing callers that pass no `expect` (generation, the merge script, the AI tools) cannot receive
a conflict. A typed overload keeps their return types unchanged.

**System callers.** `SessionHub.as(caller)` views pass the caller into `inTxn`. If `expect
.overwrite` is set and `caller.kind !== 'user'`, the call rejects with `SessionTxMisuseError` before
any statement runs (core-ports delta).

**Routes.**
- `events.ts` PUT: the version fields are parsed with the body. The existing 400s (category,
  `wall_time_utc`, `timecode_hms`) run before the hub call. A conflict answers `409 {detail:
  'Version conflict.', current: enrichEventRpc(conflict, profile)}`.
- DELETE: `requireSession`, then the query parse (422), then the hub call.
- `transcribe.ts`: the same for words (`current: wordApiDict(conflict)`) and topics (`current:
  conflict`).
- One helper, `versionConflict(c, current)` in `server/src/routers/_helpers.ts`, builds the
  response, so the body is identical everywhere.
- **Order of answers.** It is the order the routes already produce, since `requireSession` runs
  before the body parse in every `PUT`/`PATCH` route today (`events.ts:645-646`,
  `transcribe.ts:197-198`, `:358-359`). The `DELETE` routes parse the query right after
  `requireSession`. So the order is:
  1. `404 Session not found`;
  2. `422` (body or query);
  3. the event update's `400`s;
  4. `404` row;
  5. `409`.

**An empty patch** (no fields) with a matching version succeeds without writing. The version is
unchanged, nothing is audited even with `overwrite` (an overwrite that replaces nothing is not
recorded; the api-contract-freeze delta states this), and the row is returned. With a stale
version it conflicts.

## D5. The audit row

When the check passes with `overwrite`, the store, in the same transaction:
1. maps the row before the write (it has already read it for the check);
2. writes;
3. maps the row after it (null for a delete);
4. inserts `session_overwrites (session_id, id, table_name, row_id, user_id, at_utc,
   replaced_version, before_json, after_json)`, with `user_id` the caller's user id (A7), `at_utc`
   from the injected clock, and the JSON of the mapped rows (the hub row shapes, not the enriched
   HTTP dicts).

The insert runs under the user binding, so the policy checks the user id and the show access. A
failure fails the write; the transaction is all-or-nothing. The core needs the caller's user id,
which it receives through a new `SessionCore.forTransaction(t, caller)` argument. The core already
receives the transaction handle per attempt.

## D6. Contract and fixtures

- `fixtures/api-responses/*`: the fixtures whose bodies now carry `version` (`eventCreate`,
  `eventsList`, `transcriptWordCreate`, `transcriptWordsList`, `topicCreate`, `topicsList`, and any
  others the fixture test reports) are re-captured with `npm run fixtures:capture -w server`,
  never edited by hand (web-api-response-conformance).
- `web/src/api/types.ts` is not changed: the conformance check tolerates the additive field
  (web-api-response-conformance "Verification tolerates additive server changes"). 7c-2 adds the
  type when the web consumes it.
- README endpoint table: the six routes note the optional `version`/`overwrite` and the `409`, and
  the status and companion-state rows note the revision's wider meaning. No route is added.

## D7. Tests (test-first, per tasks.md)

- **Migration (pg project):** columns, defaults, revision carry-over including a non-numeric meta
  value, meta rows kept unchanged, audit table policies (user insert own/other/outsider, user select,
  update and delete refused `42501`), privileges.
- **Store/hub (integration project):**
  - versions advance on every update path;
  - the revision advances once per transaction (two events plus transport in one transaction);
  - no advance on a no-op, a read, the hub-open seed, or the event list's relink guard (a route
    test lists events twice and reads the status: unchanged, and the relink scan runs once);
  - a retried deadlock advances once (the existing deadlock-injection wrapper);
  - conflict results write and broadcast nothing;
  - a system overwrite is refused;
  - an overwrite writes one audit row with the before and after;
  - a rollback after the audit insert leaves neither.
- **Concurrency:** two processes (two adapters on one database, as `SessionHub.concurrency
  .int.test.ts` does) race same-version updates of one event, many rounds. Every round has exactly
  one winner, and the final version is 1 plus the number of wins.
- **Routes:** each of the six routes:
  - without a version (unchanged plus `version`);
  - current version;
  - stale version (`409` body equals the success shape);
  - deleted row (`404`);
  - `overwrite` without `version` (`422`);
  - bad query (`422`);
  - the order of answers (a stale version plus an unknown category answers `400`).
- **Frames and status:**
  - the `event.changed` revision equals the status revision after the write;
  - a transcript patch advances the status revision with no frame;
  - the import's single frame carries a revision one more than before.
- **Exports:** byte-identical CSV/JSONL for a seeded session (the existing export tests stay
  unchanged).
- **Repo tests:** every `UPDATE` of the three tables advances `version` (D3); no store writes
  through `all(`/`first(` (Risks).
- **Existing tests that change** (panel F2), and only these categories:
  1. exact revision numbers after non-event writes or after an import;
  2. deep-equal row bodies gaining `version`;
  3. tests calling the retired `bumpRevision()` (`sessionCore.int.test.ts:15`,
     `transportStore.int.test.ts:118`), rewritten to drive the revision through a store write;
  4. raw test setup of the retired meta key (`snapshot.int.test.ts:44`), rewritten to set
     `catalog.sessions.revision`;
  5. call sites of `forTransaction(t)` gaining the caller argument (`boundCore.ts:94`,
     `sessionCore.int.test.ts:200,218,237,252,267,291`).

  Task 1.1 records the full list from a grep on the base commit. Changing any other existing
  expectation is a stop. Because the seed does not count (D2), revision numbers after event
  writes do not shift.

## D8. Docs and ADR 0021

- README: the six routes' version semantics and the `409`; the revision note.
- ADR 0021 slice 7: the 7c split into 7c-1/7c-2, owner decisions 1-4, and the 7c-1 mechanism
  paragraph (D2, D4, D5).

## Risks / Trade-offs

- **The revision moves on lease heartbeats.** `events_stream_revision` in the status changes
  every heartbeat while recording. No in-repo consumer cares (A4). An external script polling it
  to detect new events would refetch more often; that is harmless and only increases load.
  Slice 8 moves leases to their own table, and then can decide.
  → Accepted by owner decision 3.
- **The extra round trip on non-event writes** (A2): about 0.4 ms per transcript, topic, transport
  or audio write. → Measured and recorded in task 7.2; no stop rule (owner, 2026-10-06).
- **The counting wrapper sees only `run()`**, so a future store that writes a session table
  through `all()` (e.g. `INSERT … RETURNING`) would not advance the revision. → A repo test fails
  when a `packages/session-core/src/*Store.ts` `all(` or `first(` call contains `INSERT`,
  `UPDATE` or `DELETE`. The core's own bump on `raw` is outside the store files.
- **The relink pre-check runs more often** (D2): after any session write instead of after event
  writes only. It is one probe, plus a scan only for sessions with snapshot labels. → Covered by
  the 7.2 bench; the guard write itself never advances the revision.
- **The audit rows have no reader or retention.** They grow with overwrites, which are rare and
  deliberate. → An audit viewer or retention policy is a later change.
- **Companion module installs in the field** only declare the type (A4), so they are unaffected.
  Scripts using the frozen field get a strictly increasing number, as before.

## Migration Plan

`make dev-up` / `make stage-up` run the migration before the app. Rollback before slice 11 means
reverting the branch merge. No reset is needed: the added columns and table are ignored by the old
code, and the kept `events_stream_revision` meta rows let it resume (D1 notes the possible lower
value). Resetting the dev/stage databases (`make <env>-reset CONFIRM=yes`) remains the clean
option, as for every earlier slice. Prod is untouched until cutover.

## Open Questions

None. The owner decided the four forks on 2026-10-05.
