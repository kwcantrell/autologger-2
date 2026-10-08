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

- [ ] 2.1 Test first, in new pg tests and in `catalogSchema.pg.test.ts` / `catalogPolicies.pg.test.ts`
  (D7 category 4):
  - both tables, their columns, checks and primary keys exist (`base_origin` null exactly when
    `base_url` is; `provider_key_check.id` only 1);
  - `catalog_user` gets `42501` on select, insert and delete of both;
  - deleting a user cascades;
  - a duplicate `(user_id, kind)` gets `23505`.

  Red, then add `supabase/migrations/20261016000000_user_provider_credentials.sql`, with the
  rollback in its header. Green, plus `sh docker/supabase/test_migrate.sh`.
- [ ] 2.2 Test first, storage pg tests for `PostgresProviderCredentialStore`:
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

## 3. Key crypto, mode and the boot secret (design D2, D3)

- [ ] 3.1 Test first, unit tests for `providerKeyCrypto`:
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
- [ ] 3.2 Test first, config unit tests: `PROVIDER_DEV_MODE` is true only for `NODE_ENV`
  `development` or `test`, and false for unset, `production` and `staging`. Red, then add the
  field. Green.
- [ ] 3.3 Test first, boot tests:
  - `main.ts` with no secret, or a malformed one, exits 1 naming the variable before the
    `DATA_DIR` lock is taken;
  - a second boot with a different valid secret exits 1 with the mismatch error before listening,
    and releases the lock;
  - `createBindings` without the `providerKeys` option and without the secret still works.

  Red, then wire it. Add the secret to the env of `bootOrder.int.test.ts` and
  `bootFrameBus.int.test.ts` (D7 category 8). Green.
- [ ] 3.4 Test first, `compose-run` tests: a stack whose OpenBao secret lacks
  `PROVIDER_KEYS_SECRET`, or holds 16 bytes, is refused naming it, printing no value and running
  no docker command (D7 category 9). Red, then add the check and the allowlist entry. Green.
  - Docs: `docker/secrets-env.yaml`, `server/.env.example`, `docker/.env.example`,
    `docker/.env.dev.example`, `docker/.env.stage.example` and `docs/openbao-secrets.md`
    (generation, one per environment, the lost-secret reset).

## 4. Routes and contract (design D4, D5)

- [ ] 4.1 Test first, contract schema tests:
  - `PUT` bodies per kind: `base_url` required or forbidden, `provider` pinned per kind, model and
    key lengths, the printable-ASCII rule (a key with a line feed or a space is refused);
  - production-mode URL rules: `https`, port 443, no userinfo, query or fragment;
  - every response schema is a `strictObject` with no key field.

  Red, then add the schemas. Green.
- [ ] 4.2 Test first, unit tests for `outbound.ts`:
  - every blocked range in D5, in IPv4, IPv6, v4-mapped and NAT64 forms, is refused in production
    mode and allowed in development mode;
  - a refused host and an unreachable host give the same result;
  - the pinned lookup returns the vetted address;
  - a slow lookup counts toward the 10 s timeout;
  - a 302 is not followed;
  - an error whose message holds the key is classified, and the capturing logger and the result
    hold neither.

  Red, then implement. Green.
- [ ] 4.3 Test first, integration tests for `/api/me/providers` covering every scenario of
  api-contract-freeze "Provider credential routes":
  - save, read (with `run_features_allowed`), replace and delete;
  - the first save needs a key;
  - a new `llm` host without a key gets `422` and leaves the row unchanged;
  - a control-character key gets `422`;
  - cross-user isolation;
  - signed-out and device-token callers get `401`;
  - an unknown kind gets `404`;
  - NUL gets `400`;
  - `base_url` with an uppercase host or an explicit `:443` is stored normalized, and a keep-key
    save with the same origin written differently is accepted;
  - the test's `200 {ok, detail}` for each mapped outcome, against local fake LLM and DeepGram
    servers (the DeepGram fake checks the silent clip and the model);
  - no credential gets `404`;
  - an undecryptable row gives the enter-it-again result;
  - the sixth test in a window, through two processes, gets `429` with no outbound request;
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
  - a new host asking for the key;
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
