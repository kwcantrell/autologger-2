import { TranscriptGenerateError } from '@autologger/transcription';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../httpError';
import {
  DEEPGRAM_MAX_GROUP_BYTES,
  enforceGroupSizeLimit,
  exceedsGroupSizeLimit,
  mapGenerateError,
} from './transcribe';

describe('exceedsGroupSizeLimit', () => {
  it('is false at or below the cap', () => {
    expect(exceedsGroupSizeLimit(DEEPGRAM_MAX_GROUP_BYTES)).toBe(false);
    expect(exceedsGroupSizeLimit(DEEPGRAM_MAX_GROUP_BYTES - 1)).toBe(false);
    expect(exceedsGroupSizeLimit(0)).toBe(false);
  });

  it('is true above the cap', () => {
    expect(exceedsGroupSizeLimit(DEEPGRAM_MAX_GROUP_BYTES + 1)).toBe(true);
  });
});

describe('enforceGroupSizeLimit', () => {
  it('does nothing at or below the cap', () => {
    expect(() => enforceGroupSizeLimit(DEEPGRAM_MAX_GROUP_BYTES)).not.toThrow();
    expect(() => enforceGroupSizeLimit(1024)).not.toThrow();
  });

  it('throws ApiError(502) naming the limit above the cap', () => {
    try {
      enforceGroupSizeLimit(DEEPGRAM_MAX_GROUP_BYTES + 1);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(502);
      expect((e as ApiError).detail).toContain(String(DEEPGRAM_MAX_GROUP_BYTES));
    }
  });
});

// media-worker D9 (B, assigned): a listed segment whose blob is missing fails the run with `502`
// naming it (generateTranscript's `missing_blob` code), never the `400` of an unknown code.
describe('mapGenerateError', () => {
  it('maps missing_blob to 502 with the error message', () => {
    try {
      mapGenerateError(new TranscriptGenerateError('missing_blob', 'segment seg-1 has no audio'));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(502);
      expect((e as ApiError).detail).toBe('segment seg-1 has no audio');
    }
  });

  it('keeps the existing codes', () => {
    const status = (code: ConstructorParameters<typeof TranscriptGenerateError>[0]) => {
      try {
        mapGenerateError(new TranscriptGenerateError(code, 'x'));
      } catch (e) {
        return (e as ApiError).status;
      }
      return null;
    };
    expect(status('unavailable')).toBe(503);
    expect(status('in_flight')).toBe(409);
    expect(status('upstream')).toBe(502);
    expect(status('oversize')).toBe(502);
  });
});
