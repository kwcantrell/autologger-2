import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { sqliteSessionSql } from './SessionHub';
import { SessionCore, type SessionRuntime } from './sessionCore';
import { TranscriptStore, paragraphRow, sentimentRow, wordRow } from './transcriptStore';

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
// (in-memory SQLite), written BEFORE the insert-ordinal seed and update
// patch-builder moved into the shared store helpers. These must pass
// unmodified across the extraction.
describe('TranscriptStore over a real core (D12 pins)', () => {
  function store(): TranscriptStore {
    const runtime: SessionRuntime = {
      sql: sqliteSessionSql(new Database(':memory:')),
      clock: { now: () => 1_000_000 },
      sockets: () => [],
      setAlarm: () => {},
    };
    const core = new SessionCore(runtime);
    core.initSchema();
    return new TranscriptStore(core);
  }
  const data = (word: string) => ({ session_time: '00:00:01', speaker: 'A', word });

  it('insertTranscriptWord seeds ordinals 0,1,2… and reuses MAX+1 after the top row is deleted', () => {
    const words = store();
    const a = words.insertTranscriptWord(data('a'));
    const b = words.insertTranscriptWord(data('b'));
    const c = words.insertTranscriptWord(data('c'));
    expect([a.ordinal, b.ordinal, c.ordinal]).toEqual([0, 1, 2]);
    // COALESCE(MAX(ordinal), -1) + 1: deleting the max frees its ordinal.
    words.deleteTranscriptWord(c.id);
    expect(words.insertTranscriptWord(data('d')).ordinal).toBe(2);
  });

  it('updateTranscriptWord patches only the provided fields and returns the fresh row', () => {
    const words = store();
    const w = words.insertTranscriptWord(data('orig'));
    const updated = words.updateTranscriptWord(w.id, { word: 'edited', speaker: 'B' });
    expect(updated).toEqual({ ...w, word: 'edited', speaker: 'B' });
  });

  it('updateTranscriptWord with an empty patch is a no-op returning the row; unknown id returns null', () => {
    const words = store();
    const w = words.insertTranscriptWord(data('orig'));
    expect(words.updateTranscriptWord(w.id, {})).toEqual(w);
    expect(words.updateTranscriptWord('nope', { word: 'x' })).toBeNull();
  });
});
