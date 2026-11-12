// runSessionLogImport's refusal of an untimed transcript happens before any hub call, so it runs in
// the unit tier (moved from runSessionLogImport.int.test.ts, whose other cases import over a real
// hub).
import { runSessionLogImport } from '@autologger/log-import/runSessionLogImport';
import { describe, expect, it } from 'vitest';

describe('runSessionLogImport', () => {
  it('returns a promise that rejects on an untimed transcript', async () => {
    const run = runSessionLogImport({
      hub: {} as never,
      rows: [],
      categories: [],
      ctx: { frameRate: 24, startOffsetFrames: 0 },
      transcript: [],
    });
    expect(run).toBeInstanceOf(Promise);
    await expect(run).rejects.toThrow(/Transcript is missing/);
  });
});
