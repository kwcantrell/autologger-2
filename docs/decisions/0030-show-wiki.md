# 0030: The show wiki is Markdown with checked inline citations, append-only revisions and show access

- Date: 2026-10-13
- Status: Accepted
- Rule: show-wiki (pages, access, revisions, compare-and-set, names, merge and split, citations, safe rendering, screens), catalog-database ("Wiki tables", "Wiki row-level security"), api-contract-freeze (the wiki endpoints and the "Wiki page HTML routes"), and the tests `server/src/test/pg/showWiki.pg.test.ts`, `server/src/test/pg/wikiStore.pg.test.ts`, `server/src/routers/wiki.int.test.ts` and `web/src/pages/index/components/wiki/WikiMarkdown.test.tsx`

## Context

The owner wants each show to have a knowledge wiki, "show memory for producers": people, topics, running bits and one index page per session. Search (ADR 0029) finds moments, but there was nowhere to keep what a producer learns from them. AI drafting comes next (`show-wiki-ai`) and will write into the same pages through suggestions a person reviews, so the data model and the editing UI come first.

Four facts shaped the design:

- **Access.** Wiki pages are drawn from transcripts, so they must follow transcript access exactly: `catalog.accessible_shows`. RLS alone would still let a user who can access two shows attach a row of one show to a page of the other (design A19).
- **Concurrency.** Two producers can edit the same page. Catalog transactions are SERIALIZABLE and retried on `40001`, and any error inside one fails it (A24), so a unique violation can't be caught and explained after the fact.
- **Untrusted text.** A body is pasted Markdown, and `show-wiki-ai` will later feed pages to an LLM. The repo bans `dangerouslySetInnerHTML`. A regex check of links missed every CommonMark form other than the plain inline link (panel).
- **Leavers.** RLS on `users` hides people who have left the team, so a name looked up at read time would go blank.

## Decision

- **Markdown with inline citations and page links.**
  - A citation is `[quote](cite:<session_id>@<seconds>)`, and a page link is `[label](wiki:<page_id>)`. A citation already holds the session, the time and the quote, so there is no citation table.
  - On every write that sets a body, the server parses it with `mdast-util-from-markdown` 2.0.2, the parser react-markdown renders with, and checks every link and definition whose scheme is `cite:` or `wiki:` in any case.
    - Only the lower-case grammar is valid.
    - Cited sessions and linked pages must belong to the page's show.
    - A body may hold at most 500 such links.
  - Hidden sessions may be cited, so hiding one never makes a page unsaveable.
- **The parser lives in `packages/contract` and is injected into the catalog** (re-panel). `package-architecture` lets catalog depend only on `domain` and `ports`, so the server passes `parseWikiLinks` when it creates the catalog. A catalog built without it refuses any wiki write that sets a body. The web can't import `packages/`, so `wiki/wikiUrl.ts` copies the URL grammar, and a pinning test checks the copy against the contract.
- **Three tables, every row keyed by show.**
  - The tables are `wiki_pages`, `wiki_aliases` and `wiki_revisions`.
  - RLS is `show_id in (select catalog.accessible_shows(catalog.app_user_id()))`.
  - Composite foreign keys hold every row to one show: aliases and merge redirects reference `wiki_pages (id, show_id)`, and session pages reference a new `catalog.sessions unique (id, show_id)`.
  - Partial unique indexes on `catalog.search_norm` cover live pages only, so titles and aliases are unique per show ignoring case and accents, and merged or deleted pages free their names.
- **Revisions are append-only snapshots.**
  - Each write appends the full title, kind, body and aliases. `catalog_user` can insert only revisions it authors, and has no update or delete privilege, so those fail with `42501`.
  - Author names are snapshotted at write time and are never an email.
  - Restoring a revision is an ordinary edit noted `restored r<n>`.
  - A no-op save appends nothing.
- **Compare-and-set with pre-checked names.**
  - Every write to a page carries `expected_revision`, and a stale write gets `409 Version conflict.` with the current page.
  - Title, alias and session clashes are found by a SELECT before any write. A clash a concurrent writer causes surfaces as `40001` and a retry. A stray `23505` re-runs the whole transaction once.
  - Merge and split are single transactions guarded on every page they touch. Merge escapes the merged page's title before building its `## Merged from` heading, and refuses a result over 100,000 characters or 50 aliases.
- **Safe rendering.**
  - react-markdown 10.1.0 runs with `skipHtml`, no plugins, and a `urlTransform` that keeps only `https:` and grammar-valid `cite:`/`wiki:` URLs.
  - Anything else renders as text, and images render as their alt text.
  - Titles and aliases are single-line plain text.
- **Two changes.** This change is the hand-edited wiki. `show-wiki-ai` adds the AI turn, suggestions with a base revision, a quote check against the transcript, and an inbox. Accepting a suggestion will be an ordinary compare-and-set edit.

*Alternatives considered.*
- **A citation table.** It duplicates what the link holds and has to be rebuilt when chunks change. Rejected by the grill.
- **A regex link check.** Three reviewers showed it missed reference definitions, autolinks, angle-bracket destinations, escapes, entities and upper-case schemes.
- **A `security definer` trigger** to keep session pages in their show. The composite foreign keys give the same guarantee with no new function.
- **A `catalog → contract` package edge.** It would have changed the durable package-architecture spec for one function. The owner chose injection.
- **WYSIWYG or an in-house Markdown subset.** More code to secure. The owner chose Markdown via react-markdown.
- **Real-time collaborative editing.** Compare-and-set and the conflict banner cover two editors.

## Evidence

- The panel and both re-panels are in `openspec/changes/show-wiki/panel.md`, and the measured assumptions A1–A24 are in that change's `design.md`.
- **Access matrix:** owner, granted member, ungranted member and outsider, for select, insert, update and delete on all three tables. Cross-show rows are refused by the foreign keys even for a user with access to both shows (`showWiki.pg.test.ts`, 25 tests).
- **Store behaviour:** compare-and-set, name clashes, merge, split, restore, link checks through reference definitions and autolinks, and the fail-closed missing parser (`wikiStore.pg.test.ts`, 31 tests).
- **Every endpoint, status and body** of the contract delta: `wiki.int.test.ts`, 78 tests.

## Consequences

- **A policy or foreign-key mistake leaks one show's wiki to another team.** Changes to the wiki tables are tier 2 and must keep the access matrix green.
- **Revisions grow with every save.** History is paged and no-op saves add nothing. If storage shows up in monitoring, retention is a later change.
- **Citations carry seconds and the quote, not chunk ids.** A transcript edit can move the words a little; the link still opens close to the moment.
- **The web copy of the URL grammar can drift from the contract.** The pinning test is what catches that.
- **The concurrent-create and stray-`23505` paths are not forced deterministically in tests** (task 3.2 evidence).
- **Drop or revisit if:** `show-wiki-ai` needs citations by chunk, the wiki needs search ranking, or editors start colliding often enough that compare-and-set feels like friction.
