# Media worker: sandboxed ffmpeg post-processing, merge on stop, crash-safe chunks, resumable imports

Tier: 2
Tier reason:
- a migration (a job table, an upload table, new segment columns and a new login role);
- new HTTP surface on the frozen contract, three additive segment fields and an idempotent
  segment upload (`packages/contract/**`, `server/src/routers/**`);
- a new secret (`MEDIA_DB_PASSWORD`), a new container with its own database role, and a new
  internal network;
- concurrency (a leased job queue, timed retries, a client that resumes after a crash) and a
  destructive operation (chunk segment rows are replaced and their blobs deleted after a grace
  period).
Panel: tier 2, three lenses (browser crash-safety, security and infrastructure, merge data
integrity) recorded in `panel.md` on 2026-10-11; every critical and major finding is resolved in
design D1-D4, D6-D13, D16-D20. The consistency read follows implementation.

Approved-by: Kalen 2026-10-11 (2026-10-14)

ADR 0032.

## Why

A long live recording was lost (date and environment still unknown). Recording has been chunked
since 2026-08-13, so the loss did not come from the one-blob design that change retired; it came
from what that change left for later and called an accepted limit: unsent chunks live only in
memory, a failed upload waits up to ten minutes for its next attempt, a 4xx other than 408/429
parks a chunk where even Retry cannot reach it, and the rollover and heartbeat timers run on the
throttleable main thread. Design "Root-cause notes" lists every path with its `file:line`.

At the same time the server does nothing with the audio it stores: no duration, no peaks, no
format normalisation. The browser computes peaks per chunk and fails on large imports; the
timeline draws 1 s placeholders for Chrome WebM; `#107` added ffmpeg-based peaks and a WAV→FLAC
conversion, but only as operator scripts. And prod's Cloudflare Tunnel caps a request body at
100 MB, so files the import endpoint accepts (up to 1500 MiB) cannot reach it.

## Owner decisions (2026-10-11)

1. **A sandboxed ffmpeg media worker** in every stack: a separate container, non-root, read-only
   rootfs, no capabilities, CPU/memory limits, pinned ffmpeg, no network beyond Postgres, no
   secrets beyond its own database password. Design D1-D4 pick direct Postgres access as its own
   low-privilege role over an API, a `catalog.media_jobs` queue with `SKIP LOCKED` leasing,
   retries and attempt caps, and "the worker computes, the API applies".
2. **Merge on stop.** The chunks of a finished recording (same `recording_ordinal`) become one
   segment with accurate duration and peaks. Design D6-D9: explicit client finalize plus a server
   fallback, packet-copy concatenation per codec family (never re-encoded, FLAC for PCM), seams
   instead of silence padding, decoded-sample verification before the swap, chunk blobs trashed
   for 7 days.
3. **Crash-safe chunks** in the browser: OPFS with an IndexedDB fallback, the in-progress chunk
   appended every 5 s, resume after reload through the rescue surface, quota handling and
   cleanup (D10-D11).
4. **Big imports** upload in parts of 32 MiB through a resumable create/PUT/complete API; the
   server assembles by writing each part at its offset, no ffmpeg; the worker post-processes
   (D12). The single-request import stays for small files.
5. **Timed retry** with exponential backoff and jitter, 2 s to 5 min, plus `online`/`offline`
   (D11).
6. **On-ingest processing** for every new segment: duration, peaks, WAV→FLAC with `#107`'s
   verification (D5). The two scripts stay for legacy rows; a small enqueue script lets the
   worker do a backfill.
7. **Infra:** the worker image builds multi-arch like the app images and is included in
   `prod-push`/`stage-push`; the compose wrapper's `SECRET_SCOPE` gives it only
   `MEDIA_DB_PASSWORD` (D13-D15). spark-infra changes are listed below, not made here.

## Owner answers after the panel (2026-10-11)

1. Recordings chunked before this change are not auto-merged; the operator script only (D6).
2. Trash grace period: 7 days (D8).
3. Crash-loss target about 5 s: keep the 5 s timeslices to OPFS (D10).
4. **In scope now:** a screen Wake Lock while recording, re-acquired on `visibilitychange`, and a
   visible warning when the tab is hidden during a recording (D17; spec scenarios in
   `live-recording-chunks`). The earlier non-goal is withdrawn.
5. The lost recording was a live recording (date and environment still unknown).

## What changes

- **Schema** (`supabase/migrations/20261023000000_media_jobs.sql`): `catalog.media_jobs` (with
  the worker-guard trigger and column-level grants), `catalog.media_uploads`,
  `catalog.session_audio_seams` (one row per accepted chunk window, the idempotency index and the
  seam map), three columns on `catalog.session_audio_segments` (`duration_ms`, `media_status`,
  `media_error`), the login role `autologger_media` with its grants and policies;
  `docker/supabase/migrate.sh` sets its password from `MEDIA_DB_PASSWORD`.
- **Worker** (`media-worker/`, a new workspace): claims jobs in two lanes, opens inputs itself and
  feeds `ffmpeg` through a pipe with a forced demuxer, `-xerror` and timeouts; `ingest` (probe,
  peaks through `@autologger/domain`'s `DbPeaksAccumulator`, PCM WAV→FLAC verified by decoded-PCM
  md5) and `merge` (packet copy via `@autologger/transcription`'s `mergeAudioSegments`, verified
  by an exact decoded sample count). Image `docker/media-worker.Dockerfile`, bake target, compose
  service in dev, stage and prod.
- **API** (`server/src/routers/audio.ts`, `packages/session-core`, `packages/storage`): the
  segment POST becomes idempotent per recording window; enqueue on every segment insert; `POST
  …/audio/recordings/:recordingOrdinal/finalize` with the client's chunk list; the resumable upload
  family `POST|GET|DELETE …/audio/uploads[/:uploadId]`, `PUT …/parts/:n`, `POST …/complete` (per-part
  sha256, per-user caps, a free-disk floor); the apply loop that copies worker files by handle and
  turns `done` jobs into segment rows, revision bumps and `audio.changed`, deferring while a
  transcript run holds its lease; a merge reconcile in the lease sweeper; `duration_ms`,
  `media_status` and `seams` on segment dicts; trash sweep with a low-disk mode.
- **Transcription** (`packages/transcription/src/transcriptRemap.ts`): seam-aware anchoring, so a
  word inside a merged segment lands where it would have with the chunk still separate; a missing
  listed blob fails generation instead of being skipped.
- **Web**: `chunkStore` (OPFS/IDB, per user, Web Locks per take and chunk), timeslice appends,
  recovery into the rescue surface (Record disabled until the scan completes), backoff scheduler
  on a worker timer, `online`/`offline`, re-attemptable `blocked`/`permanent` chunks, oversize
  chunks through the parts upload, microphone re-acquisition on track loss, a screen Wake Lock
  and a hidden-tab warning, finalize after the last chunk, rollover and heartbeat on
  `createWorkerInterval`, no per-chunk waveform decode; parts upload for imports over 40 MiB with
  per-part hashes and IndexedDB-remembered resumes; timeline lays a merged segment out as one
  clip per seam and shows "Finalizing recording…" while a merge is pending.
- **Docs**: README (endpoints, topology, "Media worker", runbooks), `docs/openbao-secrets.md`
  (new key), `docs/security.md` (untrusted media), ADR 0032.

## Non-goals

- Re-encoding anything, or padding rollover gaps with silence (seams carry the alignment).
- Merging recordings chunked before this change by default; an operator enqueue script can.
- Multi-client or resumable *recording*; iOS background capture (the hidden-tab warning says
  so).
- Lease checks on segment upload or finalize (a recovered chunk from a crashed tab must still be
  uploadable after another client took the lease; the lease stays advisory as today).
- Changing `MAX_AUDIO_BYTES`, the 1500 MiB import cap, or the YouTube import.
- Dynamic database credentials or secret rotation for the new role (ADR 0025 follow-ups).
- A worker-facing HTTP API, a message broker, or more than one worker replica per stack (one is
  enough; the queue allows more later).
- spark-infra changes (listed under Impact).

## Capabilities

### New

- `media-processing`: the job queue, the worker's sandbox and privileges, on-ingest processing,
  merge on stop with verification and seams, the apply step, trash and grace period, the
  resumable upload staging.

### Modified

- `live-recording-chunks`: MODIFIED "Chunk rollover bounds capture memory and upload size"
  (timeslice appends, no browser peaks), "Upload failure is surfaced and recoverable" (backoff,
  `online`, `blocked`, oversize chunks through parts, Retry re-attempts everything), "Rescue and
  uploads are bound to their recording's session and survive component lifecycle" (the reload
  limit is lifted); ADDED "Finished chunks are persisted locally until the server confirms them"
  (per user, Web Locks, Record waits for the scan), "A stopped recording is finalized", "A lost
  microphone is re-acquired", "Recording keeps the screen awake and warns when hidden".
- `api-contract-freeze`: ADDED "Recording finalize endpoint", "Resumable audio upload endpoints",
  "Audio segments carry duration, media status and seams", "Segment upload is idempotent per
  recording window".
- `batch-audio-import`: MODIFIED "Client stitch and single-take attach" (parts upload above the
  threshold); ADDED "Large imports upload in parts" (per-part hashes, group identity).
- `transcript-generation`: MODIFIED "Timeline remapping of word timestamps" (seams), "Segment
  grouping and concatenation" (a missing blob fails the run).
- `web-session-console`: MODIFIED "Recording intervals lay out multi-chunk segments contiguously"
  (server duration, one clip per seam, finalizing label).
- `catalog-database`: ADDED "The media worker connects as its own read-mostly role" (column
  grants, the guard trigger, the seams table).
- `container-deployment`: MODIFIED "Two images built from one repository", "Images run as non-root
  on pinned bases, for two architectures", "Compose topology publishes only the router,
  segmented, and operable".
- `local-container-environments`: MODIFIED "Prod targets are explicit and bound to committed
  content", "Migrations runner", "Stage can run pushed images behind a public HTTPS edge", "Static
  invariant check of the compose projects", "Database and GoTrue secret generator".

## Contract impact

Authorized by the `api-contract-freeze` delta: six new routes (finalize and the five upload
routes), three new fields on every segment dict (`duration_ms`, `media_status`, `seams`), one
emission addition (`audio.changed` also fires when the API applies a worker result), and one
behaviour change on an existing route: `POST …/audio/segments` with a `recording_ordinal` whose
window the session already holds answers with the existing segment and stores nothing (today it
would store a duplicate). No other existing route, status, shape or message changes.
`local-audio-import` is untouched. Response fixtures under `fixtures/api-responses/` are
regenerated for the three new keys.

## Impact

- Code: `media-worker/**` (new), `supabase/migrations/20261023000000_media_jobs.sql`,
  `docker/supabase/migrate.sh`, `docker/media-worker.Dockerfile`, `docker-bake.hcl`,
  `compose.yaml`, `docker/compose.dev.yaml`, `docker/compose.stage.yaml`,
  `docker/scripts/{compose-run.mjs,check-envs.sh,supabase-keys.mjs}`, `Makefile`,
  `packages/contract/src/schemas.ts`, `server/src/routers/audio.ts`, `server/src/mediaApply.ts`
  (new), `server/src/startupPurge.ts`, `packages/session-core/src/{audioStore,SessionHub}.ts`,
  `packages/storage/src/{blobStore,mediaJobs,mediaUploads}.ts`,
  `packages/transcription/src/{transcriptRemap,generateTranscript}.ts`,
  `web/src/pages/index/{components/AudioRecorder.tsx,components/ChunkRescueBanner.tsx,utils/chunkUploadQueue.ts,utils/chunkStore/**,utils/uploadBackoff.ts,batchImport/**}`,
  `web/src/shared/utils/audioClips.ts`, `web/src/pages/index/hooks/{useAudioClips,useWaveforms}.ts`,
  `web/src/api/types.ts`, `server/scripts/enqueueMediaJobs.ts` (new).
- Tests: per workstream in `tasks.md`; new pg tests for the migration, the role, the queue and the
  apply step; worker unit and `*.ffmpeg.test.ts` tests; web jsdom tests with fake OPFS/IDB.
- Docs: README, `docs/openbao-secrets.md`, `docs/security.md`, `docs/decisions/0032-media-worker.md`.
- **spark-infra (out of scope here, for the owner):** `MEDIA_DB_PASSWORD` must exist in
  `kv/autologger/<env>` **before** the migration ships (the migrations runner refuses without it;
  `docker/scripts/supabase-keys.mjs <env>` creates it, the AppRole policy already covers the
  path); assert `MEDIA_TAG` beside `WEB_TAG`/`API_TAG` in `roles/autologger_images/defaults/main.yml:14-15`
  and pass it on `make prod-check`/`prod-pull`/`prod-up`; the compose key list and defaults in
  `roles/autologger_env/defaults/main.yml:79-80` and the up steps in
  `roles/autologger_env/tasks/up.yml:107-143` learn the third image and the pull of
  `media-worker`; no firewall change (the worker publishes nothing); watch prod disk (80 GB) while
  the 7-day trash holds replaced chunks (the API logs its low-disk mode); `README.md` and
  `docs/roles.md` there mention the fourth service.
- **Branch note:** this branch is stacked on `supabase-11a-legacy-import` (#107) and also carries
  that change's directory; `check-change.sh`'s one-change-per-branch gate passes only with
  `--base supabase-11a-legacy-import` until #107 merges, after which the branch is rebased onto
  `supabase-migration` (tasks §0).
