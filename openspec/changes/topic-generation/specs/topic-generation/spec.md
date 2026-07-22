# topic-generation — spec

## ADDED Requirements

### Requirement: Configuration-gated generation

Topic generation SHALL be gated on the same `claude` CLI configuration the AI chat uses
(`aiChatConfigured` / `CLAUDE_CLI_PATH`). When unconfigured, `POST
/api/sessions/:sessionId/topics/generate` SHALL behave identically to its pre-change
unavailable response (`503`). Because a generation run spends the operator's Anthropic
budget, the endpoint SHALL additionally refuse (`503`) in the open-network configuration the
AI chat refuses in (`REQUIRE_LOGIN` off + non-loopback + no `IP_ALLOWLIST`).

#### Scenario: Unconfigured deployment is unchanged

- **WHEN** a deployment with no `CLAUDE_CLI_PATH` receives `POST
  /api/sessions/:id/topics/generate`
- **THEN** the response is `503 {detail}`, matching the pre-change unavailable response
  exactly, and no `claude` subprocess is spawned

#### Scenario: Open-network deployment refuses

- **WHEN** a configured deployment in the open-network config (`REQUIRE_LOGIN` off,
  non-loopback, no `IP_ALLOWLIST`) receives the request
- **THEN** the response is `503 {detail}` and no subprocess is spawned, mirroring the AI
  chat's open-network refusal

### Requirement: Single-flight and concurrency bounds

Topic generation SHALL acquire a turn slot from the shared AI-turn registry
(`aiChatTurns`) — per-session single-flight plus the process-wide concurrency ceiling — the
same bound the AI chat uses, since a generation run is a `claude` CLI turn that spends
budget. A request that cannot acquire a slot SHALL respond `409 {detail}` and spawn nothing.

#### Scenario: Concurrent generation is rejected

- **WHEN** a `topics/generate` request arrives while another AI turn (chat or generate) holds
  the session's slot, or the global ceiling is reached
- **THEN** the response is `409 {detail}` and no subprocess is spawned

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

The generation SHALL drive the operator's `claude` CLI through the existing autologger MCP
server and the existing spawn/env lockdown, via a **shared turn-orchestration helper** that
the `ai/chat` endpoint also uses (spawn → run-to-outcome → the full cleanup: process-group
kill, MCP-turn dispose, temp-config cleanup, turn-slot release) — so the correctness-critical
no-orphan cleanup lives in one place, not two. The one-shot turn: exposes only
`get_transcript_words` + `create_topic` (**withholds `list_topics`** so it generates a fresh
set, per the crash-safe swap); passes a fixed one-shot **user message** (the reused
`--append-system-prompt` lockdown is unchanged); and **does not wire an abort signal** (a
synchronous POST runs to completion so success-replace vs failure-restore is deterministic).
It SHALL NOT introduce a second AI provider, a direct API path, or a new credential. Extracting
the shared helper SHALL NOT change the observable behavior of `POST /api/sessions/:id/ai/chat`.

#### Scenario: Reuses the gated CLI + MCP tools via the shared helper

- **WHEN** a configured, in-bounds generation runs
- **THEN** it spawns the same lockdown-hardened `claude` CLI against the autologger MCP
  server the AI chat uses (with `list_topics` withheld), topics are created via `create_topic`,
  and the spawn/cleanup goes through the same helper `ai/chat` uses

#### Scenario: ai/chat behavior is unchanged by the extraction

- **WHEN** the shared helper is introduced and `ai/chat` is rewired to call it
- **THEN** `ai/chat`'s observable request/response/SSE behavior is unchanged (its existing
  tests pass unmodified)

### Requirement: Dedicated spend and time bounds

Because a one-shot generation reads the **entire** transcript in a single turn — a larger
workload than an incremental chat message — it SHALL use its **own** budget and timeout
configuration (distinct from the AI chat's), so a long transcript does not fail against a
chat-tuned bound and raising the generate bound does not inflate chat spend. The generate
bound SHALL default higher than the chat's.

#### Scenario: Generate budget is independent of chat budget

- **WHEN** the operator raises the topic-generate budget
- **THEN** the AI chat's per-turn budget is unchanged, and a large-transcript generation that
  would exceed the chat budget can still complete under the higher generate budget

### Requirement: Failure mapping

A failure after the gates pass — CLI spawn error, timeout, CLI-signaled error, or a run that
creates no topics — SHALL respond `502 {detail}` (distinct from the unconfigured/open-network
`503` and the concurrency `409`), with the pre-run topics left untouched (they were never
modified; the topics this run created are deleted). The detail is a **fixed, handler-owned**
message (never the raw CLI output or its internal outcome token).

#### Scenario: CLI turn failure maps to 502 with prior topics unchanged

- **WHEN** the `claude` CLI turn fails for a configured, in-bounds, has-transcript request
- **THEN** the response is `502 {detail}`, the session's prior topics are unchanged (left
  exactly as they were), and no raw CLI output is surfaced
