// The audio segment row mapper. Pure, so it runs in the unit tier (moved from
// audioStore.int.test.ts, whose other cases need a real core over Postgres).
import { audioRowToMeta } from '@autologger/session-core/audioStore';
import { describe, expect, it } from 'vitest';

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
      // media-worker D16: a row without the media columns maps them to null.
      duration_ms: null,
      media_status: null,
      media_error: null,
      seams: null,
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
      duration_ms: null,
      media_status: null,
      media_error: null,
      seams: null,
    });
  });
});
