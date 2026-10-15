# 0029: Catalog search is lexical, in Postgres, through one definer function

- Date: 2026-10-12
- Status: Accepted
- Rule: catalog-search (the search behavior and access rules), catalog-database ("Search extensions, normaliser and indexes", "Transcript chunks"), api-contract-freeze ("Search endpoint", "Search page HTML route"), and the pg tests `server/src/test/pg/catalogSearch.pg.test.ts` and `catalogSearchQuery.pg.test.ts`

## Context

Producers want to find what was said across sessions, and the planned show wiki needs the same retrieval to find earlier mentions (catalog-search proposal, "Why"). Before this change, the only search was a client-side title filter in the recent list.

Three facts shaped the design:

- **Access.** A team member can read every session row of the team's shows through RLS, notes included. The session list hides notes by hand from members without a show grant. Transcripts, topics and events can be read only on shows the caller can access.
- **RLS and indexes.** Text-search and trigram operators are not leakproof, so under RLS Postgres won't use their GIN indexes (design A19: `Seq Scan … Filter`).
- **Paragraphs.** Transcript paragraphs exist only for some sessions; words always exist.

## Decision

- **Lexical, not semantic.**
  - Postgres full-text search uses the configuration `catalog.search_english`: English stemming plus `extensions.unaccent`, so accents fold and `ts_headline` still highlights the original text.
  - `pg_trgm` covers typos and partial names, through `catalog.search_norm`, at a `word_similarity` threshold of 0.5. At 0.4, `pacing` matched "The Something Podcast" (0.43); real typos score 0.53 and up (design A29).
  - A query of only stop words (for example "why did he do that") falls back to whole-word exact-phrase matching of transcript, topic and event text, through `catalog.search_phrase_norm` and trigram indexes. The phrase must have at least 2 words and 6 characters, and each source reads at most 2,000 accessible candidate rows. The access sets apply before that cap, so other teams' rows can't use it up. A lone `the` took 4.4 s on 250k chunks, against 42 ms for a real quote (A31).
  - There is no vector store or search service. pgvector stays an option for a later change if the wiki needs matching by meaning.
- **One `SECURITY DEFINER` function, `catalog.search`, runs the whole search.** Inside it:
  - access sets come only from `member_studios`, `member_shows` and `accessible_shows` for `app_user_id()`;
  - notes, transcripts, topics and events are gated on `accessible_shows`, and notes never influence the ranking or the `match` of an inaccessible show's sessions;
  - `search_path = pg_catalog, pg_temp`, with every name schema-qualified, so a caller's temp table can't shadow a catalog table.

  Bypassing RLS is what lets the indexes work, and one statement gets one time budget.
- **Transcript chunks** are fixed blocks of 40 words by ordinal. Statement-level triggers with transition tables rebuild only the affected blocks, under a per-session advisory lock. `catalog_user` can read chunks only through the content policy, and has no write privilege on them.
- **Cost bounds instead of a rate limiter:**
  - `q` is 2–200 characters and `limit` is 1–25 per group;
  - each search runs under `SET LOCAL statement_timeout = '3s'`, and a timeout returns `503 Search timed out`;
  - at most 2 searches run per server process, and a third that waits 1 s gets `503 Search is busy`, so search never holds more than 2 of the 5 catalog connection slots;
  - the client doesn't retry.

*Alternatives considered.*
- **An invoker query under RLS.** No index use, and four statements meant four time budgets (panel, assumption tester).
- **A search service** (Meilisearch, OpenSearch). It would need its own copy of the team and grant data, kept in sync.
- **Deepgram paragraphs, or chunks by speaker turn.** Paragraphs are missing on some sessions, and speaker-turn chunks shift every later boundary when one word changes.
- **A per-user rate limiter.** It writes on every keystroke. Deferred until the logs show abuse.

## Evidence

- The panel, re-panel and consistency read are in `openspec/changes/catalog-search/panel.md`. The measured assumptions A1–A28 are in that change's `design.md`.
- A 28,579-word bulk replace rebuilds 715 chunks in 368 ms (A24).
- On the policy fixture, the D6 access matrix and the "hidden notes don't affect ranking" check pass. Index use was checked with `pg_stat_user_indexes` at 5,000 rows (task 3.1).
- On dev, an ungranted member gets 0 moments where a granted one gets 3 (task 6.2).

## Consequences

- **A bug in `catalog.search` leaks across teams, because the function bypasses RLS.** Any change to it is tier 2 and must keep the D6 matrix test green.
- **unaccent data is treated as immutable.** If an image upgrade changes the unaccent rules, rewrite the generated columns and `REINDEX` the search indexes (`docs/supabase.md`, "Search extensions").
- **Indexes after a bulk load.** GIN pending lists aren't merged by plain `ANALYZE`. Right after a bulk load the planner may seq-scan until autovacuum, or `VACUUM ANALYZE`, runs.
- **The phrase fallback has limits.** It misses a quote split across two 40-word chunks, and it does nothing for a single common word.
- **Moments are capped at 3 per session per search,** so one long session can't fill the results. `/search` offers "Show N more in this session", which uses the `session_id` filter and shows up to 25. Per-session totals (`moment_sessions`, at most 1000) say how many more there are.
- **Drop or revisit if:** search latency or the busy rate shows up in the logs, or the wiki needs matching by meaning. In either case, revisit the rate limiter or pgvector.
