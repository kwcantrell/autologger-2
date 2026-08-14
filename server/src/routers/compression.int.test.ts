// Compression middleware coverage (perf-fixes A1): the `/api/*`-scoped
// `compress()` in app.ts gzips large JSON and export bodies when the client
// advertises Accept-Encoding, while leaving audio byte-serving (range
// semantics, hand-set content-length/content-range) untouched.
//
// CACHE CORRECTNESS (`Vary: Accept-Encoding`): every response ELIGIBLE for
// encoding negotiation must carry it, whether or not this particular response
// came back gzipped — a cached identity body served to a gzip client, or a
// cached gzip body served to a client that sent no Accept-Encoding (a plain
// `<a href>` download of export.csv, later curl'd behind the same cache), is
// the bug it prevents. hono's `compress()` sets no Vary of its own; the inner
// `measureCompressibleBody` middleware stamps it, and the assertions below
// pin that it SURVIVES compress()'s response rebuild. Surfaces outside
// negotiation (audio byte-serving, SSE) must NOT gain it.
//
// NOTE: `app.request(...)` bypasses Node's HTTP client, so Accept-Encoding is
// never added implicitly — every request here sets (or omits) it explicitly,
// and compressed bodies arrive still-gzipped (no auto-decode). Decode via
// DecompressionStream.

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { AI_RUNTIME_FIXTURES_DIR } from '@autologger/ai-runtime';
import { stableSessionCwd } from '@autologger/ai-runtime/aiChatRunner';
import { afterEach, describe, expect, it } from 'vitest';
import { app, env, envWith } from '../test/harness';
import { seededSession } from '../test/helpers';

const GZIP = { 'accept-encoding': 'gzip' };
const J = { 'content-type': 'application/json' };

/** The hermetic fake-claude CLI (ai.int.test.ts's `FIXTURE_CLI`) — the only
 * env that completes a real ai/chat turn, and so the only way to reach a
 * genuine SSE response through the shared app. */
const FIXTURE_CLI = join(AI_RUNTIME_FIXTURES_DIR, 'fake-claude.mjs');

/** The fixture writes into a deterministic per-session cwd outside DATA_DIR;
 * clean up after the SSE test the way ai.int.test.ts does. */
const sseSessionIds: string[] = [];
afterEach(() => {
  for (const id of sseSessionIds.splice(0)) {
    rmSync(stableSessionCwd(id), { recursive: true, force: true });
  }
});

/** Vary is a comma-separated token list; assert membership, not the exact
 * string, so a route that adds its own token later doesn't fail this. */
function variesOnAcceptEncoding(res: Response): boolean {
  const vary = res.headers.get('vary');
  if (vary === null) return false;
  return vary
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .includes('accept-encoding');
}

async function gunzipJson(res: Response): Promise<unknown> {
  return await new Response(res.body!.pipeThrough(new DecompressionStream('gzip'))).json();
}

async function gunzipText(res: Response): Promise<string> {
  return await new Response(res.body!.pipeThrough(new DecompressionStream('gzip'))).text();
}

/** Seed enough transcript words that the JSON list body clears the
 * middleware's 1024-byte threshold by a wide margin. */
async function seedWords(sessionId: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const res = await app.request(
      `/api/sessions/${sessionId}/transcript-words`,
      {
        method: 'POST',
        headers: J,
        body: JSON.stringify({
          session_time: '00:00:01',
          speaker: `Speaker ${i}`,
          word: `word-${i}-${'x'.repeat(40)}`,
        }),
      },
      { ...env },
    );
    expect(res.status).toBe(201);
  }
}

/** Seed events so the CSV/JSONL export bodies clear the 1024-byte threshold. */
async function seedEvents(sessionId: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const res = await app.request(
      `/api/sessions/${sessionId}/events`,
      {
        method: 'POST',
        headers: J,
        body: JSON.stringify({ category: 'cam', message: `event ${i} ${'m'.repeat(200)}` }),
      },
      { ...env },
    );
    expect(res.status).toBe(200);
  }
}

describe('API compression (app-level /api/* compress middleware)', () => {
  it('gzips transcript-words when Accept-Encoding allows; payload equals the un-encoded body', async () => {
    const session = seededSession().sessionId;
    await seedWords(session);

    const plain = await app.request(
      `/api/sessions/${session}/transcript-words`,
      { method: 'GET' },
      { ...env },
    );
    expect(plain.status).toBe(200);
    expect(plain.headers.get('content-encoding')).toBeNull();
    // (b) No Accept-Encoding at all: the identity body still advertises that
    // its representation depends on the header, so a cache can never hand it
    // to a gzip client (or vice versa) without revalidating.
    expect(plain.headers.get('vary')).toBe('Accept-Encoding');
    const plainBody = (await plain.json()) as { words: unknown[] };
    expect(plainBody.words).toHaveLength(30);

    const compressed = await app.request(
      `/api/sessions/${session}/transcript-words`,
      { method: 'GET', headers: GZIP },
      { ...env },
    );
    expect(compressed.status).toBe(200);
    expect(compressed.headers.get('content-encoding')).toBe('gzip');
    expect(compressed.headers.get('content-length')).toBeNull();
    // (a) Set by the INNER middleware, before compress() rebuilt the response
    // around a CompressionStream — this asserts it survived that rebuild.
    expect(compressed.headers.get('vary')).toBe('Accept-Encoding');
    expect(await gunzipJson(compressed)).toEqual(plainBody);
  });

  it('leaves a small JSON body uncompressed with an accurate content-length', async () => {
    // Same route as the gzip test above, but with nothing seeded — so the only
    // difference is payload size. `c.json()` sets no content-length, which used
    // to make compress()'s 1024-byte threshold inert: this 14-byte body gzipped
    // to a LARGER one. measureCompressibleBody stamps the length so the
    // threshold can actually fire.
    const session = seededSession().sessionId;

    const res = await app.request(
      `/api/sessions/${session}/transcript-words`,
      { method: 'GET', headers: GZIP },
      { ...env },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBeNull();
    // (c) Below the threshold, so never encoded — but still a negotiable
    // representation, so still Vary-stamped.
    expect(res.headers.get('vary')).toBe('Accept-Encoding');

    const raw = new Uint8Array(await res.arrayBuffer());
    expect(raw.byteLength).toBeLessThan(1024);
    expect(res.headers.get('content-length')).toBe(String(raw.byteLength));
    expect(JSON.parse(new TextDecoder().decode(raw))).toEqual({ words: [] });
  });

  it('leaves a small JSON error body uncompressed with an accurate content-length', async () => {
    // Error bodies come from app.onError, downstream of the same middleware
    // pair — the hot path where a handful of bytes were being gzipped.
    const res = await app.request(
      '/api/sessions/does-not-exist/transcript-words',
      { method: 'GET', headers: GZIP },
      { ...env },
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('vary')).toBe('Accept-Encoding');

    const raw = new Uint8Array(await res.arrayBuffer());
    expect(raw.byteLength).toBeLessThan(1024);
    expect(res.headers.get('content-length')).toBe(String(raw.byteLength));
    expect(JSON.parse(new TextDecoder().decode(raw))).toHaveProperty('detail');
  });

  it('leaves audio 206 range responses uncompressed with range headers intact', async () => {
    const session = seededSession().sessionId;
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const up = await app.request(
      `/api/sessions/${session}/audio/segments`,
      { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: bytes },
      { ...env },
    );
    expect(up.status).toBe(200);
    const seg = (await up.json()) as { url: string };

    const res = await app.request(
      seg.url,
      { method: 'GET', headers: { range: 'bytes=-2', ...GZIP } },
      { ...env },
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-encoding')).toBeNull();
    // (d) audio/* is outside the compressible filter, so its representation
    // does not depend on Accept-Encoding — no Vary is added. (Range responses
    // vary on `Range`, which is the audio router's business, not ours; assert
    // only that WE contributed nothing.)
    expect(variesOnAcceptEncoding(res)).toBe(false);
    expect(res.headers.get('content-range')).toBe('bytes 3-4/5');
    expect(res.headers.get('content-length')).toBe('2');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([4, 5]));
  });

  it('clamps a compressible upload content-type so its 206 range response still ships identity', async () => {
    // The invariant behind "audio byte-serving needs no explicit exclusion" is
    // that a segment's content-type is always audio/* — and NOTHING enforced
    // that until the upload handler started normalizing (audio.ts
    // normalizeAudioMimeType). Before it, any client whose fetch defaulted the
    // header (text/plain) stored that verbatim, the download echoed it, and
    // compress() — which has no 206/Content-Range guard — gzipped the range
    // body: the hand-set Content-Length is dropped while Content-Range still
    // describes identity bytes. Corrupt audio for a range-assembling client.
    //
    // Highly compressible and comfortably over compress()'s 1KB threshold, so
    // a regression here gzips rather than silently squeaking under it.
    const session = seededSession().sessionId;
    const bytes = new Uint8Array(4096).fill(0x41);
    const up = await app.request(
      `/api/sessions/${session}/audio/segments`,
      { method: 'POST', headers: { 'content-type': 'text/plain' }, body: bytes },
      { ...env },
    );
    expect(up.status).toBe(200);
    const seg = (await up.json()) as { url: string; mime_type: string };
    // Stored (and reported) as audio, not as the caller's compressible type.
    expect(seg.mime_type).toBe('audio/webm');

    const res = await app.request(
      seg.url,
      { method: 'GET', headers: { range: 'bytes=0-2047', ...GZIP } },
      { ...env },
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-type')).toBe('audio/webm');
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(variesOnAcceptEncoding(res)).toBe(false);
    expect(res.headers.get('content-range')).toBe('bytes 0-2047/4096');
    expect(res.headers.get('content-length')).toBe('2048');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes.slice(0, 2048));
  });

  it('serves a batch-imported video/mp4 segment as video/mp4, identity, over a range', async () => {
    // The batch importer (`web/…/batchImport/`) admits `.mp4` in
    // SUPPORTED_EXTENSIONS, uploads a single-file group as the ORIGINAL `File`
    // via POST local-audio-import, and sends `blob.type` verbatim — which for
    // a .mp4 is the browser-reported `video/mp4`. `local-audio-import` stores
    // that string as-is, so the download handler's clamp is the only thing
    // standing between the row and the wire.
    //
    // An audio-only allowlist rewrote it to `audio/webm` — a playback
    // regression on Safari (strict about media mimes) that bought nothing:
    // `video/mp4` never matched the compressible filter (no `video/` branch,
    // no structured suffix). The clamp is now the negation of the hazard, so
    // this round-trips while the identity/206 guarantee below still holds.
    const session = seededSession().sessionId;
    const bytes = new Uint8Array(4096).fill(0x41);
    const up = await app.request(
      `/api/sessions/${session}/local-audio-import?duration_s=10`,
      { method: 'POST', headers: { 'content-type': 'video/mp4' }, body: bytes },
      { ...env },
    );
    expect(up.status).toBe(200);

    const listed = await app.request(
      `/api/sessions/${session}/audio/segments`,
      { method: 'GET' },
      { ...env },
    );
    expect(listed.status).toBe(200);
    const segments = (await listed.json()) as { segments: { url: string; mime_type: string }[] };
    expect(segments.segments).toHaveLength(1);
    const seg = segments.segments[0];
    expect(seg.mime_type).toBe('video/mp4');

    const res = await app.request(
      seg.url,
      { method: 'GET', headers: { range: 'bytes=0-2047', ...GZIP } },
      { ...env },
    );
    expect(res.status).toBe(206);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(variesOnAcceptEncoding(res)).toBe(false);
    expect(res.headers.get('content-range')).toBe('bytes 0-2047/4096');
    expect(res.headers.get('content-length')).toBe('2048');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes.slice(0, 2048));
  });

  it('leaves full-body audio downloads uncompressed with content-length intact', async () => {
    const session = seededSession().sessionId;
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const up = await app.request(
      `/api/sessions/${session}/audio/segments`,
      { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: bytes },
      { ...env },
    );
    expect(up.status).toBe(200);
    const seg = (await up.json()) as { url: string };

    const res = await app.request(seg.url, { method: 'GET', headers: GZIP }, { ...env });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(variesOnAcceptEncoding(res)).toBe(false);
    expect(res.headers.get('content-length')).toBe('5');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it('gzips export.csv and export.jsonl (jsonl proves the x-ndjson filter)', async () => {
    const session = seededSession().sessionId;
    await seedEvents(session);

    const plainCsv = await app.request(
      `/api/sessions/${session}/export.csv`,
      { method: 'GET' },
      { ...env },
    );
    expect(plainCsv.status).toBe(200);
    const plainCsvText = await plainCsv.text();

    const csv = await app.request(
      `/api/sessions/${session}/export.csv`,
      { method: 'GET', headers: GZIP },
      { ...env },
    );
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-encoding')).toBe('gzip');
    // The concrete scenario the header exists for: export.csv is fetched by a
    // plain `<a href>` download and later re-fetched by a non-gzip client.
    expect(csv.headers.get('vary')).toBe('Accept-Encoding');
    expect(plainCsv.headers.get('vary')).toBe('Accept-Encoding');
    expect(await gunzipText(csv)).toBe(plainCsvText);

    const plainJsonl = await app.request(
      `/api/sessions/${session}/export.jsonl`,
      { method: 'GET' },
      { ...env },
    );
    expect(plainJsonl.status).toBe(200);
    const plainJsonlText = await plainJsonl.text();

    // application/x-ndjson is NOT in hono's default compressible-type regex —
    // gzip here proves the custom contentTypeFilter is live.
    const jsonl = await app.request(
      `/api/sessions/${session}/export.jsonl`,
      { method: 'GET', headers: GZIP },
      { ...env },
    );
    expect(jsonl.status).toBe(200);
    expect(jsonl.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
    expect(jsonl.headers.get('content-encoding')).toBe('gzip');
    expect(jsonl.headers.get('vary')).toBe('Accept-Encoding');
    expect(await gunzipText(jsonl)).toBe(plainJsonlText);
  });

  it('adds no Vary: Accept-Encoding to an SSE stream', async () => {
    // (d), streaming half. `streamSSE` sets Transfer-Encoding: chunked and
    // text/event-stream — compress() skips both, so the response is not a
    // negotiated representation and must gain nothing from the middleware.
    // Driven through the real ai/chat route with the hermetic fake-claude
    // fixture (the same env ai.int.test.ts's streaming test uses) because
    // that is the only way to reach a genuine streaming response through the
    // shared app: the middleware pair only wraps routes wireApp mounted.
    const session = seededSession().sessionId;
    sseSessionIds.push(session);

    const res = await app.request(
      `/api/sessions/${session}/ai/chat`,
      { method: 'POST', headers: { ...J, ...GZIP }, body: JSON.stringify({ message: 'hi' }) },
      envWith({ CLAUDE_CLI_PATH: FIXTURE_CLI, HOST: '127.0.0.1', REQUIRE_LOGIN: '0' }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(variesOnAcceptEncoding(res)).toBe(false);
    // Drain so the fixture subprocess finishes before teardown.
    await res.text();
  });
});
