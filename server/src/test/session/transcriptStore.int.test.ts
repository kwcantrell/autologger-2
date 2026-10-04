import { describe, expect, it } from 'vitest';
import { boundCore } from './boundCore';
import { paragraphRow, sentimentRow, wordRow } from '@autologger/session-core/transcriptStore';

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

// code-health-tail task 2.4 (design D12) — behavior pins over a REAL core
// (in-memory SQLite then; Postgres since session-tables, through the bound-core
// harness), written BEFORE the insert-ordinal seed and update
// patch-builder moved into the shared store helpers. These must pass
// unmodified across the extraction.
describe('TranscriptStore over a real core (D12 pins)', () => {
  const data = (word: string) => ({ session_time: '00:00:01', speaker: 'A', word });

  it('insertTranscriptWord seeds ordinals 0,1,2… and reuses MAX+1 after the top row is deleted', async () => {
    const { run } = await boundCore();
    const a = await run((s) => s.transcript.insertTranscriptWord(data('a')));
    const b = await run((s) => s.transcript.insertTranscriptWord(data('b')));
    const c = await run((s) => s.transcript.insertTranscriptWord(data('c')));
    expect([a.ordinal, b.ordinal, c.ordinal]).toEqual([0, 1, 2]);
    // COALESCE(MAX(ordinal), -1) + 1: deleting the max frees its ordinal.
    await run((s) => s.transcript.deleteTranscriptWord(c.id));
    expect((await run((s) => s.transcript.insertTranscriptWord(data('d')))).ordinal).toBe(2);
  });

  it('updateTranscriptWord patches only the provided fields and returns the fresh row', async () => {
    const { run } = await boundCore();
    const w = await run((s) => s.transcript.insertTranscriptWord(data('orig')));
    const updated = await run((s) =>
      s.transcript.updateTranscriptWord(w.id, { word: 'edited', speaker: 'B' }),
    );
    expect(updated).toEqual({ ...w, word: 'edited', speaker: 'B' });
  });

  it('updateTranscriptWord with an empty patch is a no-op returning the row; unknown id returns null', async () => {
    const { run } = await boundCore();
    const w = await run((s) => s.transcript.insertTranscriptWord(data('orig')));
    expect(await run((s) => s.transcript.updateTranscriptWord(w.id, {}))).toEqual(w);
    expect(await run((s) => s.transcript.updateTranscriptWord('nope', { word: 'x' }))).toBeNull();
  });
});
