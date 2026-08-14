import { COMPRESSIBLE_CONTENT_TYPE_REGEX } from 'hono/compress';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../httpError';
import {
  enforceAudioByteLimit,
  enforceLocalAudioImportByteLimit,
  MAX_AUDIO_BYTES,
  MAX_LOCAL_AUDIO_IMPORT_BYTES,
  normalizeAudioMimeType,
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

describe('normalizeAudioMimeType', () => {
  // The mimes the real producers emit, verbatim. These MUST round-trip
  // unchanged — normalization exists to clamp non-audio uploads, not to
  // rewrite the recorder's or the importers' declared types.
  it.each([
    'audio/webm',
    'audio/webm;codecs=opus', // Chrome MediaRecorder default
    'audio/webm; codecs="opus"',
    'audio/ogg;codecs=opus', // Firefox MediaRecorder default
    'audio/mp4', // Safari MediaRecorder default / yt-dlp m4a+mp4
    'audio/mpeg', // BatchImportModal mp3 files
    'audio/wav', // BatchImportModal wav files / yt-dlp wav / DeepGram pcm
    'audio/aiff', // audioStore's mime<->ext table
  ])('passes %s through verbatim', (mime) => {
    expect(normalizeAudioMimeType(mime)).toBe(mime);
  });

  it.each([
    ['text/plain', 'a script whose fetch defaulted the header'],
    ['text/plain;charset=UTF-8', 'the Blob/string body default'],
    ['application/octet-stream', 'a generic binary upload'],
    ['application/json', 'a mis-set JSON header'],
    ['video/webm', 'a video container, outside the audio invariant'],
    ['audio/x+json', 'the structured-suffix hole a bare audio/ prefix test would leave open'],
    ['', 'a blank header'],
  ])('degrades %s to the audio/webm default (%s)', (mime) => {
    expect(normalizeAudioMimeType(mime)).toBe('audio/webm');
  });

  it('degrades a missing header to the audio/webm default', () => {
    expect(normalizeAudioMimeType(undefined)).toBe('audio/webm');
    expect(normalizeAudioMimeType(null)).toBe('audio/webm');
  });

  it('matches the family case-insensitively and trims surrounding space', () => {
    expect(normalizeAudioMimeType('  AUDIO/WebM;codecs=opus  ')).toBe('AUDIO/WebM;codecs=opus');
  });

  it('is idempotent (the download-side guard re-applies it)', () => {
    for (const raw of ['audio/webm;codecs=opus', 'text/plain', '', 'application/octet-stream']) {
      const once = normalizeAudioMimeType(raw);
      expect(normalizeAudioMimeType(once)).toBe(once);
    }
  });

  // The invariant this function exists to enforce, asserted against the actual
  // filter app.ts uses: whatever comes out is never compressible, so hono's
  // compress() (which has no 206/Content-Range guard) can never touch an audio
  // range response.
  it('never returns a type hono considers compressible', () => {
    const inputs = [
      'audio/webm;codecs=opus',
      'audio/ogg',
      'audio/mp4',
      'audio/mpeg',
      'audio/wav',
      'audio/x+json',
      'text/plain',
      'text/html',
      'application/json',
      'application/x-www-form-urlencoded',
      'image/svg+xml',
      '',
      undefined,
    ];
    for (const raw of inputs) {
      expect(COMPRESSIBLE_CONTENT_TYPE_REGEX.test(normalizeAudioMimeType(raw))).toBe(false);
    }
  });
});
