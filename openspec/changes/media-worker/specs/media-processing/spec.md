## ADDED Requirements

### Requirement: Media jobs are durable rows claimed under a lease
Audio post-processing work SHALL be represented as rows of `catalog.media_jobs` with a kind
(`ingest` or `merge`), the session, a target (a segment id for `ingest`, a `recording_ordinal` for
`merge`), a status (`queued`, `running`, `done`, `applied`, `failed`, `cancelled`), an attempt
count with a cap, an earliest-run time, a lease (`locked_by`, `locked_until_ms`), a result and a
classified error. At most one job per `(kind, session, target)` SHALL be live (`queued`, `running`
or `done`) at a time, so repeated enqueues coalesce. A job SHALL be inserted in the same database
transaction as the row that causes it (a new segment, a finalize, the apply of a merge), with the
inputs' total size recorded as `input_bytes`. A worker SHALL claim the due job with the earliest
`run_after_ms` (then creation time) with a single `FOR UPDATE SKIP LOCKED` update that sets the
lease and increments the attempts, renew the lease while it works, and on failure set the job
back to `queued` with an exponential earliest-run time (30 s doubling, capped at 1 h) or to
`failed` once the attempts reach the cap. Every later worker statement on a job SHALL be fenced
on `locked_by` and `status = 'running'`, so a worker whose lease was taken over changes nothing.
A `running` job whose lease has expired SHALL be treated as failed by any worker that sees it.
The worker SHALL run two lanes so small jobs are not starved: one lane claims only jobs whose
`input_bytes` is at most 64 MiB, the other any job. A worker's writes to `media_jobs` SHALL be
limited by column-level grants to the lease, attempt, schedule, result and error columns, and a
guard trigger SHALL allow the worker role only the transitions `queued → running` (when the lease
is free or expired) and `running → queued | done | failed` by the lease holder; `result_json`
SHALL be at most 256 KiB. Wake-up notifications carry no payload; receivers re-read the table.

#### Scenario: Two workers never run the same job
- **WHEN** two workers claim at the same instant with one queued job
- **THEN** exactly one receives the row, the other receives nothing, and the row is `running`
  with that worker's id

#### Scenario: A crashed worker's job is retried
- **WHEN** a job is `running` and its `locked_until_ms` has passed
- **THEN** the next claim or sweep sets it `queued` with a later earliest-run time (or `failed`
  when the attempts are exhausted), and its result is discarded

#### Scenario: Finalize and the reconcile coalesce
- **WHEN** a client finalizes a recording and the reconcile also selects it while the first job
  is still live
- **THEN** one `merge` job exists for that recording

#### Scenario: A failure is classified, never a path
- **WHEN** ffmpeg exits non-zero on a job for the last allowed attempt
- **THEN** the job is `failed` with one of the fixed error codes (`decode-failed`, `mixed-codecs`,
  `verify-mismatch`, `interleaved-input`, `missing-blob`, `timeout`, `low-disk`, `internal`,
  `invalid-result`) and no filesystem path or tool output is stored or logged

#### Scenario: The worker role cannot steer a job it does not hold
- **WHEN** `autologger_media` updates a `running` job whose `locked_by` is another worker, sets
  a `queued` job straight to `applied`, changes `kind`, `session_id` or `target`, or writes a
  300 KiB `result_json`
- **THEN** each statement is refused by the guard trigger, the grant or the check constraint

#### Scenario: A big import does not delay a chunk's waveform
- **WHEN** a 1.5 GiB import's ingest job is running and a 10 MB chunk's ingest job is queued
- **THEN** the small lane claims the chunk's job at once and its peaks arrive while the import is
  still decoding

### Requirement: The worker is sandboxed and computes only
The media worker SHALL run as a separate container in every stack: non-root (a uid other than the
API's), read-only root filesystem, no Linux capabilities, `no-new-privileges`, bounded CPU,
memory and pids, an init process, a healthcheck that needs no network, and exactly one network,
`media`, internal and host-isolated, whose only other member is `db`. It SHALL hold one secret,
its own database password, and connect as `autologger_media` (catalog-database "The media worker
connects as its own read-mostly role"). It SHALL run `ffmpeg` only from a digest-pinned build
(pinned once, in the worker's Dockerfile, with a review date; the operator scripts' pin is tested
equal), by argv (no shell), with a demuxer forced from the allowlist Matroska, Ogg, MP4, WAV, FLAC
and MP3 chosen by sniffing the file's first bytes, the input streamed on `stdin` with the protocol
whitelist `pipe` (only an MP4 whose `moov` atom follows its data may be read by `file:` path with
the `mov` demuxer forced and external references disabled), `-xerror` and a refusal of any
error-level diagnostic other than a truncated-file note, so a decode error (including a dropped
packet) fails the job, stdin otherwise closed, and a wall-clock limit after which it is killed; the worker itself
opens every input without following symlinks and only regular files under `BLOB_DIR/audio/` or
`BLOB_DIR/.trash/`. It SHALL read blobs there and write only under `BLOB_DIR/media/<job id>/`; it
SHALL write no segment row and no file under `audio/`, `.tmp/` or `.trash/`. The filesystem SHALL
enforce this: `audio/` and `.tmp/` are owned by the API's uid and not writable by others;
`media/` is a sticky world-writable directory the API owns. Its results SHALL be applied by the
API process (see "The API applies worker results"), never by the worker. The worker SHALL claim
no merge, and no job whose inputs twice over exceed the free space, while `BLOB_DIR` is below the
free-disk floor.

#### Scenario: The worker holds no app secret
- **WHEN** the running worker container's environment is listed
- **THEN** it contains `PGPASSWORD` equal to `MEDIA_DB_PASSWORD` and the five connection literals
  plus `BLOB_DIR`, and neither `APP_DB_PASSWORD`, `POSTGRES_PASSWORD`, `FRAME_BUS_SECRET`,
  `PROVIDER_KEYS_SECRET`, `JWT_SECRET` nor any other OpenBao value

#### Scenario: The worker cannot write a blob into place
- **WHEN** a process in the worker container tries to create or delete a file under
  `BLOB_DIR/audio/<session>/`
- **THEN** the operation fails with a permission error, while creating a file under
  `BLOB_DIR/media/<job>/` succeeds

#### Scenario: A hostile input is contained
- **WHEN** a job's blob is crafted so that ffmpeg hangs or allocates without bound
- **THEN** the process is killed at the wall-clock limit or by the memory limit, the job records
  `timeout` or `decode-failed`, the worker continues with the next job, and no other container is
  affected

#### Scenario: The worker reaches only Postgres
- **WHEN** the worker container resolves or connects to any address other than `db` on the `media`
  network
- **THEN** the connection fails (the network is internal and the container joins no other)

#### Scenario: ffmpeg cannot be steered to another file
- **WHEN** a job's blob is an HLS playlist, an ffconcat script, or an MP4 with an external data
  reference
- **THEN** the sniff refuses the first two (`decode-failed`) and the third decodes only its own
  samples; no file other than the input is opened by ffmpeg

### Requirement: Every new segment is probed, given peaks and normalised on ingest
Every new audio segment row (live chunk, import, completed parts upload, YouTube import,
sync-from-disk) SHALL be inserted with `media_status = 'pending'` and an `ingest` job; a merged
segment is the exception, inserted `done` by the apply step with the merge's own peaks and
duration and no job. The worker SHALL decode the blob once, streaming, to produce its exact duration
(`duration_ms`, from decoded frames and sample rate) and its waveform peaks with the shared
`DbPeaksAccumulator` math and the per-segment bucket rule (`packages/domain/src/waveformPeaks.ts`),
so the browser never has to decode a new segment. For a WAV whose header is 16- or 24-bit integer
PCM it SHALL also produce a FLAC (`-compression_level 8`) and verify it: equal STREAMINFO
parameters, equal decoded-PCM md5 and byte count, equal sample count. Applying the result SHALL set
`duration_ms`, the peaks (floor −48 dB) and `media_status = 'done'`, and for a verified FLAC
swap `r2_key`/`mime_type` to the FLAC and trash the WAV. A job that fails for good SHALL set
`media_status = 'failed'` and `media_error` to the error code. Rows that predate this requirement
keep `media_status = NULL` and are processed only when an operator enqueues them.

#### Scenario: A live chunk gets server-side peaks and duration
- **WHEN** a chunk upload succeeds and the worker is running
- **THEN** within a few seconds the segment lists `duration_ms` within 50 ms of its decoded length,
  `waveform_peaks` equal to the browser's `computeDbPeaks01` of the same PCM, and
  `media_status: 'done'`, and the client sent no `PUT …/waveform` for it

#### Scenario: An imported PCM WAV is stored as FLAC
- **WHEN** a 16-bit PCM WAV import completes
- **THEN** the segment's `mime_type` becomes `audio/flac`, its `r2_key` ends in `.flac`, the FLAC
  decodes to the identical PCM, and the WAV is under `BLOB_DIR/.trash/<date>/` until the sweep

#### Scenario: A float WAV stays WAV
- **WHEN** a 32-bit float WAV import completes
- **THEN** the segment keeps its WAV key and mime and still gains `duration_ms` and peaks

#### Scenario: An undecodable upload is reported, not hidden
- **WHEN** a segment's blob cannot be decoded after the attempt cap
- **THEN** the segment lists `media_status: 'failed'`, the row and blob stay, and the timeline
  shows the waveform as unavailable

### Requirement: A stopped recording is merged into one verified segment
A recording whose chunks (segments sharing a `recording_ordinal`) have all been uploaded SHALL be
merged into one segment. The client finalizes through `POST
/api/sessions/:sessionId/audio/recordings/:recordingOrdinal/finalize` with its list of chunk
windows once its last chunk is confirmed; the server SHALL enqueue the merge only when every
listed window is held (as a segment row or a seam) and otherwise wait for the stragglers. The
server SHALL also enqueue a merge for any recording with two or more segments whose
`media_status` is not null, whose newest `ended_at_utc` is older than 30 minutes, that has no
live merge job and no terminal merge job younger than 24 hours; recordings whose rows have a null
`media_status` (chunked before this capability) are never merged unless an operator enqueues
them. The worker SHALL order the inputs by `started_at_utc`, probe their bytes, refuse the merge
unless the probe yields exactly one group with no skipped input (`mixed-codecs` or
`decode-failed`), and concatenate them by **packet copy** into one container of the family
(Opus → WebM, AAC → MP4, PCM or FLAC → FLAC), never re-encoding and never inserting silence. It
SHALL verify the output by decoding it fully with decode errors fatal: decoded with nothing
trimmed (no start skip, no end trim, and for AAC edit lists ignored) on both sides, its sample
count SHALL **equal** the sum of the inputs' untrimmed sample counts, else `verify-mismatch`. The result SHALL carry
the merged file, its peaks and `duration_ms`, the input ids, and the **seams**: for each input its
media offset in the merged file, its `started_at_utc`/`ended_at_utc` and its source key. An input
whose window falls between two seams of an earlier merged input SHALL NOT be appended: the merge
rebuilds from the original chunks (read from the trash while they exist) or fails
`interleaved-input`, leaving every row as it was. Applying the result SHALL, in one transaction
and only if the recording's segments are still exactly the job's inputs and the session holds no
transcript-generation or YouTube-import run lease: insert one segment whose id is derived from
the job id (the first input's `ordinal`, the recording ordinal, the first input's
`started_at_utc`, the last input's `ended_at_utc`, the copied blob's key, `duration_ms`, peaks,
`media_status 'done'`), repoint the seam rows at it with their offsets, delete the input rows,
trash the input blobs named by the re-read rows (never by the result), advance the session
revision and broadcast `audio.changed`. If the segment set changed, the job SHALL be `cancelled`,
its file removed and a new merge enqueued; while a run lease is held the job waits. A chunk
uploaded after a merge SHALL be a plain segment with its own seam that triggers a new merge whose
inputs include the earlier merged file, with its seams carried over.

#### Scenario: Three chunks become one segment
- **WHEN** a three-chunk Opus recording is finalized and the worker runs
- **THEN** the session lists one segment for that `recording_ordinal`, a WebM whose `duration_ms`
  is the three decoded lengths summed, with three seams whose offsets are the cumulative input
  durations, and the three chunk rows are gone

#### Scenario: Nothing is removed before the merge is live
- **WHEN** the API process dies after the worker finished a merge but before the apply commits
- **THEN** the chunk rows and blobs are intact, the job is still `done`, and the next apply tick
  completes the swap once

#### Scenario: A verification mismatch keeps the chunks
- **WHEN** the merged file decodes to a sample count other than the one expected from the inputs'
  headers, or any input or the output raises a decode error
- **THEN** no row changes, the job retries and finally fails `verify-mismatch` or
  `decode-failed`, and the chunks remain playable segments

#### Scenario: Safari AAC chunks verify exactly
- **WHEN** three AAC/MP4 chunks from Safari are merged
- **THEN** the merged untrimmed count equals the inputs' untrimmed sum with edit lists ignored on
  both sides, and neither the priming samples nor the merged file's own skip produce a mismatch

#### Scenario: A straggler holds the merge
- **WHEN** finalize lists four windows and only three segments exist
- **THEN** the answer is `waiting`, no merge job exists, and when the fourth chunk arrives the
  merge is enqueued with all four

#### Scenario: A late middle chunk never lands at the end
- **WHEN** a recovered chunk whose window lies between the first and second seam of a merged
  segment uploads
- **THEN** the merge rebuilds from the three original chunks in the trash in wall-clock order, or,
  if they were already purged, fails `interleaved-input` and the late chunk stays a separate
  segment

#### Scenario: A merge waits for a transcript run
- **WHEN** a `done` merge job is applied while the session's transcript-generation lease is held
- **THEN** no row changes until the lease is released, and the generation run reads every blob it
  listed

#### Scenario: A failed merge is not retried every tick
- **WHEN** a recording's merge job failed `mixed-codecs` an hour ago
- **THEN** the reconcile skips it until 24 hours after that failure

#### Scenario: A late recovered chunk re-merges
- **WHEN** a recovered chunk of an already-merged recording uploads and the recording is finalized
  again
- **THEN** a new merge joins the merged file and the late chunk by packet copy, and the result's
  seams list every original chunk once

#### Scenario: Mixed codecs are refused without loss
- **WHEN** a recording's segments contain both Opus and AAC files
- **THEN** the merge fails `mixed-codecs`, every chunk stays as it was, and the timeline keeps
  the chunk layout

#### Scenario: Words keep their wall-clock position after a merge
- **WHEN** a transcript is generated after a merge and compared with one generated before it on
  the same audio
- **THEN** every word's `start_sec` is equal within 1 ms (the seams restore each chunk's
  wall-clock anchor)

### Requirement: The API applies worker results
Only the API process SHALL turn a `done` job into catalog changes, through the session hub as the
system caller `media-apply`, polling every 10 s and on a payload-free notification. Before applying
it SHALL validate the result: peaks are 8..4096 numbers in [0, 1], `duration_ms` is a positive
integer, every blob key is `media/<job id>/<name>` with a single plain name, a merge's input ids
match the current segments, and an ingest's target row still exists (else the job is
`cancelled`). Adopting a blob SHALL never rename the worker's file: the API opens it without
following symlinks, checks the open handle (a regular file within the size cap), copies it into
its own temporary file, syncs and renames that into `audio/<session>/` under a key derived from
the job, and only then removes the worker's directory; a retry after a crash finds the key in
place and does not copy again. Replaced or converted blobs SHALL be moved to
`BLOB_DIR/.trash/<yyyy-mm-dd>/<key>` and deleted only by a sweep after 7 days, except that when
`BLOB_DIR`'s free space is below the floor the sweep purges the trash oldest-first until the
floor is met and logs the transition; `sync-from-disk` and blob listings SHALL ignore `.trash/`
and `media/`. Terminal jobs older than 7 days and orphaned `media/<job>/` directories SHALL be
removed by the same sweep. The sweep SHALL also read `pg_notification_queue_usage()` and warn
above 0.5.

#### Scenario: An invalid result is refused
- **WHEN** a `done` job's result names `media/../audio/x.webm`, or peaks outside [0, 1]
- **THEN** the job becomes `failed` with `invalid-result`, no row or file changes, and the
  segment's `media_status` is `failed`

#### Scenario: A swapped symlink cannot reach the audio directory
- **WHEN** the worker's output path is replaced by a symlink to another blob, before or after
  the API's open
- **THEN** the open fails or the handle check fails, nothing is copied, no worker-owned inode
  appears under `audio/`, and the job is `failed` with `invalid-result`

#### Scenario: Low disk shortens the grace period
- **WHEN** free space on the blob volume drops below the floor with 20 GB of trash present
- **THEN** the next sweep deletes the oldest trash days until the floor is met, uploads answer
  `507`, merges wait, and the API logs entering and leaving low-disk mode once each

#### Scenario: The trash is a grace period
- **WHEN** a replaced chunk blob is trashed on day 0
- **THEN** it is still present on day 6 and absent after the sweep on day 7 or later, and
  `sync-from-disk` never re-adopts it

### Requirement: Large imports are staged by parts the API assembles
The API SHALL stage a resumable upload under `BLOB_DIR/.tmp/upload-<id>` as a preallocated file into
which each received part is written at `(n − 1) × part_size` while its sha256 is checked against
the hash the client declared for that part, record received parts in `catalog.media_uploads`,
and on completion verify the part set and the size and rebuild the whole-file check by re-hashing
every part of the staged file, before renaming the file into `audio/<session>/` and attaching it
exactly as `local-audio-import` does (import mode) or as a live chunk upload does (segment mode).
No ffmpeg is involved in assembly; the worker processes the resulting segment on ingest. A user
SHALL have at most 2 open uploads and at most 3 GiB of staging; creation and every part SHALL be
refused with `507` while the blob volume is below the free-disk floor. Uploads expire 24 hours
after their last part; expired staging files and rows are removed by the sweep.

#### Scenario: Parts assemble to the original bytes
- **WHEN** a 100 MiB file is sent as four parts in any order, one of them twice, and completed
- **THEN** the stored blob's bytes equal the original and one anchored take exists

#### Scenario: A corrupt upload never becomes a segment
- **WHEN** a part's bytes do not hash to the hash declared for it, or completion's re-hash of the
  staged file differs from the declared list
- **THEN** the part answers `400 { detail }` and is not recorded, or the completion answers `400 {
  detail }` and the staging file is deleted; no segment row exists either way

#### Scenario: Staging is bounded per user
- **WHEN** a user with two open uploads creates a third, or one whose staged bytes would exceed
  3 GiB
- **THEN** the answer is `429 { detail }` and no staging file is created
