# Tasks

**Branch and commits**
- The first commit on `shared-blob-volume` holds only `openspec/changes/shared-blob-volume/`.
- The PR targets `supabase-migration`.
- The gates run with `GITHUB_BASE_REF=supabase-migration`.

**Logs and test-first**
- Logs live under the session scratchpad as `10-<task>-<red|green>.log`, and each `Evidence:` line names its log.
- Each "test first" item is red before its change, or records why it already passes.
- A task's text and its `Evidence:` lines stay in one block with no blank line.

**Commands**
- Targeted tests while working (ADR 0026): `cd server && npx vitest run --project <unit|integration> <files>`.
- Storage: `cd packages/storage && npx vitest run --project unit <files>`.
- Typecheck: `npm run typecheck`.
- Compose invariants: `sh docker/scripts/check-envs.sh` and `sh docker/scripts/test_check_envs.sh`.
- The full integration and pg suites run in CI on the PR (ADR 0026). Locally, run only the targeted tests being written, plus the unit suites and typecheck.

**Changing tests.** Changing an existing test is allowed only for the categories in design D8. Anything else is a stop: update the artifacts and ask the owner.

## 1. Baselines

- [x] 1.1 Run the unit suites (server, storage, media-import, transcription) and typecheck on the base, and record the counts. The DB-suite baseline is the last full CI run (PR #97). List every existing test that D8 categories 1-4 may touch with `grep -rln "createBindings(\|new BlobStore(\|DATA_DIR\|'blobs'\|scratchRoot" --include=*.test.ts server/src packages`, and classify each hit by category or as unchanged.
  - Evidence: base `af0ae1c1` (code = `3cbea66b`). `cd server && npx vitest run --project unit` -> `Tests  350 passed | 3 skipped (353)`; `cd packages/storage && npx vitest run --project unit` -> `Tests  60 passed (60)`; `npx vitest run` in media-import -> `Tests  31 passed | 2 skipped (33)`, transcription -> `Tests  70 passed (70)`; `npm run typecheck` -> exit 0, 0 `error TS` (log `10-1.1-green.log`). DB baseline: the last full CI run, PR #97.
  - Evidence: the grep matches 16 files (log `10-1.1-grep.log`). Category 1: `node/config.test.ts` (`freshProcEnv`, also category 4), `routers/sessions.youtubeImport.int.test.ts:580,601` (direct `createBindings` env), `test/session/frameBus.int.test.ts:49`, `bootOrder.int.test.ts:44,61` and `bootFrameBus.int.test.ts:50` (hand-built `main.ts` envs); plus the non-test `test/harness.ts:61` and `test/session/busProcesses.ts:27`, which the grep's `*.test.ts` filter skips. Category 2: `packages/storage/src/blobStore.test.ts:12`. Category 3: none found; `sessions.localAudioImport.int.test.ts` reads blobs through `ports.audio.list` and `sessions.youtubeImport.int.test.ts:586,1184` reads `scratchRoot()`, which stays `DATA_DIR/tmp`, so both are unchanged. Category 4: `bootGuard.test.ts`, `node/config.test.ts`. Category 5: `test/copyDataDir.test.ts:256`. Unchanged (comment or unrelated DATA_DIR mentions): `ai-runtime/src/aiChatRunner.test.ts`, `ai-runtime/src/aiV2DesignTurnOptions.test.ts`, `storage/src/dataDirLock.test.ts`, `routers/compression.int.test.ts`, `test/session/generateTranscript.remap.int.test.ts` (a fake `scratchRoot`), `startupPurge.test.ts:40` (a source-order check on `createBindings(process.env)`, no env) and `routers/auth.int.test.ts:508` (a comment; it boots through the harness). D8 category 1 names `startupPurge.test.ts` and `auth.int.test.ts`, but neither builds a `createBindings` env, so neither needs an edit.

## 2. Blob store on a shared root (design D3)

- [x] 2.1 Test first in `packages/storage/src/blobStore.test.ts`:
  - two stores on one root, same pid, 50 concurrent puts: every key whole, `.tmp` empty;
  - a temp name matches `put-<uuid>`;
  - `scratchRoot()` is the scratch dir, outside the root;
  - `list('audio/x/')` never returns `.tmp` entries.
  Existing call sites move to the options object (D8 category 2). Red, then change the `BlobStore` constructor and `put`. Green.
  - Evidence: red, `cd packages/storage && npx vitest run --project unit src/blobStore.test.ts` -> `TypeError: The "path" argument must be of type string or an instance of Buffer or URL. Received an instance of Object`, `AssertionError: expected { …(2) } to be '/tmp/autologger-blob-…/dataA/tmp'`, `Tests  11 failed | 2 passed (13)` (log `10-2.1-red.log`). Then the options constructor with the old `put-<pid>-<counter>` name kept, the same command -> `× two stores on one root, same pid, 50 concurrent puts: every key whole, .tmp empty`, `Error: ENOENT: no such file or directory, rename '…/blobs/.tmp/put-324854-1' -> '…/blobs/audio/s3/0003_k.webm'`, `AssertionError: expected 'put-324854-11' to match /^put-[0-9a-f]{8}-…/`, `Tests  2 failed | 11 passed (13)` (log `10-2.1-red-naming.log`): the collision reproduces with two module instances under one pid.
  - Evidence: green, `cd packages/storage && npx vitest run --project unit` -> `Test Files  4 passed (4)`, `Tests  64 passed (64)` (1.1's 60 plus 4); `src/blobStore.test.ts` three more runs -> `Tests  13 passed (13)` each; `npm run typecheck` -> exit 0, 0 `error TS` (log `10-2.1-green.log`). `BlobStore(root, { putTmpDir, scratchDir })`; `put` writes `putTmpDir/put-${randomUUID()}` (the module counter is gone); `scratchRoot()` returns `scratchDir`. `node/config.ts` passes the options object with today's paths (`DATA_DIR/blobs`, `DATA_DIR/tmp` for both) until section 4. Existing tests: D8 category 2 only, the `store()` helper passes `{ putTmpDir: base/tmp, scratchDir: base/scratch }`, so the existing cases' `base/tmp` assertions are unchanged.
- [x] 2.2 Test first: `sweepStaleBlobPutTemps` deletes only `put-*` regular files older than the cutoff. Young files, other names and directories are kept, a file vanishing mid-sweep is tolerated, and the count is returned. Red, then implement and export it. Green.
  - Evidence: red, `cd packages/storage && npx vitest run --project unit src/blobStore.test.ts` -> `× deletes only put-* regular files older than 24 h, and returns the count`, `× tolerates a file that vanishes mid-sweep`, `TypeError: sweepStaleBlobPutTemps is not a function`, `Tests  4 failed | 13 passed (17)` (log `10-2.2-red.log`).
  - Evidence: green, `cd packages/storage && npx vitest run --project unit` -> `Test Files  4 passed (4)`, `Tests  68 passed (68)`; `npm run typecheck` -> exit 0, 0 `error TS` (log `10-2.2-green.log`). `sweepStaleBlobPutTemps(putTmpDir, nowMs, maxAgeMs = BLOB_PUT_TEMP_MAX_AGE_MS /* 24 h */)` in `packages/storage/src/blobStore.ts` (exported through the barrel's `export *`): `readdirSync`, then per `put-*` name `lstatSync` and `unlinkSync` when it is a regular file with `mtimeMs < now - maxAge`; ENOENT (a missing dir, or a file gone mid-sweep) is skipped; returns the count and logs only `autologger: removed <n> stale blob temp file(s)` when n > 0. Cases: 2-day and 24 h + 1 ms `put-` files removed, a 1-minute `put-` file, an old `other-old` file and an old `put-` directory kept; a given `maxAgeMs`; a file removed between `readdir` and `lstat` (a mocked `lstatSync` hook); a missing dir -> 0.

## 3. Scripts (design D5)

- [x] 3.1 Test first in `server/src/test/copyDataDir.test.ts` (D8 category 5): the CLI prints that audio is not in `DATA_DIR` and names the README sections "Blob sync guard" and "Moving audio into BLOB_DIR"; it no longer prints `rsync … ${dst}/blobs/`. Red, then change `server/scripts/copyDataDir.ts`. Green.
  - Evidence: red, `cd server && npx vitest run --project unit src/test/copyDataDir.test.ts` -> `× CLI: usage exit 2, success exit 0, points blobs at the README (shared-blob-volume D5)`, `AssertionError: expected 'source:      /tmp/copydatadir-uPodaX/…' to match /audio is not in DATA_DIR/`, `Tests  1 failed | 9 passed (10)` (log `10-3.1-red.log`); green, the same command -> `Test Files  1 passed (1)`, `Tests  10 passed (10)` (log `10-3.1-green.log`). `copyDataDir.ts` now prints `audio is not in DATA_DIR: it lives in BLOB_DIR, and this script does not copy it.` and `See the README sections "Blob sync guard" and "Moving audio into BLOB_DIR".` in place of the `rsync -a --delete ${src}/blobs/ ${dst}/blobs/` hint. Existing test: D8 category 5 only, the CLI case's title and its blob assertion (it also asserts no `${dst}/blobs/` and no `rsync`).
- [x] 3.2 `server/scripts/merge-session-audio.ts` reads `BLOB_DIR`, required. Test first if the script has a test; otherwise record a typecheck and a refusal smoke with `BLOB_DIR` unset.
  - Evidence: the script has no test (`grep -rn merge-session-audio server/src` -> only `catalogSystem.repo.test.ts`, the reviewed-reason list). Before, `cd server && env -u BLOB_DIR -u DATA_DIR npx tsx scripts/merge-session-audio.ts some-session` -> `error: set DATA_DIR or pass --data-dir (there is no default data directory)`, `exit=1` (log `10-3.2-red.log`). After, the same -> `error: set BLOB_DIR or pass --blob-dir, as an absolute path (there is no default blob directory)`, `exit=1`; `BLOB_DIR=blobs` (relative) -> the same refusal, `exit=1`; `BLOB_DIR=/blobs` with `PGPASSWORD` unset gets past it to `error: database settings missing: …`, `exit=1`; `npm run typecheck` -> exit 0, 0 `error TS` (log `10-3.2-green.log`). The blob path is `join(BLOB_DIR, r2_key)`; `--data-dir` became `--blob-dir` (DATA_DIR was only used for the blob path).

## 4. Boot checks and composition (design D1, D2, D4)

- [x] 4.1 Test first in `server/src/bootGuard.test.ts`:
  - `BLOB_DIR` unset or relative;
  - the four overlaps: equal, blob inside data, data inside blob, `/`;
  - each message names its variable and holds no value.
  Existing cases gain a valid `BLOB_DIR` (D8 category 4). Red, then extend `checkBootEnv`. Green.
  - Evidence: red, `cd server && npx vitest run --project unit src/bootGuard.test.ts` -> `× refuses a missing, empty or relative BLOB_DIR, naming BLOB_DIR and no value`, `× refuses a BLOB_DIR that overlaps DATA_DIR, naming both and no value`, `× checks BLOB_DIR after DATA_DIR and before the catalog settings`, `AssertionError: expected 'catalog connection settings missing: …' to match /^BLOB_DIR/`, `Test Files  1 failed (1)` (log `10-4.1-red.log`); green, the same command -> `Tests  18 passed (18)` (log `10-4.1-green.log`). After the red run one test value changed from `blobs` to `blob-value`: the D1 message itself names `/blobs`, so the not-contains check needs a value the message doesn't hold.
  - Evidence: `server/src/bootGuard.ts` exports `blobDirRefusal(env)` (D1's two messages, verbatim; overlap on `path.resolve`, equal or `startsWith(other + sep)`, so `/` overlaps everything; no symlink resolution), and `checkBootEnv` calls it after `DATA_DIR` and before the PG vars, so `bootGuardCli.ts` (`npm run dev`) refuses too. New cases: unset, empty and three relative values; overlaps `/data`=`/data`, `/data/`, `/data/x/..`, `/data/blobs`, `/srv` over `/srv/data`, and `/`; `/data2`, `/datablobs`, `/srv/blobs` accepted; the check order; no value in any message (the sentinel case gains `BLOB_DIR`). Existing cases: D8 category 4 only, `ok` gains `BLOB_DIR: '/blobs'`.
- [x] 4.2 Test first in `server/src/node/config.test.ts`:
  - `createBindings` refuses the same D1 cases before the lock, creating nothing;
  - a second `createBindings` with another `DATA_DIR` and the same `BLOB_DIR` succeeds;
  - `DATA_DIR/blobs` is not created;
  - `BLOB_DIR/.tmp` is created;
  - the stale sweep runs at boot;
  - the legacy warning: 3 files give one line naming 3 and the command, and an empty or missing dir gives none.
  The env fixtures gain `BLOB_DIR` (D8 categories 1 and 4). Red, then change `createBindings`. Green.
  - Evidence: red, `cd server && npx vitest run --project unit src/node/config.test.ts` -> `× refuses an unset, relative or overlapping BLOB_DIR before the lock, creating nothing` (`AssertionError: undefined: expected [Function] to throw an error`), `× creates BLOB_DIR/.tmp and DATA_DIR/tmp, not DATA_DIR/blobs; the store writes to BLOB_DIR`, `× sweeps put- temp files older than 24 h from BLOB_DIR/.tmp at boot` (`expected [ 'other-old', 'put-old', 'put-young' ] to deeply equal [ 'other-old', 'put-young' ]`), `× warns once, naming the count and the README section, when DATA_DIR/blobs holds files`, `Tests  4 failed | 16 passed (20)` (log `10-4.2-red.log`). "A second server with another DATA_DIR and the same BLOB_DIR boots" and "does not warn when DATA_DIR/blobs is empty or missing" already passed on the base wiring: each DATA_DIR has its own lock, and there was no warning to give.
  - Evidence: green, `cd server && npx vitest run --project unit src/node/config.test.ts src/bootGuard.test.ts` -> `Test Files  2 passed (2)`, `Tests  38 passed (38)` (log `10-4.2-green.log`). `createBindings`: `blobDirRefusal` after the `DATA_DIR` check and before the PG check and the lock (throws its message); after the lock `mkdirSync(DATA_DIR/tmp)` and `mkdirSync(BLOB_DIR/.tmp)`, no `DATA_DIR/blobs`; `warnLegacyBlobs` counts regular files under `DATA_DIR/blobs` (`readdirSync` recursive, errors ignored) and logs D4's line once when n > 0; `new BlobStore(BLOB_DIR, { putTmpDir: BLOB_DIR/.tmp, scratchDir: DATA_DIR/tmp })`; after the YouTube scratch sweep, `sweepStaleBlobPutTemps(putTmpDir, Date.now())`. Existing tests: D8 categories 1 and 4 only, `freshProcEnv` gains a sibling temp `BLOB_DIR` (cleaned up in `afterEach`). The task's "one line naming 3 and the command": the test asserts D4's exact line, which names the count and the README section and holds no command.
- [x] 4.3 Every other direct `createBindings` env in tests gains a sibling temp `BLOB_DIR` (D8 category 1): the harness, `busProcesses` (plus an optional `{ blobDir }`), `startupPurge.test.ts`, `auth.int.test.ts`, `sessions.youtubeImport.int.test.ts`, `frameBus.int.test.ts`, `bootOrder.int.test.ts` and `bootFrameBus.int.test.ts`. Category 3 edits are made where a test reads the blob root through `DATA_DIR`. Typecheck, the server unit suite, and the touched integration files run locally.
  - Evidence: red (the 4.3 edits stashed, 4.2's code in place), `cd server && npx vitest run --project integration src/bootOrder.int.test.ts src/bootFrameBus.int.test.ts src/test/session/frameBus.int.test.ts src/routers/sessions.youtubeImport.int.test.ts src/routers/sessions.localAudioImport.int.test.ts` -> `Error: BLOB_DIR must be set to an absolute path (the compose stacks pin /blobs); there is no default blob directory.`, `Test Files  5 failed (5)`, `Tests  87 failed (87)` (log `10-4.3-red.log`).
  - Evidence: green, the same five files -> `Test Files  5 passed (5)`, `Tests  87 passed (87)`; `cd server && npx vitest run --project unit` -> `Tests  360 passed | 3 skipped (363)` (1.1's 350 plus 4 boot-guard and 6 config cases); storage unit `Tests  68 passed (68)`; `npm run typecheck` -> exit 0, 0 `error TS` (log `10-4.3-green.log`). Harness-backed audio files as a check of the harness change, `cd server && npx vitest run --project integration src/routers/audio.segments.int.test.ts src/routers/audio.mimeInvariant.int.test.ts src/test/session/audioStore.int.test.ts src/routers/flows.int.test.ts src/routers/transcribe.int.test.ts src/routers/compression.int.test.ts` -> `Test Files  6 passed (6)`, `Tests  102 passed (102)` (log `10-4.3-green-audio.log`). DB tests ran locally, targeted files only (ADR 0026).
  - Evidence: D8 category 1 edits: `test/harness.ts` (a sibling `autologger-int-blobs-*` temp `BLOB_DIR`, removed at teardown), `test/session/busProcesses.ts` (`busProcess({ blobDir? })`; without it each process gets its own sibling temp dir), `test/session/frameBus.int.test.ts` (`DATA_DIR: <tmp>/data`, `BLOB_DIR: <tmp>/blobs`), `routers/sessions.youtubeImport.int.test.ts` (a sibling temp `BLOB_DIR` for both boots), `bootOrder.int.test.ts` (the PGPASSWORD and unreachable-catalog cases gain `BLOB_DIR: <cwd>/blobs`; the PGPASSWORD case's title now names `BLOB_DIR`, matching the amended scenario) and `bootFrameBus.int.test.ts` (`stackEnv`). `startupPurge.test.ts` and `auth.int.test.ts` need no edit (1.1: no `createBindings` env). Category 3: none needed; no test reads the blob root through `DATA_DIR`.

## 5. Two processes share audio (spec "Audio blobs are shared by every server process")

- [x] 5.1 Test first: `server/src/test/session/sharedBlobs.int.test.ts` on two `busProcess`es with one `blobDir` and their own `DATA_DIR`s. A segment uploaded on A:
  - returns `206` on B with the same bytes and headers for `bytes=2-5`, and a `200` full body;
  - is found by sync-from-disk on B without duplicating the row.
  Red on the base wiring (B answers `404`), green after section 4.
  - Evidence: red on the base topology (each process its own blob root, as each had its own `DATA_DIR/blobs`: `busProcess` temporarily ignoring `blobDir`), `cd server && npx vitest run --project integration src/test/session/sharedBlobs.int.test.ts` -> `× a segment uploaded through A plays through B, with the same Range answer and bytes` (`AssertionError: expected 404 to be 206`), `× sync-from-disk on B finds A’s segment without duplicating its row, and adds a row-less blob` (`- "scanned": 1,` expected, `0` received), `Tests  2 failed (2)` (log `10-5.1-red.log`); `busProcesses.ts` was restored from a copy afterwards (`git status` shows only the new test file).
  - Evidence: green, the same command three runs -> `Tests  2 passed (2)` each; the other `busProcess` users, `src/routers/sessionWs.access.int.test.ts src/routers/companionAsUser.int.test.ts src/test/session/leaseSweeper.int.test.ts` -> `Test Files  3 passed (3)`, `Tests  25 passed (25)`, and `src/routers/ai.int.test.ts src/routers/aiV2.int.test.ts src/routers/logImport.int.test.ts` -> `Test Files  3 passed (3)`, `Tests  137 passed (137)`; `npm run typecheck` -> exit 0, 0 `error TS` (log `10-5.1-green.log`). DB tests ran locally, targeted files only (ADR 0026).
  - Evidence: new `server/src/test/session/sharedBlobs.int.test.ts`, two `busProcess({ blobDir })` with one temp `BLOB_DIR` and their own `DATA_DIR`s, over real HTTP with the default user's cookie. Case 1: upload 10 bytes on A; on B `Range: bytes=2-5` -> `206` with `content-type: audio/webm`, `accept-ranges: bytes`, `content-length: 4`, `content-range: bytes 2-5/10` and bytes 2-5, the same headers as A's answer; a full GET on B -> `200`, `content-length: 10`, the same bytes. Case 2: sync-from-disk on B -> `{inserted: 0, updated: 0, scanned: 1, has_audio: true}`, one row; a row-less blob written by A's store at `audio/<sid>/0002_<uuid>.webm` -> sync on B `inserted: 1, scanned: 2`, its id listed; a repeat sync -> `inserted: 0`, two rows.

## 6. Compose, image and invariants (design D6)

- [ ] 6.1 Test first in `docker/scripts/test_check_envs.sh`: mutations that fail each new check, namely a dev `BLOB_DIR` not literal `/blobs`, dev `/blobs` not the `dev-blobs` volume, and stage or prod `api` missing `BLOB_DIR` or the `/blobs` named volume. Red, then:
  - `check-envs.sh` (invariants 4 and 6, plus the stage and prod checks, the `unset` list and `dev-custom.env`);
  - `docker/compose.dev.yaml`, `compose.yaml`, and the stage overlay if needed;
  - `docker/Dockerfile`, both stages;
  - the Makefile reset help text.
  Green, plus `sh docker/scripts/check-envs.sh`.
- [ ] 6.2 Build the dev image and bring dev up (`make dev-up`). Check that `/blobs` is a node-owned named volume, that `BLOB_DIR=/blobs` is in the app env, and that the D4 warning names the 15 legacy files and the README section.

## 7. Docs (design D7)

- [ ] 7.1 README:
  - the layout and storage bullets;
  - the env table: `BLOB_DIR`, and the `DATA_DIR` row;
  - the volume table;
  - backup and restore with the blob volume;
  - the new "Moving audio into BLOB_DIR" section (D5), and every `$VOL/blobs` in the backup, pre-seed, cutover and rollback runbooks retargeted to `$BVOL`;
  - the rollback note with the ordered steps from design "Rollback".
- [ ] 7.2 ADR 0021: the Blobs and backup bullets, and slice 10 with its owner decisions and what shipped, plus the follow-up change for unused Supabase services and GoTrue. Then `openspec validate --all --strict`.

## 8. Verify

- [ ] 8.1 Live dev check:
  - run `cp -a /data/blobs/audio /blobs/` as `node` in the running app container (design D5); the file count (15) and `du -sb` match, and the files are `node`-owned;
  - existing audio plays with Range through the gate;
  - start a second process with its own `DATA_DIR` and the shared `/blobs`;
  - upload on A, then fetch with Range on B, which returns the same bytes;
  - stop the second process.
  `/data/blobs` is left in place for the owner.
- [ ] 8.2 CI on the PR: the integration and pg suites are green, with counts against the 1.1 baseline.
- [ ] 8.3 `scripts/check-change.sh` with all gates, then a consistency read by a fresh subagent across the artifacts, the code and the docs. Each finding is fixed or reported to the owner.
