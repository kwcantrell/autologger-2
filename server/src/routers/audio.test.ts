import { describe, expect, it } from 'vitest';
import { ApiError } from './_helpers';
import { enforceAudioByteLimit, MAX_AUDIO_BYTES } from './audio';

describe('enforceAudioByteLimit', () => {
  it('does nothing for null (unknown length)', () => {
    expect(() => enforceAudioByteLimit(null)).not.toThrow();
  });

  it('does nothing at or below the cap', () => {
    expect(() => enforceAudioByteLimit(MAX_AUDIO_BYTES)).not.toThrow();
    expect(() => enforceAudioByteLimit(1024)).not.toThrow();
  });

  it('throws ApiError(413) above the cap', () => {
    try {
      enforceAudioByteLimit(MAX_AUDIO_BYTES + 1);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(413);
    }
  });

  it('does nothing for NaN (garbage Content-Length falls through to the post-read check)', () => {
    expect(() => enforceAudioByteLimit(Number('not-a-number'))).not.toThrow();
  });
});
