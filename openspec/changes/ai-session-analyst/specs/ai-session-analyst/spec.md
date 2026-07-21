# ai-session-analyst — Delta Spec

## ADDED Requirements

### Requirement: Configuration-gated analyst endpoint
The Session Analyst SHALL be gated on configuration naming the `claude` executable the Agent
SDK drives (`CLAUDE_CLI_PATH`, absolute path or a name resolvable on `PATH`) together with an
analyst enable flag. When the executable path is unset, blank, or whitespace-only, or the
analyst is not enabled, `POST /api/sessions/:sessionId/ai/analyst` SHALL respond `503` with an
actionable JSON `{ detail }`, and unconfigured deployments SHALL be otherwise unchanged. When
configured, the endpoint SHALL run the analyst turn. This route is new frozen API surface
authorized by this delta; no existing route, shape, status code, or WS emission changes.

#### Scenario: Unconfigured deployment returns 503
- **WHEN** the analyst is not configured and a client calls `POST /api/sessions/:id/ai/analyst`
- **THEN** the response is `503 { detail }` stating the analyst is not configured, and no
  subprocess is spawned

#### Scenario: Analyst disabled independently of the topics chat
- **WHEN** `CLAUDE_CLI_PATH` is set but the analyst enable flag is off
- **THEN** `POST …/ai/analyst` responds `503` and `POST …/ai/chat` continues to serve normally

#### Scenario: Configured deployment serves the analyst turn
- **WHEN** the analyst is configured and a client posts a valid message
- **THEN** the response is `200` with an SSE stream of the reply

### Requirement: Open-network refusal
Because an analyst turn spends the operator's Anthropic credentials, the endpoint SHALL refuse
to serve turns when authentication is disabled on a reachable network: when `REQUIRE_LOGIN` is
disabled AND the server is bound to a non-loopback address with no IP allowlist,
`POST …/ai/analyst` SHALL respond `503` with an actionable detail, independent of the general
auth gate. Loopback-bound anonymous dev is unaffected.

#### Scenario: Anonymous LAN deployment refuses the analyst
- **WHEN** `REQUIRE_LOGIN` is disabled and the bind is non-loopback with no allowlist
- **THEN** `POST …/ai/analyst` responds `503` and no subprocess is spawned

#### Scenario: Loopback anonymous dev still serves
- **WHEN** `REQUIRE_LOGIN` is disabled and the server is loopback-bound
- **THEN** the analyst endpoint serves turns normally

### Requirement: Analyst request contract
`POST /api/sessions/:sessionId/ai/analyst` SHALL accept a JSON body
`{ message: string, analyst_session_id?: string }` where `message` is 1–8000 characters after
trimming and `analyst_session_id`, when present, is a non-empty string. The endpoint SHALL
evaluate checks in this order, matching the `ai/chat` sibling: authentication → session
resolution/scoping (`404` for nonexistent, deleted, or out-of-studio sessions) → configuration
gate and open-network refusal (`503`) → body validation (`422` for schema violations via the
global `ZodError` mapping, `400` for malformed JSON) → turn slot (`409`). No guard path SHALL
spawn a subprocess. All error bodies SHALL be the repo's `{ detail }` shape.

#### Scenario: Invalid body rejected without side effects
- **WHEN** a client posts an empty/whitespace `message` or a body missing `message`
- **THEN** the response is `422 { detail }` and no subprocess is spawned

#### Scenario: Unauthorized session is masked as 404 before the config gate
- **WHEN** a caller without studio access to `:sessionId` posts a message, whether or not the
  feature is configured or a turn is in flight
- **THEN** the response is `404` (never `503`/`409`), leaking neither configuration nor
  in-flight state

#### Scenario: Unauthenticated request rejected like sibling routes
- **WHEN** a request lacks the credentials required by existing session sub-routes under the
  active auth configuration
- **THEN** the analyst endpoint rejects it with the same status and shape those routes use

### Requirement: Read-only tool surface
The analyst SHALL expose exactly three session-scoped tools — `get_transcript_words`,
`list_topics`, and `list_events` — all read-only. No tool that mutates session state SHALL be
reachable from the analyst; in particular `create_topic` SHALL NOT be registered, allowlisted,
or invocable. Read-only status SHALL rest on **tool registration** — only read tools are
constructed, so no mutating handler exists to reach — reinforced by the built-in denial required
under *Subprocess security lockdown*, an explicit allowlist, and a runtime permission gate whose
denials are observable. These are not independent equivalents: registration is the guarantee, and
it SHALL NOT be removed on the grounds that the others exist.

The autologger session a turn operates on SHALL be bound by the turn's own scope and SHALL NOT be
accepted as a tool parameter. The MCP server instance SHALL be constructed **per turn**, so the
captured session binding cannot outlive or cross turns.

Tool results SHALL be bounded: `get_transcript_words` SHALL accept a range or slice, `list_events`
SHALL accept paging, each SHALL apply a documented cap, and a truncated result SHALL state its
truncation in the tool output so the model can report partial coverage rather than summarizing a
silently truncated transcript. `list_events` SHALL return the operator-visible category label, not
the internal category identifier.

The analyst SHALL ground claims in tool output and SHALL state when data is unavailable rather
than inferring it. In particular, no relation between topics and events is modelled in the
schema; the analyst SHALL NOT assert topic/event containment as fact.

#### Scenario: A mutating tool is denied at runtime
- **WHEN** the model attempts to invoke a tool name not on the analyst allowlist
- **THEN** the permission gate denies it with a message, the denial is observable in the turn
  result, and no session state is modified

#### Scenario: Events carry operator-visible labels
- **WHEN** the analyst lists events
- **THEN** each event carries the category label the operator sees, not the internal identifier

#### Scenario: An oversized transcript read is truncated and says so
- **WHEN** a transcript read would exceed the documented cap
- **THEN** the result is truncated and the truncation is stated in the tool output

#### Scenario: Concurrent turns on different sessions do not cross
- **WHEN** two analyst turns run concurrently for different sessions
- **THEN** each turn's tools resolve only its own session's data

#### Scenario: The analyst cannot address another session
- **WHEN** an analyst turn is registered for `:sessionId`
- **THEN** every tool call resolves against that session only, and no tool accepts a session
  identifier as an argument

#### Scenario: A completed analyst turn leaves session state unchanged
- **WHEN** an analyst turn runs to completion against a session with existing events and topics
- **THEN** the session's events, topics, and transcript rows are byte-identical to before the turn

### Requirement: Subprocess security lockdown
The analyst turn SHALL disable **all built-in tools** outright — the positive denial, distinct
from and not satisfied by an auto-approve allowlist — so that no filesystem, shell, or network
built-in is reachable. It SHALL additionally run with: the user/project/local filesystem settings
tiers disabled, so operator hooks and user-level `CLAUDE.md` are not loaded; **only** the MCP
servers this change passes programmatically, ignoring project `.mcp.json`, user settings, and
plugins; a permission mode that **denies rather than prompts** when a tool is not pre-approved;
an explicit system prompt held as a pinned constant; a working directory **outside the repository
checkout and outside `DATA_DIR`**; and a minimal environment carrying only the variables the child
needs (credentials via `HOME`, `PATH`, a bound on MCP tool-call duration, and proxy/TLS variables
where the deployment has them), noting the environment **replaces** rather than merges with the
parent's. The user message SHALL be delivered as the SDK prompt and never as a command-line
argument. Session forking SHALL be disabled explicitly rather than left to a default.

A **closed-world** characterization test SHALL pin the resolved option set: it SHALL assert the
enumerated keys and their values, and SHALL assert that options capable of widening the child —
programmatic hooks, plugins, agent definitions, extra CLI arguments, additional directories, and
any permission-bypass switch — are **absent**. Pinning values alone detects a change; only a
closed-world assertion detects an addition.

#### Scenario: Built-in tools are not reachable
- **WHEN** the model attempts to invoke a built-in shell or filesystem tool during an analyst turn
- **THEN** the tool is not available and no command executes

#### Scenario: Operator shell hooks do not run in the analyst child
- **WHEN** the operator's user settings define a lifecycle shell hook and an analyst turn runs
- **THEN** the hook does not execute, and a control run with that settings tier enabled
  demonstrates the same hook does fire — so the negative result is not a false pass

#### Scenario: Operator MCP servers are not loaded
- **WHEN** the repository or the operator's user settings declare an MCP server and an analyst
  turn runs
- **THEN** only this change's analyst tools are available to the model

#### Scenario: The working directory is not the repository checkout
- **WHEN** an analyst turn runs
- **THEN** its working directory is outside the repository checkout and outside `DATA_DIR`

#### Scenario: A message cannot smuggle a flag
- **WHEN** a user message begins with `--` or otherwise resembles a command-line flag
- **THEN** it is treated as message content and never parsed as an option

### Requirement: Subprocess and turn lifecycle
Every analyst turn SHALL terminate its child process on every path — normal completion, failure,
turn timeout, and client disconnect — leaving no surviving process, because an orphan continues
to spend the operator's credentials and this deployment does not support restart. The turn
timeout SHALL be **independent of the agent iterator**, so a turn that never yields still ends,
releases its slot, and terminates its child. MCP tool calls SHALL be bounded by an explicit
duration limit rather than left effectively unbounded.

#### Scenario: No orphaned process survives an abort
- **WHEN** an in-flight analyst turn is aborted and its child does not exit on the first signal
- **THEN** no `claude` process from that turn survives, and its concurrency slot is released

#### Scenario: A turn that never yields still ends
- **WHEN** an analyst turn's agent iterator produces no messages and does not terminate
- **THEN** the turn timeout fires regardless, the child is terminated, and the slot is released

#### Scenario: A hung tool call does not hang the turn
- **WHEN** an analyst tool call blocks beyond the configured tool-call bound
- **THEN** the call is abandoned and the turn ends rather than blocking indefinitely

### Requirement: Spend and concurrency bounds
The analyst SHALL acquire a turn slot from the same registry the AI chat uses, before any
subprocess is spawned, so that per-session single-flight and the process-wide concurrency
ceiling bound both agents together rather than doubling the operator's exposure. When a slot
cannot be acquired the endpoint SHALL respond `409` with an actionable `{ detail }` and spawn
nothing. When the holder is the *other* agent, the detail SHALL say so, so an operator is not
told an "AI chat turn" is busy while looking at the analyst panel. The slot SHALL be released when
the turn ends, by any path, including paths where the agent iterator never terminates.

Each turn SHALL additionally carry a **per-turn spend ceiling in USD** enforced by the agent
itself, and a bound on agent turns. The concurrency registry bounds *how many* turns run; it does
not bound what one turn can spend, and a turn driven by injected transcript content into a tool
loop is bounded by neither slots nor turn count alone.

#### Scenario: A second turn on a busy session is rejected
- **WHEN** a turn is already in flight for `:sessionId` — whether an analyst turn or an AI chat
  turn — and a client posts an analyst message for that session
- **THEN** the response is `409 { detail }` and no subprocess is spawned

#### Scenario: The process-wide ceiling is shared, not doubled
- **WHEN** turns in flight across both agents have reached the configured concurrency ceiling
- **THEN** a further analyst turn is rejected `409` rather than admitted against a separate quota

### Requirement: Analyst SSE reply stream
On acceptance the endpoint SHALL respond `200` with `Content-Type: text/event-stream`, reusing
the AI chat event vocabulary: `delta` (`{ text }`, assistant text fragments in order), `tool`
(`{ name }`, the short tool name), `done` (terminal success, carrying the session id the client
echoes back for continuity), and `error` (`{ detail }`, terminal failure). The vocabulary is
**additive-open**: new event types and fields MAY be introduced without a further delta, and
clients SHALL ignore unrecognized ones. The server SHALL relay assistant text only and SHALL
NOT relay model reasoning or thinking content — suppressed at the agent-option layer as well as
filtered at the relay, since untrusted transcript content in context makes reasoning blocks a
likely carrier of injected or restated sensitive material, and a relay-only filter is one new
content-block type away from leaking. A completed stream SHALL carry **exactly one** terminal
event; a stream ended by client abort SHALL NOT carry a terminal event, so a client can be
written against the guarantee rather than a permission.

Terminal `error` details SHALL be scrubbed: the endpoint SHALL emit a stable, non-revealing
`{ detail }` and SHALL NOT forward raw exception text, subprocess stderr, or agent error arrays,
which can carry host paths, environment fragments, and credential-path errors.

#### Scenario: Exactly one terminal event per completed stream
- **WHEN** a turn completes normally, fails, or hits the turn timeout
- **THEN** the stream carries exactly one terminal `done` or `error` event, never both and never
  two of either

#### Scenario: Client abort emits no terminal event
- **WHEN** the client aborts an in-flight turn
- **THEN** the server terminates the turn and the client does not wait for a terminal event

#### Scenario: Reasoning content is not relayed
- **WHEN** the model produces reasoning/thinking content during a turn
- **THEN** no `delta` event carries that content

### Requirement: Multi-turn continuity bound to the autologger session
An `analyst_session_id` SHALL be accepted for follow-up turns only when it was issued by a
previous analyst turn on the **same** autologger `:sessionId` **and to the same acting
principal** — session access alone SHALL NOT authorize resuming another user's conversation, whose
prompts and answers it would disclose. An identifier that is unknown, stale, issued for a
different session, or issued to a different principal SHALL be rejected `422` with an actionable
`{ detail }` **before** any subprocess is spawned.

Analyst identifiers SHALL be held in a namespace **separate** from the AI chat's, so an
identifier issued by the write-capable agent can never resume as an analyst conversation or the
reverse. Session forking SHALL be disabled, so a resumed conversation keeps its identifier rather
than silently minting one the guard has never seen.

#### Scenario: Foreign session id is rejected, not resumed
- **WHEN** a client posts an `analyst_session_id` issued for a different autologger session
- **THEN** the response is `422 { detail }` and no subprocess is spawned

#### Scenario: Own session id resumes the conversation
- **WHEN** a client posts an `analyst_session_id` issued by a previous turn on the same session
- **THEN** the turn resumes that conversation rather than starting a new one

### Requirement: Analyst subtab in the session workspace
The AI panel SHALL present an `Analyst` subtab alongside the existing `Chat`, `Transcribe`, and
`Topics` subtabs. All subtab panels SHALL remain mounted and be hidden rather than unmounted
when inactive, and the analyst's conversation, streaming, and abort state SHALL be held above
the panel component, so switching subtabs neither aborts an in-flight turn nor clears the
conversation.

#### Scenario: Switching subtabs preserves an in-flight analyst turn
- **WHEN** an analyst turn is streaming and the user switches to another subtab and back
- **THEN** the turn is still streaming and the conversation is intact
