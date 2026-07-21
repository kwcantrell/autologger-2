# ai-session-analyst — Proposal

## Why

`ai-topics-chat` (shipped 2026-07-15) gave the session workspace a conversational agent, but
that agent has one job: turn transcript words into topics. Its mandate is narrow and
**write-capable** — `create_topic` mutates the session — and its system prompt is scoped to
that task.

Operators also want to *interrogate* a session without changing it: "what happened around
12:30?", "which topics have no events under them?", "summarize the second half". Answering
those through the topics chat would mean widening a write-capable agent's tool surface for
questions that never need to write. This change adds a **second, read-only agent** — the
Session Analyst — with its own tool surface, its own prompt, and no path to mutation.

## What Changes

- **Web — a fourth AI subtab.** `AiPanel`'s subtab strip becomes
  `Chat | Analyst | Transcribe | Topics`. The new panel follows the two patterns already
  established there (design D9 of `ai-topics-chat`): rendered **mounted-hidden** so switching
  subtabs never unmounts an in-flight turn, with conversation/streaming/abort state **hoisted**
  into `AiPanel`. Web-only layout change — not contract-bearing.
- **Server — new analyst endpoint.** `POST /api/sessions/:sessionId/ai/analyst` accepting
  `{ message, analyst_session_id? }` and streaming the reply as SSE. Reuses the
  `ai-topics-chat` SSE vocabulary and its **additive-open** posture. New frozen API surface
  authorized by this delta; **no existing route, shape, status code, or WS emission changes.**
- **Server — Agent SDK transport.** The turn runs via `@anthropic-ai/claude-agent-sdk`'s
  `query()` rather than a hand-spawned CLI. This **supersedes `ai-topics-chat` D1 for this
  change only** — see design D0 for the evidence and the owner ruling. The topics chat keeps
  its CLI transport untouched.
- **Server — in-process read-only toolset.** Three tools via `createSdkMcpServer` + `tool()`:
  `get_transcript_words`, `list_topics`, `list_events`. Because SDK MCP tools run **in-process**,
  this toolset needs **no loopback HTTP listener, no per-turn bearer token, and no generated
  `--mcp-config` file** — it removes that surface rather than duplicating it. `sessionId` is
  captured in the tool closure, never a tool parameter, preserving the existing invariant that
  the model cannot address another session.
- **Read-only lockdown (normative).** No tool may mutate. **Tool registration is the guarantee** —
  `create_topic` is never constructed, so no handler exists to reach — reinforced by disabling
  built-in tools outright, an explicit allowlist, and an observable permission gate. These are
  not independent equivalents (see design D2): registration must never be dropped on the grounds
  that the others exist.
- **Security lockdown (normative).** The SDK equivalents of the proven D4 flag set — **corrected
  after the 2026-07-20 panel, which found 4 of 9 mapped rows wrong**: built-in tools disabled
  outright (`tools: []`, *not* the auto-approve `allowedTools`), settings tiers disabled
  (`settingSources: []`), operator MCP sources suppressed (`strictMcpConfig`), a fail-closed
  permission mode, a working directory outside the repo and `DATA_DIR`, a pinned `systemPrompt`,
  and a minimal `env`. The mapping remains an **unverified hypothesis until the blocking Phase 0
  spike** rewrites it from observed behaviour.
- **Spend bounds (normative).** Reuses the existing `AiChatTurnRegistry` — per-session
  single-flight plus a process-wide ceiling — **plus a per-turn USD ceiling enforced by the
  agent**, since the registry bounds how many turns run, not what one turn can spend.
- **Configuration gating.** Follows the `CLAUDE_CLI_PATH` precedent: `503` unless configured,
  plus the same open-network refusal, so a paid endpoint is never exposed anonymously on a
  reachable network.

## Contract impact

**Additive only.** One new route (`POST /api/sessions/:sessionId/ai/analyst`) authorized by this
delta. No existing endpoint, JSON shape, status code, export body, header/range semantic, or WS
message/emission semantic changes. Topics remain WS-silent — the analyst never writes, so it has
no liveness story to add.

## Non-Goals

- **No change to the topics chat.** Its route, CLI transport, loopback MCP listener, resume-guard
  map, and lockdown argv are all untouched. This change does not migrate it to the SDK.
- **No write or mutating tools.** Not `create_topic`, not event creation, not edits. A future
  write-capable analyst would be a separate, separately-gated change.
- **No cross-session or library-wide scope.** The turn→`sessionId` binding stays intact; the
  analyst sees exactly one session.
- **No new auth mechanism.** Auth continues to ride on the operator's `claude login` via the
  existing `CLAUDE_CLI_PATH` install; this change does not introduce `ANTHROPIC_API_KEY`.
- **No persistence of analyst conversations *in the product*.** The UI history is ephemeral
  (browser state), matching the topics chat. Note this is **not** a claim that nothing is written:
  the agent stores conversation state on disk per working directory — that is what makes `resume`
  work — so session transcript content does land on the host. "Read-only" means no autologger
  session state is mutated; it does not mean no side effects. Spend, egress to Anthropic,
  on-disk conversation state, and issued-id retention are all expected consequences of a turn.

---

## SUPERSEDED 2026-07-20 — not implemented

Abandoned before implementation by owner decision, in favour of **`ai-v2-dashboards`** (an "AI
v2" tab where users design dashboards from session transcripts/logs, modelled on the
`ask-user-question-previews` SDK demo). The read-only-analyst framing does not survive the
pivot: dashboard design is a build-an-artifact workflow, not a question-answering one.

**Artifacts retained deliberately** — the panel and two gates produced findings that are inputs
to the successor, and re-deriving them would be waste:

- **D0/D1/D2** — the SDK lockdown option set, including the four corrections the panel forced
  (`tools: []` is the restriction, not `allowedTools`; `maxBudgetUsd` exists; `strictMcpConfig`
  suppresses project `.mcp.json`; `cwd` defaults to the repo checkout).
- **D7** — subprocess lifecycle: `interrupt()` is streaming-input-only; `abortController` kills
  one pid, not a group. Unresolved, and inherited by the successor.
- **D10** — auth policy: scoped key preferred, `claude login` fallback loopback-only.
- **D11** — the operator's verified finding that SDK sessions skip trust verification, so a
  project-tier settings file in `cwd` executes hooks with zero prompt.
- **D12** — the `canUseTool` → promise → browser round trip, which is now the *core* interaction
  of the successor rather than a clarifying-question add-on.

No code was written against this change; nothing to revert.
