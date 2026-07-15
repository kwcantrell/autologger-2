# deepgram-transcription — tasks

> Gate passed 2026-07-14 (panel + owner decisions recorded in design.md "Gate
> decisions"). Plan of record.
> file:line anchors are orientation only — locate code by content before editing.

## 1. Spike — the genuinely unknown legs (gates everything downstream)

- [x] 1.1 Adopt the in-tree `server/src/node/audioMerge.ts` module (+ tests, fixtures,
      `merge-session-audio.ts` script, mediabunny dep) onto this change's branch (gate
      decision 5). Then a throwaway, env-gated spike script (real `DEEPGRAM_API_KEY`, one paid
      call) proving: (a) DeepGram accepts a mediabunny-written concatenated WebM;
      (b) word timestamps stay aligned with recorded cumulative offsets across a concat
      seam (assert segment-2 words ≥ its offset — Opus pre-skip/priming is the suspected
      skew); (c) an fMP4/AAC (Safari-recorded) fixture remuxes to plain MP4 and DeepGram
      accepts it; (d) size-limit math recorded for 3 h Opus (~170 MB, fine) and 3 h
      stereo PCM (~2.07 GB, over the 2 GB cap → documented 502 path). Record findings as
      a dated spike note in `design.md`; delete the script.

## 2. Concat module (server)

- [x] 2.1 TDD generalize `audioMerge.ts`: per-segment cumulative offsets in the result;
      probed-codec+params classification (mediabunny `Input`; stored mime is a hint
      only); skip-unreadable posture; sub-grouping on param mismatch (replacing the
      current fail-fast throw); unit tests cover homogeneous Opus (webm+ogg), skip of a
      corrupt fixture, and PCM param-mismatch sub-grouping.
- [x] 2.2 TDD MP4 (AAC) and WAVE (PCM) output legs on the same packet loop, with temp-file
      spooling under `DATA_DIR` (no `BufferTarget`); unit tests assert container choice
      and offsets per group (gate decision 1: per-codec concat kept).

## 3. DeepGram client + config (server)

- [x] 3.1 TDD `server/src/node/deepgram.ts`: pre-recorded request streaming a spooled
      file (content type per group), `diarize`/`punctuate`/model params (`smart_format`
      unset, `language` unset, channel 0), explicit timeout above the 10-minute provider
      ceiling (undici dispatcher — the 300 s default is insufficient), key only in the
      `Authorization` header, error mapping (non-2xx/timeout → typed upstream error, no
      key or upstream body verbatim); extract `{punctuated_word ?? word, start, end,
      speaker}`; unit tests with mocked `fetch`.
- [x] 3.2 Wire `DEEPGRAM_API_KEY` / `DEEPGRAM_MODEL` (default `nova-3`) through
      `server/src/env.ts` config; update `server/.env.example` with the key/model
      entries and a prominent warning beside `DEEPGRAM_API_KEY`: setting it sends
      recorded session audio to DeepGram's cloud and lets any client who can reach the
      generate endpoint (any LAN client under `REQUIRE_LOGIN=0`) trigger billed API
      calls (gate decisions 3–4). Unit test the configured/unconfigured predicate.

## 4. Remapping, replace RPC, endpoint (server)

- [x] 4.1 TDD anchor resolution + word remapping: 3-step chain (ordinal match → index
      pairing → anchorless), anchor seconds from the start event's
      `timecode_total_frames / frame_rate` (no SMPTE parsing), `session_time` via
      `formatSmpte`, `start_sec`/`end_sec` = remapped seconds (0 when anchorless),
      ordering/ordinal assignment per spec (anchored by position, then anchorless by
      segment ordinal); unit tests cover the two-recordings-with-gap and anchorless
      scenarios.
- [x] 4.2 TDD new `replaceTranscriptWords` hub RPC (`TranscriptStore` + `SessionHub`):
      synchronous body, one transaction, delete-then-insert with `start_sec`/`end_sec`,
      contiguous ordinals from 0.
- [x] 4.3 Implement the generate route body in `server/src/routers/transcribe.ts`:
      unconfigured → existing 503 untouched; configured → single-flight guard (409, no
      spend), abort-check before the provider call, pipeline in the router layer,
      re-acquire the hub via the registry after awaits, replace only after ALL groups
      succeed. Integration tests (`*.int.test.ts`, mocked DeepGram fetch): 503
      unconfigured (byte-identical), 200 `{words}` happy path (session_time/speaker
      strings, start_sec/end_sec, contiguous ordinals, response in ordinal order), 400
      no-audio, 400 all-unreadable (distinct detail), 400 zero-word result with prior
      words preserved (gate decision 2), 409 concurrent, 502 upstream failure with prior
      words preserved, replace-on-rerun atomicity.

## 5. Docs + gates

- [ ] 5.1 Update the README endpoint table row for `…/transcript-words/generate`
      (503-unconditional → configuration-gated per the delta) and the "intentionally
      503" prose in README/CLAUDE.md; add the audio-egress + spend disclosure sentence
      to the README (gate decisions 3–4); verify `topics/generate` + `transcribe.csv`
      rows stay marked 503.
- [ ] 5.2 Full gates: `npm run typecheck`, `npm test`, `npm run lint`, `npm run e2e`
      (e2e stays hermetic — no DeepGram key in the e2e env, asserting the 503 path still
      renders its toast).
