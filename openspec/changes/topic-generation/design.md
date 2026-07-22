# topic-generation — design

## Context

The AI chat feature (`ai-topics-chat`) already generates topics: `routers/aiChatRunner.ts`
spawns the operator's `claude` CLI with an env/argv lockdown against the in-process
autologger MCP server (`routers/aiMcpServer.ts`, exposing `get_transcript_words`,
`list_topics`, `create_topic`), driven by a topics-assistant system prompt; it is gated on
`aiChatConfigured` (`CLAUDE_CLI_PATH`), refuses in the open-network config
(`aiChatOpenNetworkRefused`), and bounds spend via the `aiChatTurns` registry (per-session
single-flight + a global ceiling). The relay (`routers/aiChatRelay.ts`) parses the CLI's
stream-json to SSE for the chat UI.

`POST …/topics/generate` is an unconditional `503` stub (`routers/transcribe.ts`). This
change wires it to run the **same** CLI machinery **once, non-conversationally**, returning
the topics synchronously — the one-shot button the AI chat's conversational flow was said to
replace, now actually functional. Topics live in `session_topics` via `TopicStore`
(`insertTopic`/`listTopics`/`deleteTopic`; no bulk-delete/replace primitive exists yet).

Constraints: single Node process; SessionHub RPCs synchronous (the CLI spawn/stream is async
in the router; topic writes are synchronous hub RPCs); the frozen `topics/generate` contract
becomes a synchronous `POST → {topics}` (not SSE) — the AI chat owns the streaming surface.

## Goals / Non-Goals

**Goals:** make the one-shot "Generate topics" button work by reusing the gated CLI + MCP
infra; replace-all that never destroys prior topics on failure; unconfigured deployments
unchanged (`503`).

**Non-Goals:** a second AI provider / direct API / new key; streaming on `topics/generate`;
append/merge semantics (gate chose replace-all); generating a transcript; `transcribe.csv`.

## Decisions

### D1 — Reuse the AI-chat CLI runner + MCP + gate + registry (one-shot)
The handler drives the existing `aiChatRunner` spawn/lockdown against `aiMcpServer`, gated on
`aiChatConfigured` + `aiChatOpenNetworkRefused`, holding an `aiChatTurns` slot — everything
the AI chat uses, since a generate is a `claude` CLI turn that spends budget. New code is the
route handler, the `driveAiTurn` shared-helper extraction (D7), the `deleteTopics` bulk-delete
primitive + the crash-safe swap logic (D3), the dedicated budget config (D6), and a fixed
one-shot user message (D5).
**Alternatives:** (a) direct Anthropic API — rejected (Non-Goal): a second provider + a new
key, when the CLI path already generates topics; (b) a parallel runner — rejected: duplicates
the lockdown/registry/gate that already exist.

### D2 — Non-streaming, run-to-completion, synchronous `200 {topics}`
The frozen `topics/generate` contract is a synchronous `POST` returning a topic list. The
handler runs the CLI turn to completion server-side (consuming the CLI's stdout to detect the
terminal `result`, without an SSE relay), then returns `200 {topics}` (the post-generation
`listTopics()`). Bounded by the same subprocess timeout + process-group kill the AI chat uses.
**Alternatives:** convert `topics/generate` to SSE — rejected: that changes the frozen shape
and duplicates `ai/chat`; the client's generate button expects a synchronous `{topics}`.
*No abort signal (panel):* unlike `ai/chat` (which passes `c.req.raw.signal`), the one-shot
does **not** wire an abort signal — a mid-run client/proxy disconnect would otherwise abort →
failure → discard the fresh topics, making success-replace vs failure-restore
non-deterministic. Without it the turn runs to completion server-side, bounded by D6's timeout
+ process-group kill, and the outcome is deterministic.

### D6 — Dedicated generate budget + timeout (panel MAJOR + gate)
A one-shot generation reads the **entire** transcript in one turn (thousands of words + many
`create_topic` round-trips) — a larger workload than the incremental chat message the AI
chat's `AI_CHAT_MAX_BUDGET_USD` (0.5) / `AI_CHAT_TIMEOUT_SEC` (300) were tuned for. Reusing
them would make the button deterministically fail on large sessions (a budget-truncated run →
`is_error` result → `502`, discarding partial work), with no knob to raise generate spend
without also raising chat spend. So the generate path uses its **own** `TOPIC_GENERATE_MAX_BUDGET_USD`
(default higher than chat, e.g. ~2.0) and optionally its own timeout, passed through the shared
helper as the turn's `maxBudgetUsd`/`timeoutMs`.
**Alternative:** reuse the chat bounds + a README caveat — rejected at the gate (deterministic
failure on the exact large sessions the button targets).

### D7 — One shared turn-orchestration helper for `ai/chat` and `topics/generate` (panel MAJOR + gate)
The correctness-critical block — `getAiMcpListener → registerTurn → spawnAiChatTurn →
runAiChatTurn`, with the `finally` that runs `killAiChatProcessGroup` + `mcpTurn.dispose()` +
`spawnResult.cleanupConfig()` + `slot.release()` — currently lives inline in `ai.ts`. Both
endpoints need it; duplicating the no-orphan `finally` invites drift (a leaked process group or
MCP registration in one copy). Gate decision: **extract one helper** (e.g. `driveAiTurn({cliPath,
sessionId, message, maxBudgetUsd, timeoutMs, emit, abortSignal?}) → AiChatTurnOutcome`) that
encapsulates listener/spawn/run + the full cleanup. `ai/chat` calls it inside `streamSSE` with
an SSE-writing `emit`; `topics/generate` calls it with a no-op `emit` (reading the returned
outcome, not `emit`) and no `abortSignal`.
**Consequence (must honor):** this re-touches the **frozen** `ai/chat` path — the extraction is
behavior-preserving and ships under the existing `ai.int.test.ts` coverage + a per-phase review;
`ai/chat`'s observable behavior must not change.
**Alternative:** ~15-line duplication in the new handler leaving `ai.ts` untouched — rejected at
the gate: two copies of the exact no-orphan cleanup is the worst block to duplicate.

### D3 — Crash-safe replace-all swap: the prior topics are never touched until success (panel BLOCKER + gate)
Gate decision: replace-all, **crash-safe** — the panel showed that clearing before a multi-
minute CLI run opens a data-loss window (a process death after the clear loses in-memory-only
snapshot topics permanently), a window the transcript-words sibling deliberately avoids
(compute-then-atomic-replace). So the prior topics are **never modified until the run
succeeds**:
1. Record the ids of the pre-run topics (`listTopics().map(id)`) — ids only, no full-row
   snapshot needed, because the prior rows are never deleted on the failure path.
2. Run the CLI turn so it creates a **fresh** set. To stop it deduping against the topics
   we're about to replace, the one-shot **withholds the `list_topics` tool** (allowedTools =
   `get_transcript_words` + `create_topic` only) and passes a one-shot user message
   "generate a fresh complete set." The new topics are created alongside the (invisible to
   the model) pre-run topics.
3. Compute `newIds = current − preRunIds`.
4. **Success** (`newIds.length ≥ 1`): delete the pre-run ids in one transaction → the session
   holds only the fresh set. Return `200 {listTopics()}`.
5. **Failure** (turn error/timeout, or `newIds.length === 0`): delete `newIds` → the pre-run
   topics remain, **exactly as they were** (untouched originals: same ids/ordinals/timestamps).
   Return `502`.
A crash between steps 2–4 leaves the pre-run topics intact (they are only ever deleted by the
atomic step 4, which never ran); at worst a few orphan freshly-created topics remain, cleaned
up by the next generate. This needs one new primitive: a bulk `deleteTopics(ids: string[])`
hub RPC (one transaction) — not a clear-all/restore path.
**Alternatives:** (a) clear-before-run + in-memory restore (the original draft) — rejected at
the gate: the crash window + `insertTopic`-can't-restore-ids-verbatim problems; (b) a staging
buffer / shadow table — heavier, and touches the frozen `create_topic` MCP tool. The
withhold-`list_topics` swap gets crash-safety and byte-for-byte prior-topic preservation with
no MCP-tool change and one small bulk-delete primitive. *Deliberate invariant: nothing mutates
the pre-run topics until the atomic delete-on-success.*

### D4 — Transcript precondition → `400`
Topics are generated from the transcript; with zero transcript words the CLI has nothing to
read and would create nothing. The handler checks `listTranscriptWords()` is non-empty before
spawning; empty ⇒ `400 {detail}` (no wasted CLI turn). Transcript generation stays its own
DeepGram-gated surface (this change does not generate a transcript).

### D5 — Fixed one-shot user message; system-prompt lockdown reused
The one-shot passes a fixed non-conversational **user message** on stdin ("generate a fresh
complete set of topics for this transcript") — NOT a new system prompt; the reused
`--append-system-prompt` lockdown (`AI_CHAT_SYSTEM_PROMPT_BRIEF`) is unchanged. Prompt
injection via transcript content stays contained to "junk topics on this session" by
construction (the tool allowlist is `get_transcript_words`/`create_topic` only for the
one-shot — even narrower than the chat's, since `list_topics` is withheld per D3). *Coupling
note:* the reused system prompt mentions `list_topics`-for-dedup; withholding that tool (D3)
is what makes the reused prompt behave as "generate fresh" — the tool allowlist, not a prompt
rewrite, drives the fresh-generation behavior.

## Risks / Trade-offs

- **Non-deterministic output / zero topics** → an LLM run may create no topics. Treated as a
  failure (`502`); because the pre-run topics were never touched (D3), the session keeps them.
  Worst case is a misleading `502` on a genuinely topicless valid transcript — no data harmed.
- **Long synchronous run** → the CLI turn holds the request open; bounded by D6's dedicated
  generate timeout + process-group kill. `useGenerateTopics` simply awaits (no polling); a
  proxy idle-timeout surfaces as a button error — more exposed than `ai/chat`'s SSE (which
  keeps bytes flowing), acceptable for the loopback/LAN single-process posture.
- **Replace-all destroys manual topics on success** → owner-accepted (gate chose replace-all);
  a successful run intentionally deletes the prior set. Crash-safety (D3) only protects the
  failure/crash path, not an intended successful replace.
- **Crash leaves orphan freshly-created topics** → a process death mid-run leaves the pre-run
  topics intact (the win) plus any topics this run already created (orphans). The next generate
  treats them as "pre-run" and deletes them on its own success — self-healing, not accumulating.
- **Manual topic CRUD is not fenced against a generate** (panel residual) → `POST/PATCH/DELETE
  …/topics` don't hold the AI-turn slot. A manual topic added DURING a generate is a "new" id;
  on a failing generate it is deleted with the run's other new topics (data loss of that
  concurrent manual add). Low-probability (single-process, same-session, same-window); accepted
  residual — the AI-turn slot fences concurrent *generates*, not manual edits.
- **Turn registry sharing with AI chat** → a generate and a chat turn on the same session are
  mutually exclusive (both hold the session slot) — intended (both spend budget on the session).

## Migration Plan
Purely additive + gated: no `CLAUDE_CLI_PATH` ⇒ byte-for-byte the current `503`. No DB
migration (bulk-delete-by-id uses existing `session_topics`). No new dependency/secret (a new
`TOPIC_GENERATE_MAX_BUDGET_USD` config value + optional timeout, both defaulted). Rollback:
revert the handler ⇒ `503` again; the extracted `driveAiTurn` helper is behavior-preserving
for `ai/chat`; already-generated topics are ordinary topic rows.

## Open Questions
_All resolved at the 2026-07-22 gate:_
- ~~**Crash safety / replace mechanism**~~ → **D3:** crash-safe swap (never touch prior topics
  until success; withhold `list_topics`; delete-old-on-success / delete-new-on-failure).
- ~~**Spend/time bound fit**~~ → **D6:** dedicated `TOPIC_GENERATE_MAX_BUDGET_USD` (+ timeout),
  defaulted higher than the chat's.
- ~~**Code reuse**~~ → **D7:** extract a shared `driveAiTurn` helper (touches frozen `ai/chat`,
  ships under its tests + a per-phase review).
- ~~**Zero-topics outcome**~~ → **D3:** `502` when zero topics are created (checked post-run as
  `newIds.length === 0`, even when the CLI outcome is `ok`); prior topics preserved.
- ~~**Prompt**~~ → **D5:** reuse the system-prompt lockdown; a fixed one-shot user message; the
  withheld `list_topics` (not a prompt rewrite) drives fresh generation.

## Panel & review log

> Provisional until the adversarial panel + owner gate run on proposal/spec/design.

- **Pre-panel fact-check pass** — _2026-07-22, light-tier (Explore/sonnet)._ 9 claims, **all
  CONFIRMED, zero corrections**: `topics/generate` is an unconditional `503`
  (`transcribe.ts:224-227`); `aiChatConfigured`(`CLAUDE_CLI_PATH`)/`aiChatOpenNetworkRefused`
  (shared `openNetworkRefused` core)/`aiChatTurns.tryAcquire` all exist as described;
  `aiMcpServer` exposes exactly `get_transcript_words`/`list_topics`/`create_topic` and
  `create_topic` → hub `insertTopic`; `TopicStore` has no bulk-delete (D3 must add one);
  hub has `listTranscriptWords`/`listTopics`. **Two load-bearing confirmations:** (a) the web
  generate button (`useGenerateTopics`, `useTopics.ts:24-33`) POSTs with no body and expects
  `{topics: SessionTopic[]}` — so the `200 {topics}` success shape needs **no web change**;
  (b) the runner is cleanly reusable non-streaming — `spawnAiChatTurn` returns a raw
  `ChildProcess` (no SSE), `runAiChatTurn` takes a generic `emit` callback, and
  `relayAiChatTurn`/`processLine` detect the terminal `result` independent of `emit`, so a
  run-to-completion one-shot uses an `emit` that just records the outcome. `fake-claude.mjs`
  fixture (modes: success/exit-nonzero/garbage/not-logged-in/hang) supports hermetic tests.
- **Adversarial panel** — _2026-07-22, three skeptical reviewers (opus)._ **(BLOCKER)
  clear-before-run loses curated topics on a mid-run process death** (in-memory-only snapshot;
  the transcript-words sibling avoids this via compute-then-atomic-replace) — Failure reviewer.
  **(MAJOR) restore via `insertTopic` can't preserve id/ordinal/created_at** ("byte-for-byte"
  overclaimed) — all three. **(MAJOR) restore must clear partials first** (not bare re-insert)
  — Failure. **(MAJOR) reused chat budget/timeout deterministically fails large-transcript
  generates** — Mechanics. **(MAJOR) one-shot runner cleanup (dispose/cleanupConfig/kill) not
  enumerated → leak risk; extract the shared block** — Failure + Scope. **(MAJOR) abortSignal
  unspecified + design self-contradicts** — Scope + Failure. **(MINORs)** manual-CRUD race,
  transient empty-read, zero-topics threshold. **Cleared/validated:** no write-visibility race
  (`create_topic` commits before the terminal `result`); session binding safe (per-turn token);
  transcript precondition reads the same source the CLI reads; **no WS concern** (TopicStore
  never broadcasts); slot release leak-safe; no detail leak; `{topics}` matches the web client;
  **the endpoint is genuinely new** — the AI chat has no delete tool, so it can only append,
  whereas this does replace-all; snapshot/restore is the only structurally-possible failure-safe
  replace (a DB txn can't span the async turn) — so it's not over-built.
- **Spec-review gate (owner)** — _2026-07-22._
  - **Fixed in place:** don't wire `abortSignal` (deterministic, D2); enumerate the full
    spawn+cleanup in the shared helper (D7); zero-topics = post-run `newIds.length===0` even when
    the CLI is `ok`, `502` (D3); one-shot prompt is a user message, `list_topics` withheld (D5);
    `502` body is a fixed handler message (not the CLI token); WS-non-issue + slot-safety
    confirmed; manual-CRUD race + transient states recorded as residuals.
  - **Escalated to the gate (owner decisions):** **(1) crash safety** → **crash-safe swap**
    (never touch prior topics until success; delete-old-on-success / delete-new-on-failure,
    `list_topics` withheld) — resolves the BLOCKER + the restore-fidelity + clear-partials
    findings together (D3). **(2) spend bound** → **dedicated `TOPIC_GENERATE_MAX_BUDGET_USD`
    (+ timeout)** (D6). **(3) code reuse** → **extract a shared `driveAiTurn` helper** both
    endpoints call, touching frozen `ai/chat` under its tests + a per-phase review (D7).
  - **Accepted as residual:** manual topic CRUD not fenced against a generate; a crash leaves
    orphan freshly-created topics (self-healing); the long synchronous hold's proxy-timeout
    exposure.
- **Post-gate consistency read** — _2026-07-22, light-tier (Explore/sonnet)._ Clean on the
  substance (crash-safe swap / dedicated budget / shared helper / no-abortSignal consistent
  across all four artifacts; D1–D7 references resolve despite non-contiguous order; the
  api-contract 502 row matches "unchanged byte-for-byte"; tasks cover every requirement incl.
  the ai/chat-unchanged scenario). Three stale spots fixed: (1) design D1 still listed a
  "snapshot/clear/restore path" as new code — corrected to `deleteTopics`/`driveAiTurn`/swap;
  (2) the spec's Failure-mapping requirement said "snapshot restored"/"prior topics are
  restored" — corrected to "left untouched/unchanged" + added the "fixed handler-owned detail"
  framing; (3) the proposal's capability summary said "(snapshot/restore-on-failure)" —
  corrected to "(crash-safe swap)". Re-validated `--strict`.
