import { COMPRESSIBLE_CONTENT_TYPE_REGEX } from 'hono/compress';
import { describe, expect, it } from 'vitest';
import { isCompressibleResponseType } from '../compressibleTypes';
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

  // The container mimes browsers report for files the batch importer admits
  // (`SUPPORTED_EXTENSIONS` includes mp4/webm/ogg, and a single-file group is
  // uploaded as the original `File` with its `.type` verbatim). None are
  // compressible, so clamping them would only break playback — Safari is
  // strict about media mimes.
  it.each([
    ['video/mp4', 'a .mp4 picked in the batch importer'],
    ['video/webm', 'a .webm picked in the batch importer'],
    ['video/ogg', 'a .ogg on a platform whose mime registry says video'],
    ['application/ogg', 'a .ogg on a platform whose mime registry says application'],
    ['video/quicktime', 'a QuickTime container'],
    ['application/octet-stream', 'a generic binary upload'],
  ])('passes the non-compressible type %s through verbatim (%s)', (mime) => {
    expect(normalizeAudioMimeType(mime)).toBe(mime);
  });

  it.each([
    ['text/plain', 'a script whose fetch defaulted the header'],
    ['text/plain;charset=UTF-8', 'the Blob/string body default'],
    ['text/html', 'the one type sniffing would actually make dangerous'],
    ['application/json', 'a mis-set JSON header'],
    ['image/svg+xml', 'a scriptable structured-suffix type'],
    ['application/x-ndjson', 'compressible only under app.ts’s extended filter'],
    ['audio/x+json', 'the structured-suffix hole a bare audio/ prefix test would leave open'],
    ['', 'a blank header'],
  ])('degrades the compressible type %s to the audio/webm default (%s)', (mime) => {
    expect(normalizeAudioMimeType(mime)).toBe('audio/webm');
  });

  it('degrades a missing header to the audio/webm default', () => {
    expect(normalizeAudioMimeType(undefined)).toBe('audio/webm');
    expect(normalizeAudioMimeType(null)).toBe('audio/webm');
  });

  it('trims surrounding space and preserves case', () => {
    expect(normalizeAudioMimeType('  AUDIO/WebM;codecs=opus  ')).toBe('AUDIO/WebM;codecs=opus');
  });

  it('matches the compressible filter case-insensitively', () => {
    expect(normalizeAudioMimeType('  TEXT/Plain; charset=utf-8 ')).toBe('audio/webm');
  });

  it('is idempotent (the download-side guard re-applies it)', () => {
    for (const raw of [
      'audio/webm;codecs=opus',
      'video/mp4',
      'text/plain',
      '',
      'application/octet-stream',
    ]) {
      const once = normalizeAudioMimeType(raw);
      expect(normalizeAudioMimeType(once)).toBe(once);
    }
  });

  // The invariant this function exists to enforce, asserted against the actual
  // filter app.ts uses: whatever comes out is never compressible, so hono's
  // compress() (which has no 206/Content-Range guard) can never touch an audio
  // range response.
  it('never returns a type the /api/* compression filter would match', () => {
    const inputs = [
      'audio/webm;codecs=opus',
      'audio/ogg',
      'audio/mp4',
      'audio/mpeg',
      'audio/wav',
      'audio/x+json',
      'video/mp4',
      'video/webm',
      'application/ogg',
      'application/octet-stream',
      'text/plain',
      'text/html',
      'application/json',
      'application/x-www-form-urlencoded',
      'application/x-ndjson',
      'image/svg+xml',
      '',
      undefined,
    ];
    for (const raw of inputs) {
      const out = normalizeAudioMimeType(raw);
      expect(isCompressibleResponseType(out)).toBe(false);
      // hono's own regex is a subset of that filter; assert it directly too so
      // the invariant survives an extension of the app-level filter.
      expect(COMPRESSIBLE_CONTENT_TYPE_REGEX.test(out)).toBe(false);
    }
  });
});
