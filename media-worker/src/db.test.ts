import type { MediaSql } from '@autologger/ports/media';
import { describe, expect, it } from 'vitest';
import { workerReads } from './db';

const row = {
  id: 'seg-1',
  ordinal: '3',
  started_at_utc: null,
  ended_at_utc: null,
  mime_type: 'audio/webm',
  r2_key: 'audio/s1/3_seg-1.webm',
};
const fake: MediaSql = {
  all: async <T>() => [row] as T[],
  run: async () => ({ changes: 0 }),
};

describe('workerReads', () => {
  it('a NULL started_at_utc stays null (never the string "null")', async () => {
    const r = await workerReads(fake).segment('s1', 'seg-1');
    expect(r).toEqual({
      id: 'seg-1',
      ordinal: 3,
      startedAtUtc: null,
      endedAtUtc: null,
      mimeType: 'audio/webm',
      r2Key: 'audio/s1/3_seg-1.webm',
    });
  });
});
