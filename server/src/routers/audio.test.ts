import { describe, expect, it } from 'vitest';
import { ApiError } from '../httpError';
import {
  enforceAudioByteLimit,
  enforceLocalAudioImportByteLimit,
  MAX_AUDIO_BYTES,
  MAX_LOCAL_AUDIO_IMPORT_BYTES,
} from './audio';

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

describe('enforceLocalAudioImportByteLimit', () => {
  it('allows payloads above the live-recorder 50MB cap', () => {
    expect(() => enforceLocalAudioImportByteLimit(MAX_AUDIO_BYTES + 1)).not.toThrow();
  });

  it('throws ApiError(413) above the local-import cap', () => {
    try {
      enforceLocalAudioImportByteLimit(MAX_LOCAL_AUDIO_IMPORT_BYTES + 1);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(413);
      expect((e as ApiError).detail).toContain(String(MAX_LOCAL_AUDIO_IMPORT_BYTES));
    }
  });
});
