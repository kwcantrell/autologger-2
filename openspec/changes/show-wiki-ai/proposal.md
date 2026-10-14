# Show wiki AI: "Update wiki from this session", with verified suggestions a person reviews

Tier: 2
Tier reason:
- adds wiki suggestion endpoints and a wiki-update AI endpoint to the frozen contract (`server/src/routers/**`, `packages/contract/**`);
- adds a migration with a new table, RLS policies and composite foreign keys (`supabase/migrations/**`);
- adds an AI turn kind whose tools read the catalog (wiki pages and pending suggestions), so it is a new least-privilege surface that feeds untrusted transcript and page text to an LLM.

Approved-by: Kalen 2026-10-13 (re-panel: pending carry-forward re-check, one body per read)
## Why

`show-wiki` (#115, ADR 0030) gave each show a wiki that people edit by hand. Keeping it current by hand after every episode is the work producers skip, and it's the reason the wiki exists: the owner wants "show memory for producers" that stays up to date.

This change adds the AI step the grill planned: after a session, a producer clicks **Update wiki**, and the AI, running on that producer's own model, reads the transcript and the show's wiki and proposes rewrites of the pages it touched, plus new pages. Nothing changes until a person reviews each suggestion as a line diff and accepts it. Every quote the AI cites is checked against the transcript first.

## What Changes

- **"Update wiki" on the session page.** One synchronous request, like topic generation:
  - it runs on the caller's own language model, or on the Claude CLI for allowlisted accounts;
  - it reads the whole transcript (paged), the show's page list, any pages it opens, and their pending suggestions, so a newer run builds on unreviewed work instead of dropping it;
  - it proposes **full-page rewrites** of existing pages and **new pages** (person, topic, running bit), including the session's own index page;
  - it shares the per-session AI slot (one AI turn per session at a time) and has its own time, budget, step and token bounds.
- **Suggestions are checked before they are kept.**
  - Every new citation, including reference-style ones, must quote words that really occur in this session's transcript, starting within ±30 s of the cited time, ignoring case, accents and punctuation. Citations already in the page body aren't re-checked.
  - Links, titles, aliases and sizes follow the same rules as a manual save. An AI rewrite is capped at 30,000 characters, so it fits in one model step.
  - A proposal that fails is **rejected back to the model** with the reasons, so it can fix and retry. The server never rewrites a suggestion's Markdown.
  - Nothing is stored unless the whole run succeeds; a failed run returns `502` and stores nothing.
- **Suggestions.** Each one records the session it came from, its target (an existing page and the **base revision** it was written against, or a new page's kind and title), the proposed title, aliases and body, and a short rationale.
  - A new run's suggestion for the same target supersedes the older pending one.
  - Suggestions follow show access exactly, like pages. Anyone with show access can review them.
- **Review.** A **Suggestions** tab on `/wiki` and a banner on a page with a pending suggestion open a review sheet:
  - the line diff is against the base revision, or against the current text when the page has changed since ("stale");
  - **Accept** saves the suggestion as an ordinary compare-and-set edit on the revision the reviewer saw. The revision's author is the reviewer, noted `accepted suggestion <id>`;
  - **Edit, then accept** opens the normal editor prefilled with the suggestion;
  - **Dismiss** closes it.
- **API:**
  - `POST /api/sessions/:sessionId/wiki/generate`;
  - `GET /api/shows/:showId/wiki/suggestions`;
  - `GET /api/wiki/suggestions/:suggestionId`;
  - `POST /api/wiki/suggestions/:suggestionId/accept` and `…/dismiss`.

## Non-goals

- Background or automatic runs, for example after transcription finishes.
- Streaming progress for the run.
- Accepting part of a suggestion (per-hunk or per-claim acceptance).
- AI merge or split suggestions, and AI-proposed deletes.
- Notifications about new suggestions.
- Wiki pages in search results, semantic search and embeddings.
- Retention or pruning of old suggestions.
- AI rewrites of pages longer than 30,000 characters.
- Searching other sessions during a run, and new citations of other sessions (a carried-forward suggestion's citations of an earlier session are kept only after they are re-checked against that session).
- The phone top-bar layout pass (a separate follow-up).

## Capabilities

### New Capabilities
- `wiki-generation`: the `wiki/generate` endpoint: its gates and their order, single-flight, the wiki turn and its tool set, the checks on each proposal (including the ±30 s quote check), store-only-on-success, bounds and failure mapping.

### Modified Capabilities
- `show-wiki`: ADDED suggestions (lifecycle, supersede, access), accepting a suggestion as a compare-and-set edit, and the suggestions inbox and review sheet.
- `api-contract-freeze`: ADDED the wiki suggestion object, the wiki update endpoint, and the suggestion list, read, accept and dismiss endpoints.
- `catalog-database`: ADDED the `wiki_suggestions` table and its row-level security.
- `ai-topics-chat`: MODIFIED "Session-scoped MCP toolset" (the registry gains the wiki tools, offered only on wiki turns) and "Subprocess security lockdown" (a wiki turn may also read its session's show wiki and pending suggestions, as the caller, and nothing else).
- `auto-event-generation`: MODIFIED "Generation-density transcript rendering", naming the wiki turn as a generation-density turn.

## Impact

- **Database:** a new migration, `supabase/migrations/20261022000000_show_wiki_ai.sql`, with the `wiki_suggestions` table. It starts empty, so there is no backfill.
- **Packages:**
  - `packages/catalog`: suggestion methods on `catalog.wiki` (`wikiSuggestionStore.ts`), sharing the wiki write steps, plus read helpers for the wiki tools;
  - `packages/ai-runtime`: the `wiki` turn kind, three new tool builders, the quote match, an injected `WikiToolPort`, and `wikiGenerate.ts`;
  - `packages/contract`: suggestion schemas and `citationsOf` (every rendered citation, including references).
- **Server:**
  - `server/src/routers/wikiSuggestions.ts` (new), mounted in `app.ts`;
  - a port adapter on the caller's catalog;
  - new env `WIKI_GENERATE_TIMEOUT_SEC`, `WIKI_GENERATE_MAX_BUDGET_USD`, `WIKI_GENERATE_MAX_STEPS` and `WIKI_GENERATE_MAX_TOKENS`;
  - README endpoint rows and `fixtures/api-responses/wikiSuggestion*.ts`.
- **Web:**
  - an "Update wiki" button on the session page;
  - the Suggestions tab and review sheet, and a page banner;
  - `useWikiSuggestions` hooks;
  - the line diff moved out of `WikiHistorySheet` so it can be reused.
- **Docs:** ADR 0031 (the wiki AI turn: an injected catalog port as the caller, the quote check, store-only-on-success, the reviewer authors the revision).
