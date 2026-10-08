# Shared blob volume: audio blobs on a volume every server process mounts

Tier: 2
Tier reason:
- it changes the deployment topology: a new named volume and `BLOB_DIR` in every stack, and the
  compose invariants in `docker/scripts/check-envs.sh`;
- it changes concurrency: several processes write one blob root;
- it moves existing data, with a copy script that slice 11's cutover reuses;
- it amends ADR 0021 (the slice 10 plan, the Blobs and backup bullets).

ADR 0021 slice 10.

Approved-by: Kalen 2026-10-08

## Why

Slice 9 lets several server processes share one database, but the audio can't be shared yet:

1. **Blobs live under `DATA_DIR/blobs`, and `DATA_DIR` belongs to one server.** The data-directory
   lock (`acquireDataDirLock`, `server/src/node/config.ts:74`) refuses a second server. A second
   process therefore needs its own `DATA_DIR`, and it sees none of the audio. A segment recorded
   through process A answers `404` through process B.
2. **Temp names collide across containers.** `BlobStore.put` writes `DATA_DIR/tmp/put-<pid>-<counter>`
   (`packages/storage/src/blobStore.ts:57`). Every container usually runs the server under the same
   pid, so two processes writing one root could write the same temp file.
3. **The temp dir is on the wrong filesystem.** If the blobs move to their own volume, the
   `rename` from `DATA_DIR/tmp` crosses filesystems. It fails with `EXDEV` and is no longer
   atomic.

ADR 0021 planned to move the blobs to Supabase Storage. Exploration (2026-10-08) found that the app
uses none of Supabase Storage, PostgREST, Realtime or the gateway. The app holds no key for Storage
and has no network path to it. Storage also caps a file at 50 MB, while imports reach 2 GB.

## Owner decisions (owner, 2026-10-08)

1. **Audio stays on the filesystem, on its own Docker volume** that every server process of a stack
   mounts. That covers the planned topology: several processes on one host.
2. **Object storage waits until the server runs on more than one machine.** The `BlobStore` port is
   unchanged, so moving to Supabase Storage, S3 or MinIO later is a new implementation behind it.
3. **Dropping the unused Supabase services** (PostgREST, Realtime, Storage, the gateway) is a
   separate change after this one, and that change also decides on GoTrue. This change doesn't
   touch them.

## What changes

- **`BLOB_DIR`:**
  - A new required absolute path, and the audio root, moved out of `DATA_DIR/blobs`.
  - The server refuses to boot when it is unset, relative, or overlaps `DATA_DIR`.
  - Keys stay `audio/<session id>/…`.
- **`DATA_DIR` stays per process.** It keeps the lock, the scratch root and the legacy
  `sessions/*.db` files. A second server with its own `DATA_DIR` and the same `BLOB_DIR` boots.
- **The blob store's writes:**
  - temp files go to `BLOB_DIR/.tmp`, named `put-<random UUID>`;
  - write, fsync, rename and cleanup-on-failure are unchanged;
  - at boot, `put-` files older than 24 h are deleted.
- **Moving existing blobs:**
  - A boot warning says when `DATA_DIR/blobs` still holds files.
  - No new copy tool (panel). Existing audio is moved additively, owned by the server user: `cp -a`
    as `node` inside the dev app, or `rsync -a --chown=1000:1000` on the host for stage and prod,
    never with `--delete`. The steps live in a new README section, which slice 11's cutover
    reuses.
  - `server/scripts/copyDataDir.ts` stops printing a blob command into `DATA_DIR/blobs`.
- **Compose and image:**
  - a named blob volume per stack at `/blobs`, and `BLOB_DIR: /blobs` as a literal in the app's
    environment;
  - the image creates `/blobs`, owned by the runtime user;
  - `make *-reset` deletes the volume;
  - the `check-envs` invariants pin all of the above.
- **Docs:**
  - README: the env table, backup and restore, dev setup, and the data-migration steps;
  - ADR 0021: slice 10 and the Blobs and backup bullets.
  - `server/scripts/merge-session-audio.ts` reads `BLOB_DIR`.

The HTTP/WS contract doesn't change: same routes, status codes, Range semantics and bytes.

## Out of scope

- Supabase Storage or any object store (owner decision 2).
- Removing the unused Supabase services (owner decision 3, its own change).
- More than one `api` replica. The fixed `container_name` stays, so the topology change lifts it.
- Streaming uploads: puts still buffer, as today.
- Deleting `DATA_DIR/blobs` on dev. The owner removes it by hand once playback is confirmed.

## Capabilities

- `web-frontend-platform`: "Single-process development" (the `BLOB_DIR` boot checks).
- `core-ports-architecture`: new "Audio blobs are shared by every server process".
- `container-deployment`: "Compose topology is loopback-published, segmented, and operable" (the
  blob volume).
- `local-container-environments`: "Dev app binds loopback behind a Host/Origin gate" (the
  `BLOB_DIR` pin) and "Dev isolates data and secrets, sharing only the operator's Claude login"
  (the `dev-blobs` volume).

## Impact

- **Code:**
  - `server/src/bootGuard.ts`, `server/src/node/config.ts`, `server/src/bootGuardCli.ts`;
  - `packages/storage/src/blobStore.ts`;
  - `server/scripts/merge-session-audio.ts` and `server/scripts/copyDataDir.ts`.
- **Tests:**
  - the harnesses (`server/src/test/harness.ts`, `server/src/test/session/busProcesses.ts`) and
    the `BlobStore` constructor call sites, `bootOrder.int.test.ts`, `bootFrameBus.int.test.ts`
    and `copyDataDir.test.ts`;
  - new unit, config and two-process integration tests.
- **Deployment:**
  - `compose.yaml`, `docker/compose.dev.yaml`, `docker/compose.stage.yaml` if needed, and
    `docker/Dockerfile`;
  - the Makefile help text, `docker/scripts/check-envs.sh` and `docker/scripts/test_check_envs.sh`.
- **Docs:** README and ADR 0021.
