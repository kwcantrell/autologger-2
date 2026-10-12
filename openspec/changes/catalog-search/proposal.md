# Catalog search: find sessions, shows, studios and moments across everything you can see

Tier: 2
Tier reason:
- the frozen contract gains `GET /api/search` and the `/search` shell route (`server/src/routers/**`, `packages/contract/**`);
- a migration adds two extensions, generated columns, a table and triggers (`supabase/migrations/**`);
- the search queries read across studios, so they must keep the show-grant rules exactly.

Approved-by: Kalen 2026-10-12 (updated 2026-10-12)

## Why

The owner wants each show to have a knowledge wiki: the show's memory for producers ("what have we said about X?", "when was guest Y on?"). That wiki is a later change (`show-wiki`). It needs a way to find earlier mentions across sessions, and producers need the same thing today.

Right now the only search is a client-side check of whether a session title contains the typed text, in the recent list. Transcripts, AI topics, events and notes can't be searched at all.

## What Changes

- **Lexical search in Postgres.** Full-text search with stemming, phrases and `-exclusions`, plus `pg_trgm` for typos and partial names. Accents and case are folded. No vector search and no separate search service.
- **What is searched:**
  - session titles, episodes and notes;
  - show names and studio names;
  - transcript text;
  - AI topic summaries;
  - event messages.

  A transcript, topic or event hit is a **moment**: it links to the session and, when the time can be placed on the timeline, seeks there.
- **Access follows the session lists exactly:**
  - a member without a grant on a show matches only that show's session titles and episodes, its show name and its studio name;
  - notes, transcripts, topics and events match only on shows the caller can access;
  - hidden (deleted) sessions never match.
- **Transcript chunks.** A new table holds the transcript in blocks of 40 words. The database keeps it in sync whenever words are written, so every transcript can be searched whether or not Deepgram returned paragraphs. The wiki will later cite these chunks.
- **API:** new `GET /api/search?q=&studio_id=&show_id=&session_id=&limit=`. It searches all of the caller's studios by default and returns results grouped as studios, shows, sessions and moments, with highlighted snippets.
- **Web:**
  - a Cmd/Ctrl-K command palette showing the top hits;
  - a new `/search` results page and shell route;
  - session deep links that open at a moment: `/sessions/:id?t=<sec>`, `?topic=<id>` and `?event=<id>`;
  - clicking a show or studio hit switches to it, as the top-bar switcher does.

**Tuning after the dev-stack check (owner, 2026-10-12; design D11):**
- typo matching is stricter;
- a query of only common words falls back to exact-phrase matching in transcripts, topics and events;
- `/search` groups moments under their session, with "Show N more in this session" (a `session_id` filter and per-session totals in the API);
- transcript moments are labelled with speaker and time.

## Non-goals

- Semantic or vector search, embeddings, pgvector.
- The show wiki itself (`show-wiki`, the next change).
- Search history, saved searches and search analytics.
- Searching anything not listed above, such as dashboards, provider settings or other users' profiles.
- A rate limiter. Cost is bounded by input caps, a 3 s budget per search and at most 2 concurrent searches per process (design D7).
- Changes to the keyboard-shortcut dialog. Its list is fixed by web-session-console; the palette button's tooltip shows Cmd/Ctrl-K instead.
- Languages other than English. Transcripts are English-only today.

## Capabilities

### New Capabilities
- `catalog-search`: what search covers, the access rules for each match type, query syntax and normalisation, grouping, ranking and limits, snippet safety, the timeout, and the palette and results page.

### Modified Capabilities
- `api-contract-freeze`: ADDED the `GET /api/search` endpoint and the `/search` HTML shell route.
- `catalog-database`: MODIFIED "Session content tables" (allows the search column and its GIN index on topics and events); ADDED the search extensions, grants, text-search configuration and normaliser, the generated search columns and indexes, and the transcript chunks table (its privileges, policies, the triggers that keep it in sync, and the backfill).
- `web-session-routing`: MODIFIED URL-addressed session state (a fourth route, `/search`); ADDED moment deep links (`?t=`, `?topic=`, `?event=`) on `/sessions/:id`.

## Impact

- **Database:**
  - new migration `supabase/migrations/20261019000000_catalog_search.sql`, which:
    - creates `pg_trgm` and `unaccent` in schema `extensions`;
    - grants the catalog roles `USAGE` on `extensions`;
    - adds the `catalog.search_english` text-search configuration and `catalog.search_norm`;
    - adds the definer search function `catalog.search`;
    - adds generated columns on `sessions`, `session_topics` and `session_events`;
    - creates `catalog.session_transcript_chunks` with its triggers on `session_transcript_words`;
    - adds GIN indexes;
  - the backfill covers about 32k words in dev.
- **Server:**
  - `packages/catalog/src/searchStore.ts`, new: calls `catalog.search` with a 3 s budget and a 2-search concurrency cap;
  - `server/src/routers/search.ts`, new, mounted in `server/src/app.ts`;
  - the shell route module that defines router-known paths;
  - `packages/contract/src/schemas.ts`;
  - the README endpoint table;
  - `fixtures/api-responses/search.json`.
- **Web:**
  - `components/SearchPalette.tsx`, `SearchRoute`, the `useSearch` hook and `searchKeys`;
  - `AppShell.tsx`, and `TopBar.tsx` (search button; its switch logic extracted to a shared `useSwitchActive`);
  - the session workspace's moment seek;
  - `web/src/api/types.ts`;
  - the shadcn `command` component, which adds the `cmdk` dependency pinned to an exact version.
- **Docs:** ADR 0029 (lexical search in Postgres, vectors deferred) and `docs/supabase.md` (the extensions).
