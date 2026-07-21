import { describe, expect, it } from 'vitest';
import { paragraphRow, sentimentRow, wordRow } from './transcriptStore';

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

// NULL-preserving mappers (never-zeros-as-data contract, design D3): a NULL
// start_sec/end_sec column MUST read back as `null`, never coerced to 0.
describe('paragraphRow', () => {
  it('preserves NULL start_sec/end_sec as null, not 0', () => {
    expect(
      paragraphRow({
        id: 'p1',
        start_sec: null,
        end_sec: null,
        speaker: '0',
        text: 'hello there',
        ordinal: 0,
        created_at_utc: '2026-06-25T00:00:00.000Z',
      }),
    ).toEqual({
      id: 'p1',
      start_sec: null,
      end_sec: null,
      speaker: '0',
      text: 'hello there',
      ordinal: 0,
      created_at_utc: '2026-06-25T00:00:00.000Z',
    });
  });

  it('coerces a real numeric start_sec/end_sec', () => {
    const r = paragraphRow({
      id: 'p2',
      start_sec: 1.5,
      end_sec: 2,
      speaker: '1',
      text: 'x',
      ordinal: 1,
      created_at_utc: '2026-06-25T00:00:00.000Z',
    });
    expect(r.start_sec).toBe(1.5);
    expect(r.end_sec).toBe(2);
  });
});

describe('sentimentRow', () => {
  it('preserves NULL start_sec/end_sec as null, not 0', () => {
    expect(
      sentimentRow({
        id: 's1',
        start_sec: null,
        end_sec: null,
        sentiment: 'positive',
        sentiment_score: 0.8,
        text: 'great stuff',
        ordinal: 0,
        created_at_utc: '2026-06-25T00:00:00.000Z',
      }),
    ).toEqual({
      id: 's1',
      start_sec: null,
      end_sec: null,
      sentiment: 'positive',
      sentiment_score: 0.8,
      text: 'great stuff',
      ordinal: 0,
      created_at_utc: '2026-06-25T00:00:00.000Z',
    });
  });
});
