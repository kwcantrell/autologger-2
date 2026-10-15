import { describe, expect, it } from 'vitest';
import { DEV_CHUNK_MS_KEY, devChunkMsOverride } from './devChunkMs';

describe('devChunkMsOverride (media-worker V.2: shorter chunks on dev only)', () => {
  const store = (v: string | null) => ({
    getItem: (k: string) => (k === DEV_CHUNK_MS_KEY ? v : null),
  });

  it('is ignored outside development', () => {
    expect(devChunkMsOverride('production', store('20000'))).toBeNull();
    expect(devChunkMsOverride('test', store('20000'))).toBeNull();
  });

  it('reads a whole number of milliseconds in development', () => {
    expect(devChunkMsOverride('development', store('20000'))).toBe(20000);
  });

  it('refuses values below 15 s, above 10 min, or not a plain integer', () => {
    for (const v of ['14999', '600001', '1e4', '20s', '', '-20000']) {
      expect(devChunkMsOverride('development', store(v)), v).toBeNull();
    }
  });

  it('is null when unset', () => {
    expect(devChunkMsOverride('development', store(null))).toBeNull();
  });

  it('survives a storage that throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
    };
    expect(devChunkMsOverride('development', throwing)).toBeNull();
  });
});
