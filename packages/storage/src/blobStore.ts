// Filesystem blob store for audio bytes. Keys (the `r2_key` column — a
// grandfathered legacy schema name) are relative paths under root. put() is atomic: write to
// putTmpDir, fsync, rename. Range gets normalize to {offset,length}; unsatisfiable ranges throw
// InvalidRangeError (→ 416).
//
// shared-blob-volume D3: every server process of a stack writes one root (BLOB_DIR). putTmpDir
// is BLOB_DIR/.tmp, on the root's filesystem so the rename stays atomic; list() and the
// sync-from-disk reconciliation start from `audio/<sid>/`, so they never walk it. scratchDir is
// the calling process's own DATA_DIR/tmp.
//
// media-worker D3, D8, D12: three more directories under the root, none of which list() or
// sync-from-disk walks: `media/` (sticky, world-writable, created by the API; the worker writes
// `media/<job id>/<name>` there and the API adopts a file by opening it O_NOFOLLOW, checking the
// handle and copying it into its own put temp file, never by renaming the worker's inode),
// `.trash/<yyyy-mm-dd>/<key>` (replaced blobs, kept 7 days, purged oldest-first when the volume is
// below the free-space floor) and `.tmp/upload-<id>` (a resumable upload's staging file, written
// part by part at offsets and renamed into place when complete).

import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  createReadStream,
  type Dirent,
  lstatSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  unlink,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { BlobObject, BlobRange, BlobStore as BlobStorePort } from '@autologger/ports';
import type { MediaBlobStore } from '@autologger/ports/media';
import { MEDIA_ADOPT_MAX_BYTES, MEDIA_TRASH_GRACE_MS } from './mediaLimits';

export class InvalidRangeError extends Error {}

/** A worker file the API refused to adopt (media-worker D3): a bad path, a symlink, not a regular
 * file, over the size cap, the wrong owner, or changed under the copy. Maps to `invalid-result`. */
export class MediaAdoptError extends Error {
  override name = 'MediaAdoptError';
}

/** A part body longer than its limit or than the staging file (media-worker D12; maps to `413`). */
export class PartTooLargeError extends Error {
  override name = 'PartTooLargeError';
}

/** Directories at the root that are not blob keys (list() skips them). */
const NON_BLOB_DIRS = new Set(['.tmp', '.trash', 'media']);
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UPLOAD_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const DAY_DIR = /^(\d{4})-(\d{2})-(\d{2})$/;
const COPY_CHUNK = 1024 * 1024;
/** Blob files and their directories: readable by the worker's uid, writable by the API only. */
const BLOB_FILE_MODE = 0o644;
const BLOB_DIR_MODE = 0o755;

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A day: a put older than this was orphaned by a crash, never still in flight. */
export const BLOB_PUT_TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * shared-blob-volume D3: deletes the `put-*` regular files in `putTmpDir` (BLOB_DIR/.tmp) whose
 * mtime is older than `nowMs - maxAgeMs`, and nothing else, so a booting process never removes a
 * write another process has in flight. A file that vanishes mid-sweep (another process finished
 * its rename, or swept it) is skipped. `nowMs` is the system clock: these are filesystem mtimes,
 * not app time. Returns the count, which is all it logs.
 */
export function sweepStaleBlobPutTemps(
  putTmpDir: string,
  nowMs: number,
  maxAgeMs: number = BLOB_PUT_TEMP_MAX_AGE_MS,
): number {
  let names: string[];
  try {
    names = readdirSync(putTmpDir);
  } catch (err) {
    if (isEnoent(err)) return 0; // nothing written yet
    throw err;
  }
  const cutoff = nowMs - maxAgeMs;
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith('put-')) continue;
    const p = join(putTmpDir, name);
    try {
      const st = lstatSync(p);
      if (!st.isFile() || st.mtimeMs >= cutoff) continue;
      unlinkSync(p);
      removed += 1;
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
  }
  if (removed > 0) console.info(`autologger: removed ${removed} stale blob temp file(s)`);
  return removed;
}

export interface BlobStoreDirs {
  /** Where put() writes its temp files: inside the root's filesystem (BLOB_DIR/.tmp). */
  putTmpDir: string;
  /** This process's scratch directory (DATA_DIR/tmp), returned by scratchRoot(). */
  scratchDir: string;
}

export class BlobStore implements BlobStorePort, MediaBlobStore {
  private rootAbs: string;
  private putTmpDir: string;
  private scratchDir: string;

  constructor(root: string, dirs: BlobStoreDirs) {
    this.rootAbs = resolve(root);
    this.putTmpDir = dirs.putTmpDir;
    this.scratchDir = dirs.scratchDir;
  }

  private pathFor(key: string): string {
    const p = resolve(join(this.rootAbs, key));
    if (p !== this.rootAbs && !p.startsWith(this.rootAbs + sep)) {
      throw new Error(`Blob key escapes the store root: ${key}`);
    }
    return p;
  }

  /** Absolute filesystem path for a stored key — existence is NOT checked.
   * For callers that need to open a blob directly as a real file (e.g.
   * mediabunny's `FilePathSource` in the transcript-generation pipeline,
   * which cannot work off a stream). A missing/unreadable file surfaces as
   * that caller's own open/read failure, not here. */
  resolveKeyPath(key: string): string {
    return this.pathFor(key);
  }

  /** The store's scratch directory (outside the blob root, already created
   * at startup) for spooling temporary work files a caller must clean up
   * itself — e.g. transcript generation's per-run concat output. */
  scratchRoot(): string {
    return this.scratchDir;
  }

  async put(
    key: string,
    bytes: ArrayBuffer | Uint8Array,
    _opts: { contentType?: string } = {},
  ): Promise<void> {
    const dest = this.pathFor(key);
    await mkdir(this.putTmpDir, { recursive: true });
    await this.ensureBlobDir(dirname(dest));
    // shared-blob-volume D3: a random name, since every container usually runs the server under
    // the same pid, so a pid and counter could collide across processes.
    const tmp = join(this.putTmpDir, `put-${randomUUID()}`);
    try {
      const fh = await open(tmp, 'w');
      try {
        await fh.writeFile(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
        await fh.chmod(BLOB_FILE_MODE);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, dest);
    } catch (err) {
      // Best-effort: don't orphan the temp file on a failed write/rename. What a crash leaves,
      // sweepStaleBlobPutTemps removes at a later boot (shared-blob-volume D3).
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  async get(key: string, opts: { range?: BlobRange } = {}): Promise<BlobObject | null> {
    const p = this.pathFor(key);
    let size: number;
    try {
      size = (await stat(p)).size;
    } catch {
      return null;
    }
    if (!opts.range) {
      return { size, body: Readable.toWeb(createReadStream(p)) as unknown as ReadableStream };
    }
    let offset: number;
    let length: number;
    if ('suffix' in opts.range) {
      if (opts.range.suffix <= 0) throw new InvalidRangeError('suffix must be positive');
      // A suffix range against a zero-byte blob is unsatisfiable (RFC 9110:
      // no byte lies within a zero-length representation). Without this guard
      // the computed window would be {start: 0, end: -1}, which
      // createReadStream rejects with ERR_OUT_OF_RANGE (→ 500, not 416).
      if (size === 0) throw new InvalidRangeError(`suffix ${opts.range.suffix} of empty blob`);
      length = Math.min(opts.range.suffix, size);
      offset = size - length;
    } else {
      offset = opts.range.offset;
      length = opts.range.length ?? size - offset;
      if (offset < 0 || offset >= size || length <= 0) {
        throw new InvalidRangeError(`bytes ${offset}+${length} of ${size}`);
      }
      length = Math.min(length, size - offset);
    }
    const body = Readable.toWeb(
      createReadStream(p, { start: offset, end: offset + length - 1 }),
    ) as unknown as ReadableStream;
    return { size, range: { offset, length }, body };
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async list(opts: {
    prefix: string;
    cursor?: string;
  }): Promise<{ objects: Array<{ key: string }>; truncated: false; cursor?: undefined }> {
    // prefix is a directory-ish path; walk everything under it. Single-shot
    // (truncated always false) — callers' cursor loops terminate immediately.
    const startDir = this.pathFor(opts.prefix.endsWith('/') ? opts.prefix : dirname(opts.prefix));
    const objects: Array<{ key: string }> = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // missing directory ⇒ empty listing
      }
      for (const e of entries) {
        if (dir === this.rootAbs && NON_BLOB_DIRS.has(e.name)) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else {
          const key = full
            .slice(this.rootAbs.length + 1)
            .split(sep)
            .join('/');
          if (key.startsWith(opts.prefix)) objects.push({ key });
        }
      }
    };
    await walk(startDir);
    return { objects, truncated: false };
  }

  /** Creates `dir` (under the root) and gives each directory from the root down to it mode 0755,
   * whatever the umask, so the worker's uid can read every blob (media-worker D4; S.7). A
   * directory this process does not own keeps its mode (EPERM is ignored). */
  private async ensureBlobDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    if (!dir.startsWith(this.rootAbs + sep)) return;
    let cur = this.rootAbs;
    for (const part of dir.slice(this.rootAbs.length + 1).split(sep)) {
      cur = join(cur, part);
      await chmod(cur, BLOB_DIR_MODE).catch((err: NodeJS.ErrnoException) => {
        if (err?.code !== 'EPERM' && err?.code !== 'ENOENT') throw err;
      });
    }
  }

  // -- media-worker D3: the worker's directory and the handle-based adopt ---------------------------

  private get mediaDir(): string {
    return join(this.rootAbs, 'media');
  }

  /** Creates `media/` with mode 1777 (sticky, world-writable: the worker, another uid, creates
   * `media/<job>/` there; only the owner of an entry, or this process as the directory's owner,
   * may remove it), and repairs the mode if it drifted. Called at boot. */
  async ensureMediaDir(): Promise<void> {
    await mkdir(this.mediaDir, { recursive: true });
    await chmod(this.mediaDir, 0o1777);
  }

  /** Removes `media/<jobId>/` and everything in it; a missing directory is a no-op. */
  async removeMediaJobDir(jobId: string): Promise<void> {
    if (!JOB_ID.test(jobId)) throw new MediaAdoptError('bad media job id');
    await rm(join(this.mediaDir, jobId), { recursive: true, force: true });
  }

  /** The job directories under `media/` with their mtimes (for the orphan sweep). */
  async mediaJobDirs(): Promise<{ jobId: string; mtimeMs: number }[]> {
    let names: string[];
    try {
      names = await readdir(this.mediaDir);
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
    const out: { jobId: string; mtimeMs: number }[] = [];
    for (const name of names) {
      if (!JOB_ID.test(name)) continue;
      try {
        const st = await lstat(join(this.mediaDir, name));
        out.push({ jobId: name, mtimeMs: st.mtimeMs });
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
    }
    return out;
  }

  /**
   * Adopts a worker's output `media/<job>/<name>` as blob `key` by copy (media-worker D3): opens it
   * `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, checks the **handle** (`fstat`: a regular file, at most
   * `maxBytes`, owned by `ownerUid` when given; on Linux the handle's path must still be the job
   * directory's file), reads exactly that many bytes from the handle into this process's own
   * `.tmp/put-<uuid>`, fsyncs and renames it into place, then removes `media/<job>/`. Nothing the
   * worker does after the open changes what is copied, and no worker-owned inode reaches the key.
   * When `key` already exists (a retried apply) nothing is copied and the job directory is
   * removed. Refusals throw `MediaAdoptError` and leave the job directory for the sweep.
   */
  async adoptCopy(
    mediaPath: string,
    key: string,
    opts: { maxBytes?: number; ownerUid?: number } = {},
  ): Promise<{ copied: boolean; bytes: number }> {
    const parts = mediaPath.split('/');
    const [top, job, name] = parts;
    if (
      parts.length !== 3 ||
      top !== 'media' ||
      !job ||
      !name ||
      !JOB_ID.test(job) ||
      !FILE_NAME.test(name)
    ) {
      throw new MediaAdoptError('the result names no media/<job>/<name> file');
    }
    const dest = this.pathFor(key);
    const jobDir = join(this.mediaDir, job);
    try {
      const existing = await stat(dest);
      await rm(jobDir, { recursive: true, force: true });
      return { copied: false, bytes: existing.size };
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
    let dirSt: Awaited<ReturnType<typeof lstat>>;
    try {
      dirSt = await lstat(jobDir);
    } catch {
      throw new MediaAdoptError('no such media job directory');
    }
    if (!dirSt.isDirectory()) throw new MediaAdoptError('the media job path is not a directory');
    const maxBytes = opts.maxBytes ?? MEDIA_ADOPT_MAX_BYTES;
    let src: FileHandle;
    try {
      src = await open(
        join(jobDir, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch {
      throw new MediaAdoptError('the result file cannot be opened without following a link');
    }
    let size: number;
    try {
      const st = await src.stat();
      if (!st.isFile()) throw new MediaAdoptError('the result is not a regular file');
      if (st.size > maxBytes) throw new MediaAdoptError('the result is over the size cap');
      if (opts.ownerUid !== undefined && st.uid !== opts.ownerUid) {
        throw new MediaAdoptError('the result is not owned by the worker');
      }
      await this.checkHandlePath(src, job, name);
      size = st.size;
      await this.copyFromHandle(src, size, dest);
    } finally {
      await src.close();
    }
    await rm(jobDir, { recursive: true, force: true });
    return { copied: true, bytes: size };
  }

  /** On Linux, the open handle's path (`/proc/self/fd/N`) must be the job directory's file, so a
   * directory swapped for a link between the checks and the open is refused. */
  private async checkHandlePath(fh: FileHandle, job: string, name: string): Promise<void> {
    let actual: string;
    try {
      actual = await readlink(`/proc/self/fd/${fh.fd}`);
    } catch {
      return; // no procfs: the lstat and O_NOFOLLOW checks stand alone
    }
    const expected = join(await realpath(this.mediaDir), job, name);
    if (actual !== expected) throw new MediaAdoptError('the result moved during the open');
  }

  private async copyFromHandle(src: FileHandle, size: number, dest: string): Promise<void> {
    await mkdir(this.putTmpDir, { recursive: true });
    await this.ensureBlobDir(dirname(dest));
    const tmp = join(this.putTmpDir, `put-${randomUUID()}`);
    try {
      const out = await open(tmp, 'w');
      try {
        const buf = Buffer.allocUnsafe(Math.min(COPY_CHUNK, Math.max(size, 1)));
        let pos = 0;
        while (pos < size) {
          const { bytesRead } = await src.read(buf, 0, Math.min(buf.length, size - pos), pos);
          if (bytesRead === 0) throw new MediaAdoptError('the result shrank during the copy');
          await out.write(buf, 0, bytesRead);
          pos += bytesRead;
        }
        await out.chmod(BLOB_FILE_MODE);
        await out.sync();
      } finally {
        await out.close();
      }
      await rename(tmp, dest);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  // -- media-worker D8: trash and free space ---------------------------------------------------------

  private get trashDir(): string {
    return join(this.rootAbs, '.trash');
  }

  /** Moves blob `key` to `.trash/<yyyy-mm-dd of nowMs, UTC>/<key>`; false when it is missing. */
  async trash(key: string, nowMs: number): Promise<boolean> {
    const src = this.pathFor(key);
    const rel = src.slice(this.rootAbs.length + 1);
    const dest = join(this.trashDir, utcDay(nowMs), rel);
    try {
      await this.ensureBlobDir(dirname(dest));
      await rename(src, dest);
      return true;
    } catch (err) {
      if (isEnoent(err)) return false;
      throw err;
    }
  }

  /** The trash's day directories, oldest first. */
  private async trashDays(): Promise<{ name: string; dayMs: number }[]> {
    let names: string[];
    try {
      names = await readdir(this.trashDir);
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
    const out: { name: string; dayMs: number }[] = [];
    for (const name of names) {
      const m = DAY_DIR.exec(name);
      if (!m) continue;
      out.push({ name, dayMs: Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) });
    }
    return out.sort((a, b) => a.dayMs - b.dayMs);
  }

  /** Deletes the trash day directories at least `graceMs` (7 days) older than `nowMs`'s day: a blob
   * trashed on day 0 is still there on day 6 and gone after the sweep on day 7. Returns how many
   * day directories it deleted. */
  async sweepTrash(nowMs: number, graceMs: number = MEDIA_TRASH_GRACE_MS): Promise<number> {
    const today = Date.parse(`${utcDay(nowMs)}T00:00:00.000Z`);
    let removed = 0;
    for (const d of await this.trashDays()) {
      if (today - d.dayMs < graceMs) continue;
      await rm(join(this.trashDir, d.name), { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  /** Low-disk mode (D8): deletes trashed files oldest day first (then oldest file) until at least
   * `bytes` are freed or the trash is empty; empty day directories go too. Returns the bytes freed. */
  async purgeTrashOldestFirst(bytes: number): Promise<number> {
    let freed = 0;
    for (const d of await this.trashDays()) {
      if (freed >= bytes) break;
      const dayDir = join(this.trashDir, d.name);
      const files: { path: string; size: number; mtimeMs: number }[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          const full = join(dir, e.name);
          if (e.isDirectory()) await walk(full);
          else {
            const st = await lstat(full);
            files.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
          }
        }
      };
      await walk(dayDir);
      files.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.path < b.path ? -1 : 1));
      let left = files.length;
      for (const f of files) {
        if (freed >= bytes) break;
        await unlink(f.path).catch((err) => {
          if (!isEnoent(err)) throw err;
        });
        freed += f.size;
        left -= 1;
      }
      if (left === 0) await rm(dayDir, { recursive: true, force: true });
    }
    return freed;
  }

  /** Bytes available to this process on the root's filesystem (`statfs`: `bavail × bsize`). */
  async freeBytes(): Promise<number> {
    await mkdir(this.rootAbs, { recursive: true });
    const st = await statfs(this.rootAbs);
    return Number(st.bavail) * Number(st.bsize);
  }

  // -- media-worker D12: resumable upload staging ----------------------------------------------------

  private stagingPath(id: string): string {
    if (!UPLOAD_ID.test(id)) throw new Error('bad upload id');
    return join(this.putTmpDir, `upload-${id}`);
  }

  /** Creates (or reopens) `.tmp/upload-<id>` as a sparse file of `size` bytes, mode 0600. */
  async openStaging(id: string, size: number): Promise<void> {
    const p = this.stagingPath(id);
    await mkdir(this.putTmpDir, { recursive: true });
    const fh = await open(p, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    try {
      if ((await fh.stat()).size !== size) await fh.truncate(size);
    } finally {
      await fh.close();
    }
  }

  /** Writes `body` at `offset` of the staging file while hashing it; refuses (PartTooLargeError,
   * before writing past the limit) a body longer than `maxBytes` or reaching past the file's end.
   * Returns the byte count and the hex sha256 of what was written. */
  async writePart(
    id: string,
    offset: number,
    body: Uint8Array | AsyncIterable<Uint8Array>,
    opts: { maxBytes?: number } = {},
  ): Promise<{ bytes: number; sha256: string }> {
    const fh = await open(this.stagingPath(id), constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const limit = Math.min(
        opts.maxBytes ?? Number.POSITIVE_INFINITY,
        (await fh.stat()).size - offset,
      );
      const hash = createHash('sha256');
      let written = 0;
      const chunks: AsyncIterable<Uint8Array> | Uint8Array[] =
        body instanceof Uint8Array ? [body] : body;
      for await (const chunk of chunks) {
        if (written + chunk.length > limit) throw new PartTooLargeError('part too large');
        hash.update(chunk);
        let done = 0;
        while (done < chunk.length) {
          const { bytesWritten } = await fh.write(
            chunk,
            done,
            chunk.length - done,
            offset + written + done,
          );
          done += bytesWritten;
        }
        written += chunk.length;
      }
      return { bytes: written, sha256: hash.digest('hex') };
    } finally {
      await fh.close();
    }
  }

  /** Re-reads the staging file and hashes it per `partSize` part (the whole-file check, D12). */
  async rehashParts(id: string, partSize: number): Promise<{ size: number; sha256: string[] }> {
    const fh = await open(this.stagingPath(id), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const size = (await fh.stat()).size;
      const out: string[] = [];
      const buf = Buffer.allocUnsafe(Math.min(COPY_CHUNK, Math.max(partSize, 1)));
      for (let start = 0; start < size; start += partSize) {
        const end = Math.min(start + partSize, size);
        const hash = createHash('sha256');
        let pos = start;
        while (pos < end) {
          const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, end - pos), pos);
          if (bytesRead === 0) throw new Error('staging file shrank');
          hash.update(buf.subarray(0, bytesRead));
          pos += bytesRead;
        }
        out.push(hash.digest('hex'));
      }
      return { size, sha256: out };
    } finally {
      await fh.close();
    }
  }

  /** fsyncs the staging file and renames it into place as blob `key` (same filesystem). */
  async adoptStaging(id: string, key: string): Promise<void> {
    const p = this.stagingPath(id);
    const dest = this.pathFor(key);
    const fh = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      // Staged 0600 (API-only); readable by the worker once it is a blob (S.7).
      await fh.chmod(BLOB_FILE_MODE);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await this.ensureBlobDir(dirname(dest));
    await rename(p, dest);
  }

  /** Deletes the staging file; a missing one is a no-op. */
  async removeStaging(id: string): Promise<void> {
    await rm(this.stagingPath(id), { force: true });
  }
}
