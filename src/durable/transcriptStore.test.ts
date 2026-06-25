import { describe, expect, it } from 'vitest';
import { wordRow } from './transcriptStore';

describe('wordRow', () => {
  it('maps a full transcript-word row', () => {
    const r = {
      id: 'w1',
      session_time: '00:00:01',
      speaker: 'A',
      word: 'hello',
      start_sec: 1.5,
      end_sec: 2,
      ordinal: 4,
      created_at_utc: '2026-06-25T00:00:00.000Z',
    };
    expect(wordRow(r)).toEqual({
      id: 'w1',
      session_time: '00:00:01',
      speaker: 'A',
      word: 'hello',
      start_sec: 1.5,
      end_sec: 2,
      ordinal: 4,
      created_at_utc: '2026-06-25T00:00:00.000Z',
    });
  });

  it('applies defaults for missing fields', () => {
    expect(wordRow({ id: 'w2', ordinal: 0 })).toEqual({
      id: 'w2',
      session_time: '',
      speaker: '',
      word: '',
      start_sec: 0,
      end_sec: 0,
      ordinal: 0,
      created_at_utc: '',
    });
  });
});
