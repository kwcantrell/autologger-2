## MODIFIED Requirements

### Requirement: Enrichment persistence and internal read
A successful generation run SHALL persist the remapped enrichment in the session's own rows of
two session tables (`session_transcript_paragraphs` and `session_transcript_sentiment`,
catalog-database "Session content tables"), so every session, existing ones included, reads them
as empty until its first run: paragraph rows
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
- **THEN** it returns empty `paragraphs` and empty `sentiment` (the tables hold no rows for that
  session), never an error

#### Scenario: One session's run leaves another session's enrichment alone
- **WHEN** a generation run replaces session A's words and enrichment while session B has
  persisted enrichment
- **THEN** session B's words, paragraphs and sentiment segments are unchanged

#### Scenario: Enrichment adds nothing to the transcript-words shape
- **WHEN** a client calls `GET /api/sessions/:id/transcript-words` for a session that has
  persisted enrichment
- **THEN** each word object carries exactly the seven keys `id`, `session_time`, `speaker`,
  `word`, `start_sec`, `end_sec`, and `ordinal` — no paragraph, sentiment, or other
  enrichment field — and no HTTP route exposes enrichment at all
