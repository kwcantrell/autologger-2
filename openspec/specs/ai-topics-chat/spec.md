# ai-topics-chat Specification

## Purpose
TBD - created by archiving change ai-topics-chat. Update Purpose after archive.
## Requirements
### Requirement: Configuration-gated AI chat endpoint
The AI chat SHALL be gated on a `CLAUDE_CLI_PATH` environment variable naming the
`claude` CLI executable (absolute path or a name resolvable on `PATH`). When the variable
is unset, blank, or whitespace-only, `POST /api/sessions/:sessionId/ai/chat` SHALL respond
`503` with an actionable JSON `{ detail }` explaining that the AI chat is not configured,
and unconfigured deployments SHALL be otherwise unchanged. When set, the endpoint SHALL
run the chat turn. This route is new frozen API surface authorized by this delta; no
existing route, shape, status code, or WS emission changes.

#### Scenario: Unconfigured deployment returns 503
- **WHEN** `CLAUDE_CLI_PATH` is unset and a client calls
  `POST /api/sessions/:id/ai/chat`
- **THEN** the response is `503 { detail }` stating the AI chat is not configured

#### Scenario: Configured deployment serves the chat turn
- **WHEN** `CLAUDE_CLI_PATH` is set to a working `claude` executable and a client posts a
  valid chat message
- **THEN** the response is `200` with an SSE stream of the reply

### Requirement: Open-network refusal
Because a chat turn spends the operator's Anthropic credentials, the endpoint SHALL
refuse to serve turns when authentication is disabled on a reachable network: when
`REQUIRE_LOGIN` is disabled AND the server is bound to a non-loopback address with no IP
allowlist, `POST …/ai/chat` SHALL respond `503` with an actionable detail, independent of
the general auth gate. Loopback-bound anonymous dev is unaffected.

#### Scenario: Anonymous LAN deployment refuses chat
- **WHEN** `REQUIRE_LOGIN` is disabled and the bind is non-loopback with no allowlist
- **THEN** `POST …/ai/chat` responds `503` and no subprocess is spawned

#### Scenario: Loopback anonymous dev still serves
- **WHEN** `REQUIRE_LOGIN` is disabled and the server is loopback-bound
- **THEN** the chat endpoint serves turns normally

### Requirement: Chat request contract
`POST /api/sessions/:sessionId/ai/chat` SHALL accept a JSON body
`{ message: string, claude_session_id?: string }` where `message` is 1–8000 characters
after trimming and `claude_session_id`, when present, is a non-empty string. The endpoint
SHALL evaluate checks in this order, matching the `transcript-words/generate` sibling:
authentication → session resolution/scoping (`404` for nonexistent, deleted, or
out-of-studio sessions, exactly as sibling session sub-routes such as
`POST /api/sessions/:sessionId/events`) → open-network refusal / configuration gate
(`503`) → body validation → single-flight (`409`). Body validation SHALL use the repo's
existing semantics — `422 { detail: issues }` for schema violations (the global `ZodError`
mapping) and `400` for malformed JSON — and MUST NOT spawn a subprocess. All error bodies
SHALL be the repo's `{ detail }` shape.

#### Scenario: Invalid body rejected without side effects
- **WHEN** a client posts an empty/whitespace `message` or a body missing `message`
- **THEN** the response is `422 { detail }` and no `claude` subprocess is spawned

#### Scenario: Unauthorized session is masked as 404 before the config gate
- **WHEN** a caller without studio access to `:sessionId` posts a chat message, whether or
  not the feature is configured or a turn is in flight
- **THEN** the response is `404` (never `503`/`409`), leaking neither configuration nor
  in-flight state

#### Scenario: Unauthenticated request rejected like sibling routes
- **WHEN** a request lacks the credentials required by existing session sub-routes under
  the active auth configuration
- **THEN** the chat endpoint rejects it with the same status and shape those routes use

### Requirement: SSE reply stream shape
On acceptance, the endpoint SHALL respond `200` with `Content-Type: text/event-stream`.
The following event types are defined, each with a JSON data payload:

- `delta` — `{ "text": string }`: an assistant **text** fragment, in order. The server
  MUST relay only assistant text; model reasoning/thinking content MUST NOT be relayed.
- `tool` — `{ "name": string }`: notice that the named MCP tool was invoked, where `name`
  is the tool's **short name with the `mcp__autologger__` prefix stripped** — one of
  `get_transcript_words`, `list_topics`, `create_topic`.
- `done` — `{ "claude_session_id": string }`: terminal success event carrying the CLI
  session id the client echoes back for the next turn.
- `error` — `{ "detail": string }`: terminal failure event.

The set is **additive-open**: the server MAY introduce new event types and MAY add fields
to existing payloads without a further authorizing delta, and clients MUST ignore event
types they do not recognize and tolerate unknown fields. The frozen guarantees are: the
four event meanings above, and that a server-completed stream ends with exactly one
terminal event (`done` or `error`). A stream the server does not complete (client abort,
see Single-flight lifecycle) MAY end with no terminal event. The server MAY emit SSE
comment lines (`:` keepalives), which clients MUST ignore; the server does not set `id:`
or `retry:` fields. The `error` `detail` SHALL be one of a fixed set of server-authored,
secret-free strings (not-configured, upstream-failed, not-logged-in, timeout,
internal-error) — never a passthrough of subprocess stdout, stderr, result text,
environment values, credentials, or device-login URLs.

#### Scenario: Successful turn streams deltas then done
- **WHEN** a chat turn completes normally
- **THEN** the client received zero or more `delta`/`tool` events followed by exactly one
  `done` event with a non-empty `claude_session_id`, and the stream closed

#### Scenario: Failed turn ends with a scrubbed error event
- **WHEN** the `claude` subprocess exits nonzero, is not logged in, or its output cannot
  be parsed
- **THEN** the stream ends with exactly one `error` event whose detail is one of the
  fixed server-authored strings, free of secrets and CLI output, and the stream closes

#### Scenario: Model reasoning is not streamed to the client
- **WHEN** the CLI stream contains thinking/reasoning content blocks
- **THEN** none of that content appears in any `delta` event; only assistant text is
  relayed

#### Scenario: Client ignores unknown event types
- **WHEN** the server emits an event type the client does not recognize
- **THEN** the client ignores it without error (forward compatibility)

### Requirement: Multi-turn continuity bound to the autologger session
The server SHALL spawn the CLI in non-interactive print mode with machine-readable
streaming output (`claude -p --output-format stream-json`), delivering the user message
via **stdin** (never as an interpretable argv positional, so a message beginning with `-`
cannot become a CLI flag). The server SHALL maintain, per autologger `:sessionId`, the set
of `claude_session_id` values it has issued for that session. When a request carries a
`claude_session_id` that was issued for the **same** `:sessionId`, the server SHALL resume
that CLI conversation (CLI resume flag, without `--fork-session` so the id is stable). A
`claude_session_id` not issued for this `:sessionId` (foreign, stale, or forged) SHALL be
rejected with `422` before any subprocess is spawned. When absent, a fresh CLI session
starts. The server SHALL relay the resulting session id in the `done` event, and the
client SHALL echo the id from the most recent `done`.

#### Scenario: Second turn resumes the first turn's session
- **WHEN** a client sends turn two with the `claude_session_id` from turn one's `done`
  event on the same session
- **THEN** the spawned CLI resumes that session and the reply reflects turn one's context

#### Scenario: Foreign session id is rejected, not resumed
- **WHEN** a client posts to `…/sessions/B/ai/chat` a `claude_session_id` that was issued
  for session A
- **THEN** the response is `422`, no subprocess is spawned, and session A's conversation
  is never resumed under session B

#### Scenario: Message cannot smuggle a CLI flag
- **WHEN** a client sends a `message` of `--dangerously-skip-permissions`
- **THEN** it is delivered as prompt text via stdin and is never parsed as a CLI option

### Requirement: Ephemeral chat history
The server MUST NOT persist chat conversation content: no chat tables in the catalog DB
or session DBs, no chat blobs under `DATA_DIR`, and no chat-history read endpoint.
Server-side conversation state lives only in the client's page state; CLI-side session
storage lives outside `DATA_DIR` in the CLI's own store. The server MUST NOT write chat
message or assistant reply content to stdout, stderr, or any log output (there is no
leveled-logging framework to rely on — the prohibition is absolute).

#### Scenario: Refresh clears the conversation
- **WHEN** the user reloads the page after several chat turns
- **THEN** the Chat subtab starts empty and no server endpoint exists to recover the
  prior conversation

#### Scenario: Message content is never logged
- **WHEN** a chat turn runs
- **THEN** captured server stdout/stderr contains none of the message or reply text

### Requirement: Session-scoped MCP toolset
The spawned CLI SHALL be given a generated MCP configuration exposing exactly three
tools, all hard-bound to the `:sessionId` of the originating request via the turn
registration (the model cannot address any other session — no tool parameter names a
session):

- `get_transcript_words` — returns the session's transcript words (the DeepGram output)
  with the hub row fields (the HTTP read surface's per-word `session_id` is omitted, being
  redundant when the session is fixed).
- `list_topics` — returns the session's topics with the hub row fields.
- `create_topic` — creates one topic; input SHALL be validated with the same bounds as
  the existing `topicCreateSchema` (`session_time` ≤ 20 chars, `duration_sec` ≥ 0,
  `topic_level` 1–10 integer, `summary` ≤ 8000 chars); a violation SHALL return a tool
  error to the model (no insert, no crash).

`create_topic` SHALL write through the existing `SessionHub.insertTopic` path so the
insert is transactional and the ordinal is server-assigned — the identical code path a
manual insert takes; the hub SHALL be resolved at call time (never held across an
`await`). Topics have no WebSocket emission today (fact-check 2026-07-14) and the MCP
tools MUST NOT introduce one, alter any WS emission semantics, or add or alter any public
HTTP surface.

#### Scenario: AI-created topic matches a manual insert
- **WHEN** the model calls `create_topic` with a valid payload during a chat turn
- **THEN** the topic row is inserted through `SessionHub.insertTopic` with a
  server-assigned ordinal, indistinguishable from a manually inserted row, and no WS
  message is emitted (matching manual-insert behavior)

#### Scenario: Out-of-bounds tool input is rejected safely
- **WHEN** the model calls `create_topic` with `topic_level` 99
- **THEN** the tool returns a validation error to the model, no row is inserted, and the
  chat turn continues

#### Scenario: Tools cannot reach another session
- **WHEN** a chat turn runs for session A
- **THEN** every MCP tool reads and writes session A only, with no tool parameter that
  can name a different session

### Requirement: Subprocess security lockdown
The spawned CLI MUST be restricted to the autologger MCP tools and nothing else. The
spawn SHALL:

- load **no operator customizations** — hooks, plugins, and user/project/local
  `settings.json` and `CLAUDE.md` MUST NOT load or execute in the child (e.g.
  `--setting-sources ""` / equivalent), because lifecycle hooks run shell unconditionally
  and are not governed by tool allow/deny lists; the `claude login` credential path MUST
  still function under this setting;
- use strict MCP configuration so only the generated config loads
  (`--strict-mcp-config`), ignoring operator/project MCP servers;
- deny built-in tools and allow only the three `mcp__autologger__*` tools (positive
  denial of the built-in set, plus an explicit allowlist — not a name-keyed denylist that
  drifts as the CLI's tool inventory grows);
- run with `shell: false` and an argument array; deliver the user message via stdin;
- use a working directory outside the repo and `DATA_DIR`; and
- inherit a minimal environment (at least `HOME` for credentials and `PATH`; proxy/TLS
  vars added where the deployment needs them).

The chat endpoint MUST NOT provide a path to arbitrary command execution or host
filesystem access for any authenticated user.

#### Scenario: Prompt-injected shell request cannot execute
- **WHEN** a chat message (or injected transcript content) asks the model to run a shell
  command or read a host file
- **THEN** the CLI has no permitted tool capable of doing so and no command executes

#### Scenario: Operator hooks and plugins do not fire in the child
- **WHEN** the operator's `~/.claude` configures lifecycle hooks, plugins, or a user-level
  `CLAUDE.md`
- **THEN** none of them load or execute in the spawned chat subprocess

#### Scenario: Operator MCP configs are not inherited
- **WHEN** the operator's `~/.claude` registers additional MCP servers
- **THEN** the spawned chat subprocess loads only the generated autologger MCP config

### Requirement: Spend and concurrency bounds
Chat spend SHALL be bounded on two axes. Per autologger session, at most one turn SHALL
be in flight; a second concurrent request for the same session SHALL respond `409` with
an actionable detail and MUST NOT spawn a subprocess. Process-wide, at most
`AI_CHAT_MAX_CONCURRENT` turns (a configured ceiling with a small default) SHALL run at
once; a request beyond the ceiling SHALL be rejected without spawning. Each turn SHALL be
spawned with a per-turn cost ceiling (the CLI budget flag, e.g. `--max-budget-usd`, from a
configured value).

#### Scenario: Concurrent turn on the same session is rejected
- **WHEN** a chat turn is streaming for session A and a second `POST …/ai/chat` arrives
  for session A
- **THEN** the second request receives `409` and no additional subprocess is spawned

#### Scenario: Global concurrency ceiling rejects excess turns
- **WHEN** `AI_CHAT_MAX_CONCURRENT` turns are already in flight across distinct sessions
  and another turn is requested
- **THEN** it is rejected with an actionable detail and no additional subprocess is
  spawned

### Requirement: Subprocess lifecycle
The server SHALL spawn the child in its own process group and terminate it (and its MCP
child) when the turn completes, when a server-side turn timeout (`AI_CHAT_TIMEOUT_SEC`,
default 300) elapses, or on a best-effort basis when the SSE client disconnects. The turn
timeout is the guaranteed backstop; disconnect-driven termination is best-effort. The MCP
turn registration, the per-turn bearer token, and the generated config file SHALL be
dropped/removed when the turn ends. No orphaned `claude` processes survive the timeout.

#### Scenario: Timed-out turn is terminated
- **WHEN** a turn exceeds `AI_CHAT_TIMEOUT_SEC`
- **THEN** the server kills the process group and ends the stream with a `timeout` error
  event

#### Scenario: Client disconnect kills the subprocess (best-effort)
- **WHEN** the SSE client disconnects mid-turn and the abort signal is delivered
- **THEN** the server terminates the spawned CLI process group; if the signal is not
  delivered, the turn timeout guarantees termination

### Requirement: AI tab and subtab arrangement
The session workspace SHALL present two top-level feed tabs, `Event Feed` and `AI`. The
AI panel SHALL contain three subtabs — `Chat`, `Transcribe`, `Topics` — defaulting to
`Chat`, where Transcribe and Topics render the existing `TranscribeFeed` and `TopicsFeed`
components with their current behavior (columns, sorting, inline editing, Auto Generate /
Insert toolbar) unchanged. Chat message state and any in-flight SSE turn SHALL survive
switching among subtabs and between the AI and Event Feed tabs — switching MUST NOT
unmount the chat stream, abort the turn, or clear the conversation. The Chat subtab SHALL
render the conversation as whitespace-preserved plain text (no markdown rendering in v1),
stream assistant replies as they arrive, surface `tool` events as activity indicators,
offer a Stop control that aborts the in-flight turn (client aborts the fetch; server
terminates per the lifecycle requirement), show a clear not-configured state when the
endpoint returns `503`, and render terminal `error` events. On receiving a `tool` event
naming `create_topic`, the chatting client SHALL invalidate its topics query so AI-created
rows appear in the Topics subtab during the turn — this client-side refresh is the
liveness mechanism (there is no topics WS emission to rely on). The exact rendered tab and
subtab **label strings are non-normative** (the restructure is web-only, not
contract-bearing); the normative requirements are the two-tab / three-subtab structure,
the feeds' unchanged behavior, state survival across switches, the liveness refresh, the
Stop control, and the not-configured state.

#### Scenario: Feeds survive the move
- **WHEN** the user opens AI › Transcribe or AI › Topics
- **THEN** the feed behaves exactly as the former top-level tab did

#### Scenario: Switching subtabs mid-turn preserves the turn
- **WHEN** the user switches to AI › Topics (or Event Feed) while a turn is streaming
- **THEN** the turn keeps streaming, the subprocess is not killed, and the conversation
  is intact on return to Chat

#### Scenario: AI-created topics appear during the turn
- **WHEN** the chatting client receives a `tool` SSE event naming `create_topic`
- **THEN** it invalidates its topics query, and the new row is visible in the Topics
  subtab without a page reload

#### Scenario: Stop aborts an in-flight turn
- **WHEN** the user clicks Stop during a streaming turn
- **THEN** the client aborts the request and the server terminates the subprocess

#### Scenario: Unconfigured chat is explained in place
- **WHEN** the user sends a message while the server has no `CLAUDE_CLI_PATH`
- **THEN** the Chat subtab shows the not-configured explanation rather than a generic
  failure

### Requirement: Egress and spend disclosure
The README SHALL document the AI chat feature: that enabling it sends session transcript
and topic content to Anthropic via the operator's `claude` CLI credentials, that turns
consume the operator's Anthropic quota/spend (with the concurrency ceiling and per-turn
budget as the bounds), the `CLAUDE_CLI_PATH` gate, the open-network refusal, the security
posture (no operator hooks/plugins/CLAUDE.md, MCP-only toolset, no host shell/filesystem
access), the requirement to run the server as the logged-in operator (and that
node-on-PATH / proxy vars may be needed), and the minimum tested CLI version.
`.env.example` SHALL carry the new variables (`CLAUDE_CLI_PATH`, `AI_CHAT_TIMEOUT_SEC`,
`AI_CHAT_MAX_CONCURRENT`, and the per-turn budget var) with comments.

#### Scenario: Disclosure ships with the feature
- **WHEN** the change is archived
- **THEN** the README contains the AI chat section with egress, spend/bounds, gating,
  open-network refusal, and lockdown documented, and `.env.example` lists the new
  variables

