# Design: show-wiki-ai

## Context

See proposal.md (Why). The current state that shapes the approach:

- **The AI harness** (ADR 0027/0028, `ai-sdk-agent-harness`):
  - turn kinds are hard-coded: `SdkTurnKind = 'chat' | 'topics' | 'events'` and `SDK_TURN_TOOLS` (`packages/ai-runtime/src/sdkTurn.ts:87-93`);
  - tool bodies are written once in `aiMcpServer.ts` (`AI_MCP_TOOL_NAMES` `:80`, `TOOL_BUILDERS` `:733`, `ToolBuildContext` `:707`). They are served in process on the AI SDK route (`sdkTools.ts`) and over the MCP listener, which runs inside the same Node process, on the CLI route. Both go through `registerTurnTools(sink, registry, reg)`, with per-turn state held on the registration, because MCP servers are rebuilt per request;
  - the one-shot pattern is `topicGenerate.ts` (`generateTopicsTurn`), and its route is `server/src/routers/transcribe.ts:272`, with the guard ladder 404 → 503 → 403 → 400 → 409 → turn → `toolsDrained()` → coverage → 502;
  - single-flight is `aiChatTurns.tryAcquire` plus `claimAiLease` (`server/src/routers/_aiSlot.ts`); the AI SDK turn spec is `sdkTurnSpec` (`_aiRoute.ts:34`); bounds are `generateSdkLimits` and `topicGenerate*` in `server/src/env.ts`, typed in `packages/ports/src/config.ts` and loaded in `server/src/node/config.ts`.
- **No tool reads the catalog today.** `ToolBuildContext` holds only the session hub registry, the session id, the caller and paging state. `ai-runtime` depends on `contract`, `domain`, `ports` and `session-core`, not `catalog`, and `package-architecture` says it takes collaborators by injection.
- **The user-bound catalog** is `c.get('catalog')` (`server/src/middleware/auth.ts:40`), with `.wiki` (`wikiStore.ts`).
- **Wiki writes** run one SERIALIZABLE transaction each (`wikiStore.ts` header): pre-checked names, link checks through the injected `parseWikiLinks` (sessions and pages of the show; hidden sessions and deleted or merged pages allowed), and compare-and-set on `revision`. A write needs a user binding (`wikiStore.ts:782`), and revisions are authored by `app_user_id()`.
- **`parseWikiLinks` reports `link` and `definition` nodes only.** A reference `[text][r]` is an mdast `linkReference`, so its text is never reported (panel: the definition's label `r` is all the parser sees).
- **Transcript words** carry `session_time` (the timecode the model sees, `HH:MM:SS:FF` or drop-frame `HH:MM:SS;FF`) and `start_sec`. `start_sec` is not reliable: manual inserts and remapped words leave it at its default `0`, and editing `session_time` doesn't update it (panel). The generation word snapshot carries `word`, `session_time` and `speaker`.
- **Web patterns:** `useTopics.ts:25` (`useMutation` for a synchronous AI request), `SessionWikiButton.tsx` (a feed-row button using `apiFetch` and `showToast`), and `WikiHistorySheet.tsx` (`lineDiff`, `RevisionDiff` with the `diff` package).

## Goals / Non-Goals

**Goals:**
- The AI can propose, and never write. A page changes only when a person accepts, as an ordinary compare-and-set edit that the person authors.
- Every quote the AI adds is real: it occurs in the cited session (the run's, or an earlier one a carried-forward suggestion cites), close to the cited time.
- The AI reads exactly what the triggering user may read, through row-level security, with no system binding.
- A failed run leaves no trace, as topic generation guarantees.
- Unreviewed work is never silently lost: a newer run builds on the older pending suggestion.

**Non-Goals:**
- Fact-checking claims beyond the quote. A suggestion can still misread a true quote; the reviewer is the check.
- Partial acceptance of a suggestion.
- Merge, split or delete suggestions, and AI rewrites of pages longer than 30,000 characters.
- Searching other sessions during a run (cut by the panel; the run is "from this session").

## Decisions

### D1. One table, keyed by show
The schema is listed in the catalog-database delta.

- **`show_id` is stored**, so every policy is the same `accessible_shows` check as `wiki_pages`, and composite foreign keys `(session_id, show_id)` and `(page_id, show_id)` keep a suggestion inside its show. This is the same reasoning as show-wiki D1 (RLS alone lets a user who can access two shows mix them).
- **A suggestion stores a full proposed version** (title, kind, aliases JSON, body) plus the base revision. The client diffs it against the page's current revision.
- **Pending uniqueness** is enforced by partial unique indexes: one pending suggestion per `(show_id, page_id)`, and one per `(show_id, search_norm(title))` for new pages. The store supersedes the older one in the same transaction before inserting (D2), so the index is a backstop.
- **`catalog_user` privileges** (panel: the first draft's single `all` policy let a member forge authors, reopen resolved rows, and rewrite a body after its quotes were checked):
  - `wiki_suggestions_user_select`: `using` show access;
  - `wiki_suggestions_user_insert`: `with check` show access, `created_by = app_user_id()` and `status = 'pending'`;
  - `wiki_suggestions_user_update`: `using` show access and `status = 'pending'`; `with check` show access and (`status = 'superseded'` or (`status in ('accepted','dismissed')` and `resolved_by = app_user_id()`));
  - `revoke update, delete` from `catalog_user`, then `grant update (status, resolved_by, resolved_by_name, resolved_at_utc, resolved_revision)`. So the proposal columns can't change at all, and a delete fails with `42501`.
  - Name snapshots are written by the store and aren't pinned by the policy, as on wiki revisions today.
- **Names are snapshotted** (`created_by_name`, `resolved_by_name`), as wiki pages do, because RLS on `users` hides people who left the team.
- **IDs** come from `crypto.randomUUID()` before `catalog.tx`, so a retried transaction reuses them. `run_id` is one id per run.

The `catalog_user` policy count pinned in `catalogPolicies.pg.test.ts` goes 42 → 45 (the select, insert and update policies; `wiki_suggestions_system_all` is `catalog_system`'s and isn't counted).

### D2. Store: suggestion methods on `catalog.wiki`
The methods live in `packages/catalog/src/wikiSuggestionStore.ts` and are exposed on the existing `catalog.wiki` facade, so the catalog's pinned store list (`catalog.test.ts`) doesn't change.

- **Shared write steps.** The wiki store's create and edit pipelines are split into in-transaction steps (`createInTx`, `updateInTx`) that take the transaction and an optional revision note. Both bodies are already `this.#write(async (t) => …)` over static helpers taking `t`. `createPage` and `updatePage` call the steps unchanged, so their behaviour and tests stay the same. Accepting a suggestion calls the same steps inside its own transaction, so it gets every rule of a manual save: pre-checked names, link checks, the session-page rule, merged and deleted states, and compare-and-set.
- **Read helpers for the wiki tools** (all as the caller):
  - `checkLinks(showId, bodyMd)`: the existing `#checkLinks`, exposed, so a proposal's link check is exactly a manual save's;
  - `normalize(texts)`: one `select catalog.search_norm(x) from unnest(?::text[]) with ordinality`, so titles, quotes and transcript words fold exactly as the database's unique indexes do;
  - `nameHolder(showId, names)`: the existing pre-check query, returning the live page that holds any of the names;
  - `pendingFor(showId, {pageId | normTitle})`, and the pending new-page suggestions for the list tool.
- **`saveRun(showId, sessionId, runId, proposals)`**, one SERIALIZABLE transaction:
  1. re-validates every proposal's shape and links (cheap; it guards against a port bug, not the model);
  2. for each target, marks an older pending suggestion `superseded`;
  3. inserts the new rows, all `pending`, with the creator's name snapshot.

  A concurrent run on another session of the same show that touches the same target fails one side with `40001`, which the port retries; a stray `23505` re-runs the whole transaction once, as in the wiki store.
- **`listSuggestions(showId, {status, pageId})`** joins the target page for `page.title`, `page.revision`, `page.state` and `stale`, newest first, capped at 500 with `truncated`.
- **`getSuggestion(id)`** adds `body_md`.
- **`acceptSuggestion(id, {expectedRevision, title?, bodyMd?, aliases?})`**, one transaction:
  1. reads the suggestion; if it isn't pending, raises `WikiSuggestionResolvedError(status)` (409);
  2. for an existing page, requires `expectedRevision` (else `WikiInvalidError('expected_revision is required.')`), then calls `updateInTx` with the suggestion's or the overriding values and the note `accepted suggestion <id>` or `… (edited)`. "Edited" means some override differs from the suggestion's value;
  3. for a new page, calls `createInTx` with the suggestion's kind and the note `created from suggestion <id>`, and with `sessionId` when the kind is `session`;
  4. marks the suggestion `accepted` with the reviewer, time, name and the revision written.

  Every wiki error (`WikiConflictError`, `WikiMergedError`, `WikiDeletedError`, `WikiTitleTakenError`, `WikiSessionTakenError`, `WikiInvalidError`) propagates and fails the transaction, so the suggestion stays pending. A no-op accept (the suggestion equals the current page) still marks it accepted, with `resolved_revision` equal to the current revision.
- **`dismissSuggestion(id)`**: pending → dismissed, else `WikiSuggestionResolvedError`.

### D3. The wiki turn
- **`SdkTurnKind` gains `'wiki'`.** `SDK_TURN_TOOLS.wiki` is `get_transcript_words`, `list_wiki_pages`, `read_wiki_page`, `propose_page`. `AI_MCP_TOOL_NAMES` and `TOOL_BUILDERS` gain the three new builders. The `kind !== 'chat'` checks already give any non-chat kind the generation endings and per-turn tool cap. `WIKI_GENERATE_ALLOWED_TOOLS` is the CLI `--allowedTools` list.
- **The catalog comes in through a port.** `packages/ai-runtime/src/wikiTools.ts` declares `WikiToolPort`:
  ```ts
  interface WikiToolPort {
    showId: string;
    sessionId: string;
    listPages(): Promise<WikiToolPage[]>;            // live pages + pending flag
    listPendingNew(): Promise<WikiToolPendingNew[]>; // pending new-page suggestions
    readPage(id: string): Promise<WikiToolPageDetail | { mergedInto: string } | null>;
    readPending(suggestionId: string): Promise<WikiToolPendingDetail | null>; // a pending suggestion of the show only
    pendingFor(target: { pageId: string } | { normTitle: string }): Promise<WikiToolPendingDetail | null>;
    sessionWords(sessionId: string): Promise<WikiSnapshotWord[] | null>;     // null unless a session of the show
    sessionPageId(): Promise<string | null>;
    nameHolder(names: string[]): Promise<string | null>;
    checkLinks(bodyMd: string): Promise<string[]>;   // problems, [] when fine
    normalize(texts: string[]): Promise<string[]>;
  }
  ```
  The server implements it in `server/src/routers/_wikiToolPort.ts` over `c.get('catalog').wiki`, the facade bound to the caller, so every read is under the caller's RLS. No system binding is created, and `catalogSystem.repo.test.ts` stays as it is.
- **Per-turn state lives on the registration.** The port, the word snapshot and the run's `proposals` map are carried in the turn registration's context (as `pagedWords` and `pageState` are today), so the CLI's per-request MCP servers and the SDK tools share them.
- **Tool bodies:**
  - `list_wiki_pages {page?}` renders text lines `id · kind · title · aliases · rN · [pending]`, then the pending new-page lines `suggestion <id> · new · kind · title`. It packs at most 200 lines and 40,000 characters per call, with a final marker line, under the CLI's 45,000-character tool-output bound;
  - `read_wiki_page {page_id? | suggestion_id?}` renders a header and then one body between fixed delimiters: the page's (with its pending suggestion's id in the header) or a pending suggestion's of the show. `readPending` filters on the run's show and `status = 'pending'` itself; RLS alone would also return other accessible shows' and resolved rows. Any body is cut at 30,000 characters, then further so the rendered result, header included (aliases are JSON-escaped and can double), is at most 45,000 characters, and the cut is marked (re-panel 2026-10-14: a page plus its suggestion in one result could reach about 60,000, and an escaped header about 50,700);
  - `propose_page` validates (D4) and adds the proposal to the run's `proposals` map, keyed by target (`page:<id>` or `new:<normalized title>`, normalised through `port.normalize`). A later proposal for the same key replaces the earlier one. At most 20 keys.
- **`wikiGenerate.ts`** mirrors `generateTopicsTurn`:
  - it takes the word snapshot (`listTranscriptWords`, as topics do) before registering;
  - it builds the system prompt;
  - it calls `driveAiTurn` with `{sdk}` or `{cliPath, allowedTools, maxBudgetUsd}`;
  - it returns `{outcome, proposals, pageCoverage}`.

  The prompt names every tool's output as UNTRUSTED DATA (transcript, titles, aliases, bodies, suggestion text). It states the citation grammar, the timecode-to-seconds rule and the quote rule. It asks the model to read every transcript page, check `list_wiki_pages` before proposing new pages, build on a pending suggestion when one exists, propose the session's index page, keep each body under 30,000 characters, and write each page whole.
- **The route** (`POST /api/sessions/:sessionId/wiki/generate`, in `server/src/routers/wikiSuggestions.ts`) follows `transcribe.ts:272` step by step. `requireSession` already gives the masked 404 for a session with no show (`_helpers.ts:86-104`), so no separate show check is needed. On success (`outcome.ok`, `allTranscriptPagesServed`, tools drained), it calls `catalog.wiki.saveRun` and answers `200` with the stored suggestions. Any failure, including a `saveRun` error, answers the fixed `502` and logs only `sdkFailureSuffix`-style metadata.
- **Bounds** (panel: the topic caps would cap a normal wiki run and lose all of it):
  - `wikiGenerateTimeoutSec` (`WIKI_GENERATE_TIMEOUT_SEC`, default 900) and `wikiGenerateMaxBudgetUsd` (default 5.0) follow `topicGenerateTimeoutSec`;
  - `wikiSdkLimits` takes `WIKI_GENERATE_MAX_STEPS` (default 80, valid 1–200) and `WIKI_GENERATE_MAX_TOKENS` (default 6,000,000), with `GENERATE_MAX_OUTPUT_TOKENS` (default 16,000) for the per-step output;
  - a 30,000-character body is roughly 8–10k tokens, so one rewrite fits in one step's output.

  A realistic run is about 4 transcript pages, 2–3 list calls, up to 20 reads and 20 proposals, plus retries after misquotes: around 50 tool calls, and fewer steps, since a step can carry several calls.
- **The busy `409`** names "wiki update" in its own detail. This change doesn't change the other AI routes' frozen busy details, so while a wiki update holds the slot, a topics request's `409` lists the four older turn types only. That is accepted: the advice ("wait for it to finish") is still right, and changing four frozen strings would widen the contract delta.

### D4. Checking proposals
`propose_page` runs these checks in order and collects every problem before answering:

1. **Shape:** `wikiProposalSchema` in `packages/contract`, built from the wiki page schemas (title, aliases with lengths, count and control characters), with a body limit of 30,000 characters and a rationale of 1–500 characters. A `session` kind with aliases is refused, as the store refuses it.
2. **Target:**
   - With `page_id`: `readPage` must return a live page whose body is at most 30,000 characters. That supplies the base revision and base body. `kind` must match. An identical title, aliases and body is "No change."
   - Without `page_id`: `kind` is required. `nameHolder([title, ...aliases])` must return null; otherwise the error names the page to target. Kind `session` is only for the run's session, and only if `sessionPageId()` is null.
3. **Links:** `port.checkLinks(body)`, the store's own manual-save check, must return no problems.
4. **Citations:** a new contract function, `citationsOf(body)` in `wikiLinks.ts`, parses with the same `mdast-util-from-markdown` and returns every **rendered** citation:
   - `link` nodes whose URL is `cite:` (inline, angle-bracket and autolinks);
   - `linkReference` nodes (full, collapsed and shortcut) whose definition, matched case-insensitively as CommonMark does, is a `cite:` URL.

   Each comes with its session, seconds and rendered text (the node's text content). Definitions that no reference uses render nothing and aren't citations.

   A citation is **kept** when `citationsOf(baseBody)` has the same `(sessionId, seconds, normalised text)`. Kept citations aren't checked. Every other citation must cite the run's session, or a session that the target's pending suggestion (`port.pendingFor`, for a page id or a new page's normalised title) cites, and pass the quote match against that session's words.
   - **Why not exempt the pending suggestion's citations** (re-panel 2026-10-14): a pending body can hold citations its own run kept unchecked from an older base, which a person may since have removed from the page, and nothing in the database proves a pending row went through `propose_page`. Re-checking keeps one rule: anything not on the page now is checked.
   - **Other sessions' words** come from `port.sessionWords(id)`, read as the caller and only for a session of the show, once per run and cached, normalised with one `port.normalize` call each. At most 10 other sessions per run; past that the tool error says so. Only sessions the target's pending suggestion cites qualify. That is a limit on the model, not on a member: a member who inserts a pending row directly could cite any session of the show, so the check can tell a run whether words occur in any session of the show. That stays within what the caller can already read (their own access, RLS on words), and the answer is only pass or fail.
5. **Quote match**, in TS over the run's word snapshot:
   - once per run and per session, that session's words are normalised through `port.normalize` (one SQL call), then `regexp`-split into tokens (each run of non-alphanumerics becomes a boundary). Each token keeps its word's time: the `session_time` timecode parsed as `HH×3600 + MM×60 + SS` (frames dropped; `:` or `;` before the frames), or `start_sec` when the timecode is empty;
   - the quote is normalised the same way, and must be 1–60 tokens;
   - it must occur as a contiguous token run whose first token's time is in `[t−30, t+30]`;
   - at most 200 checked citations per proposal.

   The model reads the same `session_time` timecodes in the transcript pages, so the check uses the same clock the model cites from. `start_sec` is used only as a fallback.
6. **Answer:** on any failure, the tool returns `isError` with one line per problem, for example `cite:S1@120 "we never said that": not found within 30 s of 00:02:00`, and records nothing.

*Alternatives:*
- **Strip failing citations and keep the rest.** The owner chose rejection: the server never rewrites Markdown, and the model fixes its own text.
- **Refuse reference-style citations.** That's simpler, but react-markdown renders them as citations, and a page a person wrote could already hold them. Checking the rendered text covers both.
- **Quote any session of the show.** Cut by the panel: it needs reads of other sessions' words, gives a yes/no oracle into them, and isn't needed for "from this session". The re-panel (2026-10-14) allows exactly one narrower case, the sessions the target's pending suggestion cites, because carrying a suggestion forward otherwise drops its citations; the oracle it gives stays within the caller's own access (see step 4).
- **A TS port of `search_norm`.** It would only approximate `unaccent`; `port.normalize` keeps one definition.

### D5. API
The routes, bodies and statuses are in the api-contract-freeze delta.
- The show-scoped list (`/api/shows/:showId/wiki/suggestions`) gates on `requireShowAccess`. Suggestion-scoped routes load the suggestion as the user, so an inaccessible one reads as missing (`404 Suggestion not found.`).
- Schemas are new zod schemas in `packages/contract/src/schemas.ts` (`wikiSuggestionSchema`, `wikiSuggestionDetailSchema`, `wikiSuggestionListSchema`, `wikiSuggestionAcceptSchema`, `wikiGenerateResponseSchema`, `wikiProposalSchema`), strict on responses.
- The router `server/src/routers/wikiSuggestions.ts` is mounted in `app.ts`. `wikiError` in `wiki.ts` is exported and gains `WikiSuggestionResolvedError` → `409 {"detail":"Suggestion already resolved.","status"}`.
- The README gains one row per route; the fixtures are `fixtures/api-responses/wikiSuggestion*.ts`.

### D6. Web
- **`api/hooks/useWikiSuggestions.ts`:** `useWikiSuggestions(showId, {status, pageId})`, `useWikiSuggestion(id)`, `useAcceptWikiSuggestion()`, `useDismissWikiSuggestion()`, `useGenerateWiki(sessionId)`. Keys are added to `wikiKeys` (`suggestions(showId, filters)`, `suggestion(id)`) under the `'wikiPages'` root, so `useSwitchActive`'s existing `wikiKeys.all()` covers them. Accept and dismiss invalidate the suggestions, the page and the page list; generate invalidates the suggestions.
- **`UpdateWikiButton.tsx`** sits in the feed-tab row immediately before `SessionWikiButton`, which stays at the end of the row (show-wiki "Wiki screens"). It is disabled while pending ("Updating wiki…"). On success, a toast says "n suggestions ready" with a link to `/wiki?tab=suggestions`, or "No suggestions this time". On `503` the toast is the Settings → Advanced message; on other errors it is the response detail.
- **`WikiRoute`** gains a Suggestions tab, labelled with the pending count. `?tab=suggestions` selects it on load; it isn't a new route, because wouter matches on the path only. Items are grouped by target and show the target title or "New page · kind", the session, the rationale as text, and a Stale badge.
- **`WikiSuggestionSheet.tsx`** (shadcn `sheet`):
  - it loads the suggestion detail and the target page;
  - the diff is always against the page's current revision, using `lineDiff`/`RevisionDiff`, moved from `WikiHistorySheet.tsx` into `wiki/wikiDiff.tsx` with no behaviour change. A stale suggestion says the page changed since. A new page diffs against empty;
  - it has Preview (`WikiMarkdown`), Accept (sending the current revision it diffed against), Edit then accept, and Dismiss. Edit then accept opens `WikiEditor` prefilled; for a new page, the editor's draft mode has a fixed kind. Its save calls accept with the overrides;
  - on a `409 Version conflict.` it refetches the page and redraws, keeping edited text.
- **`WikiPageView`** shows a banner when `useWikiSuggestions(showId, {pageId})` has a pending item, and opens the sheet.

### D7. Changing existing tests
An existing test may change only in these categories. Anything else is a stop.
1. **Schema inventories gain `wiki_suggestions`:** `catalogSchema.pg.test.ts` (tables, columns, constraints, policy names), `catalogPolicies.pg.test.ts` (the `catalog_user` count 42 → 45 and its comment), `catalogPolicyHelpers.pg.test.ts`, `catalogRoles.pg.test.ts` (including the column-level update grant), and `server/src/test/session/isolation.int.test.ts`. Existing entries are otherwise unchanged.
2. **Turn and tool inventories gain `wiki`:** `packages/ai-runtime/src/sdkTurn.test.ts` ("each turn kind gets exactly its tool set") and any test that pins `AI_MCP_TOOL_NAMES` or the tool registry gain the wiki kind and its three tools. Existing kinds' expectations are unchanged.
3. **Registry and fixture inventories gain suggestion entries:** `apiResponseFixtures.int.test.ts`, `web/src/api/types.conformance.test.ts`, `web/src/queryKeyFactories.repo.test.ts`. Existing entries are unchanged.
4. **Shell controls gain the new entry points:** the `SessionWorkspace*.test.tsx` files, the `WikiRoute` tests and the `WikiPageView` tests may gain mocks or assertions for "Update wiki", the Suggestions tab and the page banner. Existing assertions are unchanged. The one exception (added 2026-10-14, after approval; owner decision when task 6.4 hit it): `WikiRoute.test.tsx`'s pinned tab list, `['People', 'Topics', 'Running bits', 'Sessions', 'Deleted']`, may gain `'Suggestions'`. Nothing else in that test changes.
5. **The diff move:** `WikiHistorySheet` tests may change only their imports, if any. What the history diff renders stays the same.
6. **Config inventories gain the four env vars:** `server/src/env.test.ts`, `server/src/upgradeDispatch.test.ts` (the full-`Config` fixture), and any test pinning the env allowlist or `server/.env.example`.
7. **The AI-router safety scan gains the wiki router** (added 2026-10-14, after approval; owner decision when task 5.1 found it unscanned): `packages/ai-runtime/src/sdkSafety.repo.test.ts`'s fixed router list gains `server/src/routers/wikiSuggestions.ts`. Nothing else in that test changes.

## Risks / Trade-offs

- [A wiki tool leaks another show's pages or transcript] → Every read goes through the caller-bound catalog under RLS. The show comes from the session, never a tool parameter. New citations may quote the run's session, whose words are already in the turn, or a session the target's pending suggestion cites, whose words are read as the caller and only answered pass or fail (D4 step 4). Each tool has a cross-show test.
- [Prompt injection in a transcript or page body steers the model] → No tool writes anything. `propose_page` only produces a pending suggestion that a person reviews as a diff. Bodies render under show-wiki's safe-rendering rules, and the system prompt names all tool output as untrusted data.
- [A forged or reference-style citation gets past the check] → The check runs on every rendered citation (`citationsOf`), keyed by rendered text, using the same parser the page renders with.
- [A real quote supports a false claim] → Not prevented. The quote check stops invented quotes; the diff and the Stale flag help review; the reviewer decides.
- [Quote matching is too strict for a noisy transcript] → Case, accents and punctuation are ignored, and a failing citation goes back to the model with the reason, so it can quote the exact words or drop the citation. If real runs fail often, the window or the normalisation is a later change.
- [A newer run drops an older run's unreviewed work] → The model reads the pending suggestion and builds on it (D3), and the superseded row stays listable by status.
- [Long pages or large lists overflow a tool result or a step] → Lists are packed to 40,000 characters, reads are cut at 30,000, and proposals are capped at 30,000. Pages over the cap can't be rewritten by the AI (a non-goal).
- [A reasoning model spends the per-step output cap before it finishes a page] → Accepted by the owner on 2026-10-14, after the dev check (task 6.5): on the dev SGLang model a 1,362-word session failed twice at `GENERATE_MAX_OUTPUT_TOKENS` (16,000) with `last=length`, storing nothing, as specified. The estimate above ("one rewrite fits in one step") holds for the body, not for a model that reasons first. The remedy is configuration (raise `GENERATE_MAX_OUTPUT_TOKENS`, up to 128,000, which also applies to topic and event generation); a wiki-only output cap is a possible follow-up.
- [A long run holds the session's AI slot] → Bounded by `WIKI_GENERATE_TIMEOUT_SEC` and the wiki step and token caps.
- [Concurrent runs on two sessions of a show target the same page] → SERIALIZABLE plus the pending unique index; the later commit supersedes the earlier one.
- [Other routes' busy `409` doesn't name "wiki update"] → Accepted (D3).

## Migration Plan

1. `20261022000000_show_wiki_ai.sql` creates `catalog.wiki_suggestions` with its keys, checks, indexes, the four policies, `revoke update, delete` and the column update grant. No backfill.
2. Rollback: drop the table.
3. The pg suite applies the migration to the template database, and `docker/supabase/test_migrate.sh` runs.

## Assumptions

Each was tested on 2026-10-13 against the dev DB (`docker exec -i autologger-dev-db-1 psql -U postgres -d postgres -At`) or the repo. Rows marked *(panel)* were tested by the assumption tester.

| # | Assumption | Command | Observed |
| --- | --- | --- | --- |
| A1 | Turn kinds and their tool sets are one hard-coded map | `sed -n 86,93p packages/ai-runtime/src/sdkTurn.ts` | `export type SdkTurnKind = 'chat' \| 'topics' \| 'events';` and `SDK_TURN_TOOLS` with three entries |
| A2 | `ai-runtime` already depends on `contract`, so tools can call `citationsOf`, and not on `catalog` | `grep -A8 '"dependencies"' packages/ai-runtime/package.json` | `"@autologger/contract": "*"`, `domain`, `ports`; no `catalog` |
| A3 | `search_norm` plus a punctuation `regexp_replace` folds case, accents and punctuation | `select regexp_replace(catalog.search_norm(regexp_replace('Café, "NOIR"!  is  great','[^[:alnum:][:space:]]+',' ','g')),'\s+',' ','g')` | `cafe noir is great`; *(panel)* also `strasse`, `rock n roll`, `istanbul` |
| A4 | `start_sec` is unreliable, so `session_time` is the clock | *(panel)* `sed -n 142p packages/session-core/src/transcriptStore.ts`; `transcriptRemap.ts:240` | manual inserts omit `start_sec` (default 0); remap sets `start_sec: 0` |
| A5 | `session_time` matches `start_sec` where both are set, and is set on every dev word | `select session_time, start_sec … limit 3`; `count(*) filter (where session_time='')` | `02:15:51:22\|8151.93`, `02:44:42:01\|9882.046`; `0` empty of `32258` |
| A6 | The snapshot words carry `session_time` | *(panel)* `grep -n "interface AiGenerationSnapshotWord" -A4 aiMcpServer.ts` | `word; session_time; speaker` |
| A7 | The biggest dev transcript is about 29k words, several generation pages | `select s.id, count(*) … group by 1 order by 2 desc limit 1` | `…\|28579` |
| A8 | Wiki writes require a user binding, so the reviewer authors an accept | `grep -n "need a user binding" packages/catalog/src/wikiStore.ts` | `:782 throw new TypeError('wiki writes need a user binding')` |
| A9 | `parseWikiLinks` doesn't report reference text, hence `citationsOf` | *(panel)* `parseWikiLinks('[we never said that][the]\n\n[the]: cite:S1@120')` | `[{"source":"definition","label":"the"}]` |
| A10 | The manual-save link check allows deleted and merged pages | *(panel)* `sed -n 18-21p packages/catalog/src/wikiStore.ts` | "hidden sessions and deleted or merged pages are allowed" |
| A11 | The policy test counts only `catalog_user` policies, 42 today | *(panel)* `sed -n 596-604p catalogPolicies.pg.test.ts`; DB count | `'catalog_user' = any(roles)` … `toHaveLength(42)`; `42\|72` |
| A12 | `requireSession` already masks a session with no show | *(panel)* `sed -n 86,104p server/src/routers/_helpers.ts` | `if (!showId \|\| !(await …authCanAccessShow(…))) throw new ApiError(404, 'Session not found')` |
| A13 | The MCP listener runs in process, and per-turn state belongs on the registration | *(panel)* `sed -n 1,6p; 960-1060p aiMcpServer.ts` | "runs INSIDE the existing Node process"; `registerTurnTools(sink, registry, reg)` for both routes |
| A14 | The create and edit bodies can become in-transaction steps | *(panel)* `sed -n 415-536p wikiStore.ts` | both are `this.#write(async (t) => …)` over static helpers taking `t` |
| A15 | The CLI's tool-output bound is why pages stop at 45,000 characters | `sed -n 440,450p packages/ai-runtime/src/aiMcpServer.ts` | `GENERATION_PAGE_MAX_CHARS = 45_000` (under the CLI's 50k diversion) |
| A16 | Generation's step and token caps are 40 and 3M, and the output cap is 16k | `sed -n 138,143p server/src/env.ts` | `intInRange(env.GENERATE_MAX_STEPS, 1, 100, 40)`, `… 3_000_000`, `… 16_000` |
| A17 | A new env var needs the `Config` type, the loader and the compose allowlist | *(panel)* `grep -n TOPIC_GENERATE_TIMEOUT_SEC packages/ports/src/config.ts server/src/node/config.ts server/src/upgradeDispatch.test.ts`; `compose-run.mjs:36` | `:59`, `:231`, `:44`; `ALLOWLIST = 'docker/secrets-env.yaml'` |
| A18 | Topic generation's busy detail names the slot holders, and is frozen per route | `sed -n 265,267p server/src/routers/transcribe.ts` | `'A turn (AI chat, AI v2, topic generation, or event generation) is already in progress …'` |
| A19 | The history diff helpers are local to `WikiHistorySheet` today | `grep -n "function lineDiff\|function RevisionDiff" …/WikiHistorySheet.tsx` | `:55 function lineDiff`, `:68 function RevisionDiff` |
| A20 | Revision notes are free text, so `accepted suggestion <id>` needs no schema change | `grep -n note supabase/migrations/20261021000000_show_wiki.sql` | `:74 note text collate "C",` with no check |
| A21 | `?tab=` on `/wiki` adds no route | *(panel)* `AppShell.tsx:124 useRoute('/wiki')` | wouter matches the path only |
| A22 | The newest migration is show-wiki's | `ls supabase/migrations \| tail -1` | `20261021000000_show_wiki.sql` |
