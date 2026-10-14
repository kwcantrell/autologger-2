# Tasks

*file:line anchors are orientation only; locate code by content before editing.*

**Commands**
- Gates: `scripts/check-change.sh --stage hook` (while stacked on #107 add
  `--base supabase-11a-legacy-import`, see 0.4). Full: `scripts/check-change.sh`.
- Unit (per workspace): `cd <ws> && npx vitest run --project unit <file>`; pg:
  `cd server && npx vitest run --project pg <file>` (docker); worker: `cd media-worker && npx vitest run`.
- Web: `cd web && npx vitest run <file>`; typecheck `npm run typecheck`; lint `npm run lint`.
- Compose checks: `docker/scripts/check-envs.sh dev|stage|prod`, `node --test docker/scripts/*.test.mjs`.
- Every ticked task carries `Evidence:` with the command and an excerpt (red first, then green).

**Workstreams and file ownership.** Five agents can work in parallel after §0. A file belongs to
exactly one workstream; a change to another workstream's file is a message to its owner, not an
edit. Shared seams are named at the hand-offs: S.1 → B and W (port interfaces), B.3 → A (the
window-normalisation fixture) and → D.1 (the regenerated segment fixtures the conformance test
reads), B.4 → D.3 (the upload route shapes), D.3 → A.3 (`uploads.ts`'s segment mode, which the
queue's `413` fallback calls; A.3 fakes it until D.3 lands). README sections are owned per task:
B owns "Endpoints", "Storage map" (the directory layout: `media/`, `.trash/`, `.tmp/upload-*`),
"Waveform peaks backfill", "Convert WAV blobs to FLAC" and the new "Media jobs" runbook; W owns
"Container deployment" ("Topology", "Build, push, and pin images", "Volumes": mounts and
ownership posture only, pointing at the Storage map for the layout) and "Local container
environments" ("Dev, stage and prod compared"). No other README section is touched.

| WS | Owner of |
| --- | --- |
| S schema + storage | `supabase/migrations/20261023000000_media_jobs.sql`, `docker/supabase/{migrate.sh,test_migrate.sh}`, `packages/storage/src/{mediaJobs,mediaUploads,audioSeams,mediaLimits}.ts`, `packages/storage/src/blobStore.ts`, `packages/storage/src/{mediaJobs,mediaUploads,audioSeams}.pg.test.ts`, `packages/storage/src/blobStore.test.ts`, `packages/ports/src/media.ts` (new port interfaces), `server/src/test/pg/{mediaJobs,mediaRole,mediaUploads,mediaSchema,audioSeams}.pg.test.ts`, `server/src/test/pg/{catalogSchema,catalogPolicies,catalogRoles}.pg.test.ts` |
| B API + session-core | `packages/contract/src/schemas.ts` (+ tests), `server/src/routers/audio.ts`, `server/src/routers/audioUploads.ts` (new), `server/src/mediaApply.ts` (new), `server/src/startupPurge.ts`, `server/src/main.ts`, `server/src/node/config.ts`, `packages/session-core/src/{audioStore,SessionHub,audioSegmentMeta}.ts`, `server/scripts/enqueueMediaJobs.ts`, `fixtures/api-responses/**`, server unit/int tests for these, README sections "Endpoints", "Storage map", "Waveform peaks backfill", "Convert WAV blobs to FLAC", new "Media jobs" runbook (and no other README section) |
| W worker + infra | `media-worker/**`, `docker/media-worker.Dockerfile`, `docker-bake.hcl`, `compose.yaml`, `docker/compose.dev.yaml`, `docker/compose.stage.yaml`, `docker/supabase-db.yaml` (db joins `media`), `docker/scripts/{compose-run.mjs,compose-run.test.mjs,check-envs.sh,test_check_envs.sh,supabase-keys.mjs,supabase-keys.test.mjs,compose-env.sh}`, `Makefile`, root `package.json` workspaces/scripts, `.github/dependabot.yml` (docker ecosystem), `server/scripts/blobSegmentRows.ts` (pin equality only), `docker/scripts/test_media_image.sh` (new), `server/src/test/ffmpegPin.repo.test.ts` (new), `docs/openbao-secrets.md`, `docs/security.md`, README sections "Topology", "Build, push, and pin images", "Volumes", "Dev, stage and prod compared" (and no other README section), the package-architecture repo test's app list |
| A web recorder | `web/src/pages/index/utils/chunkStore/**` (new), `web/src/pages/index/utils/{chunkUploadQueue,uploadBackoff,chunkLeaveWarning,recorderLocks,micReacquire,wakeLock}.ts`, `web/src/pages/index/components/{AudioRecorder,ChunkRescueBanner,HiddenTabWarning}.tsx`, `web/src/shared/utils/workerInterval.ts`, the sign-out hook's chunk-wipe call site (`web/src/api/hooks/useAuth*.ts`, one call), their tests, `web/src/test/fakes/{opfs,idb,locks,wakeLock}.ts` (new) |
| D web consumers + transcription | `web/src/api/types.ts` (+ conformance tests), `web/src/api/uploads.ts` (new parts client), `web/src/pages/index/batchImport/**`, `web/src/shared/utils/audioClips.ts`, `web/src/pages/index/hooks/{useAudioClips,useWaveforms}.ts`, `web/src/pages/index/components/timeline/**`, `packages/transcription/src/{transcriptRemap,generateTranscript,audioMerge}.ts` (+ tests) |

## 0. Spikes and branch hygiene (before parallel work)

- [x] 0.1 Spike (W): build `docker/media-worker.Dockerfile` for `linux/amd64,linux/arm64` with node
  copied onto the pinned `linuxserver/ffmpeg` base (D13); in each variant run `node --version`,
  `ffmpeg -version`, and decode `packages/transcription/fixtures/audio/seg1.webm` to `pcm_f32le`
  through `pipe:0` with `-f matroska -protocol_whitelist pipe -xerror` as uid 10001. On an
  existing dev `dev-blobs` volume record the modes of `audio/` and its files (D4). Then the
  cross-uid sequence (D3, A13): the worker (10001) writes `media/<job>/out.webm`; the API (1000)
  opens it `O_NOFOLLOW`, `fstat`s, copies to `.tmp/put-*`, renames into `audio/`, removes
  `media/<job>/`; then the same with `out.webm` replaced by a symlink to another blob (must
  fail). Also `getent hosts example.com` inside the worker (must fail). Record results in design
  D13/D4/D3 (A11, A13). If node does not run there, switch D13 to the static-ffmpeg fallback
  before W.5.
  Evidence: spike 0.1 (2026-10-12), design A11/A13 and the D13/D4/D3 notes: node v22.23.3 and
  ffmpeg 9.0 run on the pinned base on arm64 and amd64 (QEMU); seg1.webm decodes to 115200 bytes
  of f32le as uid 10001; adopt-by-copy works once the worker `chmod`s `media/<job>/` 0777 (0755
  gives `EACCES` on removal, D4 changed); symlinked `out.webm` fails `ELOOP`; `getent hosts
  example.com` rc 2 on an internal network.
- [x] 0.2 Spike (A): on Chromium, Firefox and Safari (where available) record with
  `mr.start(5000)`, append the slices, compare the bytes with a no-timeslice recording of the same
  length-class (decodable, same codec, duration within one slice), decode a truncated prefix, and
  record Safari's MP4 atom order (`moov` before or after `mdat`, D4). Record results in design
  D10/D4 (A10). If Safari's slices are not concatenable, D10's Safari branch is
  finished-chunks-only (owner informed).
  Evidence: spike 0.2 (2026-10-12), design A10 and the D10/D4 notes; Playwright 1.64 headless,
  fake mic, 25 s, timeslice and no-timeslice recorders on one stream; pinned ffmpeg `-xerror -f
  <demuxer> -i pipe:0 -f f32le`: Chromium 156 WebM concat 1198080 samples = no-timeslice 1198080,
  Firefox 157 Ogg (its default) 1218560 = 1218560, bytes differ (container metadata/serials only);
  first-3-slices prefix decodes (ffmpeg and `decodeAudioData`: 15.06 s / 14.793 s); Chromium
  `audio/mp4` is fragmented with `moov` before `moof/mdat`; an MP4 cut mid-fragment exits 183.
  **Pending owner check (Safari):** Playwright WebKit on Linux has no `MediaRecorder`, so Safari's
  concatenation, decode and atom order are unverified; the D10 Safari branch is decided by the
  owner's run of the spike `record.html` on a Mac.
- [x] 0.3 Spike (A): `createSyncAccessHandle` in a dedicated Worker, an IndexedDB `Blob` write,
  `navigator.locks.request(name, {ifAvailable: true})` across two tabs, and
  `navigator.wakeLock.request('screen')` on the same three browsers; `navigator.storage.estimate()`
  and `persist()` outcomes. Record in D10/D17 (A12).
  Evidence: spike 0.3 (2026-10-12), design A12 and the D10/D17 notes; Chromium 156, Firefox 157,
  WebKit 27.2 (proxy): worker `createSyncAccessHandle` round-trip 105000 bytes `bytesMatch: true`,
  IndexedDB `Blob` round-trip `match: true` (persistent profile, all three); second tab
  `ifAvailable` gets `null` (`contended: true`, all three); `wakeLock.request('screen')` denied
  headless on Chromium/WebKit (`NotAllowedError`), granted on Firefox; `persist()` false/false,
  Firefox unsettled after 5 s; ephemeral WebKit: `getDirectory()` `UnknownError` and IndexedDB
  `Blob` put fails. **Pending owner check (Safari):** the same `storage.html` in Safari, normal and
  Private window.
- [x] 0.4 Branch: while #107 is open, run gates with `--base supabase-11a-legacy-import`. After
  #107 merges, rebase `media-worker` onto `supabase-migration` so the branch carries only this
  change directory (the first commit must be the approved artifacts; re-verify `artifacts-first`),
  and reconcile the `transcript-generation` "Segment grouping" delta with #107's archived text.
  - 2026-10-14 (base moved, #107 still open): `supabase-migration` gained catalog search
    (`20261019000000`, ADR 0029) and show wiki (`20261021000000`-`20261022000000`, ADRs 0030,
    0031). Rebased onto #107; the migration is renumbered `20261023000000_media_jobs.sql` (it
    collided with `20261019000000_catalog_search.sql`), the ADR is renumbered 0032, the importer
    pin moves to `20261023000000`, and the schema and policy tests count both sides (49
    `catalog_user` policies). Content unchanged.
  Evidence: #107 merged (`4beb5a3e`); `git rebase --onto origin/supabase-migration 5e994021` ->
  28 commits, no conflicts, `a3c7c2af` (artifacts) first; PR base set to `supabase-migration`;
  `check-change.sh --base supabase-migration` -> `PASS change tier 2 (openspec/changes/media-worker)`,
  `PASS artifacts-first plan pinned before code`. Archive of #107 is PR #122; against its synced
  main specs, every MODIFIED requirement here is unchanged since `ac6420c4` except
  transcript-generation "Segment grouping and concatenation", whose delta already carries #107's
  FLAC text verbatim plus this change's missing-blob `502` (diff checked).

## S. Schema and storage

- [x] S.1 Test first: `server/src/test/pg/mediaSchema.pg.test.ts` (tables `media_jobs` with
  `input_bytes` and the `result_json` length check, `media_uploads`, `session_audio_seams` with
  its primary key, each with the D2/D7/D12 columns and the live-job unique partial index; the three
  new segment columns; RLS enabled; `catalog_system` all; `catalog_user` can insert/select
  `media_jobs` only for accessible sessions and cannot update; `media_uploads` user policy by
  access and creator; `session_audio_seams` user policy like the session tables); extend
  `catalogSchema.pg.test.ts` (`TABLES`, `KEY_COLUMN`) and `catalogPolicies.pg.test.ts` (policy
  count). Then write `supabase/migrations/20261023000000_media_jobs.sql` (header per the
  convention, rollback note). Also publish the TypeScript shapes `MediaJob`, `MediaUpload`,
  `MediaJobResult`, `AudioSeam` and the port interfaces `MediaJobsPort`, `MediaUploadsPort`,
  `AudioSeamsPort` in `packages/ports/src/media.ts` (**hand-off to B and W**; freeze the names in
  the first commit).
  Evidence: red `cd server && npx vitest run --project pg src/test/pg/mediaSchema.pg.test.ts` ->
  `Tests 8 failed (8)`, `relation "session_audio_seams" does not exist` (42P01); `catalogPolicies`
  red `expected [...] to have a length of 37 but got 41`; green (with `catalogSchema`,
  `catalogPolicies`) `Tests 70 passed (70)`. Ports in `packages/ports/src/media.ts` (imported as
  `@autologger/ports/media`; the barrel stays runtime-free), plus `MediaBlobStore` for S.6.
- [x] S.2 Test first: `server/src/test/pg/mediaRole.pg.test.ts` (role `autologger_media` exists
  `NOLOGIN` after the migrations alone and `LOGIN` after the runner's password phase, with the D1
  attributes; member of no role; `catalogRoles.pg.test.ts`'s
  membership rule still holds; as `autologger_media`: select `media_jobs` ok, update of the eight
  allowed columns ok, update of `kind`/`session_id`/`target`/`applied_at_ms` refused `42501`,
  insert/delete refused, select `session_audio_segments` and `session_audio_seams` ok, update
  refused, any other table refused, `set role catalog_system` refused; the guard trigger: `queued
  → running` ok when the lease is free or expired and refused when held, `running → done` ok as
  the holder and refused as another holder, `queued → applied` refused, a 300 KiB `result_json`
  refused by the check); `docker/supabase/test_migrate.sh` case for `MEDIA_DB_PASSWORD` (set,
  missing, malformed, never printed). Then the role, the grants, the trigger and the check in
  the migration and the password phase in `migrate.sh`.
  Evidence: red `npx vitest run --project pg src/test/pg/mediaRole.pg.test.ts` -> `Tests 8 failed
  | 1 passed (9)`, `password authentication failed for user "autologger_media"`; red `sh
  docker/supabase/test_migrate.sh` -> `FAIL MEDIA_DB_PASSWORD refused before connecting: unset`,
  `test_migrate: 41 passed, 14 failed`; green `test_migrate: 55 passed, 0 failed` and (with
  `catalogSchema`, `catalogRoles`, `catalogPolicies`, `mediaSchema`) `Tests 96 passed (96)`. The
  test harness (`test/pg/globalSetup.ts`, `testDb.ts`) now passes `MEDIA_DB_PASSWORD`. The
  trigger cannot authenticate a worker id (one shared role): it refuses any transition that
  changes `locked_by` outside a claim of a free or expired lease; identity is the statements'
  `locked_by = <id>` fence (S.3). A release may give the claim's attempt back.
- [x] S.3 Test first: `packages/storage/src/mediaJobs.pg.test.ts` (enqueue coalesces on the live
  unique index and records `input_bytes`; claim with two concurrent claimers hands out each job
  once; the lane filter `input_bytes <= max`; ordering by `run_after_ms` then creation; renew,
  finish and fail are fenced on `locked_by` and `status = 'running'` (a takeover makes them affect
  0 rows); fail with backoff `run_after_ms` and `failed` after `max_attempts`; requeue of expired
  `running`; delete of old terminal rows; `hasRecentTerminalMerge(session, ordinal, 24 h)`).
  Then `packages/storage/src/mediaJobs.ts` (API-side statements as `catalog_system`, plus the
  worker-side claim/renew/finish statements the worker imports from the same module).
  Evidence: red `cd packages/storage && npx vitest run --project pg src/mediaJobs.pg.test.ts` ->
  `Cannot find module './mediaJobs'`; green `Tests 14 passed (14)` (worker statements run as
  `autologger_media` through `postgresMediaSql`).
- [x] S.4 Test first: `packages/storage/src/mediaUploads.pg.test.ts` (create with the part hash
  list, record part, status, complete marks, expire sweep, per-user open count and staged bytes).
  Then `packages/storage/src/mediaUploads.ts`.
  Evidence: red `npx vitest run --project pg src/mediaUploads.pg.test.ts` -> `Cannot find module
  './mediaUploads'`; green `Tests 7 passed (7)`.
- [x] S.5 Test first: `packages/storage/src/audioSeams.pg.test.ts` (insert a window with its
  segment and `source_key`; `findWindow(session, ordinal, started_at)` returns the holding segment
  id and offset; `repoint(windows → merged segment, offsets)`; `windowsOf(session, ordinal)`;
  `23505` on a duplicate window). Then `packages/storage/src/audioSeams.ts`.
  Evidence: red `npx vitest run --project pg src/audioSeams.pg.test.ts` -> `Cannot find module
  './audioSeams'`; green `Tests 3 passed (3)`.
- [x] S.6 Test first: `packages/storage/src/blobStore.test.ts` additions (`ensureMediaDir` creates
  `media/` mode 1777; `adoptCopy(mediaRelPath, key)` opens `O_NOFOLLOW`, refuses a symlink, a
  directory, a FIFO and a file over the cap by the handle's `fstat`, copies into `.tmp/put-*`,
  fsyncs, renames, is idempotent when the key already exists, and removes the job directory
  containing a foreign-uid file (test with a second uid where available, else a mode-only
  check); `trash(key)` moves to `.trash/<date>/<key>`; `sweepTrash(7 d)` and
  `purgeTrashOldestFirst(bytes)`; `freeBytes()` by `statfs`; `openStaging(id, size)` preallocates
  `.tmp/upload-<id>`, `writePart` at offset while hashing, `rehashParts(id, partSize)`,
  `adoptStaging` renames; `list()` ignores `.trash` and `media`). Then `blobStore.ts`.
  Evidence: red `cd packages/storage && npx vitest run --project unit src/blobStore.test.ts` ->
  `Failed Tests 14`, `TypeError: s.ensureMediaDir is not a function`; green `Tests 31 passed
  (31)`; full `npx vitest run` in packages/storage `Tests 229 passed (229)`. Foreign uid: mode-only
  check (no second uid as non-root); spike 0.1 covers the cross-uid sequence.
- [x] S.7 Implementation panel fixes. (1) Blob modes: `put`, `adoptCopy`, `adoptStaging` (staged
  0600) and `trash` now leave 0644 files in 0755 directories whatever the umask, so the worker
  (uid 10001) can read parts uploads and trashed originals. (2) The guard trigger bounds a
  worker's values against the database clock: `locked_until_ms` ≤ now + 15 min, a changed
  `run_after_ms` ≤ now + 2 h, an attempt refunded only by a live lease's holder (`attempts > 0`);
  `media_jobs_error_code` checks `error` against the D2 codes (edited in place: unreleased).
  Evidence: red `cd packages/storage && npx vitest run --project unit src/blobStore.test.ts` ->
  `2 failed | 31 passed`, `audio/s1/put.webm: expected 384 to be 420` and the `docker run --user
  10001:10001 … cat` read failing; green `Tests 33 passed (33)`. Red `cd server && npx vitest run
  --project pg src/test/pg/mediaRole.pg.test.ts` -> `2 failed | 9 passed`, `expected 'ok' to be
  '42501'`, `expected 'ok' to be '23514'`; green (with mediaSchema, catalogSchema,
  catalogPolicies, catalogRoles, importLegacy) `Tests 107 passed (107)`; packages/storage `Tests
  231 passed (231)`; `test_migrate: 55 passed, 0 failed`; media-worker `Tests 109 passed (109)`.

## B. API, apply loop, session-core

- [x] B.1 Test first: `packages/contract/src/schemas.test.ts` for `audioUploadCreateBodySchema`
  (`content_type`, `size_bytes` 1..1500 MiB, `part_sha256` list length and 64-hex entries),
  `audioFinalizeBodySchema` (`chunks` 1..1000 timestamps) and `audioSegmentDictSchema` (the 12
  keys; `duration_ms`, `media_status`, `seams` nullable). Then `schemas.ts`.
  Evidence: (2026-10-12) red `cd packages/contract && npx vitest run src/schemas.media.test.ts`
  → `Tests 9 failed (9)`; green after `schemas.ts` → `Tests 9 passed`; full `npx vitest run` →
  `Tests 149 passed (149)`. Tests live in `schemas.media.test.ts`. Also `audioFinalizeResponseSchema`
  / `AudioFinalizeResponse` (`{ok: true, merge}`) for A's finalize call (hand-off), and
  `AUDIO_SEGMENT_DICT_KEYS`.
- [x] B.2 Test first: `packages/session-core/src/audioStore.test.ts`: `audioRowToMeta` carries
  `durationMs`, `mediaStatus`, `mediaError`, `seams` (joined from the seams port);
  `addAudioSegment` with a `recording_ordinal` first consults `findWindow` and returns the existing
  segment (chunk or merged) without writing, else writes the row with `media_status = 'pending'`,
  its seam row and an `ingest` job (with `input_bytes`) in the same transaction, and maps `23505`
  on the seam key to the existing-segment answer; `addImportedAudioSegment` and sync-from-disk
  enqueue per inserted row; `segmentsOfRecording(ordinal)`, `windowsHeld(ordinal)`. Then
  `audioStore.ts`, `SessionHub.ts` (`applyIngestResult`, `applyMergeResult` as system caller
  `media-apply` with the D7 input check, the run-lease deferral, the seam repoint, trashing by
  re-read `r2_key`s, revision bump and `audio.changed`; add `media-apply` and `media-reconcile` to
  the system-caller allowlist test).
  Evidence: (2026-10-12) red `cd packages/session-core && npx vitest run src/audioStore.test.ts` →
  `Tests 10 failed (10)`; green → `10 passed`; `npx vitest run` → `Tests 65 passed (65)`; hub over
  Postgres `cd server && npx vitest run --project integration src/test/session/audioMedia.int.test.ts`
  → `Tests 14 passed (14)` (seam + ingest job in one transaction, replay and a two-hub `23505` race
  answer the holder, finalize/straggler, ingest/FLAC/merge apply, lease deferral, invalid,
  cancelled + re-enqueue). Media ports are injected (`SessionHubRegistryOptions.media`, wired in
  `config.ts`; session-core cannot import storage). Meta fields are snake_case (`duration_ms`,
  `media_status`, `media_error`, `seams`) and optional in the type so older literals compile.
  `SessionCore.uncountedDb` (new getter) carries job enqueues and the finalize marker
  (`session_meta` `media_finalize:<ordinal>`) without a revision bump. Allowlist
  (`catalogSystem.repo.test.ts`): `media-apply` (mediaApply.ts, main.ts), `media-reconcile`,
  `media-sweep` (main.ts), `media-uploads` and `session-undo` (audioUploads.ts).
- [x] B.3 Test first: `server/src/routers/audio.test.ts` additions: `segmentApiDict` has 12 keys;
  the segment POST replays answer with the existing dict and store nothing (live chunk, merged
  seam, concurrent duplicate), and uploads without `recording_ordinal` are unchanged (pin
  `parseOptionalMarkedAt` normalisation as the window key; **hand-off to A**); `POST
  …/recordings/:recordingOrdinal/finalize` → `400` bad ordinal or bad `chunks`, `404` session,
  `200 {ok, merge}` with `not-needed` for one segment, `waiting` when a listed window is missing,
  `queued` then `already-queued`; a straggler's POST enqueues the waiting merge; regenerate
  `fixtures/api-responses/audioSegment{Create,sList}.json` (`npm run fixtures:capture -w server`)
  and the fixture int test. Then the routes.
  Evidence: (2026-10-12) red `cd server && npx vitest run --project unit src/routers/audio.test.ts`
  → `2 failed | 35 passed` (`segmentApiDict` not exported / 9 keys); green `37 passed`; routes
  `npx vitest run --project integration src/routers/audio.media.int.test.ts` → `Tests 8 passed`.
  Window fixture for A: `fixtures/audioWindowNormalisation.json` (outside `api-responses/`, which
  holds captures only), asserted against `parseOptionalMarkedAt`; finalize normalises each window the
  same way. Fixtures regenerated (`UPDATE_API_FIXTURES=1 … apiResponseFixtures.int.test.ts` →
  `48 passed`): `audioSegmentCreate`/`audioSegmentsList` are now **`.ts`** captures (the
  `media_status` literal union; the `.json` files are removed, so D's conformance imports must
  switch to the named `.ts` exports), plus `audioRecordingFinalize.ts`. B also edited
  `server/src/routers/transcribe.ts` (`missing_blob` → `502`; red `transcribe.test.ts` `2 failed`,
  green `6 passed`) and `sessions.ts` (pass `inputBytes`; export the local-audio-import helpers
  reused by the upload completion).
- [x] B.4 Test first: `server/src/routers/audioUploads.test.ts` (D12: create `201` with
  `part_size = 32 MiB`, `413` over 1500 MiB, `400` bad hash list, `429` third open upload or
  over 3 GiB staged, `507` below the free-disk floor (fake `freeBytes`); PUT part sizes, offsets,
  re-send, per-part hash mismatch `400` and not recorded, `404` after expiry/complete, `413` over
  part size, `507` low disk; GET status lists `received`; complete `409 {missing_parts}`, `400`
  on a re-hash mismatch aborts, import mode: `409` rolling with the post-put re-check, `200 {ok,
  segment_id}` anchors one take and appends seam parts; segment mode: one segment with the
  window, idempotent on replay, no anchor; DELETE `204`) and `audioUploads.int.test.ts` (the
  inventory walk: create → every part → complete on a real session answers `200 {ok, segment_id}`;
  the README endpoint rows are covered by the existing README inventory test, extended, or by a
  new `server/src/routers/readmeEndpoints.repo.test.ts` if none exists). Then
  `server/src/routers/audioUploads.ts`, mounted beside the audio router; README "Endpoints" rows
  for the five upload routes (finalize's row is B.3; **hand-off to D**: the route shapes are
  frozen here).
  Evidence: (2026-10-12) red `npx vitest run --project integration
  src/routers/audioUploads.int.test.ts` → `Tests 15 failed (15)` (routes absent); green `15 passed`;
  unit `audioUploads.test.ts` `3 passed`; README rows guarded by the new
  `server/src/routers/readmeEndpoints.repo.test.ts` (red `6 failed`, green `6 passed`). Mounted in
  `app.ts`; the blob store's media surface is `ports.mediaBlobs` (`appEnv.ts`). Captures:
  `audioUploadCreate.json`, `audioUploadStatus.json`, `audioUploadComplete.ts`. In
  `web/src/apiResponseShapes.repo.test.ts` only the exemption list changed: PUT part and DELETE
  (`204`) and the OPFS manifest `JSON.parse` added, the stale AudioRecorder waveform PUT removed;
  create/status/complete and finalize stay flagged until D adds their conformance assignments.
- [x] B.5 Test first: `server/src/mediaApply.test.ts` (fake ports: a `done` ingest job updates
  peaks/duration/status and marks `applied`; a FLAC result copies the blob by handle, swaps
  key/mime and trashes the WAV; an ingest whose target row is gone → `cancelled`; a `done`
  merge job with matching inputs copies the merged file under the job-derived key, inserts one
  row `done` with the merge's peaks and `duration_ms` and enqueues no ingest job for it, repoints
  seams, deletes inputs, trashes the blobs named by the re-read rows (a result
  naming other keys changes nothing else), broadcasts once, marks `applied`; mismatched inputs →
  `cancelled`, the worker directory removed, new merge enqueued; a held `transcript-generation`
  or `youtube-import` lease leaves the job `done` and untouched; a result with a bad key, bad
  peaks, a symlink or an oversize file is refused and the job marked `failed` `invalid-result`; a
  `failed` job sets `media_status 'failed'`/`media_error`; the loop is idempotent across a crash
  between the copy and the commit). Then `server/src/mediaApply.ts`, wired in `main.ts` with
  the 10 s timer and the `media_jobs_done` listener; `startupPurge.ts` gains the merge reconcile
  (D6: 30 min, only `media_status is not null` recordings, none with a terminal merge younger
  than 24 h), `sweepTrash` with the low-disk purge and transition logs, upload expiry, old-job
  deletion and the `pg_notification_queue_usage()` warning; `config.ts` calls `ensureMediaDir`.
  Evidence: (2026-10-12) `mediaApply.ts` was written before its tests (no red run recorded);
  `npx vitest run --project unit src/mediaApply.test.ts` → `6 passed`; `--project integration
  src/mediaApply.int.test.ts` → `10 passed` (ingest, FLAC copy + trash, cancelled target, invalid
  key/peaks/symlink → `invalid-result` and segment `failed`, worker failure, merge swap, crash
  idempotency, inputs changed → cancelled + new merge, lease deferral, foreign key);
  `startupPurge.media.test.ts` → `5 passed`, `startupPurge.media.int.test.ts` → `3 passed`. The
  reconcile also requires a seam per segment, so a legacy recording given a status by the backfill
  is still never auto-merged. Deviation: the `media_jobs_done` LISTEN is not wired (the server has
  no `postgres` dependency of its own; adding one touches the lockfile); `startMediaApply` exposes
  `wake()` and polls every 10 s.
- [x] B.6 Test first: `server/src/test/enqueueMediaJobs.test.ts` (selects rows with null peaks,
  null duration or WAV mime; `--merge` selects multi-chunk recordings, legacy `NULL` status
  included, and is the only path that does; emits guarded `INSERT … ON CONFLICT DO NOTHING` SQL;
  never prints values). Then `server/scripts/enqueueMediaJobs.ts`; README: "Storage map"
  (`media/`, `.trash/<date>/`, `.tmp/upload-*`), "Media jobs" runbook (enqueue, watch the queue,
  failed jobs, trash restore, low-disk mode) and a pointer from the two legacy script sections.
  Evidence: (2026-10-12) red `npx vitest run --project unit src/test/enqueueMediaJobs.test.ts` →
  `Cannot find module '../../scripts/enqueueMediaJobs'`; green `4 passed`; over Postgres
  `src/test/enqueueMediaJobs.int.test.ts` → `1 passed`. Set-based SQL (no values printed), jobs in
  the big lane (`input_bytes` = 1500 MiB). README: "Storage map", new "Media jobs" (under
  "Container deployment"), pointers in the two legacy sections, and the "Endpoints" rows.
- [x] B.7 Suites: `cd server && npx vitest run --project unit`, `--project integration`,
  `--project pg`; `npm run typecheck`.
  Evidence: (2026-10-12, after B.9) unit `Tests 603 passed | 5 skipped`; integration `Test Files
  105 passed, Tests 1456 passed` (incl. `sessionHub.interleave.int.test.ts` unchanged); pg `Test
  Files 19 passed | 1 skipped, Tests 157 passed | 1 skipped`; session-core `65 passed`; contract
  `149 passed`; `npm run typecheck` clean.
- [x] B.8 Design note (coordinator decision 2026-10-12; closes panel C minor 7): **the blob is
  written before its row on every create path**: segment POST and the upload's segment mode
  (`storeLiveSegment`: held window → answer, no write; else `planAudioSegment` → put/adopt under the
  final key → row + seam + ingest job in one transaction; a lost `23505` race or a failed insert
  deletes the just-written blob), local-audio-import, YouTube import and the upload's import mode
  (`addImportedAfterBlob`), and `mediaApply`'s merged/FLAC rows (already copy-first). A listed row
  therefore always has its bytes, so D's `missing_blob` → `502` stays a true error. The
  `session-undo` row undo on a failed put is gone from `audio.ts` and `audioUploads.ts` (allowlist
  entries removed); `catalogPolicies.int.test.ts`'s undo case is rewritten (a revoke between blob
  and row → `404`, no row, no blob; a failed put → no row). Crash residue: at boot
  `trashOrphanBlobsOnce` moves to the trash (never deletes) any `audio/` blob older than 1 h that no
  row names, except a pending merge's copy. Caveat: a blob restored from the trash keeps its old
  mtime, so run `sync-from-disk` before the next API restart.
  Evidence: red `npx vitest run --project integration src/routers/segmentOrdering.int.test.ts` →
  `Tests 3 failed (3)` (a row named the key when the blob was written); green `3 passed`;
  `startupPurge.media.int.test.ts` (orphan case added) `4 passed`.

- [x] B.9 Implementation panel fixes (2026-10-12). (1) **Major, security:** the merge apply
  checks the result's seams in its transaction: the window set must equal exactly the inputs' held
  windows plus the `started_at_utc` of seamless input rows (an input row without a window fails it),
  offsets lie in `[0, duration_ms]` and strictly increase in window order, and `ended_at_utc` /
  `source_key` come from the seam or input rows, never the result; otherwise `invalid-result`.
  (2) **Major, integrity:** `mediaApply` cancels only on `SessionNotFoundError` (or an invalid
  session id); any other lookup error propagates and the job stays `done`; `main.ts` stops the loop
  and awaits an in-flight pass (`idle()`) before closing. (3) Minor: a failed job's `error` reaches
  `media_error` only as a fixed code, else `internal` (`mediaErrorCodeOf`). (4) Minor:
  `enqueueMediaJobs.ts --merge` leaves out recordings with a row lacking `started_at_utc`.
  (5) Minor: a merge that failed `mixed-codecs`/`interleaved-input` records its input set in
  `session_meta` (`media_merge_blocked:<ordinal>`, written by the apply loop's failed-job pass), and
  the reconcile skips the recording while its segments are exactly that set, however old the
  failure and after the job row is swept; a new or removed segment lifts it.
  Evidence: red `npx vitest run --project integration src/test/session/audioMedia.int.test.ts` →
  `3 failed | 14 passed` (forged window, offsets, DB-sourced seams); green `17 passed`.
  `src/mediaApply.int.test.ts` red `1 failed` (transient lookup cancelled the job), green
  `11 passed`; unit `src/mediaApply.test.ts` red `1 failed` (`mediaErrorCodeOf`), then `1 failed`
  (shutdown order), green `8 passed`. `src/test/enqueueMediaJobs.int.test.ts` red `expected ['1',
  '3'] to deeply equal ['1']`, green `1 passed`. `src/startupPurge.media.int.test.ts` red `1 failed`
  (deterministic block), green `6 passed`. Suites: unit `603 passed | 5 skipped`; integration
  `Test Files 105 passed, Tests 1456 passed`; pg `157 passed | 1 skipped`; session-core `65
  passed`; `npm run typecheck` clean.
## W. Worker and infra

- [x] W.1 Test first: `media-worker/src/ffmpeg.test.ts` (the sniffer maps EBML/OggS/ftyp/RIFF
  WAVE/fLaC/MP3 sync/ID3 to the forced demuxer and refuses anything else; the MP4 atom scan tells
  `moov`-first from `moov`-last; argv assembly has `-nostdin`, `-xerror`, `-protocol_whitelist
  pipe`, `-f <forced>`, `-i pipe:0`, no shell, and for a `moov`-last MP4 only `-protocol_whitelist
  file -f mov -i file:<path>`; the input is opened `O_NOFOLLOW` and refused when a symlink, not a
  regular file, or outside `/blobs/audio` and `/blobs/.trash`; an HLS playlist and an ffconcat
  file are refused by the sniff; timeout kills with `SIGKILL`; stderr classification to the D2
  codes) and `media-worker/src/peaks.test.ts` (streaming f32 pipe → `DbPeaksAccumulator`, bucket
  rule, duration from frames). Then `src/ffmpeg.ts`, `src/sniff.ts`, `src/peaks.ts`. Scaffold the
  workspace (`package.json`, `tsconfig`, vitest config, root `package.json` scripts, the
  package-architecture repo test's app list).
  Evidence: red `cd media-worker && npx vitest run` -> `Cannot find module './ffmpeg'`, `Cannot
  find module './peaks'`, `Test Files 2 failed`; green `Tests 50 passed (50)`. Added while W.2
  found ffmpeg exits 0 under `-xerror` when its parser drops a corrupt Opus packet: red `× exit 0
  with an error line on stderr is a failure`, green after `runFfmpeg` counts error-level stderr
  lines (only "File ended prematurely" and the repeat counter are benign). App list: red `cd
  server && npx vitest run --project unit src/packageBoundaries.repo.test.ts` -> `× DOES flag a
  bare specifier naming the media-worker app`, `1 failed | 84 passed`; green `85 passed`. Root
  `package.json` workspaces/test/typecheck/lint gain `media-worker`; `biome.json` includes
  `media-worker/src/**/*.ts` (else the root lint skips it).
- [x] W.2 Test first: `media-worker/src/jobs/ingest.test.ts` and `ingest.ffmpeg.test.ts`
  (generated WAV fixtures from `server/src/test/waveformFixtures.ts` pattern: s16 WAV → FLAC
  written under `media/<job>/`, verify by md5/count/STREAMINFO; f32 WAV → no FLAC; WebM/FLAC
  fixtures → duration and peaks; a junk file → `decode-failed`; a truncated Opus stream →
  `decode-failed` under `-xerror`; an unreadable file → `missing-blob`; `low-disk` requeue when
  `freeBytes < 2 × input_bytes` (fake `statfs`); an MP4 fixture carrying a `dref` external data
  reference (`packages/transcription/fixtures/audio/seg-aac-dref.m4a`, new) decodes only its own
  samples and opens no other file (the referenced path is a sentinel whose absence of reads is
  asserted); results never contain paths outside `media/<job>/`). Then `src/jobs/ingest.ts`, `src/verify.ts` (port `#107`'s
  `verifyPair`/`pcmDigest` logic; do not import `server/scripts`).
  Evidence: red `npx vitest run src/jobs` -> `Cannot find module '../verify'`, `Cannot find module
  './ingest'`; first run of the impl: `× a corrupted Opus stream fails decode-failed under -xerror`
  (`expected { kind: 'done' }`: the pinned ffmpeg logs "Error parsing Opus packet header" and exits
  0); green after the stderr rule: `Test Files 4 passed, Tests 70 passed`. The dref fixture
  `packages/transcription/fixtures/audio/seg-aac-dref.m4a` (moov-last, second track with an `alis`
  reference to `sentinel.m4a`) is built by `media-worker/src/test/drefFixture.ts`; the test's FIFO
  sentinel is never opened, and the positive control (`-enable_drefs 1`) does open it.
- [x] W.3 Test first: `media-worker/src/jobs/merge.test.ts` and `merge.ffmpeg.test.ts` (two Opus
  WebM chunks → one WebM with untrimmed `merged_samples` exactly `Σ untrimmed inputs` (edited
  after approval, design D7; was `Σ raw + pre_skip₂`), seams `offset_ms` at the inputs' untrimmed
  cumulative positions with `source_key`s, peaks over the merged file; Ogg +
  WebM Opus → WebM; two AAC m4a → MP4 verified with `-ignore_editlist 1` on both sides, exact;
  FLAC → FLAC; PCM WAVs → FLAC; mixed Opus+AAC → `mixed-codecs` without output; a `skipped`
  input or two groups → failure without output; a corrupt second chunk → `decode-failed`; a
  merged input with seams plus a later chunk → seams concatenated; a late chunk whose window
  lies between two seams → rebuilt from the originals under `.trash/` (fixture copies), or
  `interleaved-input` when an original is missing; `low-disk` requeue when `freeBytes <
  2 × input_bytes`). Then `src/jobs/merge.ts` using `mergeAudioSegments`/`probeSegment` from
  `@autologger/transcription`.
  Evidence: red `npx vitest run src/jobs/merge` -> `Cannot find module './merge'`; first impl:
  every family `verify-mismatch` (debug: Opus `merged 49608, Σ raw + pre_skip₂ 48312`): the inputs
  carry end padding (WebM DiscardPadding 648, Ogg end granule) that packet copy cannot keep, and
  the merged MP4 carries a 614-sample skip. **Deviation from D7's formula**: verification decodes
  both sides untrimmed (`-flags2 +skip_manual`, plus `-ignore_editlist 1` for AAC) and requires
  `merged == Σ untrimmed inputs` exactly (Opus 29760 + 20160 = 49920; AAC 117760 + 131072 =
  248832); seam offsets are `Σ_{j<i} untrimmed_j + skip_i − skip_merged` (the merged stream's own
  pre-skip). Green: `Test Files 7 passed, Tests 102 passed` (whole workspace).
- [x] W.4 Test first: `media-worker/src/main.test.ts` (fake db: two lanes with the 64 MiB
  filter; below `MEDIA_MIN_FREE_BYTES` (fake `statfs`) no `merge` job and no job with
  `input_bytes × 2 > free` is claimed, and claiming resumes when space returns; claim → run →
  finish; renew every 60 s during a long job; finish/fail fenced (a 0-row
  update drops the result and logs); a thrown job → backoff and `queued`; `max_attempts` →
  `failed`; LISTEN wake-up; heartbeat file touched each loop; SIGTERM finishes the current jobs
  within the lock window or releases them). Then `src/main.ts`, `src/db.ts` (statements from
  `packages/storage/src/mediaJobs.ts`).
  Evidence: red `npx vitest run src/main.test.ts` -> `Cannot find module './main'`; green `Tests 14
  passed (14)`; `npx tsc --noEmit` (media-worker) rc 0.
- [x] W.5 Test first: `server/src/test/ffmpegPin.repo.test.ts` (reads `ARG FFMPEG_IMAGE=` from
  `docker/media-worker.Dockerfile` and asserts it equals `blobSegmentRows.ts`'s `FFMPEG_IMAGE`
  and carries a `# reviewed YYYY-MM-DD` comment; red while the Dockerfile has no ARG) and
  `docker/scripts/test_media_image.sh` (builds the native image, lists its filesystem: `ffmpeg`
  and `node` present; no `server/src`, `web`, `claude`, `yt-dlp`, `deno`, `.env` other than
  `.env.example`; the entrypoint's uid is 10001; skips without docker). Then
  `docker/media-worker.Dockerfile` per 0.1 with `ARG FFMPEG_IMAGE=… # reviewed 2026-10-11`,
  `.dockerignore` coverage, `docker-bake.hcl` target `media-worker` in group `default`;
  `.github/dependabot.yml` gains the `docker` ecosystem for `/docker`; `make prod-build` loads
  it; a `docker run --rm --network none … node -e` smoke in the README build section. Evidence:
  both tests green, the bake `--print`, and `docker image inspect` showing both platforms after a
  push to a scratch tag (or the local-load manifest).
  Evidence: the spike already landed the ARG, so the pin test was first run against a mutation
  (review comment removed, tag changed): `2 failed | 3 passed`; green `5 passed`. Red `sh
  docker/scripts/test_media_image.sh` -> `ERROR: could not find any target matching
  'media-worker'`; green `test_media_image: 26 passed, 0 failed` (arm64: ffmpeg/node present, no
  server/web/claude/yt-dlp/deno/tests/fixtures/.env, uid 10001, entrypoint the worker, hardened
  decode of seg1.webm = 115200 bytes, refusal without env rc 2, EROFS, healthcheck on the
  heartbeat, clean SIGTERM), `image size: 606 MB (linux/arm64)`. `GIT_SHA=abc123def456 docker
  buildx bake -f docker-bake.hcl --print` -> group default `['api', 'media-worker', 'web']`,
  media-worker `platforms ['linux/amd64', 'linux/arm64']`, tag
  `ghcr.io/kwcantrell/autologger-media-worker:abc123def456`; `docker buildx bake --builder
  autologger-multi media-worker` (both platforms) rc 0; amd64 loaded under QEMU: `v22.23.3 x64
  10001`, decode 115200, refusal rc 2, 944 MB. `.dockerignore` already covers the worker (tests,
  `src/test`, fixtures); no change. `make prod-build` and the README smoke are in W.6/W.7.
- [x] W.6 Test first: `docker/scripts/compose-run.test.mjs` (`MEDIA_DB_PASSWORD` scope per env,
  format, `MEDIA_TAG` required and not `latest` in prod, stage pull list `web api media-worker`,
  `STAGE_MEDIA_IMAGE` derived and refused as a secret, `checkStageResolved` covers the third
  image); `supabase-keys.test.mjs` (`MEDIA_DB_PASSWORD` generated, kept, never printed);
  `docker/scripts/test_check_envs.sh` (a third member of `media`, `media-worker` on another
  network, `db` missing `media`, a published worker port, a root, app-uid or writable worker, a
  worker mounting `/data`, the password in another service, the dev service set without
  `media-worker`, a worker environment with any name beyond the five `PG*` literals and
  `BLOB_DIR`: each caught). Then the compose files (service in dev, stage, prod with the D4
  posture; network `media` with the D1 subnets; `db` joins `media`), `compose-run.mjs`,
  `supabase-keys.mjs`, `check-envs.sh`, `compose-env.sh`, `Makefile` (`STAGE_UP_STEPS` pull
  list). Evidence: `check-envs.sh dev|stage|prod` clean; `make dev-up` shows the worker healthy
  and `docker exec` into it finds no `APP_DB_PASSWORD`, `POSTGRES_PASSWORD`, `FRAME_BUS_SECRET` or
  `PROVIDER_KEYS_SECRET`, and `getent hosts example.com` fails.
  Evidence: red `node --test docker/scripts/compose-run.test.mjs` -> `tests 87, pass 62, fail 24`;
  `supabase-keys.test.mjs` -> `tests 17, pass 11, fail 6`; `sh docker/scripts/test_check_envs.sh`
  -> `60 passed, 28 failed` ("FAIL a root worker is caught"). Green: both node suites `tests 103,
  pass 103, fail 0`; `test_check_envs: 88 passed, 0 failed`; `check-envs.sh dev|stage|prod` ->
  `check-envs: ok`. Three old mutations that deleted every `/blobs` line now touch only the app's,
  and two anchors follow `db`'s `[db, catalog, media]`. `prod-build` loads the whole default bake
  group, so it needs no change. Prod is `compose.yaml` (in this list). **Not run:** `make dev-up`
  (no running stack is touched here); the in-container env/DNS checks are covered by
  `test_media_image.sh` (network none, refusal, EROFS) and remain for V.2 on dev.
- [x] W.7 Docs: README "Topology" diagram and text (fourth service, `media` network, the
  permissions posture, the copy-by-handle adopt), "Build, push, and pin images" (`MEDIA_TAG`, the
  ffmpeg pin and its review date), "Volumes" (the worker's mount and the ownership posture only;
  the `media/`, `.trash/` and staging layout and low-disk mode are B.6's "Storage map" and "Media
  jobs" text, linked from here), "Dev, stage and prod compared"; `docs/openbao-secrets.md`
  (`MEDIA_DB_PASSWORD` must exist before the
  migration runs, `MEDIA_TAG`); `docs/security.md` (untrusted media row: pipe-fed ffmpeg, forced
  demuxer, `-xerror`, handle-checked copy, column grants and the guard trigger; residuals: a
  decoder exploit's read of every blob, the worker login's `LISTEN`/`NOTIFY` on the frame bus
  and its monitoring). Evidence: files; no test.
  Done: README "Topology", "Build, push, and pin images", "Volumes", "Dev, stage and prod
  compared"; `docs/openbao-secrets.md` (`MEDIA_DB_PASSWORD` in every `kv/autologger/*` and
  `kv/autologger-import/dev` before the migration, `MEDIA_TAG`); `docs/security.md` "Untrusted
  media in the worker". Outside W's list, still needing `MEDIA_TAG`/role rows: README
  "Configuration", `docker/.env.example`, `docker/scripts/make-guards.sh` `prod-tags` (legacy),
  `docs/supabase.md` role table. (Consistency read 2026-10-12: all four now carry `MEDIA_TAG` /
  the `autologger_media` row: `docker/.env.example:9`, `make-guards.sh:185`, `docs/supabase.md:53`.)

- [x] W.8 Implementation panel fixes (coordinator, 2026-10-12). (a) MAJOR: a lost lease no longer
  deletes the re-claimer's output: each attempt writes `converted-a<attempt>.flac` /
  `merged-a<attempt>.<ext>` with its mergeAudioSegments scratch in `media/<job>/a<attempt>.tmp/`;
  `makeJobDir` never removes (mkdir, EEXIST ok, 0777); every cleanup (failure, release, lost
  lease, shutdown) is `removeAttemptFiles(job, attempt)` and leaves the shared directory to the
  API's sweep. (b) AAC seam offsets use each input's priming (`-ignore_editlist 1` decode minus
  played) and the merged file's, design D7 amended. (c) `db.ts` keeps a NULL `started_at_utc` as
  null; a merge whose rows include one fails `interleaved-input`, final (its inputs cannot be put
  in wall-clock order; rows untouched).
  Evidence: red `cd media-worker && npx vitest run` -> `Tests 13 failed | 96 passed (109)`, e.g.
  `× a lost lease never deletes the re-claimer’s output (interleaving across an expired lease)`
  (`ENOENT … media/jx`: the shared directory was removed), `× AAC inputs with encoder priming`
  (`expected 514 to be 557`: seam 2 early by 43 ms), `× a NULL started_at_utc stays null`,
  `× a legacy row with started_at_utc NULL … interleaved-input`, `× attemptName …`; green `Test
  Files 9 passed, Tests 109 passed`; `npx tsc --noEmit` rc 0; biome clean.

## A. Web recorder: persistence, locks, retry, finalize, microphone, wake lock

- [x] A.1 Test first: `web/src/pages/index/utils/chunkStore/chunkStore.test.ts` with fakes
  `web/src/test/fakes/{opfs,idb}.ts` (open/append/finalize/read round-trips bytes; manifest
  fields including `userId`, `bytes`, `sliceLog`, `pendingFinalize` windows; per-user directories:
  `list(userId)` returns only that user's chunks, `wipe(userId)` removes only theirs; finalized
  and partial chunks listed with metadata; `remove`; backend selection OPFS → IDB → memory; quota
  short → memory with one warning; 30-day orphan cleanup; Safari copy flag). Then
  `chunkStore/{index,opfsBackend,opfsWorker,idbBackend,memoryBackend}.ts`.
  Evidence: `cd web && npx vitest run src/pages/index/utils/chunkStore/chunkStore.test.ts`: red
  `Failed to resolve import "./idbBackend"`, `Tests no tests`; green `Tests 31 passed (31)` (each
  of opfs/idb/memory round-trips, per-user list/wipe, finalize records, 30-day cleanup with one
  warning; OPFS `UnknownError` → idb, both failing → memory with one `onDegraded`; quota short and
  `QuotaExceededError` → chunk moves to memory with its persisted prefix; partial read cut at the
  slice log). Backend choice is a real write probe (3 s timeout), per spike 0.3.
- [x] A.2 Test first: `web/src/pages/index/utils/recorderLocks.test.ts` with
  `web/src/test/fakes/locks.ts` (take lock held for the take, chunk lock per attempt, `scan`
  skips held chunk and take locks with `ifAvailable`, the heartbeat-lease fallback when
  `navigator.locks` is absent: fresh lease skipped, 30 s-stale lease recovered). Then
  `recorderLocks.ts`.
  Evidence: `cd web && npx vitest run src/pages/index/utils/recorderLocks.test.ts`: red `Cannot
  find module './recorderLocks'`; green `Tests 10 passed (10)` (take lock held/released, chunk
  lock per attempt, second tab refused, scan skips held take/chunk locks and leaves nothing held,
  heartbeat fallback 30 s, a throwing lock manager degrades to the heartbeat rule).
- [x] A.3 Test first: `web/src/pages/index/utils/uploadBackoff.test.ts` (schedule 2 s → 5 min
  cap, jitter bounds, reset) and `chunkUploadQueue.test.ts` additions (a scheduler tick pumps a
  due transient chunk without a rollover; `offline` suspends and does not count attempts;
  `online` pumps now; `401`/`403` → `blocked`, not auto-retried; `413` → re-sent through the
  parts client in segment mode (fake) and confirmed; Retry re-attempts `blocked` and `permanent`
  once; recovered chunks enqueue in capture order, start `ambiguous`, dedupe by
  `(recording_ordinal, started_at_utc)` with the server's normalisation (fixture from B.3) and
  treat the server's existing-segment answer as confirmed; a partial chunk's `ended_at_utc` is
  start plus the measured duration (probe, else slice-log rate), not the manifest time; the scan
  skips locked chunks; `pendingFinalize` → `POST …/finalize` with the window list after the last
  chunk of an ordinal confirms, once, `waiting` counted as done, and a failed finalize call
  retried on the backoff until it succeeds or the remainder is discarded; removal from the store on
  confirm/dedupe/discard; the banner's fallback deps are gone and the queue is created with real
  deps by a provider). Then `chunkUploadQueue.ts` (store-backed chunks, `nextAttemptAt`,
  `blocked`, the parts fallback), `uploadBackoff.ts`, `workerInterval.ts` (a one-shot or tick
  helper if needed).
  Evidence: `cd web && npx vitest run src/pages/index/utils/uploadBackoff.test.ts`: red `Cannot
  find module './uploadBackoff'`, green `Tests 4 passed (4)`; `npx vitest run
  src/pages/index/utils/chunkUploadQueue.test.ts`: red `Tests 32 failed | 28 passed (60)`, green
  `Tests 60 passed (60)` (tick pumps a due chunk, 2/4/8 s, offline counts nothing and `online`
  pumps both in order, 401/403 `blocked`, 413 → `uploadSegmentInParts` (D.3) and parts again on a
  transient retry, `retryAll`/`retryChunk` reach blocked/permanent once, dedupe normalised like
  `parseOptionalMarkedAt` incl. seams (local fixture until B.3's), recovery in capture order and
  ambiguous-first, partial `ended_at_utc` from probe else slice-log rate, existing-segment answer
  confirmed, store removal before the next attempt, finalize once after the last confirm /
  `waiting` done / backoff retry / window dropped on discard / recovered and persisted finalize,
  `getChunkUploadQueue()` needs no deps; the 401/403 expectation of the old classification test
  changed to `blocked`).
- [x] A.4 Test first: `web/src/pages/index/utils/micReacquire.test.ts` (track `ended` → persist
  the open chunk, `getUserMedia` with the previous `deviceId`, then default, retried on the
  backoff up to 60 s; success → next chunk index on the new stream, same take; failure for 60 s →
  finalize with the reason; `devicechange` with a live track → log only; a rollover boundary with
  no live track waits) and `wakeLock.test.ts` with `web/src/test/fakes/wakeLock.ts` (held while
  recording, released on stop, re-requested on `visibilitychange` to visible, absence logged
  once). Then `micReacquire.ts`, `wakeLock.ts`.
  Evidence: `cd web && npx vitest run src/pages/index/utils/wakeLock.test.ts
  src/pages/index/utils/micReacquire.test.ts`: red `Cannot find module './micReacquire'` / `'./wakeLock'`;
  green `Tests 16 passed (16)` (previous device then default, 2/4/8 s retries, gives up at 60 s
  with the reason, dead stream not a success, cancel; `ended`/`devicechange` handling; rollover
  waits; wake lock held/released/re-requested on visible, absence and `NotAllowedError` logged once).
- [x] A.5 Test first: `AudioRecorder.chunks.test.tsx` additions (`mr.start(5000)`; each
  `dataavailable` appended to the store; the take lock held from start to finalize; rollover and
  heartbeat use `createWorkerInterval`; `pagehide` calls `requestData()` and the beacon; no
  waveform decode/PUT after upload; `navigator.storage.persist()` requested at start; Record
  disabled until the recovery scan resolves and a recording that starts with recovered chunks of
  ordinal 3 queued uses ordinal 4; the unexpected-stop path goes through `micReacquire`; the
  wake lock is held while recording; hidden → visible shows the `HiddenTabWarning` with the
  interval and clears on the next user action). Then `AudioRecorder.tsx`,
  `HiddenTabWarning.tsx`.
  Evidence: `cd web && npx vitest run src/pages/index/components/AudioRecorder.chunks.test.tsx`
  against HEAD's `AudioRecorder.tsx`: red `Tests 13 failed | 35 passed (48)`; with the new
  recorder green `Tests 48 passed (48)`; `AudioRecorder.meter.test.tsx` `Tests 3 passed (3)`.
  (The recorder was written before these cases; the red run swapped HEAD's file back in.) Spec
  changes replaced three old cases: waveform PUT → none, unexpected stop / dead stream at a
  rollover → re-acquire. Record refusal is phase `scanning` (toggle returns false with a toast);
  the button's visual disabled state lives in files A does not own.
- [x] A.6 Test first: `ChunkRescueBanner.test.tsx` additions (recovered group header with count
  and minutes, Safari 7-day note when applicable; Upload all; `blocked` row text names sign-in;
  Retry on a `permanent` row attempts once; partial chunk labelled; Discard confirms with the
  amount) and the sign-out hook test (unsent chunks → a confirm naming them; confirmed → the
  user's storage wiped; none → silent). Then `ChunkRescueBanner.tsx`, `chunkLeaveWarning.ts`
  (unchanged semantics: armed while the queue is non-empty; recovered chunks count), the sign-out
  call site.
  Evidence: `cd web && npx vitest run src/pages/index/components/ChunkRescueBanner.test.tsx
  src/pages/index/utils/chunkLeaveWarning.test.tsx`: red `Tests 11 failed | 18 passed (29)`
  (`guardSignOut is not a function`, recovered-group cases); green `Tests 29 passed (29)`;
  `AccountSection.test.tsx` `Tests 8 passed (8)`. No `useAuth*` hook exists and `api/` may not
  import `pages/`, so the guard is `useChunkSignOutGuard` in `chunkLeaveWarning.ts`, called once
  from `settings/AccountSection.tsx`'s sign-out link.
- [x] A.8 Implementation panel fixes (review of workstream A, 2026-10-12), test-first:
  (1) the chunk store never throws on an unknown handle and the recorder's onstop never rejects
  (a refused slice keeps it and later ones in memory, a refused finalize uploads an in-memory copy;
  a duplicate onstop is ignored); (2) the queue holds a chunk's Web Lock for its whole stay
  (`holdChunk`; recovery holds it too) and the take lock is released only after that, and bytes
  that vanished are checked against the segments list before being parked; (3) every OPFS call
  times out (10 s) and marks the worker dead, so the chunk degrades to memory; (4) degrading keeps
  the persisted prefix on disk and only puts new slices in memory; (5) unmount during a mic
  re-acquisition ends the take, so no recorder starts afterwards; (6) `chunkSettled` is chained,
  so finalize lists every window and follows every enqueue; (7) the queue uploads, the banner
  shows and sign-out counts/discards only the signed-in user's chunks; (8) a 401/403 on the dedupe
  lookup is `blocked`; (9) Record waits at most 10 s for the profile and scan, and a failed profile
  allows recording; (10) the 413 fallback resumes one remembered parts upload per chunk and maps
  `PartsUploadError` to statuses (non-resumable = terminal 400); (11) a probe timeout disposes the
  backend (terminates the worker).
  Evidence: red: `npx vitest run src/pages/index/utils/chunkStore/chunkStore.test.ts`
  `Tests 5 failed | 29 passed (34)`; `…/chunkUploadQueue.test.ts` `Tests 10 failed` (`q.whenOwned
  is not a function`, `'queued' to be 'blocked'`, `uploadChunkViaParts is not a function`);
  `…/recorderLocks.test.ts` `Tests 2 failed | 10 passed (12)`;
  `…/AudioRecorder.chunks.test.tsx` `Tests 7 failed | 50 passed (57)`, `Errors 3 errors` (the
  unhandled `chunkStore: unknown handle`), plus the finalize-order case `expected 1 to be greater
  than 2`; `ChunkRescueBanner.test.tsx` + `chunkLeaveWarning.test.tsx` `Tests 2 failed | 29
  passed (31)`. Green: store `34 passed`, queue `71 passed`, locks `12 passed`, recorder `57
  passed`, banner + sign-out `31 passed`; `cd web && npx vitest run` `Test Files 160 passed
  (160)`, `Tests 2162 passed (2162)`, no unhandled errors; `npx tsc --noEmit -p .` no errors;
  `npx biome check --error-on-warnings` clean on A's files.
- [x] A.9 Stop with a chunk still retrying is not an error (owner's VM test, 2026-10-12: a 4-chunk
  Chrome take showed "Some recorded audio failed to upload" for a moment though all 4 chunks
  arrived). Stop still attempts every pending chunk at once (explicit pumps ignore `nextAttemptAt`;
  the first awaits the in-flight attempt), but only a terminal failure (blocked, permanent) shows
  the error toast; a chunk left on its backoff keeps Record blocked (`drain_blocked`) and the rescue
  surface reads as a neutral `role="status"` "Uploading N recorded audio chunk(s)… retrying"
  with its actions, until the tick uploads it and the recorder goes idle. Development builds
  `console.warn` each failed attempt's class and HTTP status (queue `debug` dep; ids, never bytes).
  Evidence: red `npx vitest run src/pages/index/components/AudioRecorder.chunks.test.tsx
  src/pages/index/utils/chunkUploadQueue.test.ts src/pages/index/components/ChunkRescueBanner.test.tsx`
  `Tests 4 failed | 154 passed (158)` (503 and network at Stop raised the toast; no `debug`; no
  neutral status); green `Tests 158 passed (158)` (permanent 404/400 still toasts; the old
  drain-failure test now uses 404, and banner tests that meant "failed" use a permanent status);
  `cd web && npx vitest run` `Test Files 161 passed (161)`, `Tests 2172 passed (2172)`, no
  unhandled errors; `npx tsc --noEmit -p .` clean; biome clean on the touched files.
- [x] A.10 No self-contention on a chunk's own lock (owner's VM: the rescue banner flashed at every
  rollover). `own()` started `holdChunk` without awaiting, so the rollover's immediate pump took the
  per-attempt `withChunkLock` path, lost to this tab's own pending hold, and set "Another tab is
  uploading this chunk." Now each record tracks its pending hold (`holding`); an attempt awaits it
  first and, when another tab refused the hold, asks once more before treating the chunk as
  contended. Contention is logged (`report(…, 'lock contention')`) and is not a failure: no
  `lastError`, so the banner's `hasFailed` stays false (unchanged); it is retried on the backoff
  through the ambiguous path. `withChunkLock` remains only where no hold was attempted.
  Evidence: red `npx vitest run src/pages/index/utils/chunkUploadQueue.test.ts` `Tests 2 failed |
  72 passed (74)` (immediate pump after enqueue did not upload; a genuinely contended chunk was not
  logged and carried a `lastError`); green `Tests 74 passed (74)`; queue + recorder + banner + locks
  `Tests 172 passed (172)`; `cd web && npx vitest run` `Test Files 162 passed (162)`, `Tests 2176
  passed (2176)`, no unhandled errors; `npx tsc --noEmit -p .` clean; biome clean.
- [x] A.11 Safari finished-chunks-only (owner decision 2026-10-12: no Safari available for spike 0.2): `SAFARI_PERSIST_MODE = 'finished-only'`; Safari records without a timeslice and persists each chunk when it completes (crash loss up to one chunk, as before this change). Switch to `slices` once `docs/spikes/media-worker/browser/www/record.html` passes on Safari (README "Safari").
  Evidence: red `npx vitest run src/pages/index/components/AudioRecorder.chunks.test.tsx -t "Safari records"` -> `expected 5000 to be undefined`; green after the constant -> full web `Test Files 162 passed`, `Tests 2177 passed`; `tsc --noEmit` exit 0.
- [x] A.12 Development builds log every toast (`web/src/shared/components/Toast.tsx`
  `_devLogToast`: `console.warn` for errors, `console.info` otherwise, only when `NODE_ENV ===
  'development'`), so an auto-dismissed toast stays readable during V.2. **File outside A's
  ownership list, recorded for the consistency read** (commit `6eddbf07`).
  Evidence: (consistency read 2026-10-12; red not recorded, the test was written with the code)
  `cd web && npx vitest run src/shared/components/Toast.test.tsx
  src/pages/index/components/timeline/TimelineClips.test.tsx` -> `Test Files 2 passed (2)`,
  `Tests 8 passed (8)` (incl. `logs every toast to the console in development only`).
- [ ] A.7 Suites: `cd web && npx vitest run`, `npm run typecheck -w web`, `npm run lint -w web`;
  manual checklist in dev on Chromium and Firefox (and Safari if available): kill the tab at
  2.5 cadences → reload → recovered chunks upload → finalize → one merged segment appears with
  seams and a waveform; open a second tab mid-take → nothing offered to recover; sign out in
  another tab mid-take → `blocked` → sign in → Retry drains; unplug the microphone mid-take →
  recording continues on the default input; hide the tab for a minute → the warning on return.

## D. Web consumers, parts upload, transcription seams

- [x] D.1 Test first: `web/src/api/types.conformance.test.ts` (12 segment keys) and
  `web/src/pages/index/hooks/useAudioClips.durationProbe.test.tsx` (uses `duration_ms` when
  present, probes only when null); `audioClips.*.test.ts` (a merged segment with three seams lays
  out as three clips with the segment's URL, media offsets `offset_ms`, positions from each
  seam's `started_at_utc` identical to the pre-merge chunk layout fixture; eighteen seams over
  three hours place the last clip at its wall-clock position; chunk layout unchanged for `null`;
  a feed-row seek into a seam clip resolves to the same media position as the chunk did). Then
  `types.ts`, `useAudioClips.ts`, `audioClips.ts`.
  Evidence: (2026-10-12, open until B.3) red `cd web && npx vitest run
  src/shared/utils/audioClips.seams.test.ts` → `Tests 9 failed`; `useAudioClips.durationProbe` →
  `2 failed | 1 passed`; `npx tsc --noEmit` → `types.conformance.test.ts(363,7): error TS2353 …
  'duration_ms' does not exist in type 'AudioSegment'`. Green after `types.ts`, `audioClips.ts`
  (seam expansion, `clipMediaPositionSec`), `useAudioClips.ts`: `npx vitest run src/shared/utils/
  src/pages/index/hooks` → all passed (seams `9 passed`, durationProbe `3 passed`); tsc clean for
  these files. **Still red until B.3 regenerates `fixtures/api-responses/audioSegment{Create,sList}.json`**:
  `types.conformance.test.ts` "the captured upload body has exactly the 12 segment keys" and
  "every captured list row …" (re-run after B.3; then tick). Re-run after B.3 (2026-10-12):
  `types.conformance.test.ts` green with the `.ts` captures (D.7). The three fields are optional in
  `AudioSegment` so other workstreams' hand-built segment literals keep compiling.
- [x] D.2 Test first: `useWaveforms.test.tsx` (no decode while `media_status === 'pending'`;
  decodes for `null`; a `'failed'` segment is marked unavailable without a decode attempt; server
  peaks arriving clear the placeholder; a merged segment's peaks are drawn across its seam clips
  by media offset) and `TimelineWaveform.test.tsx` ("Finalizing recording…" when an interval has
  ≥ 2 segments with a pending one; "Generating waveform…" while pending single; "Waveform
  unavailable" for a `'failed'` segment). Then the hook and the timeline components.
  Evidence: (2026-10-12) red `cd web && npx vitest run src/pages/index/hooks/useWaveforms.test.tsx`
  → `Tests 4 failed | 3 passed`; `…/timeline/TimelineWaveform.test.tsx` → `4 failed | 3 passed`.
  Green after `useWaveforms.ts` (pending skipped, failed marked without decode, one decode per
  segment, `seamClipPeaks`) and `TimelineWaveform.tsx` (labels from the clips' `mediaStatus`/
  `finalizing`): `npx vitest run src/pages/index/components/timeline/ src/pages/index/hooks
  src/shared/utils` → `Test Files 20 passed`, `Tests 316 passed`.
- [x] D.3 Test first: `web/src/api/uploads.test.ts` (create with per-part sha256 computed with
  `crypto.subtle` over each 32 MiB slice and never a whole-file buffer → PUT parts in order with
  the exact sizes and offsets → complete in import mode with `duration_s` and the seam header,
  or in segment mode with the window (used by A.3); a failed part retries with backoff and
  re-GETs status to skip received parts; `upload_id` remembered in IndexedDB by the group's
  identity for 24 h and found from another tab; `429`/`507` surface as a per-group message) and
  `batchImport/*.test.ts` (files over 40 MiB and stitched WAVs over 40 MiB take the parts path;
  smaller files call `local-audio-import` unchanged; progress lines per part). Then
  `web/src/api/uploads.ts`, the batch-import call sites.
  Evidence: (2026-10-12, open until B.4) red `cd web && npx vitest run src/api/uploads.test.ts` →
  `Cannot find module './uploads'`; `src/pages/index/batchImport/runner.parts.test.ts` →
  `6 failed`. Green after `uploads.ts` and `runner.ts`: `uploads.test.ts` `15 passed`,
  `npx vitest run src/pages/index/batchImport/` → `Test Files 4 passed, Tests 45 passed`. Written
  against the D12 route shapes with a fake server; **re-run both against B.4's routes**. Also
  open: `src/apiResponseShapes.repo.test.ts` flags the five `uploads.ts` sites until B.4
  captures upload fixtures (create/status/complete → conformance assignments in
  `types.conformance.test.ts`) and the guard's owner records exemptions for the `204` PUT part
  and DELETE sites. Re-run after B.4 (2026-10-12): `uploads.test.ts`, `runner.parts.test.ts`
  and `apiResponseShapes.repo.test.ts` green (D.7 conformance checks; full suite in D.5).
- [x] D.4 Test first: `packages/transcription/src/transcriptRemap.test.ts` (a merged segment with
  seams places each seam's words at that seam's wall-clock-derived anchor plus the in-seam
  offset, equal to the pre-merge placement on the same fixture; no seams → identical output to
  today; paragraphs/sentiment through the same path), `generateTranscript.test.ts` (`seams`
  threaded from `AudioSegmentMeta`; a listed segment whose blob is missing fails with `502`
  naming it instead of being skipped, while an unparseable blob is still skipped) and
  `audioMerge.test.ts` (a missing path is reported distinctly from an unparseable one). Then
  `transcriptRemap.ts`, `generateTranscript.ts`, `audioMerge.ts`.
  Evidence: (2026-10-12) red `cd packages/transcription && npx vitest run src/audioMerge.test.ts`
  → `2 failed | 15 passed` (`kind` undefined); `src/transcriptRemap.test.ts` → `5 failed | 31
  passed`; `src/generateTranscript.test.ts` → `2 failed | 1 passed` (`expected 100.4 to be close
  to 100.45`; missing blob not a `TranscriptGenerateError`). Green: `npm run test -w
  packages/transcription` → `Test Files 10 passed, Tests 95 passed`; `npx tsc --noEmit` rc 0.
  The new error code `missing_blob` needs `server/src/routers/transcribe.ts` `mapGenerateError`
  to map it to `502` (today unknown codes map to `400`; file not in D's ownership). `seams` are
  read structurally from `AudioSegmentMeta` as `{offset_ms, started_at_utc}[]` until B.2 types it.
- [x] D.6 Follow-up (coordinator, 2026-10-12). **Ownership extension, recorded for the
  consistency read:** D also owns `web/src/pages/index/components/AudioPlayer.tsx` (+ tests) and
  `web/src/shared/utils/waveformMerge.ts` (+ tests). Test first: `AudioPlayer.seams.test.tsx`
  (a seek into the third seam of a merged segment lands at that seam's media time; playback runs
  through the seams on one element without a reload or `src` change, the playhead following each
  seam's wall-clock position so the rollover gap is never played twice; a plain segment
  unchanged) and `runner.parts.test.ts`/`uploads.test.ts` additions (the importer remembers the
  session it created for a parts upload for 30 days; after the 24 h upload memory expired, a
  re-run resumes with a fresh upload into that session only while it has no segments; a matching
  session it did not create, or one with audio, is still skipped). Then `AudioPlayer.tsx` (seek
  by `target.offsetSec + clipMediaOffsetSec(clip)`, playhead by `timelineSecAtMediaPosition`),
  `audioClips.ts` (`timelineSecAtMediaPosition`), `uploads.ts` (`createIdbImportSessionMemory`,
  `find/remember/forgetImportSession`), `runner.ts`. `waveformMerge.ts` needed no change
  (`seamClipPeaks` re-keys seam clips before the merge).
  Evidence: red `cd web && npx vitest run src/pages/index/components/AudioPlayer.seams.test.tsx`
  → `2 failed | 1 passed` (`expected 15.420000000000002 to be close to 75.42`; `expected 45 to be
  close to 45.03`); `runner.parts.test.ts` → `2 failed | 10 passed`; `uploads.test.ts` →
  `createIdbImportSessionMemory is not a function`. Green: `npx vitest run src/pages/index/
  components/AudioPlayer src/shared/utils …` → `17 passed (297 tests)`; `npx vitest run
  src/pages/index/batchImport/ src/api/uploads.test.ts` → `Test Files 5 passed, Tests 66 passed`;
  full `npx vitest run` → `4 failed | 2085 passed`, the 4 being the two B.3 fixture checks, the
  B.4 upload sites in `apiResponseShapes.repo.test.ts`, and A's `noBrowserDialogs` hit in
  `chunkUploadQueue.ts`; biome clean, tsc clean for D's files.
- [x] D.5 Suites: `cd web && npx vitest run`, `cd packages/transcription && npx vitest run`,
  `npm run typecheck`.
  Evidence: (2026-10-12, after B.3/B.4 landed) `cd web && npx vitest run` → `Test Files 160
  passed (160)`, `Tests 2135 passed (2135)`; `cd web && npx tsc --noEmit` → no output;
  `npm run test -w packages/transcription` → `Test Files 10 passed, Tests 95 passed`; its tsc rc 0.
- [x] D.7 Follow-up 2 (coordinator, 2026-10-12). **Ownership extension, recorded for the
  consistency read:** D also edited `web/src/pages/index/components/{TransportControls,
  MaximizeLogStrip,SessionWorkspace}.tsx` (+ `TransportControls.recovering.test.tsx`), and made
  one edit in A's `chunkUploadQueue.ts` (`RecordingFinalizeResponse`/`RecordingFinalizeMerge` now
  imported and re-exported from `api/types`, A finished). Test first: `types.conformance.test.ts`
  switched to B's `.ts` captures `audioSegmentCreate`/`audioSegmentsList` and gained checks for
  `audioUploadCreate.json`, `audioUploadStatus.json`, `audioUploadComplete`,
  `audioRecordingFinalize` (red: `tsc` → `TS2305: Module './types' has no exported member
  'RecordingFinalizeResponse'`); `TransportControls.recovering.test.tsx` (Record audio disabled
  with `aria-describedby` → "Recovering unsent audio…" while the recorder is `scanning`; red
  `1 failed | 2 passed`). Then `types.ts` (`RecordingFinalizeResponse {ok: true, merge}`),
  `TransportControls.tsx` (`recordRecovering` prop), the prop wired from `AudioRecorder`'s
  `onPhaseChange` in `SessionWorkspace.tsx` through `MaximizeLogStrip.tsx`.
  Evidence: `npx vitest run src/api/types.conformance.test.ts src/apiResponseShapes.repo.test.ts
  src/pages/index/utils/chunkUploadQueue.test.ts` → `Test Files 3 passed, Tests 176 passed`;
  `TransportControls` → `2 passed, 6 tests`; full suite and tsc as in D.5.
- [x] D.8 Bug (test VM, 2026-10-12): Chrome rollover chunks merged into a WebM with non-monotonic
  timestamps at every seam (`non monotonically increasing dts … 973536 >= 973536`, `1926072 >=
  1926048`), so the worker's strict decode failed every real merge `decode-failed`. Root cause
  (confirmed with mediabunny on the real chunks, locally only): Chrome's WebM leaves the last block
  without a duration (`packet.duration` 0), so the next input started at the previous input's last
  packet time; its block times are also millisecond-rounded on a real clock (0.059/0.061 s), which
  put the next chunk 24 samples before the decoded end. Fix in `audioMerge.ts` `mergeGroup`: every
  packet is written at the running end of what was written, advanced by its exact duration (Opus:
  TOC, `opusPacketSamples`; FLAC: block size; else the container's, else the previous packet's,
  else an AAC frame), so timestamps are strictly increasing and `SegmentOffset`s equal the inputs'
  untrimmed sample sums, the same sums `media-worker/src/jobs/merge.ts` computes seams from
  (merge.ts unchanged). Fixtures (45 KB, synthetic, provenance in
  `chrome-rollover.source.txt`): `chrome-rollover-{1,2,3}.webm` from headless Chromium 156 with a
  fake test-tone microphone (stop/start on one stream), and `chrome-rollover-drift-{1,2,3}.webm`,
  the same packets with a real clock's 59.6 ms block times. Test first:
  `packages/transcription/src/audioMerge.chrome.test.ts` (strictly increasing timestamps, offsets
  on the 60 ms grid, pinned-ffmpeg decode with `-xerror -loglevel error` gives empty stderr and
  exactly 3 × 38 × 2880 samples, raw f32le and the worker's wav counting decode) and
  `media-worker/src/jobs/merge.ffmpeg.test.ts` (the drift chunks merge `done`, verify exact,
  seams `[0, 2280, 4560]`).
  Evidence: red with the old `audioMerge.ts` (`git stash push` of that file): transcription
  `npx vitest run src/audioMerge.chrome.test.ts` → `5 failed | 1 passed` (`expected 2.22 to be
  greater than 2.22`; stderr `[f32le …] … non monotonically increasing dts … 106560 >= 106560`);
  worker `npx vitest run src/jobs/merge.ffmpeg.test.ts -t Chrome` → `expected done, got
  {"kind":"fail","error":"decode-failed"}`. Green: `npm run test -w packages/transcription` →
  `Tests 101 passed`; `cd media-worker && npx vitest run` → `Test Files 9 passed, Tests 111
  passed` (merge.ffmpeg `14 passed` against the pinned image); both tsc clean; server unit `603
  passed | 5 skipped`. Local confirmation on the VM's real chunks (not committed): old →
  `decode-failed`, fixed → `done`, `verify {merged_samples: 3337920, expected_samples: 3337920}`,
  seams `[0, 20340, 40260, 60240]`; pinned-ffmpeg f32le decode of the merged file has no stderr
  and 13351680 bytes = the inputs' sum.

- [x] D.9 Seam clips of a merged segment get unique React keys in
  `web/src/pages/index/components/timeline/TimelineClips.tsx` (`<segment id>@<media offset>`;
  they share the segment's id, D16). **File outside D's ownership list, recorded for the
  consistency read** (commit `95f14c82`).
  Evidence: (consistency read 2026-10-12; red not recorded) same run as A.12 -> `Tests 8 passed
  (8)`, incl. `renders every seam clip of a merged segment without a duplicate-key warning`.

## V. Verify (after all workstreams)

- [ ] V.1 `scripts/check-change.sh` green (tests, typecheck, audit, openspec, tests-with-code);
  `openspec validate media-worker --strict`.
- [x] V.0 Dev-only chunk length for V.2: `web/src/pages/index/utils/devChunkMs.ts` reads `localStorage['autologger.dev.chunkMs']` (15 s .. 10 min) only when `NODE_ENV === 'development'`; the recorder's default `chunkMs` uses it.
  Evidence: red `npx vitest run src/pages/index/utils/devChunkMs.test.ts` -> `Cannot find module './devChunkMs'`; green -> with the recorder components `Test Files 77 passed`, `Tests 891 passed`; `tsc --noEmit` exit 0.
- [ ] V.2 End to end on dev: record 3 cadences with `chunkMs` lowered in a dev-only seam → stop
  → `finalize` with the three windows → worker merges → one segment with `duration_ms`, peaks
  and three `seams`, the three chunk blobs under `.trash/<today>/`, the timeline showing three
  seam clips; re-post chunk 2's bytes → the merged segment's dict, no new blob; generate a
  transcript and compare word positions with a run made before the merge (same fixture audio) →
  equal within 1 ms; import a 120 MB WAV through the parts flow on dev with the router's body
  limit lowered to 50 MB for the test → `200`, then the worker converts it to FLAC and the WAV
  lands in `.trash`; fill the dev blob volume past the floor → uploads answer `507`, the sweep
  purges trash, the log shows the transition.
- [x] V.3 Tier 2 consistency read (`consistency-read` skill) over the whole branch; `panel.md`
  re-panel section for any scope change; the design-owned constants confirmed by the owner.
  Evidence: (2026-10-12) `git diff 138649f3..HEAD` read against proposal, design D1-D20, tasks,
  the nine spec deltas, ADR 0032 and the code; `panel.md` "Consistency read 2026-10-12" (scope
  change: no; two open findings for the owner); stale text fixed in design ("Edits after
  approval"), live-recording-chunks, media-processing, ADR 0032 and README "Media jobs";
  `npx openspec validate media-worker --strict` -> `Change 'media-worker' is valid`. Owner
  2026-10-12: constants confirmed; both findings resolved (merge block kept, polling only; spec
  amended, design notes, `panel.md` ticked); `check-change.sh --only panel` -> `47 finding(s), no
  open criticals`.
