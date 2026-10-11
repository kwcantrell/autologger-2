# AI SDK agent harness: AI turns run on each user's own language model

Tier: 2
Tier reason:
- AI turns start sending the user's decrypted provider key to model providers from the server
  (secrets, egress); secrets work is human-led, so the owner owns the key-handling design;
- a migration changes `catalog.user_provider_credentials` (`supabase/migrations/**`);
- the frozen contract changes: the chat request body and `done` event, the `503` details of chat,
  topic generation and event generation, and the provider routes (`packages/contract/**`,
  `server/src/routers/**`).

Approved-by: Kalen 2026-10-11

## Why

`byo-ai-providers` lets each user save a language model credential (OpenAI-compatible, Anthropic,
OpenAI or Google), but nothing runs on it. AI chat, topic generation and event generation still
spawn the operator's one `claude` CLI login. So every user spends the operator's subscription,
and a deployment without that login has no AI at all. Anthropic also doesn't allow a Pro/Max
subscription to serve other people.

This change runs those three features on the caller's own credential, through an in-process tool
loop built on the Vercel AI SDK. It keeps the Claude CLI only for the operator's own allowlisted
accounts.

## Owner decisions (owner, 2026-10-08 to 2026-10-11)

1. **The harness is the Vercel AI SDK, in process** (2026-10-11).
   - This replaces the earlier choice of an OpenCode process per turn, whose panel showed it
     needed a sidecar container, a key relay and per-turn OS users to be safe (panel.md).
   - The model can call only the turn's autologger tools; nothing it drives can run commands or
     read files.
2. **The client re-sends the chat history** for AI SDK turns. Nothing about the conversation is
   stored on the server.
3. **The Claude CLI stays for allowlisted "dev" accounts, production included.**
   - The allowlist is `CLAUDE_CLI_EMAILS`, set per environment in OpenBao and matched like
     `RUN_FEATURE_EMAILS`. No email goes in a committed file.
   - Those accounts choose "Claude CLI (operator)" in the Settings → Advanced provider picker.
     Everyone else, and listed accounts that pick another provider, run on their own key.
   - The CLI path keeps its server-side resume (`claude_session_id`).
4. **No development-mode CLI fallback.** The CLI runs only for an allowlisted user who picked
   it, in every mode.
5. **AI v2 dashboards are out of scope.** They keep the Agent SDK and `AI_V2_*`.
6. **The MCP server for Claude users is a separate change** (`mcp-server`).
7. **Private and `http` model hosts stay development-only**, and the API key stays required.
8. **Real-provider tests are opt-in.** An `*.real.test.ts` runs only when `REAL_LLM_ANTHROPIC_KEY`
   is set, on the owner's organization API credits, plus a manual dev-stack check. CI never runs
   it.
9. **No deployment-wide concurrency ceiling in this change** ("Defer").

## What Changes

- **Per-user AI route.** Each AI turn resolves the caller's route:
  - the Claude CLI (allowlisted and chosen);
  - the AI SDK on the caller's `llm` credential;
  - or none, which answers `503` with a detail pointing to Settings → Advanced.

  `CLAUDE_CLI_PATH` no longer enables AI for everyone.
- **AI SDK turn** in `@autologger/ai-runtime`: `streamText` with the turn's tools, built from the
  same tool bodies the MCP server uses.
  - It is bounded by a step cap, output tokens per step, a per-turn token budget, retries and the
    route timeout.
  - Its stream maps onto the existing SSE events and generation results.
  - The single-flight slot, run lease and timeouts are reused.
- **Every model request goes through the server's outbound guard:**
  - the key goes only to the credential's fixed host or saved origin;
  - pinned DNS, with the production address rules applied per connection;
  - no redirects, and per-turn request and size caps.

  Provider errors are classified only, never logged or forwarded, because they carry the whole
  prompt.
- **Chat contract.** The request gains an optional bounded `history`; `done.claude_session_id`
  becomes `string | null` (null on AI SDK turns). **BREAKING for strict clients** that require a
  string; the web client is updated in the same change.
- **`503` details change** for chat, topic generation and event generation: they name Settings →
  Advanced instead of `CLAUDE_CLI_PATH`.
- **"Claude CLI (operator)" provider option.**
  - `PUT /api/me/providers/llm` accepts `{provider: "claude-cli"}` with no key, base URL or
    model, only from allowlisted callers (`403` otherwise).
  - `GET /api/me/providers` adds `claude_cli_allowed`.
  - A migration lets that one provider's row hold no key.
- **Web.**
  - The picker shows the CLI option to allowlisted users.
  - The chat, topics and events not-configured copy points to Settings → Advanced, and clears
    when a language model is saved.
  - Chat sends its history.
- **Dependencies.** `ai` and the four `@ai-sdk/*` provider packages, pinned exactly.
  `CLAUDE_CLI_EMAILS` joins the OpenBao allowlist. No image or compose change.

## Non-goals

- AI v2 dashboards, which stay on the Agent SDK.
- The MCP server and MCP keys for Claude users (`mcp-server`).
- Storing chat history on the server.
- A dollar spend cap (provider prices vary). Steps, tokens, time and request caps bound a turn,
  and the user pays their own provider.
- Changing `AI_PROVIDER` or the run-ceiling policy it carries, and any deployment-wide
  concurrency ceiling.
- The AI SDK gateway, UI hooks or harness agents.
- Other speech-to-text providers, or other `llm` providers beyond the four plus `claude-cli`.
- Streaming topic or event generation; both stay synchronous JSON.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `ai-topics-chat`:
  - the configuration gate becomes the per-user route;
  - the request contract gains `history`;
  - continuity covers both routes;
  - the toolset, lockdown, lifecycle and spend requirements cover the AI SDK route;
  - a new requirement covers the guarded model requests;
  - egress disclosure names the user's provider.
- `topic-generation`: generation runs on the caller's route; the configuration gate and its
  `503` change.
- `auto-event-generation`: the guard ladder's configuration gate becomes the caller's route;
  generation runs on either runner.
- `provider-credentials`:
  - the `claude-cli` option and its allowlist;
  - `llm` credentials run AI turns;
  - model requests follow the destination and address rules.
- `api-contract-freeze`:
  - the chat body and `done`;
  - topic generation's unconfigured `503`;
  - the provider routes' `claude-cli` save and `claude_cli_allowed` field.
- `catalog-database`: the credentials table allows a keyless `claude-cli` row.
- `local-container-environments`: `CLAUDE_CLI_EMAILS` is an allowlisted secret; the dev
  environment's CLI features need the saved `claude-cli` choice.
- `web-session-console`: the not-configured copy and latch reset for chat, topics and events.
- `web-ui-system`: the Language model picker's CLI option.

## Impact

- **Code:**
  - `packages/ai-runtime`: the new AI SDK turn, tools and stream mapping; `TOOL_BUILDERS`
    refactored so the MCP server and the AI SDK share tool bodies;
  - `server/src/auth/providerResolve.ts` (route resolution) and `providerOutbound.ts` (a guarded
    streaming `fetch`);
  - `server/src/routers/{ai,transcribe,events,providers}.ts`;
  - `server/src/env.ts` and config;
  - `packages/contract/src/schemas.ts`;
  - the `packages/storage` credential store;
  - the web chat, generation latches and Advanced section.
- **Database:** one migration on `catalog.user_provider_credentials`.
- **Deployment:** `docker/secrets-env.yaml`, env examples and `docs/openbao-secrets.md`
  (`CLAUDE_CLI_EMAILS`). No image or compose change.
- **Docs:** README AI sections and endpoint rows, `docs/security.md`, ADR 0028.
- **Dependencies:** `ai@7.0.137`, `@ai-sdk/anthropic@4.0.78`, `@ai-sdk/openai@4.0.91`,
  `@ai-sdk/google@4.0.93`, `@ai-sdk/openai-compatible@3.0.67` (exact pins).
