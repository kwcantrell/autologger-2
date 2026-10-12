# 0028: AI turns run in process on the AI SDK, with the Claude CLI kept for an allowlist

- Date: 2026-10-12
- Status: Accepted
- Rule: ai-topics-chat, topic-generation and auto-event-generation (the AI SDK route), the
  provider-credentials `claude-cli` row and `CLAUDE_CLI_EMAILS`, and the repo test
  `packages/ai-runtime/src/sdkSafety.repo.test.ts`

## Context

AI chat, topic generation and event generation all ran the operator's `claude` CLI, so every
turn spent the operator's subscription, even after users could save their own language-model key
(byo-ai-providers, ADR 0027): only the connection test read that key (ai-sdk-agent-harness
proposal, "Why"). Running a turn on a user's key needs an agent loop the server controls. Two
facts shaped the choice:

- The turn's tools (`get_transcript_words`, `list_topics`, `create_topic`, `create_event`) already
  live in process in `TOOL_BUILDERS` and act only on the turn's own session.
- An AI SDK error carries the whole prompt (`requestBodyValues`, so the transcript and history)
  and the provider's response body (design A5), and the API embeds Next.js, whose own
  `unhandledRejection` and `uncaughtException` handlers print an escaped error in full and keep
  the process alive (A35).

## Decision

- **An in-process AI SDK harness** (`packages/ai-runtime/src/sdkTurn.ts`). `streamText` from AI
  SDK Core and the four provider factories (Anthropic, OpenAI, Google, OpenAI-compatible) at exact
  versions, behind the same slot, run lease, timeout, abort and tool bodies as the CLI. The model
  is always a factory object, never a model-id string, which would route through the Vercel
  gateway. The model can do nothing but call the turn's tools: no shell, file or web capability
  exists in the process it drives. The route injects `{provider, baseURL, model, apiKey, fetch}`,
  and construction throws without a `fetch` function or a non-empty key, so the SDK can't fall
  back to `globalThis.fetch` or to `ANTHROPIC_API_KEY`-style environment variables (A17, A18).
- **The guarded fetch** (`guardedFetch` in `server/src/auth/providerOutbound.ts`) carries every
  model request. It allows only the credential's destination: the fixed provider origin and API
  path with the model as one segment, or the saved OpenAI-compatible origin and
  `<base path>/chat/completions`; encoded slashes, `..` and doubled `/` are refused. It uses the
  pinned DNS lookup and, in production mode, the blocked address ranges; forces
  `redirect: "manual"` (Node would carry `x-api-key` across origins); waits at most 120 s for
  headers; and caps a turn at 60 requests, 4 MB per request body, 48 MB of request bodies and
  64 MB of response bytes. Nothing from a request or response is logged.
- **The Claude CLI is kept for an allowlist.** A user picks "Claude CLI (operator)" in Settings,
  stored as a keyless `claude-cli` `llm` row. It runs only while `CLAUDE_CLI_PATH` is set and the
  caller is on `CLAUDE_CLI_EMAILS` (an OpenBao key). The bootstrap owner is not implicitly listed,
  because the list names exactly who may spend the operator's subscription; anyone else does not
  see the option, gets `403` on saving it, and a removed user stops getting the CLI on the next
  turn. There is no development-mode CLI fallback, so tests and dev take the production path.
- **Error scrubbing.** Every model-side error, thrown or streamed, becomes the frozen
  `upstream-failed`. No `AISDKError` leaves `ai-runtime`: `sdkTurn` rethrows only a property-free
  `SdkTurnFailure(kind)`, every SDK result promise gets a no-op `.catch` when it is created, and
  every `streamText` has a no-op `onError`, which silences the SDK's own stderr output (A31). A
  tool body that throws sends the model the fixed "Tool failed.", not its message (A22). The
  global error log (Hono `onError`, through `redactDatabaseError`) logs an SDK error, or anything
  carrying `requestBodyValues` or `responseBody`, as its class name only. **No process-level
  handler is added:** Next.js already installs `unhandledRejection` and `uncaughtException`
  handlers that keep the shared API alive, and ours would either race them after the prompt was
  printed or crash the API on Next's routine rejections (panel.md, fresh re-panel critical).
- **Tool-call caps and serialization.** Every tool handler is wrapped. It refuses a call once the
  turn has ended; allows 16 calls per step softly (later calls get a tool error and the turn
  continues, since event generation asks for one `create_event` per hit); ends the turn as a
  breach past 32 calls (chat) or 300 (generation); and runs one tool body at a time per turn,
  because the SDK starts parallel calls concurrently with no bound (A21). The route waits for
  in-flight bodies to settle before acting on a result or releasing the slot. Steps and a
  per-turn token budget (`AI_CHAT_MAX_STEPS` 8 and `AI_CHAT_MAX_TOKENS` 400 000;
  `GENERATE_MAX_STEPS` 40 and `GENERATE_MAX_TOKENS` 3 000 000) bound spend; a step whose provider
  reports no usage counts its bytes ÷ 4, so the budget never silently turns off. A capped
  generation fails rather than replace or delete prior results.

*Alternatives considered.*
- **OpenCode per turn** (the first draft, `opencode-agent-harness`). Dropped by the owner on
  2026-10-11 after two panels (`openspec/changes/ai-sdk-agent-harness/panel.md`, "Panel (OpenCode
  design)" and "Re-panel (OpenCode sidecar delta)"). OpenCode ships shell and file tools that only
  its permission engine holds back, so it needed OS isolation the container can't give
  (`unshare` is not permitted; it would run as the API's uid and could read `/proc/<pid>/environ`).
  The sidecar that fixed this needed a key relay, per-turn uids, a runner image, a new network and
  listener, and broke compose invariant 16 and the dev gate's closed-listener rule. Reused uids let
  a `setsid` survivor read the next turn's tokens, and its retries ran 11 requests over ~90 s.
- **`ToolLoopAgent`:** the same loop; `streamText` fits routes that already own streaming and
  abort.
- **The AI SDK's MCP client against our MCP listener:** an extra hop and token for tool bodies
  that are already in process.
- **A boot-time switch between CLI and SDK:** rejected because the owner wants both runners in one
  deployment.

Change: `openspec/changes/ai-sdk-agent-harness` (design D1-D9, the panel, re-panels and
consistency read).

## Consequences

- Turns run in the shared API process. Prompt injection through a transcript or history is limited
  to the turn's own tools on the caller's own session, but a turn's memory and CPU are the API's.
  The per-step and per-turn call caps, serialized bodies and byte caps bound one turn; there is no
  deployment-wide ceiling on concurrent turns or spend (owner deferred to a later change).
- The caller's key pays for SDK turns; a key leaves the server only in the request header to its
  own provider. OpenAI requests set `store: false`.
- The AI SDK releases often. Versions are pinned exactly, and a bump is a reviewed change that
  runs the opt-in real test (`server/src/test/aiSdk.real.test.ts`).
- Reasoning is never relayed when it arrives in the provider's reasoning field or between
  `<think>` and `</think>`; a server whose template opens `<think>` in the prompt leaks it as text
  unless its reasoning parser is enabled (A39).
- A user without an `llm` credential gets the "Add a language model in Settings → Advanced" `503`;
  the operator's CLI is no longer anyone's default.

## Evidence

- Panel, re-panels and their resolutions: `openspec/changes/ai-sdk-agent-harness/panel.md`;
  measured assumptions A1-A40 in its `design.md`.
- `server/src/auth/guardedFetch.test.ts` (destinations, redirects, timeouts and caps),
  `packages/ai-runtime/src/sdkTurn.test.ts` (endings, tool-call caps, serialization, error
  classification), `packages/ai-runtime/src/sdkSafety.repo.test.ts` (no model-id strings, no SDK
  error passed to a logger, `onError` on every `streamText`), `server/src/unhandledErrorLog.test.ts`
  (SDK errors logged by class only), `server/src/auth/providerResolve.test.ts` (the CLI allowlist),
  and `docker/scripts/compose-run.test.mjs` (the five keys accepted from OpenBao).
