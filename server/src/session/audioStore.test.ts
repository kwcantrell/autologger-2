import { describe, expect, it } from 'vitest';
import { fakeRuntime } from '../test/fakeCore';
import { AudioStore, audioRowToMeta } from './audioStore';

describe('audioRowToMeta', () => {
  it('maps a full segment row incl. parsed waveform peaks', () => {
    const r = {
      id: 's1',
      ordinal: 3,
      started_at_utc: '2026-06-25T00:00:00.000Z',
      ended_at_utc: '2026-06-25T00:00:05.000Z',
      mime_type: 'audio/webm',
      r2_key: 'audio/sess/0003_s1.webm',
      recording_ordinal: 2,
      waveform_peaks_json: '[0.1,0.2,0.3]',
      waveform_db_floor: -48,
    };
    expect(audioRowToMeta(r)).toEqual({
      id: 's1',
      ordinal: 3,
      started_at_utc: '2026-06-25T00:00:00.000Z',
      ended_at_utc: '2026-06-25T00:00:05.000Z',
      mime_type: 'audio/webm',
      r2_key: 'audio/sess/0003_s1.webm',
      recording_ordinal: 2,
      waveform_peaks: [0.1, 0.2, 0.3],
      waveform_db_floor: -48,
    });
  });

  it('nulls peaks on bad JSON and nulls absent recording_ordinal/floor', () => {
    const r = {
      id: 's2',
      ordinal: 1,
      started_at_utc: null,
      ended_at_utc: null,
      mime_type: 'audio/ogg',
      r2_key: 'audio/sess/0001_s2.ogg',
      recording_ordinal: null,
      waveform_peaks_json: 'not json',
      waveform_db_floor: null,
    };
    expect(audioRowToMeta(r)).toEqual({
      id: 's2',
      ordinal: 1,
      started_at_utc: null,
      ended_at_utc: null,
      mime_type: 'audio/ogg',
      r2_key: 'audio/sess/0001_s2.ogg',
      recording_ordinal: null,
      waveform_peaks: null,
      waveform_db_floor: null,
    });
  });
});

// code-health-tail task 2.4 (design D12) — behavior pins over a REAL core
// (in-memory SQLite), written BEFORE the two mime↔ext mappings collapsed into
// one bidirectional table. These must pass unmodified across the rewrite.
describe('AudioStore mime↔ext over a real core (D12 pins)', () => {
  function store(): AudioStore {
    return new AudioStore(fakeRuntime().core);
  }
  const add = (audio: AudioStore, mimeType: string) =>
    audio.addAudioSegment({
      sessionId: 'sess',
      mimeType,
      startedAtUtc: null,
      endedAtUtc: null,
      recordingOrdinal: null,
    });

  it('addAudioSegment picks the blob-key extension by mime substring, webm as fallback', () => {
    const audio = store();
    const cases: Array<[string, string]> = [
      ['audio/webm', 'webm'],
      ['audio/webm;codecs=opus', 'webm'],
      ['audio/ogg;codecs=opus', 'ogg'],
      ['audio/wav', 'wav'],
      ['audio/mp4', 'm4a'],
      ['audio/x-m4a', 'm4a'],
      ['', 'webm'], // empty mime falls back to audio/webm
      ['audio/flac', 'webm'], // unknown mime falls back to webm
    ];
    for (const [mime, ext] of cases) {
      const seg = add(audio, mime);
      expect(seg.r2_key.endsWith(`.${ext}`), `${mime} → .${ext}, got ${seg.r2_key}`).toBe(true);
    }
    // Stored mime_type is the caller's string (or the audio/webm default), not the ext's canonical mime.
    expect(add(audio, 'audio/x-m4a').mime_type).toBe('audio/x-m4a');
    expect(add(audio, '').mime_type).toBe('audio/webm');
  });

  it('syncAudioFromBlobs restores the canonical mime for each extension', () => {
    const audio = store();
    const id = () => crypto.randomUUID();
    const keys = [
      { r2_key: `audio/sess/0001_${id()}.webm`, ordinal: 1 },
      { r2_key: `audio/sess/0002_${id()}.ogg`, ordinal: 2 },
      { r2_key: `audio/sess/0003_${id()}.wav`, ordinal: 3 },
      { r2_key: `audio/sess/0004_${id()}.m4a`, ordinal: 4 },
    ];
    expect(audio.syncAudioFromBlobs(keys)).toEqual({ inserted: 4 });
    expect(audio.listAudioSegments().map((s) => s.mime_type)).toEqual([
      'audio/webm',
      'audio/ogg',
      'audio/wav',
      'audio/mp4',
    ]);
  });

  it('round-trips a canonical mime: segment key ext → blob-scan backfill recovers the same mime', () => {
    for (const mime of ['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mp4']) {
      const writer = store();
      const seg = add(writer, mime);
      const reader = store(); // fresh DB: simulate metadata loss + blob rescan
      reader.syncAudioFromBlobs([{ r2_key: seg.r2_key, ordinal: seg.ordinal }]);
      expect(reader.listAudioSegments()[0]?.mime_type).toBe(mime);
    }
  });
});
