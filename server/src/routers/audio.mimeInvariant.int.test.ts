// The stored/served audio mime invariant (perf-fixes review finding 1).
//
// `app.ts` scopes `compress()` to `/api/*` and excludes nothing, on the premise
// that "audio/* content-types never match the compressible filter". The upload
// handler used to persist the caller's `content-type` verbatim, so that premise
// was a hope, not a guarantee. `normalizeAudioMimeType` now enforces it at the
// upload boundary (and again when serving, for rows other writers created).
//
// The clamp is stated as the negation of the hazard — degrade only what the
// `/api/*` compression filter would match — rather than as an audio allowlist,
// which went stale against the batch importer's video containers on its first
// outing (see the `video/mp4` case below).
//
// Compression's own end-to-end consequence is asserted in
// `compression.int.test.ts`; this file pins the wire-level mime behavior:
// producers' types round-trip verbatim, compressible types degrade, and the
// download response never advertises a compressible type.

import { describe, expect, it } from 'vitest';
import { app, env } from '../test/harness';
import { seededSession } from '../test/helpers';

async function upload(
  session: string,
  contentType: string | null,
): Promise<{ url: string; mime_type: string }> {
  const headers: Record<string, string> = {};
  if (contentType !== null) headers['content-type'] = contentType;
  const res = await app.request(
    `/api/sessions/${session}/audio/segments`,
    { method: 'POST', headers, body: new Uint8Array([1, 2, 3, 4]) },
    { ...env },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { url: string; mime_type: string };
}

describe('audio segment mime normalization', () => {
  // Exactly what the live recorder (`mr.mimeType` / the delivered Blob's
  // `.type`, passed straight through by AudioRecorder.tsx) and the import
  // paths send. A normalization that rewrote any of these would be a
  // regression, not a fix.
  it.each([
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'audio/mp4',
    'audio/wav',
  ])('stores and serves the producer mime %s unchanged', async (mime) => {
    const session = seededSession().sessionId;
    const seg = await upload(session, mime);
    expect(seg.mime_type).toBe(mime);

    const res = await app.request(seg.url, { method: 'GET' }, { ...env });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(mime);
  });

  // The regression this file's second half exists for: the batch importer
  // (`web/…/batchImport/`) admits `.mp4`/`.webm`, uploads a single-file group
  // as the ORIGINAL `File`, and sends its browser-reported `.type` verbatim —
  // `video/mp4` for a .mp4. An audio-only allowlist clamped those to
  // `audio/webm`, which Safari (strict about media mimes) refuses to play,
  // and bought nothing: `video/*` never matched the compressible filter.
  it.each([
    'video/mp4',
    'video/webm',
    'application/ogg',
  ])('stores and serves the batch-import container mime %s unchanged', async (mime) => {
    const session = seededSession().sessionId;
    const seg = await upload(session, mime);
    expect(seg.mime_type).toBe(mime);

    const res = await app.request(seg.url, { method: 'GET' }, { ...env });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(mime);
  });

  it.each([
    'text/plain',
    'text/plain;charset=UTF-8',
    'image/svg+xml',
  ])('degrades the compressible content-type %s to audio/webm rather than rejecting the upload', async (mime) => {
    const session = seededSession().sessionId;
    const seg = await upload(session, mime);
    expect(seg.mime_type).toBe('audio/webm');

    const res = await app.request(seg.url, { method: 'GET' }, { ...env });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/webm');
  });

  it('keeps the pre-existing audio/webm default when no content-type is sent', async () => {
    const session = seededSession().sessionId;
    const seg = await upload(session, null);
    expect(seg.mime_type).toBe('audio/webm');
  });
});
