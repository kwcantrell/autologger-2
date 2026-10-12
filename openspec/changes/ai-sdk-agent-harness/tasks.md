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
