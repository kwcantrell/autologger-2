## ADDED Requirements

### Requirement: Audio blobs are shared by every server process
The audio blob store SHALL live under `BLOB_DIR`, a directory every server process of a stack
mounts (ADR 0021 slice 10, owner decision 2026-10-08), separate from each process's own
`DATA_DIR`. The `BlobStore` port SHALL be unchanged, and keys SHALL stay `audio/<session id>/…`.

- **Atomic, collision-free writes.** The filesystem `BlobStore` SHALL write each `put` to a temp
  file in `BLOB_DIR/.tmp` (inside the blob root's filesystem, so the final rename is atomic),
  named `put-` plus a random UUID, never a process id or counter; it SHALL fsync the file, rename
  it into place, and remove it when the write or rename fails. `list` and the sync-from-disk
  reconciliation SHALL never see `.tmp`.
- **Per-process scratch.** `scratchRoot()` SHALL stay `DATA_DIR/tmp`, the calling process's own
  scratch directory (YouTube import temp dirs, transcript spooling); the boot sweep of stale
  YouTube temp dirs SHALL touch only that directory.
- **Stale temp files.** At boot, a server SHALL delete files in `BLOB_DIR/.tmp` whose names start
  with `put-` and whose modification time is more than 24 hours old, and nothing else, so a
  process starting never removes a write another process has in flight.
- **Legacy blobs.** When `DATA_DIR/blobs` exists and holds any file at boot, the server SHALL
  log one warning giving the file count and naming the README section "Moving audio into
  BLOB_DIR", and SHALL boot anyway; it SHALL NOT read, move or delete those files. No new copy
  tool is added: existing audio is moved with an additive copy (never `--delete`) that leaves
  the files owned by the server's runtime user, as that README section and the rollback steps
  describe.

#### Scenario: Audio stored by one process plays through another
- **WHEN** two server processes share a database and `BLOB_DIR`, each with its own `DATA_DIR`,
  and audio is uploaded through the first
- **THEN** the second serves the segment, with the same Range semantics and bytes, and
  sync-from-disk on the second finds it

#### Scenario: Concurrent writers never share a temp file
- **WHEN** two `BlobStore` instances on the same root, standing for two processes with the same
  process id, put different keys at the same time
- **THEN** both blobs are stored whole, and no temp file is left in `BLOB_DIR/.tmp`

#### Scenario: A booting process keeps another's in-flight write
- **WHEN** a server boots while `BLOB_DIR/.tmp` holds a `put-` file modified a minute ago and
  another modified two days ago
- **THEN** only the two-day-old file is deleted

#### Scenario: Legacy blobs are reported, not touched
- **WHEN** a server boots with three files under `DATA_DIR/blobs`
- **THEN** it logs one warning naming the count 3 and the README section, boots, and the three
  files are unchanged
