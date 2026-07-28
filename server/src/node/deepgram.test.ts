// Unit tests for the DeepGram pre-recorded transcription client. `fetch` is
// mocked (vi.stubGlobal) — no real network/provider calls.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from 'undici';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  contentTypeForFamily,
  DeepgramUpstreamError,
  extractEnrichment,
  PROVIDER_TIMEOUT_MS,
  transcribeGroup,
} from './deepgram';

// Real captured DeepGram response (design D7: record-once, replay-always).
// 89 words / 3 paragraphs / 3 sentiment segments (word spans 0-48, 49-61,
// 62-88), one neutral session average (average is NOT extracted — D8).
const enrichmentFixture = JSON.parse(
  readFileSync(
    join(__dirname, '..', 'test', 'fixtures', 'deepgram-enrichment-response.json'),
    'utf8',
  ),
);

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

    await transcribeGroup({
      outPath: filePath,
      family: 'opus',
      apiKey: 'secret-key-123',
      model: 'nova-3',
    });

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
                        {
                          word: 'hello',
                          punctuated_word: 'Hello,',
                          start: 0.08,
                          end: 0.32,
                          speaker: 1,
                        },
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

    const result = await transcribeGroup({
      outPath: filePath,
      family: 'aac',
      apiKey: 'k',
      model: 'nova-3',
    });

    expect(result.words).toEqual([
      { word: 'Hello,', start: 0.08, end: 0.32, speaker: 1 },
      { word: 'world', start: 0.4, end: 0.6, speaker: 1 },
    ]);
    // The real fixture's shape is exercised in extractEnrichment's own
    // describe block below; here just confirm the struct return is wired.
    expect(result.paragraphs).toEqual([]);
    expect(result.sentiments).toEqual([]);
  });

  it('maps a non-2xx response to a generic DeepgramUpstreamError without the upstream body or key', async () => {
    const secretLookingBody = 'Authorization: Token secret-key-123 rejected — invalid credentials';
    const fetchMock = mockFetch(() => new Response(secretLookingBody, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      transcribeGroup({
        outPath: filePath,
        family: 'opus',
        apiKey: 'secret-key-123',
        model: 'nova-3',
      }),
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
    const fetchMock = mockFetch(
      () => new Response(JSON.stringify({ results: {} }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      transcribeGroup({ outPath: filePath, family: 'opus', apiKey: 'k', model: 'nova-3' }),
    ).rejects.toBeInstanceOf(DeepgramUpstreamError);
  });
});

describe('extractEnrichment', () => {
  it('extracts paragraphs and sentiment segments from the real captured fixture', () => {
    const { paragraphs, sentiments } = extractEnrichment(enrichmentFixture);

    expect(paragraphs).toEqual([
      {
        speaker: 0,
        start: 1.28,
        end: 13.36,
        text:
          "Okay Houston, we've had a problem here. This is Houston, say again please. " +
          "Houston, we've had a problem. We've had a main beam on the vault. Roger main " +
          'beam on the vault.',
      },
      {
        speaker: 0,
        start: 15.465,
        end: 40.89,
        text:
          "Okay, stand by thirteen, we're looking at it. Okay, right now Houston, the " +
          'voltage is looking good. We had a pretty large bang associated with the ' +
          'caution and warning there. And as I recall, maybe it was the one that had a ' +
          'camp spike on it once before. Roger, Fred.',
      },
      {
        speaker: 0,
        start: 42.65,
        end: 46.33,
        text: "And the interim air, we're starting to",
      },
    ]);

    expect(sentiments).toEqual([
      {
        text:
          "Okay Houston, we've had a problem here. This is Houston, say again please. " +
          "Houston, we've had a problem. We've had a main beam on the vault. Roger main " +
          "beam on the vault. Okay, stand by thirteen, we're looking at it. Okay, right " +
          'now Houston, the voltage is looking good.',
        start_word: 0,
        end_word: 48,
        sentiment: 'neutral',
        sentiment_score: -0.03932914882898331,
      },
      {
        text: 'We had a pretty large bang associated with the caution and warning there.',
        start_word: 49,
        end_word: 61,
        sentiment: 'negative',
        sentiment_score: -0.3551284670829773,
      },
      {
        text:
          'And as I recall, maybe it was the one that had a camp spike on it once ' +
          "before. Roger, Fred. And the interim air, we're starting to",
        start_word: 62,
        end_word: 88,
        sentiment: 'neutral',
        sentiment_score: -0.14257504045963287,
      },
    ]);

    // D8: the per-request session average is never captured.
    expect(sentiments.every((s) => !('average' in s))).toBe(true);
  });

  it('returns empty arrays, never throws, for a body with no results at all', () => {
    expect(extractEnrichment({})).toEqual({ paragraphs: [], sentiments: [] });
  });

  it('returns empty paragraphs when the paragraphs container is absent', () => {
    const body = { results: { channels: [{ alternatives: [{ words: [] }] }] } };
    expect(extractEnrichment(body).paragraphs).toEqual([]);
  });

  it('returns empty paragraphs when paragraphs.paragraphs is not an array', () => {
    const body = {
      results: {
        channels: [{ alternatives: [{ words: [], paragraphs: { paragraphs: 'not-an-array' } }] }],
      },
    };
    expect(extractEnrichment(body).paragraphs).toEqual([]);
  });

  it('treats a missing/non-array sentences field as empty text, without dropping the paragraph', () => {
    const body = {
      results: {
        channels: [
          {
            alternatives: [
              {
                words: [],
                paragraphs: {
                  paragraphs: [
                    { speaker: 0, start: 1, end: 2 }, // no `sentences` at all
                    { speaker: 1, start: 3, end: 4, sentences: 'not-an-array' },
                  ],
                },
              },
            ],
          },
        ],
      },
    };
    expect(extractEnrichment(body).paragraphs).toEqual([
      { speaker: 0, start: 1, end: 2, text: '' },
      { speaker: 1, start: 3, end: 4, text: '' },
    ]);
  });

  it('drops a paragraph whose start or end is missing/non-numeric, but keeps the rest', () => {
    const body = {
      results: {
        channels: [
          {
            alternatives: [
              {
                words: [],
                paragraphs: {
                  paragraphs: [
                    { speaker: 0, start: 'not-a-number', end: 2, sentences: [{ text: 'a' }] },
                    { speaker: 0, end: 2, sentences: [{ text: 'b' }] }, // missing start
                    { speaker: 0, start: 5, end: 8, sentences: [{ text: 'kept' }] },
                  ],
                },
              },
            ],
          },
        ],
      },
    };
    expect(extractEnrichment(body).paragraphs).toEqual([
      { speaker: 0, start: 5, end: 8, text: 'kept' },
    ]);
  });

  it('defaults a paragraph missing speaker to 0 (speaker is not part of the NaN-drop set)', () => {
    const body = {
      results: {
        channels: [
          {
            alternatives: [
              {
                words: [],
                paragraphs: { paragraphs: [{ start: 1, end: 2, sentences: [{ text: 'x' }] }] },
              },
            ],
          },
        ],
      },
    };
    expect(extractEnrichment(body).paragraphs).toEqual([
      { speaker: 0, start: 1, end: 2, text: 'x' },
    ]);
  });

  it('returns empty sentiments when results.sentiments is absent', () => {
    const body = { results: { channels: [{ alternatives: [{ words: [] }] }] } };
    expect(extractEnrichment(body).sentiments).toEqual([]);
  });

  it('returns empty sentiments when results.sentiments.segments is not an array', () => {
    const body = { results: { sentiments: { segments: 'not-an-array' } } };
    expect(extractEnrichment(body).sentiments).toEqual([]);
  });

  it('drops a sentiment segment whose start_word/end_word/sentiment_score is missing/non-numeric', () => {
    const body = {
      results: {
        sentiments: {
          segments: [
            {
              text: 'a',
              start_word: 0,
              end_word: 5,
              sentiment: 'neutral',
              sentiment_score: 'oops',
            },
            { text: 'b', end_word: 5, sentiment: 'neutral', sentiment_score: 0.1 }, // missing start_word
            { text: 'c', start_word: 1, end_word: 'x', sentiment: 'neutral', sentiment_score: 0.1 },
            {
              text: 'kept',
              start_word: 2,
              end_word: 3,
              sentiment: 'positive',
              sentiment_score: 0.5,
            },
          ],
        },
      },
    };
    expect(extractEnrichment(body).sentiments).toEqual([
      { text: 'kept', start_word: 2, end_word: 3, sentiment: 'positive', sentiment_score: 0.5 },
    ]);
  });

  it('never throws on a completely empty or garbage body', () => {
    expect(() => extractEnrichment(null as never)).not.toThrow();
    expect(() => extractEnrichment(undefined as never)).not.toThrow();
    expect(extractEnrichment(undefined as never)).toEqual({ paragraphs: [], sentiments: [] });
  });
});
