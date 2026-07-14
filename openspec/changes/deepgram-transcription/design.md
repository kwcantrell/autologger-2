# deepgram-transcription — design

## Context

The transcription surface is fully built except the generator: `TranscriptStore` +
hub RPCs + CRUD routes exist; `POST …/transcript-words/generate` throws a clean `503`
(`server/src/routers/transcribe.ts`), the README endpoint table marks it "(unavailable)",
and the frontend's generate mutation already expects `200 {words}` and toasts errors.
Audio segments live as files in the `BlobStore` (`DATA_DIR/blobs/audio/...`) with
per-segment metadata (`mime_type`, `r2_key`, `recording_ordinal`, wall-clock start/end) in
the session DB. Real-world blobs are heterogeneous: Chromium records webm/Opus, Firefox
ogg/Opus, Safari m4a/AAC, and legacy Python-era sessions hold wav/PCM. Segment
`mime_type` is client-supplied and untrusted; `sync-from-disk` can index arbitrary files.

The working tree already contains an uncommitted, tested Opus/WebM merge module —
`server/src/node/audioMerge.ts` (+ `audioMerge.test.ts`, fixtures under
`server/src/test/fixtures/audio/`, `scripts/merge-session-audio.ts`, and `mediabunny`
already in `server/package.json`). It implements exactly D2's mechanism (multi-`Input` →
packet copy with timestamp rebasing, disk-spooled via `FilePathSource`/`FilePathTarget`,
stream-param mismatch fail-fast). This change adopts and extends it rather than building
a parallel module (adoption confirmed at the gate, 2026-07-14).

Constraints that shape everything below: single Node process, local disk, no native
dependencies ("runs anywhere Node 22 runs"); SessionHub RPC bodies are synchronous (async
work belongs in the router layer); the HTTP contract is frozen except where this change's
`api-contract-freeze` delta authorizes it.

## Goals / Non-Goals

**Goals:**
- Real STT for session audio via DeepGram's pre-recorded API, exposed through the existing
  generate endpoint and response shape.
- Consistent diarization ("Person N") across a whole session in the common case.
- Handle Safari (AAC) and legacy (PCM) segments without re-encoding or new native deps.
- Unconfigured deployments remain byte-for-byte unchanged.
- The single process survives its own worst case: bounded memory, bounded concurrency,
  no wallet-drain surface.

**Non-Goals:** topics generation, transcribe.csv, async job API, live transcription,
re-encoding/ffmpeg, cross-group speaker reconciliation, migrating legacy blobs at rest
(see proposal Non-Goals).

## Decisions

### D1 — Server-side pipeline in the router layer
The concat + DeepGram call + remapping run in the `transcribe.ts` route handler (router
layer), reading blobs via `BlobStore` and writing words through hub RPCs.
**Alternatives:** (a) client-side combine + upload — rejected: exposes the API key or
requires a proxy, ships megabytes to the browser and back, duplicates blob access;
(b) inside SessionHub — rejected: violates the synchronous-RPC invariant (fetch/streaming
are async). *Deliberate invariants a future reader must not "fix": no `await` may move
into a hub method; and any hub reference held across an `await` is stale — the idle-hub
sweeper may `close()` the session DB during a long DeepGram await, so the handler must
re-acquire the hub via `getSessionHub()`/registry after every long await instead of
holding a pre-await reference.*

### D2 — Codec-grouped packet-copy concatenation, probed and disk-spooled, extending `audioMerge.ts`
Classify segments by **probing bytes** with mediabunny `Input` (actual track codec +
sample rate + channels) — never by the stored `mime_type` or file extension (uploads
accept any content type; WebM/Ogg can legally carry Vorbis). Group by probed codec +
params; packet-copy each group into one container (Opus→WebM, AAC→MP4, PCM→WAVE) by
generalizing `audioMerge.ts` (add per-segment cumulative offsets to `MergeResult`,
parameterize the output format, replace fail-fast param mismatch with sub-grouping).
Unreadable/unparseable/out-of-family segments are skipped like missing blobs. All
spooling goes through temp files under `DATA_DIR` (`FilePathSource`/`FilePathTarget`, as
`audioMerge.ts` already does) and the request body streams from disk — the pipeline MUST
NOT buffer whole sessions in memory (`BufferTarget` is forbidden here); a group file over
the provider's 2 GB cap fails cleanly with `502` naming the limit.
**Alternatives:** (a) always re-encode to one Opus file — impossible in Node without
WebCodecs/ffmpeg; (b) ffmpeg subprocess — rejected: native dependency, breaks the
portability posture; (c) one DeepGram request per segment, no concat — rejected as the
default: diarization speaker ids are per-request, so "Person 1" would change identity
between recordings; kept implicitly as the degraded behavior for mixed-codec sessions;
(d) concat Opus only with AAC/PCM as singleton pass-through groups — escalated to the
gate, **rejected by the owner 2026-07-14**: per-codec concat stays (whole-session
diarization for multi-take Safari/legacy sessions; the writers share one generalized
packet loop).

### D3 — Synchronous request, frozen response shape, explicit timeouts
The endpoint stays a synchronous POST returning `{words}` (what the deployed frontend
already sends/expects). Timeouts are configured explicitly: DeepGram batch processing may
take up to its documented 10-minute ceiling, while undici's default `headersTimeout` is
300 s — the provider call MUST use a dispatcher/timeout raised above the provider ceiling
(~11 min overall). Browser-side, a multi-minute request can outlive the browser's fetch
patience; the recovery story is: the run completes server-side, words persist, and a
refetch of `GET …/transcript-words` shows them (single-flight prevents retry stacking —
see D9). **Alternative:** async job + polling — rejected: new API surface for no current
need; revisit only if real sessions time out end-to-end.

### D4 — Timeline anchoring via recording-start events, frame arithmetic, 3-step chain
A word's timeline position = anchor(segment) + (wordTime − segmentGroupOffset).
`anchor(segment)` resolves: (1) `Recording N Started` internal event matched by
`recording_ordinal`; (2) i-th unmatched segment ↔ i-th unmatched start event (ordinal/
time order); (3) anchorless → empty `session_time`, zeroed `start_sec`/`end_sec`, words
kept. Anchor seconds come from the start event's stored `timecode_total_frames /
frame_rate` — events do NOT store SMPTE strings (the `timecode` string is derived at read
time), so no SMPTE parser is needed and none is built; recomputing from live transport is
wrong after restarts. `session_time` renders via the existing `formatSmpte`;
`start_sec`/`end_sec` store the remapped seconds directly.
**Alternatives:** porting the web `audioClips.ts` greedy wall-clock matcher as step 2 —
rejected: its beneficiary set (segments with wall times but no ordinals AND count
mismatches) is a sliver of legacy data, blob-reconciled segments have NULL wall times so
it cannot help them, and the UI's own primary path ignores ordinals entirely so "mirroring
the UI" was never achievable — perfect placement parity with the clips UI on degenerate
legacy sessions is an accepted non-goal (residual: words and clips may disagree on such
sessions).

### D5 — Regeneration replaces all words, with a zero-word guard
Delete-then-insert of the full word set in one hub transaction, only after ALL groups
succeeded. Simple, matches "the transcript is a projection of the audio". **Gate decision
2026-07-14:** replace-all stands as v1 semantics — manual word edits are consciously
destroyed by a re-run — **plus a guard**: a run that succeeds upstream but yields zero
words in total does NOT replace; existing words are preserved and the response is `400`
with a no-speech-detected detail (spec + delta row). Alternatives (merge,
generate-only-if-empty) were rejected as added state/surface.

### D6 — Speaker ids as integer strings
Store DeepGram's `speaker` integer as `"0"`/`"1"`/… — `TranscribeRow.formatSpeaker`
already renders exactly this as "Person N+offset" (and `TranscribeFeed` derives the
offset). No new fields, no contract change.

### D7 — Env-gated config
`DEEPGRAM_API_KEY` (required to enable), `DEEPGRAM_MODEL` (default `nova-3`). Unset key →
the existing `503` path is taken before any pipeline code runs. Key only ever in the
`Authorization` header (never a query param), never logged; upstream error details are
summarized, not proxied verbatim. **Alternative:** per-studio key in catalog settings —
rejected: this deployment is single-operator; env matches every other integration toggle.

### D8 — (removed)
The draft's recorder Opus pin (`MediaRecorder` mimeType) was cut on panel review: the
Opus group already ingests webm **and** ogg, so Chromium and Firefox defaults are
single-group today with no pin; Safari falls through `isTypeSupported` back to AAC
anyway; and the pin would modify a lease/heartbeat-critical untested component for zero
pipeline benefit. A future browser default outside Opus simply creates one extra group —
which grouping exists to absorb.

### D9 — Single-flight + spend guards
One generation run per process at a time (and per session): concurrent requests get `409`
before any provider spend; the handler checks the request's abort signal before issuing
the provider call. This bounds memory (one spooled concat at a time), DeepGram spend
(no stacking via browser retries — D3), and event-loop pressure.
**Alternative:** per-session locks with N parallel sessions — rejected at this scale;
one global slot is simpler and the memory bound is the point. **Gate decision
2026-07-14** on auth in `REQUIRE_LOGIN=0` LAN deployments (where the route is callable by
anyone on the network — a wallet-spending endpoint under the open-box posture): accepted
as residual, no auth change — the operator opts into spend by setting the key on a box
they configured, and single-flight bounds the worst-case rate. Compensating control: a
prominent spend/egress warning beside `DEEPGRAM_API_KEY` in `server/.env.example` and the
README.

### D10 — New `replaceTranscriptWords` hub RPC
The existing per-word RPCs each run their own transaction and cannot set
`start_sec`/`end_sec`; composing them from the router cannot be atomic. A new hub RPC
takes the full word list (with `start_sec`/`end_sec`), deletes and inserts in one
transaction with a synchronous body, and assigns contiguous ordinals from 0.

## Risks / Trade-offs

- [Multi-`Input` concat correctness beyond Opus/WebM] → the Opus path is already proven
  by `audioMerge.test.ts`; the spike (Phase 1) covers the genuinely unknown legs:
  DeepGram *accepting* a mediabunny-written concat, word-timestamp alignment across
  concat seams (Opus pre-skip/priming skew), the AAC/fMP4→MP4 remux (needs a Safari
  fixture — least-exercised path), and size-limit math including the PCM worst case
  (3 h stereo PCM ≈ 2.07 GB > DeepGram's 2 GB cap → such sessions fail with the 502
  detail; acceptable, documented).
- [Mixed-codec sessions get per-group speaker ids] → accepted; rare, degraded not
  broken; documented in spec.
- [Replace-all regeneration destroys manual edits] → accepted at gate as v1 semantics;
  the empty-result wipe is guarded (D5).
- [Long-held HTTP request on big sessions] → explicit timeouts + single-flight +
  documented recovery story (D3/D9); event-loop pressure from remux/insert accepted at
  this scale (packet loop yields; single-txn insert is prepared-statement fast).
- [Words vs clips placement divergence on degenerate legacy sessions] → accepted
  residual (D4).
- [Audio egress privacy: enabling the key sends session audio to a third-party US API,
  invisible to non-operator team members] → gate decision 2026-07-14: docs-only
  disclosure (README + `.env.example` sentence); no UI hint.

## Migration Plan

No data migration. Deploy is env-additive: without the key nothing changes; with it the
endpoint activates. Rollback = unset the key (behavior reverts to the frozen 503) or
revert the branch. README endpoint table + `.env.example` updated in the same change.

## Gate decisions (2026-07-14, owner)

1. **Concat scope** (D2): per-codec concat for all three families — KEEP as specced
   (Opus-only + singleton pass-through rejected).
2. **Regeneration semantics** (D5): replace-all stands as v1, **with the zero-word
   guard** — an upstream-successful run yielding zero words does not replace (400,
   words preserved).
3. **Auth under `REQUIRE_LOGIN=0`** (D9): accepted as residual, no auth change;
   compensating spend/egress warning in `.env.example` + README.
4. **Privacy disclosure**: docs-only (README + `.env.example` sentence); no UI hint.
5. **`audioMerge.ts` adoption**: adopted as the concat base; the uncommitted module,
   tests, fixtures, script, and mediabunny dep land on this change's branch.
6. `nova-3` default model: confirm at implementation time (env-overridable regardless) —
   unchanged.

## Panel & review log

**2026-07-14 — adversarial panel (4 reviewers: requirements, assumptions,
failure & abuse, scope) over proposal + specs + design.**

*Blockers/majors fixed in place:*
- `start_sec`/`end_sec` semantics unspecified yet frozen on shipping → pinned: remapped
  session-timeline seconds, `0` for anchorless words (spec + delta).
- Unmapped failure cases (all-blobs-unreadable terminal, corrupt/mislabeled segments,
  oversize group) → pinned: probe-based classification, skip posture, distinct `400`
  terminal, `502` naming the size limit (spec + delta rows).
- "Replace via existing hub RPCs" unimplementable (per-word RPCs = N transactions, no
  `start_sec`/`end_sec` support) → new `replaceTranscriptWords` RPC (D10); replace runs
  only after all groups succeed.
- Word text (`punctuated_word` vs `word`), provider params, and ordering of anchorless
  words unpinned → pinned (new "Word content, ordering, and provider parameters"
  requirement).
- Anchor chain: spec/design disagreed; events store frames not SMPTE strings; the web
  wall-clock matcher doesn't do what D4 claimed → 3-step chain on frame arithmetic; SMPTE
  parser task deleted (D4).
- Unauthenticated/unbounded paid endpoint + unbounded in-memory concat (OOM) → D9
  single-flight + abort check + `409` delta row; D2 disk spooling mandated,
  `BufferTarget` forbidden; key restricted to `Authorization` header.
- undici 300 s default vs DeepGram 10-min ceiling → explicit timeout mandate (D3).
- Idle-hub eviction closing the session DB under the long await → re-acquire-after-await
  invariant (D1).
- Tasks greenfielded a concat module that already exists in-tree → plan rebased on
  extending `audioMerge.ts`; spike retargeted at the genuinely unknown legs (incl. new
  Safari/AAC fixture).
- Recorder Opus pin (old D8) was scope creep with zero pipeline benefit → removed.

*Escalated to the gate (decided 2026-07-14 — see "Gate decisions" above):* concat scope
(kept per-codec); regeneration semantics (replace-all + zero-word guard); auth under
`REQUIRE_LOGIN=0` (residual + docs warning); privacy disclosure (docs-only);
`audioMerge.ts` adoption (adopted).

*Minors accepted as residual:* words-vs-clips placement divergence on degenerate legacy
sessions (D4); event-loop pressure during a run (bounded by single-flight); partial
transcripts returned without a warning channel (stated in spec); sessions crossing 24 h
of timeline alias in SMPTE rendering (frame arithmetic unaffected); cross-request speaker
consistency premise unverifiable from provider docs (industry-standard conservative
assumption, and the concat design is exactly the hedge).
