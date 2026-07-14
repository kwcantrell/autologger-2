# deepgram-transcription — proposal

## Why

The transcription surface (`POST /api/sessions/:id/transcript-words/generate`) has existed
since the port but returns a deliberate `503` — no transcription box was wired up (phase 6
decision, README "unavailable" row). We now want real speech-to-text: combine a session's
recorded audio segments into a single file server-side and send it to DeepGram's
pre-recorded API, storing the returned words in the existing transcript-words store. The
single-file approach (vs. one request per segment) exists for one load-bearing reason:
DeepGram's diarization speaker labels are only consistent *within* one request, and the
product renders speakers as "Person N" across the whole session.

## What Changes

- **New server-side generation pipeline** behind the existing
  `POST /api/sessions/:sessionId/transcript-words/generate` route (router layer — hub RPCs
  stay synchronous):
  1. List the session's audio segments (hub) and probe each blob's actual codec/stream
     parameters (stored `mime_type` is an untrusted hint); skip unreadable segments.
  2. **Group segments by probed codec** (Opus, AAC, PCM families) + stream parameters.
  3. Per group, **packet-copy concatenate** with **mediabunny** (already declared in
     `server/package.json`; pure-JS remux — no WebCodecs, no ffmpeg), extending the
     in-tree `server/src/node/audioMerge.ts` module, into one container DeepGram accepts:
     Opus → `.webm`, AAC → `.mp4`, PCM → `.wav` — spooled through temp files, never
     buffered whole in memory. Record each segment's cumulative time offset.
  4. One DeepGram pre-recorded request per group (`diarize`, `punctuate`; model
     configurable, default `nova-3`; explicit timeout above DeepGram's 10-minute
     processing ceiling).
  5. Remap each returned word's timestamp: group-file time → owning segment → session
     timeline (frame arithmetic from the segment's recording-start event) → SMPTE
     `session_time` + numeric `start_sec`/`end_sec`.
  6. Replace the session's transcript words via a new single-transaction hub RPC, only
     after all groups succeed; respond `200 {words: [...]}` (the shape the frontend's
     generate mutation already expects).
- **Spend/resource guards**: single-flight — one generation run per process/session at a
  time; concurrent requests get `409` with no provider spend; abort-check before the
  provider call.
- **Config**: new `DEEPGRAM_API_KEY` env var (plus optional `DEEPGRAM_MODEL`). When unset,
  the endpoint keeps its current frozen `503` behavior — unconfigured deployments are
  byte-for-byte unchanged.
- **Speaker mapping**: DeepGram's integer speaker ids are stored as integer strings
  (`"0"`, `"1"`, …) in the `speaker` field — the frontend's `formatSpeaker` already renders
  exactly that as "Person N".

## Capabilities

### New Capabilities
- `transcript-generation`: generating session transcript words from recorded audio
  segments via an external STT provider — segment probing/grouping/concatenation rules,
  timestamp remapping to the session timeline, word content and ordering, speaker
  labeling, single-flight and resource bounds, configuration gating, and failure behavior.

### Modified Capabilities
- `api-contract-freeze`: `POST /api/sessions/:sessionId/transcript-words/generate` changes
  from unconditional `503` to: `200 {words}` on success when a DeepGram key is configured;
  `503` (unchanged) when unconfigured; `400`/`409`/`502` mapping for no-audio,
  concurrent-run, and upstream/oversize failure cases. This is the authorizing delta the
  freeze requires.

## Impact

- **Server**: `routers/transcribe.ts` (generate handler), `server/src/node/audioMerge.ts`
  generalized (per-segment offsets, MP4/WAVE outputs, sub-grouping), new DeepGram client
  module under `server/src/node/`, `env.ts` (key/model config), new `replaceTranscriptWords`
  hub RPC in `SessionHub`/`TranscriptStore`.
- **Web**: none — the generate mutation and TranscribeRow already consume the response.
- **Dependencies**: `mediabunny` (already declared in `server/package.json`; adopted with
  the in-tree `audioMerge.ts` module — pure JS/TS, zero native deps, consistent with the
  "runs anywhere Node runs" invariant). Outbound HTTPS call to DeepGram (the deployment's
  first paid external service; env-gated, off by default — enabling it sends recorded
  session audio to DeepGram's cloud; disclosed in README + `.env.example` per the gate).
- **Contract**: one frozen endpoint's status behavior changes, authorized by the
  `api-contract-freeze` delta. `transcribe.csv`, `topics/generate`, and YouTube import
  remain `503`. Response shape of `GET /transcript-words` is unchanged.

## Non-Goals

- **Topics generation** (`topics/generate`) — stays `503`; LLM summarization is a separate
  change.
- **`transcribe.csv`** — stays `503`.
- **Async/job-based generation API** — the frozen contract is a synchronous POST returning
  `{words}`; we keep it with explicit timeouts (long sessions hold the request open; the
  completed run's words persist server-side even if the client gives up).
- **Re-encoding audio** — no ffmpeg/WebCodecs transcoding. Mixed-codec sessions produce one
  DeepGram request per codec group; speaker labels are then consistent only within each
  group (rare case: a session recorded across different browsers/eras).
- **Cross-group speaker reconciliation** — possible later enhancement, out of scope.
- **Recorder mimeType changes** — an earlier draft pinned `MediaRecorder` to Opus; cut on
  panel review (webm+ogg already land in one group; the pin bought nothing).
- **Live/streaming transcription** during recording.
- **Migrating/re-encoding legacy `.wav` blobs at rest** — they stay `.wav`; PCM handling
  covers them at transcription time.
