// media-worker B.4 (design D12): the part size rule. The routes themselves run over real bindings
// in audioUploads.int.test.ts.
import { describe, expect, it } from 'vitest';
import { expectedPartBytes } from './audioUploads';

describe('expectedPartBytes (D12)', () => {
  const u = { sizeBytes: 100, partSize: 32, partsTotal: 4 };
  it('every part but the last is exactly part_size; the last is the remainder', () => {
    expect([1, 2, 3, 4].map((n) => expectedPartBytes(u, n))).toEqual([32, 32, 32, 4]);
  });
  it('a one-part upload is the whole file', () => {
    expect(expectedPartBytes({ sizeBytes: 7, partSize: 32, partsTotal: 1 }, 1)).toBe(7);
  });
  it('an exact multiple ends with a full part', () => {
    expect(expectedPartBytes({ sizeBytes: 64, partSize: 32, partsTotal: 2 }, 2)).toBe(32);
  });
});
