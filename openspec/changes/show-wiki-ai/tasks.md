# Tasks

**Branch and commits**
- The first commit on `show-wiki-ai` holds only `openspec/changes/show-wiki-ai/`.
- The PR targets `supabase-migration`.
- The gates run with `GITHUB_BASE_REF=supabase-migration`.

**Logs and test-first**
- Logs live under the session scratchpad as `swa-<task>-<red|green>.log`, and each `Evidence:` line names its log.
- Each "test first" item is red before its change, or records why it already passes.
- Each task's text and its `Evidence:` stay in one block with no blank line.

**Commands**
- Targeted server tests: `cd server && npx vitest run --project <unit|integration|pg> <files>`.
- Packages: `npx vitest run` in `packages/{contract,catalog,ai-runtime}`.
- Web: `cd web && npx vitest run`.
- `npm run typecheck`.
- Migrations: `sh docker/supabase/test_migrate.sh`.
- The full pg and integration suites run in CI on the PR (ADR 0026). Locally, run the targeted tests, the unit suites and typecheck.

**Changing tests.** Changing an existing test is allowed only for the categories in design D7. Anything else is a stop: update the artifacts and ask the owner.

## 1. Baselines

- [x] 1.1 On the base, run the unit suites (server, packages, web) and typecheck, and record the counts. Then list the existing tests D7 may touch with `grep -rln "toHaveLength(42)\|SDK_TURN_TOOLS\|AI_MCP_TOOL_NAMES\|each turn kind\|expectCapturedResponse\|FACTORY_MODULE\|SessionWikiButton\|lineDiff\|TOPIC_GENERATE_TIMEOUT_SEC" --include=*.test.ts --include=*.test.tsx server/src packages web/src`, and classify each hit as D7 category 1–6 or unchanged. Verified by the recorded counts and the classified list.
  Evidence: `swa-1.1-baseline.log`: server unit `482 passed | 5 skipped`; contract `204 passed`; catalog `61 passed`; ai-runtime `260 passed`; web `2149 passed (161 files)`; `typecheck rc=0`. `swa-1.1-d7-classified.log`: 10 hits — cat 1: catalogPolicies.pg; cat 2: sdkTurn; cat 3: apiResponseFixtures.int, queryKeyFactories.repo; cat 6: env, upgradeDispatch, aiV2.int (full env fixture); unchanged: transcribe.int, aiChatRunner, apiResponseShapes.repo.

## 2. Migration: the suggestions table

- [x] 2.1 Test first: write `server/src/test/pg/wikiSuggestions.pg.test.ts` (using `policyFixture` and `asUser`), covering:
  - the table, its columns, checks, partial unique indexes and composite foreign keys;
  - "Ungranted member reads no suggestions": owner and granted member see the show's rows, the ungranted member and outsider see none, for select, insert and update;
  - "Suggestions are never deleted by users": delete as `catalog_user` gives `42501`;
  - "A checked suggestion can't be rewritten": updating `body_md`, `title`, `aliases_json`, `page_id`, `base_revision`, `rationale` or `created_by` as `catalog_user` gives `42501`;
  - "A resolved suggestion can't be reopened": setting an accepted, dismissed or superseded row back to `pending`, or to another status, updates no row;
  - "Suggestions carry their real author": an insert with another user's `created_by`, an insert that isn't `pending`, and an accept or dismiss with another user's `resolved_by` are refused; `superseded` with no resolver is allowed;
  - "Suggestion for a page in another show", and a session from another show: refused by the foreign keys, including for a user who can access both shows;
  - "Two pending suggestions for one page", and two pending new-page suggestions whose titles match ignoring case and accents: refused; a pending plus a superseded one is allowed;
  - the `page_id`/`base_revision` pairing, status, kind, length and resolved-field checks.
  Red before the migration. Verified by the red run, then green once 2.2 lands.
  Evidence: `swa-2.1-red.log`: `relation "wiki_suggestions" does not exist` → `Test Files 1 failed`, `Tests 28 skipped`. `swa-2.1-green.log`: `cd server && npx vitest run --project pg src/test/pg/wikiSuggestions.pg.test.ts` → `Tests 28 passed (28)`.
- [x] 2.2 Write `supabase/migrations/20261022000000_show_wiki_ai.sql` as design D1 describes: the table, keys, checks, indexes, the four policies, `revoke update, delete` and the column-level update grant. Update the schema inventories (D7 category 1). Verified by 2.1 green, the inventory pg tests green (`catalog_user` policy count 42 → 45), and `sh docker/supabase/test_migrate.sh` passing.
  Evidence: `swa-2.2-inventory-red.log`: before the inventory updates, `there are 42` → `got 45` and three catalogSchema inventory failures (`Tests 4 failed | 109 passed`). `swa-2.2-green.log`: wikiSuggestions, catalogSchema, catalogPolicies (`there are 45`), catalogPolicyHelpers, catalogRoles, showWiki, wikiStore pg → `Test Files 7 passed (7)`, `Tests 172 passed (172)`; isolation.int `Tests 1 passed (1)`; `test_migrate: 35 passed, 0 failed`, `rc=0`. Inventories changed: catalogSchema (table, key column, columns, keys, checks, indexes, policy names, column update grant) and catalogPolicies (42 → 45); catalogPolicyHelpers, catalogRoles and isolation.int needed no change.

## 3. Store

- [ ] 3.1 Refactor `packages/catalog/src/wikiStore.ts` so create and edit run through in-transaction steps (`createInTx`, `updateInTx`) that take an optional revision note, as design D2 describes. No behaviour change. Verified by `wikiStore.pg.test.ts` (31 tests) and `showWiki.pg.test.ts` passing unchanged, and the catalog unit suite.
- [ ] 3.2 Test first: write `server/src/test/pg/wikiSuggestionStore.pg.test.ts` for the suggestion methods on `catalog.wiki`, covering:
  - `saveRun` stores pending rows with `created_by_name`, in proposal order; "A newer run supersedes the older suggestion" for a page target and for a new-page target matched ignoring case and accents; a run with a bad link stores nothing;
  - list by status and `page_id`, newest first, with `page.state`, `stale` and the 500 cap with `truncated`;
  - "Accept writes a revision authored by the reviewer" (note `accepted suggestion <id>`, `resolved_revision`), "Edit, then accept" (note `… (edited)`), a new-page accept (note `created from suggestion <id>`, a `session` kind gets the suggestion's session);
  - "A stale accept is refused": `WikiConflictError` with the current page, the suggestion stays pending; an accept against a newer `expected_revision` than the base succeeds;
  - accept errors leave it pending: title taken, session already has a page, a merged target, a deleted target, a missing `expected_revision`;
  - "Accept twice" and dismiss-after-accept raise `WikiSuggestionResolvedError` with the status;
  - dismiss records the reviewer;
  - an ungranted member's accept and dismiss see no suggestion;
  - the read helpers: `checkLinks` gives the same answers as a manual save (a deleted or merged linked page is allowed, another show's session is not); `normalize` folds case, accents and `ß` like the unique index; `nameHolder` finds a live title or alias; `pendingFor` and the pending new-page list.
  Then implement `wikiSuggestionStore.ts`. Verified by the tests and the catalog unit suite.

## 4. Contract and AI turn

- [ ] 4.1 Test first: add the suggestion schemas and `wikiProposalSchema` to `packages/contract/src/schemas.ts`, with `schemas.wikiSuggestion.test.ts` covering strict responses, every page limit (title, alias length and count, control characters and NUL), the 30,000-character proposal body, the rationale, and `expected_revision` as a positive integer. Then implement. Verified by the tests.
- [ ] 4.2 Test first: add `citationsOf` to `packages/contract/src/wikiLinks.test.ts`, covering inline, angle-bracket and autolinked `cite:` links; full, collapsed and shortcut references to a `cite:` definition, with case-insensitive labels ("A reference-style citation is checked by its text"); unused definitions yield nothing; references to non-`cite:` definitions are ignored; the rendered text of a label with emphasis, code and escapes. Then implement. Verified by the tests.
- [ ] 4.3 Test first: write `packages/ai-runtime/src/wikiTools.test.ts` for the three new tool builders over a fake `WikiToolPort`, covering:
  - `list_wiki_pages`: at most 200 lines and 40,000 characters per call (an adversarial fixture of 50 maximal aliases per page), the pending flag and the pending new-page lines, and the marker line;
  - `read_wiki_page`: a live page with its pending suggestion ("A pending suggestion is carried forward"), a pending new-page suggestion by `suggestion_id`, "Page not found." for a missing, deleted or other-show page, the merged notice, a body cut at 30,000 characters and marked, and both or neither id refused;
  - `propose_page`: each check in design D4 with its error line, including "A misquote is sent back to the model", "A reference-style citation is checked by its text", "Kept citations aren't re-checked", "A new citation of another session is refused", and a target page over 30,000 characters; a new page whose title matches a live alias names that page; `session` kind only for the run's session with no page, and with no aliases; "No change."; a later proposal for a target replaces the earlier one (also when the titles differ only in case and accents); the 21st target is refused;
  - the quote match: "Accents, case and punctuation don't matter"; the first word at exactly t−30 and t+30 passes and at t−31 and t+31 fails; drop-frame `HH:MM:SS;FF` timecodes; a word with an empty timecode uses `start_sec`; a word holding two tokens (`rock'n'roll`); a non-contiguous quote fails; an empty quote and one over 60 tokens fail; more than 200 checked citations is refused;
  - a thrown port error returns "Tool failed.".
  Then implement `wikiTools.ts` and the `TOOL_BUILDERS` entries. In `sdkTurn.ts`, add `'wiki'` and its tool set (D7 category 2). Verified by the tests, the ai-runtime suite and `sdkSafety.repo.test.ts`.
- [ ] 4.4 Test first: write `packages/ai-runtime/src/wikiGenerate.test.ts`:
  - with the fake LLM on the AI SDK route: a run that pages the transcript and proposes two pages returns both proposals, `ok` and full coverage; a capped run and a provider error return not-ok;
  - "A realistic run fits the bounds": a four-page transcript, 20 reads and 20 proposals finish within the default wiki step cap;
  - the wiki turn's 300-call hard cap ends the run as failed;
  - with the fake CLI: the allowlist is exactly the four wiki tools, and `--max-budget-usd` and the timeout come from the options; a chat turn's MCP server doesn't register the wiki tools, so a call to one runs nothing ("Chat turns cannot use the wiki tools");
  - the system prompt names transcript, titles, aliases, bodies and suggestion text as untrusted data, and states the timecode-to-seconds rule.
  Then implement `wikiGenerate.ts`. Verified by the tests.

## 5. API

- [ ] 5.1 Test first: write `server/src/routers/wikiSuggestions.int.test.ts`, covering every endpoint in the api-contract-freeze delta:
  - `wiki/generate`: the full order of checks (404 masked, including a session with no show; the language-model 503; 403; the no-transcript 400; the busy 409 against a held slot); "Update wiki returns the stored suggestions" on the AI SDK route with the fake LLM, and on the CLI route with the fake CLI; "A provider failure after proposals stores nothing"; "An unread transcript page fails the run"; "A failed store stores nothing" (a forced `saveRun` failure); a timed-out run whose `propose_page` body is still running stores nothing and releases the slot only after it finished; a misquote retried by the model ends with only the corrected proposal stored; a model that tries `read_wiki_page` on another show's page gets "Page not found."; a run that supersedes an older pending suggestion;
  - list, read, accept (200 and 201), dismiss: shapes; 401; masked 404s for an ungranted member, an outsider and a nonexistent id; each 409 body; each 422;
  - no `Set-Cookie` on any of them.
  Then implement `server/src/routers/wikiSuggestions.ts` and `_wikiToolPort.ts`, and mount the router. Wire the four env vars (`WIKI_GENERATE_TIMEOUT_SEC`, `WIKI_GENERATE_MAX_BUDGET_USD`, `WIKI_GENERATE_MAX_STEPS`, `WIKI_GENERATE_MAX_TOKENS`) through `packages/ports/src/config.ts`, `server/src/node/config.ts`, the accessors and `wikiSdkLimits` in `server/src/env.ts` with `env.test.ts`, `docker/secrets-env.yaml` and `server/.env.example`, updating `upgradeDispatch.test.ts`'s full `Config` (D7 category 6). Verified by the tests, server unit, typecheck, and the vars reaching the dev container (`docker exec … printenv WIKI_GENERATE_TIMEOUT_SEC` after setting it).
- [ ] 5.2 Capture the fixtures (`fixtures/api-responses/wikiSuggestion*.ts`) in `apiResponseFixtures.int.test.ts` (D7 category 3), including the conflict branch of accept. Add the README endpoint rows and router-tree line, and document the two env vars where the other AI env vars are documented. Verified by `npm run fixtures:capture -w server` and the fixtures test.

## 6. Web

- [ ] 6.1 Move `lineDiff` and `RevisionDiff` from `WikiHistorySheet.tsx` to `wiki/wikiDiff.tsx` (D7 category 5). Verified by the existing `WikiHistorySheet` tests passing with no assertion changed.
- [ ] 6.2 Test first: write `useWikiSuggestions.test.tsx` for the hooks and the new `wikiKeys` entries, covering queries, invalidations after accept, dismiss and generate, and a `409` surfacing as a version conflict. Register the keys in `queryKeyFactories.repo.test.ts`, and add the types to `api/types.ts` with conformance checks (D7 category 3). Then implement. Verified by the tests and the repo tests.
- [ ] 6.3 Test first: write `UpdateWikiButton.test.tsx` ("Update wiki from the session page": the pending label and disabled state, the success toast with the count and the link, the empty result, the 503 message, another error's detail), and add it to the workspace feed-tab row immediately before "Wiki page", which stays last (D7 category 4). Then implement. Verified by the tests.
- [ ] 6.4 Test first: write `WikiSuggestionSheet.test.tsx` and extend the `WikiRoute` and `WikiPageView` tests (D7 category 4), covering:
  - the Suggestions tab with its count, grouping, "New page · kind", the Stale badge, and `?tab=suggestions` opening it;
  - the page banner;
  - the diff against the current revision, a new page diffed against empty, and "Review a stale suggestion" saying the page changed;
  - Accept sends the revision the diff was drawn against; Edit then accept sends the overrides, and for a new page opens the editor with the kind fixed; Dismiss;
  - a 409 conflict refetches and redraws, keeping edited text;
  - the rationale, title and aliases render as text (a `<script>` title shows literally).
  Then implement. Verified by the tests, the full web suite and typecheck.
- [ ] 6.5 Manual check in the dev stack (`make dev-up`) with the dev SGLang credential, using agent-browser at 1280px and 390px: run "Update wiki" on a QA session; review and accept a suggestion and see the `accepted suggestion …` revision authored by the reviewer; edit a page, then accept its now-stale suggestion; dismiss one; an ungranted member gets the masked 404 on the list. Verified by the screenshots and notes in the log.

## 7. Docs and verification

- [ ] 7.1 Write ADR `docs/decisions/0031-show-wiki-ai.md`: the injected caller-bound catalog port, the quote check and why it rejects rather than strips, store-only-on-success, the reviewer authoring the revision, and the accepted busy-detail gap. Verified by the file existing, with a `Rule:` line naming the specs and tests it backs, as ADR 0030 does.
- [ ] 7.2 Run `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook` and `openspec validate --all --strict`, then the `consistency-read` skill, appending its result to `panel.md`. Verified by the green run and the appended section.
- [ ] 7.3 Open the PR, and confirm CI is green on it. Verified by the PR's check status.
