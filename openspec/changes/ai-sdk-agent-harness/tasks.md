# Tasks

**Branch and commits**
- The first commit on `ai-sdk-agent-harness` holds only `openspec/changes/ai-sdk-agent-harness/`.
- The PR targets `supabase-migration`.
- The gates run with `GITHUB_BASE_REF=supabase-migration`.

**Logs and test-first**
- Logs live under the session scratchpad as `sdk-<task>-<red|green>.log`, and each `Evidence:`
  line names its log.
- Each "test first" item is red before its change, or records why it already passes.
- Each task's text and its `Evidence:` stay in one block with no blank line.

**Commands**
- Targeted server tests: `cd server && npx vitest run --project <unit|integration|pg> <files>`.
- Packages: `npx vitest run` in `packages/{ports,contract,ai-runtime}`;
  `cd packages/storage && npx vitest run --project <unit|pg> <files>`.
- Web: `cd web && npx vitest run`.
- `npm run typecheck`.
- Migrations: `sh docker/supabase/test_migrate.sh`.
- The full pg and integration suites run in CI on the PR (ADR 0026). Locally, run only the
  targeted tests, the unit suites and typecheck.

**Changing tests.** Changing an existing test is allowed only for the categories in design D9.
Anything else is a stop: update the artifacts and ask the owner.

## 1. Baselines

- [x] 1.1 On the base, run the unit suites (server, packages, web) and typecheck, and record the
  counts. Then list every existing test design D9 may touch, using
  `grep -rln "CLAUDE_CLI_PATH\|aiChatConfigured\|not configured on this deployment\|claude_session_id\|no integration configured\|key_last4\|run_features_allowed\|LLM_PROVIDERS\|TOOL_BUILDERS" --include=*.test.ts --include=*.test.tsx --include=*.mjs server/src packages web/src docker/scripts`,
  and classify each hit by D9 category or as unchanged. Verified by the recorded counts and the
  classified list.
  - Evidence: base `66f2aba0`. `cd server && npx vitest run --project unit` -> `Tests  442 passed | 3 skipped (445)`; `npx vitest run` in ports -> `Tests  1 passed (1)`, contract -> `Tests  125 passed (125)`, transcription -> `Tests  71 passed (71)`, catalog -> `Tests  51 passed (51)`, ai-runtime -> `Tests  199 passed (199)`, session-core -> `Tests  55 passed (55)`, media-import -> `Tests  31 passed | 2 skipped (33)`, log-import -> `Tests  41 passed (41)`, domain -> `Tests  50 passed (50)`; `cd packages/storage && npx vitest run --project unit` -> `Tests  68 passed (68)`; `cd web && npx vitest run` -> `Tests  1920 passed (1920)`; `npm run typecheck` -> exit 0, 0 `error TS` (log `sdk-1.1-baseline.log`). DB baseline: the last full CI run on `supabase-migration` (PR #106).
  - Evidence: the grep matches 27 files (log `sdk-1.1-grep.log`).
    - Category 1: `routers/ai.int.test.ts`, `routers/transcribe.int.test.ts`, `routers/events.generate.int.test.ts`, `routers/access.int.test.ts:150`, `routers/compression.int.test.ts:371`, `routers/sessionHub.interleave.int.test.ts:84`, `routers/aiV2.int.test.ts:458,493` (shared slot only), `test/topicGenerate.real.test.ts`, `test/eventGenerate.real.test.ts` (each sets `CLAUDE_CLI_PATH`).
    - Category 2: the route 503 cases in `ai.int`, `transcribe.int` and `events.generate.int`; `aiV2.int.test.ts:267-274` (asserts `/AI chat is not configured/` with `CLAUDE_CLI_PATH: ''`); `AiChat.test.tsx`, `generateLatch.test.tsx`, `eventGenerateLatch.test.tsx`.
    - Category 3: `generateLatch.test.tsx`, `eventGenerateLatch.test.tsx`.
    - Category 4: `packages/contract/src/schemas.zod4.test.ts`; `packages/ai-runtime/src/aiChatRelay.test.ts` only where it asserts the `done` payload type (its CLI ids such as `'s1'` stay).
    - Category 5: `packages/contract/src/schemas.providers.test.ts`, `routers/providers.int.test.ts`, `web/src/api/types.conformance.test.ts`, `web/src/apiResponseShapes.repo.test.ts`.
    - Category 6: `test/pg/catalogSchema.pg.test.ts`, `test/pg/providerTables.pg.test.ts`.
    - Category 7: `settings/AdvancedSection.test.tsx` (`key_last4`, `run_features_allowed` fixtures and the four-option list).
    - Category 8: none in the grep; `grep -rln "ProviderCredentialStore\|updateKeepingKey" --include=*.ts server/src packages` finds no in-memory fake (tests use `PostgresProviderCredentialStore`), so only the port's consumers change.
    - Unchanged: `routers/logImport.int.test.ts:24` (the Sheets "not configured on this deployment" string); `upgradeDispatch.test.ts:39` (a complete `Config` literal; the new fields are optional); `test/session/aiMcpServer.int.test.ts:1311` (a source slice keyed on `create_event: (server, {...}) => {` and the `TOOL_BUILDERS` close; 6.2 must keep both texts, typing via the builders' type, not the arrow's parameters); `packages/ai-runtime/src/aiChatRunner.test.ts` and `fixtures/fake-claude.mjs` (the CLI runner and its fixture stay); `AiV2Design.test.tsx:692` (the AI v2 copy, not chat, topics or events).

## 2. Keyless `claude-cli` row (design D2)

- [x] 2.1 Test first, in `providerTables.pg.test.ts` and `catalogSchema.pg.test.ts` (D9
  category 6):
  - a `claude-cli` `llm` row with all five key columns null is accepted;
  - a keyless row for any other provider gets `23514`, and so does a keyed row with any one of
    the five key columns null (the partial-null case);
  - a `claude-cli` row with a key, a `base_url` or kind `stt` gets `23514`;
  - existing keyed rows are unaffected.
  Red, then add `supabase/migrations/20261018000000_claude_cli_provider.sql`, with the rollback
  in its header. Green, plus `sh docker/supabase/test_migrate.sh`.
  - Evidence: red, before the migration: `cd server && npx vitest run --project pg src/test/pg/providerTables.pg.test.ts src/test/pg/catalogSchema.pg.test.ts` -> `× accepts a keyless claude-cli llm row and refuses keyless, partly keyed or keyed-cli rows (ai-sdk 2.1)` (`expected '23502' to be 'ok'`), `× matches the recorded catalog schema`, `× relaxes the key columns, adds the claude_cli check, and changes no existing keyed row` (`ENOENT … 20261018000000_claude_cli_provider.sql`), `Tests  3 failed | 32 passed (35)` (log `sdk-2.1-red.log`). Green, the same two files -> `Test Files  2 passed (2)`, `Tests  35 passed (35)` (log `sdk-2.1-green.log`); `sh docker/supabase/test_migrate.sh` -> `test_migrate: 35 passed, 0 failed` (log `sdk-2.1-migrate.log`); `catalogPolicies.pg.test.ts` unchanged -> `Tests  35 passed (35)`; `npm run typecheck` -> exit 0, 0 `error TS`.
  - Evidence: the new `providerTables.pg` case covers a keyless `claude-cli` `llm` row accepted (all five key columns read back null); `23514` for a keyless `anthropic`, `openai`, `google`, `openai-compatible` and `deepgram` row, for an `anthropic` row with each one of the five key columns null in turn (the partial-null case), and for a `claude-cli` row with a full key, with only `key_last4`, with a base URL, or of kind `stt`; keyed `llm` and `stt` rows still insert. The new `catalogSchema.pg` case replays the migrations up to `20261017000000`, inserts keyed `llm` and `stt` rows, runs the new migration, and finds both rows unchanged (`row_to_json`), the five columns nullable and the check present. D9 category 6: the recorded schema's five key columns lose `not null` and `$checks` gains `user_provider_credentials_claude_cli_check`. The migration header carries the rollback (delete the `claude-cli` rows, drop the check, restore `not null`).
- [x] 2.2 Test first, in the storage pg tests for `ProviderCredentialStore`:
  - `putKeyless` stores and replaces the `llm` row;
  - `get`/`list` return `key: null` for it;
  - `updateKeepingKey` refuses to keep a key across a switch from `claude-cli`.
  Then the port and the store change, with the in-memory fakes updated (D9 category 8). Green,
  plus typecheck.
  - Evidence: red, three new cases in `packages/storage/src/providerCredentials.pg.test.ts`: `cd packages/storage && npx vitest run --project pg src/providerCredentials.pg.test.ts` -> `× putKeyless stores and replaces the llm row with no key, keeping its creation time (ai-sdk 2.2)`, `× get and list return key null for the claude-cli row (ai-sdk 2.2)`, `× updateKeepingKey never keeps a key across a switch from claude-cli, nor on the keyless row (ai-sdk 2.2)`, `TypeError: store.putKeyless is not a function`, `Tests  3 failed | 11 passed (14)` (log `sdk-2.2-red.log`). Green, the same file -> `Tests  14 passed (14)` (log `sdk-2.2-green.log`); storage unit -> `Tests  68 passed (68)`; `cd server && npx vitest run --project integration src/routers/providers.int.test.ts` -> `Tests  15 passed (15)` (log `sdk-2.2-providers-int.log`); `npm run typecheck` -> exit 0, 0 `error TS` (log `sdk-2.2-tc.log`).
  - Evidence: the port (`packages/ports/src/providerCredentials.ts`) adds `CLAUDE_CLI_PROVIDER`, `putKeyless(userId, 'llm', 'claude-cli')`, `key: StoredProviderKey | null` on `get`/`list` rows, and `KeyedProviderCredentialRow` as the result of `put` and `updateKeepingKey`. The store's `updateKeepingKey` adds `AND key_ciphertext IS NOT NULL`, so a keyless row never matches. A switch to another provider already failed on the provider predicate; the `claude-cli`-to-`claude-cli` case is what the predicate adds. Consumers: `resolveSttCredential` treats a null key as no credential; the providers router's `toWire` gives `key_last4: null`, and its test answers the existing `unreadable` result for a keyless row. That is a minimal guard; the `claude-cli` route and test behaviour are task 3.2. D9 category 8: there are no in-memory fakes. The storage pg test narrows `key!` at four reads of rows it saved with a key (`:87`, `:100`, `:102`, `:150`); its assertions are unchanged.

## 3. Contract, config and provider routes (design D2, D6)

- [ ] 3.1 Test first, in `packages/contract` schema tests (D9 categories 4 and 5):
  - `providerPutBodySchema('llm')` accepts `{provider:"claude-cli"}`, and refuses it with
    `api_key`, `base_url` or `model`;
  - the credential wire shape allows `key_last4: null`;
  - `GET` carries `claude_cli_allowed`;
  - the `chatRequestSchema` `history` bounds: 40 entries, the two roles, 1–8000 characters each,
    64 000 in total;
  - the `done` payload allows `claude_session_id: null`, and the request accepts
    `claude_session_id: null` as absent.

  Then the schemas change. Green.
- [ ] 3.2 Test first, in `providers.int.test.ts` and `server/src/env.test.ts`:
  - an allowlisted caller saves `claude-cli`: `200`, `key_last4: null`, `model: "claude-cli"`;
  - a caller who isn't allowlisted gets `403` with the fixed detail and nothing stored, and so
    does anyone when `CLAUDE_CLI_PATH` is blank;
  - switching to `anthropic` without a key gets `422`;
  - `GET` reports `claude_cli_allowed` for each caller;
  - the `claude-cli` test answers `Connected.` or `The Claude CLI isn't available to this
    account.`, with no outbound request, and counts toward the rate window;
  - `claudeCliAllowed` matching: trimming, ASCII case, a non-ASCII email, and the bootstrap
    owner not implicitly listed.

  Then the router, `claudeCliAllowed`, and the optional `Config` fields (`CLAUDE_CLI_EMAILS`, the
  step and token caps). Green.
- [ ] 3.3 Recapture the provider fixtures with `UPDATE_API_FIXTURES=1`, and update
  `web/src/api/types.ts` (D9 category 5). Verified by `apiResponseShapes.repo.test.ts` and
  `types.conformance.test.ts` green.

## 4. Route resolution (design D1)

- [ ] 4.1 Test first, in a new `server/src/auth/providerResolve.test.ts`. `resolveLlmRoute` gives:
  - **CLI** for a `claude-cli` row when the caller is allowlisted and `CLAUDE_CLI_PATH` is set;
  - **null** for that row after the email is removed, or with `CLAUDE_CLI_PATH` blank;
  - **SDK** with the decrypted key for each key provider;
  - **null** for an undecryptable row;
  - **null** for a caller with no row, allowlisted or not, in development and production mode
    alike (no fallback).

  Then the resolver. Green.

## 5. Guarded model requests (design D4, D5)

- [ ] 5.1 Test first, in a new `server/src/auth/guardedFetch.test.ts`, against a local fake
  upstream and a stub resolver:
  - fixed-host providers reach only `PROVIDER_HOSTS[provider]` on their path pattern with the
    credential's model as one segment, and `openai-compatible` only `<saved origin><base
    path>/chat/completions`; any other URL is refused without a connection, as are encoded
    slashes, `..`, a doubled `/`, and a model id containing `/` or `..`;
  - in production mode a hostname resolving to `169.254.169.254`, or re-resolving there after a
    public answer, is refused; the connection uses the checked address;
  - a `302` is returned unfollowed even though the caller set no `redirect`;
  - the 120 s header timeout fires only before headers arrive, and a slow stream after them is
    not cut;
  - the caps refuse past 60 requests, a 4 MB request body or 48 MB of request bodies per turn,
    with a classified failure and no connection; past 64 MB of responses the stream is aborted;
  - per-step byte counts are reported for the usage estimate;
  - the body streams through unbuffered past 1 MB;
  - an abort closes the upstream socket;
  - captured stdout and stderr hold no key, header or body.

  Then the guarded `fetch` in `providerOutbound.ts`. Green.
- [ ] 5.2 Add a repo test, `packages/ai-runtime/src/sdkSafety.repo.test.ts`, red against a
  planted violation and then green. It fails when production sources in `ai-runtime` or the AI
  routers:
  - pass a string as a model to `streamText` or `generateText`;
  - import `@ai-sdk/gateway`;
  - pass an AI SDK error or a caught error from a turn to `console.*` or the server logger;
  - call `streamText` without `onError`.
- [ ] 5.3 Test first, in the `redactDatabaseError` / `app.ts` error-handler test (D5, D9
  category 9): an `APICallError`, or any error carrying `requestBodyValues` or `responseBody`,
  thrown from a route is logged as its class name only, and the captured stderr holds none of a
  planted prompt marker. Other errors log as before. Then the redaction rule. Green.

## 6. AI SDK turn (design D3, D5, D6)

- [ ] 6.1 Add the pinned dependencies to `packages/ai-runtime/package.json` (design D7). Verified
  by `npm ls ai @ai-sdk/anthropic @ai-sdk/openai @ai-sdk/google @ai-sdk/openai-compatible zod`
  showing the exact versions and one `zod`, and by the package-architecture boundary and
  duplicate tests green.
- [ ] 6.2 Type the builders' `server.tool(...)` parameter as the `ToolSink` interface, and add
  `registerSdkTurn` (D3). Verified by typecheck, and by the existing `aiMcpServer.int.test.ts`,
  `mcpTools.int.test.ts` and `aiMcpGenerationRendering.test.ts` green and unchanged.
- [ ] 6.3 Test first, in a new `packages/ai-runtime/src/sdkTurn.test.ts`, against a fake
  OpenAI-compatible server (the model is built by the real factory with our `fetch`):
  - **Deps:** construction throws with no `fetch`, a non-function `fetch`, or an empty or
    non-string `apiKey`, so there is no fallback to `globalThis.fetch` or to environment keys.
  - **Tools:**
    - each turn kind gets exactly its tool set, and a call runs the shared body on the
      registration's session;
    - a `create_topic` validation failure returns the body's tool error and the turn continues;
      a thrown body error returns "Tool failed.", never its message;
    - the 17th call in one step gets the "too many tool calls" tool error and the turn
      continues;
    - more calls than the per-turn cap set the breach flag and end the turn as a breach, with
      nothing past the cap run;
    - parallel calls run one at a time;
    - a call arriving after abort runs nothing;
    - the drain set holds every in-flight body, and the turn exposes it for the route to await.
  - **Mapping:**
    - `text-delta` becomes `delta`, and `finish` becomes `done` with `claude_session_id: null`;
    - `tool-call` becomes `tool {name}` only for valid names in the set; an undefined tool's
      call, with the model's own name, is not relayed;
    - reasoning parts are not relayed, including inline `<think>…</think>` from an
      OpenAI-compatible server, split across chunks.
  - **Endings** (design D3 table, against a fake server):
    - the step cap or token budget ends a generation turn as capped (failure), and a chat turn
      `done`;
    - tool calls reported with `finish_reason: "stop"` that hit the step cap still count as
      capped;
    - `length` with an unexecuted call is incomplete (generation failure);
    - `tool_calls` with no calls on the last step is natural;
    - a breach is reported as a breach, not a client abort, and a chat breach ends with exactly
      one `error` event;
    - after an abort or an error, no unhandled rejection occurs (`process.on('unhandledRejection')`
      spy) and no result promise is awaited;
    - no `AISDKError` leaves `sdkTurn`: callers only ever see `SdkTurnFailure`.
  - **Errors:** an `APICallError` (`500`, and `401` with a body), a `RetryError` and a mid-stream
    drop (`fullStream` throws) each become `upstream-failed`. Their `requestBodyValues`,
    `responseBody` and message appear in no event and no captured output.
  - **Bounds:**
    - an endless tool loop stops at the step cap;
    - the token budget stops a loop whose fake usage passes it, and also one whose provider
      reports no usage (through the byte estimate);
    - `maxRetries: 2` gives at most 3 requests for a `500`;
    - `maxOutputTokens: 4000` reaches the request;
    - OpenAI requests carry `store: false`.
  - **Ending:** the timeout and the abort both end the turn with one ending event, close the
    upstream socket, and release the registration.
  - **History:** history entries reach the provider as `user`/`assistant` messages in order,
    followed by the new message.

  Then `sdkTurn.ts`, `sdkTools.ts`, `sdkRelay.ts` and `driveAiTurn`'s strategy selection. Green.
- [ ] 6.4 Test first, in `sdkTurn.test.ts`: each of `anthropic`, `openai`, `google` and
  `openai-compatible` builds a model through its factory with `apiKey` and our `fetch`, and its
  first request reaches the expected fixed host or saved origin (the guarded fetch's destination
  check, with a stub transport). Then the factory table. Green.

## 7. AI routes on the caller's route (design D1, D3, D6)

The integration tests point SDK routes at a local fake provider through a dev-mode
`openai-compatible` credential on `http://127.0.0.1`, which development mode allows.

- [ ] 7.1 Test first, in `ai.int.test.ts` (D9 categories 1, 2 and 4, plus new cases):
  - **No route:** `503` with the new detail, and no spawn or model request.
  - **SDK route:**
    - streams `delta`/`tool`/`done` with `claude_session_id: null`;
    - sends the history as messages;
    - ignores a stale `claude_session_id`;
    - a provider error gives one scrubbed `error` event.
  - **CLI route:** through a saved `claude-cli` row and the allowlist (the production path),
    otherwise unchanged, with resume and the `422` cases. The same caller after removal from
    `CLAUDE_CLI_EMAILS` gets the `503`.
  - **Order and limits:** a `history` violation gives `422` before any model request; the
    `403`/`409` order is unchanged.
  - **Nothing survives:** after a done, an error, a breach, a timeout and a client abort, a query
    over the catalog tables and `DATA_DIR` finds no row or file holding a planted marker from the
    message, history or reply.

  Then `ai.ts`. Green.
- [ ] 7.2 Test first, in `transcribe.int.test.ts` (topics) and `events.generate.int.test.ts`
  (D9 categories 1 and 2):
  - with no route, the new `503` details and no model request;
  - on the SDK route, the fake model creates topics or events through the tools, and the results
    and replace-all match the CLI path;
  - a provider error maps to the existing `502`, with prior topics unchanged;
  - a run stopped by the step cap or token budget maps to the `502`, with prior topics unchanged
    and no regenerate delete;
  - a slow tool body still running at the route timeout finishes before the route removes the
    run's new topics, or releases the slot and lease (no stray topic after the cleanup);
  - an event `regenerate` on the SDK route deletes the prior auto-generated events exactly as on
    the CLI route, and a failed run deletes nothing;
  - the generation step cap and token budget apply.

  Then the routes. Green.
- [ ] 7.3 Update the README's AI chat, topic and event sections, and the endpoint table rows for
  `GET /api/me/providers`, `PUT /api/me/providers/:kind`, `POST …/ai/chat`,
  `POST …/topics/generate` and `POST …/events/generate`. Cover:
  - per-route egress and spend bounds;
  - for OpenAI-compatible servers, enable the server's reasoning parser (the `<think>` scope in
    design D3);
  - `CLAUDE_CLI_EMAILS` and the step and token caps;
  - the `claude-cli` provider and its `403`, `claude_cli_allowed`, `history`, `done` with a null
    id, and the three new `503` details.

  Add the variables to `server/.env.example`, with no email values. Verified by an excerpt of each
  named README row in the evidence, and
  `grep -c "CLAUDE_CLI_EMAILS\|AI_CHAT_MAX_STEPS\|AI_CHAT_MAX_TOKENS\|GENERATE_MAX_STEPS\|GENERATE_MAX_TOKENS" server/.env.example` = 5.

## 8. Web (design D8)

- [ ] 8.1 Test first, in `AdvancedSection.test.tsx` (D9 category 7, plus new cases):
  - the CLI option appears only when `claude_cli_allowed`, or when it is the saved choice;
  - selecting it hides Base URL, Model and API key and shows the help line;
  - saving sends `{provider:"claude-cli"}`;
  - the saved state shows Connected with no key row.

  Then the section. Green.
- [ ] 8.2 Test first, in `AiChat.test.tsx`, `generateLatch.test.tsx` and
  `eventGenerateLatch.test.tsx` (D9 categories 2 and 3):
  - the new not-configured copy points to Settings → Advanced;
  - saving an `llm` credential clears the chat state and both latches without a reload;
  - chat posts `history` from its display messages, excluding error rows, tool chips and the
    in-flight reply, trimmed to the bounds.

  Then the components and hooks. Green, plus `cd web && npx vitest run`.
- [ ] 8.3 Visual check with agent-browser on the dev stack at 1440 and 390 px:
  - the Advanced picker with the CLI option, as an allowlisted user;
  - the chat not-configured state.

  Verified by screenshots under the scratchpad, with the findings fixed.

## 9. Secrets, docs and integration checks

- [ ] 9.1 Test first, in `docker/scripts/compose-run.test.mjs`: `CLAUDE_CLI_EMAILS`,
  `AI_CHAT_MAX_STEPS`, `AI_CHAT_MAX_TOKENS`, `GENERATE_MAX_STEPS` and `GENERATE_MAX_TOKENS` are
  accepted from the OpenBao secret. Then `docker/secrets-env.yaml`, `docker/.env.example` and
  `docs/openbao-secrets.md`. Green.
- [ ] 9.2 Write `docs/decisions/0028-ai-sdk-agent-harness.md`. It covers:
  - the in-process AI SDK harness;
  - the guarded fetch;
  - the CLI allowlist;
  - error scrubbing;
  - the OpenCode alternative and why it was dropped (panel.md).

  Update `docs/security.md` with the threat model: prompt injection limited to the turn's tools,
  the key only in provider request headers, scrubbed errors, and no deployment-wide ceiling.
  Verified by the ADR having the same sections as ADR 0027, and by `grep -n "0028"
  docs/security.md` matching.
- [ ] 9.3 Run the opt-in real test `server/src/test/aiSdk.real.test.ts` with
  `REAL_LLM_ANTHROPIC_KEY`. It is skipped without the variable. It checks:
  - a chat turn calls `get_transcript_words` and answers;
  - one topic generation creates at least one topic;
  - the token usage stays under the budget.

  Verified by the run's output (the key never printed), and by the test skipping in CI.
- [ ] 9.4 Run a dev-stack check (`make dev-up`, with `CLAUDE_CLI_EMAILS` set in dev OpenBao):
  - chat, topics and events on SGLang;
  - the same on Anthropic;
  - the CLI on the owner's account, with resume across turns;
  - a non-allowlisted account doesn't see the option, and its PUT gets `403`;
  - removing the credential gives the `503` copy, and saving one clears it without a reload;
  - the server log holds no prompt, transcript or key during a failing turn.

  Record the turn times and token usage.
- [ ] 9.5 At archive, after the spec sync:
  - rewrite the Purpose of `ai-topics-chat` and `topic-generation`, which are no longer
    `CLAUDE_CLI_PATH`-gated or CLI-only;
  - retitle the scenarios "Unconfigured deployment is unchanged" (topic-generation) and
    "Unconfigured deployments are byte-for-byte unchanged" (api-contract-freeze) to match their
    new bodies.

  Delta specs can't change either. Verified by
  `grep -n "CLAUDE_CLI_PATH-gated\|byte-for-byte unchanged" openspec/specs/{ai-topics-chat,topic-generation,api-contract-freeze}/spec.md`
  finding nothing.
- [ ] 9.6 Run `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook`, then the
  consistency read, then CI green on the PR.
