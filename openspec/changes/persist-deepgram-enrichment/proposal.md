# persist-deepgram-enrichment — Proposal

## Why

The transcript-generation pipeline already asks DeepGram for `paragraphs=true` and
`sentiment=true` on every request (`deepgram.ts:118,121`, asserted by
`deepgram.test.ts:96-97`), then throws both away: `extractWords` reads only
`channels[0].alternatives[0].words[]` and returns `{word,start,end,speaker}`. We pay for
the enrichment and discard it. `ai-v2-dashboards` names two widget families — a sentiment
timeline and paragraph/speaker segmentation — that render an "unavailable" state today
purely because this data is never persisted. That proposal's Non-Goals sequence this
ingest/schema work **ahead** of the dashboard change; this is that work (its Phase 0b).

## What Changes

- **Capture instead of discard.** `transcribeGroup` returns
  `{ words, paragraphs, sentiments }` (all still in group-local coordinates) rather than
  `DeepgramWord[]`. A new pure `extractEnrichment(body)` sits beside `extractWords` and
  reads paragraphs from `channels[0].alternatives[0].paragraphs.paragraphs[]` and sentiment
  segments from the **top-level** `results.sentiments.segments[]`, coercing numerics and
  tolerating any missing/malformed field.
- **Remap enrichment onto the session timeline, per-group, before the global sort.** Both
  enrichment kinds are group-local: sentiment segments reference `start_word`/`end_word`
  **word indices** into their group's word array, and paragraphs carry group-file `start`/
  `end` seconds. `transcriptRemap.ts` is extended to resolve them to session-timeline
  positions using the same anchor context it already computes for words — **not** in a
  post-pass after all groups are merged and sorted. Enrichment with no resolvable anchor is
  stored with **NULL** timeline positions (distinct from a real `0`), and malformed sentiment
  indices are clamped/dropped/degraded so they can never fail a word-bearing run.
- **Persist enrichment in the per-session DB, atomically with words.** Two new idempotent
  tables in `sessionCore.ts` `initSchema` (session DBs have no migration files):
  `session_transcript_paragraphs` and `session_transcript_sentiment`, with **nullable**
  `start_sec`/`end_sec`. The atomic-replace hub RPC that today swaps words is extended to
  swap `{words, paragraphs, sentiments}` inside the **same transaction** (no parallel
  unguarded writer), preserving the "replace only after all groups succeed" guarantee.
- **Internal read only.** A synchronous `SessionHub.listTranscriptEnrichment()` returns
  `{ paragraphs, sentiment }` in ordinal order, so the persisted data is observable and
  testable and so `ai-v2-dashboards`' in-process aggregate tools can read it. **No new HTTP
  route**; the existing `GET .../transcript-words` shape is untouched.

## Capabilities

### New Capabilities
<!-- none — enrichment is part of the existing transcript-generation capability -->

### Modified Capabilities
- `transcript-generation`: the pipeline additionally **persists** DeepGram paragraphs and
  sentiment segments (already-requested provider outputs), **remaps** them onto the session
  timeline alongside words, replaces them **atomically** with the words in the same
  transaction, and exposes them through an in-process hub read. Existing word behavior,
  ordering, the `503`/`409`/`400`/`502` failure map, and the frozen `transcript-words`
  shapes are unchanged.

## Contract impact

**None.** The read is an in-process SessionHub method — **no new HTTP route**, no README
endpoint-table change, and no existing endpoint, JSON shape, status code, export body,
header/range semantic, or WS message/emission semantic changes. This change is **not
contract-bearing** and does not touch the frozen-contract review surface (gate decision
2026-07-21 — the eventual consumer reads enrichment in-process via aggregate tools, not
over HTTP, so a public route would be unearned frozen surface). The two new tables are
additive idempotent DDL in the per-session schema and cannot alter any existing endpoint's
behavior.

## Impact

- **Code:** `server/src/node/deepgram.ts` (extract + return type),
  `server/src/node/transcriptRemap.ts` (enrichment remap + index-base guard),
  `server/src/session/` (`sessionCore.ts` schema, `transcriptStore.ts` + hub atomic-replace
  RPC and `listTranscriptEnrichment` read), `server/src/routers/transcribe.ts` (wire
  capture-through into the replace call). No README change.
- **Data:** two new per-session tables with nullable timeline columns; created lazily via
  idempotent DDL, so existing session DBs gain them on next open. No catalog-DB migration.
- **Tests:** a **real captured DeepGram response** fixture (below) plus a synthetic
  multi-group composition, driving `extractEnrichment`, remap, and hub-read tests.

## Non-Goals

- **No consumer UI.** The `ai-v2-dashboards` sentiment/segmentation widgets that motivate
  this are out of scope; this change ends at a persisted, in-process-readable enrichment
  store.
- **No HTTP endpoint / no contract surface.** The read is a hub method; adding a public
  route later (if an external reader ever needs one) would be a separate additive change.
- **No session-level sentiment average.** DeepGram returns one `average` per request = per
  codec group, and a multi-group session yields N of them with no defined combination; the
  average is deferred, and a consumer computes any roll-up from the stored segments (gate
  decision 2026-07-21).
- **No re-derivation on manual edits (snapshot semantics).** Enrichment is a generation
  artifact tied to a run's word indices. A later manual `transcript-words` edit/delete
  leaves enrichment as-is (potentially stale); the next generation run replaces it
  wholesale. (This posture was proposed by the implementer during explore and accepted at
  the gate, not a standing user directive — recorded honestly in the design log.)
- **No sentence-level storage.** Paragraph text is the concatenation of its
  `sentences[].text`; individual sentence rows are not persisted in v1.
- **No cross-group speaker reconciliation.** Diarization speaker ids are consistent only
  within a provider request; enrichment mirrors the words path and does not reconcile
  speakers across codec groups.
- **No change to the frozen `transcript-words` endpoints**, the generation failure map, or
  the WS fan-out.
