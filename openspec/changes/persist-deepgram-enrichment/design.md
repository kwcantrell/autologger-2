# persist-deepgram-enrichment — Design

## Context

`transcript-generation` (shipped) sends DeepGram `paragraphs=true` + `sentiment=true` on
every request but `extractWords` (`deepgram.ts:161`) reads only the words array and drops
the rest. `ai-v2-dashboards` (gated, parked) needs this enrichment for a sentiment timeline
and paragraph/speaker segmentation, and its Non-Goals explicitly sequence the ingest/schema
work ahead as a separate gated change. This is that change (its Phase 0b).

Current pipeline (`transcribe.ts:88` handler):

```
listAudioSegments → mergeAudioSegments → per group: transcribeGroup(...) → DeepgramWord[]
  → recordingStartAnchors(events) → remapTranscriptWords(groupWords, segInfo, anchors, fps)
  → RemappedTranscriptWord[] (globally sorted) → replaceTranscriptWords(remapped)  [1 txn]
```

Constraints that bind this change:
- **Single Node process; per-session SQLite**; session-DB schema is idempotent
  `CREATE TABLE IF NOT EXISTS` in `sessionCore.ts:79 initSchema` — **no migration files** for
  session DBs (verified: `initSchema` runs on *every* hub open via the registry, so existing
  DBs gain new tables on next open).
- **Hub RPC bodies are synchronous and transactional** (CLAUDE.md invariants). The
  atomic-replace RPC must stay synchronous and single-transaction; all provider-shape logic
  stays in the async router.
- **The consumer reads in-process**, via `ai-v2-dashboards`' aggregate/MCP tools — not over
  HTTP — so this change exposes enrichment as a hub method, adds no route, and is **not
  contract-bearing** (gate 2026-07-21).
- **One real DeepGram response is capturable** given a key + speech audio, even though the
  live product path (YouTube import) is `503`; the fixture is a **real captured** response,
  not hand-authored (gate 2026-07-21).

## Goals / Non-Goals

**Goals:**
- Persist DeepGram paragraphs + sentiment segments, remapped onto the session timeline,
  atomically with words.
- Expose them through an in-process hub read so the data is observable/testable and the
  parked consumer's aggregate tools can read it.
- Test against a **real captured** provider response (record-once, replay-always), so the
  load-bearing index-base assumption is validated by real data.

**Non-Goals:** (see proposal) no consumer UI, no HTTP route, no session-level average, no
live per-run provider call in CI, snapshot semantics (no recompute on manual edits), no
sentence-level rows, no cross-group speaker reconciliation, no change to frozen
`transcript-words` endpoints or the failure map.

## Decisions

### D1 — `extractEnrichment(body)` beside `extractWords`; `transcribeGroup` returns a struct
`transcribeGroup` changes its return type from `DeepgramWord[]` to
`{ words: DeepgramWord[]; paragraphs: DeepgramParagraph[]; sentiments: DeepgramSentimentSegment[] }`
(all group-local). A new pure `extractEnrichment(body)` mirrors `extractWords`' tolerance and
its `Number(...)` numeric coercion: missing/malformed enrichment or non-numeric
scores/indices → empty/absent, never throws. **Confirmed response locations** (DeepGram live
docs, 2026-07-21):
- Paragraphs: `results.channels[0].alternatives[0].paragraphs.paragraphs[]`, each
  `{ sentences[]{text,start,end}, speaker, start, end, num_words }` (`speaker` present
  because `diarize=true`). Paragraph text = `sentences.map(s => s.text).join(' ')`.
- Sentiment: **top-level** `results.sentiments.segments[]`
  `{ text, start_word, end_word, sentiment, sentiment_score }`. The per-request `average`
  is **not** captured (D8).

Sentiment segment `text` **is** persisted (not reconstructed): after the global word sort a
session-time window can straddle groups, so reconstructing segment text from stored seconds
is fragile — storing the provider's own text is cheap, symmetric with paragraphs, and
correct (adopts panel finding).

### D2 — Remap enrichment per-group, inside the remap layer, before the global sort (the pivot)
Enrichment is **group-local** and must be resolved *within* the per-group anchor context
`remapTranscriptWords` already computes, before the global word sort:
- **Sentiment**: `start_word`/`end_word` index into *that group's* word array; resolve to
  the remapped session-timeline positions of those boundary words. Out-of-range / negative /
  non-integer indices clamp to the group's word bounds; a zero-word group yields no segments;
  `end_word < start_word` normalizes so end ≥ start. **Index-base guard (D9).**
- **Paragraphs**: group-file `start`/`end` seconds run through the *same* anchor chain as
  words, but anchored **as a single-interval unit** — both ends resolve against the segment
  containing the paragraph's `start`, so a paragraph straddling a concat seam keeps a
  coherent duration; `end_sec` is clamped ≥ `start_sec`.

Remapping runs entirely in the router (async-safe) and **never throws / never fails a
word-bearing run**. Resolving after the global sort is wrong — indices/seconds would no
longer map to their originating group. This ordering is a **deliberate invariant** a future
refactor must not "simplify" away.

### D3 — Two per-session tables, nullable session-timeline seconds
Added to `sessionCore.ts initSchema` (idempotent):

```
session_transcript_paragraphs(
  id TEXT PK, start_sec REAL, end_sec REAL,         -- NULL = no timeline position
  speaker TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
  ordinal INTEGER NOT NULL, created_at_utc TEXT NOT NULL)
session_transcript_sentiment(
  id TEXT PK, start_sec REAL, end_sec REAL,         -- NULL = no timeline position
  sentiment TEXT NOT NULL DEFAULT '', sentiment_score REAL NOT NULL DEFAULT 0,
  text TEXT NOT NULL DEFAULT '',
  ordinal INTEGER NOT NULL, created_at_utc TEXT NOT NULL)
```
`start_sec`/`end_sec` are **nullable** session-timeline seconds: **NULL marks "no timeline
position"** (anchorless group/word), distinct from a genuine `0` at the head of the timeline
— honoring the consumer's "never zeros as data" contract (gate Q3). `speaker` uses the same
decimal-string convention as `session_transcript_words.speaker`; speaker ids are not
reconciled across groups (mirrors words). Ordinals are contiguous from 0 assigned by the
**same two-bucket order words use** — anchored (non-NULL start) by `start_sec` asc + stable
secondary key, then anchorless (NULL start) in group/segment order — so the read order is
deterministic (D9 / panel finding). Both tables get an `idx_*_ordinal` index, matching the
words/topics tables.

*Alternative rejected:* a single denormalized JSON blob — opaque to SQL, and the widgets
want row-per-segment/paragraph for timeline range queries.

### D4 — One atomic replace RPC covering words + enrichment
The existing atomic-replace hub RPC (today `replaceTranscriptWords`) is extended to
`replaceTranscriptWords(words, enrichment)` where `enrichment = { paragraphs, sentiment }`
(singular; defaults to empty so the pre-wire single-arg caller keeps compiling) and, in
**one transaction**, delete-then-inserts all three tables. It stays a synchronous hub body (invariant); the router assembles the remapped
enrichment before the single call, exactly as it assembles remapped words today. There is
**exactly one writer** — enrichment is never persisted by a second out-of-transaction path
(spec: "MUST NOT be a second writer"), so a crash can't leave words persisted with
enrichment lost.

*Alternative rejected:* a separate `replaceTranscriptEnrichment` RPC — two transactions means
a crash between them leaves words and enrichment inconsistent.

### D5 — In-process hub read, no HTTP route (gate Q1)
The read is a synchronous `SessionHub.listTranscriptEnrichment()` → `{ paragraphs, sentiment }`
(arrays in ordinal order), backed by a store read; never-generated → empty arrays. **No new
HTTP route, no README change, off the frozen-contract review path.** The `ai-v2-dashboards`
consumer reads enrichment via in-process aggregate/MCP tools, which is exactly this hub seam;
a public route would be unearned permanent frozen surface with no foreseen in-repo caller.
Observability/testing is via an integration test that drives the hub read directly (seeded
through the replace RPC).

*Alternative rejected (escalated + ruled at gate):* a `GET /api/sessions/:id/transcript-enrichment`
route (consistent with the `transcript-words`/`topics` GETs, curl-observable). Ruled out as
contract weight for a consumer that won't use it; add the route additively later if an
external reader ever materializes.

### D6 — Snapshot semantics (no recompute on manual edits)
Manual word CRUD does not touch enrichment tables. Enrichment is only ever replaced by a
generation run. Accepted staleness; documented so a future reader doesn't add "helpful"
cascade logic. **Provenance:** proposed by the implementer during explore and accepted at
the gate — not a standing user directive.

### D7 — Testing: record a real response once, replay always (gate Q4)
The fixture `server/src/test/fixtures/deepgram-enrichment-response.json` is a **real captured
DeepGram response**, not hand-authored — so the load-bearing assumption that sentiment
`start_word`/`end_word` index the same array `extractWords` reads is validated by real data,
the one thing a self-consistent hand-authored fixture cannot prove.
- **Committed audio:** a short (~30–60s), public-domain / CC0, **2-speaker** speech clip
  under `server/src/test/fixtures/audio/`, with a source + license header; NEVER
  `autologgers-demo.html` content.
- **Capture step:** a standalone `scripts/capture-deepgram-fixture.mjs`, invoked via
  `npm run capture:deepgram-fixture`, that **loads the gitignored `server/.env`** (Node
  `--env-file-if-exists`, the same mechanism the server uses — `.env.example` already
  provisions `DEEPGRAM_API_KEY`/`DEEPGRAM_MODEL`) to read the key, POSTs the committed audio
  to `/v1/listen` with our exact params, and writes the response JSON. The key lives only in
  gitignored `server/.env`, never a tracked file. The script is **not in any test glob**, so
  `npm test` never runs it and stays hermetic (record-once/replay). Run **once by the
  operator** to mint the committed fixture (this session cannot reach DeepGram). It is
  deliberately NOT wired into `npm test`: an auto-mint-when-key-present would make the suite
  billed, network-flaky, and able to silently regenerate the committed fixture.
- **Deterministic tests replay** the committed real response through `extractEnrichment`,
  remap, and the hub read.
- **Multi-group** merge/ordinal determinism (which one real single-file clip = one group
  cannot exercise) is covered by a **synthetic 2-group composition** built by duplicating +
  time-offsetting the real single-group response.

### D8 — No session-level average (gate Q2)
DeepGram returns one `results.sentiments.average` **per request = per codec group**; a
multi-group session yields N averages with no defined combination. Rather than bake in an
arbitrary weighting, `average` is **deferred**: persist only segments; a consumer computes
any roll-up (word-weighted or otherwise) from stored segments when it exists and knows the
weighting it needs.

### D9 — Index-base guard, kept as cheap insurance (gate Q4)
Even with a real fixture, a **runtime guard** defends production against *other* audio the
one captured clip didn't exercise: when a sentiment segment's leading `text` token does not
match `words[start_word]`, the segment is stored **anchorless (NULL start/end)** rather than
persisting a confidently-wrong span. ~10 lines, degrades gracefully. The captured fixture
SHOULD include a `smart_format`-merged token (e.g. a spelled-out number rendered as digits)
so the replay test documents the real index base under merging.

## Risks / Trade-offs

- **[Sentiment index base ≠ words[] base]** (the feature's core assumption) → now validated
  by a **real captured** response (D7), and defended in production by the runtime guard (D9)
  which degrades a mismatched segment instead of persisting a wrong span. Residual: audio
  shapes neither the clip nor the guard anticipates — accepted, bounded to "some segments
  degrade to anchorless," never wrong data.
- **[DeepGram response shape drift]** → `extractEnrichment` is tolerant (missing/renamed →
  empty, no throw) and coerces numerics; drift degrades to "no enrichment," never a run
  failure.
- **[Enrichment remap throwing and sinking a good words run]** → remap runs before the
  replace call in the router; the spec makes clamp/skip/degrade **normative** and requires
  it never throw / never fail a word-bearing run.
- **[Untested seam reshaped]** `remapTranscriptWords` is the seam being extended → the
  enrichment remap test (over the real fixture + synthetic multi-group) is the
  characterization anchor (specs rule).
- **[Multi-group speaker conflation]** speaker "0" in group A ≠ "0" in group B → accepted as
  residual, mirroring the words path's documented no-reconciliation stance; real sessions are
  usually single-group, and the flat transcript already lives with this.

## Migration Plan

No catalog migration. The two tables + indexes are additive idempotent DDL in session
`initSchema`; existing session DBs acquire them (empty) on next open. Rollback = revert the
code; empty unused tables are inert. No data backfill (snapshot semantics; enrichment appears
on the next generation run).

## Open Questions

- None blocking.

## Panel & review log

- **2026-07-21 — pre-panel fact-check (explore phase).** Checkable provider-shape claims
  verified against **primary sources (DeepGram live docs)** before drafting:
  paragraphs at `results.channels[0].alternatives[0].paragraphs.paragraphs[]` with `speaker`
  under `diarize=true`; sentiment **top-level** `results.sentiments.segments[]`
  (`start_word`/`end_word` indices) + `average` (corrected an initial assumption that
  sentiment sat under `channels[]`); sentiment boundaries are word indices, not timestamps.
  Per-word sentiment left UNVERIFIED (doc hint only, unused). Design judgments left
  unverified for the panel.
- **2026-07-21 — pre-panel fact-check (repo pass).** Light-tier mechanical fetch-and-compare
  of 12 repo-checkable claims: **all CONFIRMED, zero corrections** — paragraphs/sentiment set
  at `deepgram.ts:118,121`; `extractWords` discards enrichment; `transcribeGroup` returns
  `DeepgramWord[]`; `deepgramResponse()` helper + params test present; session DBs use
  idempotent `initSchema` with no session-DB migration; the atomic-replace transaction
  boundary is at the **hub** layer (`inTxn`), store body has none; `remapTranscriptWords`
  takes `GroupWords[]`, per-group anchors, global sort; handler sequence
  transcribeGroup→remap→replace; `transcript-words` GET exists, `transcript-enrichment` absent;
  README normative table present; word speaker is a decimal string; hub bodies synchronous.
- **2026-07-21 — adversarial panel** (4 skeptical reviewers: requirements / assumptions /
  failure&abuse / scope). Core engineering (capture, per-group remap-before-sort, single
  atomic writer) pressure-tested and **affirmed** (remap-now is load-bearing, not YAGNI — it
  freezes run geometry that mutable events would otherwise lose). Dispositions:

  **Blockers/majors fixed in place (folded into spec/design):**
  - Remap tolerance was scoped only to extraction; the index math in remap could throw an
    uncaught 500 and sink a good words run → clamp/skip/normalize/degrade made **normative**
    in the remap requirement; "never throws, never fails a word-bearing run."
  - Anchorless enrichment stored as `0` was indistinguishable from a real t=0 (violates the
    consumer's never-zeros rule) → **nullable `start_sec`/`end_sec`**, NULL = no position
    (gate Q3).
  - Numeric coercion (`sentiment_score`/indices via `Number(...)`, NaN→absent) — non-STRICT
    SQLite would otherwise store a stringy score and echo it back.
  - Ordinal determinism — pinned the two-bucket (anchored-by-time then anchorless) order so
    the read sequence is deterministic.
  - Paragraph interval straddling a concat seam → remap as a **single-anchor interval**,
    clamp `end_sec ≥ start_sec`.
  - Sentiment segment `text` now persisted (post-sort cross-group reconstruction is fragile).
  - Missing-sub-field guards folded into the tolerance clause.
  - Dropped `e2e:visual` from the final gates (backend-only, no pixels can move).

  **Escalated to the gate → owner rulings (2026-07-21):**
  - Read surface — **hub method only** (no HTTP route); change becomes non-contract-bearing
    (Q1 / D5).
  - Multi-group `average` undefined — **deferred entirely** (Q2 / D8).
  - Anchorless degraded marker — **nullable seconds** (Q3 / D3).
  - Index-base risk vs fixture-only mandate — **test against a real captured response**
    (record-once/replay), synthetic multi-group for merge logic, **plus** keep the runtime
    guard (Q4 / D7, D9). Supersedes the original "fixture-only, hand-authored" instruction.

  **Minors accepted as residual:**
  - Cross-group speaker conflation (mirrors words path; documented).
  - `idx_*_ordinal` on small tables and unbounded text length (consistency with words;
    inert / bounded by transcript length).

  **Provenance correction:** snapshot semantics (D6) was the implementer's explore-time
  proposal, accepted at the gate — not a standing user directive; recorded so future readers
  don't over-weight it.
- **2026-07-21 — post-gate consistency read (light-tier, over all four artifacts).**
  **CLEAN.** Cross-checked proposal, design, spec, tasks against the four gate rulings + the
  fixed-in-place items: hub-method-only / not-contract-bearing consistent everywhere (the
  rejected HTTP route survives only as a labelled rejected alternative in D5); read shape
  `{ paragraphs, sentiment }` (no average) agrees across all four; nullable `start_sec`/
  `end_sec` with NULL≠0 consistent; real-capture/replay + synthetic multi-group + runtime
  guard fully aligned between D7/D9 and tasks; snapshot-semantics provenance labelled; D/Q
  numbers intact; no README/route task; per-phase review scoped to Phase 3 only. No stale
  pre-decision language found.
- **2026-07-21 — post-gate ergonomic refinement (D7 + tasks 1.1/1.2).** Capture invocation
  changed from an inline `RUN_LIVE=1 DEEPGRAM_API_KEY=… node …` command to
  `npm run capture:deepgram-fixture` reading the gitignored `server/.env` (`.env.example`
  already provisions `DEEPGRAM_API_KEY`). Localized to *how the operator runs the one-time
  mint* — the record-once/replay invariant, hermetic `npm test`, and the committed-real-
  fixture design are unchanged; capture deliberately stays out of the test glob (rejected
  auto-mint-in-`npm test`: billed/flaky/silently-regenerating). Not structural; no re-panel.
