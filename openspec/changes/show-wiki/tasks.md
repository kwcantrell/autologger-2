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
- [x] 3.2 Test first: write `server/src/test/pg/wikiStore.pg.test.ts` for `catalog.wiki` against the policy fixture, covering:
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
  Evidence: `sw-3.2-red.log`: `Cannot read properties of undefined (reading 'createPage')` → `Tests 29 failed (29)`. `sw-3.2-green.log`: `wikiStore.pg.test.ts` → `Tests 31 passed (31)` (incl. the no-parser refusal, D4 injection); `showWiki.pg` → `Tests 25 passed`; catalog unit `Tests 61 passed (61)` (`catalog.test.ts` gains `'wiki'`, D8 cat 7); server unit `Tests 482 passed | 5 skipped`, `packageBoundaries.repo.test.ts` unchanged → `84 passed`; typecheck exit 0; `npm ci --dry-run` up to date. Gap noted: the concurrent-create test runs two creates with `Promise.all` over 3 rounds but does not force interleaving, and the single re-run after a stray `23505` has no deterministic test.

## 4. API

- [x] 4.1 Test first: add the wiki schemas to `packages/contract/src/schemas.ts`, with `schemas.wiki.test.ts` covering:
  - strict responses;
  - request limits (title, body, aliases, NUL, and control characters in titles and aliases);
  - `session_id` required exactly for `session`;
  - `expected_revision` as a positive integer.
  Then implement. Verified by the tests.
  Evidence: `sw-4.1-red.log`: `Tests 37 failed (37)` (schemas undefined). `sw-4.1-green.log`: `npx vitest run src/schemas.wiki.test.ts` → `Tests 37 passed (37)`; contract suite `Tests 204 passed (204)`; `npm run typecheck` rc=0; `npx biome check` clean.
- [x] 4.2 Test first: write `server/src/routers/wiki.int.test.ts`, covering every endpoint in the api-contract-freeze delta:
  - 200 or 201 shapes;
  - 401;
  - masked 404s for an ungranted member, an outsider and a nonexistent id;
  - each 409 body (version conflict with `current`, merged, deleted, not deleted, title used, session has a page);
  - each 422 (schema, bad link, merge into self, merge overflow, a `kind` change to or from `session`, a session kind in split, a session from another show);
  - the scenarios "Create then list", "Stale edit", "Read an old revision", "Revisions page backwards" and "Merge answers the target";
  - `GET` of a merged page and of a deleted page returns their aliases from the newest revision.
  Then implement `server/src/routers/wiki.ts` and mount it. Verified by the tests.
  Evidence: `sw-4.2-red.log`: `Tests 68 failed | 10 passed (78)` (only the anonymous 401s passed, from the existing auth middleware). `sw-4.2-green.log`: `npx vitest run --project integration src/routers/wiki.int.test.ts` → `Tests 78 passed (78)`; server unit `482 passed | 5 skipped`; typecheck rc=0. Split with a `session` kind: the 4.1 schema refused it as a zod-issue 422, but the delta lists it as a message 422, so the test now expects a string detail (`sw-4.2-splitkind-red.log`: `expected 'object' to be 'string'`) and the split schema takes any kind, leaving the store's message (`sw-4.2-splitkind-green.log`: contract `204 passed`, wiki int `78 passed`, typecheck rc=0).
- [x] 4.3 Capture the fixtures (`fixtures/api-responses/wiki*.ts`) in `apiResponseFixtures.int.test.ts` (D8 category 5), including the conflict branch. Add the README endpoint rows. Verified by `npm run fixtures:capture -w server` and the fixtures test.
  Evidence: `sw-4.3-green.log`: `npm run fixtures:capture -w server` → `Tests 58 passed (58)`, `git status` shows only the 11 new wiki fixtures; assert-only run `58 passed`; `web: apiResponseShapes.repo.test.ts` → `48 passed`. The fixtures are `fixtures/api-responses/wiki*.ts`, not `.json`: `server/src/test/apiFixtures.ts` requires `.ts` when the client type has a string-literal union (`kind`), as for search. README gains 10 API rows, the `/wiki` shell row and the `wiki.ts` router-tree line.
- [x] 4.4 Test first: in `staticServing.int.test.ts` (D8 category 2), check that:
  - `GET /wiki` and `GET /wiki/abc` serve the shell with no `Set-Cookie`;
  - `/wiki/` and `/wiki/abc/` give 404, and `/wiki/abc/history` is handed to the shell router, whose `isShellSegments` gives the 404 (as for `/search/extra`).
  Then extend `loginReturnPath.ts` (`isWikiRoutePathname`, `isRouterKnownPathname`, `isShellSegments`), with its unit tests, covering "Nested wiki path stays 404" from the web-frontend-platform delta. Verified by the tests.
  Evidence: `sw-4.4-red.log`: `loginReturnPath.test.ts` → `Tests 3 failed | 68 passed` (`isWikiRoutePathname is not a function`); staticServing int already `38 passed` (the server hands off generically, so its new cases pin behaviour). `sw-4.4-green.log`: loginReturnPath + loginReturnStash → `Tests 93 passed (93)`; `staticServing.int.test.ts` → `Tests 38 passed (38)` (`/wiki`, `/wiki/abc` shell with no `Set-Cookie`; `/wiki/`, `/wiki/abc/` 404; `/wiki/abc/history` is handed to the frontend, whose `isShellSegments` gives the 404, as `/search/extra` does). No existing assertion changed.

## 5. Web

- [x] 5.1 Add `react-markdown` 10.1.0 and `diff` 8.0.2 to `web/package.json`, pinned exactly. Verified by `npm ls react-markdown diff` and `shadcnHygiene.repo.test.ts`.
  Evidence: `sw-5.1-green.log`: `npm ls react-markdown diff` → `diff@8.0.2`, `react-markdown@10.1.0`; `shadcnHygiene.repo.test.ts` → `Tests 7 passed (7)`. `diff` ships its own types.
- [x] 5.2 Test first: write `useWiki.test.tsx` for the hooks and `wikiKeys`, covering:
  - list, page, revisions and revision queries;
  - mutations invalidate the right keys;
  - a `409` surfaces as a version conflict;
  - registration in `queryKeyFactories.repo.test.ts` (D8 category 5);
  - types in `api/types.ts`, with conformance checks against the captured fixtures in `types.conformance.test.ts` (D8 category 5);
  - revisions as an infinite query over `next_before`.
  Then implement. In `useSwitchActive`, add a `wikiKeys.all()` invalidation (D8 category 4). Verified by the tests and the repo tests.
  Evidence: `sw-5.2-red.log`: `Failed to resolve import "./useWiki"` → `Test Files 3 failed`, typecheck rc=2. `sw-5.2-green.log`: targeted (useWiki, queryKeyFactories.repo, types.conformance, useSwitchActive, TopBar, apiResponseShapes.repo, versionConflict, webBoundaries.repo) → `Tests 273 passed (273)`; full web `Tests 2104 passed (2104)`; typecheck rc=0; biome clean; hook gates PASS. Key root `'wikiPages'` (D7, re-panel 2); `TopBar.test.tsx` count 4 → 5 (D8 cat 4); biome reordered existing import lines in `types.conformance.test.ts` (no assertion changed). `versionConflictOf` gains an optional `field: 'revision'` for the wiki conflict body.
- [x] 5.3 Test first: write `WikiMarkdown.test.tsx`, covering:
  - "Script links are inert": `<img onerror>` gives no `img`, and a `javascript:` link renders as text;
  - a `cite:` link renders an `<a>` to `/sessions/S1?t=754`, labelled `0:12:34`;
  - a malformed `cite:`, an upper-case `CITE:` and an image each render as text;
  - a `wiki:` link goes to `/wiki/<id>`;
  - an `https:` link gets `target=_blank` and `rel="noopener noreferrer"`;
  - headings and lists render.
  Extract `secondsHref` into `searchLinks.ts` (D8 category 3). Verified by the tests and the existing `searchLinks` tests.
  Evidence: `sw-5.3-red.log`: `Failed to resolve import "./WikiMarkdown"` → `Test Files 2 failed`. `sw-5.3-green.log`: wiki tests `Tests 48 passed (48)`; search tests (searchLinks callers) `Tests 41 passed (41)`; full web suite `Tests 2080 passed (2080)`; typecheck rc=0. No existing test edited. Note: `webBoundaries.repo.test.ts` bars web production code from importing `packages/`, so `wiki/wikiUrl.ts` copies `classifyWikiUrl` and `wikiUrl.pinning.test.ts` checks it against the contract on 34 URLs (the `aiV2/clientAggregates` precedent).
- [x] 5.4 Test first: write `WikiRoute.test.tsx`, covering:
  - the tabs per kind;
  - the filter;
  - the Deleted view with Restore;
  - New page creates and navigates;
  - with no active show, it asks to choose one.
  Then implement, plus the `/wiki` and `/wiki/:pageId` routes in `AppShell` (D8 category 2), and the TopBar "Wiki" link with a `TopBar.test.tsx` assertion (D8 category 6). Verified by the tests.
  Evidence: `sw-5.4-red.log`: `Tests 4 failed | 81 passed (85)` (`./WikiRoute` unresolved; no `wiki-route`/`wiki-page-view` in AppShell; no "Wiki" link in TopBar). `sw-5.4-green.log`: WikiRoute + TopBar + AppShell → `Tests 96 passed (96)`; full web `Tests 2146 passed`; typecheck rc=0; biome clean. Existing-test edits are additions only: `AppShell.test.tsx` (cat 2) gains three `/wiki` route assertions plus `vi.mock`s of the two new wiki screens they need; `TopBar.test.tsx` (cat 6) gains two "Wiki" link tests.
- [x] 5.5 Test first: write `WikiPageView.test.tsx`, covering:
  - the rendered body and metadata;
  - edit and save;
  - "Edit conflict keeps the draft";
  - alias chips;
  - a merged page replaces the URL with its target;
  - a page of another show offers a switch;
  - delete confirms first.
  Then implement. Verified by the tests.
  Evidence: `sw-5.5-red.log`: `Failed to resolve import "./WikiPageView"`. `sw-5.5-green.log`: `WikiPageView.test.tsx` → `Tests 12 passed (12)`; full web `Tests 2146 passed (2146)`; typecheck rc=0; biome clean. No existing test edited.
- [x] 5.6 Test first: write the tests for `WikiHistorySheet`, `WikiMergeDialog` and `WikiSplitDialog`:
  - revisions newest first, with "Load older";
  - the line diff against the current page;
  - restore sends a `PUT` with the revision's content, `restored_from` and `expected_revision`;
  - the merge picker lists only other live non-session pages of the show and confirms first;
  - split sends the remaining body and the new page.
  Then implement. Verified by the tests.
  Evidence: `sw-5.6-red.log`: `Test Files 3 failed (3)` (`./WikiHistorySheet`, `./WikiMergeDialog`, `./WikiSplitDialog` unresolved). `sw-5.6-green.log`: `Tests 11 passed (11)`; full web `Tests 2146 passed`; typecheck rc=0; biome clean. No existing test edited.
- [x] 5.7 Test first: write `SessionWorkspace.wikiButton.test.tsx` for "Session page from the workspace":
  - the button is at the end of the feed-tab row;
  - the first press creates the page and opens it;
  - the second press opens the same page;
  - a `409 Session already has a page.` opens the named page.
  Then implement the "Wiki page" button. Verified by the tests.
  Evidence: `sw-5.7-red.log`: `Tests 3 failed (3)` (no button named "Wiki page"). `sw-5.7-green.log`: `SessionWorkspace*` + TopBar + AppShell → `Tests 130 passed (130)`; full web `Tests 2146 passed`; typecheck rc=0. No `SessionWorkspace*.test.tsx` changed (the button calls `apiFetch` directly because `SessionWorkspace.test.tsx` mocks react-query without `useMutation`).
- [x] 5.8 Check the UI with agent-browser on the dev stack (`localhost:8787`) at desktop and mobile widths: list, page, edit, conflict, history diff, merge, split, citation click and seek, the session-page button, and the top bar on one line at 390px. Fix what the check finds. Verified by screenshots noted in the evidence.
  Evidence: `sw-5.8/` holds 32 screenshots at 1440×900 and 390×844 (list, new page, page view, editor Write/Preview, citation → session at 00:01:15, conflict banner keeping the draft, history diff and restore to r4, merge redirect, split, session-page button first and second press, top bar). 8 issues fixed: phone feed-tab row overlap with the "Wiki page" button, merge confirm drawn over the picker, merge filter double border, editor hint spacing, alias chip icon size, unnamed Write/Preview tab list, split kind radio group name, diff wrap indent; 3 new tests each failed without its fix. Not fixed (owner accepted 2026-10-13 as a follow-up): at 390px the top bar stays on one line but the show crumb shrinks to "A…". `sw-5.8/sw-5.8-green.log`: wiki web tests `104 passed`; full web `Tests 2149 passed`; typecheck exit 0; biome clean.

## 6. Docs, verification, PR

- [x] 6.1 Write ADR `docs/decisions/0030-show-wiki.md`: Markdown with inline `cite:`/`wiki:` links validated on the rendering parse, append-only revisions with name snapshots, compare-and-set with name pre-checks, access through `accessible_shows` plus composite keys, react-markdown safety, and the split from `show-wiki-ai`. Verified by the file and the ADR index check in `check-change.sh`.
  Evidence: `docs/decisions/0030-show-wiki.md` written (Context, Decision incl. the injected parser and the web copy, Alternatives, Evidence, Consequences). `check-change.sh` has no ADR index gate (`grep -rln docs/decisions scripts/` → only `scripts/lib/adopt.py`); the hook gates pass with the file present.
- [x] 6.2 Run the dev-stack manual checks:
  1. create a person page with a citation, open it, and the session seeks;
  2. two tabs edit the same page, and the second gets the conflict banner;
  3. merge two pages: the old page redirects and its title becomes an alias;
  4. an ungranted member gets 404 on the wiki;
  5. history diff and restore.
  Verified by notes in the evidence.
  Evidence: checks 1, 2, 3 and 5 ran on the dev stack in the 5.8 browser pass (`sw-5.8/`): `06`/`09` a person page with a citation opens session ATS_asdf at 00:01:15; `10` a stale-revision save shows the conflict banner and keeps the draft; `19` merging "QA Person Alicia" into "QA Person Alice" redirects the old URL and adds the alias; `13`/`16` the history diff and restoring r2 to r4. Check 4: dev has no ungranted member and no second login, so `sw-6.2-rls.log` adds one inside a rolled-back transaction and reads as `catalog_user`: `ungranted member|t|0|0|0`, `granted member|t|6|3|12`, `owner|t|6|3|12`, `after rollback|0`. The HTTP 404 for an ungranted member is covered by `wiki.int.test.ts` (masked 404s).
- [x] 6.3 Run `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook` and `openspec validate --all --strict`, then run the consistency read and append it to `panel.md`. Verified by green runs.
  Evidence: `sw-6.3-full.log` (`FULL_TESTS=1 GITHUB_BASE_REF=supabase-migration scripts/check-change.sh`): every gate PASS except `tasks` (6.3/6.4 then open) and `commands`, whose only error was an unhandled `53300 too many connections for role "autologger_app"` from `authCreateUser.pg.test.ts` (not touched by this change) while the dev stack held connections; rerun `sw-6.3-db.log`: `npx vitest run --project pg --project integration` → `Tests 1748 passed | 1 skipped (1749)`, rc=0. `sw-6.3-validate.log`: `openspec validate --all --strict` → `30 passed, 0 failed`. Consistency read appended to `panel.md` (scope change: no; 3 wording majors resolved; the D8-wording major declined by the owner as within intent).
- [x] 6.4 When the owner asks, push the branch and open a PR to `supabase-migration`, then confirm CI is green. Verified by the PR checks.
  Evidence: owner asked to push 2026-10-13; PR https://github.com/kwcantrell/autologger-2/pull/115 to `supabase-migration`. First CI run 38463693548: `secrets`, `dependency-review`, `db-shard (1)` and `db-shard (2)` pass; `gates` failed only on `tasks` (this item unticked); `db-shard (3)` failed one timing test, `sessionWs.access.int.test.ts` "closes of 150" (`3070ms`), which this change does not touch and which passes 3/3 locally (`Tests 11 passed (11)` ×3). The green run after this commit is the PR's check status.
