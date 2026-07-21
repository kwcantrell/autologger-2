# persist-deepgram-enrichment — Tasks (plan of record)

> Each phase is gated by `npm run typecheck` + `npm test` before its commit. Locate code by
> content (anchors are orientation only). TDD pairs batch into one dispatch unit.
> **This change is not contract-bearing** (hub-method read, no HTTP route). Per-phase review
> applies to **Phase 3** only (transaction/concurrency semantics); other phases defer to the
> whole-branch review.

## 1. Real-response fixture + extraction (deepgram.ts)

- [x] 1.1 Add a short (~30–60s) public-domain / CC0 **2-speaker** speech clip under
      `server/src/test/fixtures/audio/` with a source + license header comment (never
      `autologgers-demo.html` content). Add `scripts/capture-deepgram-fixture.mjs` + an
      `npm run capture:deepgram-fixture` script that **loads `server/.env`**
      (`--env-file-if-exists`) for `DEEPGRAM_API_KEY`/`DEEPGRAM_MODEL`, POSTs the clip to
      `/v1/listen` with our exact params
      (`diarize/smart_format/paragraphs/sentiment/language/model`), and writes the raw
      response to `server/src/test/fixtures/deepgram-enrichment-response.json`. The script is
      **not in any test glob**, so `npm test` never runs it (stays hermetic).
- [x] 1.2 **[operator step]** Put the key in gitignored `server/.env` (`DEEPGRAM_API_KEY=…`),
      then run `npm run capture:deepgram-fixture` **once** to mint + commit the **real**
      `deepgram-enrichment-response.json`. Confirm it contains ≥2 paragraphs with distinct
      speakers, ≥2 sentiment segments with `start_word`/`end_word` spans, and (ideally) a
      `smart_format`-merged token so the replay test documents the real index base.
- [x] 1.3 Write failing unit tests for a new pure `extractEnrichment(body)` driven by the
      **real captured fixture**: returns `{ paragraphs, sentiments }` from the documented
      locations, concatenates `sentences[].text` for paragraph text, keeps sentiment segment
      `text`, coerces all numerics via `Number(...)` (NaN → absent), and is tolerant —
      missing/malformed fields → empty, never throws.
- [x] 1.4 Implement `extractEnrichment`; change `transcribeGroup`'s return from
      `DeepgramWord[]` to `{ words, paragraphs, sentiments }` (group-local). Add the
      `DeepgramParagraph` / `DeepgramSentimentSegment` interfaces and update existing
      `transcribeGroup` tests to the struct return. Gate: typecheck + test.

## 2. Remap — resolve enrichment onto the session timeline, per-group (transcriptRemap.ts)

- [x] 2.1 Write failing tests (characterization anchor for this seam) over the real fixture
      **and a synthetic 2-group composition** (built by duplicating + time-offsetting the real
      single-group response): a sentiment segment resolves to the remapped positions of its
      `start_word`/`end_word` words; a paragraph's group-file seconds remap as a single-anchor
      interval (`end_sec ≥ start_sec`, including a seam-straddling span); anchorless-group
      enrichment → **NULL** start/end (not 0); out-of-range/negative/non-integer indices
      clamp; `end_word < start_word` normalizes; a zero-word group yields no segments; the
      **index-base guard** degrades a segment whose leading text token ≠ `words[start_word]`
      to NULL; ordinals follow the anchored-then-anchorless two-bucket order deterministically.
- [x] 2.2 Implement the enrichment remap (sibling of `remapTranscriptWords`, reusing the
      per-group anchor context) returning session-timeline paragraph + sentiment records with
      **nullable** `start_sec`/`end_sec` and the index-base guard; enrichment is resolved
      **before** the global word sort and never throws. Gate: typecheck + test.

## 3. Storage + atomic replace (sessionCore.ts, transcriptStore.ts, SessionHub) — per-phase review

- [x] 3.1 Add idempotent DDL to `sessionCore.ts initSchema`: `session_transcript_paragraphs`
      and `session_transcript_sentiment` (columns per design D3, **nullable** `start_sec`/
      `end_sec`) + their `idx_*_ordinal` indexes. Schema-init test confirms existing session
      DBs gain them empty on next open.
- [x] 3.2 Write failing tests for the extended atomic-replace RPC: one transaction
      delete-then-inserts words + paragraphs + sentiment rows; a run with no enrichment clears
      prior enrichment; failure/rollback leaves prior words **and** enrichment untouched (no
      second writer). Add `listTranscriptEnrichment()` returning `{ paragraphs, sentiment }`
      in deterministic ordinal order, empty when never-generated.
- [x] 3.3 Extend the atomic-replace hub RPC to accept `{ words, paragraphs, sentiments }` and
      persist all three in the single existing transaction (synchronous hub body invariant
      preserved); implement `listTranscriptEnrichment`. Gate: typecheck + test.

## 4. Router wire-through (transcribe.ts)

- [x] 4.1 Write a failing integration test: run the generation handler against seeded audio
      with the provider mocked to return the **real captured fixture**, then assert the
      persisted enrichment reads back through `listTranscriptEnrichment` (paragraphs +
      sentiment in ordinal order, NULL times for any anchorless rows); a never-generated
      session reads empty; `GET .../transcript-words` shape is unchanged and no new route
      exists.
- [x] 4.2 Wire the generation handler to assemble remapped enrichment and pass it to the
      extended replace RPC (no second write path). No new HTTP route, no README change.
      Gate: typecheck + test.

## 5. Final gates

- [x] 5.1 `npm run typecheck` + `npm test` green across server.
- [x] 5.2 `npm run e2e` (chromium + login-gate) — sanity only; **`e2e:visual` skipped**
      (backend-only change, no user-visible surface, so no baseline can move).
- [x] 5.3 `openspec validate persist-deepgram-enrichment --strict` passes.
