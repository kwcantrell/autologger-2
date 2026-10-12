# Tasks

**Branch and commits**
- The first commit on `catalog-search` holds only `openspec/changes/catalog-search/`.
- The PR targets `supabase-migration`.
- The gates run with `GITHUB_BASE_REF=supabase-migration`.

**Logs and test-first**
- Logs live under the session scratchpad as `cs-<task>-<red|green>.log`, and each `Evidence:` line names its log.
- Each "test first" item is red before its change, or records why it already passes.
- Each task's text and its `Evidence:` stay in one block with no blank line.

**Commands**
- Targeted server tests: `cd server && npx vitest run --project <unit|integration|pg> <files>`.
- Packages: `npx vitest run` in `packages/{contract,catalog,session-core}`; `cd packages/storage && npx vitest run --project <unit|pg> <files>`.
- Web: `cd web && npx vitest run`.
- `npm run typecheck`.
- Migrations: `sh docker/supabase/test_migrate.sh`.
- The full pg and integration suites run in CI on the PR (ADR 0026). Locally, run the targeted tests, the unit suites and typecheck.

**Changing tests.** Changing an existing test is allowed only for the categories in design D10. Anything else is a stop: update the artifacts and ask the owner.

## 1. Baselines

- [x] 1.1 On the base, run the unit suites (server, packages, web) and typecheck, and record the counts. Then list the existing tests D10 may touch with `grep -rln "session_transcript_paragraphs\|'/teams'\|isRouterKnownPathname\|isTeamsRoutePathname\|has_function_privilege\|confirmSwitch" --include=*.test.ts --include=*.test.tsx server/src packages web/src`, and classify each hit as D10 category 1, 2, 3 or unchanged. Verified by the recorded counts and the classified list.
  - Evidence: base `fe54d8b8`. `cd server && npx vitest run --project unit` -> `Tests  482 passed | 5 skipped (487)`; `npx vitest run` in ports -> `Tests  1 passed (1)`, contract -> `Tests  139 passed (139)`, transcription -> `Tests  71 passed (71)`, catalog -> `Tests  51 passed (51)`, ai-runtime -> `Tests  260 passed (260)`, session-core -> `Tests  55 passed (55)`, media-import -> `Tests  31 passed | 2 skipped (33)`, log-import -> `Tests  41 passed (41)`, domain -> `Tests  50 passed (50)`; `cd packages/storage && npx vitest run --project unit` -> `Tests  68 passed (68)`; `cd web && npx vitest run` -> `Tests  1939 passed (1939)`; `npm run typecheck` -> exit 0, 0 `error TS` (log `cs-1.1-baseline.log`).
  - Evidence: the grep matches 16 files (log `cs-1.1-grep.log`).
    - Category 1: `test/pg/catalogSchema.pg.test.ts`, `test/pg/catalogPolicies.pg.test.ts`, `test/pg/catalogPolicyHelpers.pg.test.ts`, `test/pg/catalogRoles.pg.test.ts`, `test/session/isolation.int.test.ts`.
    - Category 2: `routers/staticServing.int.test.ts`, `shared/utils/loginReturnPath.test.ts`, `shared/utils/loginReturnStash.test.ts`, `pages/index/AppShell.test.tsx`.
    - Category 3: `pages/index/components/TopBar.test.tsx`.
    - Unchanged: `test/session/unknownSession.int.test.ts` (lists the nine content tables; chunks need not be there), `test/session/sessionCore.int.test.ts` (paragraph and sentiment tables only), `pages/index/RootGate.test.tsx`, `pages/index/departureWatcher.test.tsx`, `shared/components/ui/button.test.tsx`, `pages/index/useLoginReturnConsume.test.tsx` (each uses `/teams` as an existing route).

## 2. Migration: extensions, grants, config, search columns, chunks

- [x] 2.1 Test first: write `server/src/test/pg/catalogSearch.pg.test.ts`, covering:
  - `search_norm` folds `'Ångström CAFÉ Straße'` to `angstrom cafe strasse` and is immutable (`provolatile = 'i'`);
  - `catalog.search_english` matches `cafe divorce` against "Café … Divorced";
  - the five generated columns and their GIN indexes, plus the three trigram indexes, exist;
  - updating a topic summary changes what matches;
  - "Ordinary writes still succeed": an owner, as `catalog_user`, updates a session's title and notes, a topic, an event, a show and a studio;
  - "New functions are not public": `has_function_privilege` for `public`, `catalog_user` and `catalog_system` on every new function;
  - `USAGE` on `extensions` for both roles.
  - Evidence: red, before the migration: `cd server && npx vitest run --project pg src/test/pg/catalogSearch.pg.test.ts` -> `Tests  17 failed | 1 passed (18)`: `× search_norm folds accents…`, `× catalog.search_english stems…`, `× has the five generated search columns…`, `× New functions are not public…`, `× both catalog roles have USAGE on schema extensions…` and the rest with `function catalog.search_norm(unknown) does not exist` / `relation "catalog.session_transcript_chunks" does not exist` (log `cs-2.1-red.log`). The one pass is "Ordinary writes still succeed", which holds before the migration by design: it guards against the migration's `42501` on writes (panel critical 1). Green after 2.3: the same file -> `Test Files  1 passed (1)`, `Tests  18 passed (18)` (log `cs-2.1-green.log`). It also checks the trigram opclasses live in `extensions`, the definer functions' owner and pinned `search_path`, `search`'s `pg_trgm.word_similarity_threshold=0.4`, and `USAGE` on `extensions` in both the template and the `postgres` database.

  Red before the migration. Verified by the red run, then green once 2.3 lands.
- [x] 2.2 Test first: in the same file, test chunks, covering:
  - a 90-word bulk replace gives 3 chunks with the right text, `start_sec`, `end_sec` and `speaker`;
  - a one-word update rebuilds only its chunk (the other rows' `xmin` is unchanged);
  - a manual insert appends into the last chunk;
  - a delete that empties a chunk removes its row;
  - an empty-word bucket has no row;
  - RLS: owner and granted member see chunks, the ungranted member sees none (`policyFixture`);
  - a `catalog_user` insert, update or delete fails with `42501`;
  - "Concurrent edits in one block": two connections update different words of one bucket and both commit, with both words in the chunk;
  - a 30k-word bulk replace stays under 2 s.
  - Evidence: red, before the migration (same file and run as 2.1): every chunk case `×` with `relation "catalog.session_transcript_chunks" does not exist` (log `cs-2.2-red.log`). Green after 2.3 -> `Tests  18 passed (18)` (log `cs-2.2-green.log`), covering: 90-word bulk replace -> buckets `[0, 1, 2]` equal to the rule (an empty word 0 and an untimed word 80 included); word 45 `cat`->`dog` changes only bucket 1's `xmin`; a manual insert at ordinal 90 ends bucket 2 with `w89 appended`; deleting ordinals >= 80 leaves `[0, 1]`; an all-empty block has no row, an all-untimed one a null start; RLS counts owner 2, granted 2, ungranted 0, outsider 0; `catalog_user` insert, update and delete -> `42501`, chunks unchanged; a `catalog_user` word edit rebuilds through the definer trigger; two READ COMMITTED transactions editing words 5 and 6 of one block both commit and the chunk reads `alpha beta`; a 30,000-word bulk replace gives 750 chunks in under 2 s.

  Red before the migration. Verified by the red run, then green once 2.3 lands.
- [x] 2.3 Write `supabase/migrations/20261019000000_catalog_search.sql` as design D2–D5 describe:
  - `create schema if not exists extensions`, the extensions, and `USAGE` grants;
  - `catalog.search_english` and `search_norm`;
  - the generated columns and indexes;
  - `session_transcript_chunks` with `revoke insert, update, delete … from catalog_user`, the select and system policies;
  - `refresh_transcript_chunks` (with the advisory lock) and the statement-level triggers, as definer functions with `search_path` pinned;
  - the definer function `catalog.search`;
  - `revoke all … from public` on every new function, plus the grants in D2;
  - the backfill.
  - Evidence: `supabase/migrations/20261019000000_catalog_search.sql` added. `catalogSearch.pg.test.ts` green (log `cs-2.1-green.log`); the runner's checks on the file: the migrate.sh transaction-control and meta-command greps match nothing, no `concurrently`; `sh docker/supabase/test_migrate.sh` -> `test_migrate: 35 passed, 0 failed` (log `cs-2.3-migrate.log`); the full server pg project, whose global setup applies every migration with migrate.sh to `postgres` and the template -> `Test Files  15 passed | 1 skipped (16)`, `Tests  142 passed | 1 skipped (143)` (log `cs-2-pg-all.log`). 3.1 is still to come. A probe of `catalog.search` on the policy fixture (not committed) returned grouped results: titles only for the ungranted member, a `notes` match with snippet for the granted member, `christna` -> the show "Christina Ramos Live", `cafe` -> `[Café]` highlighted at word 35 with `sec` 0.5, a forged-sentinel event highlighted only on the real hit, a stop-words-only query and a null user both empty without error. Full server integration suite, run once locally -> `Tests  3 failed | 1388 passed (1391)` (log `cs-2-int-all.log`): the known `companionDevices.int` "14 concurrent creates" flake, and two raw-row pins in `test/session/eventStore.int.test.ts` (`:439`, `:570`) that now also receive `search_tsv`. That file is outside D10 category 1, so it is unchanged and open: an artifact decision for the owner. `packages/storage` pg suite -> `Tests  1 failed | 122 passed (123)`: the "8 contending read-modify-write transactions" retry test on its own scratch table `t`, which passed on two reruns (log `cs-2-storage-pg.log`).

  It follows the runner rules: no transaction-control lines at column 0, and plpgsql bodies indented. Verified by 2.1, 2.2 and 3.1 going green and by `sh docker/supabase/test_migrate.sh` passing.
- [x] 2.4 Backfill test: seed words on the template database before the migration, then assert the migrated chunks equal the rule's output. Verified by the pg test passing.
  - Evidence: `catalogSearch.pg.test.ts` "The backfill matches the rule" replays the migrations up to `20261018000000` on a `template0` database, seeds 130 words for session `a` (empty words, untimed words, an ordinal gap from 100 to 137), 30 empty words for `b` and none for `c`, runs the new migration, and finds the chunks equal to the rule computed in TypeScript (only `a`'s, 5 buckets). Red before 2.3 (`ENOENT … 20261019000000_catalog_search.sql`, log `cs-2.1-red.log`); green, log `cs-2.1-green.log`.
- [x] 2.5 Update the schema inventories (D10 category 1): `catalogSchema.pg.test.ts` (including the per-table policy conditionals), `catalogPolicies.pg.test.ts` (including the policy count, 37 → 38), `catalogPolicyHelpers.pg.test.ts`, `catalogRoles.pg.test.ts`, `isolation.int.test.ts` and `eventStore.int.test.ts` (the two raw event-row pins gain `search_tsv`). Verified by those files passing, and by `git diff` showing only D10 category 1 edits.
  - Evidence: red after the migration: `cd server && npx vitest run --project pg` over the four pg inventories plus `catalogSearch` -> `× no catalog_user policy is the constant true, and there are 37`, `× matches the recorded catalog schema`, `× has exactly the catalog tables, in schema catalog`, `× every catalog table has row-level security and a policy for each catalog role`, `Tests  4 failed | 102 passed (106)` (log `cs-2.5-red.log`). Green after the edits: `Test Files  5 passed (5)`, `Tests  106 passed (106)` (log `cs-2.5-green.log`); `npx vitest run --project integration src/test/session/isolation.int.test.ts` -> `Tests  1 passed (1)` (log `cs-2.5-green-int.log`). `git diff` of the five files shows additions only, plus the count 37 -> 38 and its test title: `catalogSchema` gains `session_transcript_chunks` in `TABLES`, `KEY_COLUMN` and the recorded schema, the three generated columns, the eight `idx_*` search indexes, one chunk row in the catalog_system write test, and a chunks policy conditional (system policy plus one select policy; select privilege only); `catalogRoles` gains the four functions in its inventory; `isolation.int` gains `session_transcript_chunks: 'bucket'`. `catalogPolicyHelpers.pg.test.ts` needed no change: it lists only the policy helpers, and the new functions' grants are asserted in `catalogSearch.pg.test.ts`.
  - Evidence: owner-approved D10 widening (2026-10-12): `eventStore.int.test.ts`'s two raw event-row pins gain `search_tsv` (`"'hi':1"`, `"'generat':1"`), nothing else changed; `cd server && npx vitest run --project integration src/test/session/eventStore.int.test.ts` -> `Tests  35 passed (35)` (log `cs-2.5-eventstore-green.log`).
- [x] 2.6 Document in `docs/supabase.md`:
  - the `extensions` schema and grants;
  - the `search_english` configuration;
  - `search_norm`;
  - the rewrite-and-reindex step for an image upgrade.
  - Evidence: `docs/supabase.md` gains "Search extensions (catalog-search)": the `extensions` schema and the `USAGE` grants (and why), `catalog.search_english`, `catalog.search_norm`, the chunks table and `catalog.search` in brief, and "After a Postgres image upgrade" with the update-and-reindex statements (`git diff docs/supabase.md`).

  Verified by the diff.

## 3. Search function and store

- [x] 3.1 Test first: write `server/src/test/pg/catalogSearchQuery.pg.test.ts`, calling `catalog.search` as `catalog_user` with `app.user_id` set. It covers:
  - each group;
  - stemming and accents;
  - phrases and `-exclusion`;
  - a typo in a show name (`christna`);
  - a stop-words-only query still runs name matching;
  - hidden and showless sessions never match;
  - the D6 matrix (owner, granted member, ungranted member, outsider) across all groups, `match` and snippets;
  - "Hidden notes don't affect ranking";
  - another team is invisible;
  - filters, with a foreign or unknown id giving identical empty groups;
  - limits, and at most 3 moments per session;
  - `sec` for a chunk and null for topics and events;
  - an accented hit at word 35 is highlighted;
  - forged sentinels are stripped;
  - index use: with at least 5,000 seeded chunks, sessions and shows, and planner statistics refreshed, `pg_stat_user_indexes.idx_scan` rises across one `catalog.search` call (after `pg_stat_force_next_flush()`) for the chunks GIN index, the `search_meta` GIN index and the show-name trigram index (`EXPLAIN` can't see inside the function);
  - a temp table named `sessions` created by `catalog_user` doesn't change the results;
  - a null `app.user_id` returns empty.
  - Evidence: `catalog.search` already existed (2.3, `ef1ac326`), so no test could be red for a missing function; the first run, `cd server && npx vitest run --project pg src/test/pg/catalogSearchQuery.pg.test.ts` -> `Tests  5 failed | 15 passed (20)` (log `cs-3.1-red.log`), failed only on test faults, none on the function: the title word `lighthouse` also fuzzy-matched the show "Harbor Lights" (renamed to `osprey`); `ts_headline` drops a leading stop word (`walrus sang \uE000beacon\uE001`); the ranking check scanned the echoed `q`; `ts_headline` trims the start of a fragment, so `<img src=x ` is cut but the rest stays unescaped plain text (asserted as such; the web renders it literally, 5.3); and the index check used plain `ANALYZE`, which leaves rows in the GIN pending lists, so the trigram and `search_meta` scans lost to a seq scan at 5,000 rows (an owner-run `EXPLAIN` probe, not committed, showed `Seq Scan` before and `BitmapOr` over `idx_shows_name_trgm` / `idx_sessions_search_meta` / `idx_sessions_title_trgm` / `idx_sessions_search_notes` after `VACUUM ANALYZE`; the test now runs `VACUUM ANALYZE`). The 15 cases that passed on first run pass because 2.3 already implements D5/D6/D8: the D6 matrix (owner, admin, granted, ungranted, outsider over studios, shows, title, episode, notes, transcript, topic, event, plus a word in all of them), snippets, "An ungranted member matches titles only", other teams invisible, filters (foreign and unknown show or studio ids give identical `{q, …empty}` bodies; `show_id` s1 narrows every group), null user, the temp `sessions`/`shows`/`session_transcript_chunks` tables, "Hidden notes don't affect ranking", stemming and accents, phrases/`-`/`or`, `christna`, stop words, hidden and showless sessions, limits (default 5, clamp 1–25), 3 moments per session, `sec`, `Café` at word 35, forged sentinels. No migration change. Green: same command -> `Test Files  1 passed (1)`, `Tests  20 passed (20)` (log `cs-3.1-green.log`); the index case asserts `idx_scan` rises for `idx_session_chunks_search`, `idx_sessions_search_meta` and `idx_shows_name_trgm` across one call (after `pg_stat_force_next_flush()`).

  Red first. Verified by red, then green after 2.3.
- [x] 3.2 Test first: write unit tests for `searchStore.ts` with a fake `CatalogDb`:
  - it sends `SET LOCAL statement_timeout = '3s'` and one `select catalog.search(…)` in one transaction;
  - `57014` maps to `SearchTimeoutError`;
  - a third concurrent search waits, and gets `SearchBusyError` after 1 s while two are running.
  - Evidence: red: `cd packages/catalog && npx vitest run` -> `Test Files  1 failed | 7 passed (8)`, `Error: Cannot find module './searchStore'` (log `cs-3.2-red.log`). Green after `packages/catalog/src/searchStore.ts` (`SearchStore`, `SearchSlots`, `SEARCH_SLOTS` = 2 slots / 1000 ms, `SearchTimeoutError`, `SearchBusyError`, exported from the package) and `Catalog.search` (a method over a private store, so `Object.keys(catalog)` is unchanged): same command -> `Test Files  8 passed (8)`, `Tests  60 passed (60)` (log `cs-3.2-green.log`), covering the one-transaction pair `SET LOCAL statement_timeout = '3s'` + `select catalog.search(?::text, ?::text, ?::text, ?::int) as r`, defaults (null filters, limit 5), `57014` -> `SearchTimeoutError` with `cause`, other errors unchanged, slots released on error, the third search pending at 999 ms and `SearchBusyError` at 1000 ms (fake timers), a waiter granted within the second, FIFO waiters, and the facade sharing the process-wide slots. `npm run typecheck` -> exit 0, 0 `error TS` (log `cs-3.2-typecheck.log`).

  Then implement the store and expose it as `catalog.search`. Verified by the tests and `npm run typecheck` exit 0.

## 4. Contract and route

- [ ] 4.1 Test first: add contract tests for the `searchQuerySchema` bounds (`q` 2–200 after trimming; `limit` 1–25, default 5) and the strict `searchResponseSchema` (`sec` null for topic and event). Red first. Verified by the contract suite.
- [ ] 4.2 Test first: write `server/src/routers/search.int.test.ts`, covering:
  - 200 with the full shape;
  - 401 anonymous;
  - 422 for each bound;
  - a masked foreign filter, identical to an unknown id apart from `q`;
  - 503 with the timeout detail on `SearchTimeoutError` and on `CatalogTxTimeoutError`;
  - 503 busy;
  - "Searches can't starve the app": with 6 slow searches in flight, an unrelated `GET /api/profile` completes;
  - unknown query parameters are ignored;
  - the request makes no writes (the session `revision` and the table row counts are unchanged);
  - no `Set-Cookie`.

  Red first. Verified by red, then green after 4.3.
- [ ] 4.3 Implement `server/src/routers/search.ts`, mount it in `app.ts`, and add the schemas to `packages/contract/src/schemas.ts`. Verified by 4.1 and 4.2 green.
- [ ] 4.4 Add a fixture case to `apiResponseFixtures.int.test.ts`, capture `fixtures/api-responses/search.json`, and add `SearchResponse` to `web/src/api/types.ts`. Verified by `apiResponseFixtures`, `types.conformance.test.ts` and `apiResponseShapes.repo.test.ts` passing.
- [ ] 4.5 The `/search` shell route. Test first, with `staticServing.int.test.ts` cases:
  - `GET /search?q=x` gives 200 with the shell and no cookie;
  - `/search/extra` and `/search/` give 404.

  Then extend `loginReturnPath.ts` (the predicate and the segment shape) and the route-inventory tests (D10 category 2). Verified by those tests passing.
- [ ] 4.6 Add README endpoint rows for `GET /api/search` (including both 503s) and `GET /search`, with origin `routers/search.ts (new, catalog-search)`. Verified by the diff and any README inventory test.

## 5. Web

- [ ] 5.1 Add the shadcn `command` component with `cmdk` pinned exactly. Verified by `shadcnHygiene.repo.test.ts` and `package.json`.
- [ ] 5.2 Test first: add the `useSearch` hook and the `searchKeys` factory, with tests for:
  - no fetch for `q` under 2 characters;
  - `retry: false`;
  - the AbortSignal is passed.

  Verified by `queryKeyFactories.repo.test.ts` and the hook tests.
- [ ] 5.3 Test first: write `SearchSnippet.test.tsx`: sentinels render as `<mark>`, and `<img onerror>` text renders literally with no `img` element. Then implement. Verified by the tests.
- [ ] 5.4 Test first: extract TopBar's switch logic into `useSwitchActive`. Existing TopBar tests keep their assertions (D10 category 3), and new tests cover a show switch across studios, which sends `{active_studio_id, active_show_id}` in one PUT through `confirmSwitch`. Verified by the TopBar and hook tests.
- [ ] 5.5 Test first: write `SearchPalette.test.tsx`, covering:
  - Cmd/Ctrl-K opens it, except while typing in a field or while another dialog or sheet is open;
  - the top-bar button opens it, and its tooltip names the shortcut;
  - the 200 ms debounce and grouped results;
  - navigation: a session goes to `/sessions/<id>`, a transcript moment to `?t=`, a topic to `?topic=`, an event to `?event=`;
  - a show or studio result goes through `useSwitchActive`, then `/`;
  - "See all results" goes to `/search?q=`.

  Then implement. Verified by the tests.
- [ ] 5.6 Test first: write `SearchRoute.test.tsx`, covering:
  - URL-driven `q` and filters, with replace on edit;
  - limit 25;
  - loading, empty, timeout and busy states.

  Then add it to `AppShell`, and add `/search` to `AppShell.test.tsx` (D10 category 2). Verified by the tests.
- [ ] 5.7 Test first: write the moment deep-link tests in the session workspace, covering:
  - `?t=754.2` waits for status and timeline, then moves the timeline once via `jumpTimelineToSec`, with no playback;
  - `?topic=` and `?event=` use the feed placement helpers and gates;
  - `?t=abc` and an unplaceable event give no seek;
  - a rolling session gives no seek;
  - the parameter is removed with a replace;
  - precedence is `t`, then `topic`, then `event`;
  - a link to the already-open session applies without a remount;
  - the login-return stash keeps the query.

  Then implement. Verified by the tests.
- [ ] 5.8 Check the UI with agent-browser on the dev stack (`localhost:8787`) at desktop and mobile widths:
  - the palette;
  - `/search`;
  - a transcript moment opening at its time without playing;
  - a show hit in another studio switching studio and show.

  Verified by screenshots noted in Evidence.

## 6. Docs, verification, PR

- [ ] 6.1 Write ADR `docs/decisions/0029-catalog-search.md`: lexical search in Postgres, vectors deferred, a definer search function, chunks in ordinal buckets, the 3 s budget and the 2-search cap instead of a limiter, and the unaccent rewrite-and-reindex step. Verified by the file existing and `scripts/check-change.sh --stage hook` passing.
- [ ] 6.2 Run the dev-stack manual checks:
  - search a word spoken in session `eea6c73f-2995-4c16-83c9-77c18b1bed43`, and it opens at the right time;
  - a misspelled show name finds the show;
  - an ungranted member account matches on titles only;
  - run `EXPLAIN ANALYZE` on an owner-run copy of each branch query from `catalog.search`, and diff `pg_stat_user_indexes.idx_scan` around a real call, to show each group's index is used.

  Verified by the notes and plan excerpts in Evidence.
- [ ] 6.3 Run `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook` and `openspec validate --all --strict`, then run the consistency read and append it to `panel.md`. Verified by green output.
- [ ] 6.4 When the owner asks, push the branch and open a PR to `supabase-migration`, then confirm CI is green. Verified by the PR checks.
