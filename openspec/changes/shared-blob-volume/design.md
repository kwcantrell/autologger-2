# Design: shared-blob-volume

## Context

Today's blob path:

- **Store:** `createBindings` (`server/src/node/config.ts`) builds the store as
  `new BlobStore(join(dataDir,'blobs'), join(dataDir,'tmp'))`.
- **Atomic puts:** `BlobStore.put` (`packages/storage/src/blobStore.ts`) writes
  `tmpDir/put-<pid>-<counter>`, fsyncs, then renames into the root.
- **Callers needing a real path:**
  - `scratchRoot()` returns the same `tmpDir`;
  - the YouTube import makes its per-request temp dirs there, and `sweepStaleYoutubeImportTempDirs`
    clears stale ones at boot;
  - transcript generation spools there, and opens blobs by path through `resolveKeyPath`.
- **Keys:** `audio/<sid>/<ordinal>_<uuid>.<ext>`. Segment ids are random UUIDs, so two
  processes never write the same key.
- **Size:** dev holds 15 blob files (20 MB) under `/data/blobs` in the `dev-data` volume.

## Decisions

### D1. `BLOB_DIR`, required and disjoint from `DATA_DIR`

`checkBootEnv` (`server/src/bootGuard.ts`) and `createBindings` both refuse, in this order, after
the `DATA_DIR` check and before the PG check and the lock:

- **Unset or relative:** `BLOB_DIR must be set to an absolute path (the compose stacks pin /blobs); there is no default blob directory.`
- **Overlap:** `BLOB_DIR and DATA_DIR must be separate directories, neither inside the other.`
  - Overlap is decided on `path.resolve` of both: equal, or one starts with the other plus `sep`.
  - `/` overlaps everything.
  - Symlinks are not followed: the paths may not exist yet, and the stacks pin literals.

`createBindings` repeats both checks because tests and `main.ts` reach it without the boot guard.
That's the same pattern it already uses for `DATA_DIR`.

**No default.** A default under `DATA_DIR` would bring back the overlap. A default elsewhere would
be a hidden data location, which retire-host-dev D1 forbids.

### D2. `DATA_DIR` stays per process

- **Lock:** `acquireDataDirLock(dataDir)` is unchanged: one server per `DATA_DIR`.
- **Scratch:** `DATA_DIR/tmp` stays the scratch root, for YouTube temp dirs and transcript
  spooling. The boot sweep runs on it, so a booting process only clears its own scratch.
- **Legacy files:** `sessions/*.db` and `catalog.db` stay for slice 11.
- **`DATA_DIR/blobs`:** no longer created.

### D3. The blob store on a shared root

- **Constructor:** `new BlobStore(root, { putTmpDir, scratchDir })`. `createBindings` passes:
  - `root = BLOB_DIR`;
  - `putTmpDir = BLOB_DIR/.tmp`, created with `mkdirSync({recursive:true})` after the lock;
  - `scratchDir = DATA_DIR/tmp`.
- **Temp files:**
  - `put` writes `putTmpDir/put-${randomUUID()}`. The pid and the module counter go away.
  - The rest is unchanged: `mkdir` of the destination dir, write, `fsync`, `rename`, and `rm` of
    the temp file on failure.
  - The temp dir is inside the root's filesystem, so the rename is atomic.
- **What `list` sees:** `list` starts from the prefix directory, and every caller passes
  `audio/<sid>/`, so `.tmp` is never walked. `syncAudioFromBlobs` also matches only
  `/\d{4}_<uuid>\.<ext>$/`.
- **Stale temp files:** `sweepStaleBlobPutTemps(putTmpDir, nowMs, maxAgeMs = 24h)` is a new
  export.
  - It deletes regular files named `put-*` whose `mtimeMs < now - maxAge`, and nothing else.
  - It tolerates a file that vanishes mid-sweep: another process may finish its rename, or sweep
    the same file.
  - It returns the count, and logs only that count.
  - Called once from `createBindings`, after the store is built. It uses the system clock: these
    are filesystem mtimes, not app time.
- **Concurrent readers:** a reader holding an open stream keeps reading after another process
  deletes the key, because POSIX unlink semantics apply. The delete callers don't change.

### D4. The legacy-blob warning

After the lock, `createBindings` counts regular files under `DATA_DIR/blobs`, recursively. If
there are any, it logs one line:

`autologger: DATA_DIR/blobs holds <n> legacy audio file(s) the server no longer reads; move them into BLOB_DIR (README "Moving audio into BLOB_DIR")`

The line holds a count and fixed text only. The counting never opens or
changes a file, and an error while counting is ignored, so it can't block boot.

### D5. Moving existing audio, with no new tool (panel)

The panel found that a new copy script would repeat the README's existing blob tooling. It would
also be missing from the api image, which ships no `server/scripts`, and run from the host as root
it would leave root-owned directories that the server (uid 1000) could not rename into. So no copy
tool is added. Existing audio is moved with an **additive** copy that never uses `--delete`. New
segments may already be in the blob volume, because the server writes there from its first boot,
and a mirror would delete them.

- **Dev, now:** inside the running app container, as `node`: `cp -a /data/blobs/audio /blobs/`.
  The server can keep running: the copy only adds keys the server never writes, since new
  segment ids are fresh UUIDs. Until a file is fully copied, its old segment answers `404` or a
  short body, as it does before the move. Then check that the file count and total bytes match
  (`find … | wc -l`, `du -sb`). `cp -a` as `node` leaves `node`-owned files, and the source is
  only read.
- **Stage and prod (slice 11's cutover, and any operator):** on the host, with `api` stopped:
  `sudo rsync -a --chown=1000:1000 "$VOL/blobs/" "$BVOL/"`. `$VOL` is the data volume's
  mountpoint and `$BVOL` the blob volume's. Without `--delete` the copy is additive. `--chown`
  gives the server's user every file and directory.
- **README:** a new section, "Moving audio into BLOB_DIR", holds both commands and the checks.

**`copyDataDir.ts`.** It no longer prints the blob command that targets the destination's
`DATA_DIR/blobs`. It prints that audio is not in `DATA_DIR` and points to the README sections
"Blob sync guard" and "Moving audio into BLOB_DIR". Its CLI test asserts the new text (D8
category 5).

`server/scripts/merge-session-audio.ts` builds its paths from `BLOB_DIR`, required, instead of
`join(dataDir,'blobs')`.

### D6. Compose, image and invariants

- **`docker/Dockerfile`:** both runtime stages run `mkdir -p /blobs && chown node:node /blobs`,
  and both add `ENV BLOB_DIR=/blobs`, next to `DATA_DIR`. The prod stage adds `/blobs` to its
  `VOLUME` list. A new named volume copies the image directory's ownership, so `/blobs` is
  writable by uid 1000.
- **`compose.yaml` (`api`):**
  - `BLOB_DIR: /blobs` as a literal;
  - the volume `autologger-blobs:/blobs`, declared under `volumes:`.
  - Stage layers `docker/compose.stage.yaml` over `compose.yaml` under the overlay's own `name:`,
    so its blob volume is that project's, disjoint from prod by construction. The overlay
    changes only if it re-lists the `api` volumes.
- **`docker/compose.dev.yaml` (`app`):** `BLOB_DIR: /blobs` as a literal, and the volume
  `dev-blobs:/blobs`, declared.
- **`make dev-reset` / `stage-reset`:** they already run `compose down -v`, which deletes every
  project volume. Only their help text changes, to name the blob volume.
- **`docker/scripts/check-envs.sh`:**
  - invariant 6, dev: `BLOB_DIR=="/blobs"` as a raw literal and resolved, and `BLOB_DIR=/x` added
    to `dev-custom.env`;
  - invariant 4, dev: `/blobs` is the `dev-blobs` named volume;
  - stage and prod: `api` has `BLOB_DIR=="/blobs"` and a single named-volume mount at `/blobs`;
  - `BLOB_DIR` added to the `unset` list.
- **`docker/scripts/test_check_envs.sh`:** cases where each new check fails on a mutated file.

### D7. Docs

- **README:**
  - the layout diagram and storage bullets: blobs under `BLOB_DIR`;
  - the env table: a new `BLOB_DIR` row, and the `DATA_DIR` row reads "per-process lock, scratch,
    legacy files";
  - the volume table: a new `autologger_autologger-blobs` row;
  - backup and restore: the `BLOBSYNC` source and destination become the blob volume's
    mountpoint (`$BVOL`);
  - the data-migration steps: copy into the blob volume;
  - the new "Moving audio into BLOB_DIR" section (D5);
  - every `$VOL/blobs` in the backup, pre-seed, cutover and rollback runbooks becomes the blob
    volume's mountpoint `$BVOL`, and the volume table gains the blob volume row.
- **ADR 0021:**
  - the Blobs bullet: a shared volume, and object storage when the server runs on more than one
    host;
  - the backup bullet: the blob volume instead of the Storage volume;
  - slice 10: renamed and its decisions recorded;
  - a note that a follow-up change drops the unused Supabase services and decides on GoTrue.

### D8. Tests

Write the test first. Existing tests change only in these categories:

1. **`BLOB_DIR` in test environments.** Every direct `createBindings` env in tests gets a
   `BLOB_DIR`: a temp dir that is a sibling of its `DATA_DIR`, never inside it. Affected:
   - `test/harness.ts`
   - `test/session/busProcesses.ts`
   - `startupPurge.test.ts`
   - `auth.int.test.ts`
   - `sessions.youtubeImport.int.test.ts`
   - `frameBus.int.test.ts`
   - `node/config.test.ts` (its env and proxy fixtures)
   - `bootOrder.int.test.ts` and `bootFrameBus.int.test.ts`, which start `main.ts` with a
     hand-built env (panel); each case keeps the variable it exercises

   `busProcess` gains an optional `{ blobDir }` so two processes can share one.
2. **The constructor.** `blobStore.test.ts` call sites move to the options object.
3. **Assertions that read `DATA_DIR/blobs`.** Tests that read the blob root through the data dir
   read it through `BLOB_DIR` instead. That's either `ports.audio.list`, which is unchanged, or a
   `readdirSync` of the scratch root, which stays `DATA_DIR/tmp`.
4. **Boot guard and config.** `bootGuard.test.ts` and `config.test.ts` gain the D1 cases. Each
   existing case's env gains a valid `BLOB_DIR` so it still exercises its own variable.
5. **`copyDataDir` hint.** `server/src/test/copyDataDir.test.ts` asserts the new blob guidance
   instead of the `rsync … ${dst}/blobs/` line (D5).

New tests:

- **Unit, `packages/storage`:**
  - two stores on one root, with `process.pid` the same: 50 concurrent puts, all keys whole, and
    `.tmp` empty after;
  - a temp name matches `put-<uuid>`;
  - `scratchRoot()` is the scratch dir, not inside the root;
  - `list('audio/x/')` never returns `.tmp` entries;
  - the stale sweep: young and old `put-` files, plus a non-`put-` file and a directory, which it
    leaves alone;
- **Unit, server:**
  - `checkBootEnv` and `createBindings` on unset, relative and the four overlaps (equal, blob
    inside data, data inside blob, `/`);
  - the legacy warning: 3 files gives one line with "3", and an empty or missing dir gives none;
  - nothing is created when refused.
- **Integration:** `sharedBlobs.int.test.ts` on two `busProcess`es with one `blobDir` and their own
  `DATA_DIR`s. A segment uploaded on A:
  - returns `206` with the same bytes for `bytes=2-5` on B;
  - is found by sync-from-disk on B, with the counts unchanged when the row already exists.
- **Config:** a second `createBindings` with another `DATA_DIR` and the same `BLOB_DIR` succeeds.
  The same `DATA_DIR` is still refused, which the existing test covers.

### D9. The shared dev secret's provider key (amended after approval, owner 2026-10-08)

Both checkouts share one dev OpenBao secret, `kv/autologger/dev`. The owner added
`PROVIDER_KEYS_SECRET` to it for the in-flight `byo-ai-providers` change. `compose-run.mjs`
refuses a whole secret that holds a key outside `docker/secrets-env.yaml`, so every `make dev-*`
on this branch is refused, and 6.2 and 8.1 can't run. Removing the key from OpenBao would break
the other branch's dev server, which refuses to boot without it.

- **The fix:** `docker/secrets-env.yaml` lists the key, directly after `FRAME_BUS_SECRET:`, with
  the two lines the `byo-ai-providers` branch adds at the same spot, byte for byte, so the two
  branches merge cleanly:

  ```yaml
        # Provider keys: encrypts users' provider API keys at rest (byo-ai-providers D2; base64 of 32 bytes)
        PROVIDER_KEYS_SECRET:
  ```
- **What it does here:** this server never reads the variable. The app container receives it, as
  it receives the retired `API_TOKEN`. That's a residual: a secret this branch doesn't use sits in
  the app's environment on dev, and on stage and prod once their secrets hold it, until the
  providers change lands.
- **Checks:** `sh docker/scripts/check-envs.sh` (invariant 15: compose and the allowlist agree)
  and `node --test docker/scripts/compose-run.test.mjs` if it pins the allowlist.

## Risks

- **Total size.** The blob volume has no cap of its own, as before. Disk use is the host's
  concern, unchanged.
- **A crash between put and row.** An orphaned blob can be left, exactly as today. sync-from-disk
  re-creates its row. This change adds no new orphan path.
- **Forgetting the move.** If an operator never moves `DATA_DIR/blobs` after deploying, old
  segments `404` until they do. The D4 warning names the README section at every boot, and slice
  11's runbook lists the step.

## Rollback

Blobs written after the deploy exist only in the blob volume. To roll back without losing them,
follow these steps in order. The README's rollback note holds them.

1. Stop `api` (dev: the app), so nothing writes during the copy.
2. Copy the blob volume back, additively and owned by the server user:
   - stage and prod: `sudo mkdir -p "$VOL/blobs" && sudo rsync -a --chown=1000:1000 --exclude /.tmp/ "$BVOL/" "$VOL/blobs/"`;
   - dev: the app is stopped, so a one-off container of the dev image mounts both volumes:
     `docker run --rm -u node -v autologger-dev_dev-data:/data -v autologger-dev_dev-blobs:/blobs --entrypoint sh autologger-dev:local -c 'mkdir -p /data/blobs && cp -a /blobs/audio /data/blobs/'`
     (amended after approval: the first wording ran the copy inside the stopped app container).

   Check the file count and bytes.
3. Revert the code, then start.
4. Keep the blob volume until playback of new and old segments is confirmed. Removing it is the
   owner's step.
