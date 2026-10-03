## MODIFIED Requirements

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
- **THEN** the turn's MCP server registers exactly `get_transcript_words` and
  `create_topic` (no `create_event`, no `list_topics`), and the spawned CLI's
  `--allowedTools` names the same two tools
