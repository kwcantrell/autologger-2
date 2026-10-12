# Design: supabase-11a-legacy-import

## Context

- **Source:** a legacy `DATA_DIR`:
  - `catalog.db`, built by the deleted SQLite catalog migrations;
  - `sessions/<id>.db`, one file per session;
  - `blobs/audio/<sid>/<NNNN>_<segment id>.<ext>`.
- **Target:** schema `catalog`, from `supabase/migrations` up to `20261017000000`. The nine
  session tables are keyed `(session_id, id)` (7b-1). `version` and `sessions.revision` come
  from 7c-1. The leases (8a/8b), the Companion tables (9d) and the provider tables come later;
  only the leases and the overwrite records reference sessions.
- **Access:** the db service publishes no port. Operators reach it with `psql` as `postgres`,
  which owns the tables and so bypasses RLS (`docker exec -i <db> psql -X -U postgres < file`).
  The files are fed non-interactively only: an interactive psql keeps reading after an error,
  so after an aborted COPY its data lines would run as SQL. The runbook says so; no header can
  detect an interactive psql cheaply.

## Decisions

### D1. Source guard

The source's `_migrations` set must be exactly `0001_init.sql` … `0006_supabase_identity.sql`.
Each source table the import reads must have exactly the mapped columns.

- A session file may lack a table: two `test-studios` files lack paragraphs, sentiment and
  dashboards. The import reads such a table as empty and reports it.
- A session in the catalog with no `.db` file is imported with no rows (and a seed transport
  row), and reported.

### D2. Scope

Imported rows, in this order:

- the team's `studio_definitions` row;
- `shows` where `studio_id` is the team;
- `app_settings` key `studio_config:<team>`;
- `sessions` of those shows;
- the nine session tables of those sessions.

Never imported: users, memberships, prefs, invites, KV, the global `active_*` keys, or another
team's rows (ADR 0021 slice 5a).

### D3. Encoding: COPY text format, no data in SQL text

Every source value is a field of a `COPY … FROM STDIN` data line. `copyText` escapes backslash,
`\n`, `\r` and `\t`; NULL is `\N`.

- **Why it is safe:** an encoded field contains no raw newline, so it can't end its line or form
  the `\.` terminator (its backslash is doubled). psql neither interpolates variables nor runs
  meta-commands inside COPY data.
- **No ids in SQL text:** the ids the checks need (team, shows, sessions, setting key) are
  COPY-loaded into a temp table. The SQL text is fixed, built from identifiers in
  `legacyImportSql.ts`.
- **Header comments** are reduced to printable ASCII without backslash.
- **Value formats:**
  - reals use JavaScript's shortest round-trip form, which `float8in` reads to the same bits
    (`-0`, NaN and the infinities are spelled out);
  - integers are read with `safeIntegers` and written as `bigint` text;
  - NUL can't be stored in Postgres text, so it refuses.
- **Invalid UTF-8:** `better-sqlite3` decodes it to U+FFFD. A value containing U+FFFD is
  compared with its stored bytes, and invalid bytes refuse the import.

### D4. Rows as the app would write them

- **The six projection columns** are recomputed: the count and maximum timecode of the session's
  events, and the transport row (`SessionCore.writeProjectionIfDirty`). The legacy stored values
  are stale in 224 of 274 `ymhs` sessions.
- **`revision`** is `events_stream_revision` when it matches `^[0-9]{1,18}$`, else 0
  (migration `20261010000000`). Meta rows are copied as they are; `relink_checked_rev` keeps
  its meaning against the same revision.
- **`version = 1`** on events, words and topics, as the migration set existing rows.
- **A missing transport row** gets the default row `SessionCore.seed` inserts.

### D5. Collisions and `--replace`

The transaction takes `SHARE ROW EXCLUSIVE` locks on `studio_definitions`, `shows`, `sessions`
and `app_settings` before it checks.

- **Default:** any existing team, show id, session id or setting key raises
  `legacy import refused: …`.
- **`--replace`:** it first refuses ids that belong to another team. It then refuses, too, when
  the team holds **live data** the source can't bring back: a session, show or audio segment
  (by `r2_key`, COPY-loaded as scope kind `audio`) that isn't in the source, or any membership,
  invite, show grant, session lease or overwrite record. The error names each kind with its
  count and says `use --replace-live`. Otherwise (and always with `--replace-live`) it deletes:
  - the team's sessions' overwrite records, leases and nine session tables;
  - its sessions (Companion presence is set null by its foreign key);
  - its show grants, shows, setting, memberships, invites and the team row.

  Deleting memberships keeps the invariant "the imported team has no owner"; the bootstrap
  owner claims it again at their next sign-in (the claim runs only in the OAuth callback).
  Blob files are never deleted: with `--replace-live`, the audio of a deleted segment that is
  not in the new manifest stays in the volume unreferenced; the runbook lists it by comparing
  the team's `r2_key`s before the apply with the manifest.

### D6. Target schema guard

The import refuses unless `max(version)` in `supabase_migrations.schema_migrations` equals
`TARGET_SCHEMA_VERSION`. A unit test pins that constant to the newest migration file. So a new
migration fails the test until someone reviews the map, which keeps a new defaulted column from
being silently filled.

### D7. Parity

The canonical row is the fields joined by `|`:

| Value | Encoding |
| --- | --- |
| NULL | `N` |
| text | `T<octet length>:<text>` |
| integer | `I<decimal>` |
| real | `D<hex of float8send>` |

The row hash is md5 of that text. A table's digest is md5 of its row hashes, sorted and
concatenated, so row order and collation never matter.

- **Two sides:** TypeScript computes the expected digest from the source. SQL computes the actual
  one over the team's scope (shows by `studio_id`, sessions by the team's shows), so extra rows
  in the target are caught too.
- **Also checked:** every session's projection equals its rows; every session's `revision`
  equals `coalesce(events_stream_revision::bigint when it matches ^[0-9]{1,18}$, 0)` from the
  imported `session_meta`, computed in SQL independently of the importer's derivation; and
  (strict by default, relaxed by `--allow-signed-in-users`, which a prod cutover needs since prod
  has had signed-in users since 2026-10-08)
  `users`, memberships, prefs, invites and `session:` KV rows are empty.
- **Read-only:** parity runs in a REPEATABLE READ transaction and ends with ROLLBACK.

### D8. Blobs

`r2_key` stays unchanged. The tool writes:

- the manifest: every referenced key, one per line, usable as `rsync --files-from`;
- the sizes file: `<bytes> <key>` for each present file (`stat -c '%s %n'` format);
- optionally `sha256sum -c` lines.

Missing files are reported, not refused: their segments answer 404, as they do today. Each key
must be `audio/<its segment's session id>/<file name>`, with no component empty, starting with
`-` (the manifest feeds `rsync`, `stat` and `rm`; the runbook passes `--` too), holding `..`, a
backslash or a control character.

### D9. Nothing committable before everything is checked

The importer writes the closing `COMMIT` last: after the data, the expected counts, the blob
stat (and sha256) pass and the parity file. A run that fails at any point leaves an import
stream without `COMMIT`, which psql rolls back at end of input, even when it went to stdout.

## Assumptions (command → observed)

- The session schemas are uniform except for two older files.
  - Command: `for f in sessions/*.db; do sqlite3 -readonly $f "<sql of sqlite_master>" | md5sum; done | sort | uniq -c`
  - Observed: 300 × `3d96…`, 2 × `353c…`. The two `353c` files are `12ef5d1a…` and
    `400c3cc0…`, both `test-studios`, and lack paragraphs, sentiment and dashboards.
- `ymhs` has 7 shows and 274 sessions (0 archived, 39 hidden), every session has a `.db` file,
  and none has a null `show_id`.
  - Command: `sqlite3 -readonly catalog.db "select s.studio_id, count(*), sum(archived), sum(ui_hidden) …"`
  - Observed: `ymhs|274|0|39`; missing `.db` files: 0.
- Storage classes match the map, with no stray types (`typeof` per column over the 274 files).
  - Every `ymhs` session has one transport row, none rolling.
  - The meta keys are `events_stream_revision` (274), `audio_seam_parts_json` (229) and
    `relink_checked_rev` (46).
- Every `ymhs` `r2_key` matches `^audio/<uuid>/<4 digits>_<uuid>.<ext>$` (the grep found no
  exceptions).
- The legacy `_migrations` holds 0001-0005 plus `0006_supabase_identity.sql` (2026-08-17).
  - Command: `sqlite3 -readonly catalog.db "select * from _migrations"`
  - Observed: 6 rows. `git log --all -S supabase_identity` finds nothing: the file is in no branch.
- The app's runtime user is uid 1000: `docker/Dockerfile`'s `USER node`, `/blobs` chowned to
  `node`; the README says uid 1000.

## Risks

- **Prod's `catalog.db` may hold exactly 0001-0005**, which slice 4e expected. It is refused until
  the owner decides (D1).
- **A session rolling in the source** would import as rolling, with no recording lease. The
  summary warns; there are none in `ymhs`.
- **Parity is a snapshot:** app writes after the import make it fail by design.
- **No users are imported**, so the Companion devices, per-user provider keys and show grants
  must be set up again after cutover.

## Follow-up B: waveform peaks backfill
### Context

The browser path: `useWaveforms` → `fetchAndDecodeWaveformPeaks` (whole-file fetch,
`decodeAudioData` at the `AudioContext` rate) → `computeDbPeaks01` (per frame max |sample| across
channels; bucket b = frames [floor(b·spp), min(len, floor((b+1)·spp))), spp = len/buckets; dB
envelope clamped to [-48, 0], scaled to [0, 1], stored in a `Float32Array`) → PUT body
`Array.from(peaks, Number)` → `setAudioSegmentWaveform` stores `JSON.stringify(peaks)` and floor
`-48`. The bucket count is `segmentWaveformDecodeBucketCount(duration, timelineSpan)`: twice the
segment's share of the 5000-bucket timeline, clamped to [256, 4096]. `mergeAudioClipsIntoTimelinePeaks`
samples stored peaks linearly by `offset / duration`, so any stored length renders at the right
place.

### Decisions

#### W1. Shared pure function in `@autologger/domain`, pinned to the web copy

`web/` may not import `packages/` (web-package-boundary, permanent policy). The computation lives in
`packages/domain/src/waveformPeaks.ts` (constants, bucket-count rule, `DbPeaksAccumulator`), and
`web/src/shared/utils/waveformDecode.pinning.test.ts` dynamically imports it (test-only, the
`clientAggregates.pinning.test.ts` precedent) and asserts bit-identical output to
`computeDbPeaks01` on shared PCM (stereo, mono, more buckets than frames, six channels, silence),
plus equal constants and bucket counts. The web code is unchanged apart from a header comment.

#### W2. Streaming accumulator, two decodes per file

Bucket boundaries need the total frame count, which a stream only knows at the end. The CLI
therefore decodes each file twice (count, then accumulate); memory is O(buckets). Keeping a
per-frame envelope instead would need ~4 bytes/frame (1.4 GB for the largest file), and a block
pre-reduction would not reproduce the exact boundaries. The second decode must yield the same
frame count, or the segment fails.

#### W3. Bucket count: the rule for a segment decoded on its own

The browser's count depends on the session's timeline span at decode time (status and events, not
in the row). Stored peaks are per segment, so the backfill uses `segmentWaveformDecodeBucketCount(d, d)`:
4096 for d ≥ 0.41 s, fewer for shorter clips. That is the contract maximum and what a session holding
only that segment stores; the merge resamples by fraction of duration, so it renders in place. In a
multi-segment session the browser would have stored fewer, max-pooled buckets; ours are finer.

#### W4. ffmpeg in a pinned image by default, f32 WAV on a pipe

The app images have no ffmpeg and the hosts may not either. Default: `docker run --rm --network
none -v <blob dir>:/blobs:ro linuxserver/ffmpeg:9.0-cli-ls84@sha256:a7182d4f…` (multi-arch);
`--ffmpeg <binary>` instead when one exists. Output `-map 0:a:0 -ar 48000 -c:a pcm_f32le -f wav -`
with no `-ac`, so channels stay separate for the max-across-channels rule; the WAV header gives the
channel count, the data runs to EOF (pipe size fields are placeholders).

#### W5. SQL file applied by the operator

The db publishes no port. The CLI writes one transaction (`\set ON_ERROR_STOP on`, `begin`,
`set local standard_conforming_strings = on`, UPDATEs, `commit`); each UPDATE is
`… where session_id = $ and id = $ and waveform_peaks_json is null`. Ids and file names match
`^[A-Za-z0-9_][A-Za-z0-9._-]{0,254}$`, the key is exactly `audio/<session_id>/<file>`, its resolved
and real path stay inside the blob dir, and the peaks JSON matches a numbers-only pattern, before
anything is written; literals are quote-doubled anyway.

### Assumptions

| Assumption | Command | Observed |
| --- | --- | --- |
| ffmpeg on a pipe writes a float WAV with placeholder sizes | `docker run --rm --network none $IMG -f lavfi -i sine=… -ac 2 -ar 48000 -c:a pcm_f32le -map_metadata -1 -fflags +bitexact -f wav - \| xxd \| head` | `RIFF ffffffff WAVE fmt  12000000 0300 0200 80bb0000 …data ffffffff` |
| The image is multi-arch | `docker buildx imagetools inspect linuxserver/ffmpeg:latest` | `linux/amd64`, `linux/arm64` manifests |
| No ffmpeg on the Spark host | `which ffmpeg` | no output |
| The browser stores floor -48 and `JSON.stringify` of the PUT numbers | `sed -n 158,170p packages/session-core/src/audioStore.ts` | `waveform_db_floor = ?` with `-48.0` |
| `postgres` over the container socket can read and update the table (RLS) | `server/src/test/pg/waveformBackfill.pg.test.ts` | `Tests 2 passed (2)` |
| Streaming keeps memory flat | 1 GB 1-hour 24-bit stereo WAV, `/usr/bin/time -v tsx server/scripts/backfillWaveforms.ts …` | `ok sb/big 3600.0s 2ch -> 4096 peaks`, 37.5 s, max RSS 137788 kB |
| Sample rate / codec barely matter | `backfillWaveforms.ffmpeg.test.ts` with temporary prints | 44.1 kHz s16 WAV: max diff 0.0059, mean 0.0004; MP3: max 0.0096, mean 0.0055 |

### Risks / Trade-offs

- [Browser decoder differs from ffmpeg (MP3 padding, resampler)] → ≤ 0.01 on the fixtures (< 0.5 dB),
  invisible on the timeline; WAVs at 48 kHz are exact.
- [`AudioContext` at 44.1 kHz on some machines] → the same small difference; peaks are max-abs.
- [Two decodes double the time] → about 40 s per hour of WAV; a one-off.
- [Operator applies a stale file] → the NULL guard makes it a no-op for rows filled meanwhile.

## Follow-up C: lossless FLAC blob storage
### Context

26 of the 259 legacy blobs are WAVs (`audio/wav`, `.wav`; 22 pcm_s16le, 22.7 GB, and 4 IEEE float
32-bit, 3.86 GB) and hold 26.6 GB of the
41.7 GB; the others are MP3 (206), WebM/Opus (47) and AAC/MP4 (6), counted from a copy of the
legacy session databases. Transcription groups segments by probed codec (`audioMerge.ts`); the
audio store derives the blob key's extension from the mime (`audioStore.ts`), and the GET route
serves the stored mime. Peaks are stored per segment and do not depend on the container.

### Decisions

#### F1. FLAC is its own codec family, concatenated by frame copy

FLAC joins Opus/AAC/PCM as a packet-copy family into mediabunny's `FlacOutputFormat`, sent to
DeepGram as `audio/flac`. Decoding to PCM and sending WAV would undo the size win and needs a
FLAC decoder in Node (mediabunny decodes through WebCodecs, absent in Node). The run partition
also compares the FLAC bit depth (from the STREAMINFO in the decoder config), since the codec
string is `flac` for every depth; a change starts a new group like a rate or channel change.

#### F2. Copied frames are renumbered to variable block size

A FLAC frame header holds its frame number (fixed block size, what encoders write) or its first
sample number (variable). Copying two files back to back restarts the numbers and puts a short
block mid-stream, which a fixed-block-size stream may not have: mediabunny's demuxer then loses
frames (43 copied, 24 read back) and ffmpeg warns about non-monotonic timestamps. `flacFrames.ts`
rewrites each frame to the variable-block-size form with the running sample number, re-encodes
the coded number, and recomputes the header CRC-8 and frame CRC-16; subframes are copied byte for
byte. The result is conformant (RFC 9639 §9.1) and decodes to exactly the concatenated samples.

#### F3. Lists that name audio formats learn FLAC

`audio/flac` ↔ `.flac` in the audio store's one table (so a FLAC upload gets a `.flac` key, and a
`.flac` file is recognised by sync-from-disk), `.flac` in batch import, `flac` in yt-dlp's
produced-extension map. The GET route already serves any non-compressible mime verbatim; the
browser waveform decode (`decodeAudioData`) and the server backfill (ffmpeg) read FLAC as is.

#### F4. Sync-from-disk skips a sibling of an existing segment

The segment id is part of the file name, so after a conversion `0001_<id>.wav` and
`0001_<id>.flac` both exist until the cleanup, and only one is referenced. Sync-from-disk inserted
any unreferenced key: it would have tried to add the other file as a segment with the same id
(a primary-key error, failing the sync). It now skips a key whose id already has a row.

#### F5. Convert next to the WAV, verify by decoded PCM, never replace

The CLI follows `backfillWaveforms.ts` (pinned ffmpeg image or `--ffmpeg`, CSV export through
`--print-query`, the same key validation, `--jobs`, per-segment report, exit 0/1/2); shared code
moved to `server/scripts/blobSegmentRows.ts`. It probes the WAV header itself (16/24-bit integer
PCM only: FLAC is integer-only), encodes at `-compression_level 8` with the WAV's sample format
(`s16`, or `s32` with 24 raw bits) into `BLOB_DIR/.flac-tmp` (same filesystem, not the app's
`.tmp`, whose sweep owns `put-*`), and accepts it only when both files decode to the same raw PCM
(MD5 and byte length, in `s16le`/`s24le`) and the STREAMINFO carries the WAV's rate, channels, bit
depth and sample count. ffmpeg runs as the invoking uid (`docker run --user`); the FLAC takes the
WAV's mode, and as root its owner. It is hard-linked into place, which fails rather than replace
an existing file. An existing FLAC is verified and reused, or reported and left for the operator.
The WAV is never written. Free space is checked per file (WAV size reserved, `--min-free-gb`
kept), and `--limit N` converts in batches.

#### F6. SQL guarded by the old key

Each UPDATE is `set r2_key = <flac>, mime_type = 'audio/flac' where session_id = $ and id = $ and
r2_key = <wav>` in one transaction with `ON_ERROR_STOP`, so a re-apply, or an apply after the row
changed, is a no-op. The FLAC key must be exactly the WAV key with its extension replaced, and both
pass the backfill's id/key validation, before any SQL is written.

#### F7. Cleanup is separate, reference-driven and re-verifying

`--cleanup` takes a fresh export of every referenced key (`--print-referenced-query`), walks
`audio/<sid>/` without following symlinks, and lists a WAV only when its `.flac` sibling is a
regular file and referenced and the WAV is not referenced. Dry run by default; `--delete`
decodes both again and unlinks the WAV only when the PCM matches. Anything else (no sibling,
unreferenced FLAC, still-referenced WAV) is kept and reported.

#### F8. Review fixes: trailing bytes, unreadable FLAC, the 2^31-sample limit, float WAVs

- mediabunny sizes a file's last FLAC packet to EOF, so an ID3v1/APE tag or padding lands in it.
  `trimFlacFrame` cuts the frame at the last position where the CRC-16 register over it is 0,
  moved back over trailing zeros, before renumbering; no such position -> error. (A
  shortest-prefix rule would stop early inside large frames: a 2^-16-per-byte coincidence.)
- mediabunny 1.50.8 misreads the "rate in kHz" frame-header code (12, 64 kHz FLAC), yields no
  packets and its muxer then asserts. `mergeGroup` now skips a segment that yields no packets or
  fails before writing any (reported in `skipped`), drops a group left empty, and a segment that
  fails part-way makes `mergeAudioSegments` retry that run one segment per group.
- Coded sample numbers of 2^31 and more are rejected by ffmpeg and overflow mediabunny's reader:
  the run partition starts a new FLAC group before the STREAMINFO sample counts would reach it.
- The converter names 32-bit float WAVs (4 legacy files, 3.86 GB) `float PCM: FLAC is
  integer-only, kept as WAV` and sums the skipped bytes in its summary.

### Assumptions

| Assumption | Command | Observed |
| --- | --- | --- |
| Legacy WAV rows are `audio/wav` with a `.wav` key | `sqlite3 <copy of each session db> "select mime_type, substr(r2_key,-4) from session_audio_segments"` | `26 audio/wav .wav`, `206 audio/mpeg .mp3`, `47 audio/webm[;codecs=opus] webm`, `6 audio/mp4 .m4a` |
| mediabunny 1.50.8 has a FLAC muxer that copies frames verbatim | `grep -n FlacOutputFormat node_modules/mediabunny/dist/mediabunny.d.ts`; `node_modules/mediabunny/src/flac/flac-muxer.ts` | `export declare class FlacOutputFormat`; `addEncodedAudioPacket` writes `packet.data` unchanged |
| Raw frame copy is not a valid stream | merge of two fixtures before F2 | mediabunny read back 24 of 43 packets; ffmpeg: `non monotonically increasing dts … 22528 >= 0` |
| Renumbered copy is exact | `ffmpeg -i group-0-flac.flac -f s16le - \| md5sum` vs the two inputs decoded and concatenated | both `8de1dcd135a02f4ccf47af7875700550`, no warnings |
| Real legacy WAV converts losslessly | `convertWavToFlac.ts` on copies of two legacy WAVs | 637.8 MB → 114.1 MB (18%), 1.8 MB → 0.25 MB (14%); `ffmpeg -f md5` of WAV and FLAC both `c0270170a5b08622aa806f6a0c64b012` |

### Risks / Trade-offs

- [DeepGram with variable-block-size FLAC] → conformant per RFC 9639 and decoded exactly by
  ffmpeg and mediabunny; single-segment sessions (all legacy ones) are renumbered too, so a
  provider problem would show on the first transcript regenerated after the conversion (README
  step 4 checks one).
- [Disk fills during conversion] → per-file free-space check with the WAV's size reserved and a
  2 GB margin; `--limit` batches.
- [A stale `referenced.csv` deletes a WAV that became referenced] → the runbook exports it right
  before the cleanup; the cleanup re-verifies each pair, so the FLAC holds the same audio anyway.
- [Rollback to a dump from before the conversion after the cleanup] → the runbook takes a dump
  after applying the SQL and before the cleanup.
