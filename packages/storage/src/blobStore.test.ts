import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BlobStore,
  InvalidRangeError,
  MediaAdoptError,
  PartTooLargeError,
  sweepStaleBlobPutTemps,
} from './blobStore';

// shared-blob-volume D3: records the temp path of every rename, so a test can see the name a put
// chose. Delegates to the real rename.
const renamedFrom: string[] = [];
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    rename: async (from: string, to: string) => {
      renamedFrom.push(String(from));
      return real.rename(from, to);
    },
  };
});

// shared-blob-volume D3: lets a test run code just before the sweep stats a file, to stand for
// another process finishing its rename (or sweeping the same file) mid-sweep.
let beforeLstat: ((path: string) => void) | null = null;
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    lstatSync: ((path: string, ...rest: unknown[]) => {
      beforeLstat?.(String(path));
      return (real.lstatSync as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof real.lstatSync,
  };
});

let base: string;
afterEach(() => rmSync(base, { recursive: true, force: true }));

function store(): BlobStore {
  base = mkdtempSync(join(tmpdir(), 'autologger-blob-'));
  return new BlobStore(join(base, 'audio'), {
    putTmpDir: join(base, 'tmp'),
    scratchDir: join(base, 'scratch'),
  });
}

// Narrowing wrapper: every get() below is expected to hit, so a miss should
// fail with the key that missed rather than a bare TypeError on `null!`.
async function getOrThrow(
  s: BlobStore,
  key: string,
  opts?: Parameters<BlobStore['get']>[1],
): Promise<NonNullable<Awaited<ReturnType<BlobStore['get']>>>> {
  const obj = await s.get(key, opts);
  if (obj === null) throw new Error(`expected a blob at '${key}'`);
  return obj;
}

async function drain(body: ReadableStream): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const c of body as unknown as AsyncIterable<Uint8Array>) chunks.push(c);
  return Buffer.concat(chunks);
}

const BYTES = new TextEncoder().encode('0123456789'); // 10 bytes

describe('BlobStore', () => {
  it('put/get round-trip with nested keys, and size is reported', async () => {
    const s = store();
    await s.put('audio/sess1/0001_x.webm', BYTES);
    const obj = await getOrThrow(s, 'audio/sess1/0001_x.webm');
    expect(obj.size).toBe(10);
    expect((await drain(obj.body)).toString()).toBe('0123456789');
  });

  it('get returns null for a missing key', async () => {
    const s = store();
    expect(await s.get('audio/nope')).toBeNull();
  });

  it('serves offset/length and suffix ranges, normalized to offset/length', async () => {
    const s = store();
    await s.put('k', BYTES);
    const mid = await getOrThrow(s, 'k', { range: { offset: 2, length: 3 } });
    expect(mid.range).toEqual({ offset: 2, length: 3 });
    expect((await drain(mid.body)).toString()).toBe('234');
    const tail = await getOrThrow(s, 'k', { range: { suffix: 4 } });
    expect(tail.range).toEqual({ offset: 6, length: 4 });
    expect((await drain(tail.body)).toString()).toBe('6789');
    const openEnd = await getOrThrow(s, 'k', { range: { offset: 7 } });
    expect(openEnd.range).toEqual({ offset: 7, length: 3 });
  });

  it('throws InvalidRangeError on out-of-bounds or non-positive ranges', async () => {
    const s = store();
    await s.put('k', BYTES);
    await expect(s.get('k', { range: { offset: 10 } })).rejects.toBeInstanceOf(InvalidRangeError);
    await expect(s.get('k', { range: { offset: 5, length: -2 } })).rejects.toBeInstanceOf(
      InvalidRangeError,
    );
    // suffix larger than the file → whole file (HTTP semantics), not an error
    const whole = await getOrThrow(s, 'k', { range: { suffix: 999 } });
    expect(whole.range).toEqual({ offset: 0, length: 10 });
  });

  it('throws InvalidRangeError for a suffix range against a zero-byte blob', async () => {
    const s = store();
    await s.put('k', new Uint8Array(0));
    await expect(s.get('k', { range: { suffix: 1 } })).rejects.toBeInstanceOf(InvalidRangeError);
    await expect(s.get('k', { range: { suffix: 999 } })).rejects.toBeInstanceOf(InvalidRangeError);
    // No range at all on the same zero-byte blob still succeeds (whole body).
    const whole = await getOrThrow(s, 'k');
    expect(whole.size).toBe(0);
    expect((await drain(whole.body)).length).toBe(0);
  });

  it('list returns keys under a prefix; partial temp files never appear', async () => {
    const s = store();
    await s.put('audio/a/0001_x.webm', BYTES);
    await s.put('audio/a/0002_y.webm', BYTES);
    await s.put('audio/b/0001_z.webm', BYTES);
    const res = await s.list({ prefix: 'audio/a/' });
    expect(res.objects.map((o) => o.key).sort()).toEqual([
      'audio/a/0001_x.webm',
      'audio/a/0002_y.webm',
    ]);
    expect(res.truncated).toBe(false);
    // temp dir is outside the listing root entirely
    expect(readdirSync(base)).toContain('tmp');
  });

  it('delete removes the file; deleting a missing key is a no-op', async () => {
    const s = store();
    await s.put('k', BYTES);
    await s.delete('k');
    expect(await s.get('k')).toBeNull();
    await expect(s.delete('k')).resolves.toBeUndefined();
  });

  it('put cleans up its temp file when the final rename fails', async () => {
    const s = store();
    // Make `audio/a` a directory so a put() targeting that exact key fails at
    // the rename step (dest is an existing directory).
    await s.put('audio/a/0001_x.webm', BYTES);
    await expect(s.put('audio/a', BYTES)).rejects.toThrow();
    expect(readdirSync(join(base, 'tmp'))).toEqual([]);
  });

  it('rejects keys escaping the root', async () => {
    const s = store();
    await expect(s.put('../escape', BYTES)).rejects.toThrow();
    await expect(s.get('../../etc/passwd')).rejects.toThrow();
  });
});

// shared-blob-volume D3: several processes write one blob root. Each process has its own module
// instance (vi.resetModules), all with the same process.pid, as two containers usually have.
describe('BlobStore on a shared root (shared-blob-volume D3)', () => {
  async function freshBlobStoreClass(): Promise<typeof BlobStore> {
    vi.resetModules();
    return (await import('./blobStore')).BlobStore;
  }

  function sharedLayout(): { root: string; putTmpDir: string; scratchA: string; scratchB: string } {
    base = mkdtempSync(join(tmpdir(), 'autologger-blob-'));
    const root = join(base, 'blobs');
    return {
      root,
      putTmpDir: join(root, '.tmp'),
      scratchA: join(base, 'dataA', 'tmp'),
      scratchB: join(base, 'dataB', 'tmp'),
    };
  }

  it('two stores on one root, same pid, 50 concurrent puts: every key whole, .tmp empty', async () => {
    const l = sharedLayout();
    const A = await freshBlobStoreClass();
    const B = await freshBlobStoreClass();
    const a = new A(l.root, { putTmpDir: l.putTmpDir, scratchDir: l.scratchA });
    const b = new B(l.root, { putTmpDir: l.putTmpDir, scratchDir: l.scratchB });
    const body = (i: number) => new TextEncoder().encode(`blob-${i}-`.repeat(2000 + i));
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        (i % 2 ? a : b).put(`audio/s${i % 5}/${String(i).padStart(4, '0')}_k.webm`, body(i)),
      ),
    );
    for (let i = 0; i < 50; i++) {
      const obj = await getOrThrow(a, `audio/s${i % 5}/${String(i).padStart(4, '0')}_k.webm`);
      expect(Buffer.compare(await drain(obj.body), Buffer.from(body(i))), `key ${i}`).toBe(0);
    }
    expect(readdirSync(l.putTmpDir)).toEqual([]);
  });

  it('names a temp file put-<uuid> in putTmpDir, with no pid or counter', async () => {
    const l = sharedLayout();
    const s = new BlobStore(l.root, { putTmpDir: l.putTmpDir, scratchDir: l.scratchA });
    renamedFrom.length = 0;
    await s.put('audio/x/0001_k.webm', BYTES);
    expect(renamedFrom).toHaveLength(1);
    const tmp = renamedFrom[0] as string;
    expect(relative(l.putTmpDir, tmp)).toMatch(
      /^put-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(tmp).not.toContain(String(process.pid));
  });

  it('scratchRoot() is the scratch dir, outside the root', () => {
    const l = sharedLayout();
    const s = new BlobStore(l.root, { putTmpDir: l.putTmpDir, scratchDir: l.scratchA });
    expect(s.scratchRoot()).toBe(l.scratchA);
    expect(s.scratchRoot().startsWith(l.root + sep)).toBe(false);
  });

  it("list('audio/x/') never returns .tmp entries", async () => {
    const l = sharedLayout();
    const s = new BlobStore(l.root, { putTmpDir: l.putTmpDir, scratchDir: l.scratchA });
    await s.put('audio/x/0001_k.webm', BYTES);
    // Another process's write in flight.
    mkdirSync(l.putTmpDir, { recursive: true });
    writeFileSync(join(l.putTmpDir, 'put-in-flight'), 'partial');
    expect(existsSync(join(l.putTmpDir, 'put-in-flight'))).toBe(true);
    const res = await s.list({ prefix: 'audio/x/' });
    expect(res.objects.map((o) => o.key)).toEqual(['audio/x/0001_k.webm']);
  });
});

describe('sweepStaleBlobPutTemps (shared-blob-volume D3)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

  function tmpWith(entries: Record<string, number | 'dir'>): string {
    base = mkdtempSync(join(tmpdir(), 'autologger-blob-'));
    const dir = join(base, 'blobs', '.tmp');
    mkdirSync(dir, { recursive: true });
    for (const [name, ageMs] of Object.entries(entries)) {
      const p = join(dir, name);
      if (ageMs === 'dir') mkdirSync(p);
      else writeFileSync(p, 'x');
      const t = (NOW - (ageMs === 'dir' ? 3 * DAY : ageMs)) / 1000;
      utimesSync(p, t, t);
    }
    return dir;
  }

  afterEach(() => {
    beforeLstat = null;
  });

  it('deletes only put-* regular files older than 24 h, and returns the count', () => {
    const dir = tmpWith({
      'put-young': 60_000,
      'put-old-1': 2 * DAY,
      'put-old-2': DAY + 1,
      'other-old': 2 * DAY,
      'put-dir-old': 'dir',
    });
    expect(sweepStaleBlobPutTemps(dir, NOW)).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(['other-old', 'put-dir-old', 'put-young']);
  });

  it('honours a given maxAgeMs', () => {
    const dir = tmpWith({ 'put-a': 120_000, 'put-b': 30_000 });
    expect(sweepStaleBlobPutTemps(dir, NOW, 60_000)).toBe(1);
    expect(readdirSync(dir)).toEqual(['put-b']);
  });

  it('tolerates a file that vanishes mid-sweep', () => {
    const dir = tmpWith({ 'put-gone': 2 * DAY, 'put-old': 2 * DAY });
    beforeLstat = (p) => {
      if (p.endsWith('put-gone')) rmSync(p, { force: true });
    };
    expect(sweepStaleBlobPutTemps(dir, NOW)).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('returns 0 for a missing directory', () => {
    base = mkdtempSync(join(tmpdir(), 'autologger-blob-'));
    expect(sweepStaleBlobPutTemps(join(base, 'nope'), NOW)).toBe(0);
  });
});

// media-worker design D3, D8, D12 (task S.6): the sticky `media/` directory the worker writes, the
// handle-based copy that adopts a worker's file, the trash and its sweeps, the free-space read and
// the resumable upload's staging file. The root is BLOB_DIR; `.tmp` is the put temp directory.
describe('BlobStore media additions (media-worker D3, D8, D12)', () => {
  function layout(): { root: string; s: BlobStore } {
    base = mkdtempSync(join(tmpdir(), 'autologger-blob-'));
    const root = join(base, 'blobs');
    mkdirSync(root);
    return {
      root,
      s: new BlobStore(root, { putTmpDir: join(root, '.tmp'), scratchDir: join(base, 'scratch') }),
    };
  }
  const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
  /** A worker's output file under media/<job>/. */
  function workerFile(root: string, job: string, name: string, bytes: string | Uint8Array): string {
    mkdirSync(join(root, 'media', job), { recursive: true });
    const p = join(root, 'media', job, name);
    writeFileSync(p, bytes, { mode: 0o644 });
    return p;
  }

  it('ensureMediaDir creates media/ sticky and world-writable (1777), and repairs its mode', async () => {
    const { root, s } = layout();
    await s.ensureMediaDir();
    expect(statSync(join(root, 'media')).mode & 0o7777).toBe(0o1777);
    chmodSync(join(root, 'media'), 0o755);
    await s.ensureMediaDir();
    expect(statSync(join(root, 'media')).mode & 0o7777).toBe(0o1777);
  });

  describe('adoptCopy', () => {
    it('copies the file through its own .tmp/put-* into the key, then removes the job directory', async () => {
      const { root, s } = layout();
      await s.ensureMediaDir();
      const src = workerFile(root, 'job-1', 'out.webm', 'merged-bytes');
      renamedFrom.length = 0;
      expect(await s.adoptCopy('media/job-1/out.webm', 'audio/s1/3_m.webm')).toEqual({
        copied: true,
        bytes: 12,
      });
      expect(readFileSync(join(root, 'audio/s1/3_m.webm'), 'utf8')).toBe('merged-bytes');
      // A new inode (never the worker's), written through a put temp file.
      expect(renamedFrom.map((p) => relative(join(root, '.tmp'), p))).toEqual([
        expect.stringMatching(/^put-[0-9a-f-]{36}$/),
      ]);
      expect(existsSync(src)).toBe(false);
      expect(existsSync(join(root, 'media', 'job-1'))).toBe(false);
      expect(readdirSync(join(root, '.tmp'))).toEqual([]);
    });

    it('is idempotent when the key already exists (a retried apply)', async () => {
      const { root, s } = layout();
      await s.put('audio/s1/3_m.webm', new TextEncoder().encode('first'));
      workerFile(root, 'job-1', 'out.webm', 'second');
      expect(await s.adoptCopy('media/job-1/out.webm', 'audio/s1/3_m.webm')).toEqual({
        copied: false,
        bytes: 5,
      });
      expect(readFileSync(join(root, 'audio/s1/3_m.webm'), 'utf8')).toBe('first');
      expect(existsSync(join(root, 'media', 'job-1'))).toBe(false);
    });

    it('refuses a symlink, a directory, a FIFO and a file over the cap, copying nothing', async () => {
      const { root, s } = layout();
      await s.put('audio/s1/other.webm', new TextEncoder().encode('secret'));
      mkdirSync(join(root, 'media', 'j'), { recursive: true });
      symlinkSync(join(root, 'audio/s1/other.webm'), join(root, 'media', 'j', 'link.webm'));
      mkdirSync(join(root, 'media', 'j', 'dir.webm'));
      execFileSync('mkfifo', [join(root, 'media', 'j', 'fifo.webm')]);
      writeFileSync(join(root, 'media', 'j', 'big.webm'), 'x'.repeat(11));
      for (const name of ['link.webm', 'dir.webm', 'fifo.webm']) {
        await expect(s.adoptCopy(`media/j/${name}`, `audio/s1/${name}`), name).rejects.toThrow(
          MediaAdoptError,
        );
      }
      await expect(
        s.adoptCopy('media/j/big.webm', 'audio/s1/big.webm', { maxBytes: 10 }),
      ).rejects.toThrow(MediaAdoptError);
      expect(readdirSync(join(root, 'audio/s1'))).toEqual(['other.webm']);
      expect(readdirSync(join(root, '.tmp'))).toEqual([]);
      // A refusal leaves the job directory for the sweep.
      expect(existsSync(join(root, 'media', 'j'))).toBe(true);
    });

    it('refuses a job directory that is a symlink, and source paths outside media/<job>/<name>', async () => {
      const { root, s } = layout();
      await s.put('audio/s1/a.webm', new TextEncoder().encode('secret'));
      mkdirSync(join(root, 'media'), { recursive: true });
      symlinkSync(join(root, 'audio/s1'), join(root, 'media', 'evil'));
      await expect(s.adoptCopy('media/evil/a.webm', 'audio/s1/b.webm')).rejects.toThrow(
        MediaAdoptError,
      );
      for (const bad of [
        'media/../audio/s1/a.webm',
        'audio/s1/a.webm',
        'media/j/sub/x.webm',
        'media/j/',
        'media//x.webm',
        'media/j/.hidden',
        '/etc/passwd',
      ]) {
        await expect(s.adoptCopy(bad, 'audio/s1/c.webm'), bad).rejects.toThrow(MediaAdoptError);
      }
      expect(readdirSync(join(root, 'audio/s1')).sort()).toEqual(['a.webm']);
    });

    it('checks the owner uid by the handle when one is required', async () => {
      const { root, s } = layout();
      workerFile(root, 'j', 'out.flac', 'flac');
      const mine = statSync(join(root, 'media/j/out.flac')).uid;
      await expect(
        s.adoptCopy('media/j/out.flac', 'audio/s1/x.flac', { ownerUid: mine + 1 }),
      ).rejects.toThrow(MediaAdoptError);
      expect(await s.adoptCopy('media/j/out.flac', 'audio/s1/x.flac', { ownerUid: mine })).toEqual({
        copied: true,
        bytes: 4,
      });
    });

    it('removes a job directory whose files it cannot write (mode-only stand-in for a foreign uid)', async () => {
      const { root, s } = layout();
      await s.ensureMediaDir();
      workerFile(root, 'j', 'out.webm', 'bytes');
      writeFileSync(join(root, 'media/j/extra.log'), 'x', { mode: 0o444 });
      chmodSync(join(root, 'media/j/out.webm'), 0o444);
      await s.adoptCopy('media/j/out.webm', 'audio/s1/x.webm');
      expect(existsSync(join(root, 'media', 'j'))).toBe(false);
      await s.removeMediaJobDir('missing-job'); // no-op
      await expect(s.removeMediaJobDir('../audio')).rejects.toThrow(MediaAdoptError);
    });
  });

  describe('trash', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);

    it('trash moves a blob to .trash/<yyyy-mm-dd>/<key>; a missing key is a no-op', async () => {
      const { root, s } = layout();
      await s.put('audio/s1/a.webm', new TextEncoder().encode('a'));
      expect(await s.trash('audio/s1/a.webm', NOW)).toBe(true);
      expect(existsSync(join(root, 'audio/s1/a.webm'))).toBe(false);
      expect(readFileSync(join(root, '.trash/2026-10-19/audio/s1/a.webm'), 'utf8')).toBe('a');
      expect(await s.trash('audio/s1/a.webm', NOW)).toBe(false);
      await expect(s.trash('../x', NOW)).rejects.toThrow();
    });

    it('sweepTrash deletes day directories 7 days old or more and keeps younger ones', async () => {
      const { root, s } = layout();
      for (const [key, daysAgo] of [
        ['audio/s1/d0.webm', 0],
        ['audio/s1/d6.webm', 6],
        ['audio/s1/d7.webm', 7],
        ['audio/s1/d9.webm', 9],
      ] as const) {
        await s.put(key, new TextEncoder().encode('x'));
        await s.trash(key, NOW - daysAgo * DAY);
      }
      mkdirSync(join(root, '.trash', 'not-a-day'));
      expect(await s.sweepTrash(NOW, 7 * DAY)).toBe(2);
      expect(readdirSync(join(root, '.trash')).sort()).toEqual([
        '2026-10-13',
        '2026-10-19',
        'not-a-day',
      ]);
    });

    it('purgeTrashOldestFirst frees at least the bytes asked, oldest day and file first', async () => {
      const { root, s } = layout();
      for (const [key, daysAgo, size] of [
        ['audio/s1/new.webm', 1, 100],
        ['audio/s1/old-a.webm', 3, 100],
        ['audio/s1/old-b.webm', 3, 100],
        ['audio/s1/mid.webm', 2, 100],
      ] as const) {
        await s.put(key, new Uint8Array(size));
        await s.trash(key, NOW - daysAgo * DAY);
      }
      expect(await s.purgeTrashOldestFirst(150)).toBe(200);
      expect(readdirSync(join(root, '.trash')).sort()).toEqual(['2026-10-17', '2026-10-18']);
      expect(await s.purgeTrashOldestFirst(10_000)).toBe(200);
      expect(readdirSync(join(root, '.trash'))).toEqual([]);
      expect(await s.purgeTrashOldestFirst(1)).toBe(0);
    });
  });

  it('freeBytes reads statfs of the root', async () => {
    const { root, s } = layout();
    const st = statfsSync(root);
    const free = await s.freeBytes();
    expect(free).toBeGreaterThan(0);
    expect(Math.abs(free - st.bavail * st.bsize)).toBeLessThan(64 * 1024 * 1024);
  });

  describe('upload staging', () => {
    it('preallocates .tmp/upload-<id>, writes parts at offsets while hashing, re-hashes, adopts by rename', async () => {
      const { root, s } = layout();
      const parts = ['aaaa', 'bbbb', 'cc'];
      await s.openStaging('up-1', 10);
      const p = join(root, '.tmp', 'upload-up-1');
      expect(statSync(p).size).toBe(10);
      // Out of order, one re-sent; a streamed body.
      expect(await s.writePart('up-1', 8, new TextEncoder().encode(parts[2]))).toEqual({
        bytes: 2,
        sha256: sha('cc'),
      });
      async function* stream() {
        yield new TextEncoder().encode('aa');
        yield new TextEncoder().encode('aa');
      }
      expect(await s.writePart('up-1', 0, stream())).toEqual({ bytes: 4, sha256: sha('aaaa') });
      await s.writePart('up-1', 4, new TextEncoder().encode('XXXX'));
      await s.writePart('up-1', 4, new TextEncoder().encode('bbbb'));
      expect(await s.rehashParts('up-1', 4)).toEqual({
        size: 10,
        sha256: parts.map((x) => sha(x)),
      });
      renamedFrom.length = 0;
      await s.adoptStaging('up-1', 'audio/s1/import.wav');
      expect(renamedFrom).toEqual([p]);
      expect(readFileSync(join(root, 'audio/s1/import.wav'), 'utf8')).toBe('aaaabbbbcc');
      expect(existsSync(p)).toBe(false);
    });

    it('a part over its limit is refused without growing the file; removeStaging deletes it', async () => {
      const { root, s } = layout();
      await s.openStaging('up-2', 6);
      await expect(
        s.writePart('up-2', 4, new TextEncoder().encode('xyz'), { maxBytes: 2 }),
      ).rejects.toThrow(PartTooLargeError);
      expect(statSync(join(root, '.tmp', 'upload-up-2')).size).toBe(6);
      // Re-opening keeps what was written (a resumed upload).
      await s.writePart('up-2', 0, new TextEncoder().encode('ab'));
      await s.openStaging('up-2', 6);
      expect(
        readFileSync(join(root, '.tmp', 'upload-up-2'))
          .subarray(0, 2)
          .toString(),
      ).toBe('ab');
      await s.removeStaging('up-2');
      expect(existsSync(join(root, '.tmp', 'upload-up-2'))).toBe(false);
      await s.removeStaging('up-2');
      await expect(s.openStaging('../x', 1)).rejects.toThrow();
      await expect(s.writePart('missing', 0, new Uint8Array(1))).rejects.toThrow();
    });
  });

  // Implementation panel (S.7): the worker (uid 10001) must read every blob the API writes, so
  // files under audio/ and .trash/ are 0644 and their directories 0755 whatever the umask.
  describe('blob modes for the worker (S.7)', () => {
    async function underUmask<T>(mask: number, fn: () => Promise<T>): Promise<T> {
      const old = process.umask(mask);
      try {
        return await fn();
      } finally {
        process.umask(old);
      }
    }
    const mode = (p: string) => statSync(p).mode & 0o7777;

    it('put, adoptCopy, adoptStaging and trash leave 0644 files in 0755 directories under umask 077', async () => {
      const { root, s } = layout();
      chmodSync(root, 0o755);
      await underUmask(0o077, async () => {
        await s.put('audio/s1/put.webm', new TextEncoder().encode('p'));
        await s.ensureMediaDir();
        workerFile(root, 'j', 'out.webm', 'w');
        await s.adoptCopy('media/j/out.webm', 'audio/s2/adopted.webm');
        await s.openStaging('up', 2);
        await s.writePart('up', 0, new TextEncoder().encode('ab'));
        await s.adoptStaging('up', 'audio/s3/import.wav');
        await s.put('audio/s4/old.webm', new TextEncoder().encode('o'));
        await s.trash('audio/s4/old.webm', Date.UTC(2026, 9, 19));
      });
      for (const f of [
        'audio/s1/put.webm',
        'audio/s2/adopted.webm',
        'audio/s3/import.wav',
        '.trash/2026-10-19/audio/s4/old.webm',
      ]) {
        expect(mode(join(root, f)), f).toBe(0o644);
      }
      for (const d of [
        'audio',
        'audio/s1',
        'audio/s2',
        'audio/s3',
        '.trash',
        '.trash/2026-10-19',
        '.trash/2026-10-19/audio',
        '.trash/2026-10-19/audio/s4',
      ]) {
        expect(mode(join(root, d)), d).toBe(0o755);
      }
    });

    const docker = (() => {
      try {
        execFileSync('docker', ['image', 'inspect', 'node:22-bookworm-slim'], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    })();

    it.skipIf(!docker)(
      'another uid (10001, the worker) reads what the store wrote (spike 0.1)',
      async () => {
        const { root, s } = layout();
        chmodSync(root, 0o755);
        await underUmask(0o077, async () => {
          await s.put('audio/s1/put.webm', new TextEncoder().encode('put'));
          await s.openStaging('up', 6);
          await s.writePart('up', 0, new TextEncoder().encode('staged'));
          await s.adoptStaging('up', 'audio/s1/import.wav');
          await s.put('audio/s1/gone.webm', new TextEncoder().encode('trashed'));
          await s.trash('audio/s1/gone.webm', Date.UTC(2026, 9, 19));
        });
        const out = execFileSync(
          'docker',
          [
            'run',
            '--rm',
            '--network',
            'none',
            '--user',
            '10001:10001',
            '-v',
            `${root}:/blobs:ro`,
            'node:22-bookworm-slim',
            'cat',
            '/blobs/audio/s1/put.webm',
            '/blobs/audio/s1/import.wav',
            '/blobs/.trash/2026-10-19/audio/s1/gone.webm',
          ],
          { encoding: 'utf8' },
        );
        expect(out).toBe('putstagedtrashed');
      },
      60_000,
    );
  });

  it('list() ignores .trash, .tmp and media at the root', async () => {
    const { root, s } = layout();
    await s.put('audio/s1/a.webm', new TextEncoder().encode('a'));
    await s.put('audio/s1/b.webm', new TextEncoder().encode('b'));
    await s.trash('audio/s1/b.webm', Date.now());
    workerFile(root, 'j', 'out.webm', 'w');
    await s.openStaging('u', 1);
    expect((await s.list({ prefix: '' })).objects.map((o) => o.key)).toEqual(['audio/s1/a.webm']);
  });
});
