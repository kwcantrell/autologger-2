# Tasks

**Branch and commits**
- The first commit on `show-wiki` holds only `openspec/changes/show-wiki/`.
- The PR targets `supabase-migration`.
- The gates run with `GITHUB_BASE_REF=supabase-migration`.

**Logs and test-first**
- Logs live under the session scratchpad as `sw-<task>-<red|green>.log`, and each `Evidence:` line names its log.
- Each "test first" item is red before its change, or records why it already passes.
- Each task's text and its `Evidence:` stay in one block with no blank line.

**Commands**
- Targeted server tests: `cd server && npx vitest run --project <unit|integration|pg> <files>`.
- Packages: `npx vitest run` in `packages/{contract,catalog}`.
- Web: `cd web && npx vitest run`.
- `npm run typecheck`.
- Migrations: `sh docker/supabase/test_migrate.sh`.
- The full pg and integration suites run in CI on the PR (ADR 0026). Locally, run the targeted tests, the unit suites and typecheck.

**Changing tests.** Changing an existing test is allowed only for the categories in design D8. Anything else is a stop: update the artifacts and ask the owner.

## 1. Baselines

- [x] 1.1 On the base, run the unit suites (server, packages, web) and typecheck, and record the counts. Then list the existing tests D8 may touch with `grep -rln "toHaveLength(38)\|'/search'\|isRouterKnownPathname\|isShellSegments\|momentHref\|useSwitchActive\|has_function_privilege\|expectCapturedResponse\|FACTORY_MODULE\|SearchPalette\|FEED_TABS" --include=*.test.ts --include=*.test.tsx server/src packages web/src`, and classify each hit as D8 category 1–6 or unchanged. Verified by the recorded counts and the classified list.
  Evidence: `sw-1.1-baseline.log`: server unit `482 passed | 5 skipped`; contract `149 passed`; catalog `61 passed`; web `2028 passed (152 files)`; `typecheck rc=0`. `sw-1.1-d8-classified.log`: 13 hits — cat 1: catalogPolicies, catalogPolicyHelpers, catalogRoles; cat 2: staticServing, AppShell, loginReturnPath; cat 4: useSwitchActive; cat 5: apiResponseFixtures, queryKeyFactories; unchanged: catalogSearch.pg, SearchPalette, SearchRoute, apiResponseShapes.repo.

## 2. Migration: wiki tables, policies, keys

- [x] 2.1 Test first: write `server/src/test/pg/showWiki.pg.test.ts` (using `policyFixture` and `asUser`), covering:
  - the three tables, their columns, checks, unique indexes and composite foreign keys exist, plus `sessions (id, show_id)`;
  - "Ungranted member reads no wiki rows": owner and granted member see a show's pages, aliases and revisions, while the ungranted member and outsider see none, for select, insert, update and delete;
  - "Revisions are append-only for users": update and delete as `catalog_user` give `42501`;
  - "Revisions carry their real author": an insert with another user's `author_user_id` is refused;
  - "Session page in the wrong show" and "Alias in the wrong show": each is refused by its foreign key, including for a user who can access both shows; the same holds for a `merged_into` that points at a page in another show;
  - live-title uniqueness ignores case and accents, and frees names on merge or delete; alias uniqueness per show;
  - `kind`/`session_id` coupling and length checks.
  Red before the migration. Verified by the red run, then green once 2.2 lands.
  Evidence: `sw-2.1-red.log`: `relation "wiki_pages" does not exist` → `Test Files 1 failed`, `Tests 25 skipped`. `sw-2.1-green.log`: `cd server && npx vitest run --project pg src/test/pg/showWiki.pg.test.ts` → `Tests 25 passed (25)`.
- [x] 2.2 Write `supabase/migrations/20261021000000_show_wiki.sql` as design D1–D2 describe:
  - `unique (id, show_id)` on `catalog.sessions`;
  - the tables, keys and indexes;
  - RLS policies and revokes.
  Update the schema inventories (D8 category 1). Verified by 2.1 green, the inventory pg tests green, and `sh docker/supabase/test_migrate.sh` passing.
  Evidence: `sw-2.2-green.log`: catalogSchema, catalogPolicies (count 38 → 42), catalogPolicyHelpers, catalogRoles → `Test Files 4 passed`, `Tests 88 passed (88)`; only catalogSchema and catalogPolicies needed additions (no new function, no session table). `sw-2.2-migrate.log`: `test_migrate: 35 passed, 0 failed` (runner fixtures only; the repo migration itself is applied by the pg global setup). `sw-2.2-pg-full.log`: whole pg project `Tests 202 passed | 1 skipped`.

## 3. Link parser and store

- [x] 3.1 Add `mdast-util-from-markdown` 2.0.2, pinned exactly, to `packages/contract`. Test first: write `packages/contract/src/wikiLinks.test.ts` for `parseWikiLinks`, covering:
  - `cite:` and `wiki:` links with their label and position;
  - decimal seconds with up to 3 places;
  - malformed targets reported;
  - every CommonMark form is found with its decoded URL: reference definitions, angle-bracket destinations, autolinks, links with titles, padded destinations, backslash escapes, entities, and upper-case schemes (reported invalid);
  - links inside code spans and fenced or indented code are ignored;
  - other schemes are ignored;
  - the 500-link count.
  Then implement `wikiLinks.ts`. Verified by the tests.
  Evidence: `sw-3.1-red.log`: `Cannot find module './wikiLinks'` → `Test Files 1 failed`. `sw-3.1-green.log`: `npx vitest run src/wikiLinks.test.ts` → `Tests 18 passed (18)`; contract suite `Tests 167 passed (167)` (baseline 149); `npm run typecheck` → `exit=0`; `npm ls mdast-util-from-markdown` → `mdast-util-from-markdown@2.0.2`.
- [ ] 3.2 Test first: write `server/src/test/pg/wikiStore.pg.test.ts` for `catalog.wiki` against the policy fixture, covering:
  - create with revision 1 and note `created`, with `*_by_name` snapshotted, and still shown after the author leaves the team;
  - edit with compare-and-set (a stale write changes nothing and raises `WikiConflictError` with the current page);
  - title/title, alias/alias and title/alias clashes each raise `WikiTitleTakenError` with `page_id`, found by the pre-check before any write;
  - "Duplicate aliases in one request collapse";
  - a no-op edit appends no revision;
  - a `kind` change to or from `session` raises `WikiInvalidError`;
  - two concurrent creates whose title and alias clash: exactly one succeeds, and the other gets `WikiTitleTakenError` with `page_id`;
  - a session page twice raises `WikiSessionTakenError`;
  - a session from another show is refused;
  - links: a citation to another show's session, or a page link to another show's page, raises `WikiInvalidError` naming the link, including through a reference definition and an autolink; a citation to a hidden session of the show is accepted;
  - delete, the deleted list, and restore, including a restore blocked by a new page holding the title; a deleted page reports its newest revision's aliases, and restore brings them back as alias rows;
  - restoring a revision through an edit with `restored_from` appends a revision noted `restored r<n>`;
  - revisions are paged with `limit` and `before`;
  - "Merge leaves a redirect", with aliases deduplicated and A's title escaped in the heading (a title like `x](wiki:…)` adds no link); a merge that is stale on either side changes nothing; "Merge that would overflow is refused" for both the body and the 50-alias limit;
  - "Split moves text atomically";
  - the list sorts by normalised title;
  - the 2000 cap sets `truncated`;
  - `*_by_name` never holds an email.

  Then implement `packages/catalog/src/wikiStore.ts` and add it to the facade. Verified by the tests and the catalog unit suite.

## 4. API

- [x] 4.1 Test first: add the wiki schemas to `packages/contract/src/schemas.ts`, with `schemas.wiki.test.ts` covering:
  - strict responses;
  - request limits (title, body, aliases, NUL, and control characters in titles and aliases);
  - `session_id` required exactly for `session`;
  - `expected_revision` as a positive integer.
  Then implement. Verified by the tests.
  Evidence: `sw-4.1-red.log`: `Tests 37 failed (37)` (schemas undefined). `sw-4.1-green.log`: `npx vitest run src/schemas.wiki.test.ts` → `Tests 37 passed (37)`; contract suite `Tests 204 passed (204)`; `npm run typecheck` rc=0; `npx biome check` clean.
- [ ] 4.2 Test first: write `server/src/routers/wiki.int.test.ts`, covering every endpoint in the api-contract-freeze delta:
  - 200 or 201 shapes;
  - 401;
  - masked 404s for an ungranted member, an outsider and a nonexistent id;
  - each 409 body (version conflict with `current`, merged, deleted, not deleted, title used, session has a page);
  - each 422 (schema, bad link, merge into self, merge overflow, a `kind` change to or from `session`, a session kind in split, a session from another show);
  - the scenarios "Create then list", "Stale edit", "Read an old revision", "Revisions page backwards" and "Merge answers the target";
  - `GET` of a merged page and of a deleted page returns their aliases from the newest revision.

  Then implement `server/src/routers/wiki.ts` and mount it. Verified by the tests.
- [ ] 4.3 Capture the fixtures (`fixtures/api-responses/wiki*.json`) in `apiResponseFixtures.int.test.ts` (D8 category 5), including the conflict branch. Add the README endpoint rows. Verified by `npm run fixtures:capture -w server` and the fixtures test.
- [x] 4.4 Test first: in `staticServing.int.test.ts` (D8 category 2), check that:
  - `GET /wiki` and `GET /wiki/abc` serve the shell with no `Set-Cookie`;
  - `/wiki/`, `/wiki/abc/` and `/wiki/abc/history` give 404.
  Then extend `loginReturnPath.ts` (`isWikiRoutePathname`, `isRouterKnownPathname`, `isShellSegments`), with its unit tests, covering "Nested wiki path stays 404" from the web-frontend-platform delta. Verified by the tests.
  Evidence: `sw-4.4-red.log`: `loginReturnPath.test.ts` → `Tests 3 failed | 68 passed` (`isWikiRoutePathname is not a function`); staticServing int already `38 passed` (the server hands off generically, so its new cases pin behaviour). `sw-4.4-green.log`: loginReturnPath + loginReturnStash → `Tests 93 passed (93)`; `staticServing.int.test.ts` → `Tests 38 passed (38)` (`/wiki`, `/wiki/abc` shell with no `Set-Cookie`; `/wiki/`, `/wiki/abc/` 404; `/wiki/abc/history` is handed to the frontend, whose `isShellSegments` gives the 404, as `/search/extra` does). No existing assertion changed.

## 5. Web

- [x] 5.1 Add `react-markdown` 10.1.0 and `diff` 8.0.2 to `web/package.json`, pinned exactly. Verified by `npm ls react-markdown diff` and `shadcnHygiene.repo.test.ts`.
  Evidence: `sw-5.1-green.log`: `npm ls react-markdown diff` → `diff@8.0.2`, `react-markdown@10.1.0`; `shadcnHygiene.repo.test.ts` → `Tests 7 passed (7)`. `diff` ships its own types.
- [ ] 5.2 Test first: write `useWiki.test.tsx` for the hooks and `wikiKeys`, covering:
  - list, page, revisions and revision queries;
  - mutations invalidate the right keys;
  - a `409` surfaces as a version conflict;
  - registration in `queryKeyFactories.repo.test.ts` (D8 category 5);
  - types in `api/types.ts`, with conformance checks against the captured fixtures in `types.conformance.test.ts` (D8 category 5);
  - revisions as an infinite query over `next_before`.

  Then implement. In `useSwitchActive`, add a `wikiKeys.all()` invalidation (D8 category 4). Verified by the tests and the repo tests.
- [x] 5.3 Test first: write `WikiMarkdown.test.tsx`, covering:
  - "Script links are inert": `<img onerror>` gives no `img`, and a `javascript:` link renders as text;
  - a `cite:` link renders an `<a>` to `/sessions/S1?t=754`, labelled `0:12:34`;
  - a malformed `cite:`, an upper-case `CITE:` and an image each render as text;
  - a `wiki:` link goes to `/wiki/<id>`;
  - an `https:` link gets `target=_blank` and `rel="noopener noreferrer"`;
  - headings and lists render.
  Extract `secondsHref` into `searchLinks.ts` (D8 category 3). Verified by the tests and the existing `searchLinks` tests.
  Evidence: `sw-5.3-red.log`: `Failed to resolve import "./WikiMarkdown"` → `Test Files 2 failed`. `sw-5.3-green.log`: wiki tests `Tests 48 passed (48)`; search tests (searchLinks callers) `Tests 41 passed (41)`; full web suite `Tests 2080 passed (2080)`; typecheck rc=0. No existing test edited. Note: `webBoundaries.repo.test.ts` bars web production code from importing `packages/`, so `wiki/wikiUrl.ts` copies `classifyWikiUrl` and `wikiUrl.pinning.test.ts` checks it against the contract on 34 URLs (the `aiV2/clientAggregates` precedent).
- [ ] 5.4 Test first: write `WikiRoute.test.tsx`, covering:
  - the tabs per kind;
  - the filter;
  - the Deleted view with Restore;
  - New page creates and navigates;
  - with no active show, it asks to choose one.

  Then implement, plus the `/wiki` and `/wiki/:pageId` routes in `AppShell` (D8 category 2), and the TopBar "Wiki" link with a `TopBar.test.tsx` assertion (D8 category 6). Verified by the tests.
- [ ] 5.5 Test first: write `WikiPageView.test.tsx`, covering:
  - the rendered body and metadata;
  - edit and save;
  - "Edit conflict keeps the draft";
  - alias chips;
  - a merged page replaces the URL with its target;
  - a page of another show offers a switch;
  - delete confirms first.

  Then implement. Verified by the tests.
- [ ] 5.6 Test first: write the tests for `WikiHistorySheet`, `WikiMergeDialog` and `WikiSplitDialog`:
  - revisions newest first, with "Load older";
  - the line diff against the current page;
  - restore sends a `PUT` with the revision's content, `restored_from` and `expected_revision`;
  - the merge picker lists only other live non-session pages of the show and confirms first;
  - split sends the remaining body and the new page.

  Then implement. Verified by the tests.
- [ ] 5.7 Test first: write `SessionWorkspace.wikiButton.test.tsx` for "Session page from the workspace":
  - the button is at the end of the feed-tab row;
  - the first press creates the page and opens it;
  - the second press opens the same page;
  - a `409 Session already has a page.` opens the named page.

  Then implement the "Wiki page" button. Verified by the tests.
- [ ] 5.8 Check the UI with agent-browser on the dev stack (`localhost:8787`) at desktop and mobile widths: list, page, edit, conflict, history diff, merge, split, citation click and seek, the session-page button, and the top bar on one line at 390px. Fix what the check finds. Verified by screenshots noted in the evidence.

## 6. Docs, verification, PR

- [ ] 6.1 Write ADR `docs/decisions/0030-show-wiki.md`: Markdown with inline `cite:`/`wiki:` links validated on the rendering parse, append-only revisions with name snapshots, compare-and-set with name pre-checks, access through `accessible_shows` plus composite keys, react-markdown safety, and the split from `show-wiki-ai`. Verified by the file and the ADR index check in `check-change.sh`.
- [ ] 6.2 Run the dev-stack manual checks:
  1. create a person page with a citation, open it, and the session seeks;
  2. two tabs edit the same page, and the second gets the conflict banner;
  3. merge two pages: the old page redirects and its title becomes an alias;
  4. an ungranted member gets 404 on the wiki;
  5. history diff and restore.

  Verified by notes in the evidence.
- [ ] 6.3 Run `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook` and `openspec validate --all --strict`, then run the consistency read and append it to `panel.md`. Verified by green runs.
- [ ] 6.4 When the owner asks, push the branch and open a PR to `supabase-migration`, then confirm CI is green. Verified by the PR checks.
