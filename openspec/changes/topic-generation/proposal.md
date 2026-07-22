# topic-generation — proposal

## Why

`POST /api/sessions/:sessionId/topics/generate` (the one-shot "Generate topics" button) is a
deliberate unconditional `503` stub — automatic topic generation was never wired to any
backend. Meanwhile the **AI chat** feature already generates topics: it spawns the operator's
local `claude` CLI against an in-process autologger MCP server (`get_transcript_words`,
`list_topics`, `create_topic`) with a topics-assistant system prompt, gated on
`CLAUDE_CLI_PATH`. This change wires `topics/generate` to run that **same** CLI machinery
**once, non-conversationally** — reusing the gate, the MCP server, the spawn/lockdown runner,
and the concurrency registry — so the button produces a fresh set of topics from the
session's transcript and returns them synchronously. No new dependency, no new secret.

This is genuinely a **new capability**, not just UX restoration: the AI chat's tool allowlist
has **no delete tool**, so the chat can only *append* topics — it structurally cannot do
**replace-all regeneration**, which is what the one-shot button provides.

## What Changes

- **New server-side one-shot generation** behind `POST /api/sessions/:sessionId/topics/generate`
  (router layer — the CLI spawn/stream is async; hub RPCs stay synchronous):
  1. Gate on `aiChatConfigured` (`CLAUDE_CLI_PATH`) — unset ⇒ the endpoint keeps its frozen
     `503`. Refuse `503` in the open-network config (`aiChatOpenNetworkRefused`, same as
     `ai/chat` — a turn spends the operator's Anthropic budget). Acquire a turn slot from the
     shared `aiChatTurns` registry (per-session single-flight + global ceiling) → `409`.
  2. Precondition: the session must have transcript words (topics are generated *from* the
     transcript, which is separately DeepGram-gated). No transcript ⇒ `400`.
  3. **Crash-safe replace-all swap** (gate decision): the prior topics are **never touched
     until success**. Record the pre-run topic ids; run the CLI turn so it creates a fresh set
     (the `list_topics` tool is **withheld** from the one-shot so it can't dedup against the
     topics being replaced); on success delete the pre-run ids in one transaction (leaving the
     fresh set) and return `200 {topics}`; on failure delete the topics this run created so the
     prior set survives **byte-for-byte** (a crash mid-run likewise leaves the prior topics
     intact — they're only ever deleted by the atomic delete-on-success). Needs one small new
     primitive: a bulk `deleteTopics(ids)` hub RPC.
  4. Bounded by a **dedicated** generate budget/timeout (`TOPIC_GENERATE_MAX_BUDGET_USD` + an
     optional timeout, defaulted higher than the chat's) — a one-shot reads the *entire*
     transcript, a bigger workload than a chat message. The turn runs to completion
     server-side (non-streaming; the frozen `topics/generate` contract is a synchronous `POST`
     returning `{topics}`) with **no abort signal**, so success-replace vs failure-restore is
     deterministic.
- **Reuse, not re-implement**: the CLI spawn/env-lockdown, the autologger MCP server, the
  gates, and the `aiChatTurns` registry are all reused via a **shared `driveAiTurn` helper**
  extracted from the `ai/chat` handler (spawn → run → the full no-orphan cleanup), which both
  endpoints call — so the correctness-critical cleanup lives in one place. New code is the
  route handler, the shared-helper extraction, the `deleteTopics` primitive + the dedicated
  budget config, and a fixed one-shot user message.

## Capabilities

### New Capabilities
- `topic-generation`: generating a session's topics one-shot from its transcript via the
  local `claude` CLI + autologger MCP server — configuration gating, open-network refusal,
  single-flight/concurrency bounds, the transcript precondition, the replace-all
  (crash-safe swap: prior topics never touched until success) semantics, the non-streaming
  run-to-completion model, and failure mapping.

### Modified Capabilities
- `api-contract-freeze`: `POST /api/sessions/:sessionId/topics/generate` changes from
  unconditional `503` to: `200 {topics}` on success when `CLAUDE_CLI_PATH` is configured;
  `503` (unchanged) when unconfigured and in the open-network config; `409 {detail}` on
  concurrency; `400 {detail}` when the session has no transcript; `502 {detail}` on a CLI
  turn failure. The `{topics}` shape matches `GET …/topics`. This is the authorizing delta.

## Impact

- **Server**: `routers/transcribe.ts` (the `topics/generate` handler replaces the `503`
  stub); a **shared `driveAiTurn` helper extracted from `routers/ai.ts`** (behavior-preserving
  for `ai/chat`), reused with `routers/aiChatRunner.ts` / `routers/aiMcpServer.ts` / `env.ts`
  gates / `routers/aiChatRegistry.ts`; a new bulk `deleteTopics(ids)` hub RPC (`TopicStore` +
  `SessionHub`); a new `TOPIC_GENERATE_MAX_BUDGET_USD` (+ optional timeout) config; and a fixed
  one-shot user message.
- **Web**: the existing "Generate topics" affordance already POSTs `topics/generate` and
  reads `{topics}` — verify it consumes the success shape; likely no change (the AI chat tab
  is unaffected and remains the conversational path).
- **Dependencies**: none new. Same `claude` CLI + Anthropic spend the AI chat already uses;
  disclosed in README alongside the AI chat disclosure.
- **Contract**: one frozen endpoint's status behavior changes, authorized by the
  `api-contract-freeze` delta. `transcribe.csv` stays `503`.

## Non-Goals

- **A second AI provider / direct API path** — reuse the `claude` CLI the AI chat uses; no
  Anthropic-API integration, no new key.
- **Conversational/streaming generation** — that's the existing `ai/chat` tab; this is the
  one-shot synchronous button. No SSE on `topics/generate`.
- **Append/merge semantics** — the gate chose replace-all; a successful run replaces the
  topics wholesale (manual edits overwritten by design), while a failed or crashed run leaves
  the prior topics intact (crash-safe swap, never touched until success).
- **Generating a transcript** — `topics/generate` requires an existing transcript;
  transcript generation stays its own DeepGram-gated surface.
- **`transcribe.csv`** — stays `503`.
