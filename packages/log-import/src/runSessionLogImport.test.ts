// runSessionLogImport is async so an async catalog mirror (projectLive) can be awaited
// (async-session-callers D5); failures surface as rejections, not synchronous throws.
import { describe, expect, it } from 'vitest';
import { runSessionLogImport } from './runSessionLogImport';

describe('runSessionLogImport', () => {
  it('returns a promise that rejects on an untimed transcript', async () => {
    const run = runSessionLogImport({
      hub: {} as never,
      rows: [],
      categories: [],
      ctx: { frameRate: 24, startOffsetFrames: 0 },
      transcript: [],
      projectLive: async () => {},
    });
    expect(run).toBeInstanceOf(Promise);
    await expect(run).rejects.toThrow(/Transcript is missing/);
  });
});
