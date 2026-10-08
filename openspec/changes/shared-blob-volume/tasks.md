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

- [ ] 1.1 Run the unit suites (server, storage, media-import, transcription) and typecheck on the base, and record the counts. The DB-suite baseline is the last full CI run (PR #97). List every existing test that D8 categories 1-4 may touch with `grep -rln "createBindings(\|new BlobStore(\|DATA_DIR\|'blobs'\|scratchRoot" --include=*.test.ts server/src packages`, and classify each hit by category or as unchanged.

## 2. Blob store on a shared root (design D3)

- [ ] 2.1 Test first in `packages/storage/src/blobStore.test.ts`:
  - two stores on one root, same pid, 50 concurrent puts: every key whole, `.tmp` empty;
  - a temp name matches `put-<uuid>`;
  - `scratchRoot()` is the scratch dir, outside the root;
  - `list('audio/x/')` never returns `.tmp` entries.
  Existing call sites move to the options object (D8 category 2). Red, then change the `BlobStore` constructor and `put`. Green.
- [ ] 2.2 Test first: `sweepStaleBlobPutTemps` deletes only `put-*` regular files older than the cutoff. Young files, other names and directories are kept, a file vanishing mid-sweep is tolerated, and the count is returned. Red, then implement and export it. Green.

## 3. Scripts (design D5)

- [ ] 3.1 Test first in `server/src/test/copyDataDir.test.ts` (D8 category 5): the CLI prints that audio is not in `DATA_DIR` and names the README sections "Blob sync guard" and "Moving audio into BLOB_DIR"; it no longer prints `rsync … ${dst}/blobs/`. Red, then change `server/scripts/copyDataDir.ts`. Green.
- [ ] 3.2 `server/scripts/merge-session-audio.ts` reads `BLOB_DIR`, required. Test first if the script has a test; otherwise record a typecheck and a refusal smoke with `BLOB_DIR` unset.

## 4. Boot checks and composition (design D1, D2, D4)

- [ ] 4.1 Test first in `server/src/bootGuard.test.ts`:
  - `BLOB_DIR` unset or relative;
  - the four overlaps: equal, blob inside data, data inside blob, `/`;
  - each message names its variable and holds no value.
  Existing cases gain a valid `BLOB_DIR` (D8 category 4). Red, then extend `checkBootEnv`. Green.
- [ ] 4.2 Test first in `server/src/node/config.test.ts`:
  - `createBindings` refuses the same D1 cases before the lock, creating nothing;
  - a second `createBindings` with another `DATA_DIR` and the same `BLOB_DIR` succeeds;
  - `DATA_DIR/blobs` is not created;
  - `BLOB_DIR/.tmp` is created;
  - the stale sweep runs at boot;
  - the legacy warning: 3 files give one line naming 3 and the command, and an empty or missing dir gives none.
  The env fixtures gain `BLOB_DIR` (D8 categories 1 and 4). Red, then change `createBindings`. Green.
- [ ] 4.3 Every other direct `createBindings` env in tests gains a sibling temp `BLOB_DIR` (D8 category 1): the harness, `busProcesses` (plus an optional `{ blobDir }`), `startupPurge.test.ts`, `auth.int.test.ts`, `sessions.youtubeImport.int.test.ts`, `frameBus.int.test.ts`, `bootOrder.int.test.ts` and `bootFrameBus.int.test.ts`. Category 3 edits are made where a test reads the blob root through `DATA_DIR`. Typecheck, the server unit suite, and the touched integration files run locally.

## 5. Two processes share audio (spec "Audio blobs are shared by every server process")

- [ ] 5.1 Test first: `server/src/test/session/sharedBlobs.int.test.ts` on two `busProcess`es with one `blobDir` and their own `DATA_DIR`s. A segment uploaded on A:
  - returns `206` on B with the same bytes and headers for `bytes=2-5`, and a `200` full body;
  - is found by sync-from-disk on B without duplicating the row.
  Red on the base wiring (B answers `404`), green after section 4.

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
