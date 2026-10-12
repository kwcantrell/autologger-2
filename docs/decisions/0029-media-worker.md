# 0029: Audio post-processing runs in a sandboxed media worker fed by a Postgres job queue

- Date: 2026-10-11
- Status: Proposed
- Rule: media-processing "Media jobs are durable rows claimed under a lease", "The worker is
  sandboxed and computes only", "A stopped recording is merged into one verified segment";
  live-recording-chunks "Finished chunks are persisted locally until the server confirms them"

## Context

A user lost a long live recording. The recorder has been chunked since `chunked-live-recording`
(archived 2026-08-13): every ten minutes the browser uploads a self-contained ~10 MB file, so a
crash should lose at most the current chunk. The design that shipped still keeps every unsent
chunk only in memory (`web/src/pages/index/utils/chunkUploadQueue.ts:141`, a `Blob[]`), retries a
failed upload only at the next rollover, at stop or by hand (`AudioRecorder.tsx:614`), turns any
4xx other than 408/429 into a chunk that **Retry cannot re-attempt** (`chunkUploadQueue.ts:212-214`
filters to `'queued'`), and runs its rollover and heartbeat timers on the main thread, which
Chrome throttles to one wake-up a minute in a hidden tab (`workerInterval.ts:3-8`). A reload, a
sign-in expiry or a long outage therefore still loses audio, with the user's only recourse being a
per-chunk Download button. The exact date and environment of the loss are not known yet; the
candidate paths are listed in `openspec/changes/media-worker/design.md`, "Root-cause notes".

Three more things pull in the same direction:
- the app images carry no `ffmpeg` (`docker/Dockerfile:107`), so the server never probes a
  segment's duration or computes its waveform. The browser does both per chunk, cannot do it for
  large imports (`supabase-11a-legacy-import` Follow-ups A and B), and MediaRecorder's WebM has no
  duration so the timeline draws a 1 s placeholder (`audioClips.ts:432`);
- `#107` already decodes audio with a pinned `ffmpeg` image, but only in operator scripts
  (`server/scripts/backfillWaveforms.ts`, `convertWavToFlac.ts`), run by hand;
- prod sits behind a Cloudflare Tunnel with a 100 MB request body limit, under the 1500 MiB the
  import endpoint accepts, so a large import cannot reach prod at all.

ffmpeg parses untrusted input. It must not run inside the API process, with the API's database
role, secrets and network.

## Decision

The owner decided on 2026-10-11:

- **A separate `media-worker` container in every stack** (dev, stage, prod) runs `ffmpeg` on
  audio the users uploaded. It is non-root, read-only rootfs, no capabilities, CPU and memory
  limited, with no network except an internal, host-isolated `media` network whose only other
  member is `db`. Its image is built multi-arch by the same `docker buildx bake` as the app images
  and pinned by git SHA like them; its `ffmpeg` is pinned by digest.
- **The worker talks to Postgres directly, as its own role** (`autologger_media`), not to an API.
  The role can read `catalog.media_jobs`, `catalog.session_audio_segments` and
  `catalog.session_audio_seams` and update only a few columns of `media_jobs`. It holds no
  catalog role membership and no app secret. A worker-facing HTTP API
  was rejected: it would add frozen surface, a shared token, and a network path from the worker
  to the API for no gain, since the blobs are already a shared volume.
- **The worker computes; the API applies.** Jobs are rows in `catalog.media_jobs`, inserted in
  the same transaction as the segment they concern, claimed with `FOR UPDATE SKIP LOCKED`, leased,
  retried with backoff and capped attempts. The worker writes its results (a merged or converted
  blob under `BLOB_DIR/media/`, peaks, duration, verification) to the job row. The API's single
  process applies them through the `SessionHub` as a system caller, so the session revision,
  `audio.changed` broadcast and row-level security stay the only write path for segments. The
  API copies a worker file through a handle it checked itself and never renames a worker-owned
  inode into place. The worker can therefore write to no segment row and to no file under
  `BLOB_DIR/audio/`, and its database writes are limited to a few job columns under a guard
  trigger.
- **Merge on stop.** When a recording is finalized, the chunks that share its `recording_ordinal`
  are joined by **packet copy** (never re-encoded; the FLAC family for PCM) into one file whose
  decoded sample count is verified against the chunks before it replaces them in one transaction.
  Gaps between chunks are not padded with silence; the chunk boundaries are kept as **seams** on
  the merged segment, so transcript words still land at their wall-clock position. Replaced chunk
  blobs are trashed and deleted after a grace period, never before the merged segment is live.
- **Every new segment is probed and given peaks by the worker**, and 16/24-bit PCM WAV imports
  are converted to verified FLAC. The browser stops decoding audio for waveforms except as a
  fallback for legacy rows.
- **Finished chunks are persisted in the browser** (OPFS, IndexedDB fallback, per user, owned
  through Web Locks) until the server confirms them, the in-progress chunk is appended every 5 s,
  uploads retry on a timed backoff and on `online`, a reload resumes the upload from storage, and
  the segment upload is idempotent per recording window so a resume never stores audio twice.
- **A lost microphone is re-acquired** and the take continues; the screen is kept awake while
  recording and a hidden tab is warned about.
- **Files above the tunnel limit are uploaded in resumable parts** (create, PUT parts, complete),
  each part hashed; the single-request import stays for small files.

Change: `openspec/changes/media-worker` (design D1-D20, the root-cause notes, `panel.md`).

## Evidence

- Owner decisions and post-panel answers, 2026-10-11 (recorded in
  `openspec/changes/media-worker/proposal.md`); the three-lens panel in
  `openspec/changes/media-worker/panel.md` (two-tab double uploads, worker-owned inodes under
  `audio/`, a too-wide `UPDATE` grant, duplicate audio after a merge, and single-clip drift of
  0.34-1.1 s over 3 h were all found before approval).
- The loss paths, each with its `file:line`, in `openspec/changes/media-worker/design.md`,
  "Root-cause notes for the lost recording"; the three code readings in Context above.
- `#107` measured FLAC at 32 % of the WAV size with bit-identical decoded PCM, and showed that a
  pinned `linuxserver/ffmpeg` image decodes everything the catalog holds
  (`openspec/changes/supabase-11a-legacy-import/proposal.md`, Follow-ups B and C).
- The Cloudflare Tunnel body limit (100 MB) versus `MAX_LOCAL_AUDIO_IMPORT_BYTES` (1500 MiB,
  `server/src/routers/audio.ts:116`).

## Consequences

- A fourth long-running service per stack, a new database role and secret (`MEDIA_DB_PASSWORD`),
  a new internal network and a third image to push. `make prod-push`/`stage-push` build it; the
  operator pins `MEDIA_TAG` beside `WEB_TAG`/`API_TAG`; `~/spark-infra` must assert it and hold the
  new key (listed in the proposal, out of scope here).
- A worker outage does not lose data: chunks stay as segments and jobs wait in the queue. It does
  delay waveforms and the merged view; the UI says so.
- Merged segments change segment ids. Nothing in the catalog references a segment id (transcript
  words, events and exports carry timeline positions only); the seams table maps every chunk
  window to the row that now holds it, and the web re-reads the list on `audio.changed`.
- The worker's login can `LISTEN` and `NOTIFY` like any role (PostgreSQL grants no privilege for
  them); the frame bus's signatures hold, the residual is a flood, monitored through
  `pg_notification_queue_usage()` and recorded in `docs/security.md`.
- Browser storage is used for audio. It is cleared on confirmation, discard, or after 30 days,
  and quota pressure degrades to today's in-memory behaviour with a warning, never to a refusal
  to record.
- What would reverse it: the worker proving too heavy for the stage or prod hosts, or a hosted
  object store replacing `BLOB_DIR` (then the job queue stays and the worker reads from the
  store). Reverting means removing the service and the apply step; the stored chunk segments and
  seams remain valid data.
