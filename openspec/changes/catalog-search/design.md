# Design: catalog-search

## Context

See proposal.md (Why). The current state that shapes the approach:

- **Collation.** Every catalog text column is `text collate "C"` (`20261001000000_catalog_schema.sql`, `20261008000000_session_tables.sql`). Under `"C"`, `lower()` and `ILIKE` fold ASCII only.
- **Access.**
  - `sessions` rows are readable by every member of the show's team. RLS uses `member_shows` (`20261007000000_catalog_policies.sql:198`), so notes are readable through RLS too.
  - The session list hides more by hand: a member without a grant sees `notes: ''`, while title, episode and dates stay visible (`redactSessionEntry`, `server/src/routers/sessions.ts:135`).
  - The nine content tables are readable only on `accessible_shows(app_user_id())` (`20261009000000_session_content_policies.sql:36-52`).
- **Hidden sessions.** Sessions are never hard-deleted. A hidden one has `ui_hidden = 1`, and the lists filter it out (`packages/catalog/src/sessionIndexStore.ts:114,125,133`).
- **Transcript words** are written in two ways (`packages/session-core/src/transcriptStore.ts`):
  - a bulk replace: one `DELETE`, then one `INSERT … SELECT FROM json_to_recordset` (`:245-275`);
  - manual edits of a single word: insert, update or delete (`:140-215`). An inserted word gets the next ordinal and `start_sec` 0.

  Today every word write runs inside `sessionTx`, which first locks the session row (`postgresCatalogStore.ts:170`). Paragraph rows exist only when the enrichment had paragraphs.
- **Requests run as the user.** Each catalog transaction starts with `set_config('role', …), set_config('app.user_id', …)` (`packages/storage/src/postgresCatalogStore.ts` `PREAMBLE`).
  - Transactions are SERIALIZABLE, retried on `40001`/`40P01`, and share 5 slots (`txSlots`) with a 10 s client deadline (`txTimeoutMs`, `:403,405`).
  - The app role has a 30 s `statement_timeout`.
- **RLS stops index use.** Text search and trigram operators are not leakproof, so under RLS Postgres won't push them into an index scan. As `catalog_user`, a GIN-indexed `@@` gives a `Seq Scan … Filter: (…policy… AND search_tsv @@ …)` (panel evidence).
- **The `extensions` schema.** The catalog roles have no `USAGE` on `extensions`. The pg test template database is cloned from `template1` and has no `extensions` schema.
- **Shows and studios have no URL.** They are the profile's active studio and show. One `PUT /api/profile` with `{active_studio_id, active_show_id}` can switch both (`server/src/routers/profile.ts:137`). TopBar's switch helpers and the `confirmSwitch` discard guard live in `TopBar.tsx:113-123`.
- **Shared route definitions.** Router-known routes are defined in `web/src/shared/utils/loginReturnPath.ts`, and the login-return stash keeps `pathname + search` (`loginReturnStash.ts:31`).

## Goals / Non-Goals

**Goals:**
- One request answers a palette keystroke in well under 100 ms at dev scale, using GIN indexes on every group.
- One search holds a catalog connection for at most 3 s, and searches can never take more than 2 of the 5 catalog slots in a server process.
- The grant split is decided in one reviewed SQL function, from the same helpers RLS uses.
- One chunking rule, enforced in the database.

**Non-Goals:**
- Ranking that uses popularity or recency signals beyond a tie-break.
- Highlighting inside the session workspace after a jump.

## Decisions

### D1. Lexical search in Postgres, not a vector store or a search service
Postgres full-text search plus `pg_trgm` and `unaccent` covers words, stems, phrases, exclusions, typos and partial names.

**Alternatives:**
- **pgvector.** It needs an embedding model and keys. Deferred.
- **A search service.** It would need its own copy of the team and grant data, kept in sync. Rejected.

### D2. Extensions, text-search configuration, normaliser and grants
- **Extensions.** `create schema if not exists extensions;`, then `create extension if not exists pg_trgm with schema extensions;` and the same for `unaccent`.
  - The schema line is needed because the pg test template has no such schema; on Supabase it already exists.
- **Grants.** `grant usage on schema extensions to catalog_user, catalog_system;`. Index expressions that call `extensions` objects are evaluated as the writing role, so without this grant every write to sessions, shows and studios would fail with `42501`.
- **Text-search configuration `catalog.search_english`.** A copy of `english` whose `word`, `hword` and `hword_part` mappings are `extensions.unaccent, english_stem`.
  - It folds accents and case in both the vectors and the queries.
  - Because the folding is inside the configuration, `ts_headline` on the original text still highlights the accented word: a probe on "…we met at the Café Noir" with query `cafe` gives `[Café] Noir`.
  - This replaces the first draft's `to_tsvector('english', search_norm(text))`, which lost highlights on accented hits.
- **Normaliser.** `catalog.search_norm(t text) returns text`, used only for trigram name matching:
  - `language sql`, `immutable`, `parallel safe`, `set search_path = pg_catalog`;
  - body: `lower(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(t, '')) collate "und-x-icu")`.
- **Function privileges.** Every new function is `revoke all … from public`, as the policy helpers already are (`20261007000000_catalog_policies.sql:80-86`). Then:
  - `search_norm`: `grant execute to catalog_user, catalog_system`; index expressions on names call it.
  - `catalog.search(…)` (D5): `grant execute to catalog_user`.
  - `refresh_transcript_chunks` and the chunk trigger function: no grant to anyone. Only the trigger calls them.

### D3. Generated `tsvector` columns and indexes
Generated columns are stored, so they can never be stale, and no application code writes them. Each uses `to_tsvector('catalog.search_english'::regconfig, …)`.

| Table | Column | Built from | Index |
| --- | --- | --- | --- |
| `sessions` | `search_meta` | title (weight A) and episode (weight B) | GIN |
| `sessions` | `search_notes` | notes | GIN |
| `session_topics` | `search_tsv` | summary | GIN |
| `session_events` | `search_tsv` | message | GIN |
| `session_transcript_chunks` | `search_tsv` | text | GIN |

There are also trigram GIN indexes (`extensions.gin_trgm_ops`) on `search_norm(sessions.title)`, `search_norm(shows.name)` and `search_norm(studio_definitions.display_name)`.

- **Spec impact.** The GIN indexes on `session_topics` and `session_events` don't lead with `session_id`, and the generated columns are new columns on content tables. The catalog-database requirement "Session content tables" is amended to allow both (MODIFIED in this change).
- **New columns stay out of API output.** Rows are mapped explicitly, so the new columns never reach API JSON (panel check).
- **Rewrite cost.** Adding a stored generated column rewrites `sessions`, `session_topics` and `session_events` under an `ACCESS EXCLUSIVE` lock. Dev has 12 sessions, 133 events and 29 topics, well inside the 10 s lock wait.

### D4. Transcript chunks: fixed ordinal buckets, kept in sync by the database
- **Table.** `catalog.session_transcript_chunks (session_id text collate "C" not null references catalog.sessions(id), bucket bigint not null, start_sec double precision, end_sec double precision, speaker text collate "C" not null default '', text text collate "C" not null, search_tsv … generated stored, primary key (session_id, bucket))`, with a GIN index on `search_tsv`. There is no cascade.
- **The rule.** A chunk holds the words with `ordinal` in `[bucket*40, bucket*40+40)`, in ordinal order:
  - `text` is the non-empty words joined by single spaces;
  - `start_sec` is the smallest positive `start_sec`, or null if none is positive;
  - `end_sec` is the largest `end_sec`;
  - `speaker` is the speaker of the first word;
  - a bucket with no non-empty words has no row.
- **Why buckets:**
  - a word edit touches exactly one bucket;
  - ordinals are stable (updates keep them, inserts append);
  - speaker turns would shift every later boundary.
- **Keeping it in sync.**
  - Statement-level `AFTER INSERT`, `AFTER UPDATE` and `AFTER DELETE` triggers on `session_transcript_words` use transition tables to collect each distinct `(session_id, ordinal / 40)`, then call `catalog.refresh_transcript_chunks(session_id, bucket[])` once per session.
  - That function first takes `pg_advisory_xact_lock(hashtextextended('transcript_chunks:' || session_id, 0))`, so two transactions can't interleave a delete-and-reinsert of the same buckets, even if a future writer skips `sessionTx`'s row lock.
  - It then deletes those buckets and reinserts them from the words with one set-based `INSERT … SELECT … GROUP BY`.
  - The backfill calls the same function.
  - The trigger function and `refresh_transcript_chunks` are `SECURITY DEFINER`, owned by the migration owner, with `search_path = pg_catalog, pg_temp` and schema-qualified names. EXECUTE is revoked from public (D2).
- **Privileges and policies.**
  - `revoke insert, update, delete on catalog.session_transcript_chunks from catalog_user;` (the pattern at `20261007000000_catalog_policies.sql:236`), so a direct write fails with `42501` instead of silently affecting 0 rows.
  - `catalog_user` gets one `SELECT` policy: the content-table predicate, `exists … accessible_shows(app_user_id())`.
  - `catalog_system` gets `*_system_all`.
- **Measured** (panel probe): on a 28,579-word session, the `DELETE` took 27.7 ms and the `INSERT` 340 ms, giving 715 chunks. The backfill of dev produced 808 chunks.
- **Alternatives:**
  - **Deepgram paragraphs.** Missing on some sessions.
  - **A tsvector per word.** No phrase search.
  - **Rebuilding in TypeScript.** Manual edits bypass it, and there would be two rules.

### D5. One definer function does the whole search
`catalog.search(q text, p_studio text, p_show text, p_limit int) returns jsonb`:
- `language plpgsql`, `stable`, `security definer`, owned by the migration owner;
- `set search_path = pg_catalog, pg_temp`, with every catalog object schema-qualified, as the policy helpers do (`20261007000000_catalog_policies.sql:26,42,53`). Listing `pg_temp` last stops a caller's temp table from shadowing a catalog table inside the definer body (re-panel probe);
- `set pg_trgm.word_similarity_threshold = 0.4`, so trigram matching can use the operator form;
- reads the caller from `app_user_id()`; returns an empty result when it is null.

**Why a definer function:**
1. Under RLS the text-search and trigram operators can't use their indexes (Context). The function's owner bypasses RLS, so the planner can use every GIN index.
2. The route sends one statement, so one `statement_timeout` covers the whole search (D7).
3. Every access rule lives in one reviewed body, built only from the policy helpers.

**Because it bypasses RLS, the function applies access itself, in every branch, from these sets:**
- `S_member`: `member_studios(uid)`;
- `Sh_member`: `member_shows(uid)`;
- `Sh_access`: `accessible_shows(uid)`.

**Groups.** Each has its own `limit`:
1. **Studios** in `S_member` where `search_norm(display_name) LIKE '%' || search_norm(q) || '%'`, or `search_norm(q) OPERATOR(extensions.<%) search_norm(display_name)`.
   - Both forms can use the trigram GIN index; a bare `word_similarity(…) >= 0.4` call cannot (re-panel probe: `Seq Scan`, against `Bitmap Index Scan … %>` for the operator).
   - `%` and `_` in `q` are escaped before the `LIKE`.
   - Ranked by `extensions.word_similarity` descending, then name.
2. **Shows** in `Sh_member`, matched and ranked the same way on `name`.
3. **Sessions** with `ui_hidden = 0` and `show_id` in `Sh_member`. The parsed query is `websearch_to_tsquery('catalog.search_english', q)`.
   - **Title match:** `search_meta @@ query`, or a trigram title match.
   - **Notes match:** only when `show_id ∈ Sh_access`, `search_notes @@ query`.
   - **For shows not in `Sh_access`:** `match`, rank and snippet are computed from `search_meta` and the trigram title score only. `search_notes` is never read in that branch, so ordering can't reveal notes.
   - **For accessible shows:** rank is the greater of the meta rank and the notes rank. `match` is `title` when the title matches, otherwise `notes`.
   - Ties are broken by `started_at_utc` descending.
4. **Moments.** Chunks, topics and events of sessions with `ui_hidden = 0` and `show_id ∈ Sh_access` that match `search_tsv @@ query`.
   - Ranked by `ts_rank_cd`, then `started_at_utc` descending.
   - At most 3 per session, using `row_number() over (partition by session_id)`.
- **Filters.** `p_studio` and `p_show` add equality predicates inside the same access sets, so an id outside them gives empty groups.
- **Stop words.** If `query` is empty (`numnode(query) = 0`, for example only stop words), the full-text branches return nothing and the trigram name branches still run.
- **Time of a moment (`sec`).** Only transcript chunks carry one (`start_sec`). Topics and events return `null`; the web places them with its feed rules (D8). This avoids a second, ungated copy of the event placement rule.

**Alternative:** a SECURITY INVOKER query under RLS. Simpler to reason about, but it can't use the indexes, and needs four statements, so four timeouts.

### D6. The grant split, tested as a matrix
`accessible_shows(app_user_id())` is the same helper the content RLS uses and that `GET /api/sessions` relies on through `authCanAccessShow`. A pg test runs the policy fixture's owner, granted member, ungranted member and outsider against a session whose title, notes, transcript, topic and event all contain distinct words, and asserts:
- **Results:** for each caller, which groups, `match` values and snippets appear;
- **Ranking:** for the ungranted member, two title-matched sessions that differ only in notes keep the same order whichever note word is searched.

### D7. Cost bounds: one statement, one budget, two slots
- **Input caps.** `q` is 2–200 characters after trimming; `limit` is 1–25.
- **One budget.** The route runs one catalog transaction: `SET LOCAL statement_timeout = '3s'`, then `select catalog.search(…)`. That is one statement, so one 3 s budget for the whole search.
- **Timeout mapping.** `57014` is not in the retry set (`RETRYABLE.catalog = {40001, 40P01}`). The store maps it to `SearchTimeoutError`. The route also maps `CatalogTxTimeoutError` to the same 503 timeout response.
- **Slots.** A process-wide semaphore lets at most 2 searches run at once. A search that waits more than 1 s for its turn gets `503 {"detail":"Search is busy; try again."}`. The other 3 catalog slots are always left for the rest of the app.
- **Client.** `useSearch` sets `retry: false`, debounces for 200 ms in the palette, and doesn't fetch for `q` shorter than 2 characters.
- **Abort.** An aborted request still finishes its statement, but that is bounded by the 3 s budget and the 2-slot cap.
- **Alternative:** a per-user window limiter that writes on every keystroke. Deferred until the logs show abuse.

### D8. Snippets and moment deep links
- **Snippets.** `ts_headline('catalog.search_english', regexp_replace(text, '[]', '', 'g'), query, 'StartSel=<U+E000>, StopSel=<U+E001>, MaxWords=24, MinWords=8, MaxFragments=1, FragmentDelimiter=" … "')`.
  - Forged sentinels are stripped from the text first.
  - The web renders `<mark>` text elements and never uses `dangerouslySetInnerHTML`.
  - `ts_headline` keeps markup as literal text (panel check).
  - Names and title matches have no snippet.
- **Deep links:**
  - `/sessions/:id?t=<sec>` places the timeline at `sec`;
  - `?topic=<id>` and `?event=<id>` compute the target with the feed's own placement helpers (`eventRowTimelineSec`, `EventLogSheet.tsx:132`; topic `sessionTimeToTimelineSec` with the `transcriptWhollyAnchorless` gate, `TopicsFeed.tsx:58`).
  - In every case the seek goes through `jumpTimelineToSec`, which moves the playhead and never plays. `useTimelineSeek().jump` would start playback when a clip covers the target, so it isn't used.
- **When a link is applied:**
  - it waits until session status has resolved and the timeline has registered;
  - if the session is rolling, it doesn't seek;
  - it then applies once, and removes the parameter with a history `replace`.
- **Same-session links.** Choosing a moment in the session that's already open is a same-id navigation: no remount and no departure. The workspace watches the URL's search string and applies a new moment parameter the same way.
- **Server.** The HTML shell route ignores the query string.

### D9. Web surfaces
- **Palette.** `shadcn add command` brings in `cmdk`, pinned to an exact version and passing `shadcnHygiene`.
  - `SearchPalette` opens on Cmd/Ctrl-K or from a top-bar search button.
  - The shortcut is ignored while focus is in an editable field, or while another modal dialog or sheet is open (web-ui-system's dialog rules).
  - `ShortcutsDialog` is not changed, because its list is fixed by web-session-console. The palette's button tooltip shows the shortcut instead.
- **`/search` page.** Added to the shared route-definition module and `AppShell` in the same change. It has the query and filters in the URL (edits replace the URL), groups of 25, filters, and loading, empty and error states.
- **Show and studio results.** TopBar's switch logic is extracted into a shared `useSwitchActive` hook, so the `confirmSwitch` discard guard and the close-session handling are reused.
  - A show result sends `{active_studio_id: hit.studio_id, active_show_id: hit.id}` in one PUT.
  - A studio result sends `{active_studio_id: hit.id}`.
  - Both then navigate to `/`.
- **Data.** `useSearch` uses a new `searchKeys` factory.

### D10. Changing existing tests
An existing test may change only in these categories. Anything else is a stop.
1. **Schema inventories gain the new objects.** These files enumerate catalog tables, columns, indexes, policies, functions or grants:
   - `catalogSchema.pg.test.ts`, including its per-table policy-name conditionals (`:823-835`), because chunks has a select-only user policy, not `_user_all`;
   - `catalogPolicies.pg.test.ts`, including its policy count (`:602`, 37 → 38);
   - `catalogPolicyHelpers.pg.test.ts`;
   - `catalogRoles.pg.test.ts`, for the function-execute inventory;
   - `server/src/test/session/isolation.int.test.ts`.

   Existing entries are otherwise unchanged.
2. **Route inventories gain `/search`.** In `loginReturnPath.test.ts`, `loginReturnStash.test.ts`, `AppShell.test.tsx` and `staticServing.int.test.ts`, only a route count or an assertion that `/search` is not a route may change.
3. **TopBar switch extraction.** `TopBar` tests may change only their import or mock paths, to follow the extracted `useSwitchActive`. What they assert stays the same.

## Assumptions

Each was tested on 2026-10-12. The DB probes ran in a transaction that was rolled back.

| # | Assumption | Command | Observed |
| --- | --- | --- | --- |
| A1 | The dev DB is PG 17 with `pg_trgm` and `unaccent` available but not installed | `psql -Atc "select name, default_version, installed_version from pg_available_extensions where name in ('pg_trgm','unaccent')"` | `unaccent\|1.1\|` and `pg_trgm\|1.6\|` |
| A2 | Schema `extensions` exists | `select nspname from pg_namespace where nspname='extensions'` | `extensions` |
| A3 | The ICU collation `und-x-icu` exists | `select collname, collprovider from pg_collation where collname in ('und-x-icu',…)` | `und-x-icu\|i` |
| A4 | The name normaliser `search_norm` folds accents and case, including non-ASCII | probe: `select catalog.search_norm_probe('Ångström CAFÉ Ünïcode Straße')` | `angstrom cafe unicode strasse` |
| A5 | It can back a trigram GIN expression index, and catches a typo | probe: `create index … using gin (search_norm_probe(t) extensions.gin_trgm_ops)`; `similarity(norm('Christina Ramos'), norm('Christna'))` | index created; `0.388889` (Café Show `0.0556`) |
| A6 | A stored generated tsvector works, and stemming matches (superseded by A21's config) | probe: a generated column `to_tsvector('english', search_norm_probe(t))`; `… @@ websearch_to_tsquery('english', norm('divorce'))` against "They were Divorced" | `'divorc':1 'talk':2`; `t` |
| A7 | The `english` config exists | `select cfgname from pg_ts_config where cfgname in ('english','simple')` | `simple`, `english` |
| A8 | Dev data size for the backfill | `select count(*), count(distinct session_id) from catalog.session_transcript_words` / `…paragraphs` | `32258\|4` words; `1780\|4` paragraphs |
| A9 | Migrations run as `postgres` (they can create extensions) | `grep -n PGUSER docker/supabase/test_migrate.sh` | `-e PGUSER=postgres` (lines 44, 108) |
| A10 | Bulk word replace is one `DELETE` and one `INSERT` statement | `sed -n 234,275p packages/session-core/src/transcriptStore.ts` | `DELETE FROM session_transcript_words WHERE session_id = ?` and one `INSERT … SELECT … FROM json_to_recordset` |
| A11 | Manual word edits are single-row statements; an insert appends the next ordinal with `start_sec` 0 | `grep -rn session_transcript_words packages server/src --include=*.ts \| grep -v test \| grep -iv select` | `transcriptStore.ts:140-215` (nextOrdinal insert with no start_sec column, update by id, delete by id); no other writer |
| A12 | Session content is Postgres-only; no SQLite path writes words | same grep as A11; `better-sqlite3` is used only in `dataDirLock.ts` and tests | confirmed |
| A13 | Sessions are never hard-deleted; hidden ones are `ui_hidden = 1` | `grep -rn "DELETE FROM catalog.sessions\|DELETE FROM sessions" packages server/src` | no matches; `sessionIndexStore.ts:114,125,133` filter `ui_hidden` |
| A14 | A no-grant member sees title and episode but not notes in lists | `grep -n "function redactSessionEntry" -A 10 server/src/routers/sessions.ts` | `notes: ''`; title and episode untouched |
| A15 | The app role's `statement_timeout` is 30 s, so a tighter `SET LOCAL` is needed | `grep -rn statement_timeout supabase/migrations` | `alter role autologger_app set statement_timeout = '30s'` |
| A17 | The login-return stash keeps the query string | `grep -n search web/src/shared/utils/loginReturn*.ts` | `` `${pathname}${search}` `` stored and returned |
| A18 | No existing server search, and no `pg_trgm` or `tsvector` in migrations | `grep -rn "pg_trgm\|tsvector\|to_tsvector" supabase/migrations server/src packages/*/src` | no matches |
| A16 | The catalog roles lack `USAGE` on `extensions`, so a grant is needed (panel) | `select has_schema_privilege(r,'extensions','usage') from unnest(array['catalog_user','catalog_system'])` | `f`, `f`; after `grant usage …`, a `catalog_user` title update gives `UPDATE 1` |
| A19 | Under RLS, `@@` can't use a GIN index; as the owner it can (panel) | `explain` of a chunks `@@` query as `catalog_user`, then as `catalog_system` | `Seq Scan … Filter: (… AND (search_tsv @@ …))`, then `Bitmap Index Scan on chunks_gin` |
| A20 | The pg test template has no `extensions` schema (panel) | `psql -d template1 -c "select nspname from pg_namespace where nspname in ('extensions','catalog')"` | no rows |
| A21 | An unaccent-based text-search config folds accents in the vectors, and `ts_headline` highlights on the raw text | probe: `catalog.search_english` (copy english; `word, hword, hword_part` → `extensions.unaccent, english_stem`); a generated column over it; `ts_headline(…,'…Café Noir…', websearch_to_tsquery(…,'cafe'))` | `t` for `cafe divorce`; `[Café] Noir, they were Divorced`; `'strass':2 'unicod':1` |
| A22 | New catalog tables are granted `arwd` to `catalog_user` by default, so an explicit revoke is needed (panel) | `select … from pg_default_acl` | `postgres\|catalog\|r\|{catalog_user=arwd/postgres,…}` |
| A23 | Catalog transactions share 5 slots with a 10 s deadline; `57014` isn't retried (panel) | `sed -n 155,170p;400,406p packages/storage/src/postgresCatalogStore.ts` | `RETRYABLE.catalog = {40001, 40P01}`; `txSlots = 5`; `txTimeoutMs = 10_000` |
| A24 | A statement-level trigger with transition tables and a definer function works inside the app's serializable transaction as `catalog_user`; the bulk replace cost (panel) | probe on the 28,579-word session | `UPDATE 1`, chunk text updated; `DELETE` 27.7 ms, `INSERT` 340 ms, 715 chunks |
| A26 | A definer function whose path omits `pg_temp` can be fooled by a caller's temp table (re-panel) | probe: definer `select … from sessions` with `search_path = pg_catalog, catalog`, then `create temp table sessions …` as `catalog_user` | `before\|005e2862-…`, then `after\|FAKE-FROM-TEMP`; the helpers use `pg_catalog, pg_temp` |
| A27 | Only the operator form of trigram matching uses the GIN index (re-panel) | probe on 20k rows: `word_similarity(…) >= 0.4` vs `'christna' <% t` with the threshold GUC | `Seq Scan … Filter`, then `Bitmap Index Scan … (t %> 'christna')` |
| A28 | `EXPLAIN` can't see inside a plpgsql function, and `auto_explain` can't be loaded by the test role (re-panel) | `explain select catalog.search(…)`; `load 'auto_explain'` | `Result`; `access to library "auto_explain" is not allowed` |
| A25 | One PUT can switch both studio and show | `sed -n 130,140p server/src/routers/profile.ts` | accepted when the show belongs to `active_studio_id` |

## Risks / Trade-offs

- **[Risk] Changes to unaccent data.** If the unaccent rules file changed in an image upgrade, stored vectors, the trigram indexes and `search_norm` would no longer match. → Mitigation: the dictionary is part of the pinned Postgres image. ADR 0029 records the upgrade step: rewrite the generated columns and `REINDEX` the search indexes.
- **[Risk] Bulk replace cost.** Each replace rebuilds every bucket, once in the delete pass and once in the insert pass. → Measured at 368 ms for 28,579 words (A24). A pg test keeps it under 2 s.
- **[Risk] Definer search function bypasses RLS.** A bug in it leaks across teams. → Mitigation: it is built only from the policy helpers; the D6 matrix test covers every caller and group; EXECUTE is granted only to `catalog_user`; and it reads the user from `app_user_id()`, never from an argument.
- **[Risk] Chunk boundaries ignore speakers.** A chunk can span two speakers, and its `speaker` is the first one. → Accepted: search finds moments; it doesn't attribute quotes. The wiki change cites seconds and a quote (show-wiki decision).
- **[Risk] Manual words with `start_sec` 0.** Chunks made only of manual words have a null `start_sec`, so the moment opens with no seek. → Accepted, and it matches the spec's "no seek when unmappable".
- **[Risk] Trigram false positives on short queries.** → Mitigation: two-character minimum, a `word_similarity` threshold of 0.4, and full-text results ranked first in the session group.
- **[Trade-off] Notes for no-grant members are excluded,** so a notes-only match is invisible to them, the same as in their list.

## Migration Plan

1. The migration (one transaction, under the runner's rules):
   - extensions;
   - `search_norm`;
   - generated columns;
   - the chunks table, its policies, functions and triggers;
   - the backfill: `refresh_transcript_chunks` for every session that has words;
   - indexes.

   It is tested by the pg suite (applied to the template database) and by `docker/supabase/test_migrate.sh`.
2. Deploy the server and web together. The route is additive; older web builds never call it.
3. **Rollback.** The server and web roll back cleanly; the new route simply goes unused. The database objects are additive and harmless if left in place. A down-migration is not provided (forward-only, as in earlier migrations). A follow-up migration can drop them if needed.

## Open Questions

None that change the specs or tasks.
