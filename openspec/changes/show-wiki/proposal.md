# Show wiki: a hand-edited knowledge wiki for each show, with revisions and transcript citations

Tier: 2
Tier reason:
- adds wiki endpoints and the `/wiki` shell routes to the frozen contract (`server/src/routers/**`, `packages/contract/**`);
- adds a migration with three tables, RLS policies, grants and composite foreign keys (`supabase/migrations/**`);
- wiki pages are drawn from transcripts, so they must follow the show-grant rules exactly.

Approved-by: Kalen 2026-10-12

## Why

The owner wants every show to have a knowledge wiki, "show memory for producers", that answers questions such as:
- "What have we said about X?"
- "When was guest Y on?"
- "Which running bits do we keep coming back to?"

Search (`catalog-search`, ADR 0029) can find moments, but there is nowhere to keep what a producer learns from them.

This change builds the wiki that people edit: pages, revisions, aliases, merge and split, and citations that open the transcript at the cited moment. The AI drafting step comes next, as `show-wiki-ai`. It writes into these same pages through suggestions that a person reviews, so the data model and the editing UI have to exist first.

## What Changes

- **One wiki per show.** Each page has a kind, a title, a Markdown body and aliases:
  - kinds are **person**, **topic**, **running bit** and **session**;
  - a session page is the index page for one session of that show, and there is at most one per session.
- **Access is show access.**
  - Owners and admins of the show's team, and members with a grant on the show, can read and edit everything: create, edit, merge, split, delete and restore.
  - Anyone else, including a team member without a grant, gets the masked 404, as with sessions.
- **Revisions.**
  - Every save appends an immutable revision.
  - History shows each revision, paged from newest to oldest, with a line diff against the current text. Any revision can be restored; restoring appends a new revision, and history is never rewritten.
  - A save that changes nothing appends no revision.
  - Saves use compare-and-set on the page revision, and a stale save gets `409 Version conflict` with the current page.
- **Aliases and titles.** A live title or alias is unique within a show, ignoring case and accents. A clash gets `409 Title already used.`, naming the page that holds it.
- **Merge and split.**
  - *Merge A into B:* A's body is appended to B under a heading, A's title and aliases become aliases of B, and A becomes a redirect to B.
  - *Split:* part of a page's body moves to a new page, in one step.
- **Citations and links are inline Markdown:**
  - `[quoted words](cite:<session_id>@<seconds>)` renders as a moment link that opens the session at that time;
  - `[label](wiki:<page_id>)` links to another page.

  On every save, merge or split, the server reads the body with the same CommonMark parser the page renders with, so reference links, autolinks and other forms are checked too. Every `cite:` session must belong to the page's show and every `wiki:` target must be a page of the same show. Otherwise the save gets `422` naming the link.
- **Safe rendering.**
  - Markdown is rendered to React elements and raw HTML is skipped.
  - Links are limited to `https:` and well-formed `cite:` and `wiki:`, so a `javascript:` link renders as plain text.
  - Titles and aliases are single-line plain text.
- **Delete is soft.** Deleted pages leave the lists, keep their revisions, and can be restored.
- **API:**
  - show-scoped `GET`/`POST /api/shows/:showId/wiki/pages`;
  - page-scoped `GET`/`PUT`/`DELETE /api/wiki/pages/:pageId`;
  - `…/restore`, `…/revisions` (paged), `…/revisions/:rev`, `…/merge` and `…/split`.

  Restoring a revision is a `PUT` with that revision's content.
- **Web:**
  - `/wiki` lists the active show's pages, with tabs for People, Topics, Running bits and Sessions, a filter and "New page";
  - `/wiki/:pageId` is the page view, with an editor that has Write and Preview tabs, a conflict banner, alias chips, a history sheet with diff and restore, and merge, split and delete actions;
  - a "Wiki" link in the top bar;
  - a "Wiki page" button on the session page that opens the session's index page, creating it if needed.

## Non-goals

- **AI drafting** (`show-wiki-ai`, next): the "Update wiki from this session" turn, pending suggestions, reviewing suggestions in an inbox, and checking that a citation's quote really is in the transcript.
- Wiki pages in search results (`catalog.search`).
- Permissions per page, read-only roles, and wikis shared across shows.
- Real-time collaborative editing. Compare-and-set and the conflict banner cover two people editing at once.
- Notifications, watch lists, comments on pages.
- Images and attachments in pages.
- Semantic search and embeddings.

## Capabilities

### New Capabilities
- `show-wiki`: pages, kinds and session index pages; access; revisions and restore; compare-and-set; titles and aliases; merge and split; `cite:` and `wiki:` links and their checks on save; safe rendering; soft delete; the wiki UI and the session-page entry point.

### Modified Capabilities
- `api-contract-freeze`: ADDED the wiki endpoints and the wiki HTML shell routes (`/wiki`, `/wiki/:pageId`).
- `catalog-database`: ADDED the wiki tables (pages, aliases, revisions) with their policies, grants, uniqueness rules and composite foreign keys that keep every row in one show, plus `unique (id, show_id)` on `catalog.sessions`.
- `web-session-routing`: MODIFIED "URL-addressed session state", adding the `/wiki` and `/wiki/:pageId` app routes.
- `web-frontend-platform`: MODIFIED "Shell routing from the shared route definition". It lists `/search`, which `catalog-search` left out, and adds `/wiki` and `/wiki/:pageId`.

## Impact

- **Database:** a new migration, `supabase/migrations/20261021000000_show_wiki.sql`.
  - The tables start empty, so there is no backfill.
  - `catalog.sessions` gains `unique (id, show_id)`, to back a composite foreign key.
- **Server:**
  - `packages/catalog/src/wikiStore.ts` (new), added to the catalog facade;
  - the link parser in `packages/contract`, which gains `mdast-util-from-markdown` 2.0.2 (pinned; already what react-markdown parses with);
  - `server/src/routers/wiki.ts` (new), mounted in `server/src/app.ts`;
  - `packages/contract/src/schemas.ts`;
  - the README endpoint table;
  - `fixtures/api-responses/wiki*.json`.
- **Web:**
  - `pages/index/components/wiki/*`, the `useWiki` hook and `wikiKeys`;
  - `AppShell.tsx`, `TopBar.tsx`, and the feed-tab row of `SessionWorkspace.tsx`;
  - `shared/utils/loginReturnPath.ts`, `api/types.ts`;
  - `useSwitchActive` invalidates the wiki cache when the show changes;
  - new dependencies, pinned to exact versions: `react-markdown` 10.1.0 and `diff` 8.0.2.
- **Docs:** ADR 0030 (wiki storage, citations and access).
