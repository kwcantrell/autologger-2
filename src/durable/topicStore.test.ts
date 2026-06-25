import { describe, expect, it } from 'vitest';
import { topicRow } from './topicStore';

describe('topicRow', () => {
  it('maps a full topic row', () => {
    const r = {
      id: 't1',
      session_time: '00:01:00',
      duration_sec: 30,
      topic_level: 2,
      summary: 'intro',
      ordinal: 1,
      created_at_utc: '2026-06-25T00:00:00.000Z',
    };
    expect(topicRow(r)).toEqual({
      id: 't1',
      session_time: '00:01:00',
      duration_sec: 30,
      topic_level: 2,
      summary: 'intro',
      ordinal: 1,
      created_at_utc: '2026-06-25T00:00:00.000Z',
    });
  });

  it('applies defaults for missing fields (topic_level defaults to 1)', () => {
    expect(topicRow({ id: 't2', ordinal: 0 })).toEqual({
      id: 't2',
      session_time: '',
      duration_sec: 0,
      topic_level: 1,
      summary: '',
      ordinal: 0,
      created_at_utc: '',
    });
  });
});
