import { describe, expect, it } from 'vitest';
import { ApiError } from '../httpError';
import {
  DEEPGRAM_MAX_GROUP_BYTES,
  enforceGroupSizeLimit,
  exceedsGroupSizeLimit,
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
