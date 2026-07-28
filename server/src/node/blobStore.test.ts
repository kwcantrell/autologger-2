import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BlobStore, InvalidRangeError } from './blobStore';

let base: string;
afterEach(() => rmSync(base, { recursive: true, force: true }));

function store(): BlobStore {
  base = mkdtempSync(join(tmpdir(), 'autologger-blob-'));
  return new BlobStore(join(base, 'audio'), join(base, 'tmp'));
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
    const obj = await s.get('audio/sess1/0001_x.webm');
    expect(obj).not.toBeNull();
    expect(obj!.size).toBe(10);
    expect((await drain(obj!.body)).toString()).toBe('0123456789');
  });

  it('get returns null for a missing key', async () => {
    const s = store();
    expect(await s.get('audio/nope')).toBeNull();
  });

  it('serves offset/length and suffix ranges, normalized to offset/length', async () => {
    const s = store();
    await s.put('k', BYTES);
    const mid = await s.get('k', { range: { offset: 2, length: 3 } });
    expect(mid!.range).toEqual({ offset: 2, length: 3 });
    expect((await drain(mid!.body)).toString()).toBe('234');
    const tail = await s.get('k', { range: { suffix: 4 } });
    expect(tail!.range).toEqual({ offset: 6, length: 4 });
    expect((await drain(tail!.body)).toString()).toBe('6789');
    const openEnd = await s.get('k', { range: { offset: 7 } });
    expect(openEnd!.range).toEqual({ offset: 7, length: 3 });
  });

  it('throws InvalidRangeError on out-of-bounds or non-positive ranges', async () => {
    const s = store();
    await s.put('k', BYTES);
    await expect(s.get('k', { range: { offset: 10 } })).rejects.toBeInstanceOf(InvalidRangeError);
    await expect(s.get('k', { range: { offset: 5, length: -2 } })).rejects.toBeInstanceOf(
      InvalidRangeError,
    );
    // suffix larger than the file → whole file (HTTP semantics), not an error
    const whole = await s.get('k', { range: { suffix: 999 } });
    expect(whole!.range).toEqual({ offset: 0, length: 10 });
  });

  it('throws InvalidRangeError for a suffix range against a zero-byte blob', async () => {
    const s = store();
    await s.put('k', new Uint8Array(0));
    await expect(s.get('k', { range: { suffix: 1 } })).rejects.toBeInstanceOf(InvalidRangeError);
    await expect(s.get('k', { range: { suffix: 999 } })).rejects.toBeInstanceOf(InvalidRangeError);
    // No range at all on the same zero-byte blob still succeeds (whole body).
    const whole = await s.get('k');
    expect(whole!.size).toBe(0);
    expect((await drain(whole!.body)).length).toBe(0);
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
