// media-worker B.1 (design D6, D12, D16): the upload create body, the finalize body and the
// 12-key audio segment dict.
import { describe, expect, it } from 'vitest';
import {
  AUDIO_SEGMENT_DICT_KEYS,
  AUDIO_UPLOAD_MAX_BYTES,
  audioFinalizeBodySchema,
  audioFinalizeResponseSchema,
  audioSegmentDictSchema,
  audioUploadCreateBodySchema,
} from './schemas';

const HEX = 'a'.repeat(64);

describe('audioUploadCreateBodySchema (D12)', () => {
  const ok = { content_type: 'audio/wav', size_bytes: 1024, part_sha256: [HEX] };

  it('accepts a well-formed body', () => {
    expect(audioUploadCreateBodySchema.safeParse(ok).success).toBe(true);
  });

  it('refuses a blank or missing content_type', () => {
    expect(audioUploadCreateBodySchema.safeParse({ ...ok, content_type: '   ' }).success).toBe(
      false,
    );
    expect(audioUploadCreateBodySchema.safeParse({ ...ok, content_type: undefined }).success).toBe(
      false,
    );
  });

  it('size_bytes is an integer in 1..1500 MiB', () => {
    expect(AUDIO_UPLOAD_MAX_BYTES).toBe(1500 * 1024 * 1024);
    for (const bad of [0, -1, 1.5, AUDIO_UPLOAD_MAX_BYTES + 1, '12']) {
      expect(
        audioUploadCreateBodySchema.safeParse({ ...ok, size_bytes: bad }).success,
        String(bad),
      ).toBe(false);
    }
    expect(
      audioUploadCreateBodySchema.safeParse({ ...ok, size_bytes: AUDIO_UPLOAD_MAX_BYTES }).success,
    ).toBe(true);
  });

  it('part_sha256 is a non-empty list of 64 lowercase hex', () => {
    for (const bad of [[], ['A'.repeat(64)], ['a'.repeat(63)], ['g'.repeat(64)], [1], 'x']) {
      expect(
        audioUploadCreateBodySchema.safeParse({ ...ok, part_sha256: bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
    expect(audioUploadCreateBodySchema.safeParse({ ...ok, part_sha256: [HEX, HEX] }).success).toBe(
      true,
    );
  });
});

describe('audioFinalizeBodySchema (D6)', () => {
  it('accepts 1..1000 timestamps', () => {
    expect(
      audioFinalizeBodySchema.safeParse({ chunks: ['2026-10-12T10:00:00.000Z'] }).success,
    ).toBe(true);
    expect(
      audioFinalizeBodySchema.safeParse({ chunks: Array(1000).fill('2026-10-12T10:00:00Z') })
        .success,
    ).toBe(true);
  });

  it('refuses an empty list, over 1000, non-strings and a missing key', () => {
    expect(audioFinalizeBodySchema.safeParse({ chunks: [] }).success).toBe(false);
    expect(
      audioFinalizeBodySchema.safeParse({ chunks: Array(1001).fill('2026-10-12T10:00:00Z') })
        .success,
    ).toBe(false);
    expect(audioFinalizeBodySchema.safeParse({ chunks: [1] }).success).toBe(false);
    expect(audioFinalizeBodySchema.safeParse({ chunks: [''] }).success).toBe(false);
    expect(audioFinalizeBodySchema.safeParse({}).success).toBe(false);
  });
});

describe('audioSegmentDictSchema (D16)', () => {
  const dict = {
    id: 'seg-1',
    ordinal: 1,
    started_at_utc: '2026-10-12T10:00:00.000Z',
    ended_at_utc: null,
    mime_type: 'audio/webm',
    recording_ordinal: 1,
    url: '/api/sessions/s/audio/segments/seg-1',
    waveform_peaks: null,
    waveform_db_floor: null,
    duration_ms: null,
    media_status: null,
    seams: null,
  };

  it('has exactly the 12 keys', () => {
    expect(AUDIO_SEGMENT_DICT_KEYS).toHaveLength(12);
    expect([...AUDIO_SEGMENT_DICT_KEYS].sort()).toEqual(Object.keys(dict).sort());
  });

  it('accepts the legacy nulls and a processed merged segment', () => {
    expect(audioSegmentDictSchema.safeParse(dict).success).toBe(true);
    expect(
      audioSegmentDictSchema.safeParse({
        ...dict,
        duration_ms: 1234,
        media_status: 'done',
        seams: [
          { offset_ms: 0, started_at_utc: '2026-10-12T10:00:00.000Z', ended_at_utc: null },
          {
            offset_ms: 600000,
            started_at_utc: '2026-10-12T10:10:00.000Z',
            ended_at_utc: '2026-10-12T10:20:00.000Z',
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('refuses a missing new key, an unknown status, an extra key and a negative duration', () => {
    const { seams: _s, ...missing } = dict;
    expect(audioSegmentDictSchema.safeParse(missing).success).toBe(false);
    expect(audioSegmentDictSchema.safeParse({ ...dict, media_status: 'queued' }).success).toBe(
      false,
    );
    expect(audioSegmentDictSchema.safeParse({ ...dict, extra: 1 }).success).toBe(false);
    expect(audioSegmentDictSchema.safeParse({ ...dict, duration_ms: -1 }).success).toBe(false);
  });
});

describe('audioFinalizeResponseSchema (D6)', () => {
  it('is { ok: true, merge } with the four outcomes', () => {
    for (const merge of ['queued', 'not-needed', 'already-queued', 'waiting']) {
      expect(audioFinalizeResponseSchema.safeParse({ ok: true, merge }).success, merge).toBe(true);
    }
    expect(audioFinalizeResponseSchema.safeParse({ ok: true, merge: 'done' }).success).toBe(false);
    expect(audioFinalizeResponseSchema.safeParse({ ok: false, merge: 'queued' }).success).toBe(
      false,
    );
  });
});
