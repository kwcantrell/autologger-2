# Spec Delta

## MODIFIED Requirements

### Requirement: Session-scoped MCP toolset
Each chat turn SHALL be given session-scoped tools, all hard-bound to the `:sessionId` of the
originating request via the turn registration (the model cannot address any other session — no
tool parameter names a session; the wiki tools below are bound to that session's show and read
only what the caller may read there, and the one other-session read is that a wiki proposal's
citations may cause a read of the words of a show session its target's pending suggestion cites,
answered only as pass or fail). On the Claude CLI route the spawned CLI SHALL be given a
generated MCP configuration exposing those tools. On the AI SDK route the server SHALL give the
model the same tools in process, wrapping the **same tool bodies, input schemas and validation**
the MCP server uses, so a tool call has the same effect and result on either route. The registry
comprises seven tools; **each turn registration SHALL carry the turn's tool set, and the per-request
MCP server, or the AI SDK turn, SHALL offer only that turn's tools — a chat turn's set is exactly
the three tools below** (the CLI `--allowedTools` allowlist remains as belt-and-braces).
`create_event` (defined by `auto-event-generation`) is offered only for event-generation turns, and
`list_wiki_pages`, `read_wiki_page` and `propose_page` (defined by `wiki-generation`
"The wiki turn and its tools") only for wiki turns; a chat turn never exposes any of them. The wiki
tools read the catalog through a catalog bound to the turn's caller, never a system binding, and
`propose_page` writes nothing: it records a proposal in the turn's memory, which the wiki route
stores only on success:

- `get_transcript_words` — returns the session's transcript rendered as **compact,
  model-readable text**, not JSON rows: consecutive words are grouped into per-speaker
  segments, each line prefixed with the segment's session-time anchor and speaker when
  present (e.g. `[HH:MM:SS] speaker S1: …`); a session with no transcript renders as a
  short placeholder line. The rendering carries the word text, speaker, and session-time
  anchor and omits the other hub row fields (`start_sec`, `created_at_utc`, `ordinal`,
  `session_id`, …), which the model does not need and whose per-word repetition made the
  JSON form a single oversized payload that overflowed the CLI's tool-output limit and
  hid the transcript from the model. The output SHALL be a bounded, non-JSON rendering.
  On a generation-density turn (event generation, the topic-generation one-shot and the wiki turn) the
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
- **per turn, a hard cap** of 32 calls (chat) or 300 (topic, event and wiki generation): a call past it
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

#### Scenario: Chat turns cannot use the wiki tools
- **WHEN** a chat turn runs
- **THEN** `list_wiki_pages`, `read_wiki_page` and `propose_page` are not offered to
  the model on either route, and a call to one of them runs nothing

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
  the originating session (and, on a wiki turn, that session's show wiki and its pending
  suggestions, and the transcript words of the show's sessions that a target's pending suggestion
  cites, all read as the caller) through the validated tool bodies;
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
