// Filesystem blob store for audio bytes. Keys (the `r2_key` column — a
// grandfathered legacy schema name) are relative paths under root. put() is atomic: write to tmpDir (outside root, so list()
// and reconciliation never see partials), fsync, rename. Range gets normalize
// to {offset,length}; unsatisfiable ranges throw InvalidRangeError (→ 416).

import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

export class InvalidRangeError extends Error {}

export type BlobRange = { offset: number; length?: number } | { suffix: number };

export interface BlobObject {
  size: number;
  range?: { offset: number; length: number };
  body: ReadableStream;
}

let tmpCounter = 0;

export class BlobStore {
  private rootAbs: string;

  constructor(
    root: string,
    private tmpDir: string,
  ) {
    this.rootAbs = resolve(root);
  }

  private pathFor(key: string): string {
    const p = resolve(join(this.rootAbs, key));
    if (p !== this.rootAbs && !p.startsWith(this.rootAbs + sep)) {
      throw new Error(`Blob key escapes the store root: ${key}`);
    }
    return p;
  }

  async put(
    key: string,
    bytes: ArrayBuffer | Uint8Array,
    _opts: { contentType?: string } = {},
  ): Promise<void> {
    const dest = this.pathFor(key);
    await mkdir(this.tmpDir, { recursive: true });
    await mkdir(dirname(dest), { recursive: true });
    const tmp = join(this.tmpDir, `put-${process.pid}-${(tmpCounter += 1)}`);
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, dest);
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
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // missing directory ⇒ empty listing
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else {
          const key = full.slice(this.rootAbs.length + 1).split(sep).join('/');
          if (key.startsWith(opts.prefix)) objects.push({ key });
        }
      }
    };
    await walk(startDir);
    return { objects, truncated: false };
  }
}
