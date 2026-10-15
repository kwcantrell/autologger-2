// Merge planning without a real ffmpeg: the low-disk rule, input ordering, seams carried over,
// the interleave rule and the originals lookup in the trash.

import { rm } from 'node:fs/promises';
import type { AudioSeam } from '@autologger/ports/media';
import { MEDIA_MIN_FREE_BYTES } from '@autologger/storage/mediaLimits';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ctx, fakeReads, job, makeTree, seg, type Tree } from '../test/fixtures';
import { planMerge, runMerge } from './merge';

let tree: Tree;
beforeAll(async () => {
  tree = await makeTree();
});
afterAll(async () => {
  await rm(tree.root, { recursive: true, force: true });
});

const T = (m: number) => `2026-10-12T10:${String(m).padStart(2, '0')}:00.000Z`;
const seam = (
  over: Partial<AudioSeam> & { segmentId: string; startedAtUtc: string },
): AudioSeam => ({
  sessionId: 's1',
  recordingOrdinal: 1,
  endedAtUtc: null,
  offsetMs: 0,
  sourceKey: `audio/s1/${over.segmentId}.webm`,
  ...over,
});
const MJOB = job({ kind: 'merge', target: '1', inputBytes: 1000 });

describe('runMerge low-disk', () => {
  it('below MEDIA_MIN_FREE_BYTES no merge runs (released, not an attempt)', async () => {
    const out = await runMerge(
      ctx(tree, fakeReads([]), { freeBytes: async () => MEDIA_MIN_FREE_BYTES - 1 }),
      MJOB,
    );
    expect(out).toEqual({ kind: 'release', error: 'low-disk', runAfterMs: 1_000_000 + 30_000 });
  });
  it('free < 2 × input_bytes → released', async () => {
    const out = await runMerge(
      ctx(tree, fakeReads([]), { freeBytes: async () => MEDIA_MIN_FREE_BYTES + 10 }),
      job({ kind: 'merge', target: '1', inputBytes: MEDIA_MIN_FREE_BYTES }),
    );
    expect(out).toMatchObject({ kind: 'release', error: 'low-disk' });
  });
  it('a recording with fewer than two segments is not merged', async () => {
    const out = await runMerge(
      ctx(
        tree,
        fakeReads([seg({ id: 'a', r2Key: 'audio/s1/a.webm', recordingOrdinal: 1 } as never)]),
      ),
      MJOB,
    );
    expect(out).toEqual({ kind: 'fail', error: 'internal', final: true });
  });
});

describe('runMerge refuses rows without a wall-clock start', () => {
  it('a legacy row with started_at_utc NULL cannot be ordered → interleaved-input, final', async () => {
    const out = await runMerge(
      ctx(
        tree,
        fakeReads([
          seg({ id: 'a', r2Key: 'audio/s1/a.webm', startedAtUtc: T(0) }),
          seg({ id: 'b', r2Key: 'audio/s1/b.webm', startedAtUtc: null }),
        ]),
      ),
      MJOB,
    );
    expect(out).toEqual({ kind: 'fail', error: 'interleaved-input', final: true });
  });
});

describe('planMerge', () => {
  it('plain chunks: one input each, in started_at order, with their own seam (or a synthesized one)', async () => {
    const rows = [
      seg({ id: 'b', r2Key: 'audio/s1/b.webm', startedAtUtc: T(10), ordinal: 2 }),
      seg({ id: 'a', r2Key: 'audio/s1/a.webm', startedAtUtc: T(0), ordinal: 1 }),
    ];
    const plan = await planMerge(tree.blobDir, rows, [
      seam({ segmentId: 'a', startedAtUtc: T(0), endedAtUtc: T(10) }),
    ]);
    expect(plan.kind).toBe('append');
    if (plan.kind !== 'append') return;
    expect(plan.inputs.map((i) => i.key)).toEqual(['audio/s1/a.webm', 'audio/s1/b.webm']);
    expect(plan.inputs[0].seams).toEqual([
      { offset_ms: 0, started_at_utc: T(0), ended_at_utc: T(10), source_key: 'audio/s1/a.webm' },
    ]);
    // legacy row without a seam row: one seam at offset 0 from the row itself
    expect(plan.inputs[1].seams).toEqual([
      { offset_ms: 0, started_at_utc: T(10), ended_at_utc: null, source_key: 'audio/s1/b.webm' },
    ]);
    expect(plan.inputIds).toEqual(['a', 'b']);
  });

  it('a merged input carries its seams; a later chunk is appended', async () => {
    const rows = [
      seg({ id: 'm', r2Key: 'audio/s1/m.webm', startedAtUtc: T(0) }),
      seg({ id: 'c', r2Key: 'audio/s1/c.webm', startedAtUtc: T(20) }),
    ];
    const seams = [
      seam({ segmentId: 'm', startedAtUtc: T(0), offsetMs: 0, sourceKey: 'audio/s1/a.webm' }),
      seam({
        segmentId: 'm',
        startedAtUtc: T(10),
        offsetMs: 600_006,
        sourceKey: 'audio/s1/b.webm',
      }),
      seam({ segmentId: 'c', startedAtUtc: T(20), sourceKey: 'audio/s1/c.webm' }),
    ];
    const plan = await planMerge(tree.blobDir, rows, seams);
    expect(plan.kind).toBe('append');
    if (plan.kind !== 'append') return;
    expect(plan.inputs.map((i) => i.seams.map((s) => s.offset_ms))).toEqual([[0, 600_006], [0]]);
  });

  it('a late chunk between two seams of a merged input → rebuild from the originals in the trash', async () => {
    await tree.trashFixture('seg1.webm', 'audio/s1/a.webm', '2026-10-10');
    await tree.trashFixture('seg2.webm', 'audio/s1/c.webm', '2026-10-11');
    const rows = [
      seg({ id: 'm', r2Key: 'audio/s1/m.webm', startedAtUtc: T(0) }),
      seg({ id: 'b', r2Key: 'audio/s1/b.webm', startedAtUtc: T(10) }),
    ];
    const seams = [
      seam({ segmentId: 'm', startedAtUtc: T(0), offsetMs: 0, sourceKey: 'audio/s1/a.webm' }),
      seam({
        segmentId: 'm',
        startedAtUtc: T(20),
        offsetMs: 600_006,
        sourceKey: 'audio/s1/c.webm',
      }),
      seam({ segmentId: 'b', startedAtUtc: T(10), sourceKey: 'audio/s1/b.webm' }),
    ];
    const plan = await planMerge(tree.blobDir, rows, seams);
    expect(plan.kind).toBe('append');
    if (plan.kind !== 'append') return;
    expect(plan.rebuilt).toBe(true);
    expect(plan.inputs.map((i) => i.key)).toEqual([
      '.trash/2026-10-10/audio/s1/a.webm',
      'audio/s1/b.webm',
      '.trash/2026-10-11/audio/s1/c.webm',
    ]);
    expect(plan.inputs.map((i) => i.seams[0].source_key)).toEqual([
      'audio/s1/a.webm',
      'audio/s1/b.webm',
      'audio/s1/c.webm',
    ]);
    expect(plan.inputIds).toEqual(['m', 'b']);
  });

  it('…or interleaved-input when an original is gone', async () => {
    const rows = [
      seg({ id: 'm', r2Key: 'audio/s1/m.webm', startedAtUtc: T(0) }),
      seg({ id: 'b', r2Key: 'audio/s1/b.webm', startedAtUtc: T(10) }),
    ];
    const seams = [
      seam({ segmentId: 'm', startedAtUtc: T(0), sourceKey: 'audio/s1/gone-a.webm' }),
      seam({ segmentId: 'm', startedAtUtc: T(20), offsetMs: 5, sourceKey: 'audio/s1/gone-c.webm' }),
      seam({ segmentId: 'b', startedAtUtc: T(10) }),
    ];
    expect(await planMerge(tree.blobDir, rows, seams)).toEqual({ kind: 'interleaved' });
  });
});
