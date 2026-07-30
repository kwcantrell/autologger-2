# topic-generation — delta (topic-generate-paged-transcript)

## ADDED Requirements

### Requirement: One-shot transcript delivery is paged, complete, and snapshot-stable

The one-shot turn's `get_transcript_words` SHALL deliver the transcript at the
generation-density paged rendering governed by `auto-event-generation`'s
"Generation-density transcript rendering" (bounded sequential pages under the rendered
size cap, explicit continuation marker on every page except the last — never one
unbounded payload, never a silent truncation), regardless of transcript length: the
tool surface and the delivery guarantee do not vary with transcript size (the model's
own context ceiling is a documented operational residual, not a delivery limit).

The pages SHALL be computed from a single word list captured once, synchronously,
before any `await` in the turn path, and no page SHALL be served from a re-read — so a
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
- **THEN** the turn's MCP server registers exactly `get_transcript_words` and
  `create_topic` (no `create_event`, no `list_topics`), and the spawned CLI's
  `--allowedTools` names the same two tools

## MODIFIED Requirements

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
Its transcript delivery is governed by "One-shot transcript delivery is paged, complete,
and snapshot-stable".
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
bound SHALL default higher than the chat's. Because the transcript is delivered as
multiple sequential pages at generation density — each page entering and persisting in
the turn's context, plus one tool round-trip per created topic — the generate budget and
timeout defaults SHALL be sized for a multi-page sequential read of a long session, no
lower than the event-generation defaults (which the repo sizes for the same
full-transcript-at-generation-density read), so a multi-page session completes rather
than exhausting the bound.

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
