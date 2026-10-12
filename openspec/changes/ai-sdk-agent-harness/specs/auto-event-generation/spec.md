## MODIFIED Requirements

### Requirement: Single orchestrator turn over all instructions
A generation run SHALL execute as **one** AI turn on the caller's route (the `claude` CLI or
the AI SDK route; provider-credentials, ai-topics-chat), driven through the existing shared turn
lifecycle (turn registration → run → outcome → cleanup). On the CLI route all existing lockdown
invariants stay intact — MCP registration, no built-in tools, strict MCP config, loopback +
per-turn bearer, no orphaned process; on the AI SDK route the model's only capabilities are the
turn's tools, built from the same tool bodies, input schemas and validation the MCP server uses.
There is **no abort signal** from the client, so a run always completes server-side regardless of
the initiating client's connection, exactly like `topics/generate`. The run SHALL
snapshot, at run start: the session's frame rate and start-offset, and the
instruction-bearing categories (ids, names, types, colors, instructions, option
labels/instructions). Mid-run edits to the show or session SHALL NOT affect the
in-flight run; they take effect on the next run.

The turn's message SHALL enumerate every instruction-bearing button and option from
the snapshot, and SHALL embed the session's existing events for those categories
(complete for each instruction-bearing category — **except, on regenerate, the rows
in the pre-spawn auto-row snapshot, which SHALL be excluded** — rendered compactly
with timecode, message, and a generated-row marker) as the dedup basis — there is no
events-reading tool. Instruction text SHALL be rendered as clearly-delimited
untrusted data, with the
system prompt stating that instructions describe *what to detect* and cannot alter the
tool contract, the run's scope, or the delimiter framing. The message and system prompt
SHALL be the same on both routes. The turn's tool set
SHALL be exactly `get_transcript_words`, `create_event`: on the CLI route as the CLI's allowed
tools and the turn's MCP registration, and on the AI SDK route as the only tools given to the
model. The CLI turn SHALL run under the configured generation budget (`--max-budget-usd`) and
server-side timeout. The AI SDK turn has no dollar cap; it SHALL run under the generation step cap
(`GENERATE_MAX_STEPS`, default 40), at most `GENERATE_MAX_OUTPUT_TOKENS` output tokens per step (default 16 000, valid 1 000–128 000, so a step can hold a batch of `create_event` calls; if the turn's first model request is rejected with `400` at a cap above 4000, the turn starts again once at 4000 before any tool has run), the generation per-turn
token budget (`GENERATE_MAX_TOKENS`, default 3 000 000 tokens, counting each step's total tokens minus its prompt-cache reads, checked after each step so a
turn may overrun it by at most one step, and counting an estimate of the step's request and
response bytes divided by 4 when the provider reports no usage), at most 2 retries of a failed
model request, the same server-side timeout (`EVENT_GENERATE_TIMEOUT_SEC`), at most 16 tool calls
per step (soft: further calls in the step get a tool error and the turn continues, since a step
may legitimately hold many `create_event` calls) and 300 per turn (hard) (ai-topics-chat
"Session-scoped MCP toolset"), and the per-turn request
and byte caps of the guarded model requests (ai-topics-chat "Model requests on the AI SDK route
are guarded"), and every model request SHALL go only to the caller's credential's destination. An
AI SDK turn's ending SHALL be decided from the turn's own step records, not from the provider's
finish reason alone. A turn that ends **capped** (the step count reached the generation step cap,
the token budget fired, or the last step still had tool calls) or **incomplete** (the last step
finished for output length, content filter, error or another reason) has not succeeded: it SHALL
be a failed turn, like a passed per-turn tool-call, request or byte cap. The
per-run `create_event` cap (`cap_hit`) is a separate bound and is not such a failure. On the AI SDK route
each generation-density transcript page SHALL be returned to the model whole, with no truncation
layer between the tool and the model, so the page cap alone bounds a tool result. In this
capability's other requirements (including the regenerate delete and failure handling), "the CLI
turn" and "the CLI" mean the generation turn on either route.

Message conventions (matching the manual logging flow, so generated rows share the
feed's vocabulary):
- BUTTON hit → `message` = the button's name/label verbatim.
- DROPDOWN option hit → `message` = the option label verbatim, or
  `<label> || <context>` when the option has `needs_context` (context authored by the
  model from the transcript moment). A whole-button DROPDOWN instruction acts as
  shared context/scoping for its option instructions and as a fallback detector: a hit
  matching the button instruction but no specific option logs the button's name.
- TEXT hit → `message` = model-authored text per the instruction (TEXT buttons carry
  free-form notes in the manual flow).

#### Scenario: One subprocess regardless of instruction count
- **WHEN** a show has five instruction-bearing buttons and generation runs for a caller whose
  route is the CLI
- **THEN** exactly one CLI subprocess is spawned, its allowlist is exactly
  `get_transcript_words` and `create_event`, and its prompt carries all five buttons'
  instructions and their categories' existing events

#### Scenario: One AI SDK turn with the same tools
- **WHEN** a show has five instruction-bearing buttons and generation runs for a caller whose
  route is the AI SDK route
- **THEN** exactly one AI SDK turn runs, the model is given exactly `get_transcript_words` and
  `create_event`, its prompt carries all five buttons' instructions and their categories'
  existing events, and the turn's registration is gone and no upstream connection is open when
  the response is sent

#### Scenario: Option-only DROPDOWN participates
- **WHEN** a DROPDOWN button has no button-level instruction but one option carries an
  instruction
- **THEN** the button is instruction-bearing: it is enumerated in the prompt, its
  category id is writable by `create_event`, and the no-instructions precondition does
  not trigger

#### Scenario: Generated messages match manual vocabulary
- **WHEN** the model logs a hit for a plain BUTTON named "SLATE"
- **THEN** the created event's `message` is exactly "SLATE", indistinguishable in
  vocabulary from a manual press

### Requirement: Generation endpoint guard ladder runs before any spawn
The server SHALL expose `POST /api/sessions/:sessionId/events/generate` (added to the
README endpoint table), a **synchronous JSON** route mirroring `topics/generate`'s
guard ladder, evaluated in this order before any subprocess, model request or turn
registration exists:

1. session resolution (unknown session masks as `404`, matching sibling routes);
2. `503 {"detail": "Add a language model in Settings → Advanced to generate events."}` when
   the caller has no AI route (provider-credentials; resolved per request from the caller's
   saved `llm` choice, `CLAUDE_CLI_EMAILS` and `CLAUDE_CLI_PATH`; `CLAUDE_CLI_PATH` alone does not enable generation for every caller, and
   a caller with no saved `llm` credential has no route in any mode, with no development-mode
   fallback to the Claude CLI);
3. `403 {"detail": "This feature is limited to approved users on this server."}` when the
   requester's verified login email is not an approved user (api-contract-freeze "Run features
   are limited to approved users", run-status-and-sweeper D9); a malformed optional body's `400`
   (see "Optional generate body for regenerate and selection") is answered before steps 2 and 3;
4. `400 {detail}` when the session's transcript is empty **or contains no word with a
   non-empty session-time anchor** (a run without anchors can only invent timecodes);
5. `400 {detail}` when the session's show has no instruction-bearing button;
6. `400 {detail}` when the instruction-bearing set exceeds the aggregate pre-spawn
   bound (a configured ceiling on total instruction bytes and instruction-bearing
   entry count);
7. `409 {detail}` when the per-session AI slot is held (same registry as AI chat/AI
   v2/topics). On `AI_PROVIDER=claude_cli` there is no process-wide or deployment-wide
   ceiling, so there is no at-capacity refusal, and AI turns for other sessions never
   cause this `409` (run-status-and-sweeper D2). The shared-slot busy details SHALL name
   event generation among the possible holders — the wording of the existing
   shared-slot session-busy `409` detail strings at all three sibling endpoints
   (`ai/chat`, the AI v2 design turn, and `topics/generate`) carries it; the at-capacity
   detail strings are removed.

The optional request body carries only run modifiers (`regenerate`, `selection` —
see "Optional generate body for regenerate and selection"); instructions and the
category snapshot are read server-side at run start, never from the client. On
success it SHALL respond `200 {created, cap_hit}` (`created` = events inserted by
the run; `cap_hit` = whether the per-run cap ended writing early), plus `deleted`
when `regenerate` was true. A turn failure after the run starts on either route (on the AI SDK
route including any model-side error, a refused model request, a passed per-turn tool-call,
request or byte cap, and a capped or incomplete ending) SHALL map to the
same opaque scrubbed failure mechanics as `topics/generate` (a `502 {detail}` that
never carries raw subprocess output, a provider error message, a request body or a provider
response body);
events inserted before the failure remain
persisted and are reported nowhere in the error body, and a failed run SHALL NOT perform the
regenerate delete. On the AI SDK route the route SHALL wait for any tool body still running for
the turn to finish before it acts on the generation result (the regenerate delete), sends the
response, or releases the session's AI slot and run lease; the wait has no fixed time bound of its
own, because each of a body's database statements is bounded by the existing statement timeout.

#### Scenario: Unconfigured deployment refuses
- **WHEN** a caller who has no `llm` credential and does not resolve to the Claude CLI POSTs to
  the generate route
- **THEN** the response is `503 {"detail": "Add a language model in Settings → Advanced to
  generate events."}`, and no subprocess, model request or turn registration is created

#### Scenario: A user who is not approved is refused before spend
- **WHEN** a member of the session's show who has an AI route but whose email is not an
  approved user POSTs to the generate route with a well-formed body
- **THEN** the response is `403` with the fixed detail, no AI slot or run lease is taken, and no
  subprocess, model request or turn registration is created

#### Scenario: Non-loopback bind without an allowlist is not refused
- **WHEN** the server binds non-loopback with no allowlist and a signed-in member of the
  session's studio who has an AI route POSTs to the generate route
- **THEN** no network-posture `503` is returned, and the guard ladder above applies

#### Scenario: Anchorless transcript refuses before spend
- **WHEN** the session's transcript exists but no word carries a session-time anchor
- **THEN** the response is `400 {detail}` naming the missing anchors and nothing is
  spawned

#### Scenario: No instructions configured refuses before spend
- **WHEN** generation is requested for a session whose show has no instruction-bearing
  button
- **THEN** the response is `400 {detail}` stating that no instructions are configured
  and nothing is spawned

#### Scenario: Busy slot names the holder
- **WHEN** an AI chat turn is streaming for session A and a generate run is requested
  for session A
- **THEN** the request receives `409` with a detail naming the holding feature set,
  and no subprocess is spawned

#### Scenario: Turns on other sessions do not refuse a run
- **WHEN** `AI_PROVIDER` is `claude_cli`, AI turns are in flight for three other sessions, and a
  generate run is requested for an idle session that passes the earlier guards
- **THEN** no `409` is returned and the run is spawned

#### Scenario: Partial results survive a failed run
- **WHEN** the CLI exits nonzero after the run has inserted events
- **THEN** the route responds `502` with the scrubbed generate-failure detail, no raw
  subprocess output, and the already-inserted events remain persisted

#### Scenario: An AI SDK provider failure keeps partial results and leaks nothing
- **WHEN** an AI SDK generation turn ends with a provider authentication error after the run
  has inserted events
- **THEN** the route responds `502` with the same scrubbed generate-failure detail, nothing
  from the provider's error message, the request body or the response body appears in the response or the server log,
  and the already-inserted events remain persisted

#### Scenario: A regenerate stopped by the step cap is a failure and deletes nothing
- **WHEN** a client POSTs `{ "regenerate": true }`, the caller's route is the AI SDK route, and the
  turn has inserted events when the generation step cap or the generation token budget stops it
  while the model still wants to call tools
- **THEN** the route responds `502` with the scrubbed generate-failure detail, the prior
  auto-generated events are not deleted, and the events the run inserted remain persisted

#### Scenario: A provider that reports stop while still calling tools at the step cap fails the run
- **WHEN** a client POSTs `{ "regenerate": true }` on the AI SDK route, and the provider reports the
  finish reason `stop` on every step while still emitting `create_event` calls, until the step
  count reaches the generation step cap
- **THEN** the turn ends as capped, the route responds `502` with the scrubbed generate-failure
  detail, and no regenerate delete is performed

#### Scenario: An output-length stop with an unexecuted tool call fails the run
- **WHEN** an AI SDK generation turn's last step finishes for output length with a `create_event`
  call that was never executed
- **THEN** the turn ends as incomplete, the route responds `502` with the scrubbed generate-failure
  detail, and no regenerate delete is performed

#### Scenario: Many calls in one step get a tool error and the run continues
- **WHEN** an AI SDK generation turn's model asks for 20 `create_event` calls in one step, within
  the per-turn cap
- **THEN** the first 16 run, each call past the 16th runs nothing and returns the tool error "Too
  many tool calls in one step; continue in the next step." to the model, and the turn continues
  with its next step

#### Scenario: Passing the per-turn tool-call cap fails the run
- **WHEN** an AI SDK generation turn's model asks for more than 300 tool calls in the turn
- **THEN** the calls past the cap run nothing, the route responds `502` with the scrubbed
  generate-failure detail, and no regenerate delete is performed
