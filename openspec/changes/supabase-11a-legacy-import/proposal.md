# Legacy data import: one team's SQLite data into the Postgres catalog

Tier: 2
Tier reason:
- it writes production data: the cutover moves prod's teams into Postgres;
- it is part of a migration (ADR 0021 slice 11), and its parity check is the cutover gate;
- it touches identity: users, memberships, prefs, invites and login sessions are never imported
  (slice 5a binding), and ownership comes from the bootstrap owner's claim.

ADR 0021 slice 11 (11a: the tool, the parity check and the runbook).

## Why

Since slice 4e (catalog) and 7b-1 (session content), the server reads only Postgres. The
pre-Supabase files (`catalog.db`, `sessions/<id>.db`) and the audio under `DATA_DIR/blobs` are
not read. Until they are imported, every existing team, show and session is missing on the new
stack. ADR 0021 requires the import, a parity check, a cutover runbook and a rollback plan, all
rehearsed on dev against the disposable `server/data` copy (ADR 0022).

## Owner decisions (2026-10-11)

1. **Scope per team:**
   - imported: the `studio_definitions` row, the team's shows, `app_settings` key
     `studio_config:<team>` only, every session of those shows (archived and hidden included) and
     every per-session table;
   - not imported: the global keys `active_studio_id` / `active_show_id`, and `kv`.
2. **No identity rows:** no users, memberships, prefs, invites or KV (ADR 0021 slice 5a). The
   imported team has no owner. `BOOTSTRAP_OWNER_EMAIL`'s sign-in claims it
   (`authClaimOwnerlessStudios`).
3. **Source guard:** the source's `_migrations` set is exactly `0001`-`0006`
   (`0006_supabase_identity.sql` changes only `users`). The ADR's "exactly 0001-0005" is amended.
4. **Collisions refuse at apply time**, unless `--replace` deletes the team's rows first, in the
   same transaction. `--replace` itself refuses a team with live data (app-created sessions,
   shows or audio, memberships, invites, grants, leases, overwrite records); only
   `--replace-live` deletes that (review finding, 2026-10-11).
5. **Every column is copied explicitly**, so a Postgres default never replaces a stored value.
6. **One SQL transaction** for `psql` as `postgres` (the db service publishes no port). Values
   must round-trip exactly, and a crafted value must not be able to leave its literal.
7. Rehearsal: team `ymhs` on VM `autologger-import`.

## What changes

- `server/scripts/importLegacy.ts` (CLI) and `server/scripts/legacyImportSql.ts` (the table map,
  encoding and SQL). From one team of a legacy `DATA_DIR`, opened read-only, they emit:
  - `import.sql`: one transaction. It checks the target schema version, refuses collisions (or
    `--replace` / `--replace-live`), COPYs every row, recomputes the live projection, revision
    and versions as the app writes them, then checks the counts. `COMMIT` is written only after
    every check passed;
  - `parity.sql`: per-table row counts and content hashes, compared with the source, plus the
    invariants (live projection, `revision` versus `events_stream_revision`, no identity rows).
    Read-only (it ends with ROLLBACK);
  - a blob manifest, a size list and an optional sha256 list, with missing files reported.
- Tests: unit tests (encoding, hashing, source checks, CLI) and pg tests that pipe the files into
  `psql` in the pinned test Postgres.
- Docs: `docs/legacy-import.md` (the runbook), a README section, and ADR 0021 (slice 4e's
  `_migrations` expectation, slice 11 status).

## Non-goals

- Importing several teams in one file, or users/memberships/KV in any form.
- Changing the server, the schema or any migration. The HTTP/WS contract doesn't change.
- Copying audio: the tool lists it; the copy is the README's additive `rsync`.
- Cleaning up the legacy meta keys (`events_stream_revision`, …): they are copied, as migration
  `20261010000000` left them, for its later cleanup migration.

## Capabilities

- New `legacy-data-import`.
- Modified `web-session-console` (Follow-up B): ADDED requirement "Missing waveform peaks can be backfilled offline".
- `legacy-data-import` (Follow-up C): requirement "Imported PCM WAV blobs can be stored losslessly as FLAC".
- Modified `transcript-generation` (Follow-up C): MODIFIED requirement "Segment grouping and concatenation" (FLAC family).
- Modified `batch-audio-import` (Follow-up C): MODIFIED requirement "Audio file discovery and grouping" (`.flac`).

## Impact

- Code: `server/scripts/importLegacy.ts`, `server/scripts/legacyImportSql.ts`.
- Tests: `server/src/test/importLegacy.test.ts`, `server/src/test/legacyFixture.ts`,
  `server/src/test/pg/importLegacy.pg.test.ts`.
- Docs: `docs/legacy-import.md`, `README.md`, `docs/decisions/0021-migrate-to-self-hosted-supabase.md`.

## Follow-up A: Show "Waveform unavailable" instead of a permanent "Generating waveform…"

Found in the rehearsal on `autologger-import`: imported sessions whose audio has no stored peaks
(211 of 259 segments; the 23 WAVs of up to 1.3 GB) show "Generating waveform…" forever.
Tier 1 on its own (web only, no contract or spec change).

### Why

`TimelineWaveform` shows "Generating waveform…" whenever there are no merged peaks and there are
clips, without checking `isDecoding`. `useWaveforms` decodes missing segment peaks in the browser
and stores `null` when the decode fails, so a failed decode looks like an in-progress one and the
label stays forever. For very large files (1.3 GB WAVs) the browser first downloads the whole
file and then fails or runs out of memory.

### What Changes

- **`useWaveforms.ts`.** Returns a new `unavailable` flag (decode finished, at least one segment in
  the layout has no peaks). `isDecoding` is unchanged. A failed or skipped segment is remembered
  and not retried when the layout changes; server-provided peaks clear it.
- **`TimelineWaveform.tsx`.** "Generating waveform…" only while `isDecoding`. With no peaks and
  `unavailable`, a quiet "Waveform unavailable" in the same slot. Partial peaks render as before.
- **`waveformDecode.ts`.** `WAVEFORM_DECODE_MAX_BYTES` (200 MB). The size is the response
  `Content-Length`, checked before the body is read (the fetch body is cancelled when over the cap);
  without it the body is streamed and cancelled once the cap is passed. No segment metadata carries a byte size.
- `Timeline`, `MaximizeLogStrip`, `SessionWorkspace` pass `unavailable` through.

### Capabilities

#### New Capabilities

None.

#### Modified Capabilities

None. `skip_specs: true`.

### Non-goals

- The server-side peaks backfill (separate branch).

### Impact

- `web/src/pages/index/hooks/useWaveforms.ts`, `.../timeline/TimelineWaveform.tsx`,
  `web/src/shared/utils/waveformDecode.ts`, pass-through props in three components, three new test files.

## Follow-up B: Backfill missing waveform peaks server-side

The server-side half of Follow-up A: fills the peaks the browser can't compute for imported audio.
Its design decisions are W1–W5 in design.md.

### Why

A segment's timeline waveform comes from `catalog.session_audio_segments.waveform_peaks_json`.
When it is `NULL`, the browser computes it (`useWaveforms` → `fetchAndDecodeWaveformPeaks`: fetch
the whole file, `decodeAudioData`, bucket, dB envelope) and PUTs it back. For large files (the
imported legacy data has a 1.3 GB WAV, 23 WAVs and ~188 MP3s) the browser never succeeds: the
fetch plus a full in-memory decode runs out of memory or time. On the rehearsal VM 211 of 259
segments have no peaks, so their sessions draw no waveform, every time, for every viewer.

### What Changes

- **`packages/domain/src/waveformPeaks.ts`** (new, pure): the waveform constants, the per-segment
  bucket-count rule, and a streaming accumulator that turns interleaved Float32 PCM into the same
  dB-envelope peaks as the browser's `computeDbPeaks01`, in constant memory.
- **`web/src/shared/utils/waveformDecode.pinning.test.ts`** (new): the web keeps its own copy
  (web-package-boundary: `web/` never imports `packages/`); a test-only dynamic import pins the two
  bit-for-bit on shared PCM fixtures, and pins the constants and bucket-count rule.
- **`server/scripts/backfillWaveforms.ts`** (new operator CLI): reads a CSV of segments with
  `NULL` peaks (exported with psql), decodes each blob with ffmpeg (a pinned ffmpeg image through
  `docker run --network none` with the blob dir mounted read-only, or a given `--ffmpeg` binary)
  as a stream, computes peaks, and writes one SQL transaction of `UPDATE … WHERE … AND
  waveform_peaks_json IS NULL`. Per-segment report (ok / missing / failed / invalid); a failure
  never stops the others; exit 1 when any segment was not filled.
- **README**: a "Waveform peaks backfill" runbook section for dev, stage and prod.

### Capabilities

#### New Capabilities

None.

#### Modified Capabilities

- `web-session-console`: ADDED requirement "Missing waveform peaks can be backfilled offline".

### Non-goals

- No server endpoint, job or boot-time task; no change to the browser decode path, the PUT route,
  its schema or `setAudioSegmentWaveform`.
- No ffmpeg in the app images.
- No re-computation of peaks that already exist, legacy `-72` floors included.
- Not wired into the legacy import (that lives on another branch); the runbook says when to run it.

### Impact

- New files only, plus a README section and the domain barrel export. Contract impact: none.

## Follow-up C: lossless FLAC blob storage

Prod has an 80 GB disk. Of the legacy audio (41.7 GB), 26 WAVs (pcm_s16le, 48 kHz stereo) are
26.6 GB; FLAC at `-compression_level 8` measured 32% of the WAV's size on a 1.3 GB file with
bit-identical decoded PCM (`ffmpeg -f md5` equal). MP3, Opus and AAC stay as they are. Design
decisions F1–F8 in design.md.

### Why

The import copies the blobs as they are, so the WAVs alone would take a third of prod's disk.
Of those, 22 (22.7 GB) are 16-bit integer PCM; 4 (3.86 GB) are 32-bit float, which FLAC cannot
hold and which stay WAV. Converting the 22 frees about 15 GB without changing a sample, but the app must then handle
FLAC segments end to end: today transcription silently skips them (no FLAC codec family), the
audio store maps `audio/flac` to a `.webm` key and its sync-from-disk ignores `.flac` files.

### What Changes

- **Transcription (`packages/transcription`).** A `flac` codec family: FLAC segments are
  concatenated by frame copy into a FLAC file (mediabunny `FlacOutputFormat`), with a stream
  parameter change (rate, channels, bit depth) starting a new group, and sent as `audio/flac`.
  Each copied frame's header is renumbered (new `flacFrames.ts`), because raw copies restart the
  frame numbers per file and mediabunny then drops frames.
- **Audio store (`packages/session-core`).** `audio/flac` ↔ `.flac` in the mime/extension table;
  sync-from-disk accepts `.flac` keys and skips a file whose segment id already has a row (a WAV
  next to its FLAC).
- **Other lists:** batch import accepts `.flac` (`grouping.ts`); yt-dlp's produced-extension map
  knows `flac`. The audio GET route serves the stored mime verbatim (pinned by a test), and the
  browser decodes FLAC for waveforms with `decodeAudioData`; the server backfill reads anything
  ffmpeg reads.
- **`server/scripts/convertWavToFlac.ts`** (new operator CLI): converts WAV rows to verified FLACs
  next to them and writes guarded SQL; `--cleanup` deletes only superseded, unreferenced WAVs.
  `server/scripts/blobSegmentRows.ts` (new) holds what it shares with `backfillWaveforms.ts`.
- **Docs:** README "Convert WAV blobs to FLAC"; `docs/legacy-import.md` step 5 (optional
  post-import steps).

### Capabilities

#### New Capabilities

None. `legacy-data-import`, new in this change, gets one more requirement: "Imported PCM WAV
blobs can be stored losslessly as FLAC".

#### Modified Capabilities

- `transcript-generation`: MODIFIED "Segment grouping and concatenation" (FLAC family).
- `batch-audio-import`: MODIFIED "Audio file discovery and grouping" (`.flac` accepted).

### Non-goals

- No re-encoding of MP3, Opus or AAC; no lossy conversion of anything.
- No ffmpeg in the app images; no server endpoint or job: the conversion is an operator step.
- No change to the HTTP/WS contract or the schema (the row keeps its id; only `r2_key` and
  `mime_type` change).
- Not wired into the import itself; the import still copies blobs byte for byte.

### Impact

- Code: `packages/transcription/src/{audioMerge,deepgram,flacFrames}.ts`,
  `packages/session-core/src/audioStore.ts`, `packages/media-import/src/ytdlp.ts`,
  `web/src/pages/index/batchImport/grouping.ts`, `server/scripts/{convertWavToFlac,blobSegmentRows,backfillWaveforms}.ts`.
- Tests: FLAC fixtures under `packages/transcription/fixtures/audio/`, `flacFrames.test.ts`,
  `audioMerge.test.ts`, `deepgram.test.ts`, `audioStore.int.test.ts`, `audio.test.ts`,
  `grouping.test.ts`, `ytdlp.test.ts`, `convertWavToFlac{,.ffmpeg}.test.ts`, `pg/wavToFlac.pg.test.ts`.
- Contract impact: none (an existing mime string is now produced by more writers).
