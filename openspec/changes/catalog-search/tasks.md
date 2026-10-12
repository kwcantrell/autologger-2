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

- [ ] 1.1 On the base, run the unit suites (server, packages, web) and typecheck, and record the counts. Then list the existing tests D10 may touch with `grep -rln "session_transcript_paragraphs\|'/teams'\|isRouterKnownPathname\|isTeamsRoutePathname\|has_function_privilege\|confirmSwitch" --include=*.test.ts --include=*.test.tsx server/src packages web/src`, and classify each hit as D10 category 1, 2, 3 or unchanged. Verified by the recorded counts and the classified list.

## 2. Migration: extensions, grants, config, search columns, chunks

- [ ] 2.1 Test first: write `server/src/test/pg/catalogSearch.pg.test.ts`, covering:
  - `search_norm` folds `'Ångström CAFÉ Straße'` to `angstrom cafe strasse` and is immutable (`provolatile = 'i'`);
  - `catalog.search_english` matches `cafe divorce` against "Café … Divorced";
  - the five generated columns and their GIN indexes, plus the three trigram indexes, exist;
  - updating a topic summary changes what matches;
  - "Ordinary writes still succeed": an owner, as `catalog_user`, updates a session's title and notes, a topic, an event, a show and a studio;
  - "New functions are not public": `has_function_privilege` for `public`, `catalog_user` and `catalog_system` on every new function;
  - `USAGE` on `extensions` for both roles.

  Red before the migration. Verified by the red run, then green once 2.3 lands.
- [ ] 2.2 Test first: in the same file, test chunks, covering:
  - a 90-word bulk replace gives 3 chunks with the right text, `start_sec`, `end_sec` and `speaker`;
  - a one-word update rebuilds only its chunk (the other rows' `xmin` is unchanged);
  - a manual insert appends into the last chunk;
  - a delete that empties a chunk removes its row;
  - an empty-word bucket has no row;
  - RLS: owner and granted member see chunks, the ungranted member sees none (`policyFixture`);
  - a `catalog_user` insert, update or delete fails with `42501`;
  - "Concurrent edits in one block": two connections update different words of one bucket and both commit, with both words in the chunk;
  - a 30k-word bulk replace stays under 2 s.

  Red before the migration. Verified by the red run, then green once 2.3 lands.
- [ ] 2.3 Write `supabase/migrations/20261019000000_catalog_search.sql` as design D2–D5 describe:
  - `create schema if not exists extensions`, the extensions, and `USAGE` grants;
  - `catalog.search_english` and `search_norm`;
  - the generated columns and indexes;
  - `session_transcript_chunks` with `revoke insert, update, delete … from catalog_user`, the select and system policies;
  - `refresh_transcript_chunks` (with the advisory lock) and the statement-level triggers, as definer functions with `search_path` pinned;
  - the definer function `catalog.search`;
  - `revoke all … from public` on every new function, plus the grants in D2;
  - the backfill.

  It follows the runner rules: no transaction-control lines at column 0, and plpgsql bodies indented. Verified by 2.1, 2.2 and 3.1 going green and by `sh docker/supabase/test_migrate.sh` passing.
- [ ] 2.4 Backfill test: seed words on the template database before the migration, then assert the migrated chunks equal the rule's output. Verified by the pg test passing.
- [ ] 2.5 Update the schema inventories (D10 category 1): `catalogSchema.pg.test.ts` (including the per-table policy conditionals), `catalogPolicies.pg.test.ts` (including the policy count, 37 → 38), `catalogPolicyHelpers.pg.test.ts`, `catalogRoles.pg.test.ts` and `isolation.int.test.ts`. Verified by those files passing, and by `git diff` showing only D10 category 1 edits.
- [ ] 2.6 Document in `docs/supabase.md`:
  - the `extensions` schema and grants;
  - the `search_english` configuration;
  - `search_norm`;
  - the rewrite-and-reindex step for an image upgrade.

  Verified by the diff.

## 3. Search function and store

- [ ] 3.1 Test first: write `server/src/test/pg/catalogSearchQuery.pg.test.ts`, calling `catalog.search` as `catalog_user` with `app.user_id` set. It covers:
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

  Red first. Verified by red, then green after 2.3.
- [ ] 3.2 Test first: write unit tests for `searchStore.ts` with a fake `CatalogDb`:
  - it sends `SET LOCAL statement_timeout = '3s'` and one `select catalog.search(…)` in one transaction;
  - `57014` maps to `SearchTimeoutError`;
  - a third concurrent search waits, and gets `SearchBusyError` after 1 s while two are running.

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
