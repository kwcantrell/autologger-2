# Tasks

**Branch and commits**
- The first commit on `byo-ai-providers` holds only `openspec/changes/byo-ai-providers/`.
- The PR targets `supabase-migration`.
- The gates run with `GITHUB_BASE_REF=supabase-migration`.

**Logs and test-first**
- Logs live under the session scratchpad as `byo-<task>-<red|green>.log`, and each `Evidence:` line
  names its log.
- Each "test first" item is red before its change, or records why it already passes.
- Each task's text and its `Evidence:` stay in one block with no blank line.

**Commands**
- Targeted server tests: `cd server && npx vitest run --project <unit|integration|pg> <files>`.
- Packages: `npx vitest run` in `packages/{ports,contract,transcription,catalog}`;
  `cd packages/storage && npx vitest run --project <unit|pg> <files>`.
- Web: `cd web && npx vitest run`.
- `npm run typecheck`.
- Migrations: `sh docker/supabase/test_migrate.sh`.
- The full pg and integration suites run in CI on the PR (ADR 0026). Locally, run only the
  targeted tests, the unit suites and typecheck.

**Changing tests.** Changing an existing test is allowed only for the categories in design D7.
Anything else is a stop: update the artifacts and ask the owner.

## 1. Baselines

- [x] 1.1 On the base, run the unit suites (server, packages, web) and typecheck, and record the
  counts.
  - Then list every existing test that design D7 categories 1-9 may touch, using
    `grep -rln "DEEPGRAM_API_KEY\|TRANSCRIPT_UNAVAILABLE\|deepgramConfigured\|ensureTimedTranscript\|companion-devices'\|isn.t configured on this server\|companion-device'\|FRAME_BUS_SECRET\|BOOTSTRAP_OWNER_EMAIL" --include=*.test.ts --include=*.test.tsx --include=*.sh --include=*.mjs server/src packages web/src docker/scripts`.
  - Classify each hit by category, or as unchanged.
  - Evidence: base `8b241154`. `cd server && npx vitest run --project unit` -> `Tests  350 passed | 3 skipped (353)`; `npx vitest run` in ports -> `Tests  1 passed (1)`, contract -> `Tests  109 passed (109)`, transcription -> `Tests  70 passed (70)`, catalog -> `Tests  51 passed (51)`, ai-runtime -> `Tests  199 passed (199)`, session-core -> `Tests  55 passed (55)`, media-import -> `Tests  31 passed | 2 skipped (33)`, log-import -> `Tests  41 passed (41)`, domain -> `Tests  50 passed (50)`; `cd packages/storage && npx vitest run --project unit` -> `Tests  60 passed (60)`; `cd web && npx vitest run` -> `Tests  1907 passed (1907)`; `npm run typecheck` -> exit 0, 0 `error TS` (log `byo-1.1-baseline.log`). DB baseline: the last full CI run on `supabase-migration` (PR #97/#98).
  - Evidence: the grep matches 28 files (log `byo-1.1-grep.log`).
    - Category 1: `routers/transcribe.int.test.ts` (the unconfigured case at :65 and the `deepgramConfiguredEnv` helper at :801).
    - Category 2: `test/session/generateTranscript.remap.int.test.ts:79` and `packages/transcription/src/generateTranscript.inflight.test.ts:11` (`config: {DEEPGRAM_API_KEY}` -> `stt`).
    - Category 3: `routers/logImport.int.test.ts` and `routers/logImport.test.ts` (`ensureTimedTranscript`).
    - Category 5: `catalogSystem.repo.test.ts:113`.
    - Category 6: `settings/SettingsView.test.tsx:38,125`.
    - Category 7: `generateLatch.test.tsx:21,112,173`.
    - Category 8: `bootOrder.int.test.ts:73` and `bootFrameBus.int.test.ts:59`.
    - Category 9: `docker/scripts/compose-run.test.mjs` (and the code `compose-run.mjs:253-255`).
    - Unchanged: `bootGuard.test.ts`, `env.test.ts`, `ai.int.test.ts`, `auth.int.test.ts`, `test/session/frameBus.int.test.ts` and `node/config.test.ts` (bootstrap or frame-bus env only; `createBindings` without the new option is unchanged); `companionDevices.int.test.ts`, `companionDeviceAuth.int.test.ts` and `CompanionDevicesSection.test.tsx` (path strings); `supabase-keys.test.mjs` and `frameBusEnvelope.test.ts`; `packages/transcription/src/deepgramConfig.test.ts` (the functions stay); `routers/sessionHub.interleave.int.test.ts:459` (configures generation with `DEEPGRAM_API_KEY`, which still works because vitest runs with `NODE_ENV=test`, development mode); `apiResponseFixtures.int.test.ts` (gains new cases only, nothing changes).
  - Evidence: for the owner, one spot near the edge of the categories. `upgradeDispatch.test.ts:23` and `aiV2.int.test.ts:320` build complete `Config` literals ("no optional/default fields"), so a required `PROVIDER_DEV_MODE` field would break their typecheck, and no D7 category covers that. To stay inside D7, the field will be optional, `PROVIDER_DEV_MODE?: boolean`, where absent means production mode. This is the safe default the spec requires, and it leaves both literals unchanged. `grep -rln "satisfies Config\|: Config = {" --include=*.ts server/src packages` -> only those two files.

## 2. Table and store (design D1)

- [x] 2.1 Test first, in new pg tests and in `catalogSchema.pg.test.ts` / `catalogPolicies.pg.test.ts`
  (D7 category 4):
  - both tables, their columns, checks and primary keys exist (`base_origin` null exactly when
    `base_url` is; `provider_key_check.id` only 1);
  - `catalog_user` gets `42501` on select, insert and delete of both;
  - deleting a user cascades;
  - a duplicate `(user_id, kind)` gets `23505`.
  Red, then add `supabase/migrations/20261016000000_user_provider_credentials.sql`, with the
  rollback in its header. Green, plus `sh docker/supabase/test_migrate.sh`.
  - Evidence: red, with the migration moved aside: `cd server && npx vitest run --project pg src/test/pg/providerTables.pg.test.ts src/test/pg/catalogSchema.pg.test.ts src/test/pg/catalogPolicies.pg.test.ts` -> `PostgresError: relation "catalog.user_provider_credentials" does not exist`, `× matches the recorded catalog schema`, `× has exactly the catalog tables, in schema catalog`, `Test Files  3 failed (3)`, `Tests  16 failed | 52 passed (68)` (log `byo-2.1-red.log`). Green, the same three files -> `Test Files  3 passed (3)`, `Tests  68 passed (68)` (log `byo-2.1-green.log`); `sh docker/supabase/test_migrate.sh` -> `test_migrate: 35 passed, 0 failed` (log `byo-2.1-migrate.log`); `npm run typecheck` -> exit 0, 0 `error TS`.
  - Evidence: the migration creates both tables as the catalog-database delta specifies, with named checks for kind, provider (1-64), base URL (≤ 2048), model (1-200), `key_last4` (1-4), `base_origin` null exactly when `base_url` is null, and `provider_key_check.id = 1`. It sets RLS with one `<table>_system_all` policy for `catalog_system`, revokes `catalog_user` on both, and gives the rollback in its header. The new `providerTables.pg.test.ts` has 7 cases: privileges and policies, including none for `anon` or `authenticated`; `42501` for a user binding even on its own rows; system read and write; bytea key parts and an empty test window by default; cascade on user delete; `23505`, `23503` and `23514` on every check; one key-check row only. D7 category 4: `catalogSchema.pg` `TABLES`, `SYSTEM_ONLY`, `KEY_COLUMN` (`provider_key_check` keys on its text `check_value`, so the bare-role insert fails on privilege, not on the smallint `id`), the recorded schema and its `$checks`, and one insert into each table in the system read-write case. `catalogPolicies.pg` lists the two tables as system-only; its `toHaveLength(37)` is unchanged (comment only).
- [x] 2.2 Test first, storage pg tests for `PostgresProviderCredentialStore`:
  - `put` inserts, then replaces;
  - `get` and `list` return only the user's own rows;
  - `updateKeepingKey` changes only provider, base URL, model and time, and reports zero rows when
    the row is gone or its `base_origin` differs;
  - `takeTestSlot` counts 1 to 6 within a window, restarts at 1 once 60 s have passed (injected
    clock), and never lets two concurrent calls from different connections both read 5;
  - a concurrent `delete` that commits first stays deleted;
  - `delete` removes only the user's row;
  - `writeCheckIfAbsent` and `readCheck` keep the first value written;
  - another user's id never matches.
  Red, then add the port and the store on `bindSystem('provider-credentials')`, add the
  allowlist entries (D7 category 5), and wire them in `server/src/node/config.ts`. Green and
  typecheck.
  - Evidence: red, `cd packages/storage && npx vitest run --project pg src/providerCredentials.pg.test.ts` -> `Error: Cannot find module './providerCredentials'`, `Test Files  1 failed (1)` (log `byo-2.2-red.log`). Red, with the store added: `cd server && npx vitest run --project unit src/catalogSystem.repo.test.ts` -> `+ "packages/storage/src/providerCredentials.ts provider-credentials"`, `Tests  1 failed | 17 passed (18)` (log `byo-2.2-repo-red.log`). Green, the store tests -> `Tests  9 passed (9)` (log `byo-2.2-green.log`); the repository test -> `Tests  18 passed (18)`; `cd server && npx vitest run --project unit` -> `Tests  350 passed | 3 skipped (353)`; storage unit -> `Tests  60 passed (60)`; `npm run typecheck` -> exit 0, 0 `error TS`.
  - Evidence: the `ProviderCredentialStore` port is in `packages/ports/src/providerCredentials.ts`, and `PostgresProviderCredentialStore` in `packages/storage/src/providerCredentials.ts` on `bindSystem('provider-credentials')`. `put` is an upsert that keeps `created_at_utc` and the test window. `updateKeepingKey` is one `UPDATE … WHERE … base_origin IS NOT DISTINCT FROM ? RETURNING`. `takeTestSlot` is one `UPDATE … RETURNING`, with the window from the Clock (`PROVIDER_TEST_LIMIT` 5, `PROVIDER_TEST_WINDOW_MS` 60 000). `writeCheckIfAbsent` is `ON CONFLICT (id) DO NOTHING`, then a read. It is wired as `Bindings.ports.providerCredentials` (`server/src/node/config.ts`, `server/src/appEnv.ts`). The 9 store tests: put then replace; own rows only; keep-key update; null on another origin or a missing row; ten keep-key-update and delete races leaving no row; delete; window count and restart on the injected clock; 8 concurrent slots from two store instances counting 1-8; first check value wins. D7 category 5: `catalogSystem.repo.test.ts` gains the one allowlist entry.

- [ ] 2.3 (Owner decision 10, provider picker) Test first, storage pg tests: `updateKeepingKey`
  matches only a row with the same provider, so a keep-key save that names another provider
  reports zero rows and changes nothing; `put` can switch the provider. Red, then add `provider =`
  to the predicate and stop setting `provider` on a keep-key update. Green and typecheck.
- [ ] 2.4 (Re-panel) Test first, in pg tests: `provider_test_windows` exists, is system-only and
  cascades on user delete; the two window columns are gone from `user_provider_credentials`; and
  `takeTestSlot(userId)` counts 1 to 6 in a window across both kinds, restarts after 60 s
  (injected clock), keeps counting after the credential is deleted and saved again, and counts 8
  concurrent calls from two store instances as 1 to 8. The 2.2 window tests and the schema
  snapshots move to the new shape (D7 category 11). Red, then add
  `supabase/migrations/20261017000000_provider_test_windows.sql` and change the store. Green,
  `sh docker/supabase/test_migrate.sh` and typecheck.

## 3. Key crypto, mode and the boot secret (design D2, D3)

- [x] 3.1 Test first, unit tests for `providerKeyCrypto`:
  - a round trip;
  - a fresh nonce each time;
  - a tampered tag, ciphertext or nonce gives `null`;
  - another user's id, another kind or another `llm` origin as AAD gives `null`;
  - `key_version` 2 gives `null`;
  - `key_last4` is right;
  - the check value is stable for a secret and differs between secrets;
  - a secret decoding to 16 or 33 bytes throws `ProviderKeysSecretError` naming the variable and
    not the value.
  Red, then implement. Green.
  - Evidence: red, `cd server && npx vitest run --project unit src/auth/providerKeyCrypto.test.ts` -> `Error: Cannot find module './providerKeyCrypto'`, `Test Files  1 failed (1)` (log `byo-3.1-red.log`). Green -> `Tests  15 passed (15)` (log `byo-3.1-green.log`). The 15 cases: a 32-byte secret is accepted; missing, empty, whitespace, 16-byte, 33-byte and non-base64 secrets are refused with a message naming `PROVIDER_KEYS_SECRET` and not the value; a round trip with version 1, `last4`, a 12-byte nonce and a 16-byte tag; a fresh nonce each time; a tampered tag, ciphertext or nonce, a short nonce, or version 2 give `null`, with one warn line each naming only the user id and kind; another user, kind or origin as AAD gives `null`; another secret can't decrypt; the check value is stable per secret, differs between secrets and is not the secret; a random cipher round-trips; `keyLast4`. The module is `server/src/auth/providerKeyCrypto.ts` (HKDF-SHA256 encryption and check keys, AES-256-GCM, AAD `user\0kind\0origin`).
- [x] 3.2 Test first, config unit tests: `PROVIDER_DEV_MODE` is true only for `NODE_ENV`
  `development` or `test`, and false for unset, `production` and `staging`. Red, then add the
  field. Green.
  - Evidence: red, `cd server && npx vitest run --project unit src/node/config.test.ts` -> six `× NODE_ENV … gives PROVIDER_DEV_MODE …`, `Tests  6 failed | 14 passed (20)` (log `byo-3.2-red.log`). Green -> `Tests  20 passed (20)` (log `byo-3.2-green.log`); `npm run typecheck` -> exit 0, 0 `error TS`. `Config.PROVIDER_DEV_MODE?: boolean` (`packages/ports/src/config.ts`, optional, so absent is production mode and the two complete `Config` literals from 1.1 stay unchanged) is set in `createBindings` to `NODE_ENV === 'development' || NODE_ENV === 'test'`. The new cases cover `development` and `test` (true), and `production`, `staging`, `Development` and unset (false).

- [x] 3.3 Test first, boot tests:
  - `main.ts` with no secret, or a malformed one, exits 1 naming the variable before the
    `DATA_DIR` lock is taken;
  - a second boot with a different valid secret exits 1 with the mismatch error before listening,
    and releases the lock;
  - `createBindings` without the `providerKeys` option and without the secret still works.
  Red, then wire it. Add the secret to the env of `bootOrder.int.test.ts` and
  `bootFrameBus.int.test.ts` (D7 category 8). Green.
  - Evidence: red, `cd server && npx vitest run --project unit src/node/config.test.ts` -> `Tests  3 failed | 20 passed (23)`; `npx vitest run --project integration src/bootProviderKeys.int.test.ts` -> all three cases `×` (main.ts booted instead of refusing), `Tests  3 failed (3)` (logs `byo-3.3-red-unit.log`, `byo-3.3-red-int.log`). Green: `cd server && npx vitest run --project unit` -> `Tests  374 passed | 3 skipped (377)` (log `byo-3.3-green-unit.log`); `npx vitest run --project integration src/bootProviderKeys.int.test.ts src/bootOrder.int.test.ts src/bootFrameBus.int.test.ts` -> `Test Files  3 passed (3)`, `Tests  10 passed (10)` (log `byo-3.3-green-int.log`); `npm run typecheck` -> exit 0, 0 `error TS`.
  - Evidence: `createBindings` option `providerKeys: 'required'`, passed only by `main.ts`, parses `PROVIDER_KEYS_SECRET` after the frame-bus check and before the lock. Without the option, a valid secret is used and anything else becomes `ProviderKeyCipher.random()`. That keeps the existing Proxy test in `config.test.ts`, which answers every unset key with `/etc/attacker`, unchanged, so no test outside D7 moves. The cipher is wired as `Bindings.ports.providerKeys`. `main.ts` catches `ProviderKeysSecretError` before the lock, and after `waitForCatalog` runs `verifyProviderKeysCheck` (`writeCheckIfAbsent` then compare). A mismatch goes through the existing catch, so it logs `autologger: PROVIDER_KEYS_SECRET does not match the stored provider keys …`, calls `close()` and exits 1. The new `bootProviderKeys.int.test.ts` covers: no secret, and a 16-byte secret, each exit 1 naming the variable with an empty data directory; a first boot with S1 listens, a boot with S2 exits 1 with the mismatch error and never listens, and S1 then boots again (the lock was released and the value kept). D7 category 8: `bootOrder.int.test.ts` (the unreachable-catalog case) and `bootFrameBus.int.test.ts` (`stackEnv`) gain `PROVIDER_KEYS_SECRET`.

- [x] 3.4 Test first, `compose-run` tests: a stack whose OpenBao secret lacks
  `PROVIDER_KEYS_SECRET`, or holds 16 bytes, is refused naming it, printing no value and running
  no docker command (D7 category 9). Red, then add the check and the allowlist entry. Green.
  - Docs: `docker/secrets-env.yaml`, `server/.env.example`, `docker/.env.example`,
    `docker/.env.dev.example`, `docker/.env.stage.example` and `docs/openbao-secrets.md`
    (generation, one per environment, the lost-secret reset).
  - Evidence: red, `node --test --test-name-pattern="provider keys" docker/scripts/compose-run.test.mjs` -> `✖ every stack refuses a missing, blank or non-32-byte PROVIDER_KEYS_SECRET` (`checkProviderKeysSecret is not a function`), `✖ a dev run without PROVIDER_KEYS_SECRET in OpenBao refuses before docker runs` (`Expected "actual" to be strictly unequal to: 0`) (log `byo-3.4-red.log`). Green, `node --test docker/scripts/compose-run.test.mjs` -> `ℹ tests 74`, `ℹ pass 74`, `ℹ fail 0` (log `byo-3.4-green.log`). `sh docker/scripts/check-envs.sh dev|stage|prod` -> `check-envs: ok` for each.
  - Evidence: `checkProviderKeysSecret(env, secrets)` in `compose-run.mjs` refuses a missing, blank, malformed or non-32-byte value without printing it, and runs after `checkSignInClient`. `docker/secrets-env.yaml` allows `PROVIDER_KEYS_SECRET`. D7 category 9: the six full-run fixtures in `compose-run.test.mjs` gain `secret('PROVIDER_KEYS_SECRET', PKS)`, and the child-env names assertion gains `PROVIDER_KEYS_SECRET`. Docs: `server/.env.example` (the variable, and transcription now per-user with no production fallback), `docker/.env.example` (required; `DEEPGRAM_API_KEY` unused in production), `docker/.env.dev.example` (required; the dev fallback), `docker/.env.stage.example` (required; unused on stage), and `docs/openbao-secrets.md` (every stack needs it, generated per environment, the boot check, the lost-secret reset, no production DeepGram fallback).
  - Evidence: for the owner, `sh docker/scripts/test_check_envs.sh` -> `48 passed, 1 failed` ("clean tree passes", with `xargs: tar: terminated by signal 13` while copying the tree). It fails the same way with this change stashed (log `byo-3.4-checkenvs-base.log`, `48 passed, 1 failed`), so it is a local environment issue, not this change. CI runs it on the PR.

- [ ] 3.5 (Owner decision 10) Test first, `providerKeyCrypto` unit tests: the binding includes the
  provider, so a key encrypted for `openai-compatible` does not decrypt as `anthropic` (or any
  other provider) with the same user, kind and origin. The existing fixtures gain `provider` (D7
  category 10). Red, then add `provider` to the binding and the AAD. Green and typecheck.

## 4. Routes and contract (design D4, D5)

- [x] 4.1 Test first, contract schema tests:
  - `PUT` bodies per kind: `base_url` required or forbidden, `provider` pinned per kind, model and
    key lengths, the printable-ASCII rule (a key with a line feed or a space is refused);
  - production-mode URL rules: `https`, port 443, no userinfo, query or fragment;
  - every response schema is a `strictObject` with no key field.
  Red, then add the schemas. Green.
  - Evidence: red, `cd packages/contract && npx vitest run src/schemas.providers.test.ts` -> `TypeError: providerPutBodySchema is not a function` (log `byo-4.1-red.log`). Green, `cd packages/contract && npx vitest run` -> `Test Files  5 passed (5)`, `Tests  121 passed (121)` (was 109; log `byo-4.1-green.log`); `npm run typecheck` -> exit 0, 0 `error TS`. In `packages/contract/src/schemas.ts`: `providerKindSchema`; `providerPutBodySchema(kind, {production})` (provider pinned per kind; `base_url` required for `llm` and null or absent for `stt`; model 1-200 and key 8-4096 printable ASCII without spaces after trimming; key optional); `providerBaseUrlProblem` (no userinfo, query or fragment, at most 2048 characters, http or https; production mode needs https on the default port); strict `providerCredentialSchema`, `providersResponseSchema` and `providerTestResponseSchema`; the fixed `PROVIDER_TEST_DETAIL` strings. The tests cover each rule, including spaces, CR, LF, tab, DEL and non-ASCII refused in a key or model, and no key field accepted in any response.

- [x] 4.2 Test first, unit tests for `outbound.ts`:
  - every blocked range in D5, in IPv4, IPv6, v4-mapped and NAT64 forms, is refused in production
    mode and allowed in development mode;
  - a refused host and an unreachable host give the same result;
  - the pinned lookup returns the vetted address;
  - a slow lookup counts toward the 10 s timeout;
  - a 302 is not followed;
  - an error whose message holds the key is classified, and the capturing logger and the result
    hold neither.
  Red, then implement. Green.
  - Evidence: red, `cd server && npx vitest run --project unit src/providers/outbound.test.ts` -> `Error: Cannot find module './outbound'` (log `byo-4.2-red.log`). Green -> `Test Files  1 passed (1)`, `Tests  39 passed (39)` (log `byo-4.2-green.log`); `npm run typecheck` -> exit 0, 0 `error TS`.
  - Evidence: `server/src/providers/outbound.ts` uses Node's own `http`/`https` with a pinned `lookup`, so no new dependency. The blocked ranges are a `net.BlockList` of the D5 IPv4 and IPv6 ranges plus the documentation and discard ranges, with the IPv4 embedded in `::ffff:0:0/96` and `64:ff9b::/96` checked as IPv4. `providerRequest` resolves within the caller's `AbortSignal`, refuses in production mode when any resolved address is blocked, connects to the vetted address with the original `Host`/SNI, never follows a redirect, caps the body at 1 MB, and turns every failure into `OutboundFailure('unreachable'|'timeout')` with a fixed message and no cause. `normalizeOrigin` and `normalizeBaseUrl` are added too. The tests cover 24 blocked and 6 allowed addresses (v4, v6, mapped, NAT64), normalization, no connection to a blocked address in production mode (including one blocked among public ones), the pinned connection keeping `Host`, a 302 not followed, a never-resolving lookup and a silent server each timing out, a refused connection being unreachable, a header holding the key and a newline classified with no key in the error, its JSON, its cause or any captured console line, and the 1 MB cap.

- [ ] 4.3 (Owner decision 10) Test first, contract schema tests: an `llm` body takes provider
  `openai-compatible` (base URL required, the URL rules apply), or `anthropic`, `openai` or
  `google` (base URL absent or null, refused otherwise); `stt` stays `deepgram`; the response
  schemas accept every provider. Red, then change `providerPutBodySchema`. Green and typecheck.
- [ ] 4.4 (Re-panel) Test first, unit tests for `ProviderTester` and its wiring:
  - each provider's request (path, percent-encoded model, auth headers) against local fakes;
  - the result mapping, including Google's `400` `API_KEY_INVALID` as rejected and its error body
    in no result or log;
  - `createBindings` always wires the frozen constant hosts, even under a hostile environment
    Proxy, and the table can't be mutated.
  Red, then add `server/src/providers/tester.ts` and wire `Bindings.ports.providerTester`. Green
  and typecheck.
- [ ] 4.5 Test first, integration tests for `/api/me/providers` covering every scenario of
  api-contract-freeze "Provider credential routes":
  - save, read (with `run_features_allowed`), replace and delete;
  - the first save needs a key;
  - a new `llm` host, or a new provider, without a key gets `422` and leaves the row unchanged;
  - a fixed-host provider with a `base_url` gets `422`;
  - a control-character key gets `422`;
  - cross-user isolation;
  - signed-out and device-token callers get `401`;
  - an unknown kind gets `404`;
  - NUL gets `400`;
  - `base_url` with an uppercase host or an explicit `:443` is stored normalized, and a keep-key
    save with the same origin written differently is accepted;
  - the test's `200 {ok, detail}` for each mapped outcome, against local fake servers for every
    provider through a `ProviderTester` built with their hosts (each fake checks its auth header
    and path: Bearer for OpenAI-compatible and OpenAI, `x-api-key` and `anthropic-version` for
    Anthropic, `x-goog-api-key` for Google; the DeepGram fake checks the silent clip and the
    model);
  - no credential gets `404`;
  - an undecryptable row gives the enter-it-again result;
  - the sixth test in a window, through two processes, gets `429` with no outbound request, and
    so does a sixth after deleting and re-saving the credential;
  - no response or captured log contains the key.
  Red, then add `server/src/routers/providers.ts` and mount it. Add the README endpoint table rows.
  Green and typecheck.

## 5. Transcription on the caller's key (design D3)

- [ ] 5.1 Test first, transcription unit tests:
  - `generateTranscriptWords` takes `stt: {apiKey, model}`;
  - `null` throws `unavailable` with the new detail;
  - the key goes only in the `Authorization` header.
  Red, then change the package (D7 category 2). Green.
- [ ] 5.2 Test first, integration tests for `transcript-words/generate`:
  - in production mode, a caller without a key gets the new `503` detail and no provider call is
    made, even with `DEEPGRAM_API_KEY` set;
  - with a key, the fake DeepGram sees that user's key and model;
  - in development mode, the env key is used when the caller has none;
  - another user's key is never used;
  - a tampered row answers as unconfigured;
  - the approval `403` still comes after the config `503`.
  Red, then add `resolveSttCredential` and wire `transcribe.ts` (D7 category 1). Green.
- [ ] 5.3 Test first, log-import integration tests:
  - generation uses the creator's key;
  - an approved creator without a key in production mode gets the add-a-key line, no lease and no
    provider call, and the job continues;
  - a creator who isn't approved gets only the approval skip line.
  Red, then wire `logImport.ts` (D7 category 3). Green.
  - Docs: update every README statement of the global DeepGram gate (lines 61, 73, 130, 229, 245,
    1107, 1263, 1448 and 1814 at base) and the production runbook (per-user keys, no production
    fallback, the lost-secret reset). Add a `docs/security.md` section: the at-rest cipher, the
    in-memory master key, the origin binding, and user-directed egress with its limits. Add ADR
    0027 "Provider keys at rest".

## 6. Web (design D6)

- [ ] 6.1 Test first, `AdvancedSection.test.tsx` in the `CompanionDevicesSection.test.tsx` style,
  covering every scenario of web-ui-system "Settings manages the user's AI providers":
  - the tabs and a draft surviving a switch;
  - a save showing only the last four characters, with the key in no query or mutation cache;
  - Replace and Remove with confirm;
  - the provider picker, with Base URL shown only for OpenAI-compatible;
  - a new provider or host asking for the key;
  - the approval note;
  - the test result alerts;
  - server error details;
  - a member's own credentials.
  The `SettingsView.test.tsx` order gains Advanced (D7 category 6). Red, then build the hook,
  types, fixtures and section from the prototype at `c831e510` (shadcn primitives only, no MCP
  tab). Green.
- [ ] 6.2 Test first, the web-session-console scenarios:
  - the transcription latch copy names Settings → Advanced and no server setting;
  - saving a speech-to-text credential clears the latch without a reload;
  - event-generation latching is unchanged.
  `generateLatch.test.tsx` moves to the new copy (D7 category 7). Red, then change
  `TranscribeFeed.tsx` and `useGatedGenerate.ts`. Green, `cd web && npx vitest run`, typecheck.
- [ ] 6.3 Look at the built section and the transcript panel in the dev stack at 1440 and 390
  wide: both tabs, saved and unsaved states, the new-host prompt, the approval note, the test
  alerts, Remove's confirm, and the latched transcript copy. Fix what the look shows in one batch,
  and record the captures.

## 7. Verify

- [ ] 7.1 `scripts/check-change.sh` passes (all gates). Run `consistency-read` over the
  artifacts. CI on the PR runs the full pg and integration suites green.
