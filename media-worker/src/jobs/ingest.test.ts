// Ingest without a real ffmpeg: the paths that never reach a decode, and the low-disk rule.

import { chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ctx, fakeReads, job, makeTree, seg, type Tree } from '../test/fixtures';
import { runIngest } from './ingest';

let tree: Tree;
beforeAll(async () => {
  tree = await makeTree();
});
afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(tree.root, { recursive: true, force: true });
});

describe('runIngest (no decode needed)', () => {
  it('low-disk: free < 2 × input_bytes → release (not an attempt), nothing written', async () => {
    const key = await tree.put('1_a.webm', Buffer.from('x'));
    const out = await runIngest(
      ctx(tree, fakeReads([seg({ id: 'seg-1', r2Key: key })]), { freeBytes: async () => 1999 }),
      job({ inputBytes: 1000, attempts: 2 }),
    );
    expect(out).toEqual({ kind: 'release', error: 'low-disk', runAfterMs: 1_000_000 + 60_000 });
    expect(await readdir(join(tree.blobDir, 'media'))).toEqual([]);
  });

  it('a target row that is gone → missing-blob, final', async () => {
    const out = await runIngest(ctx(tree, fakeReads([])), job());
    expect(out).toEqual({ kind: 'fail', error: 'missing-blob', final: true });
  });

  it('a row whose blob is absent → missing-blob (retried: the put may still land)', async () => {
    const out = await runIngest(
      ctx(tree, fakeReads([seg({ id: 'seg-1', r2Key: 'audio/s1/absent.webm' })])),
      job(),
    );
    expect(out).toEqual({ kind: 'fail', error: 'missing-blob', final: false });
  });

  it.skipIf(process.getuid?.() === 0)(
    'an unreadable blob (mode 0600 of another user) → missing-blob',
    async () => {
      const key = await tree.put('locked.webm', Buffer.from('x'));
      await chmod(join(tree.blobDir, key), 0o000);
      const out = await runIngest(ctx(tree, fakeReads([seg({ id: 'seg-1', r2Key: key })])), job());
      expect(out).toEqual({ kind: 'fail', error: 'missing-blob', final: false });
    },
  );

  it('a junk file is refused by the sniff → decode-failed, final, without running ffmpeg', async () => {
    const key = await tree.put(
      'junk.webm',
      Buffer.from('#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n'),
    );
    const out = await runIngest(
      ctx(tree, fakeReads([seg({ id: 'seg-1', r2Key: key })]), {
        ffmpegPath: '/nonexistent/ffmpeg',
      }),
      job(),
    );
    expect(out).toEqual({ kind: 'fail', error: 'decode-failed', final: true });
  });

  it('a row key outside audio/ (e.g. a crafted media/ path) is refused', async () => {
    const out = await runIngest(
      ctx(tree, fakeReads([seg({ id: 'seg-1', r2Key: 'media/x/out.webm' })])),
      job(),
    );
    expect(out).toMatchObject({ kind: 'fail', error: 'decode-failed' });
  });
});
