# Design: ai-sdk-agent-harness

## Context

See proposal.md "Why". The current state that shapes the approach:

- **One CLI turn path.** AI chat (`server/src/routers/ai.ts`), topic generation
  (`transcribe.ts` → `generateTopicsTurn`) and event generation (`events.ts`) all run
  `driveAiTurn` (`packages/ai-runtime/src/aiTurn.ts`):
  - register an MCP turn (per-turn bearer token, tool set) on the in-process MCP listener
    (`aiMcpServer.ts`);
  - spawn the `claude` CLI (`aiChatRunner.ts`);
  - relay its stream-json (`aiChatRelay.ts`) through `runOuterAiTurn` (timeout, abort, a single
    ending event);
  - kill the process group in `finally`.

  The shared per-session slot (`aiChatTurns`) and the `ai-turn` run lease (`_aiSlot.ts`) sit in
  front of it.
- **The tool bodies live in `TOOL_BUILDERS`** (`aiMcpServer.ts:713-860`):
  - `get_transcript_words` (compact, or paged at generation density);
  - `list_topics`;
  - `create_topic` (validated by `topicCreateSchema`);
  - `create_event` (capped per run).

  Each resolves the session hub as the caller inside the body, and reads its session from the
  turn registration, never from an argument.
- **The gates.** Each route's gate is `aiChatConfigured(env)` (`CLAUDE_CLI_PATH` non-blank), then
  the approved-user `403` (`runFeatureAllowed`).
- **The unused `llm` credential.** Users save it (`byo-ai-providers`); only the connection test
  reads it. `resolveSttCredential` (`server/src/auth/providerResolve.ts`) is the pattern for
  per-user resolution. `providerOutbound.ts` already has the pinned-DNS, blocked-range,
  no-redirect request used by the connection test.
- **History.** An earlier draft of this change ran OpenCode per turn in a sidecar container.
  The panel found that design needed OS isolation, a key relay and new deployment machinery
  (panel.md, first panel and re-panel). The owner switched to the Vercel AI SDK, an in-process
  library (2026-10-11).

## Goals / Non-Goals

**Goals:**
- One AI turn abstraction with two runners behind the same slot, lease, timeout, abort and tool
  bodies:
  - **CLI** (unchanged, allowlisted accounts);
  - **AI SDK** (in process, on the caller's key).
- A model that can do nothing but call the turn's tools: no shell, file or web capability exists
  in the process the model drives.
- Every model request goes through the server's outbound guard. A key never leaves the server
  except in the request header to its provider.

**Non-Goals:**
- Using the AI SDK gateway, UI hooks or harness agents. Only AI SDK Core and the four provider
  packages are used.
- Changing the MCP listener, which the CLI path keeps using.
- Changing the tool set, renderings or write paths.
- Changing `AI_PROVIDER`, the run ceilings, or adding a deployment-wide ceiling.

## Decisions

### D1. Route resolution: `resolveLlmRoute(env, user)`
Added to `server/src/auth/providerResolve.ts`. It returns `{kind:'cli'}`,
`{kind:'sdk', provider, baseUrl, baseOrigin, model, apiKey}` or `null`:

1. **The saved `llm` row is `claude-cli`:**
   - **CLI** when `CLAUDE_CLI_PATH` is set and the caller is on `CLAUDE_CLI_EMAILS`;
   - otherwise **null**. A user removed from the list stops getting the CLI on the next turn,
     and gets the "add a language model" `503` until they pick another provider.
2. **Another `llm` row:** decrypt it as `resolveSttCredential` does, giving **SDK**, or **null**
   when it does not decrypt.
3. **No row:** **null**, in every mode. There is no development-mode CLI fallback (owner,
   2026-10-11, after the panel): an allowlisted developer picks "Claude CLI (operator)" once in
   Settings, so tests and dev exercise the same path as production.

**Allowlist matching** reuses `asciiEmailNorm` and `bootstrapEmailMatch` (`server/src/env.ts`)
through a new `claudeCliAllowed(env, user)`. Unlike `RUN_FEATURE_EMAILS`, the bootstrap owner is
**not** implicitly on this list: the list names exactly who may use the operator subscription.

**Gate order** stays frozen: session `404`, configuration `503`, approved-user `403`, body, `409`.
The route resolution *is* the configuration gate. It needs the caller, which every AI route
already has before the gate.

*Alternatives considered.* A boot-time global switch was rejected because the owner wants both
runners in one deployment. Putting the CLI choice in a separate preference row was rejected:
the credential row already is "this user's language model choice", and a second source of truth
could disagree with it.

### D2. The `claude-cli` provider row
- **Migration** `20261018000000_claude_cli_provider.sql`:
  - drops `not null` from `key_nonce`, `key_ciphertext`, `key_tag`, `key_version` and
    `key_last4`;
  - adds the check constraint `user_provider_credentials_claude_cli_check`:
    - when `provider = 'claude-cli'`, all five are null, `kind = 'llm'` and `base_url` is null;
    - for every other provider, **each** of the five is non-null, so a keyed row can never be
      partly null (which the dropped `not null` used to guarantee);
  - leaves the `model` column non-null; the server stores the fixed value `claude-cli`.
- **Port.** `ProviderCredentialStore` gains `putKeyless(userId, 'llm', 'claude-cli')`. The
  `get`/`list` shapes make `key` nullable, and every reader handles null.
  `resolveSttCredential` can't see a `claude-cli` row, because the kind is `llm`.
- **Wire.** The credential shape keeps `{kind, provider, base_url, model, key_last4,
  updated_at}`, with `key_last4: null` and `model: "claude-cli"` for this row.
  `GET /api/me/providers` adds `claude_cli_allowed`, which is true when the caller is on
  `CLAUDE_CLI_EMAILS` and `CLAUDE_CLI_PATH` is set.
- **PUT** `{provider:'claude-cli'}` (no `api_key`, `base_url` or `model`) from a caller for whom
  `claude_cli_allowed` is false gets
  `403 {"detail": "The Claude CLI is limited to approved operator accounts."}` and stores
  nothing.
- **Switching** from `claude-cli` to a key provider follows the existing rule that a new
  provider needs a key.
- **The connection test** for `claude-cli` makes no outbound request. It answers
  `{ok:true, detail:"Connected."}` when the caller would resolve to the CLI now, and otherwise
  `{ok:false, detail:"The Claude CLI isn't available to this account."}` (a new fixed string).
  It still takes a slot in the rate window.

### D3. The AI SDK turn (`packages/ai-runtime/src/sdkTurn.ts`)
Plugged into `driveAiTurn` as a second strategy next to the CLI spawn. It reuses
`runOuterAiTurn` (timeout, abort, one ending event). Versions are pinned exactly (D7).

**Inputs are injected** (package-architecture: `ai-runtime` imports nothing under
`server/src`). The route passes a required `SdkTurnDeps`:
`{provider, baseURL, model, apiKey, fetch}`.
- `baseURL` is computed server-side: `PROVIDER_HOSTS[provider]` plus the provider's path, or the
  saved `base_url`.
- `fetch` is the server's guarded fetch (D4).
- Construction throws when `fetch` is missing or not a function, or `apiKey` is not a non-empty
  string. Otherwise the AI SDK would silently fall back to `globalThis.fetch` (unguarded) or to
  `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` and `*_BASE_URL` in the
  environment (re-panel, A17, A18).

**Model.** Built with the provider factory; never a model-id string. A string routes through the
Vercel gateway dependency, so a repo test forbids it.

| Provider | Model | `baseURL` | Notes |
| --- | --- | --- | --- |
| `anthropic` | `createAnthropic(…)(model)` | `https://api.anthropic.com/v1` | `providerOptions.anthropic.cacheControl = {type:"ephemeral"}` (automatic prompt caching, 5-minute TTL): Anthropic places the breakpoint on the last cacheable block and moves it forward as the turn grows, so each step re-reads the earlier context from cache. Cache reads don't count toward Anthropic's input-tokens-per-minute limit and cost 0.1× input (0.05× on Opus and Sonnet 5.5) (owner, 2026-10-12, after a long-transcript generation failed; A41) |
| `openai` | `createOpenAI(…)(model)` (Responses API) | `https://api.openai.com/v1` | `providerOptions.openai.store = false`, so OpenAI does not retain the prompt (its default is to store, A19) |
| `google` | `createGoogleGenerativeAI(…)(model)` | `https://generativelanguage.googleapis.com/v1beta` | |
| `openai-compatible` | `createOpenAICompatible({name:"llm", includeUsage:true, …})(model)`, wrapped with `extractReasoningMiddleware({tagName:"think"})` | the saved `base_url` | servers without a reasoning parser (e.g. Qwen on SGLang) inline `<think>…</think>` in content; the middleware turns it into reasoning parts, which are not relayed (verified A20, including a tag split across chunks). A server whose chat template opens `<think>` inside the prompt emits only `</think>` (A39), and its reasoning would pass through as text. So the guarantee is scoped: reasoning in the provider's reasoning field, or between `<think>` and `</think>`, is never relayed. The README and the Settings help say to enable the server's reasoning parser (as the owner's SGLang does: `reasoning_parser: qwen3`). |

Every factory gets `apiKey`, `baseURL` and `fetch`, and no extra `headers`.

**Tools.** Shared with the MCP server through the builders' existing seam. Each `TOOL_BUILDERS`
entry already calls `server.tool(name, description, shape, handler)`. That parameter is typed as
a minimal `ToolSink` interface. The MCP server passes itself; `sdkTools(registry, registration)`
passes a collector that turns each registration into an AI SDK `tool()`. So the bodies, the
per-turn choice of the paged or unpaged `get_transcript_words` shape, and the MCP tests stay
untouched (re-panel).

The collector wraps every handler. The wrapper:
1. **Checks the turn is live.** A call after abort, timeout or the end of the turn returns
   the fixed "turn ended" error and runs nothing.
2. **Counts calls.**
   - **Per step, a soft cap of 16 calls.** Calls past it get the tool error "Too many tool calls
     in one step; continue in the next step." The turn continues, because the event prompt asks
     for one `create_event` per hit, and a step can legitimately hold many (fresh review).
   - **Per turn, a hard cap:** chat 32, generation 300, which covers 200 events plus transcript
     pages and the soft-capped retries. Past it, the wrapper sets the turn's `breach` flag and
     aborts the turn's internal `AbortController`, and nothing more runs.
3. **Serializes.** One tool body runs at a time per turn. The SDK starts parallel calls
   concurrently (A21), and serializing bounds the work a single step can start in the shared
   process.
4. **Translates** the MCP result: a text result passes through; an `isError` result becomes a
   tool error carrying the body's own validation text (as on MCP); a thrown error becomes the
   fixed string "Tool failed.". The SDK otherwise sends the thrown message to the model (A22).
5. **Tracks** the in-flight promise in the turn's drain set.

The registration is the existing per-turn object (session, caller, tool set, generation
snapshot, created-events counter, page state), made by a new listener-free
`registerSdkTurn(...)`. `registerTurn` requires the started listener and mints a token (A23).
The session comes from the registration, never from a tool argument.

A turn gets exactly its kind's tool set:
- chat: `get_transcript_words`, `list_topics`, `create_topic`;
- topics: `get_transcript_words`, `create_topic`;
- events: `get_transcript_words`, `create_event`.

**Call.**
```ts
streamText({
  model, system, messages, tools,
  stopWhen: [isStepCount(steps), tokenBudget(maxTotalTokens, usageEstimate)],
  maxOutputTokens, maxRetries: 2, abortSignal,
  providerOptions, onError: () => {},
})
```
- `messages` is the chat history (D6) plus the new user message; for generation, the existing
  one-shot message.
- `system` is the existing system prompt for the turn kind, unchanged. The prompts already name
  tools by bare names; only the CLI's `--allowedTools` and its relay use the
  `mcp__autologger__` prefix.
- `maxOutputTokens` is always set. Without it Anthropic requests `max_tokens: 128000` (A24).

**The token budget.**
- `tokenBudget` is a custom `StopCondition` over the accumulated billable tokens: each step's
  `usage.totalTokens` minus its `inputTokenDetails.cacheReadTokens` when reported (A25, A41). Cache
  reads are excluded because they don't count toward provider rate limits and cost a fraction of
  input; uncached input, cache writes and output do count (owner, 2026-10-12).
- For a step whose provider reports no usage (an OpenAI-compatible server that ignores
  `include_usage`, A26), it counts an estimate instead: (that step's request and response body
  bytes, counted by the guarded fetch) ÷ 4. So the budget never silently turns off.
- It is checked after each step, so a turn can overrun by at most one step, bounded by that
  step's context and `maxOutputTokens`.

**How a turn ends.** The turn decides from its own step records, never from the SDK's
`finishReason` alone. Servers can report `stop` while still emitting tool calls, `length` with an
unexecuted call, or `tool_calls` with none (fresh review, A33). An `onStepFinish` callback records
each step's tool-call count, tool-result count and finish reason. The result promises
(`steps`, `text`, `finishReason`, `totalUsage`) are never awaited; each gets a no-op `.catch`
when the call is made, because they reject after an abort or an error (A34).

| Ending (checked in this order) | Chat | Generation |
| --- | --- | --- |
| **breach**: the `breach` flag is set (tool-call cap, or a guarded-fetch cap) | `error upstream-failed` | failure |
| **abort**: the route's signal (client abort, or `runOuterAiTurn`'s timeout) | as today: `timeout`, or nothing for a client abort | as today |
| **error**: an `error` part, or `fullStream` throwing (a dropped provider stream throws instead of emitting a part, A27) | `error upstream-failed` | failure |
| **capped**: the step count reached `steps`, the token budget fired, or the last recorded step had tool calls | `done`; the text so far is the answer | **failure**: topics `502` with prior topics unchanged; events `502` with no regenerate delete (re-panel critical) |
| **incomplete**: the last step's finish reason is `length`, `content-filter`, `error` or `other` | `done` with the text so far | failure |
| **natural**: none of the above (the last step had no tool calls and finished `stop`) | `done {claude_session_id: null}` | the generation result |

The `breach` flag is checked before the abort row, so a cap breach is never mistaken for a client
abort, and a chat turn always ends with exactly one terminal event (or none for a client abort,
as the frozen SSE rule allows).

**Draining tool bodies.**
- `runOuterAiTurn` is reused unchanged. On timeout it emits the terminal `timeout` and then
  aborts, as today.
- The **route** waits for the turn's drain set to settle after `driveAiTurn` returns, and
  before it acts on a generation result (the replace-all or the regenerate delete), removes a
  failed run's new topics, or releases the session slot and run lease. The lease keeps renewing
  while it waits.
- Tool bodies take no signal, so the wait has no timer of its own. A body is hub operations
  bounded by the app role's `statement_timeout = '30s'` per statement
  (`supabase/migrations/20261001000000_catalog_schema.sql:137`), so it settles.
- From the moment the turn is not live, the wrapper refuses new calls. So once the drain set is
  empty, no tool body runs for the turn.

**Stream mapping** (`sdkRelay.ts`). The `fullStream` iteration is wrapped in `try`/`catch`; a
throw is classified (D5).

| Part | What the turn emits |
| --- | --- |
| `text-delta` | `delta {text}` |
| `tool-call` with `invalid !== true` and a name in the turn's set | `tool {name}` |
| `tool-call` otherwise (undefined tool, or the model's own invented name, A28) | nothing |
| `finish` | the ending row above |
| `error` | the error row above |
| `abort` | resolved by the ending table (breach, or abort) |
| everything else, including `reasoning-*` | ignored |

Generation results (`createdEvents()`, `pageCoverage()`, the topics replace-all) come from the
registration, as today.

**Limits** (optional `Config` fields, with these defaults):

| Turn kind | `steps` | `maxOutputTokens` per step | `maxTotalTokens` | Tool calls per turn |
| --- | --- | --- | --- | --- |
| chat (`AI_CHAT_MAX_STEPS`, `AI_CHAT_MAX_TOKENS`) | 8 | 4000 (fixed) | 400 000 | 32 |
| generation (`GENERATE_MAX_STEPS`, `GENERATE_MAX_OUTPUT_TOKENS`, `GENERATE_MAX_TOKENS`) | 40 | 16 000 | 3 000 000 | 300 |

- `*_MAX_STEPS` sets `steps`, and `*_MAX_TOKENS` sets the per-turn `maxTotalTokens` budget.
- **`GENERATE_MAX_OUTPUT_TOKENS`** (default 16 000) sets generation's per-step output cap (owner,
  2026-10-12). A generation step writes a batch of `create_event` / `create_topic` calls in one
  response. On a 2h52m transcript, step 7 hit 4000 and was cut off mid-call: the dev log showed
  `(ending=incomplete, steps=7, last=length)`, and the run failed with no events written (A42).
  Chat's 4000 stays fixed.
- **Valid ranges** (validated values only; blank, non-numeric or out-of-range falls back to the
  default): `GENERATE_MAX_OUTPUT_TOKENS` 1 000–128 000, `AI_CHAT_MAX_STEPS` 1–50,
  `GENERATE_MAX_STEPS` 1–100. The response-byte cap (D4) is computed from the validated values, so
  it stays bounded (at most 100 × 128 000 × 400 ≈ 5.1 GB as a stream counter, at the extreme
  configuration).
- **A smaller-model fallback.** Some models and servers reject a 16 000 output cap with `400`
  before doing anything: older models (e.g. 4–8k output limits) and OpenAI-compatible servers with
  a small context window. So if a generation turn's **first** model request is answered `400` while
  its output cap is above 4000, the turn starts again once with 4000. This happens before any tool
  has run, so nothing is duplicated. The route's log line notes it content-free as
  `(output-cap fallback 4000)`. A second `400`, or a `400` on any later request, fails as usual
  (re-panel 2026-10-12).
- The 16 calls per step and the per-turn call caps are fixed constants.
- Timeouts reuse `AI_CHAT_TIMEOUT_SEC`, `TOPIC_GENERATE_TIMEOUT_SEC` and
  `EVENT_GENERATE_TIMEOUT_SEC` through `runOuterAiTurn`, which aborts `streamText` through its
  signal (A6).

*Alternatives considered.*
- **OpenCode per turn** (the earlier draft): it needed a sidecar container, a key relay,
  per-turn uids and deployment changes, because it ships shell and file tools that only its
  permission engine holds back. See panel.md.
- **`ToolLoopAgent`:** same loop. `streamText` is used because the routes already own streaming
  and abort.
- **The AI SDK's MCP client against our MCP listener:** an extra hop and a token, for tool
  bodies that are already in process.
- **Refactoring the builders into plain functions:** more churn than the `ToolSink` seam, for
  the same sharing.

### D4. The guarded fetch (`server/src/auth/providerOutbound.ts`, a new streaming function)
`guardedFetch(turn)` returns a `fetch`-compatible function. The provider factories call it as
`(url: string, init)`, with `init` keys `body` (a string), `headers`, `method` and `signal`
(A17). The existing `providerRequest` stays as it is for the connection test: it buffers 1 MB,
and its 10 s timeout covers the whole request.

**For each request it:**
1. **Checks the destination,** after normalizing the URL. Encoded slashes, `..` segments and a
   doubled `/` are refused.
   - **Fixed-host providers:** origin `PROVIDER_HOSTS[provider]`, and the path matches the
     provider's pattern with the credential's model as one segment:
     - Anthropic `/v1/messages`;
     - OpenAI `/v1/responses`;
     - Google `/v1beta/models/<model>:streamGenerateContent` (query `alt=sse` allowed).

     A model id containing `/` or `..` can't retarget the path (A29).
   - **`openai-compatible`:** the saved `base_origin`, and the path is `<base path>/chat/completions`.
   - Anything else is refused without a connection.
2. **Sends** through the pinned DNS lookup and, in production mode, the blocked ranges, on the
   connection that is used.
   - `redirect` is forced to `"manual"`, because the SDK never sets it (A17). Plain fetch
     would follow, and Node strips only `authorization` across origins, not `x-api-key` or
     `x-goog-api-key`. A 3xx is returned unfollowed.
   - **A new header timeout of 120 s** covers only the wait for response headers, and is
     cleared when they arrive. It allows a long-context prefill; the route timeout bounds the
     whole turn.
3. **Applies per-turn caps:**
   - at most 60 requests, including the SDK's retries;
   - 4 MB per request body, and 48 MB of request bodies per turn (derivation A11);
   - a response-byte cap per turn derived from the turn's own limits: `steps × maxOutputTokens ×
     400` bytes, i.e. ~200 bytes of streamed SSE per token chunk, doubled for headroom. That is
     12.8 MB for chat (8 × 4000) and 256 MB for generation at the defaults (40 × 16 000). The
     response is streamed, never buffered, so the cap is a counter, not memory. It bounds a
     hostile server streaming bytes regardless of `max_tokens` (owner, 2026-10-12, replacing the
     fixed 64 MB derived from 4000 tokens per step).

   Past a cap it throws a classified `OutboundFailure` without a connection, or aborts the
   response stream. The turn ends as a cap breach.
4. **Streams** the response body through unbuffered, counting bytes per step for the usage
   estimate (D3).

The `AbortSignal` is passed through, so an aborted turn closes the upstream socket (A6). Nothing
from the request (headers, body) or the response is logged.

### D5. Errors never carry content
`APICallError` carries `requestBodyValues` (the whole prompt, including the transcript and
history), `responseBody`, `responseHeaders` and a message that can repeat the provider's body
(A5). After retries the error is a `RetryError` with no `statusCode` (A30). So:
- **Classification.** Every error, thrown or delivered as an `error` part, becomes the frozen
  `upstream-failed`, whatever its class: `APICallError` of any status, `RetryError`, an
  `OutboundFailure` (`unreachable`, `timeout` or a cap breach) or anything else. Only the class
  name may be counted in a metric, never logged with properties.
- **A content-free diagnostic** (owner, 2026-10-12, caching re-panel). `SdkTurnFailure` carries
  only a `kind` (`provider`, `breach` or `internal`), plus either the upstream HTTP `status` as a
  number (when the error had one; for a `RetryError`, the last attempt's) or the breach name
  (`requests`, `request-bytes`, `request-total`, `response-bytes`, `tool-calls`). The routes'
  existing failure line appends exactly these, e.g. `… failed — upstream-failed (status=429)` or
  `(breach=request-total)`. That makes a failure diagnosable without logging any message, body,
  header, prompt or key.
- **Never surfaced.** The error object is never logged, stringified, stored or forwarded. A repo
  test forbids passing an AI SDK error to `console.*` or the server logger in `ai-runtime` and the
  AI routes, and requires `onError` on every `streamText`. The no-op `onError` suppresses all of
  the SDK's own error output (A31).
- **No error escapes unhandled.** The process already has Next.js's `unhandledRejection` and
  `uncaughtException` handlers, which print the whole error and keep running
  (`next/dist/server/lib/router-server.js:554-567`, `next-server.js:193-221`). A process-level
  handler of ours would race them, so none is added (fresh review). Instead:
  - every SDK result promise gets a no-op `.catch` when it is created;
  - `sdkTurn` catches every SDK error at the boundary and rethrows only a property-free
    `SdkTurnFailure(kind)`, so no `AISDKError` leaves `ai-runtime`.
- **The global error log is redacted too.** Hono's `onError` (`server/src/app.ts:237`) logs
  unexpected errors through `redactDatabaseError`. That redaction gains a rule: an error where
  `AISDKError.isInstance(err)` is true, or that carries `requestBodyValues` or `responseBody`, is
  logged as its class name only. So an SDK error that escapes a route by a bug still prints no
  prompt.

### D6. Chat history
**Request.** `chatRequestSchema` becomes
`{message, claude_session_id?, history?: [{role: 'user'|'assistant', text}]}`, with:
- at most 40 entries;
- each `text` 1–8000 characters after trimming;
- at most 64 000 characters in total;
- NUL refused by the existing NUL `400`.

**Which field each route uses.**
- The **CLI** route ignores `history`, and validates `claude_session_id` exactly as today.
- The **SDK** route ignores `claude_session_id` and does not check its binding, so a stale id
  from an earlier CLI turn after the user switched provider is harmless.
- `claude_session_id: null` is accepted on both routes and means absent. A client that echoes
  the `done` value verbatim after an SDK turn would otherwise get `422` (re-panel). This relaxes
  the request schema, which is part of the contract delta.

**Messages (SDK).** History becomes `messages`, each `{role, content: text}`, followed by
`{role:'user', content: message}`. The roles reach the provider as real roles (verified A4), so
the model sees a normal conversation and no delimiter scheme is needed. The system prompt still
says transcript and tool content are data, not instructions.

**Done event.** `done {claude_session_id: string | null}`: null on SDK turns, so a client that
echoes it sends nothing next turn.

**Client.** It sends `history` built from its display messages, excluding the in-flight
assistant message, error rows and tool chips, trimmed from the oldest end to fit the bounds.

### D7. Dependencies
`packages/ai-runtime/package.json` gains, at **exact** versions:
- `ai@7.0.137`;
- `@ai-sdk/anthropic@4.0.78`;
- `@ai-sdk/openai@4.0.91`;
- `@ai-sdk/google@4.0.93`;
- `@ai-sdk/openai-compatible@3.0.67`.

Zod stays the single repo copy: the SDK takes it as a peer, `^3.25.76 || ^4.1.8`, and the repo
has 4.6.5. This satisfies package-architecture "Runtime dependencies checked by nominal identity
are never duplicated", checked by the existing duplicate test.

Bumping a version is a reviewed change that runs the opt-in real test (task 9.3).

There is no image or compose change. The secrets allowlist `docker/secrets-env.yaml` gains:
- `CLAUDE_CLI_EMAILS`;
- `AI_CHAT_MAX_STEPS`, `AI_CHAT_MAX_TOKENS`, `GENERATE_MAX_STEPS` and `GENERATE_MAX_TOKENS`.

The allowlist refuses a whole secret holding an unlisted key, so a tunable variable has to be
listed (re-panel). `GENERATE_MAX_OUTPUT_TOKENS` joins them (amendment 2026-10-12). The same variables go in `server/.env.example` and `docker/.env.example` (no
email value) and `docs/openbao-secrets.md`.

### D8. Web
**Advanced section.** `AdvancedSection` adds "Claude CLI (operator)" to the Language model
picker when `claude_cli_allowed`. With it selected:
- Base URL, Model and API key are hidden;
- the help line reads "Runs on this server's Claude CLI login. Available only to operator
  accounts.";
- the status badge reads "Connected" when saved.

A user who saved `claude-cli` and was later removed from the list still sees it as their current
choice, so they can replace or remove it.

**Latches.** The chat's `notConfigured` state and the topics and events latches clear when an
`llm` credential save succeeds. This uses the same `['providers']` query subscription the
Transcribe feed uses; `useGatedGenerate` exposes `resetUnavailable` to both panels.

**Copy.**
- Chat: "Add a language model in Settings → Advanced to use the assistant."
- Topics: "Add a language model in Settings → Advanced to generate topics."
- Events: "Add a language model in Settings → Advanced to generate events."

These are also the server's `503` details.

**Chat request.** It sends `history` (D6).

### D9. Existing tests that may change, by category
An existing test may change only for one of these reasons. Anything else is a stop: update the
artifacts and ask the owner. New tests are always allowed.

1. **The CLI is enabled the new way.** A test that enables AI by setting `CLAUDE_CLI_PATH` also
   puts its caller's email in `CLAUDE_CLI_EMAILS` and saves a `claude-cli` credential for that
   caller through a shared test helper, the production path (there is no fallback, D1). Only
   setup changes; its assertions stay. The panel's grep found: `ai.int`, `transcribe.int`,
   `events.generate.int`, `access.int`, `compression.int`, `sessionHub.interleave.int`,
   `aiV2.int` (shared slot only), and the two `*.real.test.ts`.
2. **The old `503` details and not-configured copy** (chat, topics, events) change to the new
   strings. This covers the server route tests and `AiChat.test.tsx`, `generateLatch.test.tsx`
   and `eventGenerateLatch.test.tsx`.
3. **The latch now clears on a language-model save** instead of only on reload
   (`generateLatch.test.tsx`, `eventGenerateLatch.test.tsx`).
4. **The `done` payload and chat body schemas:** `claude_session_id` may be null, and the body
   gains `history` (`schemas.zod4.test.ts`, `aiChatRelay.test.ts` where it asserts the payload
   type).
5. **The credential wire shape:**
   - `key_last4` may be null, and `GET` adds `claude_cli_allowed`;
   - affected: `schemas.providers.test.ts`, `providers.int.test.ts`, `types.conformance.test.ts`,
     `apiResponseShapes.repo.test.ts`;
   - fixtures are recaptured with `UPDATE_API_FIXTURES=1`.
6. **The recorded catalog schema:** the nullable key columns and the new check
   (`catalogSchema.pg.test.ts`, `providerTables.pg.test.ts` where they assert `not null` or list
   checks).
7. **The Advanced section's provider list** gains the CLI option when allowed
   (`AdvancedSection.test.tsx` where it asserts exactly four options).
8. **Tests of `ProviderCredentialStore`** (in-memory fakes, if any, and the storage pg test
   `packages/storage/src/providerCredentials.pg.test.ts`) gain `putKeyless` where needed and
   narrow the now-nullable `key` on rows they saved with a key (a typing change only, such as
   `key!` or a guard). Their assertions stay unchanged (owner, 2026-10-11, during task 2.2).
9. **The error redaction:** a test of `redactDatabaseError` that asserts an unknown error is
   returned unchanged keeps passing for non-SDK errors; only SDK errors gain the new rule. The
   `ToolSink` seam (D3) is a typing change only, and the MCP tool tests stay unchanged.

**New `Config` fields** (`CLAUDE_CLI_EMAILS`, the four step and token variables, and `GENERATE_MAX_OUTPUT_TOKENS`) are **optional**, so the
two complete `Config` literals (`upgradeDispatch.test.ts`, `aiV2.int.test.ts`) don't change.
Absent means no allowlist and default caps.

## Assumptions

Each assumption below was tested on 2026-10-11 in a scratch install of the pinned versions
(`scratchpad/aisdk-probe`) against a local fake provider, or in this checkout.

| # | Assumption | Command | Observed |
| --- | --- | --- | --- |
| A1 | The pinned packages exist and every provider factory accepts `fetch` and `apiKey` (and `baseURL`) | `npm view ai version` etc.; `grep -hoE "(fetch\|baseURL\|apiKey)\?: " …/dist/index.d.ts` | `ai 7.0.137`, `@ai-sdk/anthropic 4.0.78`, `openai 4.0.91`, `google 4.0.93`, `openai-compatible 3.0.67`; openai, google and anthropic: `apiKey?: baseURL?: fetch?:`; openai-compatible: `apiKey?: fetch?:` (`baseURL` required) |
| A2 | `streamText` with tools runs a multi-step loop, uses our `fetch` for every request, and emits typed parts | `node probe.mjs ok` (fake OpenAI-compatible server: step 1 tool call, step 2 text) | `parts {"start":1,"start-step":2,…,"tool-call":1,"tool-result":1,…,"text-delta":2,…,"finish":1} requests 2 fetches 2`; `text: Hello world steps: 2` |
| A3 | Zod 4 schemas work as `inputSchema`, and tools reach the request | same run | `REQ1 tools: [ 'get_words' ] max_tokens: 4000`; the tool executed with `{page:1}` |
| A4 | History is sent as real roles | same run | `msgs: system,user,assistant,user` |
| A5 | Errors carry the prompt and the provider body, so they must not be surfaced | `node probe.mjs 500`, `node probe.mjs anth` | `APICallError` keys `name,cause,url,requestBodyValues,statusCode,responseHeaders,responseBody,isRetryable,data`; message `secret-body` (the provider's body) |
| A6 | Abort ends the stream and closes the upstream socket | `node abort.mjs` | `abort parts start,start-step,text-start,text-delta,abort upstream socket closed: true` |
| A7 | `isStepCount(n)` bounds an endless tool loop | `node probe.mjs loop` (`isStepCount(3)`) | `tool-call:3 … requests 3` |
| A8 | `maxRetries` bounds retries | `probe.mjs 500` (`maxRetries:0`), `500r` (`maxRetries:2`) | 1 request; 3 requests in 6 s |
| A9 | Anthropic's factory honours `baseURL` and sends the key in `x-api-key` | `node probe.mjs anth` | `ANTH POST /v1/messages sk-test-key` |
| A10 | Zod is a peer, so no second copy is installed; the repo's Zod satisfies it | `node -e "…peerDependencies"`; `node -p "require('./node_modules/zod/package.json').version"` | `peer {"zod":"^3.25.76 \|\| ^4.1.8"}` for `ai`, the providers and `provider-utils`; repo zod `4.6.5`; one `node_modules/zod` in the probe |
| A11 | Byte caps sit above legitimate turns | re-panel simulation (40 steps re-sending the full context) | ASCII pages read every step: last request 1.71 MB, total 34.4 MB; a full 200k-token context for 40 steps ≈ 30.5 MB; 60 requests ≈ 45.8 MB. The caps bind only for 3–4-byte text beyond ~1.3M tokens, past any model's context |
| A12 | The tool bodies exist in one place to share | `sed -n 713,860p packages/ai-runtime/src/aiMcpServer.ts` | `TOOL_BUILDERS` with the four tools, each resolving the hub as the caller |
| A13 | The gate order matches D1 | `sed -n 114,160p server/src/routers/ai.ts`; `transcribe.ts:269-293`; `events.ts:453-531` (first panel) | `requireSession` → `aiChatConfigured` 503 → `requireRunFeature` 403 → body → 409 |
| A14 | Integration tests run in development mode, and the CLI tests use known callers | `server/src/test/harness.ts`; `server/src/node/config.ts:218` (first panel) | `NODE_ENV: 'test'` → `PROVIDER_DEV_MODE: true`; callers `seeded-user@` / `default-user@example.com` |
| A15 | `ai` depends on `@ai-sdk/gateway`, so string model ids are a risk | `node -e "require('./node_modules/ai/package.json').dependencies"` | `{"@ai-sdk/gateway":"4.0.110",…}` |
| A17 | Factories call our fetch as `(url, init)` and never set `redirect`; omitted `fetch` falls back to `globalThis.fetch` | re-panel `node urls.mjs`; `provider-utils/dist/index.js:650-660` | `init` keys `body,headers,method,signal` (body a string); no `redirect`; `fetch = getOriginalFetch$3()` → `globalThis.fetch` |
| A18 | An undefined `apiKey` or `baseURL` falls back to environment variables; an empty string does not | re-panel `ANTHROPIC_API_KEY=… node env.mjs` | `x-api-key OPERATOR-ENV-KEY`; `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` honoured when `baseURL` is omitted |
| A19 | OpenAI uses the Responses API and sends no `store` field (OpenAI's default stores) | re-panel `node urls.mjs`, `node urls2.mjs` | `https://api.openai.com/v1/responses`; body keys `input,model,stream,tool_choice,tools`, `store= None` |
| A20 | `extractReasoningMiddleware({tagName:"think"})` turns inline `<think>` into reasoning parts, even split across chunks | `node think2.mjs` (chunks `<thi`, `nk>SECRET-REASON</th`, `ink>Answer`) | `reasoning-delta:"SECRET-REASON" \| text-delta:"Answer"`; without it the re-panel saw `text-delta "<think>INLINE-REASONING</think>"` |
| A21 | The SDK executes parallel tool calls concurrently, with no bound | re-panel `ai/dist/index.js:3229`; `node latetool.mjs` | per-call `executeTool`; two calls both started at 24 ms |
| A22 | A thrown tool error's message reaches the model by default | re-panel `node beh.mjs throw` | `"content":"Error: INTERNAL-DB-SECRET at /srv/x"` |
| A23 | `registerTurn` needs the started listener and mints a token | re-panel `sed -n 1000,1060p aiMcpServer.ts` | `throw new Error('AiMcpListener not started')`; `randomBytes(TOKEN_BYTES)` |
| A24 | Without `maxOutputTokens`, Anthropic requests 128 000 output tokens | re-panel `node urls2.mjs` | `max_tokens: 128000` |
| A25 | A custom `StopCondition` sees per-step `usage.totalTokens` (computed when only prompt and completion counts are given) | re-panel `node beh.mjs budget`, `node beh_nototal.mjs budget` | `seenSteps [[1050],[1050,1050]] requests 2` |
| A26 | With no usage reported, `totalTokens` is undefined, so a usage-only budget never fires | re-panel `node beh_nousage.mjs budget` | `seenSteps [[null],[null,null],[null,null,null]]`, 4 requests, budget 2000 never tripped |
| A27 | A provider stream dropped mid-response throws from `fullStream` instead of emitting an `error` part | re-panel `node beh.mjs drop` | `THROWN APICallError status 200 … hasPrompt true`; parts `start,start-step,text-start,text-delta` |
| A28 | A call to an undefined tool still yields a `tool-call` part with the model's own name | re-panel `node guard.mjs unknowntool` | `tool-call bash invalid true dynamic true`, then `tool-error bash` |
| A29 | A Google model id with `../` can retarget the path on the same host | re-panel `node -e "new URL(...)"` | the resolved path leaves `/v1beta/models/` |
| A30 | Repeated `5xx` surface as a `RetryError` with no `statusCode`; an `OutboundFailure` from fetch surfaces unwrapped and is not retried | re-panel `node beh.mjs 500`, `node guard.mjs throw` | `RetryError` after 3 requests; `OutboundFailure` as the `error` part |
| A31 | A no-op `onError` suppresses all SDK error output; without it stderr carries the provider body | re-panel `node beh.mjs 500\|drop\|hang\|redirect`; `node beh_noonerr.mjs 500` | `stderr bytes: 0`; without it `stderr bytes 10934 hasProviderBody 9` |
| A32 | No side-channel network requests happen besides our fetch | re-panel `node spyurls.mjs` | `SIDE-CHANNEL HITS []` |
| A33 | `finishReason` doesn't reliably say whether the model wanted more tools | fresh review `node fresh-review/ends.mjs stopfr\|lenfr\|tcnotool\|cap` | tool calls with `stop`: `stop/stop/calls=1/results=1 … finalFinishReason stop`; `length/length/calls=1/results=0` (tool never ran); `tool-calls/tool_calls/calls=0`; `finish(tool-calls)` only when the server reports `tool_calls` |
| A34 | Aborting from inside `execute` ends the stream with an `abort` part, and the result promises reject | fresh review `node fresh-review/ends.mjs capabort` | `parts start,start-step,tool-call,tool-call,tool-call,abort`; `steps rejected DOMException`; `finishReason rejected DOMException` |
| A35 | Next.js installs process-level handlers that print the whole error and keep the process alive | `node_modules/next/dist/server/lib/router-server.js:554-567`; `next-server.js:193-221` | `process.on('unhandledRejection', …)` with `_log.error('unhandledRejection: ', err)`; `console.error(reason)`, "we definitely shouldn't crash the entire process" |
| A36 | Hono `onError` logs non-database errors in full | `server/src/app.ts:142-151,237` | `console.error('unhandled error', ...redactDatabaseError(err))`; returns `[err]` unchanged unless `PostgresError` / `CatalogForbiddenError` |
| A37 | Serializing tool bodies under parallel calls doesn't deadlock the SDK | fresh review `node fresh-review/ends.mjs parallel` | `start1 end1 start2 end2 … start9 end9`, 3 requests, every step finished |
| A38 | `providerOptions.openai.store=false` reaches the request | fresh review `node fresh-review/store.mjs` | `store= false` (gpt-4.1); `store= false include= ["reasoning.encrypted_content"]` (gpt-5) |
| A39 | A server whose template opens `<think>` in the prompt emits only the closing tag; the middleware then passes the reasoning through as text | fresh review `node fresh-review/think3.mjs noopen` | `t:"REASON-NO-OPEN-TAG" \| t:"</think>Answer1 "` |
| A40 | Database statements of tool bodies are time-bounded | `grep -n statement_timeout supabase/migrations/20261001000000_catalog_schema.sql` | `137:alter role autologger_app set statement_timeout = '30s';` |
| A41 | With `providerOptions.anthropic.cacheControl`, the Anthropic request carries a top-level `cache_control`, and usage reports cache reads and writes separately | `node cache.mjs` (fake Anthropic stream with `cache_read_input_tokens: 9000`) in `aisdk-probe` | `top-level cache_control: {"type":"ephemeral"}`; `usage: {"inputTokens":9250,"inputTokenDetails":{"noCacheTokens":50,"cacheReadTokens":9000,"cacheWriteTokens":200},…,"totalTokens":9255}`. Anthropic docs: "only uncached input tokens count toward your ITPM rate limits" (rate-limits, cache-aware ITPM); automatic caching "moves [the breakpoint] forward as conversations grow" (prompt-caching) |
| A42 | Event generation with a 4000-token per-step output cap fails on a long transcript | dev stack, 2h52m session (28 579 words), Anthropic `claude-sonnet-5-5`, `POST …/events/generate` | `502`; server log `generation failed — AI turn failed (upstream-failed) (ending=incomplete, steps=7, last=length)`; events before and after: 2 |
| A16 | The credential key columns are non-null today | `supabase/migrations/20261016000000_user_provider_credentials.sql:39-45` | `key_nonce bytea not null`, … `key_last4 … not null` |

## Risks / Trade-offs

- **The AI SDK releases often.** → Exact pins. Bumps are reviewed and run the opt-in real test.
- **A provider SDK could add a default request somewhere** (telemetry, the gateway). → Model
  objects only, no strings (repo test). The guarded `fetch` refuses any destination but the
  credential's.
- **Prompt injection through the transcript or history.** → The only capabilities are the turn's
  tools, which act on the caller's own session through the existing validated bodies. Nothing in
  the process the model drives can run commands or read files.
- **Spend on the user's key.** → Steps, output per step, a per-turn token budget (overrun at most
  one step), timeouts, and the byte caps. It is the user's own account; README states the
  bounds.
- **Turns run in the API process, shared by every user.** → A hostile OpenAI-compatible server
  could ask for thousands of tool calls in one step. The tool wrapper caps calls per step (16)
  and per turn, and runs one body at a time; the guarded fetch caps response bytes. Memory per
  turn is the conversation plus the transcript pages. No deployment-wide ceiling (owner
  deferred).
- **`claude_session_id: null` in `done`.** → The web client is updated in the same change. The SSE
  stream is additive-open.

## Migration Plan

1. The migration only relaxes `not null` and adds a check that existing rows already satisfy;
   deploy order is irrelevant.
2. Set `CLAUDE_CLI_EMAILS` in each OpenBao stack before deploying. Without it, nobody gets the
   CLI.
3. After deploy, users without an `llm` credential see the "add a language model" `503`. This is
   intended (no operator fallback in production).

**Rollback.**
- Revert the code and redeploy.
- Rows with `provider = 'claude-cli'` must be deleted before the old code runs, because it
  expects a key:
  `delete from catalog.user_provider_credentials where provider = 'claude-cli';`
- Then restore the constraints:
  `alter table … alter column key_nonce set not null, …;`
  `alter table … drop constraint user_provider_credentials_claude_cli_check;`

## Open Questions

- The default step and token caps may be tuned during the dev check. They are configuration
  values, not contract.
