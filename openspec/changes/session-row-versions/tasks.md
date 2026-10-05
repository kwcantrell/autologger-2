# Tasks

The first commit on `supabase-7c1-session-row-versions` holds only
`openspec/changes/session-row-versions/`, so the plan is pinned before code. The PR targets
`supabase-migration`, and the gates run with `GITHUB_BASE_REF=supabase-migration`. One PR, no size
budget (ADR 0024). Every `make stage-up` needs the owner's permission; the live dev and stage checks
are in proposal.md "After merge".

Logs: keep every test and gate run under the session scratchpad as `7c1-<task>-<red|green>.log`, and
name the log in each `Evidence:` line. Each "test first" item is red before its change (record the
failure line) and green after; if a new test already passes, record that and why.

Test commands: server tiers are `cd server && npx vitest run --project <unit|integration|pg>
<files>`; packages are `cd packages/<name> && npx vitest run [--project <unit|pg>] [<files>]`. "The
full suites" means `cd server && npx vitest run --project unit --project integration --project pg`,
`npx vitest run` in `packages/storage`, `packages/session-core`, `packages/catalog`,
`packages/contract`, `packages/domain`, `packages/log-import`, `packages/transcription` and
`packages/ai-runtime`, `cd web && npx vitest run src/apiResponseShapes.repo.test.ts`, and
`npm run typecheck`. `<change>` below is `openspec/changes/session-row-versions`.

Order: each group ends with the full suites green and is its own commit. Changing an existing test
is allowed only for the five categories in design D7 ("Existing tests that change") and the files
1.1 lists; any other change is a stop: update the artifacts and ask the owner.

Keep each task's text, and later its `Evidence:`, in one block with no blank line: the evidence gate
reads only up to the first blank line.

## 1. Baselines (design A2, D7)

- [ ] 1.1 On the base commit, run the full suites and `sessionHub.interleave.int.test.ts` three times (`cd server && npx vitest run --project integration src/routers/sessionHub.interleave.int.test.ts --reporter=verbose`), and record the existing tests design D7 expects to change: `grep -rn "bumpRevision\|events_stream_revision\|forTransaction(" --include=*.test.ts server/src packages` plus the revision assertions after non-event writes or imports. Verify: all green; the log records the suite counts, each interleave run's frame count, revision range and final event count (7.1 compares against them), and the file:line list of tests expected to change. Known flake: `teams.race.int.test.ts` "invite cap (#10)" can time out under full-suite load and passes alone; record any recurrence.
- [ ] 1.2 In the dev stack (`make dev-up`), run the 7b-1 bench `openspec/changes/archive/2026-10-03-session-tables/spike/bench7b.mts` as its header says. Verify: the `addEvent` and `listEvents` medians and the 31,621-word replace time are recorded as the before-values for 7.2.

## 2. The migration (design D1)

- [ ] 2.1 Test first, in `server/src/test/pg/catalogSchema.pg.test.ts`: `version` on the three tables (bigint, not null, default 1), `sessions.revision` (bigint, not null, default 0), `session_overwrites` in `TABLES`/`KEY_COLUMN`/`EXPECTED_SCHEMA` with its key, foreign key and check; the RLS test admits `session_overwrites` with one `catalog_system` policy and one `catalog_user` insert policy; a new case "the 7c-1 migration carries the revision over" (a database migrated up to `20261009000000`, sessions A with meta `17`, B with none, C with `'x'`, A with an event, a word and a topic; then `20261010000000` applied: A 17, B 0, C 0, the three `events_stream_revision` meta rows unchanged, every row version 1). In `server/src/test/pg/catalogPolicies.pg.test.ts` (or a new `sessionOverwrites.pg.test.ts`): a user binding inserts its own overwrite row for an accessible session; inserting for another user or an inaccessible session fails `42501`; select, update and delete as `catalog_user` fail `42501`. Verify: red, recorded.
- [ ] 2.2 Add `supabase/migrations/20261010000000_session_row_versions.sql` as design D1 gives it. Verify: 2.1 green; the other `pg` files pass unchanged; `sh docker/supabase/test_migrate.sh` passes; the full suites green, with the existing hub tests still green because nothing reads the new columns yet.

## 3. The revision moves to `catalog.sessions` (design D2)

- [ ] 3.1 Test first, `server/src/test/session/revision.int.test.ts`: (a) one hub write transaction that inserts two events and changes the transport advances `catalog.sessions.revision` by one, and both its frames carry that value; (b) `patch` of a transcript word, a topic, a dashboard save, a waveform set and a lease heartbeat each advance it by one and send no `event.changed`; (c) a delete of a missing id, a word `PATCH` with no fields, every read, the hub-open seed of a new session (revision 0 after open) and `maybeRelinkOrphans` with no orphan to relink leave it unchanged, while a relink that changes an event advances it by one; (d) a write whose body throws after a change leaves it unchanged; (e) a first-run deadlock injected through the existing failure-injecting storage wrapper, then a commit, advances it once; (f) `anchorImportedTake` advances it once and its single frame carries the new value; (g) no `events_stream_revision` row is written or read: a seeded meta value of `999` is ignored and left unchanged. In `server/src/routers/`, a route test: `GET …/events` (first page, with a snapshot-labelled orphan present once) twice, then `GET …/status`: `events_stream_revision` unchanged by the second list, and the relink scan ran once. Verify: red, recorded.
- [ ] 3.2 Implement design D2 in `packages/session-core/src/sessionCore.ts`: the `raw` and counting `db` handles on transaction-bound cores, the bump on `raw` with `RETURNING`, the per-transaction cache, `revision()` from the column, `bumpRevision()` removed (callers keep `markProjectionDirty()`), `seed()` and the relink guard's `metaSet` on `raw`, and `seed()` without the meta row; update `eventStore.ts` call sites. Add the repo test from design Risks: no `all(`/`first(` call in `packages/session-core/src/*Store.ts` contains `INSERT`, `UPDATE` or `DELETE`. Verify: 3.1 green; `cd server && npx vitest run --project integration src/test/session src/routers/sessionHub.interleave.int.test.ts` green, with only D7's revision-number expectations changed (each listed in the evidence); the full suites green.

## 4. Row versions (design D3)

- [ ] 4.1 Test first: in `server/src/test/session/` (store level) every update path advances `version` by exactly one (`updateEvent`, the orphan relink, the word patch, the topic patch), inserts start at 1, a word patch with no fields leaves it; the mappers carry `version`; a repo test in `packages/session-core` that every `UPDATE session_events|session_transcript_words|session_topics` statement in `src` contains `version = version + 1`; in `server/src/routers/`, the event list, create, update and Companion `log` responses, the word and topic lists, create, update and generate responses carry `version`; the CSV and JSONL export tests stay byte-identical. Verify: red, recorded.
- [ ] 4.2 Implement design D3: the four `UPDATE` statements, `EventRpc.version` and `enrichEventRpc` (`packages/domain`), `wordRow`/`TranscriptWord`/`wordApiDict`, `topicRow`/`Topic`; re-capture the affected fixtures with `npm run fixtures:capture -w server` in the same commit (never hand-edited; `web/src` untouched). Verify: 4.1 green; `server/src/routers/apiResponseFixtures.int.test.ts` and `web/src/apiResponseShapes.repo.test.ts` green unchanged on the web side; `git diff --stat fixtures/` shows only the re-captured files, each diff only adding `version` (recorded); only D7's expectations changed (listed); the full suites green.

## 5. The check, the conflict and the audit (design D4, D5)

- [ ] 5.1 Test first, store/hub level (`server/src/test/session/versionCheck.int.test.ts`): for each of the six hub methods, a matching expected version writes; a stale one returns the conflict with the stored row and changes no row, no revision, no frame; a missing row keeps the not-found result; `overwrite` with a matching version writes one `session_overwrites` row (user, session, table, row id, replaced version, before, after; after null for a delete); a rollback forced after the audit insert leaves neither; a system caller with `overwrite` rejects with `SessionTxMisuseError` and runs no statement. Concurrency (`server/src/test/session/versionRace.int.test.ts`): two adapters on one database race same-version `updateEvent`s of one event for 200 rounds; each round has exactly one winner and the final version is 1 plus the wins. Verify: red, recorded.
- [ ] 5.2 Implement the hub and store side of design D4 and D5: the `expect` argument and conflict results (typed so callers without `expect` keep their types), the caller passed into `forTransaction`, the system-overwrite refusal, the audit insert. Verify: 5.1 green; the full suites green.
- [ ] 5.3 Test first, route level (`server/src/routers/versionChecks.int.test.ts`): for each of the six routes, without a version (unchanged plus `version`); a current version; a stale version (`409` with `detail` `Version conflict.` and `current` deep-equal to that route's success shape); a deleted row (`404`); `overwrite` without `version` (`422`); `DELETE` with `?version=abc`, `?version=0` and `?overwrite=1` alone (`422`); the order of answers (an inaccessible session with a stale version, and an inaccessible session with `?version=abc` on `DELETE`: both `404 Session not found`; a stale version with an unknown category: `400`); an empty `PATCH` with a matching version and `overwrite: true` answers `200` with the version unchanged and records no audit row; a conflict then an overwrite with `current.version` records one audit row; a stale overwrite (a third edit in between) answers `409` and records nothing; Companion `log`/`transport` and the generate routes accept no version and never answer this `409`. In `packages/contract/src/schemas.test.ts`: the new fields' bounds and the `overwrite` refine. Verify: red, recorded.
- [ ] 5.4 Implement the schemas (`expectedVersion`, `deleteVersionQuerySchema`), `versionConflict()` in `server/src/routers/_helpers.ts`, and the six routes. Verify: 5.3 green; the full suites green.

## 6. Docs and the ADR (design D6, D8)

- [ ] 6.1 README: the six routes' `version`/`overwrite`/`409` notes in the endpoint table and the API section; the revision note for the status and companion-state rows. ADR 0021 slice 7: the 7c split, owner decisions 1-4 and the 7c-1 mechanism paragraph. Verify: `grep -n "Version conflict\|overwrite" README.md` shows the new notes (recorded); `scripts/check-change.sh --only guide-size,openspec` green.

## 7. After-measurements and final checks (design A2, D7)

- [ ] 7.1 Rerun `sessionHub.interleave.int.test.ts` three times. Verify: each passes; the frame count and final events match 1.1's, and the revision range is recorded beside 1.1's (it may now be shorter, since one transaction advances it once); any other difference is a stop.
- [ ] 7.2 In the dev stack (`make dev-up`, which applies the migration), rerun the 7b-1 bench as in 1.2. Verify: the medians are recorded beside 1.2's; stop and ask the owner if the `addEvent` median exceeds 10 ms or the replace exceeds 10 s.
- [ ] 7.3 Final checks: the full suites; `npm audit --audit-level=high`; `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook`; then the `consistency-read` skill over the artifacts (tier 2). Verify: all green, and the consistency read's log entry is recorded.
