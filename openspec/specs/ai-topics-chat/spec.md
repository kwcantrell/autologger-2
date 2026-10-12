# ai-topics-chat Specification

## Purpose
Defines the per-session AI chat: `POST /api/sessions/:sessionId/ai/chat`, gated on the caller's own AI route, runs either an in-process AI SDK tool loop on the caller's saved language model (behind a guarded fetch) or, for allowlisted operator accounts that chose it, a locked-down `claude` CLI subprocess, with a session-scoped toolset, and streams the reply as SSE. It also covers multi-turn continuity bound to the autologger session, ephemeral history, spend, concurrency and lifecycle bounds, and the AI tab in the web client.

## Requirements

### Requirement: Configuration-gated AI chat endpoint
The AI chat SHALL be gated on the **caller's AI route**, resolved on every request from the
caller's saved language model (`provider-credentials`) and the deployment's configuration:

- **Claude CLI** when the caller's saved `llm` provider is `claude-cli`, `CLAUDE_CLI_PATH` names
  the `claude` CLI executable (absolute path or a name resolvable on `PATH`; unset, blank or
  whitespace-only counts as unset), and the caller's email is on `CLAUDE_CLI_EMAILS` (matched
  like `RUN_FEATURE_EMAILS`, except that the bootstrap owner is not implicitly listed);
- **AI SDK** when the caller's saved `llm` credential is any other provider and it decrypts: the
  server calls that provider in process with the turn's tools;
- **none** when the caller has no usable route, in every mode: a caller with no saved `llm`
  credential (there is no development-mode or other fallback to the Claude CLI), a `claude-cli`
  choice by a caller no longer on `CLAUDE_CLI_EMAILS` or while `CLAUDE_CLI_PATH` is blank, and a
  credential that does not decrypt.

`CLAUDE_CLI_PATH` alone SHALL NOT enable AI chat for any caller. When the route is none,
`POST /api/sessions/:sessionId/ai/chat` SHALL respond
`503 {"detail": "Add a language model in Settings → Advanced to use the assistant."}` and run
nothing. The route SHALL be resolved per request, so a change to the caller's saved credential or
to the allowlist applies to the caller's next turn. When a route resolves, the endpoint SHALL run
the chat turn on that route. The changed `503` detail amends `api-contract-freeze`; no other
route, shape, status code or WS emission changes.

#### Scenario: Unconfigured deployment returns 503
- **WHEN** in production or development mode a caller with no saved `llm` credential calls
  `POST /api/sessions/:id/ai/chat`, whether or not `CLAUDE_CLI_PATH` is set and whether or not
  the caller is on `CLAUDE_CLI_EMAILS`
- **THEN** the response is `503` with the detail naming Settings → Advanced, no subprocess is
  spawned and no model request is made

#### Scenario: Configured deployment serves the chat turn
- **WHEN** a caller with a saved OpenAI-compatible, Anthropic, OpenAI or Google `llm` credential
  posts a valid chat message
- **THEN** the response is `200` with an SSE stream of the reply, produced by an AI SDK turn on
  that credential

#### Scenario: An allowlisted caller who chose the Claude CLI runs on the CLI
- **WHEN** `CLAUDE_CLI_PATH` is set, the caller's email is on `CLAUDE_CLI_EMAILS`, and the caller's
  saved `llm` provider is `claude-cli`
- **THEN** the turn runs on the `claude` CLI and the response is `200` with an SSE stream

#### Scenario: A caller removed from the allowlist loses the CLI on the next turn
- **WHEN** a caller whose saved `llm` provider is `claude-cli` is no longer on `CLAUDE_CLI_EMAILS`
- **THEN** the next chat request answers the not-configured `503` and no `claude` subprocess is
  spawned

#### Scenario: An allowlisted caller who chose another provider runs on the AI SDK route
- **WHEN** a caller on `CLAUDE_CLI_EMAILS` has saved an OpenAI-compatible `llm` credential
- **THEN** the turn runs on the AI SDK route with that credential, not on the CLI

#### Scenario: An allowlisted caller with no saved language model is not served
- **WHEN** the server runs in development mode with `CLAUDE_CLI_PATH` set, and a caller on
  `CLAUDE_CLI_EMAILS` with no saved `llm` credential posts a chat message
- **THEN** the response is the not-configured `503` and no `claude` subprocess is spawned; the
  caller gets the CLI only after saving the `claude-cli` provider

#### Scenario: A credential that does not decrypt is not served
- **WHEN** a caller's saved non-CLI `llm` credential cannot be decrypted with the server's key
- **THEN** the response is the not-configured `503` and no model request is made

### Requirement: Chat request contract
`POST /api/sessions/:sessionId/ai/chat` SHALL accept a JSON body
`{ message: string, claude_session_id?: string | null, history?: [{ role: "user" | "assistant", text: string }] }`
where `message` is 1–8000 characters after trimming, `claude_session_id`, when present, is a
non-empty string or `null`, and `history`, when present, holds at most 40 entries, each `text` 1–8000
characters after trimming, with at most 64 000 characters of `text` in total. The endpoint
SHALL evaluate checks in this order, matching the `transcript-words/generate` sibling:
authentication → session resolution/scoping (`404` for nonexistent, deleted, or
out-of-studio sessions, exactly as sibling session sub-routes such as
`POST /api/sessions/:sessionId/events`) → configuration gate (`503`, the caller's AI route) →
approved user (`403` with the detail `This feature is limited to approved users on this server.`,
api-contract-freeze "Run features are limited to approved users", run-status-and-sweeper D9) →
body validation → single-flight (`409`). Body validation SHALL use the repo's
existing semantics — `422 { detail: issues }` for schema violations (the global `ZodError`
mapping), including every `history` bound violation, `400` for malformed JSON, and the existing
`400` for a NUL character anywhere in the body, `history` included — and MUST NOT spawn a
subprocess or make a model request. All error bodies SHALL be the repo's `{ detail }` shape.
A `claude_session_id` of `null` SHALL be treated exactly as an absent one on both routes, so a
client that echoes a `done` event's `claude_session_id` verbatim never gets `422` for it.

#### Scenario: Invalid body rejected without side effects
- **WHEN** a client posts an empty/whitespace `message` or a body missing `message`
- **THEN** the response is `422 { detail }`, no `claude` subprocess is spawned and no model
  request is made

#### Scenario: Out-of-bounds history is rejected without side effects
- **WHEN** a client posts a `history` with 41 entries, an entry whose `text` is empty after
  trimming or longer than 8000 characters, an entry whose `role` is neither `user` nor
  `assistant`, or entries totalling more than 64 000 characters
- **THEN** the response is `422 { detail }`, no subprocess is spawned and no model request is made

#### Scenario: A NUL in history is refused like a NUL in the message
- **WHEN** a client posts a `history` entry whose `text` contains a NUL character
- **THEN** the response is the existing NUL `400`, no subprocess is spawned and no model request
  is made

#### Scenario: A null session id is treated as absent
- **WHEN** a client posts a chat message with `claude_session_id: null`, on the Claude CLI route or
  the AI SDK route
- **THEN** the request passes body validation, no `422` is returned for it, and the turn runs as if
  no `claude_session_id` were sent (a fresh CLI session on the CLI route)

#### Scenario: Unauthorized session is masked as 404 before the config gate
- **WHEN** a caller without studio access to `:sessionId` posts a chat message, whether or
  not the feature is configured or a turn is in flight
- **THEN** the response is `404` (never `503`/`409`), leaking neither configuration nor
  in-flight state

#### Scenario: Unauthenticated request rejected like sibling routes
- **WHEN** a request lacks the credentials required by existing session sub-routes under
  the active auth configuration
- **THEN** the chat endpoint rejects it with the same status and shape those routes use

#### Scenario: A user who is not approved is refused before any spawn
- **WHEN** the caller's AI route resolves and a member of the session's show whose email is not
  an approved user posts a chat message
- **THEN** the response is `403 { detail }` with the fixed detail, no turn slot or run lease is
  taken, no subprocess is spawned and no model request is made

### Requirement: SSE reply stream shape
On acceptance, the endpoint SHALL respond `200` with `Content-Type: text/event-stream`.
The following event types are defined, each with a JSON data payload:

- `delta` — `{ "text": string }`: an assistant **text** fragment, in order. The server
  MUST relay only assistant text; model reasoning/thinking content MUST NOT be relayed. On the
  Claude CLI route this is the CLI's thinking content. On the AI SDK route it is reasoning the
  provider reports in its reasoning field, and reasoning an OpenAI-compatible server inlines in its
  text between `<think>` and `</think>` (even when a tag is split across stream chunks). Reasoning
  an OpenAI-compatible server emits as plain text without an opening `<think>` tag (a chat template
  that opens the tag inside the prompt) cannot be told apart from the answer and is relayed as
  text; the README tells operators of such servers to enable the server's reasoning parser
  ("Egress and spend disclosure").
- `tool` — `{ "name": string }`: notice that the named tool was invoked, where `name` is the
  tool's **short name** — one of `get_transcript_words`, `list_topics`, `create_topic`. On the
  Claude CLI route the server strips the `mcp__autologger__` prefix; on the AI SDK route the tools
  already carry their short names, so no prefix is stripped. A tool call whose name is not one of
  the turn's tools, including a call to a tool the turn does not define (a name the model
  invented), SHALL NOT be relayed.
- `done` — `{ "claude_session_id": string | null }`: terminal success event. On the Claude CLI
  route it carries the CLI session id the client echoes back for the next turn; on the AI SDK
  route it is `null`. An AI SDK chat turn that ends **capped** (the step count reached the chat
  step cap, the chat token budget fired, or the last step still had tool calls) or **incomplete**
  (the last step finished for output length, content filter, error or another reason) SHALL end
  with `done`, the assistant text streamed so far being the answer.
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
internal-error) — never a passthrough of subprocess stdout, stderr, result text, model provider
error messages, request bodies or response bodies, environment values, credentials, or
device-login URLs. On the AI SDK route every model-side error — a provider error of any status,
retries exhausted, a failed or refused outbound request, a passed request or byte cap or the
per-turn tool-call cap, or a provider stream that drops mid-response — SHALL end the turn with the
upstream-failed detail, never another string; a timeout keeps the timeout detail. A passed cap
SHALL always end a chat turn with exactly one upstream-failed `error` event, and SHALL never be
treated as a client abort that ends the stream silently. An AI SDK turn's ending SHALL be decided
from the turn's own step records (each step's tool calls, tool results and finish reason), never
from the provider's reported finish reason alone, because a provider can report `stop` while still
calling tools.

#### Scenario: Successful turn streams deltas then done
- **WHEN** a chat turn completes normally
- **THEN** the client received zero or more `delta`/`tool` events followed by exactly one
  `done` event, whose `claude_session_id` is a non-empty string on the Claude CLI route and
  `null` on the AI SDK route, and the stream closed

#### Scenario: Failed turn ends with a scrubbed error event
- **WHEN** the `claude` subprocess exits nonzero, is not logged in, or its output cannot
  be parsed
- **THEN** the stream ends with exactly one `error` event whose detail is one of the
  fixed server-authored strings, free of secrets and CLI output, and the stream closes

#### Scenario: A provider error on the AI SDK route is scrubbed
- **WHEN** an AI SDK turn's model request fails (for example the provider rejects the key with
  `401` and a response body naming the account, or answers `500`)
- **THEN** the stream ends with exactly one `error` event carrying the fixed upstream-failed
  string, and neither the error message, the request body nor the provider's response body
  appears in the stream or the server log

#### Scenario: A provider stream that drops mid-response ends upstream-failed
- **WHEN** an AI SDK turn's provider closes the response stream after some text and before the
  step finishes
- **THEN** the stream ends with exactly one `error` event carrying the upstream-failed detail, and
  nothing from the error appears in the stream or the server log

#### Scenario: Every model-side error maps to the same detail
- **WHEN** an AI SDK turn ends because the provider answered `401`, `429` or `500` until retries
  were exhausted, the outbound request was refused, or a request or byte cap or the per-turn
  tool-call cap was passed
- **THEN** in every case the terminal `error` event's detail is the fixed upstream-failed string

#### Scenario: A chat turn stopped by a cap ends with done
- **WHEN** an AI SDK chat turn's model still wants to call tools when the chat step cap or the chat
  token budget stops the turn
- **THEN** the stream ends with exactly one `done` event with `claude_session_id: null`, and the
  `delta` events streamed before it are the answer

#### Scenario: A provider that reports stop while still calling tools at the step cap is capped
- **WHEN** an AI SDK chat turn's provider reports the finish reason `stop` on every step while
  still emitting tool calls, until the step count reaches the chat step cap
- **THEN** the turn ends as capped: the stream ends with exactly one `done` event after the text
  streamed so far, and no further request reaches the provider

#### Scenario: An output-length stop ends a chat turn with done
- **WHEN** an AI SDK chat turn's last step finishes for output length, with or without an
  unexecuted tool call
- **THEN** the turn ends as incomplete: the stream ends with exactly one `done` event, and the
  `delta` events streamed before it are the answer

#### Scenario: A cap breach ends with one error event, never silently
- **WHEN** an AI SDK chat turn passes the per-turn tool-call cap, or a request or byte cap of the
  guarded model requests, which aborts the turn's model request
- **THEN** the stream ends with exactly one `error` event carrying the upstream-failed detail, and
  never ends with no terminal event as a client abort may

#### Scenario: Tool names are reported as short names on both routes
- **WHEN** the model calls `create_topic` on an AI SDK turn, or `mcp__autologger__create_topic`
  on a Claude CLI turn
- **THEN** the client receives `tool` with name `create_topic` in both cases

#### Scenario: Model reasoning is not streamed to the client
- **WHEN** the CLI stream contains thinking content, or the AI SDK stream contains reasoning in the
  provider's reasoning field or an OpenAI-compatible server's inline text between `<think>` and
  `</think>` split across stream chunks
- **THEN** none of that content appears in any `delta` event; only assistant text is
  relayed

#### Scenario: A call to a tool outside the turn's set is not relayed
- **WHEN** on an AI SDK chat turn the model calls a tool named `bash`, which the turn does not
  define, or `create_event`
- **THEN** no `tool` event is emitted for that call and nothing runs for it

#### Scenario: Client ignores unknown event types
- **WHEN** the server emits an event type the client does not recognize
- **THEN** the client ignores it without error (forward compatibility)

### Requirement: Multi-turn continuity bound to the autologger session
Continuity SHALL depend on the caller's AI route.

**Claude CLI route.** The server SHALL spawn the CLI in non-interactive print mode with
machine-readable streaming output (`claude -p --output-format stream-json`), delivering the user
message via **stdin** (never as an interpretable argv positional, so a message beginning with `-`
cannot become a CLI flag). The CLI route SHALL ignore `history`. The server SHALL record, for each
`claude_session_id` it issues, the autologger `:sessionId`
and the signed-in user whose turn issued it, in the catalog's key-value store with a 7-day
expiry, so any server process sharing the database sees it (ADR 0021 slice 9b). When a request
carries a `claude_session_id` that was issued for the **same** `:sessionId` **and the same
user**, and the CLI's conversation file for it exists in this process's CLI store, the server
SHALL resume that CLI conversation (CLI resume flag, without `--fork-session` so the id is
stable). A `claude_session_id` not issued for this `:sessionId` and user (foreign, another
user's, expired, or forged), or whose conversation file this process cannot find, SHALL be
rejected with `422` before any subprocess is spawned. The binding holds identifiers only, never
conversation content. When absent or `null`, a fresh CLI session
starts. The server SHALL relay the resulting session id in the `done` event, and the
client SHALL echo the id from the most recent `done`.

**AI SDK route.** The server stores nothing about the conversation. Continuity SHALL come only
from the client-supplied `history`, which the client builds from its displayed conversation (user
messages and completed assistant replies, oldest dropped first to fit the bounds; never the
in-flight reply, error rows or tool notices). The server SHALL send `history` to the provider as
real conversation messages, each entry with its own `user` or `assistant` role and in order,
followed by the new message as a `user` message; no delimiter scheme is used. The turn's system
prompt SHALL state that transcript and tool content are data, not instructions. History SHALL be
no more trusted than the message itself and SHALL NOT widen what the turn's tools can reach. The
AI SDK route SHALL ignore `claude_session_id`: it SHALL NOT check its binding and SHALL NOT answer
`422` for it, so an id left over from an earlier CLI turn is harmless.

#### Scenario: Second turn resumes the first turn's session
- **WHEN** on the Claude CLI route a client sends turn two with the `claude_session_id` from turn
  one's `done` event on the same session
- **THEN** the spawned CLI resumes that session and the reply reflects turn one's context

#### Scenario: Foreign session id is rejected, not resumed
- **WHEN** on the Claude CLI route a client posts to `…/sessions/B/ai/chat` a
  `claude_session_id` that was issued for session A
- **THEN** the response is `422`, no subprocess is spawned, and session A's conversation
  is never resumed under session B

#### Scenario: Message cannot smuggle a CLI flag
- **WHEN** a client sends a `message` of `--dangerously-skip-permissions`
- **THEN** it is delivered as prompt text via stdin and is never parsed as a CLI option

#### Scenario: A co-member cannot resume another user's conversation
- **WHEN** on the Claude CLI route user U2, with access to session A, posts to
  `…/sessions/A/ai/chat` a `claude_session_id` issued to user U1's turn on session A
- **THEN** the response is `422` and no subprocess is spawned

#### Scenario: Another process resumes the conversation
- **WHEN** turn one runs through process A and turn two, from the same user and session with turn
  one's `claude_session_id`, is served by process B that can read the CLI's conversation file
- **THEN** process B resumes the conversation

#### Scenario: A missing conversation file is a 422, not a CLI error
- **WHEN** a correctly bound `claude_session_id` is sent to a process whose CLI store has no
  conversation file for it
- **THEN** the response is `422` and no subprocess is spawned

#### Scenario: An AI SDK turn continues from the re-sent history
- **WHEN** on the AI SDK route a client sends turn two with a `history` holding turn one's
  message and reply
- **THEN** the provider receives those entries as a `user` message and an `assistant` message, in
  order, followed by the new `user` message, the reply can reflect turn one's context, and the
  server stored nothing between the turns

#### Scenario: A stale CLI session id is ignored on the AI SDK route
- **WHEN** a caller who switched from the Claude CLI to another `llm` credential sends a
  `claude_session_id` issued for another session or user
- **THEN** the turn runs normally on the AI SDK route, with no `422`, and `done` carries
  `claude_session_id: null`

### Requirement: Ephemeral chat history
The server MUST NOT persist chat conversation content: no chat tables in the catalog DB
or the session tables, no chat blobs under `DATA_DIR`, and no chat-history read endpoint.
Server-side conversation state lives only in the client's page state; CLI-side session
storage lives outside `DATA_DIR` in the CLI's own store. On the AI SDK route the client-supplied
`history` SHALL be used only to build that one turn's model requests and SHALL NOT be stored, and
nothing of the turn (message, history, reply or tool results) SHALL outlive the turn on the
server. The server MUST NOT write chat message, `history`, or assistant reply content
to stdout, stderr, or any log output (there is no leveled-logging framework to rely on — the
prohibition is absolute). No model-side error object SHALL leave the AI turn: the turn reduces
every such error to a fixed classification at its boundary, so nothing carrying the prompt or the
provider's response reaches the route. As a backstop, the server's global error log SHALL record an
AI SDK error, or any error carrying a model request body or a provider response body, as its class
name only — never the prompt, transcript, history, provider body or key.

#### Scenario: Refresh clears the conversation
- **WHEN** the user reloads the page after several chat turns
- **THEN** the Chat subtab starts empty and no server endpoint exists to recover the
  prior conversation

#### Scenario: Message content is never logged
- **WHEN** a chat turn runs
- **THEN** captured server stdout/stderr contains none of the message, history or reply text

#### Scenario: A failed AI SDK turn is diagnosable from the server log without content
- **WHEN** an AI SDK turn fails because the provider answered `429`, or because a request or byte
  cap was reached
- **THEN** the server's failure line names only the classification and the HTTP status (for
  example `status=429`) or the cap that was reached, and holds no message, provider body, header,
  prompt, transcript, history or key

#### Scenario: A failing turn leaves no prompt, transcript or key in the server logs
- **WHEN** an AI SDK turn fails with a provider error that carries the turn's prompt, history and
  the provider's response body, and, separately, such an error reaches the server's global error
  log from a route
- **THEN** the turn's caller sees only the fixed classification, the global error log records only
  the error's class name, and none of the prompt, transcript, history, provider body or key
  appears in captured server stdout or stderr

#### Scenario: Nothing of an AI SDK turn survives it
- **WHEN** an AI SDK chat turn ends, by completion, error, timeout or client abort
- **THEN** no database row or file holds the turn's message, history or reply

### Requirement: Session-scoped MCP toolset
Each chat turn SHALL be given session-scoped tools, all hard-bound to the `:sessionId` of the
originating request via the turn registration (the model cannot address any other session — no
tool parameter names a session). On the Claude CLI route the spawned CLI SHALL be given a
generated MCP configuration exposing those tools. On the AI SDK route the server SHALL give the
model the same tools in process, wrapping the **same tool bodies, input schemas and validation**
the MCP server uses, so a tool call has the same effect and result on either route. The registry
comprises four tools; **each turn registration SHALL carry the turn's tool set, and the per-request
MCP server, or the AI SDK turn, SHALL offer only that turn's tools — a chat turn's set is exactly
the three tools below** (the CLI `--allowedTools` allowlist remains as belt-and-braces).
`create_event` (defined by `auto-event-generation`) is offered only for event-generation turns; a
chat turn never exposes it:

- `get_transcript_words` — returns the session's transcript rendered as **compact,
  model-readable text**, not JSON rows: consecutive words are grouped into per-speaker
  segments, each line prefixed with the segment's session-time anchor and speaker when
  present (e.g. `[HH:MM:SS] speaker S1: …`); a session with no transcript renders as a
  short placeholder line. The rendering carries the word text, speaker, and session-time
  anchor and omits the other hub row fields (`start_sec`, `created_at_utc`, `ordinal`,
  `session_id`, …), which the model does not need and whose per-word repetition made the
  JSON form a single oversized payload that overflowed the CLI's tool-output limit and
  hid the transcript from the model. The output SHALL be a bounded, non-JSON rendering.
  On a generation-density turn (event generation and the topic-generation one-shot) the
  same tool renders at generation density with deterministic paging — defined solely by
  `auto-event-generation`'s "Generation-density transcript rendering". Chat turns keep
  the unpaged compact rendering unchanged, and a chat turn's registration SHALL NOT
  carry the paged-transcript word snapshot (the field that keys paged delivery).
- `list_topics` — returns the session's topics with the hub row fields.
- `create_topic` — creates one topic; input SHALL be validated with the same bounds as
  the existing `topicCreateSchema` (`session_time` ≤ 20 chars, `duration_sec` ≥ 0,
  `topic_level` 1–10 integer, `summary` ≤ 8000 chars); a violation SHALL return a tool
  error to the model (no insert, no crash).

**Tool calls on the AI SDK route** SHALL be bounded and serialized:

- **per step, a soft cap of 16 calls**: a call past the 16th in one step SHALL run nothing and SHALL
  return the tool error "Too many tool calls in one step; continue in the next step." to the
  model, and the turn SHALL continue;
- **per turn, a hard cap** of 32 calls (chat) or 300 (topic and event generation): a call past it
  SHALL run nothing, no further tool body or model request SHALL run, and the turn SHALL end as
  failed — a chat turn with exactly one upstream-failed `error` event, a generation turn with its
  `502`;
- one tool body SHALL run at a time per turn, even when the model asks for several calls in one
  step;
- a tool call that arrives after the turn ended (client abort, timeout, or the turn finished)
  SHALL run nothing;
- a body's validation failure SHALL return that body's own validation text to the model as a tool
  error, as on the MCP server; any other error a body throws SHALL return the fixed result "Tool
  failed." to the model, never the error's message.

`create_topic` SHALL write through the existing `SessionHub.insertTopic` path so the
insert is transactional and the ordinal is server-assigned — the identical code path a
manual insert takes; the hub SHALL be resolved at call time, inside the tool body, and
never from a reference captured when the turn was registered; within one tool invocation the
body MAY use the hub it resolved across that hub's own awaited operations, and SHALL NOT keep
the reference beyond the invocation (core-ports-architecture "AI tool bodies consume the
session facade directly"). Topics have no WebSocket emission today (fact-check 2026-07-14) and the MCP
tools MUST NOT introduce one, alter any WS emission semantics, or add or alter any public
HTTP surface. (`create_event`'s writes produce the existing `event.changed` emission a
manual event insert already produces — governed by `auto-event-generation`; that is not
an alteration of emission semantics.)

#### Scenario: AI-created topic matches a manual insert
- **WHEN** the model calls `create_topic` with a valid payload during a chat turn, on either route
- **THEN** the topic row is inserted through `SessionHub.insertTopic` with a
  server-assigned ordinal, indistinguishable from a manually inserted row, and no WS
  message is emitted (matching manual-insert behavior)

#### Scenario: Out-of-bounds tool input is rejected safely
- **WHEN** the model calls `create_topic` with `topic_level` 99, on either route
- **THEN** the tool returns a validation error to the model, no row is inserted, and the
  chat turn continues

#### Scenario: Tools cannot reach another session
- **WHEN** a chat turn runs for session A
- **THEN** every tool reads and writes session A only, with no tool parameter that
  can name a different session

#### Scenario: Transcript is delivered as bounded text, not JSON rows
- **WHEN** the model calls `get_transcript_words` for a session with a transcript
- **THEN** the tool returns a compact per-speaker, session-time-anchored text rendering
  (not a JSON array of hub rows), so a multi-thousand-word transcript stays within the
  CLI's tool-output limit and is visible to the model

#### Scenario: Chat turns keep the unpaged rendering
- **WHEN** a chat turn's model calls `get_transcript_words`
- **THEN** the tool has the zero-argument input shape and returns the whole compact
  rendering in one result — no `page` argument, no continuation marker — and the chat
  turn's registration carries no paged-transcript word snapshot

#### Scenario: Chat turns cannot write events
- **WHEN** a chat turn runs
- **THEN** `create_event` is not offered to the model (on the CLI route the turn's MCP server does
  not register it, so a call to it fails at the server independent of CLI flags, and the spawned
  CLI's allowlist names exactly `get_transcript_words`, `list_topics`, `create_topic`; on the AI
  SDK route the model is given exactly those three tools)

#### Scenario: A thrown tool failure does not leak its message
- **WHEN** a tool body throws an unexpected error during an AI SDK turn
- **THEN** the model receives the fixed result "Tool failed.", never the error's message, and the
  turn continues

#### Scenario: A validation failure returns the body's own text
- **WHEN** on an AI SDK turn the model calls `create_topic` with `topic_level` 99
- **THEN** the model receives the same validation text the MCP server returns for that input, as a
  tool error, no row is inserted, and the turn continues

#### Scenario: Calls past 16 in one step get a tool error and the turn continues
- **WHEN** on an AI SDK turn the model asks for 20 tool calls in one step, within the per-turn cap
- **THEN** the first 16 run, the 4 past the 16th run nothing and each returns the tool error "Too
  many tool calls in one step; continue in the next step." to the model, and the turn continues
  with its next step

#### Scenario: The per-turn tool-call cap fails the turn
- **WHEN** an AI SDK chat turn's model has made 32 tool calls and asks for another
- **THEN** that call runs nothing, no further model request is made, and the stream ends with
  exactly one upstream-failed `error` event

#### Scenario: Parallel tool calls run one at a time
- **WHEN** on an AI SDK turn the model asks for several tool calls in one step
- **THEN** each tool body starts only after the previous one has finished

#### Scenario: A tool call after the turn ended runs nothing
- **WHEN** a tool call for an AI SDK turn arrives after the client aborted, the turn timed out or
  the turn finished
- **THEN** no tool body runs for it, and no row is read or written for it

### Requirement: Subprocess security lockdown
The spawned CLI, and the model on the AI SDK route, MUST be restricted to the autologger tools
and nothing else.

On the Claude CLI route the spawn SHALL:

- load **no operator customizations** — hooks, plugins, and user/project/local
  `settings.json` and `CLAUDE.md` MUST NOT load or execute in the child (e.g.
  `--setting-sources ""` / equivalent), because lifecycle hooks run shell unconditionally
  and are not governed by tool allow/deny lists; the `claude login` credential path MUST
  still function under this setting;
- use strict MCP configuration so only the generated config loads
  (`--strict-mcp-config`), ignoring operator/project MCP servers;
- deny built-in tools and allow only the turn's explicit `mcp__autologger__*` allowlist
  (positive denial of the built-in set, plus an explicit per-turn allowlist — not a
  name-keyed denylist that drifts as the CLI's tool inventory grows); a chat turn's
  allowlist is the three chat tools;
- run with `shell: false` and an argument array; deliver the user message via stdin;
- use a working directory outside the repo and `DATA_DIR`; and
- inherit a minimal environment (at least `HOME` for credentials and `PATH`; proxy/TLS
  vars added where the deployment needs them).

On the AI SDK route no process is spawned: the turn runs inside the API server, and the model's
only capabilities SHALL be the turn's tools. In particular:

- nothing the model drives SHALL run a command, read or write a file, or reach any network
  destination; the only actions available to it are calls to the turn's tool set, which act on
  the originating session through the validated tool bodies;
- a model call naming a tool outside the turn's set, including a tool the turn does not define,
  SHALL run nothing and SHALL NOT be relayed;
- the model's tool calls SHALL be limited per step (soft) and capped per turn, and run one at a time
  ("Session-scoped MCP toolset"), so a hostile provider cannot make the shared server process run
  unbounded tool work;
- the model SHALL be addressed only through the caller's credential and its provider, never by a
  model-id string that a hosted gateway could route, so no model request reaches anything but the
  credential's destination (see "Model requests on the AI SDK route are guarded").

The chat endpoint MUST NOT provide a path to arbitrary command execution or host
filesystem access for any authenticated user.

#### Scenario: Prompt-injected shell request cannot execute
- **WHEN** a chat message (or injected transcript content) asks the model to run a shell
  command or read a host file
- **THEN** the CLI has no permitted tool capable of doing so and no command executes

#### Scenario: Prompt-injected shell request cannot execute on the AI SDK route
- **WHEN** on the AI SDK route a chat message, history entry or transcript content asks the model
  to run a shell command, read a host file or fetch a URL, and the model emits a call to a tool
  named, for example, `bash` or `read_file`
- **THEN** no such tool exists for the turn, nothing runs, no command executes, no host file is
  read and no connection is opened

#### Scenario: Operator hooks and plugins do not fire in the child
- **WHEN** the operator's `~/.claude` configures lifecycle hooks, plugins, or a user-level
  `CLAUDE.md`
- **THEN** none of them load or execute in the spawned chat subprocess

#### Scenario: Operator MCP configs are not inherited
- **WHEN** the operator's `~/.claude` registers additional MCP servers
- **THEN** the spawned chat subprocess loads only the generated autologger MCP config

### Requirement: Subprocess lifecycle
On the Claude CLI route the server SHALL spawn the child in its own process group and terminate
it (and its MCP child) when the turn completes, when a server-side turn timeout
(`AI_CHAT_TIMEOUT_SEC`, default 300) elapses, or on a best-effort basis when the SSE client
disconnects. On the AI SDK route the same timeout and the client disconnect SHALL abort the turn,
which ends the in-flight model request and closes its upstream connection; nothing is spawned, so
nothing can be orphaned. The turn timeout is the guaranteed backstop; disconnect-driven
termination is best-effort. The turn registration SHALL be dropped when the turn ends; on the CLI
route the per-turn bearer token and the generated config file SHALL be dropped/removed as well,
and on the AI SDK route the server SHALL release the turn's decrypted key. No orphaned `claude`
processes survive the timeout. On the AI SDK route, once the turn is no longer live (abort,
timeout or the end of the turn) a tool call SHALL run nothing. The route SHALL wait for any tool
body still running for the turn to finish before it acts on the turn's generation result (the
topics replace-all or the regenerate delete), removes a failed run's new topics, or releases the
session's turn slot and run lease; the run lease keeps renewing while it waits. The wait has no
fixed time bound of its own: a tool body takes no abort signal, and each of its database
statements is bounded by the existing statement timeout. A chat turn's terminal event, including
the `timeout` event a timed-out turn emits as today, MAY be sent before the wait; the slot is
released only after it. After the wait no tool body runs for the turn.

#### Scenario: Timed-out turn is terminated
- **WHEN** a turn exceeds `AI_CHAT_TIMEOUT_SEC`
- **THEN** the server kills the `claude` process group, or on the AI SDK route aborts the model
  request and closes its upstream connection, and ends the stream with a `timeout` error event

#### Scenario: Client disconnect kills the subprocess (best-effort)
- **WHEN** the SSE client disconnects mid-turn and the abort signal is delivered
- **THEN** the server terminates the spawned CLI process group, or on the AI SDK route aborts the
  model request and closes its upstream connection; if the signal is not delivered, the turn
  timeout guarantees termination

#### Scenario: The turn waits for a running tool body before ending
- **WHEN** an AI SDK turn's stream ends, times out, or is aborted while a `create_topic` body is
  still running
- **THEN** the session's turn slot and run lease are released only after that body finished, a
  timed-out turn still ends its stream with the `timeout` event, and a new turn for the session
  cannot start while the body runs

#### Scenario: An ended AI SDK turn leaves nothing behind
- **WHEN** an AI SDK turn ends for any reason
- **THEN** no upstream connection from the turn is open, its registration is gone, and a late tool
  call for it acts on nothing

### Requirement: AI tab and subtab arrangement
The workspace tab inventory, order, and labels are governed by `web-session-console` (which
this change makes the single owner of tab IA: Transcript, Topics, and the chat surface render
as top-level sibling tabs; there is no nested subtab arrangement). Within that structure, this
capability owns the chat surface's and feeds' semantics: the Transcript and Topics tabs render
the existing `TranscribeFeed` and `TopicsFeed` components with their current behavior
(columns, sorting, inline editing, Auto Generate / Insert toolbar) unchanged — except as
governed by web-session-console's capability-gating requirement (the Auto Generate control's
503 latch and single-channel errors). Chat message
state and any in-flight SSE turn SHALL survive switching among any of the workspace tabs —
switching MUST NOT unmount the chat stream, abort the turn, or clear the conversation. The
chat surface SHALL render the conversation as whitespace-preserved plain text (no markdown
rendering in v1), stream assistant replies as they arrive, surface `tool` events as activity
indicators, offer a Stop control that aborts the in-flight turn (client aborts the fetch;
server terminates per the lifecycle requirement), show a clear not-configured state when the
endpoint returns `503`, and render terminal `error` events. The not-configured state SHALL read
"Add a language model in Settings → Advanced to use the assistant." and SHALL clear, without a
page reload, when the user successfully saves a language model in Settings → Advanced. On
receiving a `tool` event naming
`create_topic`, the chatting client SHALL invalidate its topics query so AI-created rows
appear in the Topics tab during the turn — this client-side refresh is the liveness mechanism
(there is no topics WS emission to rely on). The normative requirements are: deference of tab
structure/labels to `web-session-console`, the feeds' unchanged behavior, state survival
across tab switches, the liveness refresh, the Stop control, and the not-configured state.

#### Scenario: Feeds survive the move
- **WHEN** the user opens the Transcript or Topics tab
- **THEN** the feed renders with its established columns, sorting, inline editing, and
  Auto Generate / Insert toolbar, behaviorally unchanged from before the IA restructure

#### Scenario: Switching tabs mid-turn preserves the turn
- **WHEN** a chat turn is streaming and the user switches to any other workspace tab and back
- **THEN** the stream is not aborted, the conversation is not cleared, and subsequent deltas
  continue rendering into the same conversation

#### Scenario: AI-created topics appear during the turn
- **WHEN** the in-flight turn emits a `tool` event naming `create_topic`
- **THEN** the client invalidates its topics query and the new topic row is visible in the
  Topics tab while the turn is still streaming

#### Scenario: Stop aborts an in-flight turn
- **WHEN** the user activates Stop during a streaming turn
- **THEN** the client aborts the fetch, the turn ends in the UI, and the conversation up to
  that point remains

#### Scenario: Unconfigured chat is explained in place
- **WHEN** the chat endpoint returns `503`
- **THEN** the chat surface shows its not-configured state in place, reading "Add a language
  model in Settings → Advanced to use the assistant." (no dead send affordance)

#### Scenario: Saving a language model clears the not-configured state
- **WHEN** the chat surface shows its not-configured state and the user then saves a language
  model in Settings → Advanced successfully
- **THEN** the chat surface leaves the not-configured state and offers a working send control
  without a page reload

### Requirement: Egress and spend disclosure
The README SHALL document the AI chat feature per route. For the **AI SDK** route: that a turn
sends session transcript and topic content, the message and the re-sent history from the server
directly to the caller's own language model provider, that the caller's own provider account
pays, that OpenAI requests are sent with storage off (`store: false`), that Anthropic requests use
prompt caching (cache reads are cheaper and don't count toward Anthropic's input rate limit), and
the bounds of each
route (chat, topic generation, event generation): the step cap, the output tokens per step (4000 for chat; `GENERATE_MAX_OUTPUT_TOKENS`, default 16 000, for generation), the
per-turn token budget (which counts uncached input, cache writes and output but not cache reads,
which a turn may overrun by at most one step, and which counts an estimate when a provider reports
no usage), at most 2 retries per model request, the turn timeout, at most
16 tool calls per step (further calls in the step get a tool error and the turn continues) and 32
(chat) or 300 (generation) per turn, and the per-turn request and byte caps of the guarded model
requests (60 requests, 4 MB per request body, 48 MB of request bodies, and the derived per-turn response-byte cap), with no
dollar cap. It SHALL also tell operators of OpenAI-compatible servers to enable the server's
reasoning parser: reasoning in the provider's reasoning field, or between `<think>` and `</think>`
in text, is never relayed, but reasoning a server emits as plain text without an opening `<think>`
tag reaches the chat as answer text. For the **Claude CLI** route: that enabling it
sends session transcript and topic content to Anthropic via the operator's `claude` CLI
credentials, that turns consume the operator's Anthropic quota/spend (with the per-session
single-flight and per-turn budget as the bounds, and no concurrency ceiling on
`AI_PROVIDER=claude_cli`: a deployment-wide ceiling is deferred to a later change (owner,
2026-10-11)), that only accounts on `CLAUDE_CLI_EMAILS` may choose it, the
requirement to run the server as the logged-in operator (and that
node-on-PATH / proxy vars may be needed), and the minimum tested CLI version. The README SHALL
also document the per-user route gate (`CLAUDE_CLI_PATH`, `CLAUDE_CLI_EMAILS` and the saved
language model, with no fallback to the Claude CLI in any mode), the step and token caps
(`AI_CHAT_MAX_STEPS`, `AI_CHAT_MAX_TOKENS`, `GENERATE_MAX_STEPS`, `GENERATE_MAX_OUTPUT_TOKENS`, `GENERATE_MAX_TOKENS`), and the
security posture of both routes (no operator hooks/plugins/CLAUDE.md, an autologger-tools-only
toolset, no host shell/filesystem access, a model on the AI SDK route that can only call the
turn's tools, and the user's key sent only to that user's provider).
`.env.example` SHALL carry the variables (`CLAUDE_CLI_PATH`, `CLAUDE_CLI_EMAILS` commented with no
value, `AI_CHAT_TIMEOUT_SEC`, `AI_PROVIDER`, the per-turn budget var, `AI_CHAT_MAX_STEPS`,
`AI_CHAT_MAX_TOKENS`, `GENERATE_MAX_STEPS`, `GENERATE_MAX_OUTPUT_TOKENS` and `GENERATE_MAX_TOKENS`) with comments.
`.env.example` SHALL NOT name an email address. `.env.example` SHALL NOT name
`AI_CHAT_MAX_CONCURRENT`. `docker/secrets-env.yaml` SHALL allow `AI_PROVIDER` and SHALL keep
`AI_CHAT_MAX_CONCURRENT`, marked as ignored, until every OpenBao secret has dropped it, because
the allowlist refuses a whole secret that holds an unlisted key (run-status-and-sweeper D1).

#### Scenario: Disclosure ships with the feature
- **WHEN** the change is archived
- **THEN** the README contains the AI chat section with egress, spend/bounds, gating,
  and lockdown documented for both the AI SDK and Claude CLI routes — including OpenAI's storage
  being off, each route's step, token, tool-call, request and byte bounds, and the advice to enable
  an OpenAI-compatible server's reasoning parser — and `.env.example` lists the new variables

#### Scenario: The allowlist variable carries no value
- **WHEN** `server/.env.example` is read
- **THEN** it names `CLAUDE_CLI_EMAILS` in a comment with no email address, and names
  `AI_CHAT_MAX_STEPS`, `AI_CHAT_MAX_TOKENS`, `GENERATE_MAX_STEPS`, `GENERATE_MAX_OUTPUT_TOKENS` and `GENERATE_MAX_TOKENS`

#### Scenario: The removed ceiling variable is gone
- **WHEN** `server/.env.example` and `docker/secrets-env.yaml` are read
- **THEN** `.env.example` does not name `AI_CHAT_MAX_CONCURRENT` and documents `AI_PROVIDER` with
  `claude_cli` as its default, and `docker/secrets-env.yaml` allows `AI_PROVIDER` and still allows
  the ignored `AI_CHAT_MAX_CONCURRENT`

### Requirement: The AI provider is chosen at boot
The server SHALL read `AI_PROVIDER` at boot (run-status-and-sweeper D1). Unset or blank SHALL mean
`claude_cli`, today the only accepted value. Any other value SHALL refuse to boot with an error that
names the accepted values and echoes the given value, and the refusal SHALL happen before the
`DATA_DIR` lock is taken, so a refused boot holds nothing. The provider SHALL decide whether run
ceilings apply: on `claude_cli` no ceiling applies to AI turns, YouTube imports or transcript
generation, in process or deployment-wide. The per-session single-flight of each run kind, with its
session-busy `409`, SHALL apply on every provider.

#### Scenario: An unset provider means claude_cli
- **WHEN** the server boots with `AI_PROVIDER` unset, or set to whitespace only
- **THEN** it boots with provider `claude_cli` and applies no run ceiling

#### Scenario: An unknown provider refuses to boot
- **WHEN** the server boots with `AI_PROVIDER=openai`
- **THEN** boot fails with an error naming `claude_cli` as the accepted value and echoing
  `openai`, and the `DATA_DIR` lock was never taken

### Requirement: Spend bounds and per-session single-flight
Chat spend SHALL be bounded per autologger session: at most one turn SHALL be in flight per
session, on either route; a second concurrent request for the same session SHALL respond `409`
with an actionable detail and MUST NOT spawn a subprocess or make a model request. On
`AI_PROVIDER=claude_cli`, the default and only accepted value, there SHALL be no process-wide or
deployment-wide ceiling on concurrent turns: turns for different sessions SHALL all be admitted,
and no at-capacity refusal exists (run-status-and-sweeper D1, D2). `AI_CHAT_MAX_CONCURRENT` SHALL
NOT be read; a value left in the environment is ignored. A deployment-wide ceiling, a count of
live run leases, is deferred to a later change (owner, 2026-10-11). Each Claude CLI turn SHALL be
spawned with a per-turn cost ceiling (the CLI budget flag, e.g. `--max-budget-usd`, from a
configured value). Each AI SDK chat turn SHALL be bounded by:

- a step cap (`AI_CHAT_MAX_STEPS`, default 8);
- at most 4000 output tokens per step;
- a per-turn token budget (`AI_CHAT_MAX_TOKENS`, default 400 000 tokens), counting each step's
  total tokens minus the tokens it read from the provider's prompt cache, checked after each step,
  so a turn may overrun it by at most one step;
- at most 2 retries of a failed model request;
- the turn timeout (`AI_CHAT_TIMEOUT_SEC`);
- at most 16 tool calls per step (soft: further calls in the step get a tool error and the turn
  continues) and 32 per turn (hard) ("Session-scoped MCP toolset"); and
- the per-turn request and byte caps of "Model requests on the AI SDK route are guarded".

When a provider reports no token usage for a step, the token budget SHALL count an estimate for
that step instead — the step's request and response body bytes divided by 4 — so the budget
always applies. The turn's ending SHALL be decided from its own step records, not from the
provider's finish reason alone. A chat turn that ends capped (the step count reached the chat step
cap, the token budget fired, or the last step still had tool calls) or incomplete (the last step
finished for output length, content filter, error or another reason) SHALL end with `done`, the
text streamed so far being the answer; a passed per-turn tool-call, request or byte cap SHALL end
it with exactly one upstream-failed `error` event.

The AI SDK route has no dollar cap, and the caller's own provider account pays for it.

#### Scenario: Concurrent turn on the same session is rejected
- **WHEN** a chat turn is streaming for session A and a second `POST …/ai/chat` arrives
  for session A
- **THEN** the second request receives `409`, no additional subprocess is spawned and no model
  request is made

#### Scenario: Turns on other sessions do not refuse a turn
- **WHEN** `AI_PROVIDER` is `claude_cli`, AI turns are in flight for three distinct sessions, and a
  chat turn is requested for a fourth session
- **THEN** the turn is admitted and its subprocess is spawned or its model request made, and no
  at-capacity `409` is returned

#### Scenario: An AI SDK turn stops at its step cap
- **WHEN** an AI SDK chat turn's model keeps calling tools past the chat step cap, whether its
  provider reports the finish reason `tool_calls` or `stop` for those steps
- **THEN** the turn stops at the cap, the stream ends with exactly one `done` event after the text
  streamed so far, and no further request reaches the provider

#### Scenario: An AI SDK turn stops at its token budget
- **WHEN** an AI SDK chat turn's accumulated token usage passes the per-turn token budget
- **THEN** the turn makes no further step after the one that passed the budget, and the stream
  ends with exactly one `done` event after the text streamed so far

#### Scenario: Cache reads do not count toward the token budget
- **WHEN** an AI SDK chat turn's provider reports, for each step, token usage that is mostly read
  from its prompt cache, and the total including cache reads passes the budget but the total
  without them does not
- **THEN** the token budget does not stop the turn

#### Scenario: The token budget applies when the provider reports no usage
- **WHEN** an AI SDK chat turn's OpenAI-compatible provider reports no token usage, and the model
  keeps calling tools until the steps' request and response bytes divided by 4 pass the chat token
  budget
- **THEN** the turn makes no further step after the one that passed the estimated budget, and the
  stream ends with exactly one terminal event

#### Scenario: A failing model request is retried at most twice
- **WHEN** the provider answers every model request of an AI SDK turn with `500`
- **THEN** the turn makes at most 3 requests for that step and ends with the upstream-failed error

### Requirement: Model requests on the AI SDK route are guarded
Every request the server makes to a language model provider on the AI SDK route SHALL go through
the server's outbound guard; no model request SHALL bypass it. The model's provider client SHALL be
given the caller's key, the server-computed destination and the guarded request function
explicitly: the server SHALL NOT fall back to an operator key, base URL or unguarded request
function from the environment when one is absent, and a turn with no usable key SHALL NOT start.
For each request the guard SHALL:

- **check the destination**, after normalizing the URL: a URL containing an encoded slash, a `..`
  segment or a doubled `/` SHALL be refused. For Anthropic, OpenAI and Google the request MUST go
  to the provider's fixed host (the server's constant provider host table) on that provider's
  model-request path, with the credential's model as exactly one path segment where the path names
  the model (Anthropic `/v1/messages`; OpenAI `/v1/responses`; Google
  `/v1beta/models/<model>:streamGenerateContent`, with the query `alt=sse` allowed), so a model id
  containing `/` or `..` cannot retarget the path. For OpenAI-compatible it MUST go to the
  credential's saved origin with the path `<saved base path>/chat/completions`. A request to any
  other destination SHALL be refused without opening a connection, so neither a bug nor a future
  SDK default can send the key elsewhere;
- **apply the address rules per connection**: the destination's DNS answer SHALL be resolved and
  pinned for the connection that is used, and in production mode refused when it is a private,
  loopback, link-local or otherwise blocked address (including IPv4-mapped IPv6 and NAT64 forms of
  a blocked address), with the same rules the credential save applies;
- **follow no redirect**: redirects SHALL NOT be followed, whatever the provider client asks for;
  a `3xx` answer SHALL be returned unfollowed and the turn treats it as a failed request;
- **apply a header timeout of 120 s**: it covers only the wait for the response headers and is
  cleared when they arrive, so a long-context prefill can complete and a slow stream after the
  headers is not cut; the route's turn timeout bounds the whole turn;
- **cap the turn**: at most 60 requests per turn, retries included; at most 4 MB per request body;
  at most 48 MB of request bodies per turn, which bounds the input tokens each step re-sends; and
  at most (the turn's step cap × its per-step output-token cap × 400) response bytes per turn (12.8 MB for chat and 256 MB for generation at the defaults). A request past a cap SHALL be refused without opening a
  connection, a response that passes the response cap SHALL be ended, and in both cases the turn
  SHALL end with the upstream-failed error;
- **stream the response through unbuffered**, counting its bytes per step for the token-budget
  estimate, and pass the turn's abort signal to the connection, so an aborted turn closes the
  upstream connection.

Every OpenAI model request SHALL ask OpenAI not to store the conversation (`store: false`), since
OpenAI stores it by default.

Every Anthropic model request SHALL ask Anthropic to cache the conversation prefix (automatic prompt
caching, a top-level `cache_control` of type `ephemeral`), so each step re-reads the earlier context
from the provider's cache instead of sending it as new input.

The user's API key SHALL appear only in the provider's own authentication header of a request to
the credential's destination (`x-api-key` for Anthropic, `authorization: Bearer` for OpenAI and
OpenAI-compatible, `x-goog-api-key` for Google). Nothing from a model request or response
(headers, body, key) SHALL be logged.

A provider error carries the whole prompt (transcript, history and message) and the provider's
response body. Every model-side error, thrown or reported in the stream — a provider error of any
status, retries exhausted, a refused or failed outbound request, a passed cap, or a provider
stream that drops mid-response — SHALL map to the fixed upstream-failed result and never to any
other string. Only the error's class name MAY be counted in a metric. The server SHALL NOT log,
stringify, store or forward the error object, its message, its request body or its response body;
the SDK's default error logging SHALL be suppressed.

#### Scenario: A request to another host is refused
- **WHEN** a model request on an Anthropic credential's turn targets a URL whose origin is not the
  Anthropic host, or an OpenAI-compatible turn's request targets a path other than
  `<saved base path>/chat/completions`
- **THEN** the guard refuses it without opening a connection, the key is sent nowhere, and the
  turn ends with the upstream-failed error

#### Scenario: A DNS answer that changes to a private address is refused in production mode
- **WHEN** in production mode an OpenAI-compatible credential's host passed the save-time check
  and, at turn time, its DNS answer has changed to a private address
- **THEN** the guard refuses the connection, no request reaches the private address, and the turn
  ends with the upstream-failed error

#### Scenario: A redirect is not followed
- **WHEN** the provider answers a model request with `302` and a `Location` on another host, and
  the provider client set no redirect mode
- **THEN** the `302` is returned unfollowed, no request is made to the `Location`, the key is not
  sent there, and the turn ends with the upstream-failed error

#### Scenario: A model id cannot retarget the request path
- **WHEN** a Google credential's model is `../../v1/other`, or an Anthropic or OpenAI turn's request
  URL carries an encoded slash, a `..` segment or a doubled `/`
- **THEN** the guard refuses the request without opening a connection, and the turn ends with the
  upstream-failed error

#### Scenario: The header timeout bounds only the wait for headers
- **WHEN** a provider sends no response headers for 120 s, and in another turn a provider sends its
  headers at once and then streams slowly for longer than 120 s within the turn timeout
- **THEN** the first request is ended at 120 s and that turn ends with the upstream-failed error,
  and the second stream is not cut by the header timeout

#### Scenario: OpenAI is asked not to store the conversation
- **WHEN** an AI SDK turn on an `openai` credential makes a model request
- **THEN** the request body carries `store: false`

#### Scenario: Anthropic is asked to cache the conversation prefix
- **WHEN** an AI SDK turn on an `anthropic` credential makes a model request
- **THEN** the request body carries a top-level `cache_control` of type `ephemeral`, and requests to
  the other providers carry none

#### Scenario: No operator key or base URL is used in place of the caller's
- **WHEN** the server's environment sets `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GOOGLE_GENERATIVE_AI_API_KEY` or a provider base URL variable, and a turn's credential yields no
  usable key
- **THEN** the turn does not start, no model request is made, and no request ever carries an
  environment key or goes to an environment base URL

#### Scenario: A provider error containing the prompt never appears in any log or event
- **WHEN** the provider answers a model request with an error whose body repeats the account name,
  and the error object carries the turn's whole prompt
- **THEN** the stream ends with exactly one `error` event carrying the fixed upstream-failed
  string, and none of the prompt, the provider's body or the error message appears in any event,
  in captured server stdout or stderr, or in any stored row

#### Scenario: The 61st request in a turn is refused
- **WHEN** an AI SDK turn has already made 60 model requests, retries included, and makes another
- **THEN** the guard refuses it without opening a connection and the turn ends with the
  upstream-failed error

#### Scenario: The byte caps are enforced
- **WHEN** an AI SDK turn makes a request whose body is larger than 4 MB, or one that would take
  the turn's request bodies past 48 MB, or the turn's responses pass the turn's response-byte cap
- **THEN** the guard refuses the request (or ends the response) with no further connection, and
  the turn ends with the upstream-failed error
