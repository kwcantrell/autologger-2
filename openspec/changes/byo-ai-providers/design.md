# Design: byo-ai-providers

## Context

Line numbers are at base `3cbea66b`.

**Today's configuration** is global and read once at boot:
- `server/src/node/config.ts:158-160` reads `DEEPGRAM_API_KEY`, `DEEPGRAM_MODEL` and
  `CLAUDE_CLI_PATH` into `Config` (`packages/ports/src/config.ts:24-32`).
- `generateTranscriptWords` reads `deps.config.DEEPGRAM_API_KEY` itself
  (`packages/transcription/src/generateTranscript.ts:153`).
- When the key is blank it throws `unavailable` with `TRANSCRIPT_UNAVAILABLE` (`:28`, `:103`),
  which `mapGenerateError` turns into a `503` (`server/src/routers/transcribe.ts:87`).
- The DeepGram call sends `Authorization: Token <key>` to a fixed host
  (`packages/transcription/src/deepgram.ts:23,160`).

**Callers of transcription:**
- `POST …/transcript-words/generate` (`transcribe.ts:153-193`), with the caller from `requireUser`.
- Sheets log import's `ensureTimedTranscript` (`server/src/routers/logImport.ts:48-110`), called
  from a fire-and-forget job (`:171`). The job's creator is `job.createdByUserId`.

**Assumptions added after the panel** (each tested; see panel.md):
- `FRAME_BUS_SECRET` is checked only when `createBindings` gets `frameBus: 'postgres'`, which only
  `main.ts` passes. `grep -n "frameBus\|checkFrameBusSecret" server/src/node/config.ts` →
  `69: options.frameBus === 'postgres' ? checkFrameBusSecret(procEnv.FRAME_BUS_SECRET) : null;`
  So the provider-secret check follows the same option, and tests that call `createBindings` are
  untouched (D2).
- `Config` has no mode field. `NODE_ENV` is read once, for `HOST`
  (`grep -n NODE_ENV server/src/node/config.ts` → `146`). D3 adds a boot-time field.
- The web never shows the transcript-generate `503` detail. `useGatedGenerate` latches on any
  `503`, and `TranscribeFeed.tsx:306,352` hardcode `DEEPGRAM_API_KEY` copy, so D6 changes them.
- No web code knows whether a user is approved. `grep -rln "limited to approved\|run_features"
  web/src packages/catalog/src` → no output. So the providers `GET` carries
  `run_features_allowed` (D4).
- Node's `fetch` puts the whole header value in its error for an invalid header
  (`TypeError: Headers.append: "Token sk_secret\nX" is an invalid header value.`). Hence the key
  character rule and the no-error-message rule (D5).

**Template for per-user secrets:** companion-devices.
- Router: `server/src/routers/companionDevices.ts`.
- Port: `packages/ports/src/companionDevices.ts`.
- Store: `packages/storage/src/companionDevices.ts`, using the system binding, user id in every
  statement, and an advisory lock for the cap.
- Migration: `supabase/migrations/20261015000000_companion_devices.sql`, a system-only table.
- Web: `web/src/api/hooks/useCompanionDevices.ts` and `CompanionDevicesSection.tsx`.

**Boot refusal:** `FRAME_BUS_SECRET` is the precedent. `createBindings` throws
`FrameBusSecretError`, and `server/src/main.ts:30-36` exits before `DATA_DIR` is touched.

**Settings design reference:** `AdvancedSection.tsx` at commit `c831e510` on
`scratch/advanced-settings-design`. It is a mocked prototype; its MCP tab belongs to `mcp-server`.

### Assumptions, each with the command that tests it and what it showed

1. **Nothing encrypts at rest today**, so this adds the first cipher and needs an ADR.
   `grep -rn "createCipheriv\|pgp_sym" --include=*.ts --include=*.sql server packages supabase | grep -v node_modules | wc -l`
   → `0`.
2. **The next migration timestamp is free after `20261015000000`.**
   `ls supabase/migrations | tail -2` → `20261014000000_session_lease_started_at.sql`,
   `20261015000000_companion_devices.sql`.
3. **Production and stage both run `NODE_ENV=production`; dev runs `development`.**
   - `grep -n NODE_ENV compose.yaml docker/compose.dev.yaml docker/Dockerfile` →
     `compose.yaml:93: NODE_ENV: production`, `docker/compose.dev.yaml:49: NODE_ENV: development`,
     `docker/Dockerfile:153: ENV NODE_ENV=production`, `docker/Dockerfile:218: ENV
     NODE_ENV=development`.
   - Stage builds the production target, so stage gets no DeepGram fallback either.
4. **The DeepGram key is read in exactly one place in the package.**
   `grep -n DEEPGRAM_API_KEY packages/transcription/src/generateTranscript.ts server/src/routers/logImport.ts`
   → only `generateTranscript.ts:153`.
5. **Node supports AES-256-GCM, HKDF and `dns.lookup` with `all: true`.**
   `node -e "console.log(process.versions.node)"` → `24.21.0`.
6. **The secret-boot pattern exists.** `sed -n 25,45p server/src/main.ts` shows `createBindings`
   throwing `FrameBusSecretError`, which is caught and exits 1 before the data directory is
   touched.

## Goals / Non-Goals

**Goals:**
- Keys never leave the server in plaintext and never sit in the database in plaintext.
- One resolver decides which DeepGram key a request or job uses, so production can't fall back
  by accident.
- The connection test can't be turned into an SSRF probe in production.

**Non-Goals:**
- Using the `llm` credential. Nothing reads it except the test route, until
  `opencode-agent-harness`.
- Rotating the master key. `key_version` is stored for it, but there is only version 1.

## Decisions

### D1. Table and store

The migration is `supabase/migrations/20261016000000_user_provider_credentials.sql`, as
catalog-database "Provider credentials are stored in the catalog" specifies:
- primary key `(user_id, kind)`;
- the nonce, ciphertext and tag as `bytea`;
- system-only RLS following the `companion_devices` pattern.

**The store.** `PostgresProviderCredentialStore` in `packages/storage`, behind a
`ProviderCredentialStore` port in `packages/ports`. It runs on `bindSystem('provider-credentials')`,
a new reviewed reason: the core-ports-architecture delta lists it, and the repository allowlist
gains it. Its operations:
- `get(userId, kind)`
- `list(userId)`
- `put(userId, kind, row)` writes a new key: `insert … on conflict (user_id, kind) do update`
  setting every column.
- `updateKeepingKey(userId, kind, {provider, base_url, base_origin, model})` is one statement:
  `update … set base_url, model, updated_at_utc where user_id=$1 and kind=$2 and provider = $3
  and base_origin is not distinct from $origin` (owner decision 10: the provider is part of the
  key's destination, so a keep-key save never changes it). The `base_origin` column holds the normalized origin
  (`normalizeOrigin` in `server/src/auth/providerOutbound.ts`: WHATWG `URL` origin, which lowercases
  the scheme and host and drops the default port), and the AAD uses that same column value. It reads nothing first and never
  writes the key columns. It reports zero rows when the row is gone, or its provider or origin changed, and the
  route then answers `422`. This closes the panel's resurrection race.
- `delete(userId, kind)`
- `takeTestSlot(userId)` is one atomic upsert on the per-user window table
  `catalog.provider_test_windows` (re-panel: a window on the credential row was reset by deleting
  and re-saving the credential): `insert … values ($user, $now, 1) on conflict (user_id) do update
  set window_start_ms = case when $now - window_start_ms >= 60000 then $now else window_start_ms
  end, test_count = case when … then 1 else test_count + 1 end returning test_count`. More than 5
  means refused. The row lock serializes it across processes, and the time comes from the Clock
  port, so tests inject it. The route checks that the credential exists (`404`) before taking a
  slot. The migration `20261017000000_provider_test_windows.sql` creates the table and drops the
  two window columns from the credentials table.
- `readCheck()` and `writeCheckIfAbsent(value)` for the master-key check value, in the single-row
  table `catalog.provider_key_check`: `insert … on conflict (id) do nothing`, then read back. `kv`
  has no insert-if-absent and no atomic increment, so it isn't used here.

Every credential statement binds `user_id`. The store deals only in ciphertext; crypto lives in
the server.

Alternative: put the blob in `catalog.app_settings` or `kv`. Rejected because `kv` has expiry
semantics, and app settings are team-scoped and owner-writable.

### D2. Crypto and the master key (owner decision 2)

The module is `server/src/auth/providerKeyCrypto.ts`:
- **Master key:** `PROVIDER_KEYS_SECRET`, base64 decoding to exactly 32 bytes.
- **Derived keys:** HKDF-SHA256, with `info` `autologger provider keys v1` for the encryption
  key and `autologger provider keys check v1` for the check key. The raw secret is never used
  directly.
- **Encrypt:** `aes-256-gcm` with a 12-byte `randomBytes` nonce and a 16-byte tag. The AAD is
  `` `${userId}\0${kind}\0${provider}\0${origin}` ``, where `origin` is the row's `base_origin`
  for `openai-compatible` and the empty string for every other provider. A ciphertext therefore
  fails to decrypt once the row's provider or origin differs, a second guard behind the `422` of
  D4.
- **Decrypt:** checks `key_version === 1`. Any failure, whether the tag, the version or the
  length, becomes `null` plus one log line with the user id and kind.
- **Check value:** HMAC-SHA256 under the check key of the label `provider-keys-check`, hex.

**Boot** (`createBindings` option `providerKeys: 'required'`, passed only by `main.ts`, like
`frameBus: 'postgres'`):
1. Validate the secret, throwing `ProviderKeysSecretError` (missing or not 32 bytes).
2. Compute the check value and `writeCheckIfAbsent`.
3. Compare it with what is stored. A mismatch throws `ProviderKeysSecretError("PROVIDER_KEYS_SECRET
   does not match the stored provider keys")`.

Steps 2 and 3 need the catalog, so they don't run in `createBindings`:
- Step 1 runs in `createBindings`, before `acquireDataDirLock` (`server/src/node/config.ts:74`).
  `main.ts` catches the error next to `FrameBusSecretError` and exits 1.
- Steps 2 and 3 run in `main.ts` right after `waitForCatalog` (`main.ts:53`) and before the
  server listens. On a mismatch it logs the error, calls `close()` (releasing the lock) and exits
  1.

Without the option, a missing secret becomes a per-process random 32 bytes, and the check is
skipped. Tests and scripts that call `createBindings` therefore need no change. Integration tests
that save and read keys across processes set a fixed secret in the harness.

**Recovering from a lost secret** (runbook):
1. Delete every row of `user_provider_credentials`.
2. Delete the `provider_key_check` row.
3. Boot with the new secret.

Users then re-enter their keys.

**Where the secret comes from:**
- `docker/secrets-env.yaml` allows `PROVIDER_KEYS_SECRET`.
- `docker/scripts/compose-run.mjs` refuses a stack whose secret is missing or not 32 bytes (the
  local-container-environments delta).
- `docs/openbao-secrets.md` documents it for `dev`, `stage` and `prod`, generated with
  `openssl rand -base64 32`.

Alternatives:
- Supabase Vault or pgsodium: rejected by the owner.
- An envelope key per row: no benefit with one in-memory master key.
- No check value: rejected by the panel, because a wrong secret would boot cleanly and silently
  make every key unreadable.

### D3. Mode and credential resolution (owner decisions 1, 4)

**`Config.PROVIDER_DEV_MODE`** is a boolean set at boot. It is `true` only when `NODE_ENV` is
exactly `development` or `test`, so production mode is the default. Tests force production mode
with `envWith({PROVIDER_DEV_MODE: false})`. Nothing reads `NODE_ENV` at request time.

`resolveSttCredential(env, userId)` in `server/src/auth/providerResolve.ts` returns `{apiKey, model}`
or `null`:
1. Use the user's decrypted `stt` row.
2. Otherwise, when `PROVIDER_DEV_MODE` is true and `DEEPGRAM_API_KEY` is set, use the env key and
   `DEEPGRAM_MODEL`.
3. Otherwise return `null`.

`generateTranscriptWords` changes so that its deps take `stt: {apiKey, model} | null` instead of
reading `config`. When `stt` is `null` it throws `unavailable` with the new detail
`TRANSCRIPT_NEEDS_KEY`.

The callers:
- `transcribe.ts` resolves for `requireUser(c).id` in place of today's env-key check, so the
  frozen order holds: a `503` when unconfigured, then `requireRunFeature`'s `403`.
- `logImport.ts` resolves for `job.createdByUserId` at each `ensureTimedTranscript` call, after the
  approval check. With `null`, it logs the add-a-key line, takes no lease and makes no provider
  call.

`TRANSCRIPT_UNAVAILABLE` stays the detail for `transcribe.csv`, which is unchanged.

The profile is not changed (the panel cut the `providers` field).

### D4. Routes

`server/src/routers/providers.ts`, mounted at `/api/me/providers`:
- Cookie-only; `requireUser` already rejects device tokens outside `/api/companion/`.
- `GET` adds `run_features_allowed: runFeatureAllowed(config, user)`.
- Schemas go in `packages/contract/src/schemas.ts`:
  - `providerKindSchema`
  - `providerPutBodySchema`, split by kind with a `superRefine`. `model` and `api_key` match
    `^[\x21-\x7E]+$` after trimming. The `base_url` shape: no userinfo, query or fragment;
    `https` on port 443 in production mode.
  - `providerCredentialSchema`
  - `providersResponseSchema`
  - `providerTestResponseSchema`
- **`PUT` with `api_key`:** encrypt, then `put`.
- **`PUT` without `api_key`:** `updateKeepingKey` with the body's provider and, for
  `openai-compatible`, its normalized base URL origin. Zero rows answers `422` with `api_key` named
  in the issues. That covers no stored row, a changed provider or origin, and a concurrent delete
  or rotation.
- **Test rate limit:** `takeTestSlot(userId)` (D1) runs after the credential lookup and before any decryption or outbound work. A count
  above 5 answers `429`.
- The audit line is `console.info('provider credential <saved|deleted> user=<id> kind=<kind>')`.

### D5. Outbound policy and the test (provider-credentials)

`server/src/auth/providerOutbound.ts`:
- **Save time** (`PUT`): validate the URL shape as in D4.
- **Request time:** `resolveAllowedAddress(url, signal)` runs `dns.lookup(host, {all: true})`,
  raced against the test's single 10 s `AbortSignal`:
  - In production mode, it refuses when any address is in the blocked ranges: `0/8`, `10/8`,
    `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.168/16`, `198.18/15`,
    `224/4`, `240/4`, `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, `::ffff:0:0/96`
    (checked on the embedded v4), and `64:ff9b::/96` (checked on the embedded v4).
  - It connects through an undici `Agent` whose `connect.lookup` returns the vetted address, so
    the request goes to the address that was checked. TLS SNI and `Host` stay the original
    hostname.
- **Request options:** `redirect: 'manual'`; a 3xx maps to "unexpected (3xx)". The response body
  is read only for the `llm` model list, capped at 1 MB, and never logged.
- **Errors:** every thrown error is classified by its type or `code` into a fixed outcome. Its
  message and properties are never logged, returned or rethrown. A unit test checks this with a
  header-invalid key and a capturing logger.

**Result mapping (`detail` strings):**

| Outcome | `ok` | `detail` |
|---|---|---|
| connected | true | "Connected." |
| 401 or 403 | false | "The provider rejected the API key." |
| model not listed | false | "Connected, but the model wasn't found." |
| DNS failure, connect failure or blocked address | false | "Couldn't reach the provider." |
| timeout | false | "The provider didn't answer in time." |
| other status | false | "The provider answered unexpectedly (HTTP <status>)." |
| decrypt failed | false | "The saved key can't be read. Enter it again." |

**LLM tests per provider (owner decision 10).** Each reads model information, which costs no
usage. The fixed hosts are constants, so the IP policy applies only to `openai-compatible`.
Re-panel: the fixed-host providers fetch the one model rather than a paged list, which also
resolves Anthropic aliases (`model_id` is "Model identifier or alias").

| Provider | Request | Auth header | Result |
| --- | --- | --- | --- |
| `openai-compatible` | `GET {base_url}/models` | `Authorization: Bearer` | `data[].id` holds the model, or no list: connected; a list without it: model not found |
| `openai` | `GET https://api.openai.com/v1/models/{model}` | `Authorization: Bearer` | 2xx connected; 404 model not found |
| `anthropic` | `GET https://api.anthropic.com/v1/models/{model}` | `x-api-key`, `anthropic-version: 2023-06-01` | 2xx connected; 404 model not found |
| `google` | `GET https://generativelanguage.googleapis.com/v1beta/models/{model}` | `x-goog-api-key` | 2xx connected; 404 model not found; 400 with `error.details[].reason` `API_KEY_INVALID` key rejected |

The model is one percent-encoded path segment. For every provider, `401`/`403` is "key rejected".
The error body is read (capped at 1 MB) only for the Google reason, and is never returned or
logged.

**`ProviderTester` port.** The hosts come from a `ProviderTester` (`server/src/auth/providerTester.ts`)
wired at boot as `Bindings.ports.providerTester`. `createBindings` always builds it with the frozen
constant table (`Object.freeze`d `PROVIDER_HOSTS`) and reads no environment or config for it.
Integration tests replace the port with `envWith({}, {providerTester: new ProviderTester(fakeHosts)})`;
a unit test asserts `createBindings(...).bindings.ports.providerTester.hosts` equals the
constants under a hostile environment Proxy, like the existing credential-path test.

**DeepGram test (owner choice):** `POST https://api.deepgram.com/v1/listen?model=<model>` with
`Content-Type: audio/wav` and a committed 0.25 s, 16 kHz mono silent WAV (about 8 KB) as a
constant. The key goes only in the `Authorization: Token` header. It goes to the fixed host, so the
IP policy is not applied. Each test costs a fraction of a cent of the user's DeepGram usage, and
the help text says so.

### D6. Web

The design comes from the prototype `AdvancedSection.tsx` (`c831e510`), minus the MCP tab.

**Hook.** `web/src/api/hooks/useProviders.ts` provides:
- `useProviders()`: a GET query with key `['providers']`;
- `useSaveProvider(kind)`: a PUT that invalidates `['providers']`;
- `useDeleteProvider(kind)`;
- `useTestProvider(kind)`: a mutation with `gcTime: 0`.

The typed key is sent only in the PUT body. The mutation is then reset so its variables leave the
cache, and the key is never in a query.

**Section.**
- `sections.ts` gains the `advanced` id after `companion-devices`.
- `SettingsSections.tsx` maps it.
- The approval note shows when `run_features_allowed` is false.
- Each `ProviderPanel` uses `useInlineDraft` per kind. The Language model panel has a provider
  `Select` (OpenAI-compatible, Anthropic, OpenAI, Google); the Base URL row shows only for
  OpenAI-compatible. Changing the provider, or the OpenAI-compatible base URL's origin, switches
  the key row to the input with the new provider or host help.
- Remove uses `useConfirm`.

**Generation gating (web-session-console delta):**
- The transcription copy in `TranscribeFeed.tsx` (`:306`, `:352`) becomes the Settings → Advanced
  wording, with a button that opens Settings on `advanced`.
- `useGatedGenerate` exposes a reset. The transcript panel calls it when the `['providers']`
  query's `stt` changes from `null` to a credential, so saving a key clears the latch.

**Types and fixtures** follow commit `ef882ad2`: `api/types.ts`, `types.conformance.test.ts`, the
`fixtures/api-responses/providers*.json` files, and the server's
`apiResponseFixtures.int.test.ts`.

### D7. Existing tests that change, by category

1. **Transcript-generate unconfigured tests.** Their premise moves from "env key unset" to "caller
   has no key, in production mode", and the expected detail becomes the new string.
2. **Transcription unit tests that pass `config` with `DEEPGRAM_API_KEY`** now pass
   `stt: {apiKey, model}`.
3. **Log-import tests that rely on the env key** seed a credential for the job creator, or run in
   development mode.
4. **Schema snapshots** (`catalogSchema.pg.test.ts`, `catalogPolicies.pg.test.ts`) gain the table.
   The table is system-only, so the user-policy counts don't change.
5. **The system-binding allowlist test** gains the `provider-credentials` entries.
6. **`SettingsView.test.tsx`** gains `advanced` in the stub list and the You-group order.
7. **`generateLatch.test.tsx`** and any test asserting the `DEEPGRAM_API_KEY` transcription copy
   now assert the Settings → Advanced copy.
8. **Boot tests that spawn `main.ts`** (`bootOrder.int.test.ts`, `bootFrameBus.int.test.ts`) add
   `PROVIDER_KEYS_SECRET` to their env so they still reach the failure they assert.
9. **`compose-run` and invariant tests** (`docker/scripts/*`) gain the `PROVIDER_KEYS_SECRET`
   requirement.
10. (Owner decision 10) **`providerKeyCrypto.test.ts` bindings gain `provider`**, now a required
    part of the binding.
11. (Re-panel) **The 2.2 store tests of `takeTestSlot`** call `takeTestSlot(userId)` on the
    per-user window, and the schema snapshots lose the two window columns and gain
    `provider_test_windows`.

Any other existing test change is a stop: update the artifacts and ask the owner.

## Risks / Trade-offs

- **Losing `PROVIDER_KEYS_SECRET` means re-entering every key.** → Boot refuses a wrong secret
  rather than running with dead keys. The runbook gives the reset steps.
- **Production users lose transcription until they add a key** (owner decision 4). → The `503`
  detail, the panel copy and the log-import line all name Settings → Advanced. The release note
  warns operators.
- **A compromised server process can decrypt every key**, because the master key is in memory. →
  That is accepted by design, since the server must use the keys. The ADR and `docs/security.md`
  record it, and the table is system-only.
- **A stolen session can still use a victim's key against its saved host,** for example by running
  tests. → It can't redirect the key elsewhere (the origin binding) or read it. Tests are
  rate-limited, and the DeepGram test spends almost nothing.
- **DNS answers differ between the check and the connect.** → The vetted address is pinned on the
  connection (D5).
- **Tests run in development mode**, so the dev fallback could hide production-mode behavior. →
  Every production-mode scenario sets `PROVIDER_DEV_MODE: false` explicitly.

## Migration Plan

1. Add `PROVIDER_KEYS_SECRET` to OpenBao `dev`, `stage` and `prod`; compose refuses without it.
2. Deploy. The migration runs before the app, as usual. The first boot writes the check value.
3. Announce that each user adds a DeepGram key in Settings → Advanced.

**Rollback:** revert the code, then drop both tables.
Stored keys are lost. `PROVIDER_KEYS_SECRET` can stay in OpenBao because the allowlist tolerates
it.
