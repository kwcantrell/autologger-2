import { describe, expect, it } from 'vitest';
import { MAX_METADATA_BYTES, logBodySchema } from './schemas';

describe('logBodySchema.metadata cap', () => {
  it('accepts a normal small metadata object', () => {
    const r = logBodySchema.safeParse({ category: 'cam', message: 'hi', metadata: { take: 1 } });
    expect(r.success).toBe(true);
  });

  it('defaults metadata to {} when absent', () => {
    const r = logBodySchema.safeParse({ category: 'cam', message: 'hi' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.metadata).toEqual({});
  });

  it('rejects metadata that serializes beyond the cap', () => {
    const big = { blob: 'x'.repeat(MAX_METADATA_BYTES + 100) };
    const r = logBodySchema.safeParse({ category: 'cam', message: 'hi', metadata: big });
    expect(r.success).toBe(false);
  });
});
