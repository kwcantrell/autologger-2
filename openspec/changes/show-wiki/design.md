# Design: show-wiki

## Context

See proposal.md (Why). The current state that shapes the approach:

- **Show access.** "Show access" is `catalog.accessible_shows(uid)`: owners and admins of the show's team, and members who hold a `show_grants` row (`20261007000000_catalog_policies.sql:40-48`). Its TypeScript twin is `authCanAccessShow` (`packages/catalog/src/authStore.ts`).
  - Routers gate with `requireShowAccess` and `requireSession` (`server/src/routers/_helpers.ts:86,106`), which return the same 404 for a missing row and for no access.
- **Default privileges.** `catalog_user` and `catalog_system` get `arwd` on every new catalog table by default, so a table must revoke whatever a role should not hold.
  - Content tables follow a `<t>_user_all` / `<t>_system_all` policy pair (`20261009000000_session_content_policies.sql`).
  - `session_overwrites` is the model for an append-only table: an insert-only user policy, then `revoke update, delete` (`20261010000000_session_row_versions.sql:28-59`).
- **Transactions.** `catalog.tx(fn)` runs at SERIALIZABLE and may run its body more than once, so the body must touch only the catalog.
  - No catalog code yet maps a unique violation (`23505`) to a domain error; this change adds the first one.
- **Sessions and shows.** No code changes a session's `show_id` after creation, and no code deletes a show or a session.
- **Existing patterns to reuse:**
  - **Optimistic concurrency:** `versionConflict()` returns `409 {detail:'Version conflict.', current}` (`_helpers.ts:224`); the web side has `api/versionConflict.ts`.
  - **Deep links:** `/sessions/:id?t=<sec>` takes decimal seconds (`MomentDeepLink.tsx:46`).
- **Web constraints:**
  - `dangerouslySetInnerHTML` is banned across the repo (`web/src/noAgentAuthoredMarkup.repo.test.ts`);
  - there is no Markdown or diff library;
  - routes are `useRoute` booleans in `AppShell.tsx`;
  - the shell route list is `loginReturnPath.ts`, where `isShellSegments` accepts only one-segment `teams`/`search` and two-segment `sessions/<id>`;
  - query-key literals are owned by their factory modules (`queryKeyFactories.repo.test.ts`);
  - every `apiFetch<T>` needs a captured fixture (`apiResponseShapes.repo.test.ts`).

## Goals / Non-Goals

**Goals:**
- One place decides wiki access, the same `accessible_shows` that guards transcripts. It is enforced by RLS and checked again in the routes.
- History is never rewritten, and two people editing at once can't silently overwrite each other.
- The data model `show-wiki-ai` needs is in place: suggestions will record a base revision, and accepting one is an ordinary compare-and-set edit.

**Non-Goals:**
- A WYSIWYG editor. Editing is a Markdown textarea with a preview.
- Search ranking inside the wiki. The list filter is a substring match on titles and aliases.
- Undoing a merge. Restoring a revision of the merged page can bring its text back, but the redirect stays.

## Decisions

### D1. Three tables, keyed by show
The schema is listed in the catalog-database delta.

- **`show_id` is stored on the page and alias rows**, not reached through a join, so:
  - every policy is a single `show_id in (select catalog.accessible_shows(catalog.app_user_id()))`;
  - uniqueness can be a plain per-show unique index.
- **Composite foreign keys keep everything in one show.** RLS alone would let a user who can access shows A and B write an alias of an A page under B (panel; the probe gave `INSERT 0 1`, `MISMATCH|t`). These keys prevent that:
  - `wiki_pages` has `unique (id, show_id)`;
  - `wiki_aliases (page_id, show_id)` and `wiki_pages (merged_into, show_id)` reference it;
  - `wiki_pages (session_id, show_id)` references a new `unique (id, show_id)` on `catalog.sessions`.

  This replaces the first draft's `security definer` trigger: no new function, and the same guarantee. `sessions.show_id` is nullable, but a session with no show matches no page's `(id, show_id)`, so it can't get a session page.
- **Live pages only.** The partial unique indexes use `catalog.search_norm` (immutable, `i`) and apply only where `merged_into is null and deleted_at_utc is null`.
  - This frees the names of merged and deleted pages.
  - Probe A6: an accent- and case-insensitive clash is refused, while a non-live duplicate and a duplicate in another show are allowed.
- **Aliases** exist as rows only for live non-session pages, and merge, delete and restore add or remove them in the same transaction. A page that isn't live reports the aliases from its newest revision's `aliases_json`, and restore rebuilds its rows from there.
- **Names are snapshotted** when written: `created_by_name` and `updated_by_name` on pages, `author_name` on revisions, built from the writer's own `users` row (given and family name, never email). RLS on `users` hides people who have left the team (`users_user_select` allows only self and `co_members`), so a join at read time would lose their names (panel).
- **IDs** come from `crypto.randomUUID()`, generated before `catalog.tx`, so a retried transaction reuses them. Times are ISO text, as elsewhere in the catalog.

*Alternatives:*
- **One table with JSON aliases.** Uniqueness by alias would then need a trigger. Rejected.
- **A slug in the URL.** Renames would break links. Page links use ids; titles are only for display.

### D2. Revisions are an append-only snapshot table
- **Every write stores a full snapshot** (title, kind, body and aliases JSON) rather than a delta. A body is at most 100,000 characters, and the history view diffs on the client.
- **`catalog_user` privileges on revisions:**
  - select through the page's show;
  - insert with `author_user_id = app_user_id()`;
  - `revoke update, delete`, so those statements raise `42501`, as on `session_overwrites`.
- **`wiki_pages.revision`** equals the newest revision number. The store bumps it and inserts the revision in one transaction.
- **An edit that changes nothing** writes nothing: after normalising, the store compares title, kind, body and aliases with the current row.
- **Growth.** History is read in pages (`limit` up to 100, `before` cursor). Writes are bounded by the human editing rate. Retention is a later change, if storage ever shows up in monitoring.

*Alternative:* triggers that write revisions. They would hide the author and note in session settings, so explicit store writes are used instead.

### D3. Compare-and-set, with names pre-checked
- **Every page write** runs `update wiki_pages set …, revision = revision + 1 where id = ? and revision = ?`. If no row is updated, a follow-up read decides the answer:
  - stale: `409` with the current page;
  - merged or deleted: `409` with its own detail;
  - not visible: `404`.

  The follow-up read runs before any failing statement, so the transaction is still usable.
- **Merge** updates both rows, each guarded by its own expected revision.
- **Split** guards the source page and inserts the new one.
- **Names are checked before anything is written.** A unique violation aborts the transaction (`catalogDb.ts:7-10`: any error inside it fails the whole transaction), so the holder can't be looked up after a `23505` (panel).
  1. Aliases are trimmed, deduplicated on `search_norm`, and any alias equal to the page's own title is dropped.
  2. One `SELECT` finds a live page (other than this one) whose title or alias matches any of the request's names, and one more finds a live session page for the session. A hit raises `WikiTitleTakenError` or `WikiSessionTakenError` with that page's id.
  3. Only then do the writes run.
- **Concurrency.** Under SERIALIZABLE, a concurrent insert of a clashing name makes one transaction fail with `40001`, and the port retries it; the retry's pre-check then finds the holder. The assumption tester checked this with two concurrent transactions: `40001 … pivot` on one, and one row left. If a `23505` still escapes (a race the serializable check didn't catch), the store re-runs the whole `tx` once, and the pre-check then names the holder. A second `23505` is a 500.
- **Checks before the write:**
  - a `kind` change to or from `session` gives `WikiInvalidError` (422) before any write, so the DB check (`23514`) is never what fires;
  - a merge computes the merged body length and the deduplicated alias count first, and gives a 422 if either exceeds its limit.
- **Errors** are new classes in `wikiStore.ts`: `WikiConflictError`, `WikiMergedError`, `WikiDeletedError`, `WikiNotDeletedError`, `WikiTitleTakenError`, `WikiSessionTakenError` and `WikiInvalidError`. The router turns them into `ApiError` responses, following `search.ts`.

### D4. Citations and links: checked on the same parse that renders
- **No citation table.** A citation is the session id, the time and the quote, as the grill decided, and a Markdown link already holds all three: `[quote](cite:<session>@<sec>)`. So there is no citation table, and nothing to rebuild when chunks change.
- **The parser** is `packages/contract/src/wikiLinks.ts`, used by the server. The web can't import `packages/` (`webBoundaries.repo.test.ts`), so it renders with react-markdown and classifies URLs with `web/src/pages/index/components/wiki/wikiUrl.ts`, a copy of the contract's `classifyWikiUrl` that `wikiUrl.pinning.test.ts` checks against the contract (wording corrected 2026-10-13, after approval, to match task 5.3).
  - It parses the body with `mdast-util-from-markdown` 2.0.2, the CommonMark parser react-markdown uses through `remark-parse` 11, with no extensions. So the links it validates are exactly the links the page renders (panel: three reviewers showed a regex missed reference definitions, autolinks, angle-bracket destinations, titles, escapes, entities and upper-case schemes).
  - It walks the `link` and `definition` nodes (autolinks become `link` nodes) and returns each one's decoded URL, scheme, target, label (the link text, which `show-wiki-ai` will use as the quote) and position.
  - Code is skipped by construction, since code nodes contain no links.
  - **The store gets the parser by injection** (added 2026-10-13, after approval; owner decision after the re-panel). `package-architecture` lets catalog depend only on `domain` and `ports`, so `packages/catalog` does not import `packages/contract`. `Catalog` and `createCatalog` take an optional `wikiLinks` option, a function with `parseWikiLinks`' signature whose result type the store declares locally. Bound and derived catalogs carry it on. The server passes `parseWikiLinks` where it creates the catalog (`server/src/middleware/auth.ts`) and in its test helpers. A catalog built without the option refuses every wiki write that sets a body with an error (a 500), so validation can never be skipped silently.
  - **The grammar**, where a scheme is recognised case-insensitively, but only the lower-case form is valid:
    - `cite:` + session id `[A-Za-z0-9_-]{1,64}` + `@` + seconds `\d+(\.\d{1,3})?`;
    - `wiki:` + page id `[A-Za-z0-9_-]{1,64}`.
  - An invalid `cite:` or `wiki:` URL is a 422.
- **On every write that sets a body** (create, edit, restore, merge's assembled body, split's two bodies), the store:
  - checks the distinct session ids with one `select id from sessions where show_id = ? and id = any(?)`;
  - checks the page ids the same way against `wiki_pages`;
  - refuses more than 500 links.
- **Hidden sessions** are allowed on purpose. Hiding a session shouldn't make pages that cite it unsaveable, and the wiki is human memory, which people delete by hand. No existence oracle arises, because the caller can already access every session of the show.
- **Titles and aliases are single-line text.** Control characters are refused by the schema. Merge escapes A's title with a Markdown backslash before each ASCII punctuation character before it builds the `## Merged from` heading, so a title can never become links or structure. That also matters because `show-wiki-ai` will feed pages to an LLM.
- **No quote check here.** People type citations by hand, so a quote may be a paraphrase. Checking quotes against the transcript is `show-wiki-ai`'s job, and only for AI suggestions.

### D5. Safe rendering with react-markdown
- **`react-markdown` 10.1.0** (peer `react >=18`; A9) renders to React elements, so the `dangerouslySetInnerHTML` ban holds.
  - `skipHtml` drops raw HTML. One known effect: a paragraph that begins an HTML block renders as nothing. That is acceptable for hostile input.
  - The `urlTransform` returns the URL unchanged for `https:` and for URLs that `parseWikiLinks`' grammar accepts (through the web's pinned `classifyWikiUrl`, D4), and `''` for anything else.
  - A custom `a` renderer:
    - renders a link with an empty `href` as plain text;
    - renders a valid `cite:` link as `<a href="/sessions/<id>?t=<sec>">`;
    - renders a valid `wiki:` link as an in-app link.

    The assumption tester checked in a scratch render that custom schemes do reach `urlTransform`, and that `''` turns into text.
  - Images render as their alt text.
  - No remark or rehype plugins are added.
- **`diff` 8.0.2** (`diffLines`, browser ESM, published 2025-05-22) is used only on the client, for the history view.
- **Alternatives:** an in-house Markdown subset means more code to secure; plain text was rejected because the owner chose Markdown.

### D6. API shape
The routes, bodies and statuses are in the api-contract-freeze delta.
- **List and create are show-scoped** (`/api/shows/:showId/wiki/pages`), so the show gate is `requireShowAccess`.
  - There is no `q` parameter (panel: cut). The list already carries every title and alias, up to 2000, and the web filters on the client.
- **Everything else is page-scoped** (`/api/wiki/pages/:pageId`), so a URL can carry just the page id.
  - The router loads the page as the user. Under RLS, a page in a show the user can't access reads as missing, which gives `404 Page not found.`.
- **Restoring a revision** is a `PUT` with that revision's content and `restored_from: n`, which writes the note "restored rN". There is no separate restore-revision endpoint (panel: cut).
- **Schemas** are new zod schemas in `packages/contract/src/schemas.ts`, with `z.strictObject` for responses. Title and alias strings refuse `[\u0000-\u001f\u007f]`.
- **The router**, `server/src/routers/wiki.ts`, is mounted in `app.ts`.
- **README** gets one endpoint row per route.

### D7. Web
- **Routes:**
  - `loginReturnPath.ts` gains `WIKI_ROUTE_PATHNAME`, `isWikiRoutePathname` (`/wiki` and `/wiki/<one segment>`), and both entries in `isRouterKnownPathname` and `isShellSegments`;
  - `AppShell` gains `useRoute('/wiki')` and `useRoute('/wiki/:pageId')`, and renders the wiki view in the same switch as `SearchRoute`.
- **Components** go in `pages/index/components/wiki/`:
  - `WikiRoute` (the list);
  - `WikiPageView`;
  - `WikiEditor` (shadcn `tabs` and `textarea`);
  - `WikiMarkdown`;
  - `WikiHistorySheet` (shadcn `sheet`, with "Load older" from `next_before`);
  - `WikiMergeDialog` (shadcn `command`);
  - `WikiSplitDialog`;
  - `NewWikiPageDialog`.

  Confirmations use the existing `useConfirm`.
- **Hooks** live in `api/hooks/useWiki.ts`, with a `wikiKeys` factory:
  - `all: ['wikiPages']`, `list(showId, filters)`, `page(id)`, `revisions(id)` (infinite), `revision(id, n)`. The root is `'wikiPages'`, not `'wiki'` (changed 2026-10-13, after approval): the registry guard in `queryKeyFactories.repo.test.ts` treats every quoted root literal as a key, and `'wiki'` is already a route segment and a link kind;
  - it is registered in `queryKeyFactories.repo.test.ts`;
  - `useSwitchActive` adds `wikiKeys.all()` to its invalidation list.
- **Moment links.** `searchLinks.ts` gains `secondsHref(sessionId, sec)`. `momentHref` calls it for transcript moments, and so does `WikiMarkdown`.
- **Session workspace.** A small "Wiki page" button sits at the end of the feed-tab row (`SessionWorkspace.tsx`, the `flex … items-end` row that holds `TabsList`). There is no workspace header today, and the session-meta strip belongs to session-title-suffix, so it doesn't go there.
  - It lists `?kind=session&session_id=<id>` and opens the hit.
  - Otherwise it creates the page, titled after the session.
  - A `409 Session already has a page.` opens the `page_id` it names.
- **Top bar.** A "Wiki" icon link sits next to the search button. It is icon-only below `md`, so the bar keeps to one line at 390px (web-ui-system "Phone width keeps one line").

### D8. Changing existing tests
An existing test may change only in these categories. Anything else is a stop.
1. **Schema inventories gain the wiki objects.** That means `catalogSchema.pg.test.ts` (tables, columns, per-table policy names, and the new `sessions (id, show_id)` unique constraint), `catalogPolicies.pg.test.ts` (the policy count, 38 today), `catalogPolicyHelpers.pg.test.ts`, `catalogRoles.pg.test.ts`, and `server/src/test/session/isolation.int.test.ts`. Existing entries are otherwise unchanged.
2. **Route inventories gain `/wiki`.** In `loginReturnPath.test.ts`, `loginReturnStash.test.ts`, `AppShell.test.tsx` and `staticServing.int.test.ts`, the only changes allowed are a route count, or an assertion that `/wiki…` is or isn't a route.
3. **`searchLinks` refactor.** `searchLinks` tests may change only their imports. What `momentHref` returns stays the same.
4. **`useSwitchActive`.** Its tests may gain an expectation for the wiki invalidation, and nothing else may change. `TopBar.test.tsx` pins the switch's invalidation count: its two `toHaveBeenCalledTimes(4)` become `5`, and its test title's "four query keys" becomes "five". Nothing else in it changes under this category (added 2026-10-13, after approval; task 1.1's classification missed it).
5. **Registry and fixture inventories gain wiki entries.** These are `server/src/routers/apiResponseFixtures.int.test.ts` (new captures), `web/src/api/types.conformance.test.ts` (new conformance checks), and `web/src/queryKeyFactories.repo.test.ts` (registering `wikiKeys`). Existing entries are unchanged, as catalog-search did (`31e68f9e`).
6. **Shell controls gain the wiki entry points.** `TopBar.test.tsx` and the `SessionWorkspace*.test.tsx` files may gain assertions or mocks for the "Wiki" link and the "Wiki page" button. Their existing assertions are unchanged.
7. **The catalog facade inventory gains the wiki store** (added 2026-10-13, after approval, when task 3.2 hit it): `packages/catalog/src/catalog.test.ts` ("carries no flat delegate methods") gains `'wiki'` in its pinned store list. Nothing else in that file changes.

## Risks / Trade-offs

- [A bug in a policy leaks one show's wiki to another team] → The pg access matrix covers all three tables and all four roles (owner, granted, ungranted, outsider), the composite keys stop cross-show rows, and the routes also gate on `requireShowAccess`.
- [The SERIALIZABLE retry re-runs the store body] → The body is SQL only, and ids are generated before `tx`, so a retry reuses them.
- [Names raced between the pre-check and the insert] → SERIALIZABLE gives `40001` and a retry. A stray `23505` gets one re-run of the whole transaction. A pg test runs two concurrent creates whose title and alias clash: exactly one succeeds, and the other gets 409 with `page_id`.
- [Revisions grow without bound (100k × n)] → History is paged, and no-op saves add nothing. Retention is deferred.
- [Pasted Markdown is untrusted input, and `show-wiki-ai` will later feed pages to an LLM] → `skipHtml`, the scheme allowlist on the same parse as validation, no plugins, single-line titles and an escaped merge heading. A test renders a hostile body. `show-wiki-ai` must still treat page text as data.
- [A citation points at a time that later transcript edits move] → Citations carry seconds and the quote, not chunk ids, so they still open the session close to the right moment. `show-wiki-ai` re-checks quotes.
- [Merge loses the merged page's identity] → A keeps its body and full history and becomes a redirect, and B's history records "merged from A". Merge chains work, because a merge requires a live target, so a redirect is never more than one hop.

## Migration Plan

1. `20261021000000_show_wiki.sql` adds `unique (id, show_id)` to `catalog.sessions`, then creates the three tables, keys, indexes, policies and revokes. It has no backfill, because the tables start empty.
2. Rollback: drop the three tables and the `sessions (id, show_id)` constraint.
3. The pg suite applies the migration to the template database, and `docker/supabase/test_migrate.sh` checks that it applies cleanly.

## Assumptions

Each was tested on 2026-10-13 against the dev DB (`docker exec -i autologger-dev-db-1 psql -U postgres -At`) or the repo. DB probes ran in a transaction that was rolled back.

| # | Assumption | Command | Observed |
| --- | --- | --- | --- |
| A1 | The dev DB is PG 17 | `-c "select version()"` | `PostgreSQL 17.6 on aarch64-unknown-linux` |
| A2 | `catalog.search_norm` exists and is immutable, so it can back an index | `-c "select proname, provolatile from pg_proc where proname='search_norm'"` | `search_norm\|i` |
| A3 | `accessible_shows` and `member_shows` are `security definer`; `app_user_id` is not | `select proname, prosecdef … in ('accessible_shows','member_shows','search_norm','app_user_id')` | `accessible_shows\|t`, `member_shows\|t`, `app_user_id\|f`, `search_norm\|f` |
| A4 | No code changes a session's `show_id` or deletes a show (so the composite FK never blocks a real write) | `grep -rn "show_id = ?\|SET show_id" packages/*/src server/src --include=*.ts \| grep -v test \| grep -i update`; `grep -rn "DELETE FROM shows\|DELETE FROM catalog.shows" packages server/src` | no matches for either |
| A5 | New catalog tables get `arwd` for both roles by default, so revokes are needed | `-c "select defaclrole::regrole, defaclacl from pg_default_acl"` | `postgres\|{catalog_user=arwd/postgres,catalog_system=arwd/postgres}` |
| A6 | A partial unique index on `(show_id, search_norm(title))` refuses an accent- and case-insensitive clash among live rows only | temp table, `create unique index … (show_id, catalog.search_norm(title)) where live`; insert `Café Noir`, then `cafe noir` live, not live, and in another show | `ERROR: duplicate key … (s, cafe noir) already exists`; non-live and other-show inserts succeed; count `3` |
| A7 | Catalog transactions are SERIALIZABLE and retry on `40001`/`40P01` | `grep -n "SERIALIZABLE\|40001" packages/storage/src/postgresCatalogStore.ts` | `:168 'BEGIN ISOLATION LEVEL SERIALIZABLE'`, `:161 new Set(['40001', '40P01'])` |
| A8 | `users` has name columns other than email | `select column_name … table_name='users'` | `id google_sub email given_name family_name picture_url created_at_utc disabled_at_utc` |
| A9 | react-markdown 10.1.0 supports React 19 | `npm view react-markdown version peerDependencies`; `grep '"react"' web/package.json` | `10.1.0`, `{ react: '>=18' }`; web uses `"react": "^19.0.0"` |
| A10 | `diff` 8.0.2 is older than two weeks | `npm view diff time --json \| grep 8.0.2` | `"8.0.2": "2025-05-22T13:42:28.816Z"` |
| A11 | The repo bans `dangerouslySetInnerHTML` | `grep -n dangerouslySetInnerHTML web/src/noAgentAuthoredMarkup.repo.test.ts` | the pattern at `:20-21` |
| A12 | Shell segments accept only `teams`, `search` and `sessions/<id>` today | `grep -n "segments.length" web/src/shared/utils/loginReturnPath.ts` | `:101 … 'teams' \|\| … 'search'`, `:102 … 'sessions'` |
| A13 | `?t=` accepts decimal seconds | `grep -n "SECONDS_RE =" web/src/pages/index/components/MomentDeepLink.tsx` | `/^(\d+(\.\d+)?\|\.\d+)$/` |
| A14 | Show ids are random UUIDs | `grep -n randomUUID packages/catalog/src/showsStore.ts` | `:202 const sid = crypto.randomUUID();` |
| A15 | The policy count pinned in `catalogPolicies.pg.test.ts` is 38 today | `grep -n "toHaveLength(38)" server/src/test/pg/catalogPolicies.pg.test.ts` | `:603 expect(rows).toHaveLength(38);` |
| A16 | No catalog code maps `23505` yet | `grep -rn 23505 packages/*/src server/src --include=*.ts \| grep -v test` | only a comment in `authStore.ts:146` |
| A17 | A partial unique pre-check under SERIALIZABLE stops a concurrent title/alias clash (panel: assumption tester) | throwaway PG 17.6 container: T1 checks aliases, T2 checks titles, both insert | T2 commits; T1 `40001 … Canceled on identification as a pivot`; one row left |
| A18 | `show_id in (select accessible_shows(...))` works as WITH CHECK for insert and update (panel) | rolled-back probe as `catalog_user` | accessible insert `INSERT 0 1`; inaccessible -> `new row violates row-level security policy` |
| A19 | RLS alone lets an alias carry another accessible show's `show_id` (panel) | rolled-back probe: `insert into wiki_aliases select 'P1', <other show>, 'cross'` | `INSERT 0 1`, `MISMATCH\|t`, hence the composite FKs (D1) |
| A20 | `users` RLS hides users who are not co-members (panel) | `grep -n users_user_select supabase/migrations/20261007000000_catalog_policies.sql` | `using (id = … app_user_id() or id in (select catalog.co_members(…)))`, hence name snapshots (D1) |
| A21 | react-markdown passes custom schemes to `urlTransform`, `''` renders as text, and a regex misses CommonMark link forms (panel) | scratch render with react-markdown@10.1.0, `skipHtml` and an allowlist transform | `seen: href=cite:S1@754 \| href=wiki:abc \| href=javascript:alert(1)`; reference, autolink, angle, escape, entity and upper-case forms all rendered as links, hence D4's mdast parse |
| A22 | `mdast-util-from-markdown` is what react-markdown parses with, and 2.0.2 is old enough | `npm view remark-parse@11.0.0 dependencies --json \| grep mdast-util-from`; `npm view mdast-util-from-markdown time --json \| grep 2.0.2` | `"mdast-util-from-markdown": "^2.0.0"`; `"2.0.2": "2024-10-25…"` |
| A23 | `diff@8.0.2` ships browser ESM and `diffLines` works (panel) | `node_modules/diff/package.json` exports; a `diffLines` call | `import → ./libesm/index.js`; `[[f,f,"a\n"],[f,t,"b\n"],[t,f,"c\n"]]` |
| A24 | Any error inside `catalog.tx` fails the whole transaction (panel) | `sed -n 7,10p packages/ports/src/catalogDb.ts` | "Any error inside the transaction, even one the body catches, fails the whole transaction" |
