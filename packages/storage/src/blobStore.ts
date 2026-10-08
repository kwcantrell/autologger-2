// Filesystem blob store for audio bytes. Keys (the `r2_key` column — a
// grandfathered legacy schema name) are relative paths under root. put() is atomic: write to
// putTmpDir, fsync, rename. Range gets normalize to {offset,length}; unsatisfiable ranges throw
// InvalidRangeError (→ 416).
//
// shared-blob-volume D3: every server process of a stack writes one root (BLOB_DIR). putTmpDir
// is BLOB_DIR/.tmp, on the root's filesystem so the rename stays atomic; list() and the
// sync-from-disk reconciliation start from `audio/<sid>/`, so they never walk it. scratchDir is
// the calling process's own DATA_DIR/tmp.

import { randomUUID } from 'node:crypto';
import { createReadStream, type Dirent, lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { BlobObject, BlobRange, BlobStore as BlobStorePort } from '@autologger/ports';

export class InvalidRangeError extends Error {}

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

export class BlobStore implements BlobStorePort {
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
    await mkdir(dirname(dest), { recursive: true });
    // shared-blob-volume D3: a random name, since every container usually runs the server under
    // the same pid, so a pid and counter could collide across processes.
    const tmp = join(this.putTmpDir, `put-${randomUUID()}`);
    try {
      const fh = await open(tmp, 'w');
      try {
        await fh.writeFile(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
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
}
