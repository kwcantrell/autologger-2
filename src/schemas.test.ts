import { describe, expect, it } from 'vitest';
import {
  adminStudioCreateBodySchema,
  audioSegmentWaveformBodySchema,
  companionCommandBodySchema,
  eventUpdateBodySchema,
  logBodySchema,
  MAX_METADATA_BYTES,
  newSessionBodySchema,
} from './schemas';

describe('logBodySchema.metadata cap', () => {
  it('accepts a normal small metadata object', () => {
    const r = logBodySchema.safeParse({ category: 'cam', message: 'hi', metadata: { take: 1 } });
    expect(r.success).toBe(true);
  });

  it('defaults metadata to {} when absent', () => {
    const r = logBodySchema.safeParse({ category: 'cam', message: 'hi' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.metadata).toEqual({});
  });

  it('rejects metadata that serializes beyond the cap', () => {
    const big = { blob: 'x'.repeat(MAX_METADATA_BYTES + 100) };
    const r = logBodySchema.safeParse({ category: 'cam', message: 'hi', metadata: big });
    expect(r.success).toBe(false);
  });
});

describe('newSessionBodySchema', () => {
  it('defaults frame_rate=24, start_offset=0 and requires show_id+episode', () => {
    const r = newSessionBodySchema.safeParse({ show_id: 's', episode: '001' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ frame_rate: 24, start_offset_frames: 0 });
  });
  it('rejects frame_rate out of [1,120]', () => {
    expect(newSessionBodySchema.safeParse({ show_id: 's', episode: '1', frame_rate: 0 }).success).toBe(
      false,
    );
    expect(
      newSessionBodySchema.safeParse({ show_id: 's', episode: '1', frame_rate: 121 }).success,
    ).toBe(false);
  });
  it('requires non-empty episode', () => {
    expect(newSessionBodySchema.safeParse({ show_id: 's', episode: '' }).success).toBe(false);
  });
});

describe('eventUpdateBodySchema', () => {
  it('requires exactly-8-char timecode_hms', () => {
    const base = { category: 'c', message: 'm', wall_time_utc: 'w' };
    expect(eventUpdateBodySchema.safeParse({ ...base, timecode_hms: '00:00:00' }).success).toBe(true);
    expect(eventUpdateBodySchema.safeParse({ ...base, timecode_hms: '1:2:3' }).success).toBe(false);
  });
});

describe('enum + bound schemas', () => {
  it('companionCommandBodySchema accepts only known actions', () => {
    expect(companionCommandBodySchema.safeParse({ type: 'record-start' }).success).toBe(true);
    expect(companionCommandBodySchema.safeParse({ type: 'nope' }).success).toBe(false);
  });
  it('adminStudioCreateBodySchema enforces id length 2..63', () => {
    expect(adminStudioCreateBodySchema.safeParse({ id: 'a', display_name: 'x' }).success).toBe(false);
    expect(adminStudioCreateBodySchema.safeParse({ id: 'ab', display_name: 'x' }).success).toBe(true);
  });
  it('audioSegmentWaveformBodySchema bounds peaks 8..4096', () => {
    expect(audioSegmentWaveformBodySchema.safeParse({ peaks: [1, 2, 3] }).success).toBe(false);
    expect(audioSegmentWaveformBodySchema.safeParse({ peaks: Array(8).fill(0) }).success).toBe(true);
  });
});
