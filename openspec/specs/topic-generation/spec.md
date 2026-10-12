# topic-generation Specification

## Purpose
Defines `topics/generate`: a one-shot, non-streaming endpoint, gated on the caller's own AI route, that runs the same AI turn machinery as the AI chat (the AI SDK route on the caller's language model, or the Claude CLI for allowlisted accounts) to derive a session's topics from its transcript. The replace-all is crash-safe (prior topics are untouched until the new set exists), with single-flight, spend and time bounds, a transcript precondition, paged snapshot-stable transcript delivery, and a defined failure mapping.

## Requirements

### Requirement: Single-flight and concurrency bounds

Topic generation SHALL acquire a turn slot from the shared AI-turn registry
(`aiChatTurns`) — per-session single-flight, with no process-wide or deployment-wide ceiling on
`AI_PROVIDER=claude_cli` (run-status-and-sweeper D2) — the same bound the AI chat uses, since a
generation run is an AI turn on either route (the `claude` CLI or the AI SDK route) that spends
the operator's budget or the caller's provider account. A request that cannot acquire a slot
SHALL respond `409 {detail}`, spawn nothing and make no model request.

#### Scenario: Concurrent generation is rejected

- **WHEN** a `topics/generate` request arrives while another AI turn (chat, AI v2 design, event
  generation or topic generation) holds the session's slot, in this or another process
- **THEN** the response is `409 {detail}`, no subprocess is spawned and no model request is made;
  AI turns running for other
  sessions never cause this refusal

#### Scenario: The slot bounds both routes alike

- **WHEN** a caller whose route is the AI SDK route requests generation while another caller's
  CLI chat turn holds the same session's slot
- **THEN** the response is `409 {detail}`, no `claude` subprocess is spawned and no model request
  is made for the request

### Requirement: Transcript precondition

Topics are generated from the session transcript. If the session has no transcript words,
`topics/generate` SHALL respond `400 {detail}` (nothing to generate from) rather than
spawning a CLI turn that would produce nothing.

#### Scenario: No transcript maps to 400

- **WHEN** a configured deployment receives `topics/generate` for a session with zero
  transcript words
- **THEN** the response is `400 {detail}` and no subprocess is spawned

### Requirement: Replace-all generation is crash-safe (the prior topics are never touched until success)

A successful generation SHALL replace the session's topics wholesale with the freshly
generated set; a failed or interrupted generation SHALL leave the prior topics **exactly as
they were, byte-for-byte** (same ids, ordinals, timestamps). To guarantee this even across a
mid-run process death, the server SHALL NOT clear or modify the existing topics before the
run: it SHALL record the ids of the pre-run topics, run the CLI turn so it creates a **fresh**
set (the `list_topics` tool is withheld from this one-shot so the model cannot dedup against
the soon-to-be-replaced topics), and only **on success** delete the pre-run ids in one
transaction, leaving the freshly created set. On failure it SHALL instead delete the topics
this run created (the pre-run set survives untouched). Because the pre-run topics are never
mutated until the atomic delete-on-success, a crash at any point leaves them intact.

#### Scenario: Success replaces topics with the fresh set

- **WHEN** a generation succeeds for a session that already had topics
- **THEN** the session's topics are exactly the newly generated set (the prior topics,
  including manually-added ones, are gone), returned as `200 {topics}`

#### Scenario: Failure leaves the prior topics byte-for-byte intact

- **WHEN** the CLI turn fails (spawn error, timeout, CLI error) or creates no topics
- **THEN** the topics this run created are removed and the session's prior topics are exactly
  what they were before the request — same ids, ordinals, and timestamps (they were never
  modified)

#### Scenario: A crash mid-run does not destroy prior topics

- **WHEN** the process dies during the CLI run (before the delete-on-success)
- **THEN** the prior topics are still present and unmodified (only the atomic
  delete-on-success removes them, and it never ran)

### Requirement: One-shot, non-streaming, synchronous response

The generation SHALL run the CLI turn to completion server-side and respond synchronously —
there is no SSE/streaming surface on `topics/generate` (that is the AI chat's `ai/chat`
endpoint). A successful run SHALL respond `200 {topics}` with the session's topic list in the
same shape `GET …/topics` returns. The run SHALL be bounded by the same subprocess
timeout + process-group kill the AI chat turn uses.

#### Scenario: Success returns the topics list shape

- **WHEN** a generation completes successfully
- **THEN** the response is `200` with `{topics: [...]}` whose entries match the shape of
  `GET /api/sessions/:id/topics` entries

#### Scenario: No streaming surface is introduced

- **WHEN** a client generates topics
- **THEN** the outcome is delivered by the single synchronous request/response, with no SSE
  or streaming endpoint added to `topics/generate`

### Requirement: Generation reuses the AI-chat CLI + MCP machinery

The generation SHALL run on the caller's AI route (provider-credentials), through the existing
autologger tool bodies, via a **shared turn-orchestration helper** that the `ai/chat` endpoint
also uses (start → run-to-outcome → the full cleanup: on the CLI route process-group kill, MCP-turn
dispose and temp-config cleanup; on either route turn-registration disposal and turn-slot
release) — so the correctness-critical cleanup lives in one place, not two:

- on the **CLI** route it SHALL drive the operator's `claude` CLI through the existing autologger
  MCP server and the existing spawn/env lockdown, exactly as before this change;
- on the **AI SDK** route it SHALL call the caller's model provider in process on the caller's
  `llm` credential (ai-topics-chat), giving the model exactly the turn's tools, built from the
  same tool bodies, input schemas and validation the MCP server uses, and nothing else.

The one-shot turn, on either route: exposes only `get_transcript_words` + `create_topic`
(**withholds `list_topics`** so it generates a fresh set, per the crash-safe swap); passes the
same fixed one-shot **user message** and the same generate system prompt (the reused CLI
`--append-system-prompt` lockdown is unchanged); and **does not wire a client abort signal** (a
synchronous POST runs to completion so success-replace vs failure-restore is deterministic; the
timeout still ends the turn). Its transcript delivery is governed by "One-shot transcript
delivery is paged, complete, and snapshot-stable", identically on both routes. Elsewhere in this
capability, "the CLI turn" means this generation turn on whichever route the caller's route
selects.
It SHALL NOT introduce an AI provider, a model path, or a credential beyond the caller's route; on
the AI SDK route every model request goes only to the caller's credential's destination through
the guarded model requests (ai-topics-chat "Model requests on the AI SDK route are guarded").
Extracting the shared helper SHALL NOT change the observable behavior of
`POST /api/sessions/:id/ai/chat`.

#### Scenario: Reuses the gated CLI + MCP tools via the shared helper

- **WHEN** a generation runs for a caller whose route is the CLI, and the request passes every
  guard
- **THEN** it spawns the same lockdown-hardened `claude` CLI against the autologger MCP
  server the AI chat uses (with `list_topics` withheld), topics are created via `create_topic`,
  and the spawn/cleanup goes through the same helper `ai/chat` uses

#### Scenario: An AI SDK caller runs the same one-shot on their own model

- **WHEN** a generation runs for a caller whose route is the AI SDK route, and the request passes
  every guard
- **THEN** the model is given the same paged `get_transcript_words` and `create_topic` tools
  (`list_topics` withheld) with the same system prompt and user message, topics are created via
  `create_topic` through the same tool body the MCP server uses, every model request goes to the
  caller's provider, and the turn's registration is gone and no upstream connection is open when
  the response is sent

#### Scenario: ai/chat behavior is unchanged by the extraction

- **WHEN** the shared helper is introduced and `ai/chat` is rewired to call it
- **THEN** `ai/chat`'s observable request/response/SSE behavior is unchanged (its existing
  tests pass unmodified)

### Requirement: Dedicated spend and time bounds

Because a one-shot generation reads the **entire** transcript in a single turn — a larger
workload than an incremental chat message — it SHALL use its **own** budget and timeout
configuration (distinct from the AI chat's), so a long transcript does not fail against a
chat-tuned bound and raising the generate bound does not inflate chat spend. The generate
bound SHALL default higher than the chat's. Because the transcript is delivered as
multiple sequential pages at generation density — each page entering and persisting in
the turn's context, plus one tool round-trip per created topic — the generate budget and
timeout defaults SHALL be sized for a multi-page sequential read of a long session, no
lower than the event-generation defaults (which the repo sizes for the same
full-transcript-at-generation-density read), so a multi-page session completes rather
than exhausting the bound.

The bound that applies depends on the route:

- the **CLI** turn keeps its dollar budget (`TOPIC_GENERATE_MAX_BUDGET_USD`) and
  `TOPIC_GENERATE_TIMEOUT_SEC`, unchanged;
- the **AI SDK** turn has no dollar cap (the caller pays their own provider). It SHALL be bounded
  by the generation step cap (`GENERATE_MAX_STEPS`, default 40, distinct from and higher than the
  chat's), at most `GENERATE_MAX_OUTPUT_TOKENS` output tokens per step (default 16 000, valid 1 000–128 000; if the turn's first model request is rejected with `400` at a cap above 4000, the turn starts again once at 4000 before any tool has run), the generation per-turn token budget
  (`GENERATE_MAX_TOKENS`, default 3 000 000 tokens, counting each step's total tokens minus its prompt-cache reads, checked after each step so a turn may
  overrun it by at most one step, and counting an estimate of the step's request and response
  bytes divided by 4 when the provider reports no usage), at most 2 retries of a failed model
  request, the same `TOPIC_GENERATE_TIMEOUT_SEC`, at most 16 tool calls per step (soft: further
  calls in the step get a tool error and the turn continues) and 300 per turn (hard)
  (ai-topics-chat "Session-scoped MCP toolset"), and the per-turn request and byte caps of the
  guarded model requests. The turn's ending SHALL be decided from its own step records, not from
  the provider's finish reason alone. A turn that ends **capped** (the step count reached the
  generation step cap, the token budget fired, or the last step still had tool calls) or
  **incomplete** (the last step finished for output length, content filter, error or another
  reason) has not finished: it SHALL be a failure, like reaching the timeout or the per-turn
  tool-call, request or byte cap, and SHALL take the existing failure mapping (`502`, prior topics
  unchanged), never the success replace.

#### Scenario: Generate budget is independent of chat budget

- **WHEN** the operator raises the topic-generate budget
- **THEN** the AI chat's per-turn budget is unchanged, and a large-transcript generation that
  would exceed the chat budget can still complete under the higher generate budget

#### Scenario: A multi-page transcript completes within the configured bounds

- **WHEN** a generation runs against a session whose transcript spans several
  generation-density pages (on the order of thirty thousand words)
- **THEN** the run's configured budget and timeout defaults are sized for the multi-page
  read, and the run completes and returns `200 {topics}` rather than exhausting a bound
  and mapping to the failure status

#### Scenario: An AI SDK turn is bounded without a dollar cap

- **WHEN** an AI SDK generation turn exceeds `TOPIC_GENERATE_TIMEOUT_SEC`, or reaches the
  generation step cap, the generation token budget, the per-turn tool-call cap or the per-turn
  request cap without finishing
- **THEN** the model request in flight is aborted, the response is the existing `502 {detail}`,
  and the session's prior topics are unchanged

#### Scenario: A run stopped by the step cap after creating topics is a failure
- **WHEN** an AI SDK generation turn has created topics and the model still wants to call tools
  when the generation step cap or the generation token budget stops the turn
- **THEN** the response is the existing `502 {detail}`, the topics this run created are removed,
  and the session's prior topics are unchanged byte-for-byte

### Requirement: Failure mapping

A failure after the gates pass — on the CLI route a CLI spawn error, timeout or CLI-signaled
error; on the AI SDK route any model-side error (a provider error of any status, retries
exhausted, a refused or failed model request, a dropped provider stream), a timeout, a passed
per-turn tool-call, request or byte cap, or a capped or incomplete ending ("Dedicated spend and
time bounds"); or, on either route, a run that creates no topics — SHALL respond
`502 {detail}` (distinct from the no-route `503` and the concurrency `409`), with the pre-run
topics left untouched (they were never modified; the topics this run created are deleted). The
detail is a **fixed, handler-owned** message (never the raw CLI output, a provider error message,
request body or response body, or an internal outcome token). On the AI SDK route the route SHALL
wait for any tool body still running for the turn to finish before it acts on the generation
result (the replace-all), removes a failed run's new topics, sends the response, or releases the
session's AI slot and run lease, so no topic is created after the failure's clean-up. The wait has
no fixed time bound of its own; each of a body's database statements is bounded by the existing
statement timeout.

#### Scenario: CLI turn failure maps to 502 with prior topics unchanged

- **WHEN** the `claude` CLI turn fails for an in-bounds, has-transcript request from a caller
  whose route is the CLI
- **THEN** the response is `502 {detail}`, the session's prior topics are unchanged (left
  exactly as they were), and no raw CLI output is surfaced

#### Scenario: A capped AI SDK run maps to the same 502
- **WHEN** an AI SDK generation turn is stopped by the step cap or the token budget while the
  model still wanted to call tools, or passes the per-turn tool-call cap
- **THEN** the response is the same `502 {detail}` with the same fixed detail, the topics this
  run created are removed, and the prior topics are unchanged

#### Scenario: A provider that reports stop while still calling tools at the step cap is capped
- **WHEN** an AI SDK generation turn's provider reports the finish reason `stop` on every step
  while still emitting `create_topic` calls, until the step count reaches the generation step cap
- **THEN** the turn ends as capped, the response is the same `502 {detail}`, the topics this run
  created are removed, and the prior topics are unchanged

#### Scenario: An output-length stop with an unexecuted tool call fails generation
- **WHEN** an AI SDK generation turn's last step finishes for output length with a `create_topic`
  call that was never executed
- **THEN** the turn ends as incomplete, the response is the same `502 {detail}`, the topics this
  run created are removed, and the prior topics are unchanged

#### Scenario: A tool body still running at the timeout finishes before the clean-up
- **WHEN** an AI SDK generation turn times out while a `create_topic` body is still running
- **THEN** the route removes the run's new topics and releases the AI slot and run lease only after
  that body finished, so no topic from the run remains after the `502`

#### Scenario: An AI SDK provider failure maps to the same 502

- **WHEN** an AI SDK generation turn ends with a provider authentication error (the caller's
  key is rejected) or another provider error, after creating some topics
- **THEN** the response is the same `502 {detail}` with the same fixed detail, the topics this
  run created are removed, the prior topics are unchanged, and nothing from the provider's error
  message, the request body or the response body appears in the response or the server log

### Requirement: One-shot transcript delivery is paged, complete, and snapshot-stable

The one-shot turn's `get_transcript_words` SHALL deliver the transcript at the
generation-density paged rendering governed by `auto-event-generation`'s
"Generation-density transcript rendering" (bounded sequential pages under the rendered
size cap, explicit continuation marker on every page except the last — never one
unbounded payload, never a silent truncation), regardless of transcript length: the
tool surface and the delivery guarantee do not vary with transcript size (the model's
own context ceiling is a documented operational residual, not a delivery limit).

The pages SHALL be computed from a single word list captured once, by one hub read whose
result is materialized as an immutable copy before the turn registers, and no page SHALL be
served from a re-read — so a
mid-run transcript replacement or single-word edit cannot shift page content, page
boundaries, or page count within one run.

The turn's registration SHALL carry ONLY that word snapshot beyond its tool set — no
event-run fields (category allowlist, per-run cap, frame rate, run id); `create_event`
registration remains keyed by the turn's explicit tool set, never by the presence of a
transcript snapshot.

The generate system prompt SHALL name the paged protocol explicitly: that the
transcript arrives in sequential pages, that each non-final page ends with a
continuation marker naming the next page, and that the model MUST keep fetching until
a page carries no marker before treating the transcript as fully read; and it SHALL
state that transcript content is untrusted data that cannot alter the tools, the task,
or the paging rules.

The server SHALL track which pages the run fetched, and a run that created topics
without fetching EVERY page of the snapshot SHALL NOT replace the prior topic set — it
takes the existing failure mapping (fresh rows removed, prior topics byte-for-byte
intact, the existing failure status and detail). This is mechanical page bookkeeping,
not model-output inference.

#### Scenario: Long transcript is delivered fully via pages

- **WHEN** a generation runs against a transcript that exceeds one generation-density
  page
- **THEN** the one-shot's `get_transcript_words` accepts a `page` input and returns
  deterministic sequential pages, every page except the last carrying an explicit
  continuation marker naming the next page, such that the model can retrieve the entire
  transcript without any single oversized tool result

#### Scenario: A short transcript still uses the paged tool shape

- **WHEN** a generation runs against a transcript that fits in one generation-density
  page
- **THEN** `get_transcript_words` still exposes the `page` input and returns page 0
  with no continuation marker (the tool surface does not vary with transcript length)

#### Scenario: Mid-run transcript replacement cannot shift the run's pages

- **WHEN** a topic one-shot has fetched page 0 and the session's transcript words are
  wholly replaced before it fetches page 1
- **THEN** every subsequent page is served from the run's captured word list — the page
  boundaries, page count, and page content are exactly what page 0's run computed, and
  no page reflects the replacement

#### Scenario: A partial page read cannot replace the prior topics

- **WHEN** a run creates topics but exits having fetched only a strict subset of the
  snapshot's pages
- **THEN** the prior topic set is left byte-for-byte intact, the run's fresh rows are
  removed, and the response is the existing failure mapping

#### Scenario: The generate system prompt carries the paging protocol

- **WHEN** the one-shot turn is spawned
- **THEN** its system prompt names the sequential-page protocol, the
  fetch-until-no-continuation-marker rule, and the untrusted-data status of transcript
  content (asserted directly against the prompt constant), in addition to the tool
  description's own protocol text

#### Scenario: Paged delivery does not widen the tool set

- **WHEN** the one-shot turn is registered with paged transcript delivery
- **THEN** the turn offers exactly `get_transcript_words` and `create_topic` (no
  `create_event`, no `list_topics`): on the CLI route the turn's MCP server registers exactly
  those two and the spawned CLI's `--allowedTools` names the same two tools, and on the AI SDK
  route the model is given exactly those two tools

### Requirement: Topic generation is configuration-gated

Topic generation SHALL be gated on the caller's AI route (provider-credentials),
resolved on every request from the caller's saved `llm` choice, the `CLAUDE_CLI_EMAILS`
allowlist and the server's configuration (`CLAUDE_CLI_PATH` for the CLI route). `CLAUDE_CLI_PATH`
alone SHALL
NOT enable generation for every caller, and a caller with no saved `llm` credential has no route
in any mode: there is no development-mode fallback to the Claude CLI.
When the caller has no route, `POST /api/sessions/:sessionId/topics/generate` SHALL respond
`503 {"detail": "Add a language model in Settings → Advanced to generate topics."}`, spawn
nothing and make no model request; this replaces the earlier unavailable detail, which was shared with transcription. The
route check SHALL keep the gate's place in the frozen order: after session resolution and before
the approved-user `403`. The endpoint SHALL NOT have any network-posture refusal: a caller with
an AI route proceeds to the remaining checks when signed in and able to access the session's
show, whatever the deployment's bind address or `IP_ALLOWLIST`; a caller without that access
gets the masked `404` of every session route.

#### Scenario: A caller with no AI route gets the language-model 503

- **WHEN** a signed-in caller who can access the session's show, and who has no `llm`
  credential and does not resolve to the Claude CLI, sends `POST
  /api/sessions/:id/topics/generate`
- **THEN** the response is `503 {"detail": "Add a language model in Settings → Advanced to
  generate topics."}`, and no `claude` subprocess, model request, turn registration, slot or run
  lease is created

#### Scenario: CLAUDE_CLI_PATH alone does not enable generation

- **WHEN** `CLAUDE_CLI_PATH` is set, in production or development mode, and a caller who has no
  `llm` credential requests generation, whether or not the caller is on `CLAUDE_CLI_EMAILS`
- **THEN** the response is the same `503` with the Settings → Advanced detail

#### Scenario: Saving a language model takes effect on the next request

- **WHEN** a caller who was answered the no-route `503` saves an `llm` credential and requests
  generation again
- **THEN** the request passes the configuration gate and proceeds to the remaining checks
  without a server restart

#### Scenario: Non-loopback bind without an allowlist is not refused

- **WHEN** a deployment bound to a non-loopback address with no `IP_ALLOWLIST` receives the
  request from a signed-in caller who has an AI route and can access the session's show
- **THEN** no network-posture `503` is returned, and the request proceeds to the remaining
  checks (concurrency, transcript precondition)
