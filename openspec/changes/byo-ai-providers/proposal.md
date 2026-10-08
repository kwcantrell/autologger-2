# Bring your own AI providers: per-user, encrypted provider keys and Settings → Advanced

Tier: 2
Tier reason:
- it stores user secrets (provider API keys) and adds encryption at rest, the first crypto of its
  kind in the codebase; secrets work is human-led, so the owner owns the design;
- a migration adds a table (`supabase/migrations/**`);
- the frozen contract changes: four new `/api/me/providers` routes, and transcript generation's
  `503` now depends on the caller's key, with a new detail (`packages/contract/**`,
  `server/src/routers/**`).

Approved-by: Kalen 2026-10-08 (again)

## Why

In production every user shares the operator's one Claude CLI login and one `DEEPGRAM_API_KEY`.
Nothing is per user:
- a team that wants AI or transcription has to get the operator to pay for it;
- usage can't be attributed;
- a deployment with no operator keys has no AI features at all.

Users should bring their own provider accounts.

This change is the first of two:
1. **This one** stores per-user provider credentials safely and moves transcription onto the
   caller's own DeepGram key.
2. **`openai-compatible-agent`** (follow-up) replaces the Claude CLI with a tool-calling loop on
   the caller's OpenAI-compatible LLM.

The MCP server for Claude users is a third, separate change (`mcp-server`).

## Owner decisions (owner, 2026-10-08)

1. **Keys are per user.** Each user's keys are used only for that user's requests and jobs.
2. **AES-256-GCM in the server, with a master key from OpenBao** (`PROVIDER_KEYS_SECRET`). A stored
   key is write-only: no response ever returns it. Only its last four characters are shown back.
3. **DeepGram for speech to text now**, with the `kind`/`provider` shape left open for other STT
   providers later.
4. **No env-key fallback in production.**
   - In production mode, a user without a DeepGram key gets the "unconfigured" answer.
   - In development mode, `DEEPGRAM_API_KEY` stays a fallback so local work and tests run.
5. **The LLM credential is stored and testable in this change**, but nothing calls the LLM with it
   until `openai-compatible-agent`.
6. **AI v2 dashboards are out of scope.** They keep their own `AI_V2_*` configuration.
7. (After the panel) **Users who aren't approved are told in Advanced** that transcription and AI
   are limited to approved users. The frozen order of the config `503` and then the approval `403`
   stays.
8. (After the panel) **Connection tests are limited** to 5 a minute per user. Production-mode LLM
   URLs are `https` on port 443 with no query, and a refused host reads as unreachable.
9. (After the panel) **The DeepGram test sends a tiny silent clip** rather than listing projects,
   so a key scoped only to transcription tests as valid.
10. **The Settings design comes from the live-mode prototype** (scratch branch commit `c831e510`):
   - a new "Advanced" section in the You group;
   - Language model and Speech to text tabs;
   - shadcn primitives only.

## What changes

- **Migration** `20261016000000_user_provider_credentials.sql`: `catalog.user_provider_credentials`.
  - One row per user and kind (`llm`, `stt`), holding:
    - the provider, base URL and model;
    - the encrypted key (IV, ciphertext, tag, key version);
    - the key's last four characters.
  - System-only like `companion_devices`: every statement is scoped by the caller's user id in SQL.
- **Key encryption.**
  - AES-256-GCM, with a fresh 12-byte IV per write.
  - The user id, the kind and, for the LLM, the base URL's origin are bound as additional
    authenticated data. So a ciphertext copied to another row, or a key pointed at a new host,
    fails to decrypt.
  - Changing the LLM base URL's host requires entering the key again, so a stolen session can't
    redirect a stored key.
  - `PROVIDER_KEYS_SECRET` (32 bytes, base64) is required at boot. The server records a check
    value and refuses to boot with a secret that doesn't match it. The secret reaches every
    environment through OpenBao, and compose refuses a stack without it.
- **Routes** (cookie-only, own rows only):
  - `GET /api/me/providers`
  - `PUT /api/me/providers/:kind`
  - `DELETE /api/me/providers/:kind`
  - `POST /api/me/providers/:kind/test`
- **Connection test** (5 a minute per user):
  - LLM: `GET {base_url}/models`. In production mode the base URL must be `https` on port 443,
    with no query, and must not resolve to a loopback, private, link-local or otherwise reserved
    address.
  - DeepGram: a 0.25 s silent clip sent to `/v1/listen` with the chosen model.
  - Results are fixed, server-authored strings; upstream bodies and error messages are never
    echoed or logged.
- **Production mode is the default.** Development mode, which enables the DeepGram fallback and
  local model URLs, applies only when `NODE_ENV` is exactly `development` or `test`.
- **Transcription uses the caller's key.**
  - `POST …/transcript-words/generate` uses the caller's DeepGram key and model.
  - Sheets log import uses the job creator's key.
  - Without one, both get the unconfigured `503`, with a new detail that points to Settings →
    Advanced. In development only, they fall back to `DEEPGRAM_API_KEY` first.
- **Web.**
  - Settings → Advanced (You group, after Companion devices) with Language model and Speech to
    text tabs. For each provider: fields, a write-only key with Replace and Remove, Test connection
    and a save bar.
  - Users who aren't approved for run features see a note in the section saying so, before they
    add a key.
  - The transcript panel's unavailable copy names Settings → Advanced instead of
    `DEEPGRAM_API_KEY`, and saving a key clears the panel's latch without a reload.
- **Docs and config:**
  - the README endpoint table, AI and transcription sections, and the prod runbook;
  - `docs/openbao-secrets.md` and `docs/security.md`;
  - the env examples, `docker/.env.example` included;
  - `docker/secrets-env.yaml` (allow `PROVIDER_KEYS_SECRET`);
  - a new ADR for keys at rest.

## Capabilities

### New Capabilities
- `provider-credentials`: per-user provider credentials, covering:
  - encryption at rest, and the write-only key;
  - the connection test and its outbound-URL rules;
  - how a request or job resolves the credentials it runs with.

### Modified Capabilities
- `api-contract-freeze`: the four new routes, and transcript generation's unconfigured row and
  detail.
- `transcript-generation`: the configuration gate becomes per-user, with the development fallback.
- `sheets-log-import`: generation runs on the job creator's key.
- `catalog-database`: the new table.
- `web-ui-system`: the Advanced section and the updated section list.
- `web-session-console`: the transcription unavailable copy and its latch.
- `core-ports-architecture`: the `provider-credentials` system-binding reason.
- `local-container-environments`: compose refuses a stack without `PROVIDER_KEYS_SECRET`.

## Impact

- **Operators:**
  - set `PROVIDER_KEYS_SECRET` in OpenBao (dev, stage, prod) before deploying;
  - users then add their own DeepGram keys;
  - in production, the operator's `DEEPGRAM_API_KEY` stops being used. Every user without a key
    loses transcript generation until they add one.
- **Losing `PROVIDER_KEYS_SECRET`** makes every stored key unreadable. Users must re-enter their
  keys; nothing else is lost. The runbook says so.
- **Code:**
  - `packages/ports`: a credentials port;
  - `packages/storage`: a Postgres store;
  - `server/src/auth`: key crypto;
  - `server/src/routers/providers.ts` (new), plus `transcribe.ts` and `logImport.ts`;
  - `packages/transcription`: the key is passed in, not read from config;
  - `packages/contract`: schemas;
  - `web/src/pages/index/components/settings/*`, a new hook, `TranscribeFeed.tsx` and
    `useGatedGenerate.ts`;
  - `docker/scripts/compose-run.mjs`;
  - the migration, README, docs, env examples and ADR.
- **Egress:** connection tests go to user-chosen LLM hosts (production: public `https` only), and
  DeepGram calls are billed to users.

## Non-goals

- Calling the LLM with the stored credential, removing the Claude CLI, or changing AI chat, topic
  or event generation (`openai-compatible-agent`).
- The MCP server and MCP keys (`mcp-server`). The prototype's MCP tab is not built here.
- AI v2 dashboards.
- Team-level or admin-managed keys, and sharing a key between users.
- STT providers other than DeepGram, and a DeepGram base URL setting.
- Rotating `PROVIDER_KEYS_SECRET`. The key version column makes it possible later; no rotation
  tooling ships.
