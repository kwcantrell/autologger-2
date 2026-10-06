# Panel: session-row-versions
Tier: 2 · Reviewers: assumption tester, failure and abuse, scope and simplicity · Date: 2026-10-05

Reviewers report only critical and major findings (ADR 0024). Each reviewer ran as a separate
fresh-context subagent; duplicates across reviewers are merged and say who found them.

- [x] [critical] Every first-page `GET …/events` would advance the revision, and the relink guard would never hold again: `maybeRelinkOrphans` (a write transaction, `events.ts:209-210`) upserts `relink_checked_rev` (`eventStore.ts:288-291`), which reports `changes = 1` even for an unchanged value, so D2's wrapper bumped the revision past the stored guard on every list. This contradicted the delta's "a read leaves the revision unchanged". Found by all three reviewers (scope: critical; assumption tester: critical; failure and abuse: major). Evidence: `docker exec -i autologger-dev-db-1 psql …` re-upserting an equal value -> `INSERT 0 1`. Resolved: design D2 gives the bound core a `raw` handle and a counting `db` handle; the bump, the projection, the hub-open seed and the relink guard row go through `raw` and never count; the api-contract-freeze delta names both exceptions and its read scenario lists the first page; tasks 3.1(c) and 3.1(g) add hub- and route-level cases (list twice, status unchanged, relink scan once).
- [x] [major] D4 contradicted itself and the spec on the `DELETE` answer order ("query parsed first, then `requireSession`" vs `404 Session not found` first). Found by all three reviewers. Evidence: every `DELETE` route calls `requireSession` first today (`events.ts:702-709`, `transcribe.ts:211-216,375-380`). Resolved: the D4 bullet now reads `requireSession`, then the query parse, then the hub; task 5.3 adds an inaccessible session with `?version=abc` -> `404`.
- [x] [major] The frozen scenario "Responses and frames are unchanged for serial requests" (core-ports-architecture) becomes false (new `version` field, new revision values) and was not amended. Found by scope and simplicity. Resolved: a MODIFIED delta of "Session runtime is an asynchronous, per-session serialized port on Postgres" restates the requirement verbatim and widens only that scenario's carve-out to the two 7c-1 deltas.
- [x] [major] D3 claimed `get_transcript_words` gains `version`, but ai-topics-chat specifies its own bounded rendering, not hub row fields. Found by scope and simplicity. Evidence: `openspec/specs/ai-topics-chat/spec.md:155-163` vs `:169`. Resolved: D3 names only `list_topics`; `get_transcript_words` is unchanged.
- [x] [major] The revision bump (`UPDATE … RETURNING`, only possible through `all()`) violated the design's own repo test ("no session-core `all(` contains `UPDATE`"), and the statement-text prefix list was unnecessary. Found by scope and simplicity and the assumption tester. Evidence: `sessionCore.ts:28`, the seam's `run` returns only `{changes}`. Resolved: the bump runs on `raw` in `sessionCore.ts`; the repo test scans the `*Store.ts` files only; no SQL text is matched.
- [x] [major] Design and spec disagreed on auditing an empty `PATCH` sent with `overwrite`. Found by scope and simplicity. Resolved: the spec now says an overwrite that changes nothing records nothing, matching D4; task 5.3 tests it. Flagged to the owner at approval as a small behaviour choice.
- [x] [major] The server slice edited `web/src/api/types.ts` on a false premise (the conformance check already tolerates additive fields) and described the fixtures as edited, which web-api-response-conformance forbids. Found by scope and simplicity. Evidence: `openspec/specs/web-api-response-conformance/spec.md:22-25,44-54`. Resolved: no `web/src` change in 7c-1 (7c-2 adds the type); fixtures are re-captured with `npm run fixtures:capture -w server`, and task 4.2 checks the diff only adds `version`.
- [x] [major] The migration deleted the only copy of the old revision, so reverting 7c-1 on stage without a reset would drop every session's revision to 0. Found by failure and abuse. Resolved: the migration keeps the `events_stream_revision` meta rows (the server no longer reads or writes them; a later cleanup migration drops them); the catalog-database delta and D1 say so; the Migration Plan notes a revert resumes from the pre-migration value (dev and stage only).
- [x] [major] D7's list of existing tests allowed to change was too short, so task 3.2 would trip its own stop rule: tests call the retired `bumpRevision()` (`sessionCore.int.test.ts:15`, `transportStore.int.test.ts:118`), set the retired meta key directly (`snapshot.int.test.ts:44`), and call `forTransaction(t)` (`boundCore.ts:94`, `sessionCore.int.test.ts:200,218,237,252,267,291`); the seed counting would also shift about 30 revision assertions. Found by the assumption tester. Evidence: `grep -rn "revision" --include=*.test.ts server/src packages | grep -i "toBe\|toEqual\|run(\|seed\|meta"` -> about 30 assertions in 9 files. Resolved: D7 lists five categories, task 1.1 records the exact file:line list on the base commit, and the seed no longer counts (D2), which removes the +1 shift.

Verified true by the reviewers (cited for the record): every session-table write is a store `core.db.run` inside a hub transaction; `run().changes` maps postgres.js `count` reliably (an upsert reports 1, `DO NOTHING` on conflict 0, a JSON-id delete reports the rows removed); bigint reads as `Number`; the D1 SQL applies on the pinned `supabase/postgres:17.6.1.136` image inside `begin … rollback`, leaving `catalog_user` with INSERT only and the policies refusing another user's row, an inaccessible session, and select/update/delete; `catalog_user` may `UPDATE sessions … RETURNING revision` under the existing policies; only the six routes reach the hub update/delete methods; exports and the session list build explicit dicts; the web and Companion never send a version; the lease heartbeat upserts `session_meta`; `catalog` is not exposed through PostgREST; no route deletes sessions, so the audit foreign key blocks nothing.

## Re-panel 2026-10-06

Edits since approval (75ae66e): proposal.md, design.md and tasks.md 7.2 drop the latency stop rule
(median `addEvent` above 10 ms, replace above 10 s) for "measure and record, no stop rule" (owner,
2026-10-06: latency is accepted until observability exists after the migration); tasks 1.2 and 7.2
switch from the 7b-1 bench, which no longer runs, to the 7b-2 bench. Scope or contract change: no.
Accepted risk changed: yes (a named stop rule removed), so the delta was re-paneled and needs the
owner's re-approval. One reviewer subagent covered the three roles for this three-sentence delta,
not three separate subagents (deviation from CLAUDE.md, disclosed to the owner).

- [x] [major] The owner's decision did not reach ADR 0021, which still frames latency around the 10 ms rule (revisit item; 7b-2 paragraph), and task 6.1 had no place for it or for the 7.2 numbers. Found by scope and simplicity. Resolved: task 6.1 now records owner decision 5, updates the latency revisit item, and adds the measurement placeholder 7.2 fills.

Verified (no findings): the 7b-1 bench fails on the 7b-2 API (`PostgresSessionDb` takes the catalog root; hub calls need `.as(caller)`); `bench7b2.mts` reports the `addEvent`/`listEvents` medians and the replace time at ~300 and ~3,000 sessions; the revision `UPDATE` runs on the row already locked `FOR UPDATE`, so the removed gate leaves no lock or deadlock risk unguarded; task 7.1 still stops on any interleave difference. A false clause in task 1.2 ("the dropped seed team"; `test-studios` is still seeded) was removed.

## Consistency read 2026-10-06
Edits since the re-approval (8987007): design.md D7 gains category 6 (catalog-wide inventories
that grow with the new table or policy: the `catalog_user` policy count 32 -> 33 in
`catalogPolicies.pg.test.ts`, a direct consequence of catalog-database "Session overwrites are
recorded in the catalog"); tasks.md ticks 1.2, 2.1 and 2.2 with evidence.
Scope change: no. Contract change: no. Accepted risk change: no.
No findings.

## Consistency read 2026-10-06 (group 3)
Edits since the previous read: design.md D7 category 1 now names a test's own setup writes through
the bound core's handle (they count under D2, so revision expectations after them move by one);
tasks.md ticks 3.1 and 3.2 with evidence.
Scope change: no. Contract change: no. Accepted risk change: no.
No findings.

## Consistency read 2026-10-06 (group 4)
Edits since the previous read: tasks.md ticks 4.1 and 4.2. Implementation note: the server row types
(`EventRpc`, `TranscriptWord`, `Topic`) now require `version`, so three hand-built test fixtures of
those types gained `version: 1`, one of them under `web/src`
(`clientAggregates.pinning.test.ts`, which builds "full server-shape fixtures" to compare the web's
mirror of the aggregates with the server's). proposal.md's "`web/src/` is not touched" therefore
reads as "no web production code changes"; no web behaviour, type in `web/src/api/types.ts` or
response handling changed (7c-2 still owns those). Flagged to the owner.
Scope change: no. Contract change: no. Accepted risk change: no.
No findings.

## Consistency read 2026-10-06 (final, task 7.3)
Edits since the group 4 read: tasks.md ticks 5.1-7.2 with evidence; README (the events, status and
words/topics rows; the "Row versions and the session revision" paragraph); ADR 0021 (the 7c split,
the 7c-1 entry with owner decisions 1-5, the mechanism and measurement paragraphs, the latency and
contention-test revisit items). Checked together: every requirement in the three spec deltas has a
task and a test (versions: 4.1; checks, order, 409 shape, DELETE query: 5.3; audit: 5.1, 5.3;
revision: 3.1; atomicity and system overwrite: 5.1; carry-over and audit policies: 2.1); no task
does what a non-goal excludes (web production code, frames, other tables, audit reader); the design
and the specs agree after the group 3 and 4 clarifications.
Scope change: no. Contract change: no. Accepted risk change: no.
- [x] [major] `npm audit --audit-level=high` fails on 4 advisories in dependencies this change does not touch (`proxy-addr` critical via `@modelcontextprotocol/sdk` → `express`; `source-map-js` high via `next`/`postcss`, tailwind, jsdom; `uuid` moderate via `exceljs`), so task 7.3 cannot verify "all green". Evidence: `npm audit --audit-level=high` -> `4 vulnerabilities (2 moderate, 1 high, 1 critical)` (log `7c1-7.3-audit.log`); `git diff supabase-migration -- package.json package-lock.json` is empty. Resolved: out of 7c-1's scope (no dependency changes); the owner chose a separate change, `audit-fix-2026-10` (PR #53, merged 2026-10-06); after rebasing on it, `npm audit` -> `found 0 vulnerabilities` and task 7.3 closed.
