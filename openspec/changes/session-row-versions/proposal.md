# Session row versions: one session revision, per-row versions and opt-in version checks with audited overwrites

Tier: 2
Tier reason: an observable contract change: a new optional request field and query parameters,
a new `409` body carrying the current row, a `version` field on row responses, and wider
`events_stream_revision` / `event.changed.revision` semantics. Also a migration (version columns,
`catalog.sessions.revision`, a new audit table with row-level security), and concurrency (the
check and the write share the session's row lock). It touches `supabase/migrations/**`,
`server/src/routers/**` and `packages/contract/**`, all high-risk paths. ADR 0021 slice 7c-1.

Approved-by: Kalen 2026-10-05 (no latency stop rule)

## Why

Every edit of session content is last-writer-wins. When two people edit the same event, transcript
word or topic, the later save silently replaces the earlier one, and nothing records it. ADR 0021
plans per-row versions, a `409` that hands back the current row, a deliberate and audited
overwrite, and one session revision that every write advances. Slice 9 needs that revision to order
Realtime frames. 7b moved session content into Postgres under the session row lock, so a version
check can now be atomic with the write. This change builds the server half. The web dialog follows
in 7c-2.

## Owner decisions (owner, 2026-10-05)

Plan of record `joyful-sprouting-dove.md`:
1. **Scope: the rows people edit by hand.** Events (`PUT` / `DELETE`), transcript words (`PATCH` /
   `DELETE`) and topics (`PATCH` / `DELETE`) get versions and opt-in checks. Every other writer
   advances these rows' versions but is never checked: event and topic generation, the transcript
   replace, imports, the log import and Companion. Transport, audio, dashboards and the session
   rename get no versions.
2. **Split 7c into 7c-1 and 7c-2.** 7c-1 is the server: schema, checks, `409`, audit, revision and
   contract delta. 7c-2 is the web: handling the `409` and the overwrite dialog. Each gets its own
   proposal, panel and approval, and 7c-2 starts after 7c-1 merges.
3. **Unify the revision.** The per-session counter `events_stream_revision` (a `session_meta` key
   today, advanced only by event writes) becomes `catalog.sessions.revision`, advanced by every
   session write. The wire names stay the same: the `revision` of `event.changed`, and
   `events_stream_revision` in the session status and `/api/companion/state`. Only their meaning
   widens. In-repo consumers were checked: the web ignores the number (it only invalidates on the
   frame), and the Companion module only declares its type (`companion/src/state.ts:12`).
4. **An overwrite is a retry with the fresh version.** The `409` returns the current row with its
   version. To overwrite, the client re-sends the edit with that version plus `overwrite: true`.
   The check still runs, so a third editor who saved in between gets another `409`. The server
   records who overwrote which row, when, what was replaced and what replaced it.

## For the approver

- **No request changes behaviour unless it sends a version** (design D4). Every existing client
  (the web today, Companion, scripts) keeps last-writer-wins with the same statuses and bodies,
  apart from the additive `version` field below.
- **A `version` field appears on every event, transcript word and topic in JSON responses**
  (design D3). This includes the event list, create, update and Companion `log` responses, the
  word and topic lists, create and update, and the transcript and topic generate responses. It is
  additive: no field is removed or renamed. The CSV and JSONL exports are unchanged, because they
  build their own columns.
- **A stale edit is refused with `409 {"detail":"Version conflict.","current":{…}}`** (design D4).
  `current` is the row as the same route would return it, with its version. Checks run in this
  order: `404 Session not found`, `422` invalid body or query, the event update's existing `400`s,
  `404` for a missing row, then `409` for a stale version. A stale versioned `DELETE`
  gets the same `409`; a versioned delete of an already-deleted row gets the existing `404`.
- **An overwrite is audited in the same transaction** (design D5). A new table,
  `catalog.session_overwrites`, gets one row per write sent with `overwrite: true` that passes the
  check. The row holds the user, the session, the table and row id, the time, the replaced version,
  and the old and new row as JSON. A user can only insert their own rows, for a session they can
  access. Nothing in this slice reads them: there is no viewer and no endpoint.
- **The session revision now moves on every write, not only on event writes** (design D2). It
  advances by exactly one for each committed hub write transaction that changed at least one
  session row. The hub-open seed and the event list's relink bookkeeping do not count, so listing
  events never advances it (design D2, panel F1). Two consequences can be observed:
  1. `events_stream_revision` in `GET /api/sessions/:id/status` and `/api/companion/state` also
     moves on transport, transcript, topic, audio, dashboard and lease writes. That includes the
     recording lease heartbeat.
  2. A write that changes several events in one transaction advances it by one, not by one per
     event (for example an imported take's two `Recording N` events).

  No in-repo consumer compares the values; only a strictly increasing order is promised.
- **Write latency** (design A2, D2): event writes keep one revision statement; it moves from
  `session_meta` to `catalog.sessions`. Writes that did not touch the revision before (transcript,
  topic, transport, audio, dashboard and lease writes) gain one primary-key update per transaction.
  The numbers are measured before and after (tasks 1.2 and 7.2, with the 7b-2 bench) and recorded,
  with no stop rule: the owner accepts all latency changes until after the migration, when
  database-side observability exists (owner, 2026-10-06, after approval).

## What Changes

- **Migration** `supabase/migrations/20261010000000_session_row_versions.sql` (design D1):
  - `version bigint not null default 1` on `session_events`, `session_transcript_words` and
    `session_topics`;
  - `revision bigint not null default 0` on `catalog.sessions`, seeded from each session's
    `session_meta` `events_stream_revision`. Those meta rows are kept, unread and unwritten, so a
    revert loses nothing; a later cleanup migration drops them;
  - `catalog.session_overwrites` with row-level security: an allow-all `catalog_system` policy (the
    catalog rule) and a `catalog_user` insert-only policy (own user id, accessible show).
    `catalog_user` loses select, update and delete on it.
- **Versions** (design D3): every insert of the three tables stores version 1, and every update on
  every path sets `version = version + 1`. The row mappers carry `version`.
- **The revision** (design D2): `SessionCore` advances `catalog.sessions.revision` once per write
  transaction, on the first store statement that changes a session row, and caches the new value
  for that transaction's frames and responses. The `session_meta` key and the seed's meta row are
  retired.
- **Checks and overwrites** (design D4, D5): the request schemas gain an optional `version`
  (integer, 1 to `Number.MAX_SAFE_INTEGER`) and `overwrite` (boolean; requires `version`).
  `DELETE` takes `?version=<n>` and `&overwrite=1`. The hub's update and delete methods for the
  three tables take an optional expected version and overwrite flag, compare them under the
  session row lock, and return a conflict result carrying the current row. The routes answer `409`.
- **Contract** (design D6): `packages/contract` schemas; README endpoint table notes; the
  `fixtures/api-responses/*` that carry these rows are re-captured
  (`npm run fixtures:capture -w server`). `web/src/` is not touched: the conformance check
  tolerates the additive field, and 7c-2 adds the type.
- **Docs** (design D8): README (versions, `409`, overwrite, revision meaning); ADR 0021's slice 7
  entry gains 7c-1 and the owner decisions above.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `api-contract-freeze`:
  - ADDED "Opt-in version checks on session content edits": the request fields, the check order,
    the `409` body and the `DELETE` query.
  - ADDED "Session content rows carry their version": the field on every JSON row response, with
    exports unchanged.
  - ADDED "Overwrites are audited".
  - ADDED "The session revision advances once per session write": the wider meaning of
    `events_stream_revision` and `event.changed.revision`.
- `catalog-database`:
  - MODIFIED "Session content tables": the version columns, `catalog.sessions.revision` and the
    retired meta key.
  - MODIFIED "The session live projection commits with the session write": the revision commits
    with the write.
  - ADDED "Session overwrites are recorded in the catalog": the table, its insert-only user policy
    and its privileges. "Row-level security is enabled on every catalog table" already admits it
    unchanged (an allow-all system policy plus a user policy).
- `core-ports-architecture`:
  - MODIFIED "Session runtime is an asynchronous, per-session serialized port on Postgres": only
    its scenario "Responses and frames are unchanged for serial requests", whose carve-out now
    names the added `version` field and the new revision values.
  - ADDED "Version checks are atomic with the session write": the check and the write share the
    session row lock, concurrent same-version edits produce exactly one success, overwrites only
    from a user caller, and the revision is advanced once per committed write by the hub's write
    path.

## Non-goals

- **The web**: no `409` handling and no overwrite dialog (7c-2). The web keeps sending no version.
- **Versions on other content**: transport, audio segments, dashboards, transcript paragraphs and
  sentiment, `session_meta`, and the session rename (`PUT /api/sessions/:id`, a catalog write).
- **Checks on any other writer**: generation, the transcript replace, imports, the log import and
  every Companion route. They advance versions and never check them.
- **New frames**: transcript and topic edits still broadcast nothing (slice 9), and no frame gains
  a field.
- **An audit viewer, an endpoint or retention for the audit rows.**
- **`If-Match` / `ETag` headers**: the version travels in the body and query.
- **Leases across processes** (slice 8), **backups** (slice 1.3), **optimising the adapter's
  per-transaction overhead** (ADR 0021 revisit item).
- **New runtime dependencies.**

## Impact

- **Code:**
  - `supabase/migrations/20261010000000_session_row_versions.sql`;
  - `packages/session-core/src`: `sessionCore.ts` (the revision), `eventStore.ts`,
    `transcriptStore.ts`, `topicStore.ts` (versions, checks, audit), `SessionHub.ts` (the facade's
    method signatures and the conflict result), `index.ts`;
  - `packages/domain/src/studio.ts` (`EventRpc.version`, `enrichEventRpc`);
  - `packages/contract/src/schemas.ts`;
  - `server/src/routers`: `events.ts`, `transcribe.ts` (the `409`s and the `DELETE` query),
    `companion.ts` (none expected beyond the shared mapper); `server/src/app.ts` (none expected);
  - `fixtures/api-responses/*` (re-captured);
  - tests (design D7).
- **Specs:** the deltas above.
- **Docs:** README; ADR 0021.
- **Operators:** the migration runs with `make <env>-up`. No env var. Existing revisions carry
  over; versions start at 1. Follow-up: a cleanup migration drops the retired meta rows.
- **Performance:** design A2 and D2.

## After merge

Outside tasks.md, because they need the merged branch or `make stage-up` permission:
- **Dev live check** (`make dev-up` applies the migration):
  - the 7b-2 checklist;
  - with `curl` and a session cookie, edit an event, a word and a topic with a stale version (`409`
    with `current`), then overwrite;
  - in `psql`, as `postgres`, confirm the audit row and that the revision advanced once per write.
- **Stage live check**, with the owner's permission for `make stage-up`: the same walk-through.
- **Prod:** prod runs `main` until slice 11's cutover, so no prod step here.
