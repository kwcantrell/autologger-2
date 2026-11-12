// The event row mapper. Pure, so it runs in the unit tier (moved from eventStore.int.test.ts,
// whose other cases need a real core over Postgres).
import { formatSmpte, fromTotalFrames } from '@autologger/domain';
import { eventRowToRpc } from '@autologger/session-core/eventStore';
import { describe, expect, it } from 'vitest';

describe('eventRowToRpc', () => {
  it('maps a row with a timecode', () => {
    const r = {
      id: 'e1',
      wall_time_utc: '2026-06-25T00:00:00.000Z',
      frame_rate: 24,
      timecode_total_frames: 48,
      category: 'note',
      message: 'hi',
      metadata_json: '{"a":1}',
    };
    expect(eventRowToRpc(r)).toEqual({
      event_id: 'e1',
      wall_time_utc: '2026-06-25T00:00:00.000Z',
      timecode: formatSmpte(fromTotalFrames(48, 24)),
      frame_rate: 24,
      timecode_total_frames: 48,
      category: 'note',
      message: 'hi',
      metadata_json: '{"a":1}',
      version: 1,
    });
  });

  it('nulls timecode fields when timecode_total_frames is absent, defaults metadata', () => {
    const r = {
      id: 'e2',
      wall_time_utc: '2026-06-25T00:00:01.000Z',
      frame_rate: 24,
      timecode_total_frames: null,
      category: 'internal',
      message: 'rec start',
      metadata_json: null,
    };
    expect(eventRowToRpc(r)).toEqual({
      event_id: 'e2',
      wall_time_utc: '2026-06-25T00:00:01.000Z',
      timecode: null,
      frame_rate: null,
      timecode_total_frames: null,
      category: 'internal',
      message: 'rec start',
      metadata_json: '{}',
      version: 1,
    });
  });
});
