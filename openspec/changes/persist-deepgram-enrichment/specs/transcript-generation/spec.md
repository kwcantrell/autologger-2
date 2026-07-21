# transcript-generation (delta: persist-deepgram-enrichment)

## ADDED Requirements

### Requirement: Enrichment capture from the provider response
The generation pipeline SHALL capture the paragraph and sentiment enrichment DeepGram
already returns for the requested `paragraphs=true` / `sentiment=true` parameters, instead
of discarding it. Per group, the provider call SHALL return, alongside its words, the
group's **paragraphs** — read from `results.channels[0].alternatives[0].paragraphs.paragraphs[]`,
each carrying its `speaker`, group-file `start`/`end` seconds, and the text formed by
concatenating its `sentences[].text` — and the group's **sentiment** — read from the
**top-level** `results.sentiments.segments[]` (each with `start_word`/`end_word` word
indices into that group's word array, `sentiment`, `sentiment_score`, and the segment
`text`). Extraction SHALL be **defensively tolerant**: any missing or malformed field
(absent `paragraphs`/`sentiments`/`sentences`, a non-array where an array is expected)
SHALL yield empty enrichment for that group and MUST NOT throw. All numeric fields
(`start`, `end`, `sentiment_score`, word indices) SHALL be coerced via `Number(...)` as
`extractWords` already does for word timings; a value that coerces to `NaN` SHALL be
treated as absent, never persisted. Words remain the sole success gate; enrichment is
strictly additive to the run's result — a group that yields words but no usable enrichment
still succeeds.

#### Scenario: Paragraphs and sentiment are captured, not discarded
- **WHEN** a group's provider response contains `alternatives[0].paragraphs.paragraphs[]`
  and top-level `results.sentiments.segments[]`
- **THEN** the pipeline retains that group's paragraphs (with speaker and text) and its
  sentiment segments (with text and score), in addition to its words

#### Scenario: Missing or malformed enrichment does not fail a word-bearing run
- **WHEN** a group returns words but its `paragraphs`/`sentiments` are absent, malformed,
  or contain non-numeric scores/indices
- **THEN** extraction yields empty enrichment for that group, does not throw, and the run
  succeeds with words persisted

### Requirement: Enrichment timeline remapping
Captured enrichment SHALL be remapped onto the session timeline **per group, using the
same anchor context computed for that group's words, before words from all groups are
merged and globally ordered** — because sentiment `start_word`/`end_word` indices and
paragraph group-file seconds are only meaningful within their own group's word slice.
Remapping SHALL never throw and SHALL never fail a word-bearing run:

- **Sentiment segments** SHALL take their session-timeline start/end from the remapped
  positions of the words at their `start_word` and `end_word` indices within that group.
  Indices that are out of range, negative, or non-integer SHALL be clamped to the group's
  word bounds; a segment in a zero-word group SHALL be dropped; a segment whose
  `end_word < start_word` SHALL be normalized so end ≥ start. As an index-base guard, a
  segment whose leading `text` token does not match the word at its `start_word` SHALL be
  stored with NULL session-timeline start/end (degraded to unanchored) rather than
  persisting a confidently-wrong span.
- **Paragraphs** SHALL have their group-file `start`/`end` seconds remapped through the
  same anchor chain used for words. A paragraph is an **interval anchored as a unit**: both
  `start` and `end` resolve against the single segment containing the paragraph's `start`,
  so a paragraph that straddles a concatenation seam keeps a coherent duration; the stored
  `end_sec` SHALL be clamped to be ≥ `start_sec`.

Enrichment whose group (or boundary word) has **no resolvable anchor** SHALL be stored with
**NULL** session-timeline start/end — distinct from a genuine `0` — so a consumer can tell
"no timeline position" from "at the start of the timeline" (the `ai-v2-dashboards`
never-zeros-as-data contract). Anchorless enrichment SHALL NOT be dropped. Enrichment SHALL
NOT be resolved in a post-pass over the already-merged, already-sorted word set.

#### Scenario: Sentiment segment inherits its words' timeline position
- **WHEN** a sentiment segment spans `start_word`..`end_word` in a group whose words
  remap to a later recording interval, and its leading text token matches `words[start_word]`
- **THEN** the stored segment's session-timeline start/end match the remapped positions of
  those boundary words, not the group-file seconds

#### Scenario: Malformed sentiment indices never kill a good run
- **WHEN** a sentiment segment has an out-of-range, negative, or non-integer index, or its
  text does not match `words[start_word]`
- **THEN** the segment is clamped, dropped, or degraded to NULL start/end as specified, no
  exception propagates, and the run's words are persisted normally

#### Scenario: Paragraph seconds are remapped as a single-anchor interval
- **WHEN** a paragraph reports group-file `start`/`end` seconds in an anchored group,
  including one whose span crosses a segment concatenation seam
- **THEN** the stored paragraph's session-timeline start/end are anchor-remapped against the
  segment containing its start, with `end_sec ≥ start_sec`

#### Scenario: Anchorless-group enrichment is retained with NULL times, not zeros
- **WHEN** a group (or a segment's boundary word) has no resolvable recording-start anchor
- **THEN** its paragraphs and sentiment segments are stored with NULL session-timeline
  start/end (never silently `0`), and are not dropped

### Requirement: Enrichment persistence and internal read
A successful generation run SHALL persist the remapped enrichment in the per-session
database in two tables created idempotently in the per-session schema init (no catalog
migration), so existing session databases gain them empty on next open: paragraph rows
(nullable session-timeline `start_sec`/`end_sec`, speaker rendered as the same decimal
string convention as word speakers, concatenated text) and sentiment-segment rows (nullable
session-timeline `start_sec`/`end_sec`, `sentiment`, `sentiment_score`, segment text). Rows
SHALL carry contiguous ordinals from 0 assigned by the **same two-bucket order words use**:
anchored rows (non-NULL start) first, ordered by `start_sec` ascending with a stable
secondary key, followed by anchorless rows (NULL start) in group/segment order — so the
read order is deterministic. Speaker ids are diarization indices consistent only within one
provider request; the system SHALL NOT attempt cross-group speaker reconciliation for
enrichment, matching the words path. No session-level sentiment average is persisted (a
consumer computes any roll-up from the stored segments with the weighting it needs).

Enrichment SHALL be readable through a synchronous SessionHub read
(`listTranscriptEnrichment`) returning `{ paragraphs, sentiment }` as arrays in ordinal
order; a session that has never generated (or whose last run produced no enrichment) SHALL
read as empty arrays, never an error. This is an **in-process read only** — no new HTTP
route is added, and the frozen `GET /api/sessions/:sessionId/transcript-words` shape is
unchanged, so this change adds no observable HTTP/WS contract surface.

#### Scenario: Enrichment round-trips through the hub read
- **WHEN** a generation run persists paragraphs and sentiment segments, and a caller then
  invokes `listTranscriptEnrichment`
- **THEN** it returns `{ paragraphs, sentiment }` with both arrays in deterministic ordinal
  order (anchored-by-time then anchorless)

#### Scenario: Never-generated session reads as empty, not error
- **WHEN** `listTranscriptEnrichment` is invoked for a session with no transcript enrichment
- **THEN** it returns empty `paragraphs` and empty `sentiment` (the tables exist but hold no
  rows), never an error

#### Scenario: The frozen transcript-words shape is unchanged
- **WHEN** a client calls `GET /api/sessions/:id/transcript-words` after this change
- **THEN** the response shape is byte-for-byte what it returned before, and no new HTTP
  route exists — enrichment is read only in-process

### Requirement: Enrichment is a generation snapshot
Persisted enrichment SHALL be treated as a snapshot of the run that produced it, tied to
that run's word set and indices. Manual `transcript-words` mutations (insert, update,
delete) SHALL NOT recompute, remap, or wipe enrichment — it may become stale relative to
edited words, and that is accepted. The only operation that changes enrichment is a
subsequent generation run, which replaces it wholesale.

#### Scenario: Manual word edit leaves enrichment untouched
- **WHEN** a user deletes or edits a transcript word after a generation run
- **THEN** the persisted paragraphs and sentiment segments are unchanged (and may no longer
  align with the edited words)

## MODIFIED Requirements

### Requirement: Regeneration replaces the transcript atomically
A successful generation run SHALL replace the session's entire transcript-words set **and
its persisted enrichment** via a **single-transaction hub RPC** (delete-then-insert of
words, paragraphs, and sentiment segments in one transaction; the RPC body stays
synchronous per the hub invariant, and accepts `start_sec`/`end_sec`). All enrichment
extraction and remapping happens in the **router layer** before this call — no `await` and
no provider-shape logic enters the synchronous hub body. The replace transaction SHALL run
only after **all** groups' provider requests have succeeded — a failed group discards the
whole run's results, words and enrichment alike. A failed run SHALL leave the existing words
**and existing enrichment** untouched. **Zero-word guard (gate decision 2026-07-14):** a run
whose provider requests all succeed but yield zero words in total SHALL NOT replace anything
— the existing transcript and its enrichment are preserved and the response is `400` with a
distinct no-speech-detected detail. Skipped segments mean the `200` response can be a partial
transcript; this is returned without any warning indication (the frozen response shape has no
channel for one) — a deliberate, accepted property. Enrichment persistence MUST NOT be a
second writer outside this transaction; there is exactly one atomic replace covering words
and enrichment together, so a crash can never leave words persisted with enrichment lost (or
vice versa).

#### Scenario: Re-run replaces prior words and enrichment together
- **WHEN** generation succeeds on a session that already has transcript words and enrichment
- **THEN** the stored set afterward contains only the new run's words and enrichment,
  replaced in a single transaction

#### Scenario: Failed run preserves existing words and enrichment
- **WHEN** any group's provider request fails mid-run
- **THEN** the session's pre-existing transcript words and enrichment are unchanged and no
  partial insert of either is observable at any point

#### Scenario: Zero-word result does not wipe the transcript or enrichment
- **WHEN** generation succeeds upstream but returns zero words (e.g. silent audio) for a
  session that already has transcript words and enrichment
- **THEN** the response is `400` with a no-speech-detected detail and the existing words and
  enrichment are untouched
