import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlobStore, InvalidRangeError, sweepStaleBlobPutTemps } from './blobStore';

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
