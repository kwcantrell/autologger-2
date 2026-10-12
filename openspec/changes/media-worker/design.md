# Design: media-worker

## Context

- **Recorder today** (`web/src/pages/index/components/AudioRecorder.tsx`): `new MediaRecorder(stream)`
  with no options (:576), `mr.start()` with no timeslice (:620), rollover every `CHUNK_MS = 10 min`
  (:37) by `stop()` then a new recorder on the same stream (:647-649), each chunk `enqueue`d to the
  module singleton `chunkUploadQueue` (:600-608) and uploaded by `POST
  /api/sessions/:id/audio/segments?started_at_utc&ended_at_utc&recording_ordinal` (:193-226).
  Stop logs `Recording N Stopped`, releases the lease and pumps the queue (:466-566). Nothing tells
  the server a recording is complete.
- **Queue today** (`web/src/pages/index/utils/chunkUploadQueue.ts`): `let chunks: InternalChunk[]`
  with the `Blob` (:141), single-flight `pump()` (:245-250), transient = `status >= 500 || 408 ||
  429` (:127-129), any other 4xx → `classification = 'permanent'` and skipped by `nextAttemptable`
  (:212-214, :315-320), network error → `ambiguous` then dedupe by `(recording_ordinal,
  started_at_utc)` against the segments list (:219-232). No timer, no persistence, no `online`.
- **Server today** (`server/src/routers/audio.ts`): the segment POST inserts the row, then puts the
  blob, rolling the row back on put failure (:226-238); `MAX_AUDIO_BYTES = 50 MB` (:108),
  `MAX_LOCAL_AUDIO_IMPORT_BYTES = 1500 MiB` (:116); no duration, no peaks, no lease check, no
  DELETE route. `segmentApiDict` returns 9 keys (:32-44). Blobs: `packages/storage/src/blobStore.ts`
  (`put` = write `BLOB_DIR/.tmp/put-<uuid>`, fsync, rename; no streaming put). Timers: kv purge
  (10 min) and the lease sweeper (60 s) in `server/src/startupPurge.ts`.
- **Schema today**: `catalog.session_audio_segments(session_id, id, ordinal, started_at_utc,
  ended_at_utc, mime_type, r2_key, recording_ordinal, waveform_peaks_json, waveform_db_floor,
  created_at_utc)` (`supabase/migrations/20261008000000_session_tables.sql:41-56`). Transcript
  words, events and exports carry timeline positions, never a segment id. Only `autologger_app`
  and `postgres` may be members of the catalog roles (`20261006000000_catalog_roles.sql:64-68`);
  `autologger_app`'s password is set by `docker/supabase/migrate.sh` phase 3 from
  `APP_DB_PASSWORD`.
- **Transcription** (`packages/transcription/src/audioMerge.ts`): probes bytes, groups by codec
  family (`opus|aac|pcm|flac|mp3`) and stream parameters, packet-copies each group into one
  container (WebM/MP4/WAV/FLAC, FLAC frames renumbered), records per-input offsets; the remap
  anchors each chunk at `A + max(0, started_at − wall(E))` (`transcriptRemap.ts`).
- **Stacks**: prod is `compose.yaml` + `docker/supabase-db.yaml` + `docker/supabase-services.yaml`;
  stage adds `docker/compose.stage.yaml`; dev is `docker/compose.dev.yaml`. `catalog` is a
  two-member internal network (`db`, the app); `check-envs.sh` invariant 16 and the compose
  wrapper's `SECRET_SCOPE` (`compose-run.mjs:61-67`) pin members and secret scopes. Images are
  built only by `docker buildx bake -f docker-bake.hcl` (group `default` = `web`, `api`), tagged by
  git SHA. The app image has no ffmpeg. `#107`'s scripts run
  `linuxserver/ffmpeg:9.0-cli-ls84@sha256:a7182d4f…` through `docker run --network none`.

## Assumptions

Each was tested in this worktree at `3d145c41` unless marked *spike*.

| # | Assumption | Command | Observed |
| --- | --- | --- | --- |
| A1 | The app image has no ffmpeg | `grep -nc ffmpeg docker/Dockerfile` | `1` (the comment at :107 "No ffmpeg") |
| A2 | A multi-arch ffmpeg image is already pinned | `grep -n "linuxserver/ffmpeg" -r server/scripts` | `blobSegmentRows.ts:11: 'linuxserver/ffmpeg:9.0-cli-ls84@sha256:a7182d4f…'` |
| A3 | Live and import caps | `grep -n "MAX_AUDIO_BYTES =\|MAX_LOCAL_AUDIO_IMPORT_BYTES =" -r server/src` | `audio.ts:108: 50 * 1024 * 1024`, `audio.ts:116: 1500 * 1024 * 1024` |
| A4 | Segments store no duration | `grep -n "create table.*session_audio_segments" -A 16 supabase/migrations/*.sql` | 11 columns, none a duration or size |
| A5 | Next migration version | `ls supabase/migrations \| tail -1` | `20261017000000_provider_test_windows.sql` |
| A6 | Nothing references a segment id | `grep -rn "segment" supabase/migrations/20261008000000_session_tables.sql` | only the segments table itself; words/paragraphs carry `start_sec`/`end_sec` |
| A7 | No queue exists | `grep -rn "SKIP LOCKED" server packages` | no match |
| A8 | Prod stack subnets in use | `grep -n "subnet" compose.yaml docker/compose.stage.yaml docker/compose.dev.yaml` | prod 10,11,12,15,16,17; stage 20,21,22,25,27,28; dev 30,31,34,35,36 (`172.28.N.0/24`) |
| A9 | The web never imports `packages/` | `grep -rn "@autologger/" web/src --include=*.ts --include=*.tsx -l` | no match (web-package-boundary) |
| A10 | *spike* Timeslice blobs concatenate to the same bytes as a no-timeslice file (Chromium, Firefox; Safari separately) | tasks 0.2 | 2026-10-12: **holds at the decoded-stream level, not byte level**. Headless Chromium 156 (WebM/Opus) and Firefox 157 (Ogg/Opus, Firefox's default) `mr.start(5000)` slices appended over 25 s decode with the pinned ffmpeg (`-xerror`, `pipe:0`) and `decodeAudioData` to the same codec, rate and sample count as a parallel no-timeslice recorder on the same stream (Chromium 1198080 = 1198080, Firefox 1218560 = 1218560); bytes differ (Chromium's no-timeslice file carries SeekHead/Cues/Duration and sized clusters, the concatenation unknown-size clusters; Ogg serials differ). Safari unverified (Playwright WebKit on Linux has no `MediaRecorder`); see D10 note |
| A11 | *spike* Node runs on the pinned `linuxserver/ffmpeg` base (glibc, libstdc++ present) for amd64 and arm64 | tasks 0.1 | holds (spike 0.1, 2026-10-12): the base is Ubuntu 26.04.1, glibc 2.43; `ldd /usr/local/bin/node` has 0 `not found`; node `v22.23.3` (`arm64`, and `x64` under QEMU) as uid 10001 |
| A12 | *spike* `createSyncAccessHandle` in a dedicated worker works on current Chrome, Firefox and Safari; IndexedDB `Blob` storage works where OPFS does not; `navigator.locks` and `navigator.wakeLock` are available on all three | tasks 0.3 | 2026-10-12: holds on Chromium 156, Firefox 157 and WebKit 27.2 (Playwright, Linux; proxy, Safari unverified) with a persistent profile: worker `createSyncAccessHandle` write/append/flush/read round-trips 105000 bytes, IndexedDB `Blob` parts round-trip, `locks.request(…, {ifAvailable: true})` from a second tab gets `null` while the first holds it, `wakeLock` exists everywhere. **Not** where OPFS fails: in an ephemeral WebKit context `getDirectory()` throws `UnknownError` *and* the IndexedDB `Blob` put fails, so both backends fail together (memory fallback). See D10/D17 notes |
| A13 | *spike* The API (uid 1000) can open a worker-written file (uid 10001) under sticky `media/` with `O_NOFOLLOW`, `fstat` it, copy it and remove the worker's directory; `getent hosts example.com` fails inside the worker | tasks 0.1 | holds with one change (spike 0.1, 2026-10-12): the API cannot remove a worker-made `media/<job>/` left at mode 0755 (`EACCES`); the worker must `chmod` it 0777 (D4). Then adopt + remove succeed, a symlinked `out.webm` fails `ELOOP`, and `getent hosts example.com` returns 2 |
| A14 | No segment undo exists (`deleteAudioSegment` only serves import rollback) | `grep -rn "deleteAudioSegment" server/src packages/session-core/src \| grep -v test` | `audio.ts` put rollback and `sessions.ts` import rollback only |
| A15 | `LISTEN`/`NOTIFY` cannot be revoked per role | PostgreSQL 17 `NOTIFY`/`LISTEN` reference: no privilege is checked; `docs/security.md` "NOTIFY forgery" already records that any database login can `pg_notify` | accepted risk, monitored (D20) |

## Decisions

### D1. The worker is a separate container that reaches only Postgres, as its own role

`media-worker` joins one network, `media`: internal, host-isolated, pinned subnet (prod
`172.28.18.0/24`, stage `172.28.29.0/24`, dev `172.28.37.0/24`), members exactly `db` and
`media-worker`. It connects as `autologger_media` (created `NOLOGIN` by the migration; the
migrations runner grants `LOGIN` and sets the password from `MEDIA_DB_PASSWORD` in the same phase
that does this for `autologger_app`, so a database that was never migrated by the runner has no
login for it; connection limit 4, `statement_timeout` 30 s, `idle_in_transaction_session_timeout`
15 s, `search_path = catalog`, no catalog role membership, no `BYPASSRLS`). Its privileges: `USAGE` on `catalog`; `SELECT` and a column-limited
`UPDATE` on `media_jobs` (D2); `SELECT` on `session_audio_segments` and `session_audio_seams`;
nothing else. Its RLS policies allow every row of those three tables for that role (the worker
is a system task; the policies are permissive like `catalog_system`'s).

- *Alternative, poll an API on the app:* rejected. It needs new frozen HTTP surface, a shared
  worker token (a secret the worker holds and the API must verify), a network path from the worker
  to the API, and the API streaming blobs the worker can already read from the shared volume. The
  database role is a narrower credential than any API token: it cannot touch sessions, events,
  users or any other table, and cannot write a segment.
- `catalog`'s "exactly two members" invariant stays true; the `media` network is new. `check-envs.sh`
  gains the mirror invariants (D15).
- The worker never holds `APP_DB_PASSWORD`, `POSTGRES_PASSWORD`, `FRAME_BUS_SECRET`,
  `PROVIDER_KEYS_SECRET` or any OpenBao value other than its own password.

### D2. `catalog.media_jobs` is the durable queue, claimed with `SKIP LOCKED`

```
id text pk, kind text check (kind in ('ingest','merge')), session_id text not null references sessions,
target text not null,                      -- ingest: segment id; merge: recording_ordinal as text
status text check (status in ('queued','running','done','applied','failed','cancelled')),
attempts int not null default 0, max_attempts int not null default 5, input_bytes bigint not null,
run_after_ms bigint not null, locked_by text, locked_until_ms bigint,
result_json text check (octet_length(result_json) <= 262144), error text,
created_at_ms bigint not null, updated_at_ms bigint not null, applied_at_ms bigint
```

- One live job per target: a unique partial index on `(kind, session_id, target)` where `status in
  ('queued','running','done')`. Enqueue is `INSERT … ON CONFLICT DO NOTHING`, so finalize, the
  reconcile and a late chunk coalesce.
- **Enqueue is transactional with its cause**: the ingest job is inserted in the same transaction
  as the segment row (`addAudioSegment`, `addImportedAudioSegment`, sync-from-disk). The merged
  row the apply step inserts is already `done` (peaks and duration come from the merge, D7) and
  gets no job. The table has a `catalog_user` policy for `INSERT`/`SELECT` scoped by the
  same session-access rule as the session tables (it is written inside user transactions), and
  `catalog_system` all.
- **Claim** (worker, one statement): `UPDATE media_jobs SET status='running', locked_by=$worker,
  locked_until_ms=$now+600000, attempts=attempts+1, updated_at_ms=$now WHERE id = (SELECT id FROM
  media_jobs WHERE status='queued' AND run_after_ms <= $now AND input_bytes <= $lane_max ORDER BY
  run_after_ms, created_at_ms LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`. The worker renews
  `locked_until_ms` every 60 s while ffmpeg runs; a `running` job whose lock expired is re-queued
  by any worker's sweep (or `failed` once `attempts >= max_attempts`). Every later statement by
  the worker on that job is fenced `… WHERE id=$id AND locked_by=$worker AND status='running'`
  (0 rows = the lease was lost; the worker discards its result).
- **Fair ordering** (panel B): `input_bytes` (the inputs' total size, set at enqueue) lets the
  worker run two lanes concurrently: lane A claims only jobs with `input_bytes <= 64 MiB` (live
  chunks, small imports), lane B any job; a 1.5 GiB import's ingest therefore never delays the
  waveform of a chunk recorded meanwhile. The CPU limit (2) matches two lanes.
- **The worker's write surface is the minimum** (panel B): column-level `GRANT UPDATE (status,
  locked_by, locked_until_ms, attempts, run_after_ms, result_json, error, updated_at_ms)`; a
  `BEFORE UPDATE` trigger `media_jobs_worker_guard` that, when `current_user = 'autologger_media'`,
  allows only `queued → running` (and only while `locked_by` is null or `locked_until_ms` has
  passed) and `running → queued | done | failed` with `NEW.locked_by = OLD.locked_by`, and raises
  on anything else; `CHECK (octet_length(result_json) <= 262144)` (256 KiB: 4096 peaks plus the
  seams of a long recording use a tenth of it). The apply step never trusts the result for what to
  delete: it re-reads the rows and uses their `r2_key`s (D7).
- **Retry**: on error, `run_after_ms = now + min(30 s × 2^(attempts−1), 1 h)`, status `queued`;
  after `max_attempts`, `failed` with a classified `error` (`decode-failed`, `mixed-codecs`,
  `verify-mismatch`, `interleaved-input`, `missing-blob`, `timeout`, `low-disk`, `internal`,
  `invalid-result`; never a path or stderr). Times are epoch milliseconds like the leases.
- **Wake-ups**: the API `NOTIFY media_jobs` (no payload) after an enqueue; the worker `LISTEN`s and
  also polls every 5 s. The worker `NOTIFY media_jobs_done` (no payload) after a result; the API
  listens and polls every 10 s. A forged or replayed notification only causes an extra read, so
  these channels need no signature (unlike the frame bus).
- `applied`/`failed`/`cancelled` rows older than 7 days are deleted by the API's sweep.

### D3. The worker computes, the API applies

The worker writes nothing to a segment row and nothing under `BLOB_DIR/audio/`. Its outputs are
files under `BLOB_DIR/media/<job id>/` and `result_json`. The API's single process runs
`mediaApply` (every 10 s; the `media_jobs_done` wake-up is not wired, see "Edits after
approval"): for each `done` job, in one `SessionHub`
transaction as system caller `media-apply`, it validates the result, **copies** the worker's file
into a blob of its own, writes the rows, bumps the session revision, broadcasts `audio.changed`,
and sets the job `applied`; any failure leaves the job `done` for the next tick (idempotent: the
job row's status guards the transaction).

- Why: the hub is the only writer of session rows today (revision, RLS, broadcast, the frame bus
  secret). Letting the worker write rows would need a second write path and give it
  `FRAME_BUS_SECRET`.
- **Adopt by handle and copy, never by rename** (panel B blockers): the API opens
  `media/<job>/<name>` with `O_RDONLY | O_NOFOLLOW`, `fstat`s the **handle** (regular file, size
  ≤ 1650 MiB, owner the worker's uid), streams it into its own `BLOB_DIR/.tmp/put-<uuid>` (the
  existing `put` path: an API-owned inode, fsync, rename into `audio/<sid>/`), and only then
  removes `media/<job>/` (the API owns the sticky directory). Nothing the worker can do after the
  open (swap in a symlink, replace or grow the file) changes what was checked, and no worker-owned
  inode ever reaches `audio/`. Cost: one copy of up to 1.5 GiB per big job, accepted. Spike 0.1
  (A13) proves the open/copy/remove sequence across the two uids.
  **Spike 0.1 (2026-10-12)**: emulated volume `media-worker-spike-blobs`; worker
  `media-worker-spike:{arm64,amd64}` (uid 10001, hardened flags), API `node:22-bookworm-slim` pin
  (uid 1000) running `open(O_RDONLY|O_NOFOLLOW)`, `fstat` (regular file, uid 10001, ≤ 1650 MiB),
  64 KiB copy to `.tmp/put-<uuid>`, `fsync`, `rename` to `audio/s1/<n>_m.webm`, `rm -r media/<job>`.
  Job dir 0755 (worker umask 022): copy and rename OK, `rm media/job1 FAIL EACCES` (removing
  `out.webm` needs write on the worker-owned job dir; the sticky bit on `media/` only covers its
  own entries). Job dir 0777: `copied 2778 bytes -> audio/s1/3_m.webm owner 1000`, `rm media/job2
  OK` (same on the amd64 worker). `out.webm` replaced by `ln -s /blobs/audio/s1/1_b.webm`: `open
  FAIL ELOOP`. Extra case: `media/job4` itself a symlink to `audio/s1/` opens an API-owned blob
  (`O_NOFOLLOW` covers only the last component); only the handle's owner check (`uid 1000` →
  `REJECT`) stops it, so that check is load-bearing; the API also `lstat`s `media/<job>` (a real
  directory owned by 10001) before the open.
- Result validation: peaks are 8..4096 numbers in [0, 1]; `duration_ms` is a positive integer; the
  blob key is `media/<job id>/<name>` with `<name>` a single plain path component; a merge's input
  ids must equal the current segment set (D7); an `ingest` whose target row no longer exists is
  `cancelled` (a deleted session or segment leaves no target; since B.8 every blob is written
  before its row). A merge's seams are validated strictly (B.9, see "Edits after approval").
- **Deterministic output identity**: the merged segment's id is derived from the job id
  (`uuidv5(job id)`) and its key is `audio/<sid>/<ordinal>_<id>.<ext>`, so an apply retried after a
  crash between the blob put and the commit finds the blob already in place under the same key
  and does not duplicate it.

### D4. Sandbox and filesystem posture

- Compose: `user: "10001:10001"`, `read_only: true`, `tmpfs: /tmp` (64 MiB), `cap_drop: [ALL]`,
  `security_opt: [no-new-privileges:true]`, `init: true`, `pids_limit: 128`,
  `deploy.resources.limits: {cpus: "2", memory: 1g}` (`mem_limit`/`cpus` in dev, since dev is
  not swarm either; the implementer uses the compose v2 keys that `compose config` keeps),
  restart policy, bounded logs, healthcheck `node -e` that checks a heartbeat file the loop
  touches in `/tmp` (no network tools).
- `BLOB_DIR` is mounted at `/blobs` from the same named volume as `api`. The narrow write path is
  Unix permissions, not a second mount: `audio/` and `.tmp/` are owned by `node` (uid 1000, mode
  0755) so uid 10001 can read but not create or delete there; the API creates `media/` with mode
  `1777` (sticky, world-writable) at boot, so the worker can create `media/<job>/…` and the API, as
  the directory's owner, can rename files out of it and remove job directories. Files the worker
  creates are mode 0644, readable by the API. Blobs the import copied with mode 0600 are
  unreadable to the worker: the job fails `missing-blob` with a README note (`chmod -R a+rX
  audio/`). Spike 0.1 confirms the modes on an existing volume.
  **Spike 0.1 (2026-10-12)**, on an emulated volume (the dev `dev-blobs` volume lives on the
  `autologger-dev` VM, which the spike did not touch): `BlobStore.put` as uid 1000, umask `22`,
  gives `. .tmp audio audio/s1` = `755 1000:1000`, blobs `644 1000:1000`; `media` after
  `mkdir` + `chmod 0o1777` (mkdir's mode is masked by the umask, so the API must `chmod`) =
  `1777 1000:1000`. As 10001: `touch audio/s1/x`, `rm audio/s1/1_b.webm`, `touch .tmp/x` and `mv
  media m2` all `Permission denied`; worker output `out.webm` = `644 10001`. **Change**: the
  worker creates `media/<job>/` and then `chmod`s it to `0777` (not sticky), otherwise the API
  cannot remove it (D3 note). `read_only`, `cap_drop ALL`, `no-new-privileges`, `--init`, `tmpfs
  /tmp` (64 MiB): node writes `/tmp`, ffmpeg decodes, `touch /x` → `Read-only file system`, on
  both architectures. On an `internal: true` network: `getent hosts example.com` rc `2`, node
  `dns.lookup` `EAI_AGAIN`, resolver `127.0.0.11`; `getent hosts db` (service alias) still resolves.
- **ffmpeg never opens a path** (panel B): the worker opens each input itself (`O_RDONLY |
  O_NOFOLLOW`, `fstat` regular file, under `/blobs/audio/` or `/blobs/.trash/`), sniffs the
  container from the first bytes (Matroska/WebM EBML, `OggS`, MP4 `ftyp`, RIFF `WAVE`, `fLaC`, MP3
  frame sync or `ID3`), refuses anything else (`decode-failed`), and spawns ffmpeg with argv only:
  `-nostdin -hide_banner -loglevel error -xerror -protocol_whitelist pipe -f <forced demuxer from
  the allowlist matroska, ogg, mov, wav, flac, mp3> -i pipe:0 …`, streaming the file into stdin.
  A forced demuxer plus a pipe-only whitelist means no playlist or concat demuxer ever runs and
  ffmpeg can open no second file. One exception: an MP4 whose `moov` follows `mdat` cannot be
  demuxed from a pipe; for that layout only (seen in the atom scan) the worker passes `-f mov
  -protocol_whitelist file -i file:<path>` with the default `use_absolute_path 0`, so the mov
  demuxer cannot follow external data references; spike 0.2 records which layout Safari's
  MediaRecorder writes. `-xerror` makes any decode error fatal, so a corrupt stream never decodes
  to silence and then passes a sample count. **Edit after approval (W.2, 2026-10-12, for the
  consistency read):** `-xerror` is not enough: the pinned ffmpeg's Opus parser drops a corrupt
  packet ("Error parsing Opus packet header") and still exits 0. A run therefore also fails on any
  error-level stderr line (`-loglevel error`) except "File ended prematurely" (a live WebM cut at a
  slice boundary) and ffmpeg's "Last message repeated N times" counter. Stderr is captured and
  discarded after classification; 30 min wall-clock limit; `SIGKILL` on overrun; outputs under `media/<job>/`,
  never `/tmp` (sizes up to 1.5 GiB).
- The `media` network is `internal`, so the container has no route and no resolver beyond
  Docker's embedded DNS for service names; spike 0.1 checks that an external name does not
  resolve.
- `docs/security.md` gains a row for untrusted media: the controls above, and the residuals: a
  decoder exploit yields a read of every blob and a bounded write to `media_jobs`; the worker
  login can `LISTEN` on the frame-bus channel and flood `pg_notify` (D20).

**Spike 0.2/0.3 (2026-10-12).** Atom order: headless Chromium 156 asked for `audio/mp4` writes
fragmented MP4 (Opus) with `moov` **before** the fragments, both no-timeslice (`ftyp, moov, moof,
mdat`) and timeslice (slice 0 = `ftyp, moov`; later slices `moof, mdat` pairs), so it demuxes from
`pipe:0` with `-f mov`; Chromium/Firefox defaults are WebM and Ogg, never MP4. Safari's layout is
**unverified** (Playwright WebKit on Linux exposes no `MediaRecorder`); the `file:` exception
stays until the owner's Safari check reports `moov` after `mdat`. Classification: with `-xerror`
a WebM or Ogg prefix cut at a slice boundary or mid-slice exits 0 (WebM logs "File ended
prematurely" at level error, so stderr content alone must not mean failure); an MP4 cut
mid-fragment exits 183 ("corrupt input packet") after decoding the earlier fragments, while an MP4
cut at a slice boundary exits 0. A partial chunk is therefore trimmed to its last whole slice (D10
note) before upload. Scripts and outputs: `/tmp/claude-1000/-home-spark-spark-infra/6240e2d2-a7e0-415a-bc19-67c2995ccb4b/scratchpad/spike-browser/` (`drive.mjs`, `www/`, `out/`).

### D5. On-ingest processing for every new segment

An `ingest` job per new segment (live chunk, import, upload complete, YouTube, sync-from-disk;
not the merged row, which the apply step inserts `done` with the merge's own peaks and
duration, D7). The worker decodes the blob once to `pcm_f32le` through a pipe, counting frames and
feeding `DbPeaksAccumulator` with `segmentWaveformDecodeBucketCount(dur, dur)` buckets (the same
math and constants as the browser, pinned by `#107`), and reports `duration_ms = round(frames /
rate × 1000)`, codec, rate and channels. For a WAV whose header is 16- or 24-bit integer PCM it
also encodes `media/<job>/converted-a<attempt>.flac` (per-attempt name, W.8) (`-c:a flac -compression_level 8`, `#107`'s arguments)
and verifies it (`#107` `verifyPair`: STREAMINFO parameters equal, decoded-PCM md5 and byte count
equal, sample count equal). The apply step writes peaks, `duration_ms`, `media_status = 'done'`,
and for a verified FLAC swaps `r2_key`/`mime_type` and trashes the WAV (D8). A job that fails for
good sets `media_status = 'failed'` and `media_error` (the classified code).

- New rows get `media_status = 'pending'` at insert. Legacy rows keep `NULL`, which the web treats
  as today (browser decode fallback). `server/scripts/enqueueMediaJobs.ts` inserts `ingest` jobs
  for rows with `NULL` peaks, `NULL` duration or a WAV mime, so the worker can do the backfill;
  `backfillWaveforms.ts` and `convertWavToFlac.ts` stay as operator tools and their README sections
  say which to prefer.
- The browser stops computing peaks for its own chunks (`computeAndUploadWaveformBestEffort` is
  removed; the `PUT …/waveform` route stays frozen and in use by the legacy fallback).

### D6. What "stop" means: explicit finalize plus a server fallback

The client calls `POST /api/sessions/:sessionId/audio/recordings/:recordingOrdinal/finalize` once
every chunk of that recording has been confirmed (the queue tracks `pendingFinalize` per ordinal,
persisted with the chunks, so a recovery that finishes the upload later still finalizes). The body
carries the client's chunk list, `{chunks: [started_at_utc, …]}` (panel C): the server enqueues a
`merge` only when every listed window exists as a segment row or a seam row; otherwise it answers
`merge: 'waiting'` and the merge is enqueued when the last straggler arrives (the segment POST
checks the recording's pending finalize) or by the reconcile. The route answers `200 {ok, merge:
'queued'|'not-needed'|'already-queued'|'waiting'}`. The lease sweeper's tick also enqueues `merge`
for any recording with two or more segments whose `media_status` is not null, whose newest
`ended_at_utc` is older than 30 min, that has no live merge job **and no terminal (`failed`,
`cancelled`) merge job younger than 24 h** (panel C: no retry loop on a recording that cannot
merge). Recordings whose rows have `media_status IS NULL` (chunked before this change) are never
reconciled; only `enqueueMediaJobs.ts --merge` touches them (owner answer 1). A chunk that arrives
after a merge (a recovered upload) is a plain segment and re-triggers the merge (D7, "late and
interleaved inputs").

- *Alternative, server detects stop from `Recording N Stopped` or the lease release:* kept only as
  the fallback above, because a recovered client may still hold chunks the server has not seen.

### D7. Merge: packet copy per codec family, verified, swapped in one transaction

Inputs are the recording's current segments ordered by `started_at_utc` (then `ordinal`). The
worker probes each (bytes, not mime) and refuses with `mixed-codecs` when they are not one codec
family with equal stream parameters (a Safari AAC chunk among Opus chunks cannot happen from one
recorder; it would mean two clients). It concatenates with `mergeAudioSegments` (mediabunny packet
copy: Opus→WebM, AAC→MP4, PCM→FLAC via the FLAC family rules, FLAC→FLAC; never re-encoded). The
merge fails (`mixed-codecs` or `decode-failed`) unless `mergeAudioSegments` returns exactly one
group and no skipped input (panel C). It then verifies with ffmpeg (`-xerror`, so a decode error
fails the job instead of passing as silence, plus the D4 stderr rule): the merged file decoded
**untrimmed** must hold exactly the inputs' untrimmed samples, with no tolerance: every side is
decoded with `-flags2 +skip_manual` (no Opus pre-skip, no WebM DiscardPadding or Ogg end-granule
trim), AAC/MP4 also with `-ignore_editlist 1` (priming kept on both sides), and `merged ==
Σ untrimmed(input_i)`. Packet copy keeps every packet, so the totals must match whatever the
containers' trim metadata says. Seam offsets follow the same unit: input *i* starts at
`Σ_{j<i} untrimmed_j + skip_i − skip_merged` samples in the played merged stream (`skip` = the
Opus pre-skip of that file; for AAC each file's edit-list priming, measured as its decode with
`-ignore_editlist 1` minus its played decode, for every input and for the merged file alike,
since packet copy keeps each input's priming; 0 for FLAC/PCM), and a merged input's own seams are
shifted by its start. **Edit after approval (W.8, 2026-10-12, for the consistency read):** the W.3
text used `skip_i = 0` for AAC and the merged file's untrimmed-minus-played count (which also
holds its end trim) as `skip_merged`, so every AAC seam after the first was early by one priming
(about 23 ms at 44.1 kHz). Peaks and
`duration_ms` come from the merged decode (D5 math).
**Edit after approval (W.3, 2026-10-12, for the consistency read):** the approved rule was
`Σ raw(input_i) + Σ_{i>1} pre_skip_i` for Opus (raw = the trimmed standalone decode) and the raw
sum with `-ignore_editlist 1` for AAC. It is not exact: browser chunks carry end padding (WebM
DiscardPadding 648 samples, the Ogg end granule) that packet copy cannot keep, and the merged MP4
carries a 614-sample skip that `-ignore_editlist` does not remove (fixtures: Opus merged 49608 vs
48312 expected; untrimmed 29760 + 20160 = 49920 = merged; AAC 117760 + 131072 = 248832 = merged).
The untrimmed rule above is what `media-worker/src/jobs/merge.ts` implements; the padding from
non-final chunks (about 13.5 ms of codec padding per seam) is played, like the accepted rollover
gaps.

**Late and interleaved inputs** (panel C): the merge orders inputs by `started_at_utc`. If an
input's window falls *between* two seams of an earlier merged input, appending would reorder
audio; the merge then rebuilds from the originals: each seam records the source chunk's key
(`session_audio_seams.source_key`), the originals sit under `.trash/` for 7 days, and the worker
reads them from there (read-only, like `audio/`); when an original is gone the job fails
`interleaved-input` and the late chunk stays a separate segment with its own seam row. A late
chunk that follows every seam is appended (the earlier merged file is one more input, its seams
carry over).

`result_json`: `{key, mime, duration_ms, peaks, seams: [{offset_ms, started_at_utc, ended_at_utc,
source_key}], input_ids, verify: {merged_samples, expected_samples}}`.

Apply (one hub transaction, as `media-apply`): re-read the recording's segments; if their ids
differ from `input_ids` (a chunk landed meanwhile) set the job `cancelled` (error
`inputs-changed`), remove the worker's directory and enqueue a new merge; if the session holds a
`transcript-generation` or `youtube-import` run lease, leave the job `done` for the next tick
(panel C: a generation run reads blobs for many seconds and must never meet a row whose blob was
just trashed); else insert one row (id derived from the job, `ordinal` = the first input's, the
recording's `recording_ordinal`, `started_at_utc` = first input's, `ended_at_utc` = last input's,
`mime_type`, the copied blob's `r2_key`, `duration_ms`, peaks, `media_status = 'done'`), repoint
the seam rows at the new segment with their offsets, delete the input rows, trash their blobs
**using the re-read rows' `r2_key`s, never the result**, bump revision, broadcast `audio.changed`,
mark `applied`. Crash anywhere before commit leaves the chunks untouched and the job `done`; the
next tick retries (the blob copy is the only step outside the transaction and is idempotent
through the derived key).

- **Why not pad the gaps with silence:** Opus and AAC silence would have to be encoded with the
  stream's exact parameters and spliced into container timestamps (AAC priming, WebM clusters), a
  re-encode-adjacent path with no lossless guarantee; and the gaps are 20-65 ms per rollover
  (chunked-live-recording spike), so back-to-back concatenation drifts under 0.4 s per hour.
- **Seams keep wall-clock alignment everywhere.** Seams live in `catalog.session_audio_seams`
  (`session_id, recording_ordinal, started_at_utc, ended_at_utc, segment_id, offset_ms,
  source_key`; primary key `(session_id, recording_ordinal, started_at_utc)`): one row per chunk
  window ever accepted, pointing at the row that holds its audio (the chunk itself until a merge,
  offset 0; then the merged segment with the chunk's media offset). The segment dict exposes them
  as `seams`. The transcript remap (D9) and the timeline (D16: one clip per seam, each positioned
  from its own `started_at_utc`) both use them, so neither words nor playback drift with the
  accumulated rollover gaps (panel C: 0.34-1.1 s over 3 h for a single linear clip). Events are
  wall-clock/timecode anchored and never referenced a segment. The same table is the index behind
  the idempotent segment POST (D18).
- **Mime/codec families:** Chrome/Firefox Opus (WebM or Ogg) → one WebM; Safari AAC/MP4 → one MP4
  (mediabunny's existing AAC path); PCM (legacy) → FLAC. MP3 is a one-file family and is never
  merged (import only).
- **Idempotency/crash safety:** the job is unique per `(merge, session, ordinal)`; the worker
  writes to `media/<job>/` and a crash leaves at most an orphan directory the API's trash sweep
  removes with its job after 7 days; the swap is one transaction.

### D8. Trash and grace period

The API never deletes a replaced or converted blob in place. It renames it to
`BLOB_DIR/.trash/<yyyy-mm-dd>/<r2_key>` (same filesystem; `.trash` is a dot directory like `.tmp`
so `sync-from-disk` and `list()` never see it). `sweepTrash` (next to `sweepStaleBlobPutTemps`,
on the API's 10 min timer) deletes day directories older than 7 days (owner answer 2). README
documents the restore (`mv` back and `sync-from-disk`) and the disk cost (chunks of a recording
are held twice for a week; prod has 80 GB). The worker may read `.trash/` (D7, rebuilding from
originals) but never write it.

**Low-disk mode** (panel B): `MEDIA_MIN_FREE_BYTES = 10 GiB`, a design-owned compiled constant in
`packages/storage/src/mediaLimits.ts` that both the API and the worker import (no environment
variable: the worker's environment stays the five connection literals plus `BLOB_DIR`, D15; the
API uses it with `UPLOAD_PART_BYTES` and the per-user caps). When `statfs` on
`BLOB_DIR` reports less, the sweep purges trash oldest-first until the floor is met (the grace
period shortens, never the live data), the API refuses new uploads and parts with `507` (D12), and
the worker claims no `merge` and no job whose `input_bytes × 2` exceeds the free space (requeued
`low-disk` with backoff), so a merge never fills the disk with its second copy. The API logs one
warning per transition into and out of low-disk mode.

### D9. Seam-aware transcript remap

`SegmentAnchorInfo` gains `seams: {offsetSec, startedAtUtc}[] | null`. For a word at within-segment
offset `t` of a segment with seams, the owning seam is the last one with `offsetSec <= t`; its
anchor is `A + max(0, (startedAtUtc(seam) − wall(E)) / 1000)` and the position is `anchor +
(t − offsetSec)`. A segment without seams is unchanged (delta-0 identity pinned by the existing
tests). `generateTranscriptWords` passes `seams` from `AudioSegmentMeta` (read from the seams
table). Paragraph and sentiment remapping go through the same function.

**Generation and the swap** (panel C): a listed segment whose blob is missing fails the run with
`502` naming the segment instead of being skipped: once the worker swaps rows in one transaction,
a row without bytes is a restore in progress or a bug, and skipping it would produce a transcript
with a silent hole. The apply step defers merges while a `transcript-generation` run lease is
held (D7), and the replace transaction re-checks the segment set it read.

### D10. Browser persistence: OPFS in a worker, IndexedDB fallback, in-progress appends

`web/src/pages/index/utils/chunkStore/` exposes `openChunk(meta) → handle`, `append(handle,
bytes)`, `finalize(handle)`, `list() → RecoveredChunk[]`, `read(id) → Blob`, `remove(id)`,
`estimate()`. Backends: **OPFS** through a dedicated Worker (`createSyncAccessHandle`; the only
OPFS write API Safari supports) with a `manifest.json` per chunk (`userId, sessionId,
recordingOrdinal, chunkIndex, startedAtUtc, endedAtUtc, mimeType, bytes, sliceLog: [{at,
bytes}], finalized, pendingFinalize`); **IndexedDB** (`autologger-chunks`, one record per chunk
with its `Blob` parts) when OPFS or workers are unavailable; **memory** (today's behaviour) when
both fail or quota is short, with one warning. The layout is per user:
`autologger-chunks/<userId>/…` (panel A, shared machines): the store lists only the signed-in
user's directory; sign-out first warns when that user has unsent chunks (the leave-warning copy)
and then wipes the directory; another user's directory is never read or shown.

The recorder calls `mr.start(PERSIST_SLICE_MS = 5000)` (owner answer 3: a crash loses about 5 s;
Safari records without a timeslice, see the Safari branch below);
each `dataavailable` blob is appended to the open chunk. Timeslice blobs after the first are
continuations of one file, so the appended bytes equal the no-timeslice file (spike 0.2 pins this
on Chromium and Firefox; for Safari the spike decides between appends and finished-chunks-only
persistence). The upload reads the chunk back as one `Blob`. On confirmed upload (200, or the
dedupe match) the chunk is removed.

**Ownership across tabs** (panel A blocker): the recorder holds a Web Lock
`autologger:recording:<sessionId>:<ordinal>` for the whole take, and the uploader holds
`autologger:chunk:<chunkId>` for each attempt. The recovery scan requests each stored chunk's lock
with `ifAvailable: true` and skips (does not enqueue, does not show) any chunk whose lock is held,
and any chunk whose recording lock is held: a second tab therefore never recovers a chunk the
first tab is still recording or uploading. When `navigator.locks` is unavailable the manifest's
`heartbeatAt` (refreshed every 10 s by the owner) acts as a 30 s lease with the same rule.

Recovery: `getChunkUploadQueue()` scans the store once per page load and enqueues every unlocked
stored chunk of the current user with its persisted metadata (`recovered: true`). A recovered
chunk starts in the `ambiguous` state, so its first step is the segments-list check and the
server's idempotent POST (D18) is the second guard: a chunk the server already accepted before
the crash (before `remove()` ran) is matched by `(recording_ordinal, started_at_utc)` against the
live rows and the seams of merged rows, and never stored twice (panel A, panel C). A partial
chunk is enqueued with `partial: true`; its `ended_at_utc` is `started_at_utc + measured duration`,
where the duration is probed from the recovered bytes (a media element; when the probe is not
finite, the byte count over the slice log's bytes-per-second), and the manifest's last write time
is only the fallback: the stored bytes, not the manifest, are the truth. The rescue surface shows
"Recovered N chunks (≈M min) from a previous session" with Upload all / Download / Discard;
uploads flow through the same single-flight queue. **Record is disabled until the scan has
completed** (panel A), and `deriveNextOrdinal` counts the recovered ordinals, so a new recording
never reuses one.

Quota and eviction: `navigator.storage.persist()` is requested when a recording starts (best
effort: Chrome grants it silently on site engagement or an installed PWA, Firefox prompts, Safari
grants only to home-screen web apps); `estimate()` runs before each append and persistence stops
(memory fallback plus one warning) when the free quota is under 2 × the expected chunk size.
Safari evicts all script-writable storage of a site not used for 7 days (ITP), so a recovery on
Safari is only promised within 7 days; the rescue copy says so on Safari. Cleanup: removal on
confirm/discard; stored chunks older than 30 days are deleted at scan with a console warning.

**Spike 0.2/0.3 (2026-10-12).** Headless Chromium 156, Firefox 157, WebKit 27.2 (Playwright on
Linux aarch64; WebKit is a proxy, **Safari unverified**), fake microphone, 25 s, a timeslice
recorder and a no-timeslice recorder on the same stream.
- Concatenation: slice 0 starts with the container header (EBML `1a45dfa3` / `OggS` with BOS),
  later slices are continuations (Chromium `43c3…` mid-cluster, Firefox `OggS` pages). The
  appended slices decode (pinned ffmpeg `-xerror -f matroska|ogg -i pipe:0`, and
  `decodeAudioData`) to the same codec, 48 kHz mono, and the **same sample count** as the
  no-timeslice file (24.96 s Chromium, 25.387 s Firefox). The bytes are **not** equal: "the
  appended bytes equal the no-timeslice file" above is superseded by "decode to the same stream".
  Chromium's no-timeslice WebM now carries SeekHead/Cues/Duration; the concatenation has none
  (live-style unknown-size clusters), so ffprobe and the media element report no duration for it.
- Firefox records **Ogg/Opus** by default (`audio/ogg; codecs=opus`, no WebM unless asked), and
  its final slice arrives after `stop()`; the store must accept `ogg` (D4's allowlist has it)
  and take the MIME type from the first blob's `.type` (as the recorder already does).
- Prefix: the first 3 slices decode with ffmpeg and `decodeAudioData` (Chromium 15.06 s, Firefox
  14.793 s, Chromium-MP4 15.1 s). A prefix cut mid-slice decodes for WebM/Ogg but fails `-xerror`
  for MP4, so recovery trims a partial chunk to `sum(sliceLog.bytes)` (the last fully appended
  slice) and the duration probe uses that prefix.
- Duration probe: the media element gives `Infinity` for Chromium's concatenated WebM (finite for
  Firefox Ogg and Chromium MP4), so on Chromium the slice-log fallback (or `decodeAudioData` of
  the prefix) is the normal path, not the exception.
- Persistence (0.3): worker `createSyncAccessHandle` write/append/flush/read and IndexedDB `Blob`
  parts round-trip on all three with a persistent profile. In an ephemeral WebKit context (the
  proxy for Safari Private Browsing) `navigator.storage.getDirectory()` throws `UnknownError`
  and the IndexedDB `Blob` put fails too, so backend selection must **probe with a real write**
  (not feature-detect) and fall through to memory with the one warning. `locks.request(name,
  {ifAvailable: true})` in a second tab of the same profile gets `null` while the first tab holds
  the lock (all three), so the cross-tab rule works as designed. `estimate()`: Chromium quota
  ≈10 GiB, Firefox 10 GiB, WebKit 1000 MiB; `persist()`: Chromium `false` (no engagement),
  WebKit `false`, Firefox did not settle in 5 s (prompt pending in headless), so the recorder
  must not await `persist()` before `start()`.
- Safari branch: **decided finished-chunks-only** (owner decision 2026-10-12, task A.11; edit after
  approval): no Safari was available for spike 0.2, so Safari records each chunk without a
  timeslice and persists it when it completes (`SAFARI_PERSIST_MODE = 'finished-only'` in
  `AudioRecorder.tsx`; a crash loses at most the chunk in progress, as before this change).
  It switches to `slices` once the owner's Safari run of the spike page shows the concatenated
  slices decode with `decodeAudioData` and ffmpeg.

### D11. Timed retry, classification, finalize, throttle-proof timers

- Backoff: `delay = min(300 s, 2 s × 2^(attempt−1)) × U(0.5, 1.5)` per chunk, persisted as
  `nextAttemptAt`. A 1 s scheduler tick on `createWorkerInterval` runs while the queue is
  non-empty and pumps when a chunk is due; `online` pumps at once and resets the delay; `offline`
  suspends the tick and does not count attempts. Rollover, stop and Retry still pump.
- Classification: transient (network, 5xx, 408, 429) → backoff; `401`/`403` → `blocked`
  (sign-in lost; the surface says "Sign in again in another tab, then Retry"); `404`, `400` →
  `permanent`; `413` (a chunk over 50 MB, possible after a throttled or re-acquired long chunk)
  → the chunk is re-sent through the parts upload in segment mode (D12) instead of being parked.
  **Retry re-attempts `blocked` and `permanent` chunks too** (user-initiated, one attempt each);
  only the automatic scheduler skips them. The single-flight rule and the ambiguous dedupe are
  unchanged.
- Finalize (D6) is sent with the recording's chunk windows when the last chunk is confirmed;
  `pendingFinalize` (with the window list) is persisted with the chunk store so a recovery
  completes it.
- The rollover and heartbeat intervals move to `createWorkerInterval` (exempt from intensive
  throttling); `pagehide` keeps releasing the lease by beacon and additionally requests a final
  `dataavailable` (`mr.requestData()`). That request is best effort (the page may be gone before
  the slice is written), so the promise is "at most one slice is lost", with or without it.

### D12. Resumable upload for big imports

Routes (all under `/api/sessions/:sessionId/audio/uploads`, login and session access as the
segment routes):
- `POST` `{content_type, size_bytes, part_sha256: [hex, …]}` → `201 {upload_id, part_size,
  parts_total, expires_at_utc}`; `part_size` is the server constant `UPLOAD_PART_BYTES = 32 MiB`
  (under the 50 MB live cap and the 100 MB tunnel limit); `part_sha256` has exactly `parts_total`
  entries of 64 lowercase hex (the client hashes each ≤ 32 MiB part with WebCrypto, never the
  whole file in one `ArrayBuffer`); `size_bytes > 1500 MiB` → `413 {detail}`; a blank
  `content_type` or a bad hash list → `400`. **Abuse caps** (panel B): at most 2 open uploads and
  `UPLOAD_MAX_STAGED_BYTES_PER_USER = 3 GiB` of staging per user → `429 {detail}`; free space on
  `BLOB_DIR` below `MEDIA_MIN_FREE_BYTES` (D8) at create or at any part → `507 {detail}`.
- `PUT /:uploadId/parts/:n` (raw bytes, `n` 1-based): every part but the last must be exactly
  `part_size`, the last `size_bytes − (parts_total−1) × part_size`; the server hashes the body
  while writing it at offset `(n−1) × part_size` into `BLOB_DIR/.tmp/upload-<id>` (preallocated
  sparse file, API-owned, never under `audio/`) and compares with `part_sha256[n]` (`400
  {detail}` on mismatch, the part is not recorded); a part may be re-sent; `204`; wrong size
  `400`; over `part_size` `413`; unknown, expired or completed upload `404`; low disk `507`.
- `GET /:uploadId` → `200 {upload_id, status, size_bytes, part_size, parts_total, received: [n…],
  expires_at_utc}`.
- `POST /:uploadId/complete` in one of two modes: **import** (`?duration_s=…` and the optional
  `X-Audio-Seam-Parts` header, exactly `local-audio-import`'s semantics: `409` while rolling with
  the post-put re-check, the anchor, appended seam parts) or **segment** (`?recording_ordinal=&
  started_at_utc=&ended_at_utc=`, exactly the segment POST's semantics including D18 idempotency,
  for a live chunk over 50 MB). It verifies all parts received (`409 {detail, missing_parts}`),
  the file size, and the **whole-file check the server builds itself**: it re-hashes every part of
  the staged file and compares with the declared list, plus the file size (a mismatch is `400
  {detail}` and aborts the upload); then the staged file is renamed into place (API-owned inode)
  instead of a body read; `200 {ok: true, segment_id}`.
- `DELETE /:uploadId` → `204`; staging removed.
- Rows in `catalog.media_uploads` (`id, session_id, created_by_user_id, content_type, size_bytes,
  part_size, parts_total, part_sha256_json, received_json, status, expires_at_ms,
  created_at_ms`), RLS: system all, `catalog_user` rows of sessions it can access that it
  created. Uploads expire 24 h after their last part; the API's sweep deletes expired rows and
  staging files.
- Client: files over `IMPORT_PARTS_THRESHOLD_BYTES = 40 MiB` (and every stitched WAV over it) use
  the parts flow, one part in flight, the same backoff as chunks; `upload_id`s are remembered in
  IndexedDB (never `sessionStorage`, which a new tab does not share) keyed by the **file-group
  identity** (the group's ordered file names, sizes and last-modified times) for 24 h, so a re-run
  of the same folder resumes. Smaller files keep `local-audio-import` unchanged.

### D13. Worker image and build

`docker/media-worker.Dockerfile` (the `companion.Dockerfile` naming): stage `node` = the pinned
`node:22-bookworm-slim@sha256:…` already used by `docker/Dockerfile`; final stage = the pinned
`linuxserver/ffmpeg:9.0-cli-ls84@sha256:a7182d4f…` (the same ffmpeg `#107` verified, multi-arch)
with `/usr/local/bin/node` copied from `node`, the worker's `src/**`, the workspace packages it
imports and their production dependencies, `USER 10001`, `ENTRYPOINT ["node", …]` (the image's
own `ENTRYPOINT`/`CMD` overridden). Spike 0.1 verifies node runs there on both architectures; the
recorded fallback is a static ffmpeg per architecture pinned by sha256 onto the node image, the
`yt-dlp`/`deno` pattern. **Spike 0.1 (2026-10-12)**: the DRAFT
`docker/media-worker.Dockerfile` (`COPY --from=node /usr/local/bin/node`, `USER 10001:10001`,
`ENTRYPOINT ["node"]`) builds with `docker buildx build --builder default --platform
linux/{arm64,amd64}` (amd64 via QEMU). Each, run `--user 10001:10001 --read-only --tmpfs /tmp
--cap-drop ALL --security-opt no-new-privileges:true --network none --init`: `node --version` →
`v22.23.3`; `ffmpeg -version` → `ffmpeg version 9.0`; `ffmpeg -nostdin -hide_banner -loglevel
error -xerror -protocol_whitelist pipe -f matroska -i pipe:0 -f f32le -acodec pcm_f32le pipe:1 <
seg1.webm | wc -c` → `115200`, rc 0 (pipefail). Node runs on the base, so the static-ffmpeg
fallback is not needed. Image sizes before app code: arm64 583 MB, amd64 920 MB. `docker-bake.hcl` adds target `media-worker` (`platforms` from
`_common`, tag `${REGISTRY}/autologger-media-worker:${GIT_SHA}`) to group `default`, so
`prod-push` and `stage-push` build and push it unchanged. Dev builds it locally
(`autologger-dev-media-worker:local`); stage `${STAGE_MEDIA_IMAGE:-autologger-stage-media-worker:local}`;
prod `ghcr.io/kwcantrell/autologger-media-worker:${MEDIA_TAG:?…}`.

**Pin ownership** (panel B): the ffmpeg digest lives once, as `ARG FFMPEG_IMAGE=…` in the
Dockerfile with a `# reviewed YYYY-MM-DD` comment, and `server/scripts/blobSegmentRows.ts`'s
constant is pinned to the same value by a repo test. Dependabot's `docker` ecosystem is enabled
for `/docker` so digest bumps arrive as PRs; the quarterly rule review (AGENTS.md 11) re-reads
the pin date. A bump is a tier 1 change (new image digest, same major).

### D14. Workspace layout

`media-worker/` is a new npm workspace (like `companion/`): `src/main.ts` (loop, LISTEN, heartbeat
file), `src/db.ts` (`postgres` client; the claim/renew/finish statements imported from
`packages/storage/src/mediaJobs.ts`), `src/ffmpeg.ts` (spawn, limits, classification),
`src/sniff.ts` (container detection and the MP4 atom scan), `src/jobs/ingest.ts`,
`src/jobs/merge.ts`, `src/verify.ts`, `src/peaks.ts`; depends on `@autologger/domain` (peaks
math), `@autologger/storage` (the job statements and `mediaLimits`) and `@autologger/transcription`
(`mergeAudioSegments`, `probeSegment`), all already in the layer graph below apps. It has unit
tests (fake ffmpeg, fake db), `*.ffmpeg.test.ts` tests that skip without ffmpeg (the `#107`
convention) and pg tests for the claim statement. Root `test`/`typecheck` scripts gain the
workspace; the package-architecture repo test learns the new app.

### D15. Secrets, scopes and static invariants

- New KV key `MEDIA_DB_PASSWORD` (lowercase hex ≥ 32, generated by `supabase-keys.mjs` like
  `APP_DB_PASSWORD`). `SECRET_SCOPE`: `{dev: ['media-worker','migrate'], stage: ['media-worker',
  'migrate'], prod: ['media-worker','migrate']}`; `SUPABASE_KEYS`, `KEY_FORMAT`, and
  `check-envs.sh`'s `SB_SECRETS`/`SB_SCOPE` mirror it. The worker's environment is five literals
  (`PGHOST=db`, `PGPORT`, `PGDATABASE`, `PGUSER=autologger_media`, `PGPASSWORD=${MEDIA_DB_PASSWORD}`)
  plus `BLOB_DIR=/blobs`; it does not `extends` the allowlist file, and every limit it applies
  (`MEDIA_MIN_FREE_BYTES`, the lane size, the timeouts) is a compiled constant, not a variable
  (D8), so `check-envs.sh` can pin the worker's environment to exactly those six names.
- `COMPOSE_KEYS.prod` gains `MEDIA_TAG`; `checkProdTags` refuses it unset or `latest`; stage with
  a tag pulls `web api media-worker` and `checkStageResolved`/`parseStageOptions` cover the third
  image.
- `check-envs.sh`: invariant 16 gains "`media`'s members are exactly `db` and `media-worker`;
  `media-worker`'s networks are exactly `media`; `db`'s networks are exactly `db`, `catalog`,
  `media`; `media` is internal, host-isolated, on its pinned subnet; `media-worker` publishes no
  port, runs `read_only` as a non-zero uid with `cap_drop ALL`"; invariant 6's dev service set
  adds `media-worker`; the `MEDIA_DB_PASSWORD` scope row.

### D16. API additions and web consumers

- `segmentApiDict` adds `duration_ms: number | null`, `media_status: 'pending' | 'done' |
  'failed' | null` and `seams: {offset_ms, started_at_utc, ended_at_utc}[] | null` (null for a
  segment with a single seam at offset 0 or none); `fixtures/api-responses/audioSegment*.json`
  are regenerated; `web/src/api/types.ts` and its conformance test list 12 keys.
- `useAudioClips` uses `duration_ms` when present and probes only when it is null. **A merged
  segment is laid out as one clip per seam** (panel C): each clip has the segment's URL, a media
  offset `offset_ms` (seek = position − clip start + offset), and its position is derived from
  the seam's own `started_at_utc` exactly as a chunk's was, extending to the next seam's position
  (the last to the interval end or its duration), so the layout, feed-row seeks and playback are
  identical to the pre-merge chunk layout and no linear drift accumulates (0.34-1.1 s over 3 h
  measured for a single clip). `useWaveforms` draws the merged segment's peaks across its seams
  by media offset.
- `useWaveforms` skips the decode fallback while `media_status === 'pending'` (the slot shows
  "Generating waveform…", then the server's peaks arrive on `audio.changed`), and decodes as today
  for `null`. The timeline shows "Finalizing recording…" in the waveform slot of an interval that
  still has two or more segments with a pending merge (any of them `media_status: 'pending'`).

### D17. Wake Lock and the hidden-tab warning (owner answer 4)

While `phase === 'recording'` the recorder holds a screen Wake Lock (`navigator.wakeLock.request
('screen')`, best effort: refused or unavailable is logged once, never an error), releases it on
stop, and re-requests it on `visibilitychange` back to `visible` (the browser drops the lock when
the page is hidden). When the document becomes hidden during a recording, the recorder shows a
persistent in-page warning the user sees on return ("Recording continued in the background;
browsers may throttle a hidden tab, keep this tab visible") and logs the hidden interval's start
and end to the console; the warning clears on the next user action. Mobile Safari suspends a
hidden page's capture regardless; the warning says so there. Neither mechanism affects the
timers, which already run on worker intervals (D11).

**Spike 0.2/0.3 (2026-10-12).** `navigator.wakeLock` exists in Chromium 156, Firefox 157 and WebKit
27.2 (proxy). Headless `request('screen')`: Chromium `NotAllowedError: Wake Lock permission
request denied`, WebKit `NotAllowedError: Permission was denied`, Firefox **granted**. Refusal is
therefore a normal outcome and the "logged once, never an error" rule stands; a granted lock in
a visible headed tab is expected but unverified here (Safari: owner check).

### D18. The segment POST is idempotent per recording window (panel A, panel C blockers)

`POST …/audio/segments` with a `recording_ordinal` and `started_at_utc` first looks the window up
in `session_audio_seams`; a hit answers as a successful upload with the dict of the segment the
seam points at (the chunk itself, or the merged segment that absorbed it) and stores nothing. A
miss writes the blob first (B.8) and then inserts the row, its seam row (offset 0, `source_key` =
its key) and the ingest job in one transaction (a lost race or a failed insert deletes the
just-written blob); the unique primary key on `(session_id, recording_ordinal, started_at_utc)` makes a
concurrent duplicate from two tabs fail with `23505`, which the route turns into the same
"existing" answer. The client-side dedupe keeps using the normalised `started_at_utc` the server
stores (pinned by a test on `parseOptionalMarkedAt`), so the recovered chunk, the lost-response
retry and the two-tab race all converge on one stored copy. Uploads without a `recording_ordinal`
(legacy sync, imports) are unchanged.

### D19. Microphone loss is recovered, not final (panel A)

An unexpected recorder `onstop`, a track `ended`, or a `devicechange` that removes the active
input no longer ends the take. The recorder keeps the take open, persists the chunk captured so
far (D10), and re-acquires the microphone: `getUserMedia` with the previous `deviceId` first,
then the default input, retried on the chunk backoff for up to 60 s; on success it starts the
next chunk index on the new stream (the take's ordinal, lease and events unchanged), re-binds
the level meter, and shows a persistent notice "Microphone changed; recording continues". Only
when re-acquisition fails for 60 s does the recorder finalize the take as today, with the
reason. A `devicechange` while the current track is still live only logs. A rollover boundary
reached with no live track waits for the re-acquisition instead of ending the take.

### D20. Frame-bus exposure of the worker login (panel B)

`LISTEN`/`NOTIFY` carry no privilege in PostgreSQL (A15), so the worker's login can listen on the
frame-bus channel and flood `pg_notify`. Messages are HMAC-signed and replay-guarded (security.md
"NOTIFY forgery"), so the worker cannot forge a frame; the residual is a flood that costs a
signature check per message and can fill the notification queue. Mitigations: the role's
`statement_timeout` and connection limit (4) bound one connection's rate; the API's lease
sweeper reads `pg_notification_queue_usage()` every minute and logs a warning above 0.5 (and the
frame bus already drops on overflow); `docs/security.md` records the accepted risk under the
untrusted-media row. No further restriction is available short of a separate database.

## Root-cause notes for the lost recording

Plausible loss paths in the pipeline as it stands at `3d145c41`, and what closes each. The owner
may later supply the date and environment; the server's segment rows and `Recording N
Started/Stopped` events for that session will tell which path it was (chunks missing at the end =
1, 2 or 4; a `Started` with no `Stopped` = crash; all chunks missing = 3 or 5).

| # | Path | Where | Closed by |
| --- | --- | --- | --- |
| 1 | Reload, tab close, tab crash or OOM: the in-progress chunk exists only in MediaRecorder's buffer (no timeslice, `AudioRecorder.tsx:620`) and the closure's `localChunks` (:581); every queued chunk is a `Blob` in an array (`chunkUploadQueue.ts:141`). `pagehide` only releases the lease (:875-884); `beforeunload` is a prompt. Up to 10 min plus every unsent chunk is gone. | `AudioRecorder.tsx:581,620,875-903`; `chunkUploadQueue.ts:141` | D10 (appends every 5 s, chunks persisted until confirmed, recovery on next load), D11 (`requestData` on `pagehide`) |
| 2 | Network outage or server restart: a transient or ambiguous failure breaks the pump loop (`chunkUploadQueue.ts:301-304,326-328`); the next attempt is the next rollover (`AudioRecorder.tsx:614`), up to 10 min later, so chunks pile up in memory and sit exposed to path 1 | `chunkUploadQueue.ts:296-328`; `AudioRecorder.tsx:614` | D11 (backoff from 2 s, `online` pump), D10 |
| 3 | Permanent 4xx mid-take: a sign-in expiry (`401`), a revoked grant or deleted session (`404`) marks the chunk `permanent` (:315-320); `nextAttemptable` never returns it (:212-214), so **Retry is a no-op** and every later chunk after a `401` is rescue-only; the only exits are Download or Discard | `chunkUploadQueue.ts:127-129,212-214,315-320`; banner `ChunkRescueBanner.tsx` | D11 (`blocked` class with a sign-in hint, Retry re-attempts every class), D10 (chunks survive a reload to sign in) |
| 4 | Background-tab throttling: the rollover and heartbeat run on main-thread `setInterval` (`AudioRecorder.tsx:732-741`); Chrome coalesces hidden-tab timers to once a minute (`workerInterval.ts:3-8`). Rollovers drift (bigger chunks, longer exposure), heartbeats can exceed `LEASE_STALE_MS = 40 s` (`leaseStore.ts:36`) and another client can take the lease | `AudioRecorder.tsx:732-741`; `workerInterval.ts:3-8` | D11 (`createWorkerInterval` for both timers) |
| 5 | Lease loss: a `409` on re-claim only toasts (:394-397); capture and uploads continue, but a second recorder on the session produces interleaved ordinals and `deriveNextOrdinal` (:124-143) sees the other client's chunks late, so the timeline groups chunks wrongly or the user, seeing the warning, stops and discards | `AudioRecorder.tsx:124-143,386-414` | Unchanged by design (lease stays advisory, non-goal); D10 makes "stop and discard" recoverable; the finalize/merge makes the end state one segment per ordinal |
| 6 | Mic or track ends (device unplugged, Bluetooth switch, a permission revocation, sleep, an iOS interruption): an unexpected `onstop` or a dead track at a boundary ends the take with a toast and never restarts (:641-645,617,485-490); everything after is unrecorded. The panel rates this the likeliest real-world loss for a live recording | `AudioRecorder.tsx:485-490,617,641-645` | D19 (re-acquire the microphone and continue the take; finalize only after 60 s of failure), D10 (what was captured is on disk), D17 (hidden-tab warning) |
| 7 | Rollover gap: `stop()` then a new recorder with no overlap loses 20-65 ms per boundary | `AudioRecorder.tsx:647-649` | Accepted; D7 seams keep alignment, no silence padding |
| 8 | Safari: no `isTypeSupported`/mime choice; `audio/mp4` only handled for the download extension; no `visibilitychange`; duration probes give `Infinity`/`NaN` → 1 s placeholder | `AudioRecorder.tsx:576`; `ChunkRescueBanner.tsx` ext map; `useAudioClips.ts:34`; `audioClips.ts:432` | D5/D16 (server duration), D10 (spike 0.2/0.3 decide Safari persistence), merge of AAC by the MP4 family |
| 9 | Memory: an unbounded in-memory `Blob` queue during a long outage (one ~10 MB chunk per 10 min) until the tab is killed (path 1) | `chunkUploadQueue.ts:141` | D10 (storage, with quota handling) |
| 10 | Dedupe edge: the ambiguous dedupe compares `started_at_utc` strings exactly (:226-230) while the server normalises through `parseOptionalMarkedAt` (`audio.ts:206`); a mismatch duplicates rather than loses | `chunkUploadQueue.ts:226-230` | Pinned by a test in WS-A (normalisation equal on both sides); the merge would otherwise double audio |
| 11 | Crash recovery today only offers a synthetic `Recording N Stopped` (`useRecoveryStopWarning.ts:42-104`); the tail audio is not recoverable | `useRecoveryStopWarning.ts:42-104` | D10 (the tail is in storage and uploads; D6 finalize then merges) |
| 12 | Construction order: if `ChunkRescueBanner` ever built the queue singleton first, its fallback deps throw status-less errors, every upload is `ambiguous`, `listSegments` fails `lookup-failed`, and chunks stick until reload | `ChunkRescueBanner.tsx` fallback deps | WS-A removes the fallback deps (the queue is constructed with real deps by a module-level provider) |

## Owner answers (2026-10-11, after the panel)

1. Recordings chunked before this change are **not** auto-merged; only the operator script (D6).
2. Trash grace period: 7 days (D8).
3. Crash-loss target about 5 s: 5 s timeslices to OPFS stay (D10).
4. Wake Lock and a visible hidden-tab warning are **in scope** (D17); the non-goal is withdrawn.
5. The lost recording was a **live** recording (date and environment still unknown); the
   root-cause table above applies, and path 6 is now closed by D19.

Still open: the design-owned constants (`UPLOAD_PART_BYTES = 32 MiB`,
`IMPORT_PARTS_THRESHOLD_BYTES = 40 MiB`, `PERSIST_SLICE_MS = 5 s`, backoff cap 5 min, reconcile
after 30 min, `MEDIA_MIN_FREE_BYTES = 10 GiB`, 2 open uploads and 3 GiB staged per user); object
if any is wrong.

## Edits after approval (consistency read 2026-10-12)

Implementation changed or refined these decisions after the 2026-10-11 approval. The inline
"Edit after approval" and "Spike" notes above (A10-A13, D3, D4, D5, D7, D10, D13, D17) stay
where they are; this list adds what the code does that the text above did not say. None changes
a route, a status, a response shape or the worker's privileges.

- **D2 guard trigger** (S.2, S.7): besides the two transitions it allows `running → running` (a
  renewal), keeps the holder on every `running` exit, lets a re-queue give the claim's attempt back
  only under a live lease (the worker's `release`), and bounds the worker's values on the database
  clock (`locked_until_ms` ≤ now + 15 min, a changed `run_after_ms` ≤ now + 2 h). The trigger
  cannot tell workers apart (one role); identity is each statement's `locked_by = <id>` fence.
  `media_jobs_error_code` checks `error` against the codes listed in D2 plus `inputs-changed`
  (set by the API's apply, D7).
- **D2/D3 wake-ups** (B.5 deviation): the worker `LISTEN`s on `media_jobs` and polls every 5 s as
  designed, and still `NOTIFY`s `media_jobs_done`; the API does **not** listen (the server has no
  `postgres` client of its own) and applies every 10 s. media-processing "The API applies worker
  results" still says "and on a payload-free notification" (open finding in `panel.md`).
- **D3 apply** (B.9): a merge's result seams must be exactly the inputs' held windows plus the
  `started_at_utc` of seamless input rows, offsets in `[0, duration_ms]` and strictly increasing
  in window order; `ended_at_utc` and `source_key` come from the database, never the result; else
  `invalid-result`. The apply cancels a job only when its session is gone (`SessionNotFoundError`);
  any other error leaves it `done`. A failed job's `error` reaches `media_error` only as a fixed
  code (else `internal`). Shutdown awaits an in-flight pass.
- **D3/D18 blob before row** (B.8): every create path (segment POST, the upload's segment and
  import modes, local-audio-import, YouTube import, the apply's merged and FLAC rows) writes the
  blob under its final key before the row, so a listed row always has its bytes. Crash residue
  is handled at boot by `trashOrphanBlobsOnce` (D8 below).
- **D4 modes** (S.7): `put`, `adoptCopy`, `adoptStaging` and `trash` leave 0644 files in 0755
  directories whatever the umask, so the 0600 `missing-blob` case applies only to blobs written
  before this change.
- **D5/D7 per-attempt outputs** (W.8): each attempt writes `converted-a<n>.flac` /
  `merged-a<n>.<ext>` and its scratch `a<n>.tmp/` in the shared `media/<job>/`; the worker never
  removes the directory (the API removes it after apply or in the orphan sweep), so a worker that
  lost its lease cannot delete the re-claimer's output.
- **D6 reconcile** (B.5, B.9): it also requires a seam row per segment (so a legacy recording given
  a status by the backfill is still never auto-merged), and a merge that failed `mixed-codecs` or
  `interleaved-input` records its input set (`session_meta` `media_merge_blocked:<ordinal>`); the
  reconcile skips that recording for as long as its segments are exactly that set, beyond the 24 h
  hold-off. Owner decision 2026-10-12: keep the block; the media-processing scenario is amended.
- **D3 apply wake-up** (B.5): the API only polls every 10 s; the worker's `media_jobs_done`
  notification is sent but not listened to (no `postgres` client in the server). Owner decision
  2026-10-12: polling only; the requirement text is amended.
- **Constants** (owner confirmation 2026-10-12): 5 s slices, 10 min chunks, 32 MiB parts, 40 MiB
  parts threshold, 2 s -> 5 min backoff, 30 min reconcile, 7-day trash, 2 open uploads and 3 GiB
  staged per user, 10 GiB free-disk floor.
  `enqueueMediaJobs.ts --merge` leaves out recordings with a row lacking `started_at_utc`.
- **D7 merge timestamps** (D.8): `mergeAudioSegments` writes every packet at the running end of
  what it wrote, advanced by the packet's exact duration (Opus TOC, FLAC block size, else the
  container's), because Chrome's last block has no duration and its block times are rounded to
  milliseconds; the timestamps are strictly increasing and each input's offset equals the earlier
  inputs' untrimmed sample sum, the unit the worker's seams use. A merge whose rows include a
  `NULL` `started_at_utc` fails `interleaved-input`, final (W.8).
- **D8 orphan blobs** (B.8): at boot the API moves to the trash (never deletes) any `audio/` blob
  older than 1 h that no row names, except a pending merge's copy. A blob restored from the trash
  keeps its old mtime, so `sync-from-disk` must run before the next API restart (README "Media
  jobs").
- **D10 locks and storage** (A.8, A.10): the queue holds a chunk's Web Lock for its whole stay in
  the queue (`holdChunk`, recovery included), not per attempt, and releases the take lock after
  that; an attempt waits for the queue's own pending hold, and real contention is logged and
  retried, not shown as a failure. Every OPFS call times out after 10 s (the backend is marked
  dead and the chunk degrades to memory, keeping the persisted prefix on disk); backend choice is a
  real write probe (3 s timeout).
- **D11 stop and diagnostics** (A.9, V.0, dev toast log): at Stop only a terminal failure
  (`blocked`, `permanent`) raises the error toast; a chunk still on its backoff keeps Record
  blocked and the rescue surface reads as a neutral status with its actions. Development builds
  (`NODE_ENV === 'development'` only) `console.warn` each failed attempt's class and HTTP status,
  log every toast to the console (`Toast.tsx`), and read a chunk-length override from
  `localStorage['autologger.dev.chunkMs']` (15 s..10 min, `devChunkMs.ts`, the "dev-only seam"
  task V.2 names). Production builds are unchanged.
- **D12 import memory** (D.6): besides the 24 h `upload_id` memory, the importer remembers for
  30 days the session it created for a parts upload, so a re-run after the upload memory expired
  resumes with a fresh upload into that session while it has no segments; a matching session it
  did not create, or one with audio, is still skipped.
- **D16 clip keys** (D.9): seam clips share their segment's id, so the timeline keys them by
  `<segment id>@<media offset>`.
