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
  - Evidence: correction. The first 2.2 commit exported a runtime `CLAUDE_CLI_PROVIDER` from `@autologger/ports`, which broke `packages/ports/src/index.test.ts` ("the package barrel exports no runtime values"). The port now exports only the `ClaudeCliProvider` type, and the store keeps its own constant. `cd packages/ports && npx vitest run` -> `Tests  1 passed (1)`; the storage pg file -> `Tests  14 passed (14)` (log `sdk-2.2-green.log`); `npm run typecheck` -> exit 0.

## 3. Contract, config and provider routes (design D2, D6)

- [x] 3.1 Test first, in `packages/contract` schema tests (D9 categories 4 and 5):
  - `providerPutBodySchema('llm')` accepts `{provider:"claude-cli"}`, and refuses it with
    `api_key`, `base_url` or `model`;
  - the credential wire shape allows `key_last4: null`;
  - `GET` carries `claude_cli_allowed`;
  - the `chatRequestSchema` `history` bounds: 40 entries, the two roles, 1–8000 characters each,
    64 000 in total;
  - the `done` payload allows `claude_session_id: null`, and the request accepts
    `claude_session_id: null` as absent.
  Then the schemas change. Green.
  - Evidence: red, a new `packages/contract/src/schemas.chat.test.ts` and new cases in `schemas.providers.test.ts`: `cd packages/contract && npx vitest run` -> `× bounds are 40 entries and 64 000 characters`, `× accepts 40 entries totalling 64 000 characters, and refuses a 41st entry`, `× refuses more than 64 000 characters in total, counted after trimming`, `× allows only the user and assistant roles`, `× accepts null as absent`, `× carries a non-empty CLI session id, or null on an AI SDK turn`, `× llm accepts exactly {provider: "claude-cli"}`, `× a credential may have key_last4 null (the keyless claude-cli row)`, `× the list is llm, stt, run_features_allowed and claude_cli_allowed, each credential nullable`, `Tests  12 failed | 127 passed (139)` (log `sdk-3.1-red.log`). Already passing, as expected: the claude-cli refusals with `api_key`, `base_url` or `model` and as `stt` (an unknown provider was already refused), and a non-empty `claude_session_id` still accepted. Green -> `Test Files  6 passed (6)`, `Tests  139 passed (139)` (log `sdk-3.1-green.log`).
  - Evidence: `schemas.ts` adds `CHAT_HISTORY_MAX_ENTRIES` (40), `CHAT_HISTORY_MAX_CHARS` (64 000), `chatHistoryEntrySchema` (`user`/`assistant`, text trimmed 1-8000), `history` on `chatRequestSchema` with the total refined after trimming, `claude_session_id` nullish and mapped to `undefined`, `chatDoneEventSchema` (`claude_session_id: string(min 1) | null`, strict), `CLAUDE_CLI_PROVIDER`, the `claude-cli` variant of the `llm` PUT body (a strict object whose `base_url`, `model` and `api_key` are typed as always absent, so any of them, `null` included, is refused), `key_last4` nullable, `claude_cli_allowed` on the list, and `PROVIDER_TEST_DETAIL.claudeCliUnavailable`. D9 category 5: the existing list case in `schemas.providers.test.ts` now includes `claude_cli_allowed`, and a list without it is refused. The `zod4` stripping and transform cases for `chatRequestSchema` are unchanged and green.
- [x] 3.2 Test first, in `providers.int.test.ts` and `server/src/env.test.ts`:
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
  - Evidence: red: `cd server && npx vitest run --project unit src/env.test.ts` -> `TypeError: claudeCliAllowed is not a function`, `Tests  4 failed | 32 passed (36)`; `npx vitest run --project integration src/routers/providers.int.test.ts` -> `× an allowlisted caller saves it keyless, and GET reports claude_cli_allowed`, `× a caller who is not listed, the bootstrap owner, and anyone while CLAUDE_CLI_PATH is blank get 403 and nothing is stored`, `× switching from claude-cli to a key provider without a key gets 422 and changes nothing; with a key it saves`, `× the test answers Connected or unavailable with no outbound request, and counts toward the window`, plus three existing cases that parse `GET` with the 3.1 schema, `Tests  7 failed | 13 passed (20)` (log `sdk-3.2-red.log`). The 422 case for `claude-cli` with a key, base URL or model already passed through the 3.1 schema. Green -> `Tests  36 passed (36)` and `Tests  20 passed (20)` (log `sdk-3.2-green.log`); `npm run typecheck` -> exit 0.
  - Evidence: `env.ts` adds `claudeCliAllowed(env, user)`: false unless `CLAUDE_CLI_PATH` is set, then each comma-separated `CLAUDE_CLI_EMAILS` entry through `bootstrapEmailMatch(...) === true`, with no implicit bootstrap owner. `Config` gains the optional `CLAUDE_CLI_EMAILS`, `AI_CHAT_MAX_STEPS`, `AI_CHAT_MAX_TOKENS`, `GENERATE_MAX_STEPS` and `GENERATE_MAX_TOKENS`, read in `node/config.ts`; the two complete `Config` literals are unchanged. The router: `GET` adds `claude_cli_allowed`; a `claude-cli` `PUT` that passes the schema answers `403 {"detail": "The Claude CLI is limited to approved operator accounts."}` unless allowed, else `putKeyless`, with the audit line; the test takes its slot first, then for the keyless row answers `Connected.` or `The Claude CLI isn't available to this account.` with no outbound request. Switching to a key provider without a key keeps the existing `422` (the keep-key update never matches a keyless row). D9 category 5: the existing `GET` assertion in `providers.int.test.ts` gains `claude_cli_allowed: false`.
- [x] 3.3 Recapture the provider fixtures with `UPDATE_API_FIXTURES=1`, and update
  `web/src/api/types.ts` (D9 category 5). Verified by `apiResponseShapes.repo.test.ts` and
  `types.conformance.test.ts` green.
  - Evidence: red: `cd server && npx vitest run --project integration src/routers/apiResponseFixtures.int.test.ts -t "provider credentials"` -> `× GET, PUT and POST test on /api/me/providers match the captured fixtures`, diff `+   "claude_cli_allowed": false,` (log `sdk-3.3-red.log`); with the new conformance cases, `cd web && npx tsc --noEmit -p .` -> `types.conformance.test.ts(809,11): error TS2322 … not assignable to type 'ProviderCredential'` and `(815,36): error TS2339: Property 'claude_cli_allowed' does not exist on type 'ProvidersResponse'` (log `sdk-3.3-red-tc.log`). Recaptured: `cd server && UPDATE_API_FIXTURES=1 npx vitest run --project integration src/routers/apiResponseFixtures.int.test.ts -t "provider"` -> `Tests  2 passed | 44 skipped (46)` (log `sdk-3.3-capture.log`); `providersList.json` gains `"claude_cli_allowed": false`, and a new capture `providerSaveClaudeCli.json` holds `"provider": "claude-cli"`, `"model": "claude-cli"`, `"key_last4": null`. Green: the fixture file without the flag -> `Tests  46 passed (46)` (log `sdk-3.3-fixtures-green.log`); `cd web && npx vitest run src/api/types.conformance.test.ts src/apiResponseShapes.repo.test.ts` -> `Tests  109 passed (109)` (log `sdk-3.3-green.log`); `npm run typecheck` -> exit 0, 0 `error TS` (log `sdk-3.3-tc.log`).
  - Evidence: `web/src/api/types.ts`: `ProviderId` gains `claude-cli`, `ProviderCredential.key_last4` is `string | null`, and `ProvidersResponse` gains `claude_cli_allowed`. New cases: the claude-cli save capture and its conformance check, and the list's `claude_cli_allowed`. D9 category 5: `AdvancedSection.test.tsx:178`, the `ProvidersResponse` state literal, gains `claude_cli_allowed: false` (typing only; it is also a category 7 file). Units after group 3 (log `sdk-3-units.log`): server unit `Tests  446 passed | 3 skipped (449)`, contract `139 passed`, ai-runtime `199 passed`, storage unit `68 passed`, web `Tests  1922 passed (1922)`, ports `1 passed` (after the 2.2 correction).

## 4. Route resolution (design D1)

- [x] 4.1 Test first, in a new `server/src/auth/providerResolve.test.ts`. `resolveLlmRoute` gives:
  - **CLI** for a `claude-cli` row when the caller is allowlisted and `CLAUDE_CLI_PATH` is set;
  - **null** for that row after the email is removed, or with `CLAUDE_CLI_PATH` blank;
  - **SDK** with the decrypted key for each key provider;
  - **null** for an undecryptable row;
  - **null** for a caller with no row, allowlisted or not, in development and production mode
    alike (no fallback).
  Then the resolver. Green.
  - Evidence: red, the new `server/src/auth/providerResolve.test.ts` (an in-memory store, the real `ProviderKeyCipher`): `cd server && npx vitest run --project unit src/auth/providerResolve.test.ts` -> `TypeError: resolveLlmRoute is not a function`, `Tests  6 failed (6)` (log `sdk-4.1-red.log`). Green -> `Tests  6 passed (6)` (log `sdk-4.1-green.log`); `npm run typecheck` -> exit 0, 0 `error TS`.
  - Evidence: the cases: CLI for a `claude-cli` row with the caller listed (in either case and with spaces) and `CLAUDE_CLI_PATH` set, in development and production mode; null after the email is removed, with an empty list, with `CLAUDE_CLI_PATH` blank or whitespace, and for an unlisted bootstrap owner; SDK with the decrypted key for `anthropic`, `openai`, `google` and `openai-compatible` (with its base URL and origin); null for a row encrypted for another user or under another secret; null for no row for listed, unlisted and owner emails with `PROVIDER_DEV_MODE` true, false and absent; an `stt` row ignored. `resolveLlmRoute(env, user)` in `providerResolve.ts` returns `{kind:'cli'}`, `{kind:'sdk', provider, baseUrl, baseOrigin, model, apiKey}` or null, and uses `claudeCliAllowed` (3.2).

## 5. Guarded model requests (design D4, D5)

- [x] 5.1 Test first, in a new `server/src/auth/guardedFetch.test.ts`, against a local fake
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
  - Evidence: red, the new `server/src/auth/guardedFetch.test.ts`: `cd server && npx vitest run --project unit src/auth/guardedFetch.test.ts` -> `guardedFetch is not a function` in every case, `Tests  18 failed (18)` (log `sdk-5.1-red.log`). Green -> `Tests  18 passed (18)` (log `sdk-5.1-green.log`); with `providerOutbound.test.ts` and `providerTester.test.ts`, three runs -> `Tests  74 passed (74)` each; `npm run typecheck` -> exit 0 (log `sdk-5-tc.log`).
  - Evidence: `guardedFetch(opts)` in `providerOutbound.ts` returns `{fetch, byteLog, breach}`; `providerRequest` is unchanged, and `PROVIDER_HOSTS` moves beside it (re-exported from `providerTester.ts`). The cases: fixed hosts reach only `/v1/messages`, `/v1/responses` and `/v1beta/models/<model>:streamGenerateContent` (query empty or `alt=sse`), and 14 other paths are refused, including `%2e%2e`, `..`, `.`, `//` and `%2F`; a model id with `/` or `..` is refused for every provider without a request; `openai-compatible` reaches only `<origin><base path>/chat/completions`; a non-POST method, a `Request` object and a userinfo URL are refused; in production a host resolving to `169.254.169.254` is refused, and so is the second connection when the answer flips there after a first answer that passed (the per-connection check takes a test-only `isBlocked` so the fake's loopback reads as public), and blocked IP literals and `::ffff:` forms open no connection; the connection goes to the checked address with the original `Host`; a `302` comes back unfollowed and its target is never contacted; a header timeout of 150 ms (default 120 s) fires before headers, while a stream of 600 ms after them completes; the 61st request, a body over 4 MB and bodies past 48 MB are refused with kind `cap` and no connection; past 64 MB of response the stream errors with `cap` and the turn's next request is refused; `byteLog()` gives the request and response bytes per request; 2 MB is read while the upstream still holds the response open; an abort before or after headers closes the upstream socket (an already-aborted signal opens none); console, stdout and stderr hold no key, header or body.
- [x] 5.2 Add a repo test, `packages/ai-runtime/src/sdkSafety.repo.test.ts`, red against a
  planted violation and then green. It fails when production sources in `ai-runtime` or the AI
  routers:
  - pass a string as a model to `streamText` or `generateText`;
  - import `@ai-sdk/gateway`;
  - pass an AI SDK error or a caught error from a turn to `console.*` or the server logger;
  - call `streamText` without `onError`.
  - Evidence: the scanner's own cases and the repo scan pass on the tree: `cd packages/ai-runtime && npx vitest run src/sdkSafety.repo.test.ts` -> `Tests  6 passed (6)`. Red against a planted `src/zzPlantedSdkViolation.ts` (a `@ai-sdk/gateway` import, `streamText({ model: 'openai/gpt-5.5' })` with no `onError`, and `console.error('turn failed', err)` from a `catch` in a file importing `ai`) -> `× no file breaks a rule`, `+ "packages/ai-runtime/src/zzPlantedSdkViolation.ts gateway-import: 3"`, `string-model: 6`, `streamText-without-onError: 6`, `error-logged: 8`, `Tests  1 failed | 5 passed (6)` (log `sdk-5.2-red.log`). The plant deleted -> `Tests  6 passed (6)` (log `sdk-5.2-green.log`).
  - Evidence: it is a TypeScript syntax scan of `packages/ai-runtime/src` (no test files) and `server/src/routers/{ai,transcribe,events}.ts`. Rule 3's log sinks are `console.*` and `process.stdout/stderr.write`; the server has no other logger. It flags any AI SDK export, and in files importing `ai` or `@ai-sdk/*` any `catch`, `.catch()` or `onError` binding, passed to a sink. The existing `console.warn` diagnostics in `aiV2PendingQuestions.ts` and the routers are in files that don't import the SDK, so they stay. Rule 1 sees only literal model values, and rule 4 needs the options inline; the file header says so, and `sdkTurn.ts` (6.3) must follow that shape.
- [x] 5.3 Test first, in the `redactDatabaseError` / `app.ts` error-handler test (D5, D9
  category 9): an `APICallError`, or any error carrying `requestBodyValues` or `responseBody`,
  thrown from a route is logged as its class name only, and the captured stderr holds none of a
  planted prompt marker. Other errors log as before. Then the redaction rule. Green.
  - Evidence: red, new cases in `server/src/unhandledErrorLog.test.ts` (through the real `wireApp` `onError`): `cd server && npx vitest run --project unit src/unhandledErrorLog.test.ts` -> `× logs an APICallError as its class name only`, `× logs a RetryError (the marker alone) as its class name only`, `× logs any error carrying requestBodyValues as its class name only`, `× logs any error carrying responseBody as its class name only`, `Tests  4 failed | 3 passed (7)` (log `sdk-5.3-red.log`). Green -> `Tests  7 passed (7)` (log `sdk-5.3-green.log`). Units after group 5 (log `sdk-5-units.log`): server unit `Tests  475 passed | 3 skipped (478)`, ai-runtime `Tests  205 passed (205)`; `npm run typecheck` -> exit 0.
  - Evidence: `ai` is not a server dependency (`server/node_modules/ai` and `node_modules/ai` absent), so `app.ts` doesn't import `AISDKError`. It reads the marker `AISDKError.isInstance` checks, `Symbol.for('vercel.ai.error') === true`, or the presence of `requestBodyValues` or `responseBody`, and logs `{name: <constructor name>}` only. Each case also checks that console and stderr hold none of the planted prompt marker. D9 category 9: the existing two cases (a database error, and "logs any other error as before") are unchanged and green, and a new case keeps a non-SDK error with other properties logged whole.

## 6. AI SDK turn (design D3, D5, D6)

- [x] 6.1 Add the pinned dependencies to `packages/ai-runtime/package.json` (design D7). Verified
  by `npm ls ai @ai-sdk/anthropic @ai-sdk/openai @ai-sdk/google @ai-sdk/openai-compatible zod`
  showing the exact versions and one `zod`, and by the package-architecture boundary and
  duplicate tests green.
  - Evidence: `packages/ai-runtime/package.json` pins `ai: "7.0.137"`, `@ai-sdk/anthropic: "4.0.78"`, `@ai-sdk/openai: "4.0.91"`, `@ai-sdk/google: "4.0.93"`, `@ai-sdk/openai-compatible: "3.0.67"`; `npm install` at the root. `npm ls ai @ai-sdk/anthropic @ai-sdk/openai @ai-sdk/google @ai-sdk/openai-compatible zod` -> `ai@7.0.137`, `@ai-sdk/anthropic@4.0.78`, `@ai-sdk/openai@4.0.91`, `@ai-sdk/google@4.0.93`, `@ai-sdk/openai-compatible@3.0.67`, every `zod@4.6.5 deduped` (including under `@ai-sdk/provider-utils@5.0.58` and `@ai-sdk/gateway@4.0.110`); `npm ls zod --all --parseable` -> the one path `node_modules/zod` (log `sdk-6.1-ls.log`). Not test-first: a dependency change, verified by these checks. `cd server && npx vitest run --project unit src/zodSingleCopy.repo.test.ts src/packageBoundaries.repo.test.ts` -> `Test Files  2 passed (2)`, `Tests  87 passed (87)` (log `sdk-6.1-green.log`); ai-runtime `Tests  205 passed (205)`. `npm audit` reports only the existing `next` advisory.
- [x] 6.2 Type the builders' `server.tool(...)` parameter as the `ToolSink` interface, and add
  `registerSdkTurn` (D3). Verified by typecheck, and by the existing `aiMcpServer.int.test.ts`,
  `mcpTools.int.test.ts` and `aiMcpGenerationRendering.test.ts` green and unchanged.
  - Evidence: `aiMcpServer.ts` adds `ToolSink` (`tool(name, description, shape, handler)`, the handler's args typed from the shape) and `ToolSinkResult`; only the `TOOL_BUILDERS` record type changes (`(server: ToolSink, ctx) => void`), so the builder arrows, including `create_event: (server, { registry, sessionId, caller, generation, createdEvents }) => {`, and the `\n  },\n};` close are byte-identical, and `McpServer` still passes itself. `registerSdkTurn(registry, sessionId, caller, context?)` returns `{sessionId, tools, registerTools(sink), createdEvents(), pageCoverage(), disposed, dispose()}` with no listener or token; `registerTurn` and it share `newTurnRegistration`, `registerTurnTools` and `registrationCoverage`. Not test-first: a typing seam, verified by the unchanged tests (its behaviour is tested in 6.3). `cd server && npx vitest run --project integration src/test/session/aiMcpServer.int.test.ts src/test/session/mcpTools.int.test.ts` -> `Test Files  2 passed (2)`, `Tests  81 passed (81)`; `cd packages/ai-runtime && npx vitest run src/aiMcpGenerationRendering.test.ts src/sdkSafety.repo.test.ts` -> `Tests  26 passed (26)` (log `sdk-6.2-green.log`); `promiseHygiene.repo` and `packageBoundaries.repo` -> `Tests  107 passed (107)`; `git diff --stat` over the test files is empty; `npm run typecheck` -> exit 0, 0 `error TS` (log `sdk-6.2-tc.log`).
- [x] 6.3 Test first, in a new `packages/ai-runtime/src/sdkTurn.test.ts`, against a fake
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
  - Evidence: red, the new `packages/ai-runtime/src/sdkTurn.test.ts` (33 cases) and its fake server `src/test/fakeLlm.ts`: `cd packages/ai-runtime && npx vitest run src/sdkTurn.test.ts` -> `Error: Cannot find module '/src/sdkTools'`, `Test Files  1 failed (1)` (log `sdk-6.3-red.log`). Green -> `Tests  33 passed (33)`, three runs (log `sdk-6.3-green-file.log`); the package -> `Test Files  15 passed (15)`, `Tests  238 passed (238)` (log `sdk-6.3-green.log`); `cd server && npx vitest run --project unit src/promiseHygiene.repo.test.ts src/packageBoundaries.repo.test.ts src/zodSingleCopy.repo.test.ts` -> `Tests  110 passed (110)`; server unit -> `Tests  475 passed | 3 skipped (478)`; `npm run typecheck` -> exit 0, 0 `error TS` (log `sdk-6.3-tc.log`). Mutation checks, each reverted: no serialization -> `× parallel calls run one at a time`; no `<think>` middleware, no `store: false`, no `onError` -> `× reasoning parts are not relayed…`, `× OpenAI requests carry store: false`, `× an APICallError 401 with a body…` (the SDK's own stderr carried the body).
  - Evidence: `sdkTurn.ts`: `SdkTurnDeps {provider, baseURL, model, apiKey, fetch, byteLog, breach}`, so the route passes `{provider, baseURL, model, apiKey, ...guardedFetch(...)}` (the byte log and breach reader are injected as the guarded fetch's own functions); `buildSdkModel` throws `SdkTurnFailure('invalid-deps')` unless `fetch`, `byteLog` and `breach` are functions and `apiKey`, `baseURL`, `model` non-empty strings; `SDK_TURN_TOOLS` per kind (a context's wider `tools` is replaced); `streamText` with `onError` inline, `maxOutputTokens: 4000`, `maxRetries: 2`, `stopWhen` [step cap, token budget], `prepareStep` (marks each step's start in the byte log and the guard's step), `onStepEnd` (ai 7's name for the deprecated `onStepFinish`) recording tool calls, results and finish reason; result promises get `.then(undefined, noop)` and are never awaited; `historyToMessages` (D6) gives `user`/`assistant` messages then the new message. `sdkTools.ts`: `SdkToolGuard` (live check, 16 per step soft, 32/300 per turn hard -> breach and internal abort, one body at a time, `Tool failed.`, drain set) and the `ToolSink` collector. `sdkRelay.ts`: the part mapping and `decideSdkEnding`. `aiTurn.ts`: `sdk` in the options selects the SDK strategy; results may carry `ending` and `toolsDrained`, and an SDK success has `claudeSessionId: null`. The CLI path is unchanged.
  - Evidence: judgment calls for the owner. (1) "Capped" by the step cap or budget means the stop condition fired: the SDK evaluates stop conditions only after a step whose tool calls all ran (`ai/dist/index.js:10036`), so a natural finish on exactly the last allowed step is natural, not capped. (2) `incomplete` (last finish `length`, `content-filter`, `error`, `other`) is checked before "the last step had tool calls", so `length` with a call the SDK never ran reads `incomplete`; both fail generation and end chat `done`. (3) A client abort emits no terminal event (the frozen SSE rule, D3 table), so the abort case asserts at most one. (4) A dropped mid-stream response is retried by the SDK (3 requests within `maxRetries: 2`) before ending `upstream-failed`. (5) A tool error reaches the model by throwing an `Error` carrying the fixed text or the body's own validation text.
- [x] 6.4 Test first, in `sdkTurn.test.ts`: each of `anthropic`, `openai`, `google` and
  `openai-compatible` builds a model through its factory with `apiKey` and our `fetch`, and its
  first request reaches the expected fixed host or saved origin (the guarded fetch's destination
  check, with a stub transport). Then the factory table. Green.
  - Evidence: red, a new `the factory table` block in `sdkTurn.test.ts`: `cd packages/ai-runtime && npx vitest run src/sdkTurn.test.ts -t "factory table"` -> `× anthropic builds its model through its factory with apiKey and our fetch, and its first request reaches its fixed host`, `× google …`, `SdkTurnFailure: AI SDK turn failed`, `Tests  2 failed | 2 passed | 33 skipped (37)` (log `sdk-6.4-red.log`). Already passing, as expected: `openai` and `openai-compatible`, whose factories 6.3 needed (the `store: false` case and the fake server). Green: `createAnthropic` and `createGoogleGenerativeAI` join the table, each with `apiKey`, `baseURL` and our `fetch` only -> the file `Tests  37 passed (37)`, the package `Tests  242 passed (242)` (log `sdk-6.4-green.log`); `npm run typecheck` -> exit 0, 0 `error TS` (log `sdk-6.4-tc.log`).
  - Evidence: the cases build each model from its server-computed `baseURL` (`https://api.anthropic.com/v1`, `https://api.openai.com/v1`, `https://generativelanguage.googleapis.com/v1beta`, a saved `https://llm.example.test/sub/v1`) and run a turn whose stub transport records the first request and answers `400`: it reaches `/v1/messages`, `/v1/responses`, `/v1beta/models/gemini-test:streamGenerateContent?alt=sse` and `/sub/v1/chat/completions` on the expected origin, with the key only in `x-api-key`, `authorization: Bearer`, `x-goog-api-key` and `authorization: Bearer`, and the turn ends `upstream-failed`. Judgment call: `ai-runtime` may not import `server/src`, so the stub restates the guarded fetch's destination rule (`providerOutbound.ts` D4 step 1) instead of calling `guardedFetch`.
- [x] 6.5 Test first, in `sdkTurn.test.ts` (design D3, A41, owner 2026-10-12): Anthropic requests
  carry the top-level `cache_control: {"type":"ephemeral"}` and the other providers' requests carry
  none; the token budget counts each step's `totalTokens` minus `cacheReadTokens`, so a fake
  Anthropic stream reporting large cache reads does not fire the budget while one reporting the
  same total as uncached input does. Then the provider options and the budget. Green.
  - Evidence: red, a new block in `packages/ai-runtime/src/sdkTurn.test.ts` with a fake Anthropic Messages stream (every step a `tool_use`, usage as given): `cd packages/ai-runtime && npx vitest run src/sdkTurn.test.ts -t "cache"` -> `× Anthropic requests carry the top-level cache_control {type: ephemeral}` (`expected undefined to deeply equal { type: 'ephemeral' }`), `× large cache reads do not fire the budget, while the same total as uncached input does` (`expected [ … ] to have a length of 5 but got 1`), `Tests  2 failed | 1 passed | 37 skipped (40)` (log `sdk-6.5-red.log`). Already passing, as expected: no `cache_control` on the OpenAI-compatible, OpenAI or Google requests. Green -> the file `Tests  40 passed (40)`, the package `Tests  245 passed (245)` (log `sdk-6.5-green.log`); `npm run typecheck` -> exit 0 (log `sdk-6.5-tc.log`).
  - Evidence: `buildSdkModel` gives Anthropic `providerOptions: {anthropic: {cacheControl: {type: 'ephemeral'}}}` (the `providerOptions` type widens to allow it); the other providers are unchanged. `tokenBudget` adds each step's `usage.totalTokens` minus `usage.inputTokenDetails.cacheReadTokens` (0 when absent); the bytes ÷ 4 estimate for a step with no usage is unchanged. The cases: per step 9 255 total tokens with 9 000 cache reads (255 billable) runs to the step cap of 5 under a 2 000 budget, while 9 255 uncached input tokens stop the run after 1 request.
- [x] 6.6 Test first, in `sdkTurn.test.ts` and the topics route test (design D5 diagnostic): a
  `429` (and a `RetryError` whose last attempt was `429`), a guarded-fetch cap breach and a
  tool-call breach each yield an `SdkTurnFailure` carrying only `kind` plus `status` or the breach
  name. The route's failure log line ends `(status=429)` / `(breach=…)`, and the captured log holds
  no marker from the prompt, the provider body or the key. Then the failure fields and the log
  suffix. Green.
  - Evidence: red, a new block in `sdkTurn.test.ts` ("a content-free failure diagnostic") and a new topics case in `transcribe.int.test.ts`: `cd packages/ai-runtime && npx vitest run src/sdkTurn.test.ts` -> `× SdkTurnFailure carries only its kind plus a status or a breach name`, `× a 429 and a RetryError whose last attempt was 429 give status 429…` (`providerFailure is not defined`), `× a turn whose provider answers 429 on every attempt ends with {kind: provider, status: 429}` (`expected undefined to be an instance of SdkTurnFailure`), `× a guarded-fetch cap breach ends with {kind: breach, breach: request-total}`, `× the guarded fetch’s body and response caps are named request-bytes and response-bytes`, `× a tool-call breach ends with {kind: breach, breach: tool-calls}`, `× bad deps end as {kind: internal}` (log `sdk-6.6-red.log`); `cd server && npx vitest run --project integration src/routers/transcribe.int.test.ts -t "failure line names"` -> `× the failure line names only the classification and status=429 or breach=tool-calls, with no prompt, body or key` (`expected false to be true`, the line had no suffix) (log `sdk-6.6-red-route.log`). Green: the file `Tests  47 passed (47)`, the package `Tests  252 passed (252)` (log `sdk-6.6-green.log`); `transcribe.int`, `events.generate.int` and `ai.int` -> `Test Files  3 passed (3)`, `Tests  181 passed (181)` (log `sdk-6.6-green-route.log`); server unit `475 passed | 5 skipped`; `npm run typecheck` -> exit 0, 0 `error TS` (log `sdk-6.6-tc.log`).
  - Evidence: `SdkTurnFailure(kind: 'provider' | 'breach' | 'internal', {status?, breach?})` has enumerable `kind` plus, at most, an integer `status` or a `breach` (`requests`, `request-bytes`, `request-total`, `response-bytes`, `tool-calls`); its message is the fixed "AI SDK turn failed". `statusOf` reads only `APICallError.statusCode` or a `RetryError`'s `lastError` status; `relaySdkStream` takes it as `statusOf` and keeps only the number from an `error` part or a thrown stream error. A `breach` ending names `tool-calls` (the tool guard) or the guarded fetch's cap (`request-body` -> `request-bytes`, `response-total` -> `response-bytes`); an `error` ending is `provider` with its status; bad deps give `internal` (in `driveAiTurn`). `DriveAiTurnResult` gains optional `failure`. `sdkFailureSuffix` gives ` (status=N)`, ` (breach=name)` or nothing; `transcribe.ts` and `events.ts` append it to their existing failure line, and `ai.ts` logs `[ai-chat] session=…: turn failed — <detail><suffix>` for a failed AI SDK turn (chat had no failure line before). The fake providers accept response `headers` (`retry-after-ms` keeps the 429 retries fast). The 6.3 case "no AISDKError leaves the turn" now builds `SdkTurnFailure('internal')` / `('provider')`, the amended kinds; its assertions are otherwise unchanged. The route case's captured console holds no transcript, provider-body or key marker.
  - Evidence: correction (live dev check, 2026-10-12: a 28k-word Anthropic topic generation logged `… CLI turn failed (upstream-failed)` with no suffix, so its ending was unknown). Red: `cd packages/ai-runtime && npx vitest run src/sdkTurn.test.ts -t "ending summary"` -> `× sdkFailureSuffix names the ending, the step count and the last finish reason`, `× a capped, an incomplete and a status-less error turn report their summary, content-free`, `Tests  2 failed | 47 skipped (49)` (log `sdk-6.6b-red.log`); `cd server && npx vitest run --project integration src/routers/transcribe.int.test.ts -t "logs its ending"` -> `× a capped, an incomplete or a status-less failure logs its ending, step count and last finish, with no content` (`… generation failed — CLI turn failed (upstream-failed): expected false to be true`) (log `sdk-6.6b-red-route.log`). Green: the package `Tests  254 passed (254)` (log `sdk-6.6b-green.log`); `transcribe.int`, `events.generate.int` and `ai.int` -> `Test Files  3 passed (3)`, `Tests  182 passed (182)` (log `sdk-6.6b-green-route.log`), and `ai.int` alone four more times -> `Tests  54 passed (54)`; server unit `475 passed | 5 skipped`; `npm run typecheck` -> exit 0 (log `sdk-6.6b-tc.log`). `SdkTurnResult` (and `DriveAiTurnResult`) carry `summary: {steps, lastFinish}` (`'none'` before any step); `sdkFailureSuffix(failure, ending?, summary?)` keeps `(status=N)` / `(breach=…)`, else for an SDK ending gives ` (ending=<ending>, steps=<n>, last=<finish>)`; the topics, events and chat lines pass `ending` and `summary`, and the topics and events lines now say "AI turn" (no test depended on "CLI turn"); the chat line logs any failed SDK ending. The route case checks `(ending=capped, steps=3, last=tool-calls)`, `(ending=incomplete, steps=1, last=length)` and `(ending=error, steps=0, last=none)` (a connection reset, no status), with no transcript, reply or key marker in the captured log. The fake providers gain `reset` (destroy the socket before any response). Test fix, in the 7.1 cases of this change: the two mid-turn client-abort cases (`ai.int` "a second turn while one is in flight…", "after a client abort…") now send the caller's cookie explicitly. Without it the harness hands the app a copy of the request whose signal follows the original only through a weak reference, so after a GC the abort never reached the route (traced: the test's signal aborted, the route's did not) and the case timed out waiting for the slot. That was the intermittent 7.1 timeout, made frequent here by allocation changes; production requests are not copied this way.
- [x] 6.7 Test first, in `sdkTurn.test.ts` and `server/src/env.test.ts` (design D3 Limits, D4,
  amendment 2026-10-12): generation turns send `maxOutputTokens` from `GENERATE_MAX_OUTPUT_TOKENS`
  (default 16 000; blank, non-numeric and out-of-range values fall back), and chat still sends
  4000. The guarded fetch's response-byte cap equals `steps × maxOutputTokens × 400` for the turn
  (12.8 MB chat, 256 MB generation at defaults); a fake stream past it is cut as a breach. The
  ranges hold: `GENERATE_MAX_OUTPUT_TOKENS` 1 000–128 000, `AI_CHAT_MAX_STEPS` 1–50,
  `GENERATE_MAX_STEPS` 1–100, with values outside them using the default, and the cap computed
  from validated values. A generation turn whose first request gets `400` at a 16 000 cap
  restarts once at 4000 and succeeds (log suffix `(output-cap fallback 4000)`); a `400` again, or
  on a later request, fails; no tool runs twice. Then the config field, the turn wiring, the cap
  derivation and the fallback. Green.
  - Evidence: red, a new block in `sdkTurn.test.ts`, a new block in `server/src/env.test.ts`, the new `server/src/routers/_aiRoute.test.ts` and the amended response-cap cases in `guardedFetch.test.ts`: `cd packages/ai-runtime && npx vitest run src/sdkTurn.test.ts -t "task 6.7"` -> `× generation sends GENERATE_MAX_OUTPUT_TOKENS (default 16 000); chat always sends 4000` (`expected [ 4000 ] to deeply equal [ 16000 ]`), `× the response-byte cap is steps × maxOutputTokens × 400…` (`sdkResponseByteCap is not a function`), `× a generation turn whose first request gets 400 restarts once at 4000 and succeeds, with no tool run twice`, `× a second 400 fails as usual, after exactly one restart`, `× a 400 on a later request fails with no restart…`, `× no restart at a cap of 4000 or less, nor for chat, nor for a status other than 400`, `Tests  6 failed | 49 skipped (55)`; `cd server && npx vitest run --project unit src/env.test.ts src/auth/guardedFetch.test.ts src/routers/_aiRoute.test.ts -t "6.7|per-turn caps"` -> `× GENERATE_MAX_OUTPUT_TOKENS takes 1 000–128 000…` (`expected undefined to be 1000`), `× AI_CHAT_MAX_STEPS takes 1–50 and GENERATE_MAX_STEPS 1–100…` (`expected [ 1, 50, 51, 8, 8 ]…`), `× abort the response stream past the turn’s response-byte cap…` (`expected 67108864 to be less than or equal to 3200000`), `× chat: steps × 4000 × 400 (1 step: 1.6 MB)…`, `Tests  8 failed | 3 passed | 50 skipped (61)` (log `sdk-6.7-red.log`); the topics route case, run against the pre-change `transcribe.ts`: `cd server && npx vitest run --project integration src/routers/transcribe.int.test.ts -t "task 6.7"` -> `× sends GENERATE_MAX_OUTPUT_TOKENS, and a first-request 400 restarts once at 4000 with the content-free note (task 6.7)` (`expected [] to have a length of 1 but got +0`) (log `sdk-6.7-red-route.log`). Green: the package `Test Files  15 passed (15)`, `Tests  260 passed (260)` (including `sdkSafety.repo.test.ts`), and the three server files `Tests  61 passed (61)` (log `sdk-6.7-green.log`); `transcribe.int`, `events.generate.int` and `ai.int` -> `Test Files  3 passed (3)`, `Tests  183 passed (183)` (log `sdk-6.7-green-route.log`); server unit `Tests  482 passed | 5 skipped (487)` (log `sdk-6.7-unit.log`); `npm run typecheck` -> exit 0, 0 `error TS` (log `sdk-6.7-tc.log`).
  - Evidence: `Config.GENERATE_MAX_OUTPUT_TOKENS` (ports, node config). `env.ts` `intInRange` gives `AI_CHAT_MAX_STEPS` 1–50 (default 8), `GENERATE_MAX_STEPS` 1–100 (default 40) and `GENERATE_MAX_OUTPUT_TOKENS` 1 000–128 000 (default 16 000; digits only, so `12.5`, `1e9` and `-5` fall back); `generateSdkLimits` returns `maxOutputTokens`. `sdkTurn.ts`: `SdkTurnLimits.maxOutputTokens?`, `sdkMaxOutputTokens(kind, limits)` (chat fixed 4000, generation the limit or 16 000), `sdkResponseByteCap(kind, limits)` = `maxSteps × sdkMaxOutputTokens × 400`; `sdkTurnSpec` passes it to `guardedFetch` as the now-required `responseTotalBytes` (a non-positive or non-finite value admits no bytes), and `GUARDED_FETCH_CAPS` drops the fixed 64 MB. The fallback restarts `streamText` once, inside the same `runOuterAiTurn` relay (one timeout, one terminal event), only for a generation turn at a cap above 4000 whose first attempt errored with status 400 with no finished step, no tool call (`SdkToolGuard.calls === 0`), one request in the byte log, no breach and no abort; the result and `DriveAiTurnResult` carry `outputCapFallback: 4000`, and `sdkFallbackSuffix` gives ` (output-cap fallback 4000)`. `transcribe.ts` and `events.ts` append it to their failure line and, on a success that fell back, log `… AI turn succeeded (output-cap fallback 4000)` with `console.info`; chat never falls back. The route case checks `max_tokens` 9000 from config and 16 000 for an out-of-range `500`, the fallback success line, `(status=400) (output-cap fallback 4000)` on a second 400, and no prompt, body or key marker in the log. Test changes, both in tests created earlier in this change and updated to the amended behaviour (D3/D4 amendment 2026-10-12): `guardedFetch.test.ts` (5.x) helpers pass `responseTotalBytes: 12_800_000`, the caps case no longer expects a fixed `responseTotalBytes: 64 MB`, and the response-cap case runs at a 3.2 MB per-turn cap instead of 64 MB; `sdkTurn.test.ts` (6.3) `run` helper passes an optional `maxOutputTokens`.

## 7. AI routes on the caller's route (design D1, D3, D6)

The integration tests point SDK routes at a local fake provider through a dev-mode
`openai-compatible` credential on `http://127.0.0.1`, which development mode allows.

- [x] 7.1 Test first, in `ai.int.test.ts` (D9 categories 1, 2 and 4, plus new cases):
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
  - Evidence: red, new cases in `ai.int.test.ts` plus the D9 changes: `cd server && npx vitest run --project integration src/routers/ai.int.test.ts` -> `× 503 not-configured when CLAUDE_CLI_PATH is unset` and `… whitespace-only` (category 2), `× a caller with no saved llm credential gets the 503 in development and production mode…`, `× a claude-cli caller removed from CLAUDE_CLI_EMAILS gets the 503 on the next turn…`, `× streams delta/tool/done with claude_session_id null…ignoring a stale claude_session_id`, `× sends the history as user/assistant messages…`, `× a provider error gives one scrubbed error event`, `× after done|an error|a breach|a timeout|a client abort, no catalog row or DATA_DIR file holds the message, history or reply`, `Tests  12 failed | 42 passed (54)` (log `sdk-7.1-red.log`). Already passing, as expected: the 422 for a 41-entry history and the 403 before it (schema 3.1), the SDK-route 409 (the slot is route-independent), and the scan's non-vacuity case (a kept topic's marker is found). Green: `npx vitest run --project integration src/routers/ai.int.test.ts src/routers/access.int.test.ts src/routers/compression.int.test.ts src/routers/aiV2.int.test.ts` -> `Test Files  4 passed (4)`, `Tests  158 passed (158)` (log `sdk-7.1-green.log`); `ai.int` alone, twice more -> `Tests  54 passed (54)`; server unit `Tests  475 passed | 3 skipped (478)`; `sdkSafety.repo` `Tests  6 passed (6)`; `npm run typecheck` -> exit 0, 0 `error TS` (log `sdk-7.1-tc.log`).
  - Evidence: `ai.ts` gates on `callerLlmRoute(c)` (`resolveLlmRoute`, D1): null -> `503 {"detail": "Add a language model in Settings → Advanced to use the assistant."}`; the CLI route keeps the resume check, `--allowedTools` and budget; the SDK route ignores `claude_session_id` and passes `sdk: sdkTurnSpec(c, route, 'chat', aiChatSdkLimits(config), body.history)`; a binding is recorded only when `claudeSessionId !== null`; the stream's `finally` awaits `toolsDrained()` before `slot.release()`. New `routers/_aiRoute.ts` (`callerLlmRoute`, `sdkTurnSpec`: the server-computed `baseURL` from `PROVIDER_HOSTS` plus `/v1` or `/v1beta`, or the saved base URL, and a fresh `guardedFetch` per turn with `production = PROVIDER_DEV_MODE !== true`); `env.ts` adds `aiChatSdkLimits` (8 / 400 000) and `generateSdkLimits` (40 / 3 000 000). Test helpers: `test/llmRoutes.ts` (`CLI_TEST_EMAILS`, `chooseClaudeCliForAll`, `chooseClaudeCli`, `saveSdkCredential` through `PUT /api/me/providers/llm`, `placesHolding` over every `catalog` table as the owner and every file under DATA_DIR and BLOB_DIR), `test/fakeLlm.ts` (a copy of the ai-runtime fake), and `harness.ts` exports `testDirs()`.
  - Evidence: D9 changes. Category 1 (setup only): `ai.int` — `loopbackEnv` adds `CLAUDE_CLI_EMAILS: CLI_TEST_EMAILS`, `post()` calls `chooseClaudeCliForAll()` first, and the second-app env adds the variable; `access.int:150`, `compression.int:371` and `aiV2.int:458,493` add the variable and the helper call. Category 2: the two `ai.int` 503 cases now assert the new detail, and `aiV2.int:272` matches `/Add a language model in Settings → Advanced/`. No assertion changed otherwise. The abort cases cancel the response body rather than read it (one full-file run timed out reading it; it did not recur in eight runs).
- [x] 7.2 Test first, in `transcribe.int.test.ts` (topics) and `events.generate.int.test.ts`
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
  - Evidence: red, new `describe` blocks in `transcribe.int.test.ts` ("topics/generate on the AI SDK route") and `events.generate.int.test.ts` ("events/generate on the AI SDK route") plus the D9 changes: `cd server && npx vitest run --project integration src/routers/transcribe.int.test.ts src/routers/events.generate.int.test.ts src/routers/sessionHub.interleave.int.test.ts src/routers/sessions.youtubeImport.int.test.ts` -> topics: `× with no route, the new 503 and no model request`, `× the fake model creates topics through the tools, and the replace-all matches the CLI path`, `× a run stopped by the step cap maps to the 502…GENERATE_MAX_STEPS applies`, `× a run stopped by the token budget…GENERATE_MAX_TOKENS applies`, `× a slow tool body still running at the route timeout finishes before the route removes the run’s new topics…`; events: `× with no route…`, `× the fake model creates events through the tools…`, `× a regenerate deletes the prior auto-generated events exactly as on the CLI route`, `× a regenerate stopped by a provider error|the step cap|the token budget answers the existing 502 and deletes nothing`; and the five category-2 503 cases; `Tests  16 failed | 160 passed (176)` (log `sdk-7.2-red.log`). Already passing, as expected: the topics provider-error 502 (the CLI fixture also made no topics). Green, the same files plus `test/session/topicGenerate.int.test.ts` -> `Tests  187 passed` and the slow-body case (its 5 s default timeout raised to 30 s) `1 passed`; then `transcribe.int`, `events.generate.int` and `ai.int` together -> `Test Files  3 passed (3)`, `Tests  180 passed (180)` (log `sdk-7.2-green.log`); server unit `475 passed | 3 skipped`; ai-runtime `242 passed`; `npm run typecheck` -> exit 0, 0 `error TS` (log `sdk-7.2-tc.log`). Mutation check, reverted: without the route's drain the slow-body case fails (`expected 578 to be greater than or equal to 1400`).
  - Evidence: `transcribe.ts` and `events.ts` gate on `callerLlmRoute(c)`: null -> `503` "Add a language model in Settings → Advanced to generate topics." / "…to generate events." (the gate keeps its place in each ladder); the CLI route is unchanged; the SDK route passes `sdk: sdkTurnSpec(c, route, 'topics' | 'events', generateSdkLimits(config))`; each awaits `outcome.toolsDrained?.()` right after the turn, before reading the run's topics, the replace-all, removing a failed run's topics, the regenerate delete and the slot and lease release (the lease renews meanwhile). A capped, incomplete, breached or failed SDK run is `ok: false`, so it maps to the existing `502` with no replace-all and no regenerate delete. `topicGenerate.ts`: `GenerateTopicsTurnOptions` takes `{cliPath, maxBudgetUsd}` or `{sdk}`.
  - Evidence: D9 changes. Category 1 (setup only): `transcribe.int` (`claudeConfiguredEnv`, both `generateReq` helpers, the approved-users `topics()` and its envs), `events.generate.int` (`configuredEnv`, `generateReq`, the approved-users `post()`, the cross-direction chat 409 and the revoke-regenerate case) and `sessionHub.interleave.int:84` add `CLAUDE_CLI_EMAILS: CLI_TEST_EMAILS` and `chooseClaudeCliForAll()`. Category 2: the topics 503 detail in `transcribe.int` (three cases) and `sessions.youtubeImport.int.test.ts:559` (its `topics/generate` half; the `transcribe.csv` half is unchanged), and the events 503 in `events.generate.int` ("2. CLAUDE_CLI_PATH unset → 503": `toMatch(/CLAUDE_CLI_PATH/)` becomes the new detail). `sessions.youtubeImport.int` was not in the 1.1 grep, which keys on other strings; it asserts the old topics 503 detail, which category 2 covers. The two `*.real.test.ts` call `generateTopicsTurn` / `driveAiTurn` with `cliPath`, whose signature is unchanged, so they need no change.
- [x] 7.3 Update the README's AI chat, topic and event sections, and the endpoint table rows for
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
  - Evidence: `README.md` — the AI chat section (now "AI chat (AI SDK or Claude CLI)", cross-references renamed) gains "The caller's language model route" (AI SDK, Claude CLI with `CLAUDE_CLI_EMAILS` and the `403` "The Claude CLI is limited to approved operator accounts.", none with the three `503` details), "Egress on the AI SDK route" (fixed host or saved origin, pinned DNS and per-connection production address rules, no redirects, 120 s header timeout, 60 requests / 4 MB / 48 MB / 64 MB per turn, `store: false`, classified errors), "Spend bounds on the AI SDK route" (`AI_CHAT_MAX_STEPS` 8, `AI_CHAT_MAX_TOKENS` 400000, `GENERATE_MAX_STEPS` 40, `GENERATE_MAX_TOKENS` 3000000, the bytes ÷ 4 estimate, 4000 output tokens, 2 retries, 16 / 32 / 300 tool calls, one body at a time; capped chat `done`, capped generation `502`), "OpenAI-compatible servers: enable the reasoning parser" (the `<think>` scope, e.g. `--reasoning-parser qwen3`) and "Chat history" (bounds, `422` before any model request, `done` null, `claude_session_id: null` as absent). The overview, topic generation, CLI-gate, CLI egress, event generation (gate, statuses, egress) and AI v2 paragraphs name the caller route; the deferred ceiling now says "deferred to a later change"; the environment table adds `CLAUDE_CLI_EMAILS`, `AI_CHAT_MAX_STEPS` / `AI_CHAT_MAX_TOKENS` and `GENERATE_MAX_STEPS` / `GENERATE_MAX_TOKENS`.
  - Evidence: the endpoint rows (log `sdk-7.3-rows.log`): `| \`GET /api/me/providers\` → **200** \`{llm, stt, run_features_allowed, claude_cli_allowed}\` (… \`key_last4\` is \`null\` and \`model\` \`"claude-cli"\` for the keyless \`claude-cli\` row …)`; `PUT …` gains `or exactly \`{provider: "claude-cli"}\` with no key, base URL or model` and `**403** \`{"detail":"The Claude CLI is limited to approved operator accounts."}\``, and the test `Connected.` / `The Claude CLI isn't available to this account.` with no outbound request; `| \`POST …/ai/chat\` \`{message, claude_session_id?: string \\| null, history?: […]}\` … **503** \`{"detail":"Add a language model in Settings → Advanced to use the assistant."}\` … \`done {claude_session_id}\` (a string on the CLI route, \`null\` on the AI SDK route …)`; `| \`POST …/topics/generate\` → **503** \`{"detail":"Add a language model in Settings → Advanced to generate topics."}\` no caller route … **502** turn failure/zero-topics, or on the AI SDK route a run stopped by the step cap or token budget (prior topics unchanged)`; `| \`POST …/events/generate\` → **503** \`{"detail":"Add a language model in Settings → Advanced to generate events."}\` … **502** … (… no regenerate delete)`. `server/.env.example` adds `CLAUDE_CLI_EMAILS=` (empty, "never commit real addresses"), `AI_CHAT_MAX_STEPS=8`, `AI_CHAT_MAX_TOKENS=400000`, `GENERATE_MAX_STEPS=40`, `GENERATE_MAX_TOKENS=3000000`, and rewrites the AI block's header; `grep -c "CLAUDE_CLI_EMAILS\|AI_CHAT_MAX_STEPS\|AI_CHAT_MAX_TOKENS\|GENERATE_MAX_STEPS\|GENERATE_MAX_TOKENS" server/.env.example` -> `5`. Not test-first: documentation.

## 8. Web (design D8)

- [x] 8.1 Test first, in `AdvancedSection.test.tsx` (D9 category 7, plus new cases):
  - the CLI option appears only when `claude_cli_allowed`, or when it is the saved choice;
  - selecting it hides Base URL, Model and API key and shows the help line;
  - saving sends `{provider:"claude-cli"}`;
  - the saved state shows Connected with no key row.
  Then the section. Green.
  - Evidence: red, a new `describe` "Settings › Advanced — the Claude CLI option": `cd web && npx vitest run src/pages/index/components/settings/AdvancedSection.test.tsx` -> `× an allowlisted user is offered it after the four providers`, `× selecting it hides Base URL, Model and API key, shows the help line, and saves {provider} alone`, `× the saved state shows Connected with no key row, and offers Test connection and Remove`, `× a saved claude-cli user later removed from the list still sees it as the current choice`, `× switching from a saved Claude CLI to another provider needs a model and a key`, `Tests  5 failed | 11 passed (16)` (log `sdk-8.1-red.log`). Already passing, as expected: the not-allowlisted user is offered exactly the four providers. Green: the same file -> `Tests  16 passed (16)` (log `sdk-8.1-green.log`); `npm run typecheck` -> exit 0, 0 `error TS` (log `sdk-8.1-tc.log`).
  - Evidence: `AdvancedSection.tsx` adds "Claude CLI (operator)" after the four providers when `claude_cli_allowed` or the saved `llm.provider` is `claude-cli`; with it selected the Model, separator and API key rows are not rendered, the Provider row's help reads "Runs on this server's Claude CLI login. Available only to operator accounts.", Save is valid with no typed field and sends `{provider: "claude-cli"}`, and a saved CLI row shows Connected with Test connection and Remove in the Connection row (its confirm names the CLI, not a key). Leaving a saved CLI for another provider clears the stored `claude-cli` model and asks for the key. `web/src/api/types.ts`: `ProviderSaveBody` becomes a union with the exact `{provider: 'claude-cli'}` body. D9 category 7: no existing case asserted the option count, so no existing assertion changed; the test's fake `PUT` gains a `claude-cli` branch returning the keyless row (`key_last4: null`, model `claude-cli`), as the server does.
- [x] 8.2 Test first, in `AiChat.test.tsx`, `generateLatch.test.tsx` and
  `eventGenerateLatch.test.tsx` (D9 categories 2 and 3):
  - the new not-configured copy points to Settings → Advanced;
  - saving an `llm` credential clears the chat state and both latches without a reload;
  - chat posts `history` from its display messages, excluding error rows, tool chips and the
    in-flight reply, trimmed to the bounds.
  Then the components and hooks. Green, plus `cd web && npx vitest run`.
  - Evidence: red, new cases plus the D9 changes: `cd web && npx vitest run src/pages/index/components/AiChat.test.tsx src/pages/index/components/generateLatch.test.tsx src/pages/index/components/eventGenerateLatch.test.tsx` -> chat: `× reads the new copy and names no server setting`, `× saving a language model clears the state without a reload`, `× a latch while a language model is already saved does not clear itself`, `× posts the earlier user and assistant messages, excluding error rows and tool chips`, and the three `buildChatHistory` bound cases (`TypeError: buildChatHistory is not a function`); topics: `× the empty state names Settings → Advanced and Insert, and no server setting or reload`, `× saving a language model clears the latch without a reload`, `× a latch while a language model is already saved stays until a new save`, and the category-2 `× latches on the first 503…` (topics case); events: `× clears without a reload, and a retry re-calls generate` and the category-2 `× latches on the first 503, persists across a session switch within the mount, clears on remount`; `Tests  13 failed | 33 passed (46)` (log `sdk-8.2-red.log`). Green: the same files -> `Test Files  3 passed (3)`, `Tests  46 passed (46)` (log `sdk-8.2-green.log`); `cd web && npx vitest run` -> `Test Files  145 passed (145)`, `Tests  1939 passed (1939)` (log `sdk-8.2-web-all.log`); `npm run typecheck` -> exit 0, 0 `error TS` (log `sdk-8.2-tc.log`).
  - Evidence: new `hooks/useClearOnLanguageModelSave.tsx`: while latched it subscribes to `['providers']` (the Transcribe feed's subscription), takes the first language model it sees as the baseline, and clears when a saved one differs from it (provider and `updated_at`), so a latch taken while a refused model is saved (a CLI choice after leaving the allowlist) waits for a new save; `ClearOnLanguageModelSave` is the same as a component, which `AiChat` mounts only inside its not-configured state (so `SessionWorkspace.test.tsx`, which mocks React Query without `useQuery`, needs no change). `useSseTurn` returns `resetNotConfigured`; `TopicsFeed` and `EventLogSheet` pass `useGatedGenerate`'s `resetUnavailable`. Copy: chat "Add a language model in Settings → Advanced to use the assistant."; the topics reason and empty state "Add a language model in Settings → Advanced to generate topics." (plus Insert and Dashboards); the events reason and empty state "…to generate events." (plus manual logging), with no reload or server wording. `AiChat` sends `history` from `buildChatHistory(messages)` (user and assistant rows only, trimmed, cut to 8000, newest 40 within 64 000 characters, a leading assistant entry dropped), omitted when empty; a null `done` id is still never echoed.
  - Evidence: D9 changes. Category 2: `generateLatch.test.tsx` topics `reasonText` becomes `/Add a language model in Settings → Advanced to generate topics\./`; `eventGenerateLatch.test.tsx` 503 case asserts the new events reason and no reload wording in place of `/no integration configured/` and `/[Rr]eload/`. Category 3: the events 503 case's title says "clears on remount" (not "only"), its `mockRoutes` serves `me/providers`, and the `providersState` type widens to a saved `llm`. The existing `AiChat` 503 case is unchanged. No other assertion changed.
- [x] 8.3 Visual check with agent-browser on the dev stack at 1440 and 390 px:
  - the Advanced picker with the CLI option, as an allowlisted user;
  - the chat not-configured state.
  Verified by screenshots under the scratchpad, with the findings fixed.
  - Evidence: `make dev-up` rebuilt the dev app (the running image lacked the new `@ai-sdk/*` packages: `ERR_MODULE_NOT_FOUND … '@ai-sdk/anthropic'`); `docker inspect autologger-dev-app` mounts this checkout's `web/src`. The dev OpenBao secret has no `CLAUDE_CLI_EMAILS` (`docker exec … ` -> `CLAUDE_CLI_EMAILS unset`), and the signed-in dev user already has a saved OpenAI-compatible model, so both states were reached by replacing `window.fetch` in the page (no credential was saved or removed): `GET /api/me/providers` answering `claude_cli_allowed: true` (or a saved `claude-cli` row with `claude_cli_allowed: false`), and `POST …/ai/chat` answering `503` with the new detail. Screenshots (scratchpad): `sdk-8.3-picker-open-1440.png` (the list ends "Claude CLI (operator)"), `sdk-8.3-cli-selected-1440.png` / `-390.png`, `sdk-8.3-cli-saved-delisted-1440.png` (Connected, Test connection and Remove, no key row), `sdk-8.3-chat-notconfigured-1440.png` / `-390.png` ("Add a language model in Settings → Advanced to use the assistant."), and after the fix `sdk-8.3-cli-selected-fixed-1440.png` / `-390.png`.
  - Evidence: one finding, fixed: with the CLI selected and unsaved, the Connection help read "the test checks the saved key and model"; it now reads "Save your changes first: the test checks the saved choice." Test first: `AdvancedSection.test.tsx` asserts no help line on the CLI panel mentions a key -> `Tests  1 failed | 15 passed (16)` (log `sdk-8.3-red.log`); green `cd web && npx vitest run` -> `Test Files  145 passed (145)`, `Tests  1939 passed (1939)` (log `sdk-8.3-green.log`); `npm run typecheck` -> exit 0 (log `sdk-8.3-tc.log`). Not seen live: the CLI option for a real allowlisted account, which needs the owner to add `CLAUDE_CLI_EMAILS` to the dev OpenBao secret.

## 9. Secrets, docs and integration checks

- [x] 9.1 Test first, in `docker/scripts/compose-run.test.mjs`: `CLAUDE_CLI_EMAILS`,
  `AI_CHAT_MAX_STEPS`, `AI_CHAT_MAX_TOKENS`, `GENERATE_MAX_STEPS` and `GENERATE_MAX_TOKENS` are
  accepted from the OpenBao secret. Then `docker/secrets-env.yaml`, `docker/.env.example` and
  `docs/openbao-secrets.md`. Green.
  - Evidence: red, `node --test --test-name-pattern="AI SDK harness" docker/scripts/compose-run.test.mjs` -> `✖ are accepted from the OpenBao secret in every stack` and `✖ a dev run passes them to compose` (`refusing the OpenBao secret: AI_CHAT_MAX_STEPS AI_CHAT_MAX_TOKENS CLAUDE_CLI_EMAILS GENERATE_MAX_STEPS GENERATE_MAX_TOKENS [not-allowed]`), `ℹ tests 2`, `ℹ fail 2` (log `sdk-9.1-red.log`). Green, `node --test docker/scripts/compose-run.test.mjs` -> `ℹ tests 80`, `ℹ pass 80`, `ℹ fail 0`; `sh docker/scripts/check-envs.sh dev|stage|prod` -> `check-envs: ok` for each (log `sdk-9.1-green.log`).
  - Evidence: the five keys are null passthroughs in `docker/secrets-env.yaml` under one comment. `docker/.env.example` has an empty `CLAUDE_CLI_EMAILS=` with its comment (no address) and the four limits commented out with their defaults. `docs/openbao-secrets.md` gains a `CLAUDE_CLI_EMAILS` rule (optional, owner not implicit, empty means nobody, `403` for others, restart to apply, link to ADR 0028) and a limits rule (defaults, positive integers, per-turn caps paid by the caller's key).
- [x] 9.2 Write `docs/decisions/0028-ai-sdk-agent-harness.md`. It covers:
  - the in-process AI SDK harness;
  - the guarded fetch;
  - the CLI allowlist;
  - error scrubbing;
  - the OpenCode alternative and why it was dropped (panel.md).
  Update `docs/security.md` with the threat model: prompt injection limited to the turn's tools,
  the key only in provider request headers, scrubbed errors, and no deployment-wide ceiling.
  Verified by the ADR having the same sections as ADR 0027, and by `grep -n "0028"
  docs/security.md` matching.
  - Evidence: `diff <(grep "^## " docs/decisions/0027-provider-keys-at-rest.md) <(grep "^## " docs/decisions/0028-ai-sdk-agent-harness.md)` -> no output (both `## Context`, `## Decision`, `## Consequences`, `## Evidence`); `grep -n "0028" docs/security.md` -> `128:  [0028](decisions/0028-ai-sdk-agent-harness.md)). AI chat, topic and event generation run` (log `sdk-9.2-green.log`). `docs/decisions/` has no ADR index (only `0000-adr-template.md` and the numbered ADRs), so nothing else lists 0028.
  - Evidence: ADR 0028's Decision covers the in-process harness (factory models only, injected fetch and key), the guarded fetch (destinations, manual redirect, 120 s header timeout, request and byte caps), the CLI allowlist (keyless row, owner not implicit, `403`, no dev fallback), error scrubbing (`upstream-failed`, `SdkTurnFailure`, no-op `.catch` and `onError`, "Tool failed.", class-only global log, no process handler because of Next.js's handlers), the tool-call caps and serialization, and the alternatives, with OpenCode's drop cited to panel.md's two OpenCode panels. `docs/security.md` Known gaps gains the threat model: prompt injection limited to the turn's tools, the key only in the provider request header, scrubbed errors, and no deployment-wide ceiling as a residual.
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
- [ ] 9.7 Allowlist `GENERATE_MAX_OUTPUT_TOKENS` (amendment 2026-10-12): test first in
  `docker/scripts/compose-run.test.mjs`, then `docker/secrets-env.yaml`, `server/.env.example`,
  `docker/.env.example`, `docs/openbao-secrets.md`, and the README AI bounds (generation output
  per step, and the derived response cap). Verified by `node --test
  docker/scripts/compose-run.test.mjs` green, and `grep -c GENERATE_MAX_OUTPUT_TOKENS` ≥ 1 in each
  file.
