// Compression middleware coverage (perf-fixes A1): the `/api/*`-scoped
// `compress()` in app.ts gzips large JSON and export bodies when the client
// advertises Accept-Encoding, while leaving audio byte-serving (range
// semantics, hand-set content-length/content-range) untouched. SSE exclusion
// is asserted in ai.int.test.ts (the streaming success test), where the
// fixture-CLI env it needs already exists.
//
// NOTE: `app.request(...)` bypasses Node's HTTP client, so Accept-Encoding is
// never added implicitly — every request here sets (or omits) it explicitly,
// and compressed bodies arrive still-gzipped (no auto-decode). Decode via
// DecompressionStream.

import { describe, expect, it } from 'vitest';
import { app, env } from '../test/harness';
import { seededSession } from '../test/helpers';

const GZIP = { 'accept-encoding': 'gzip' };
const J = { 'content-type': 'application/json' };

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
    expect(await gunzipJson(compressed)).toEqual(plainBody);
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
    expect(res.headers.get('content-range')).toBe('bytes 3-4/5');
    expect(res.headers.get('content-length')).toBe('2');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([4, 5]));
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
    expect(await gunzipText(jsonl)).toBe(plainJsonlText);
  });
});
