# Tasks

**Commands**
- Unit: `cd server && npx vitest run --project unit src/test/importLegacy.test.ts`.
- pg: `cd server && npx vitest run --project pg src/test/pg/importLegacy.pg.test.ts` (needs docker).
- Typecheck: `npm run typecheck`.
- Logs live under the session scratchpad as `11a-<task>.log`.

## 1. Tool and tests

- [x] 1.1 Test first: the encoding and hash unit tests (`copyText`, `copyField`, `realText`,
  `canonicalField`, `rowHash`, `commentLines`, `checkBlobKey`), the target-version pin and the
  map-versus-migrations check; then `legacyImportSql.ts`.
  - Evidence: `npx vitest run --project unit src/test/importLegacy.test.ts` -> `Tests  22 passed (22)` (log `11a-unit.log`). The tests were written in the same pass as the module, not red first; the fixture's first run caught two test errors (comment lines and nasty values in the SQL-text check).
- [x] 1.2 Test first: the fixture (real DDL, nasty values, a file without the AI tables, a session without a file, a missing blob) and the source refusals (`_migrations`, unknown team, column drift, wrong type, invalid UTF-8, NUL, a traversing key, read-only source, CLI exit codes and no partial output); then `importLegacy.ts`.
  - Evidence: same run, `Tests  22 passed (22)`.
- [x] 1.3 pg tests: import plus parity through `psql` in the pinned image; exact values; recomputed projection and revision; no identity rows; bootstrap claim; a second import refused; a colliding session id; a newer target schema; tampering caught (text, one-ulp real, version, extra row, projection); `--replace` with app state; `--replace` refusing another team's id.
  - Evidence: `npx vitest run --project pg src/test/pg/importLegacy.pg.test.ts` -> `Tests  7 passed (7)` (log `11a-pg.log`). The first runs failed on two test expectations: a connection whose `extra_float_digits` shortened `0.30000000000000004`, and SQLite storing the fixture's `-0.0` as `0`.
- [x] 1.4 Suites: server unit and typecheck.
  - Evidence: `cd server && npx vitest run --project unit` -> `Tests  464 passed | 3 skipped (467)`; `npm run typecheck` -> exit 0, 0 `error TS` (logs `11a-unit.log`, `11a-typecheck.log`).

## 2. Docs

- [x] 2.1 `docs/legacy-import.md` (rehearse, parity, cutover, rollback), a README section, and ADR 0021 (the 0006 amendment and slice 11 status).
  - Evidence: files changed in the working tree; no test.

## 3. Rehearsal on real data

- [x] 3.1 Generate the files for `ymhs` from `server/data`, then apply all migrations, `import.sql` and `parity.sql` to a throwaway Postgres (the pinned image).
  - Evidence: summary `274 session(s)`, `session_events 1096`, `session_transcript_words 241675`, `audio: 259 referenced, 259 present (41678860528 bytes), 0 missing`, `224 differed`; psql `import.sql: exit 0 in 1743 ms`, `parity.sql: exit 0`, `NOTICE:  legacy parity OK: 13 tables match`; a second apply -> `ERROR:  legacy import refused: team ymhs already exists (use --replace)`.
- [x] 3.2 Rehearse on VM `autologger-import` (non-interactive `docker exec -i … psql`, blob copy, bootstrap sign-in), per `docs/legacy-import.md` §2. Owner step.
  Evidence: 2026-10-11 on `autologger-import` (dev stack, migrations at HEAD): 259 blobs copied into `autologger-dev_dev-blobs`, size check `blobs OK`; `docker exec -i autologger-dev-db-1 psql -X -q -U postgres < import.sql` -> exit 0 in 3.0 s; parity -> `NOTICE:  legacy parity OK: 13 tables match`; 274 sessions, 0 users, 0 memberships; the owner signed in and claimed the team. Re-run from the prod copy (`/home/spark/legacy-prod-data/data`, `_migrations` 0001–0006) with `--replace-live --allow-signed-in-users`: 276 sessions, 261/261 blobs (41784454298 bytes), `NOTICE:  legacy import: --replace-live removed team ymhs and its rows`, then `legacy parity OK: 13 tables match`.

## 4. Review fixes (2026-10-11)

- [x] 4.1 Test first, then fix: plain `--replace` refuses live team data (sessions, shows or audio not in the source, memberships, invites, show grants, leases, overwrite records) unless `--replace-live`; blob keys must be `audio/<the segment's session id>/<file name>` with no component empty, starting with `-` or holding `..`; `COMMIT` is written only after the blob checks and the parity file; parity checks `sessions.revision` against `events_stream_revision` in SQL; the fixture builds in one transaction with `journal_mode = MEMORY`, `synchronous = OFF` (the unit file took 15.5 s and one test ran 7.6 s against the 5 s default; now ~0.3 s).
  - Evidence: before the fix, `npx vitest run src/test/importLegacy.test.ts` -> `Tests  5 failed | 19 passed (24)`; after, run twice -> `Tests  24 passed (24)`, `Duration  278ms` / `285ms`. `npx vitest run --project pg src/test/pg/importLegacy.pg.test.ts` -> `Tests  9 passed (9)`. Full `npx vitest run` -> `1953 passed | 4 skipped`, 1 failed: `teamOwner.pg.test.ts` `tuple concurrently updated` (not touched; that file alone -> `Tests  6 passed (6)`) (log `11a-full.log`). `npm run typecheck` -> exit 0.
- [x] 4.2 Runbook: non-interactive psql only (no `make dev-psql <`), `--` for `stat`/`rm`, the rollback blob removal limited to keys the restored database doesn't reference, listing the audio `--replace-live` leaves behind, a cleanup step, and the prod cutover's `--allow-signed-in-users` and owner sign-out/sign-in.
  - Evidence: `docs/legacy-import.md`, README section; no test.
- [x] 4.3 Real data again: regenerate for `ymhs` from `server/data`; apply to a throwaway pinned Postgres with all migrations.
  - Evidence: summary `274 session(s)`, `audio: 259 referenced, 259 present (41678860528 bytes), 0 missing`, `224 differed`; `import.sql: exit 0 in 1739 ms`, `NOTICE:  legacy parity OK: 13 tables match` (exit 0); a second apply -> `legacy import refused: team ymhs already exists (use --replace)`; a `--replace` file -> `--replace removed team ymhs`, COMMIT; with an owner membership added -> `legacy import refused: --replace would delete live data of team ymhs: 1 membership(s) (use --replace-live)`; parity again OK.

## 5. Follow-up A: "Waveform unavailable" UI

### A1. Failing tests first

- [x] A1.1 Add `waveformDecode.test.ts`, `TimelineWaveform.test.tsx`, `useWaveforms.test.tsx`.
  Evidence: `npx vitest run` of the three files on the old code -> 6 failed (size guard, label only while decoding, unavailable label, hook `unavailable`, no retry).

### A2. Fix

- [x] A2.1 Implement the hook flag, label logic and size guard.
  Evidence: same three files -> `Tests 7 passed (7)`; see A3 for typecheck, biome and the full suite.

### A3. Verify

- [x] A3.1 `npm run typecheck -w web`, `npm run lint -w web`, `npx vitest run` in `web/`, `scripts/check-change.sh`.
  Evidence: `npx biome check --error-on-warnings` on the 9 changed files -> clean; `tsc --noEmit` shows no errors in the changed files; the 3 new test files plus the existing utils/hooks/timeline tests -> 268 passed. After `npm ci` in the worktree: `npm run test -w web` -> `Test Files 148 passed (148)`, `Tests 1927 passed (1927)`; `npm run typecheck` -> exit 0.

## 6. Follow-up B: waveform peaks backfill

### B1. Shared peak computation (W1, W2)

- [x] B1.1 Test first: `packages/domain/src/waveformPeaks.test.ts` (accumulator equals a whole-buffer reference bit for bit at chunk sizes 1..10M, more buckets than frames, other floor, zero frames, frame-count and whole-frame refusals; bucket-count rule). Red, then implement `waveformPeaks.ts` and export it from the barrel. Green.
  Evidence: red, `cd packages/domain && npx vitest run src/waveformPeaks.test.ts` -> `Error: Cannot find module './waveformPeaks'`, `Test Files 1 failed (1)` (log `1.1-red.log`). Green, same command -> `Tests 8 passed (8)` (log `1.1-green.log`).
- [x] B1.2 Test: `web/src/shared/utils/waveformDecode.pinning.test.ts` pins `computeDbPeaks01` to `DbPeaksAccumulator` (5 PCM cases, bit-identical arrays and JSON), the constants, the bucket-count rule, and the merged timeline. Shown to bite by a mutation (`Math.floor` -> `Math.round` in the accumulator's bucket end).
  Evidence: `cd web && npx vitest run src/shared/utils/waveformDecode.pinning.test.ts src/webBoundaries.repo.test.ts` -> `Tests 96 passed (96)` (log `1.2.log`); with the mutation -> `Tests 5 failed | 2 passed (7)` (log `1.2-mutation-red.log`), reverted.

### B2. Backfill CLI (W3, W4, W5)

- [x] B2.1 Test first: `server/src/test/backfillWaveforms.test.ts` (CSV parsing, key validation incl. `..`, leading `-`/`.`, protocol, quotes, symlink escape; SQL emission with the NULL guard, floor -48, transaction, refusal of bad ids/peaks; WAV stream parsing at any chunking; decode command lines; full CLI with a fake ffmpeg: ok/failed/missing/invalid report, exit 1/0/2, `--print-query`). Red, then implement `server/scripts/backfillWaveforms.ts`. Green.
  Evidence: red, `cd server && npx vitest run --project unit src/test/backfillWaveforms.test.ts` -> `Error: Cannot find module '../../scripts/backfillWaveforms'` (log `2.1-red.log`). Green -> `Tests 30 passed (30)` (log `2.1-green.log`).
- [x] B2.2 Test: `server/src/test/backfillWaveforms.ffmpeg.test.ts` runs the CLI with a real ffmpeg (pinned image via docker, or `ffmpeg`/`WAVEFORM_TEST_FFMPEG`; skips when neither) on generated fixtures: 48 kHz float WAV bit-identical to the browser computation; 44.1 kHz s16 WAV within 0.02; MP3 within 0.03 (mean 0.01); junk file `failed`, exit 1.
  Evidence: first run -> `failed s1/f32 not a WAV stream` because the fixture's fake `LIST` chunk made ffmpeg refuse the input (fixture bug, replaced by a `JUNK` chunk); then `npx vitest run --project unit src/test/backfillWaveforms.ffmpeg.test.ts src/test/backfillWaveforms.test.ts` -> `Tests 34 passed (34)` (logs `2.2.log`, `3.2-backfill.log`).
- [x] B2.3 Test: `server/src/test/pg/waveformBackfill.pg.test.ts` applies the emitted SQL with `docker exec -i <container> psql -X -U postgres` to a migrated catalog: the export query yields the CSV, only NULL rows are filled (floor -48), a filled row (floor -72) is untouched, a second apply is a no-op, an error rolls the file back. Shown to bite by removing the NULL guard.
  Evidence: `cd server && npx vitest run --project pg src/test/pg/waveformBackfill.pg.test.ts` -> `Tests 2 passed (2)` (log `2.3.log`); without `and waveform_peaks_json is null` -> `× fills only NULL rows, keeps filled ones, and is a no-op the second time`, `Tests 1 failed | 1 passed (2)` (log `2.3-mutation-red.log`), reverted; `docker ps -a --filter label=autologger-test-pg.pid` -> empty.

### B3. Docs and verify

- [x] B3.1 README "Waveform peaks backfill" (dev, stage, prod; re-run safety; caveats). `npm run typecheck` passes; biome is clean on every changed file.
  Evidence: `npm run typecheck` -> rc=0, 0 `error TS` (log `3.1-typecheck.log`); `npx biome check --error-on-warnings <changed .ts files>` -> `Checked 9 files … No fixes applied.` `npm run lint` fails only on files this change doesn't touch (`web/src/api/types.conformance.test.ts`, `AccountSection.test.tsx`, `v5Leftovers.repo.test.ts`, `packages/catalog/src/authStore.ts`, …), the same on the base tree with this change stashed.
- [x] B3.2 Unit suites: domain, server unit, web.
  Evidence: `packages/domain` -> `Tests 58 passed (58)`; `server --project unit` -> `Test Files 38 passed | 2 skipped (40)`, `Tests 476 passed | 3 skipped (479)`; `web` -> `Test Files 146 passed (146)`, `Tests 1927 passed (1927)` (logs `3.2-*.log`).
- [x] B3.3 `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook` passes. The full run's `approval` and `artifacts-first` gates wait on the owner (`Approved-by:`, then the artifacts-only first commit).
  Evidence: `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage hook` -> rc=0; `PASS openspec`, `PASS change tier 1`, `PASS risk-floor 0 high-risk path(s) touched`, `PASS evidence`, `PASS commands ran ['typecheck', 'test'] (pg/integration skipped: local run …)` (log `3.3-hook.log`); `openspec validate --all --strict` -> `Totals: 28 passed, 0 failed`.

### B4. Parallel decoding

- [x] B4.1 `--jobs N` (1-64, default 1): a worker pool over the rows; results are indexed by input row, so the SQL is byte-identical for any N (test: `--jobs 4` vs one job on the fake-ffmpeg fixture; `0`, `-1`, `1.5`, `x`, `65` exit 2). README documents it.
  Evidence: test written first -> `× --jobs N decodes in parallel and writes the same SQL, in input order, as one job` (1 failed); after the worker pool -> `npx vitest run src/test/backfillWaveforms.test.ts src/test/backfillWaveforms.ffmpeg.test.ts` -> `Tests 35 passed (35)`; `npm run typecheck` -> exit 0. Real run on `autologger-import` with `--jobs 6`: `215 ok, 0 failed, 0 missing, 0 invalid`, then 0 of 261 segments without peaks.

## 7. Follow-up C: lossless FLAC blob storage

### C1. FLAC end to end in the app (F1–F4)

- [x] C1.1 Test first: FLAC fixtures (`seg-flac.flac`, `seg-flac2.flac`, `seg-flac-mismatch.flac`, `seg-flac-24bit.flac`, made with the pinned ffmpeg image), `audioMerge.test.ts` (FLAC group by frame copy, packet count and duration, rate/channel and bit-depth changes start new groups, FLAC after PCM), `deepgram.test.ts` (`audio/flac`). Red, then the `flac` family. The first green attempt failed on the read-back, which led to F2.
  Evidence: red, `cd packages/transcription && npx vitest run src/audioMerge.test.ts src/deepgram.test.ts` -> `Tests 3 failed | 26 passed (29)` (`expected undefined to be 'audio/flac'`); with the family but raw frame copy -> `expected 24 to be 43` (merged packets read back).
- [x] C1.2 Test first: `flacFrames.test.ts` (coded numbers 1-7 bytes, fixture frames parsed with valid CRC-8, renumbered frames with recomputed CRC-8/CRC-16 and unchanged subframes, refusal of non-frames and bad CRCs); then `flacFrames.ts` and the renumbering in `mergeGroup`; the merged-stream test checks every frame is variable-block-size with consecutive sample numbers.
  Evidence: red -> `Test Files 1 failed (1)`, `no tests` (module missing); green, `cd packages/transcription && npx vitest run` -> `Test Files 9 passed (9)`, `Tests 79 passed (79)`; merged fixtures decoded with ffmpeg `-f s16le | md5sum` -> `8de1dcd135a02f4ccf47af7875700550` for the merge and for the two inputs concatenated, no warnings.
- [x] C1.3 Test first: `audioStore.int.test.ts` (`audio/flac`/`audio/x-flac` -> `.flac`, `.flac` restored as `audio/flac`, round trip, sync-from-disk skips a WAV whose id has a FLAC row); then the table entry, the regex and the sibling skip in `audioStore.ts`.
  Evidence: red, `cd server && npx vitest run --project integration src/test/session/audioStore.int.test.ts` -> `Tests 4 failed | 2 passed (6)`; green -> `Tests 6 passed (6)`.
- [x] C1.4 Test first: `grouping.test.ts` (`.flac`, `.FLAC`, stem), `ytdlp.test.ts` (`flac` -> `audio/flac`), `audio.test.ts` (`audio/flac` served verbatim); then `grouping.ts` and `ytdlp.ts`.
  Evidence: red, `cd web && npx vitest run src/pages/index/batchImport/grouping.test.ts` -> `Tests 3 failed | 18 passed (21)`; `packages/media-import` with `ytdlp.ts` stashed -> `Tests 1 failed | 26 passed (27)`; green -> `Tests 37 passed (37)` (batchImport) and `Tests 27 passed (27)`; `audio.test.ts` -> `Tests 34 passed (34)` (a pin: it passed before too).

### C2. Conversion CLI (F5–F7)

- [x] C2.1 Shared helpers moved from `backfillWaveforms.ts` to `server/scripts/blobSegmentRows.ts` (CSV, key check, literals, image pin, `--jobs` pool), re-exported so its tests are unchanged.
  Evidence: `cd server && npx vitest run --project unit src/test/backfillWaveforms.test.ts` -> `Tests 31 passed (31)`; `npx tsc --noEmit -p .` -> exit 0.
- [x] C2.2 Tests: `convertWavToFlac.test.ts` (export queries, `flacKeyFor`, WAV header probe incl. extensible/float/8/32-bit/non-WAV, STREAMINFO parsing incl. 36-bit sample counts, SQL with the old-key guard and refusals, docker/binary command lines, cleanup planning incl. symlinks, CLI usage exit 2, empty cleanup dry run); `convertWavToFlac.ffmpeg.test.ts` with the pinned image (16-bit stereo and 24-bit mono extensible WAVs converted, PCM MD5 equal, STREAMINFO equal, mode copied, temp dir removed; float and junk `skipped`, missing `missing`, exit 1; re-run `reused` with byte-identical SQL under `--jobs 3`; a corrupted existing FLAC `failed` and left; `--limit 1`; cleanup dry run and `--delete`; `--delete` keeps a WAV whose FLAC no longer matches). Written together with the module, not run red; shown to bite by a mutation.
  Evidence: `cd server && npx vitest run --project unit src/test/convertWavToFlac.test.ts src/test/convertWavToFlac.ffmpeg.test.ts src/test/backfillWaveforms.test.ts src/test/backfillWaveforms.ffmpeg.test.ts` -> `Test Files 4 passed (4)`, `Tests 59 passed (59)`; with the PCM MD5/length comparison removed -> `Tests 2 failed | 5 passed (7)` (corrupt FLAC reused / deleted WAV), reverted.
- [x] C2.3 Test: `pg/wavToFlac.pg.test.ts` applies the SQL with `docker exec -i <container> psql -X -U postgres` to a migrated catalog: the export selects `.wav`/`.WAV` keys and wav mimes, only rows still holding the WAV key change (peaks kept), a second apply is a no-op, a row changed after the export is untouched, the referenced export lists every key, an error rolls back.
  Evidence: `cd server && npx vitest run --project pg src/test/pg/wavToFlac.pg.test.ts src/test/pg/waveformBackfill.pg.test.ts` -> `Tests 4 passed (4)`; without `and r2_key = <wav>` -> `× exports the WAV rows; switches key + mime only while the WAV key is current; idempotent`, `Tests 1 failed | 1 passed (2)`, reverted; no test containers left (`docker ps -a --filter label=autologger-test-pg.pid` empty).
- [x] C2.4 Real data: copies of two legacy WAVs (`server/data` read only) in a scratch blob dir, `--jobs 2`, then a re-run and a cleanup dry run.
  Evidence: `ok … 1.8 MB -> 250646 B (14%) 44100 Hz 1ch 16-bit, 20.0s`; `ok … 637.8 MB -> 114.1 MB (18%) 48000 Hz 2ch 16-bit, 3321.9s, pcm md5 c0270170a5b08622aa806f6a0c64b012`; `2 ok … WAV 639.6 MB -> FLAC 114.4 MB`, exit 0, 16 s; independent `ffmpeg -map 0:a -c:a pcm_s16le -f md5 -` of WAV and FLAC both `MD5=c0270170a5b08622aa806f6a0c64b012`; re-run `0 ok, 2 reused`, SQL identical (`cmp`); cleanup dry run `2 to delete (639.6 MB), 0 kept`; `mergeAudioSegments` on the real FLAC -> one `flac` group, 38929 packets, 3321.936 s, decoded MD5 `c0270170…` again.

### C3. Docs and verify

- [x] C3.1 README "Convert WAV blobs to FLAC" (dev commands, stage/prod, order, disk headroom, `--limit`, ownership); `docs/legacy-import.md` step 5 (optional post-import steps, rollback note).
  Evidence: sections present (`grep -n "Convert WAV blobs to FLAC" README.md docs/legacy-import.md`).
- [x] C3.2 Typecheck, biome, suites.
  Evidence: `npm run typecheck` -> rc=0, 0 `error TS`; `npx biome check --error-on-warnings` on the 17 changed files biome covers -> `Checked 17 files … No fixes applied.` (`server/scripts` is outside biome's includes); `npm run test` in `packages/transcription` -> `Tests 79 passed (79)`, `packages/session-core` -> `Tests 55 passed (55)`, `packages/storage` -> `Tests 188 passed (188)`, `packages/media-import` -> `Tests 32 passed | 2 skipped (34)`; `server --project unit` -> `Test Files 41 passed | 2 skipped (43)`, `Tests 526 passed | 3 skipped (529)`; `web` -> `Test Files 149 passed (149)`, `Tests 1937 passed (1937)`; `server --project integration` audioStore, transcribe, audio.mimeInvariant, audio.segments -> `Tests 94 passed (94)`.
- [x] C3.3 `npx openspec validate supabase-11a-legacy-import --strict` and `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage commit`.
  Evidence: `npx openspec validate supabase-11a-legacy-import --strict` -> `Change 'supabase-11a-legacy-import' is valid`; `GITHUB_BASE_REF=supabase-migration scripts/check-change.sh --stage commit` -> rc=0, `PASS openspec`, `PASS yaml`, `PASS workflows`, `PASS skills-sync`, `PASS guide-size`, `PASS change tier 2 (openspec/changes/supabase-11a-legacy-import)`, `PASS risk-floor 1 high-risk path(s) touched`.

### C4. Review fixes (F8)

- [x] C4.1 Test first: `flacFrames.test.ts` (a frame followed by an ID3v1 tag, by 64 zero bytes, and by a fake sync word is trimmed to the frame and renumbered with a valid CRC-16; a frame whose CRC-16 never checks is refused) and `audioMerge.test.ts` (a FLAC + 128-byte `TAG` and a FLAC + 300 zero bytes merge into frames with consecutive sample numbers and no tag bytes); then `trimFlacFrame`.
  Evidence: red, `cd packages/transcription && npx vitest run` -> `Tests 5 failed | 79 passed (84)` (incl. `expected true to be false`: tag bytes in the merged file); green -> `Tests 84 passed (84)`; the reviewer's repro (fixture + `TAG` + 125 bytes, and a padded one) merged and decoded with `ffmpeg -err_detect crccheck+explode` -> no error, MD5 `8de1dcd135a02f4ccf47af7875700550`, same as the inputs.
- [x] C4.2 Test first: 12 kHz and 64 kHz FLAC fixtures (frame-header rate code 12, `0xac`) between two 48 kHz ones are reported in `skipped` (`no audio packets could be read`) and the others still merge; the run partition starts a new FLAC group before 2^31 samples. Then the skip/empty-group/retry handling in `mergeGroup`/`mergeAudioSegments` and the sample cap in `partitionRuns`; the 2^31 limit is documented in `flacFrames.ts`.
  Evidence: red in the same run as C4.1 (`× skips FLAC segments the demuxer yields no packets for`, `× starts a new FLAC run before the sample numbers would reach 2^31`); green -> `Tests 84 passed (84)`; `server --project integration src/routers/transcribe.int.test.ts` -> `Tests 74 passed (74)`.
- [x] C4.3 Test first: float WAVs reported `32-bit float PCM: FLAC is integer-only, kept as WAV`, the summary sums skipped bytes; README, `docs/legacy-import.md`, proposal and design give the legacy split (22 × 16-bit, 22.7 GB; 4 × float, 3.86 GB, measured from the `fmt ` headers of `server/data/blobs`, read only).
  Evidence: red, `cd server && npx vitest run --project unit src/test/convertWavToFlac.test.ts` -> `Tests 1 failed | 16 passed (17)`; green, converter + backfill unit/ffmpeg tests -> `Test Files 4 passed (4)`, `Tests 59 passed (59)`; `npm run typecheck` -> rc=0, 0 `error TS`; biome on `packages/transcription/src` and the two converter tests -> clean.
