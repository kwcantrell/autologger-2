## MODIFIED Requirements

### Requirement: Regeneration replaces the transcript atomically
A successful generation run SHALL replace the session's entire transcript-words set **and
its persisted enrichment** via a **single-transaction hub RPC** (delete-then-insert of
words, paragraphs, and sentiment segments in one transaction; the RPC body awaits only its
own transaction's statements, and accepts `start_sec`/`end_sec`). All provider calls, blob
reads and enrichment extraction happen in the **router layer** before this call — none enters
the hub body. The remap of words and enrichment onto the session timeline SHALL run inside the
replace transaction, as a pure computation over the recording anchors read in that same
transaction, so the stored transcript is never remapped against anchors that changed before it
committed. The replace transaction SHALL run
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

#### Scenario: Re-run replaces prior words
- **WHEN** generation succeeds on a session that already has transcript words and enrichment
- **THEN** the stored set afterward contains only the new run's words and enrichment,
  replaced in a single transaction

#### Scenario: Remap uses the anchors the replace transaction reads
- **WHEN** a recorded or imported take adds `Recording N` anchors while a generation run waits on the provider
- **THEN** the replace remaps the run's words against the anchors present when its transaction runs, including the new take's

#### Scenario: Failed run preserves existing words
- **WHEN** any group's provider request fails mid-run
- **THEN** the session's pre-existing transcript words and enrichment are unchanged and no
  partial insert of either is observable at any point

#### Scenario: Zero-word result does not wipe the transcript
- **WHEN** generation succeeds upstream but returns zero words (e.g. silent audio) for a
  session that already has transcript words and enrichment
- **THEN** the response is `400` with a no-speech-detected detail and the existing words and
  enrichment are untouched

### Requirement: Failure mapping
When the key is configured: a session with zero audio segment rows SHALL yield `400` with
an actionable detail; a session whose segments are all skipped (no readable segment
remains) SHALL yield `400` with a distinct detail; a provider request failure or provider
timeout SHALL yield `502` with a detail that does not leak the API key or verbatim
upstream bodies; the client-side provider timeout SHALL be configured longer than the
provider's documented 10-minute processing ceiling (undici's 300s default is insufficient
and MUST be overridden). The pipeline SHALL run in the router layer — no provider call or
blob read enters a SessionHub RPC body — and any hub access after a provider or blob `await`
SHALL re-acquire the hub through the registry (idle eviction may have closed the previous
handle during the await).
Generation runs against the segment set snapshotted at run start; segments uploaded
mid-run (e.g. a recording in progress) are absent from the result — accepted snapshot
semantics.

#### Scenario: No audio to transcribe
- **WHEN** generation is requested for a session with no audio segments
- **THEN** the response is `400` with a detail explaining there is no audio to transcribe

#### Scenario: All segments unreadable
- **WHEN** every segment's blob is missing or unparseable
- **THEN** the response is `400` with a distinct detail (no provider request is made)

#### Scenario: Upstream failure maps to 502
- **WHEN** DeepGram responds with an error or exceeds the configured timeout
- **THEN** the endpoint responds `502` with a generic upstream-failure detail and existing
  words are preserved

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

Enrichment SHALL be readable through a SessionHub read
(`listTranscriptEnrichment`) returning `{ paragraphs, sentiment }` as arrays in ordinal
order; a session that has never generated (or whose last run produced no enrichment) SHALL
read as empty arrays, never an error. This is an **in-process read only** — no HTTP route
exposes enrichment, and enrichment adds nothing to the transcript-words wire shape.

That wire shape is no longer the shape this capability shipped against: `perf-audit-remediation`
trimmed it to exactly the seven keys `{id, session_time, speaker, word, start_sec, end_sec,
ordinal}`, dropping `session_id` and `created_at_utc` and rounding `start_sec`/`end_sec` to
3 decimals; that shape is specified normatively by the `api-contract-freeze` capability.
Enrichment SHALL NOT reintroduce either dropped key, and SHALL NOT add fields to that shape.

#### Scenario: Enrichment round-trips through the hub read
- **WHEN** a generation run persists paragraphs and sentiment segments, and a caller then
  invokes `listTranscriptEnrichment`
- **THEN** it returns `{ paragraphs, sentiment }` with both arrays in deterministic ordinal
  order (anchored-by-time then anchorless)

#### Scenario: Never-generated session reads as empty, not error
- **WHEN** `listTranscriptEnrichment` is invoked for a session with no transcript enrichment
- **THEN** it returns empty `paragraphs` and empty `sentiment` (the tables exist but hold no
  rows), never an error

#### Scenario: Enrichment adds nothing to the transcript-words shape
- **WHEN** a client calls `GET /api/sessions/:id/transcript-words` for a session that has
  persisted enrichment
- **THEN** each word object carries exactly the seven keys `id`, `session_time`, `speaker`,
  `word`, `start_sec`, `end_sec`, and `ordinal` — no paragraph, sentiment, or other
  enrichment field — and no HTTP route exposes enrichment at all
