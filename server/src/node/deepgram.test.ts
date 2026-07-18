// Unit tests for the DeepGram pre-recorded transcription client. `fetch` is
// mocked (vi.stubGlobal) — no real network/provider calls.

import { Agent } from 'undici';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  contentTypeForFamily,
  DeepgramUpstreamError,
  PROVIDER_TIMEOUT_MS,
  transcribeGroup,
} from './deepgram';

function deepgramResponse(words: unknown[]) {
  return {
    results: { channels: [{ alternatives: [{ words }] }] },
  };
}

/** A real HTTP client reads the request body stream to send it. Our fixture
 * lives only for the test run, so the mock drains the stream the same way —
 * otherwise `createReadStream`'s deferred, unconsumed open can fire an
 * unlistened 'error' event after the fixture is gone. */
function mockFetch(respond: () => Response) {
  return vi.fn(async (_url: URL, init?: RequestInit & { body?: NodeJS.ReadableStream }) => {
    const body = init?.body;
    if (body && typeof body.on === 'function') {
      await new Promise<void>((resolve, reject) => {
        body.on('data', () => {});
        body.on('end', () => resolve());
        body.on('error', reject);
      });
    }
    return respond();
  });
}

// One fixture file shared across tests (not recreated per-test): the mocked
// `fetch` never actually consumes the request body stream the way a real
// HTTP client would, so `createReadStream`'s deferred open can fire after a
// per-test file is already gone, throwing an unhandled ENOENT. A real fetch
// implementation reads the stream (or surfaces its error) before resolving.
let dir: string;
let filePath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'deepgram-test-'));
  filePath = join(dir, 'group-0-opus.webm');
  writeFileSync(filePath, Buffer.from('fake audio bytes'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('contentTypeForFamily', () => {
  it('maps each codec family to the content type DeepGram expects', () => {
    expect(contentTypeForFamily('opus')).toBe('audio/webm');
    expect(contentTypeForFamily('aac')).toBe('audio/mp4');
    expect(contentTypeForFamily('pcm')).toBe('audio/wav');
  });
});

describe('PROVIDER_TIMEOUT_MS', () => {
  it('is configured above DeepGram’s documented 10-minute processing ceiling', () => {
    expect(PROVIDER_TIMEOUT_MS).toBeGreaterThan(10 * 60 * 1000);
  });
});

describe('transcribeGroup', () => {
  it('requests diarize/smart_format/paragraphs/sentiment/language/model, key only in Authorization', async () => {
    const fetchMock = mockFetch(
      () => new Response(JSON.stringify(deepgramResponse([])), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await transcribeGroup({ outPath: filePath, family: 'opus', apiKey: 'secret-key-123', model: 'nova-3' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      URL,
      RequestInit & { dispatcher?: unknown },
    ];
    const requestUrl = url instanceof URL ? url : new URL(String(url));

    expect(requestUrl.origin + requestUrl.pathname).toBe('https://api.deepgram.com/v1/listen');
    expect(requestUrl.searchParams.get('model')).toBe('nova-3');
    expect(requestUrl.searchParams.get('diarize')).toBe('true');
    expect(requestUrl.searchParams.get('smart_format')).toBe('true');
    expect(requestUrl.searchParams.get('paragraphs')).toBe('true');
    expect(requestUrl.searchParams.get('sentiment')).toBe('true');
    expect(requestUrl.searchParams.get('language')).toBe('en');
    expect(requestUrl.searchParams.has('punctuate')).toBe(false);

    // Key must never appear in the URL/query string.
    expect(requestUrl.toString()).not.toContain('secret-key-123');

    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Token secret-key-123');
    expect(headers.get('Content-Type')).toBe('audio/webm');

    expect(init.dispatcher).toBeInstanceOf(Agent);
  });

  it('extracts punctuated_word falling back to word, start/end/speaker, from channel 0 only', async () => {
    const fetchMock = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            results: {
              channels: [
                {
                  alternatives: [
                    {
                      words: [
                        { word: 'hello', punctuated_word: 'Hello,', start: 0.08, end: 0.32, speaker: 1 },
                        { word: 'world', start: 0.4, end: 0.6, speaker: 1 },
                      ],
                    },
                  ],
                },
                // A second channel that must be ignored (multichannel not requested).
                { alternatives: [{ words: [{ word: 'ignored', start: 0, end: 1, speaker: 9 }] }] },
              ],
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const words = await transcribeGroup({
      outPath: filePath,
      family: 'aac',
      apiKey: 'k',
      model: 'nova-3',
    });

    expect(words).toEqual([
      { word: 'Hello,', start: 0.08, end: 0.32, speaker: 1 },
      { word: 'world', start: 0.4, end: 0.6, speaker: 1 },
    ]);
  });

  it('maps a non-2xx response to a generic DeepgramUpstreamError without the upstream body or key', async () => {
    const secretLookingBody = 'Authorization: Token secret-key-123 rejected — invalid credentials';
    const fetchMock = mockFetch(() => new Response(secretLookingBody, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      transcribeGroup({ outPath: filePath, family: 'opus', apiKey: 'secret-key-123', model: 'nova-3' }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(DeepgramUpstreamError);
      const message = (err as Error).message;
      expect(message).not.toContain(secretLookingBody);
      expect(message).not.toContain('secret-key-123');
      expect(message).toContain('401');
      return true;
    });
  });

  it('maps a fetch rejection (e.g. timeout) to a generic DeepgramUpstreamError', async () => {
    const fetchMock = mockFetch(() => {
      throw new Error('UND_ERR_HEADERS_TIMEOUT');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      transcribeGroup({ outPath: filePath, family: 'pcm', apiKey: 'k', model: 'nova-3' }),
    ).rejects.toBeInstanceOf(DeepgramUpstreamError);
  });

  it('maps a response with no transcript words to a DeepgramUpstreamError', async () => {
    const fetchMock = mockFetch(() => new Response(JSON.stringify({ results: {} }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      transcribeGroup({ outPath: filePath, family: 'opus', apiKey: 'k', model: 'nova-3' }),
    ).rejects.toBeInstanceOf(DeepgramUpstreamError);
  });
});
