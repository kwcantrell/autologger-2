# youtube-audio-import — proposal

## Why

The New Session flow already lets a user paste a YouTube URL and tick "use publish date",
and the whole client path for it ships today — `handleSelectSession` POSTs to
`POST /api/sessions/:sessionId/youtube-import`, shows a pending spinner, and on failure
renders `YouTubeImportErrorModal` (retry / continue without audio / delete session). The
server endpoint, however, is a deliberate unconditional `503` (phase-6 "no import pipeline
wired up" decision). This change makes the endpoint actually fetch a video's audio and
attach it as the session's audio, so the already-built UI does something. Every downstream
consumer — the audio player, waveform, and DeepGram transcription — already accepts the
container formats YouTube yields, so this is reconnecting one deliberately-cut wire, not a
greenfield pipeline.

## What Changes

- **New server-side import pipeline** behind the existing
  `POST /api/sessions/:sessionId/youtube-import` route (router layer — hub RPCs stay
  synchronous):
  1. Validate the request URL against an **exact-hostname YouTube allowlist** (incl.
     `youtu.be`; reject look-alikes like `youtube.com.evil.com` with a clean `{detail}`
     error) — the URL is user-supplied and handed to an external fetcher.
  2. **Spawn the `yt-dlp` binary** (argument array with a `--` terminator, never a shell
     string; `--ignore-config`, plugins disabled, and a **scrubbed minimal env** so no
     ambient config/plugin can inject flags and the child never sees server secrets) to
     fetch a **pinned-format** best-audio into an isolated temp dir under the blob scratch
     root, plus one `--dump-json` metadata read. Bounded on four axes (gate decision "all
     three guards", 2026-07-21): a **byte-size cap** (`--max-filesize`), **reject
     live/unknown-duration**, a **4-hour duration cap**, and a wall-clock hang timeout. The
     temp directory is always cleaned up (and crash-orphans swept at startup).
  3. Inject the produced audio as **a single session audio segment** through the existing
     recorder upload path: `addAudioSegment` (synchronous hub RPC) returns the blob key,
     then `ports.audio.put(key, bytes, {contentType})` in the router layer (async), **with
     the recorder's rollback-on-`put`-failure** so a failure can't orphan a metadata row.
     No transcode; the format is **pinned to supported containers** and the stored
     ext/`Content-Type` is **derived from the produced file** (a `502` if it isn't
     supported, rather than a mislabeled blob).
  4. When `use_publish_date` is set, write the session's `episode_date` from the video's
     `upload_date` through the **catalog layer** (`SessionIndexStore.setSessionEpisodeDate`,
     a sibling of the existing `setSessionArchived` — `episode_date` is a catalog column,
     **not** a per-session hub field), storing an **un-shifted `YYYY-MM-DD`** and correcting
     the client date formatter so a UTC-midnight parse doesn't display the prior day. This
     is the first writer of `episode_date` — today the column is only read, so the client's
     checkbox is a dead flag.
  5. Respond `200 {ok: true}` (the shape the client's `useYoutubeImport` mutation already
     reads).
- **Config gating (DeepGram-style, PATH-inclusive)**: a `ytDlpConfigured(env)` gate,
  analogous to `deepgramConfigured(env)`, satisfied by **either** an explicit configured
  `yt-dlp` path (e.g. `YTDLP_PATH`) **or** a bare `yt-dlp` resolvable on the process `PATH`
  (gate decision, 2026-07-21). When neither is present the endpoint keeps its frozen `503`.
  Implication (a deliberate departure from DeepGram's explicit-key gate): a deployment that
  merely has `yt-dlp` installed on `PATH` auto-enables import, so "byte-for-byte unchanged"
  means "no `yt-dlp` available", not "no key set". Detection resolves the binary once at
  startup (PATH lookup is I/O, not a pure config read).
- **Open-network refusal (mirrors the AI endpoints)**: the endpoint refuses (`503`) in the
  `REQUIRE_LOGIN`-off + non-loopback + no-`IP_ALLOWLIST` config, exactly as AI chat / AI v2
  do — an import spends bandwidth/disk and hits a third party (gate decision, 2026-07-21).
  This closes the unauthenticated-reachability edge of the PATH auto-enable.
- **Concurrency bounds**: **per-session single-flight** (concurrent same-session import →
  `409`, no spawn) **and** a **global concurrency ceiling** across sessions (over the cap →
  `409`), the latter mirroring `aiChatMaxConcurrent` (gate decision "all three guards").
- **Failure behavior**: a download/extraction failure responds with a clean `{detail}`
  error (e.g. `502`), distinct from the unconfigured `503`. The client treats every
  non-2xx identically (toast `err.message`, then the retry modal), so the exact code is a
  server choice as long as it stays the existing `{detail}` envelope.
- **Timeline-anchored take** (2nd-cycle fold-in, design D10–D13): a successful import
  synthesizes a take — `Recording N Started`/`Stopped` internal events anchored at the
  current transport position, a transport advance by the video duration, and a segment with
  `recording_ordinal`/timestamps — so transcript words get time, the audio bar places, and
  events appear (the anchorless residual, observed live in FS-8). The three anchor writes are
  one atomic transaction; the import is **refused `409` while a recording is live**.

## Capabilities

### New Capabilities
- `youtube-audio-import`: importing a YouTube video's audio into a session — exact-hostname
  URL validation, the hardened external `yt-dlp` fetch (arg-array spawn, `--ignore-config`,
  scrubbed env, pinned format, four bounds: byte/live/duration/hang, temp isolation +
  cleanup + startup sweep), single-supported-container-segment ingestion with atomic
  rollback, `use_publish_date` → catalog `episode_date` write semantics, PATH-inclusive
  configuration gating + open-network refusal, per-session single-flight + global
  concurrency ceiling, the synchronous single-shot request model, and failure behavior.

### Modified Capabilities
- `api-contract-freeze`: `POST /api/sessions/:sessionId/youtube-import` changes from
  unconditional `503` to: `200 {ok: true}` on success when a `yt-dlp` binary is configured;
  `503` (byte-for-byte unchanged) when no `yt-dlp` is available; `503` (new, mirroring the
  AI-endpoint refusal) in the open-network config; `409 {detail}` when another same-session
  import is in flight or the global ceiling is reached (no spawn); a `502 {detail}` for a
  download/extract/bound/unsupported-container/blob-write failure; and a `400` for a
  non-allowlisted or malformed URL. **Fold-in (D10–D13):** a successful import additionally
  creates the two `Recording N` anchor events + a transport advance, broadcasting the existing
  `event.changed`/`transport.changed` once (no new WS shape); and a `409 {detail}` precondition
  is added for a session whose transport is actively rolling (the existing `409` status, new
  precondition). This is the authorizing delta the freeze requires. The `GET`-side session JSON
  shape is unchanged — `episode_date` was already a nullable field in the response; this change
  only makes it non-null for imported sessions (a value, not a shape, change).

## Impact

- **Server**: `routers/sessions.ts` (the `youtube-import` handler replaces the `503` stub,
  with per-session single-flight + a global concurrency ceiling + the open-network refusal),
  new `yt-dlp` client/download module under `server/src/node/` (arg-array spawn,
  `--ignore-config`, scrubbed env, pinned format, four bounds), `env.ts` (startup-resolved
  binary path + `ytDlpConfigured` gate + `youtubeImportOpenNetworkRefused`), new
  `setSessionEpisodeDate` **catalog** mutator in `SessionIndexStore`, a Zod body schema +
  exact-hostname URL allowlist, and a startup temp-sweep.
- **Web**: one small fix — `fmtDateOnly` (duplicated in `HomeRoute.tsx` /
  `RecentSessionsList.tsx`) must render a bare `YYYY-MM-DD` on its literal calendar day (no
  UTC-midnight zone shift). The import request/response and failure path are otherwise
  already fully consumed by `useYoutubeImport`/`AppShell`/`YouTubeImportErrorModal`.
- **Dependencies**: no new npm dependency. The pipeline shells out to an **external
  `yt-dlp` binary** the operator installs and points the config at — off by default,
  consistent with "runs anywhere Node runs, no external integration wired up *by default*."
  Enabling it makes outbound requests to YouTube and downloads third-party audio to disk;
  disclosed in README + `.env.example` per the gate, exactly as DeepGram's egress is.
- **Contract**: one frozen endpoint's status behavior changes, authorized by the
  `api-contract-freeze` delta. `topics/generate` and `transcribe.csv` remain `503`.

## Non-Goals

- **Setting the session title from the video** — the user names the session in the New
  Session modal; import only touches audio and (opt-in) the episode date.
- **Playlists / channels / multiple videos** — one video URL → one session's audio.
- **Any async/job/progress protocol** — the frozen client contract is a single synchronous
  POST returning `{ok}` with no polling surface, so the request is kept single-shot and
  bounded by timeouts rather than re-architected. A long download holds the request open;
  the client's own spinner + retry modal already cover the wait and the give-up case.
- **Transcoding / re-encoding the downloaded audio** — stored as-downloaded; the format is
  pinned to supported containers and an unsupported produced container fails the request
  (`502`) rather than being transcoded (`mediabunny` is not invoked in this path).
- **Bundling or auto-updating `yt-dlp`** — the operator provides and maintains the binary;
  the server only spawns what the config points at.
- **A pure-JS extractor (`ytdl-core` et al.)** — rejected as too fragile against YouTube's
  constant breakage; the env-gated external binary is the robust, maintainable path.
