# ai-topics-chat — Proposal

## Why

DeepGram transcription (shipped 2026-07-14) produces transcript words, but turning them
into session topics is still entirely manual — `POST …/topics/generate` was deliberately
left `503` because no external integration was wired up (gate decision E2 era). This
change wires that missing step as a conversational workflow: a ChatGPT-style chat panel in
the session workspace drives the local `claude` CLI, which reads the session's transcript
through a session-scoped MCP toolset and creates topics the user can steer, refine, and
hand-edit — instead of a one-shot generate button.

## What Changes

- **Web — feed tab restructure**: the workspace's flat tablist (`Event Feed | Transcribe
  Feed | Topics Feed`) becomes `Event Feed | AI`. The AI panel carries subtabs
  `Chat | Transcribe | Topics`; `TranscribeFeed` and `TopicsFeed` components move under it
  unchanged. Web-only layout change — not contract-bearing.
- **Web — Chat subtab**: a ChatGPT-like conversation UI with a Stop control that aborts
  the in-flight turn (client-side fetch abort; server terminates the subprocess). History
  is **ephemeral** (React state only; refresh clears it). Multi-turn continuity rides on
  the claude CLI session id echoed back by the client each turn.
- **Server — new chat endpoint**: `POST /api/sessions/:sessionId/ai/chat` accepting
  `{ message, claude_session_id? }` and streaming the reply as SSE (text deltas,
  tool-activity notices, terminal event carrying the claude session id). The event
  vocabulary is **additive-open** — new event types or payload fields may appear without a
  further delta, and clients ignore unrecognized ones. Lives in the router layer as an
  async job (SessionHub stays synchronous), following the DeepGram single-flight mechanism
  (session-keyed — see design D5).
- **Server — claude CLI integration**: the endpoint spawns
  `claude -p --output-format stream-json` (with `--resume` for follow-up turns), parses
  the stream, and relays it to the SSE response.
- **Server — session-scoped MCP toolset**: the spawned CLI gets a generated MCP config
  exposing exactly three tools scoped to the one session: `get_transcript_words`,
  `list_topics`, `create_topic`. `create_topic` is validated by the existing
  `topicCreateSchema` and writes through `SessionHub.insertTopic`, so transactions and
  server-assigned ordinals behave identically to a manual insert. The chatting client
  refreshes its Topics view off the SSE `tool` events (fact-check 2026-07-14: topics
  have no WS emission today, so there is no fan-out to inherit).
- **Security lockdown (normative)**: the spawned CLI is restricted to the autologger MCP
  tools only — no operator hooks/plugins/CLAUDE.md (`--setting-sources ""`),
  `--strict-mcp-config`, positive built-in-tool denial + an explicit three-tool
  allowlist, message delivered via stdin (never an argv flag). The chat endpoint must
  never become a remote shell on the host.
- **Spend bounds (normative)**: per-session single-flight, a process-wide concurrency
  ceiling, and a per-turn CLI budget — any authenticated user can otherwise fan out N
  concurrent turns on the operator's Anthropic account.
- **Configuration gating** (DeepGram precedent): the endpoint returns `503` unless the
  claude CLI integration is configured; unconfigured deployments are unchanged. It also
  refuses (`503`) on an anonymous, non-loopback, no-allowlist bind so a paid endpoint is
  never open on a LAN. README gains an egress + spend + security disclosure (transcript
  content leaves the machine to Anthropic when the feature is used).

## Capabilities

### New Capabilities

- `ai-topics-chat`: the AI chat capability — chat endpoint contract (request/SSE shapes,
  status codes, gating), claude CLI subprocess lifecycle, the session-scoped MCP toolset
  and its security lockdown, ephemeral-history semantics, and the AI tab / subtab
  arrangement in the session workspace.

### Modified Capabilities

_None._ No existing requirement changes: `transcript-generation` is a data source only
(read via the MCP tool), and `api-contract-freeze` requirements are satisfied — not
altered — by this change (see Contract impact).

## Contract impact

**New API surface, no changes to existing surface.** This change adds one route,
`POST /api/sessions/:sessionId/ai/chat`, with an SSE response body — new frozen surface
authorized by this change's delta spec (`specs/ai-topics-chat/spec.md`), per the
`api-contract-freeze` requirement that new surface arrives only via an authorizing delta.
On archive, the README endpoint table (normative route inventory) gains the row.
Everything else is untouched: `topics/generate` keeps its intentional `503`, existing
topic/transcript endpoints keep their shapes (the MCP tools call the same hub paths, not
new ones), and WS message shapes/emission semantics are unchanged — topics emit no WS
message today (fact-check 2026-07-14) and this change adds none; AI-inserted topics reach
other clients exactly the way manually inserted ones do. The tab restructure is web-only
and not part of the frozen contract.

## Impact

- **Server**: new router (`server/src/routers/ai.ts` or similar) + an in-process MCP
  server on a loopback-only ephemeral port (design D3 — same Node process, direct hub
  access); config wiring in `server/src/node/` for `CLAUDE_CLI_PATH`,
  `AI_CHAT_TIMEOUT_SEC`, `AI_CHAT_MAX_CONCURRENT`, and the per-turn budget var; no
  SessionHub API additions (reuses `listTopics`/`insertTopic` and the transcript read
  path).
- **Dependencies**: `@modelcontextprotocol/sdk` (server workspace) for the in-process
  Streamable-HTTP MCP server; the `claude` CLI itself is a deployment prerequisite, not
  an npm dependency.
- **Web**: `SessionWorkspace.tsx` tab restructure; new AI panel + Chat components; no
  changes to `TranscribeFeed`/`TopicsFeed` internals.
- **Docs**: README endpoint table row, feature section with egress/spend + security
  disclosure, `.env.example` additions.
- **Tests**: unit + integration for gating (503), request validation, SSE relay, MCP tool
  validation/write path, and the security lockdown flags; web tests for the tab
  restructure.
- **Out of contract's blast radius**: `companion/` untouched; e2e smoke unaffected
  (feature is unconfigured in the hermetic server).

## Non-Goals

- **No general-purpose assistant**: the toolset is exactly the three session-scoped tools;
  no event-feed writes, no transcript edits, no `update_topic`/`delete_topic` in v1
  (hand-editing in the Topics subtab covers corrections).
- **No markdown rendering and no cross-client topic liveness in v1**: chat replies render
  as plain text; only the chatting client refreshes topics live (other clients keep
  today's manual-insert refetch-on-focus semantics).
- **No chat persistence**: no history table, no history endpoint, no cross-refresh
  restore. Ephemeral by decision.
- **No change to `topics/generate`**: the button's `503` stays; the chat is the
  integration, not a backend for the button.
- **No streaming over the session WebSocket, and no new WS emissions**: chat deltas go
  to the requesting client via SSE, and no `topic.changed` broadcast is introduced —
  cross-client topic liveness stays exactly as it is for manual inserts today.
- **No Companion surface, no YouTube import, no `transcribe.csv` changes.**
- **No Anthropic API-key auth path**: auth rides on the operator's `claude login`; adding
  a key-based alternative is future work.
