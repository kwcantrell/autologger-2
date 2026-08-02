// DeepGram pre-recorded transcription client (server/src/node — Node-specific
// infrastructure). Streams a spooled group file (an audioMerge.ts MergedGroup
// output — never buffered whole in memory) to DeepGram's /v1/listen endpoint
// with diarization, smart formatting, sentiment, and paragraphs enabled;
// extracts `{word, start, end, speaker}` from the first/only channel's
// transcript.
//
// Security posture (design D7): the API key is sent ONLY in the
// `Authorization` header — never a query param, so it cannot leak into logs
// or error messages that stringify a URL. Upstream failures are summarized
// (status code + generic detail) and never include the verbatim response
// body, which could otherwise echo back request details.
//
// DeepGram's documented batch-processing ceiling is ~10 minutes; undici's
// default `headersTimeout`/`bodyTimeout` (300s) is below that, so requests go
// through a dedicated undici `Agent` with both timeouts raised above the
// provider ceiling (design D3) instead of relying on Node's global dispatcher.

import { createReadStream } from 'node:fs';
import { Agent } from 'undici';
import type { CodecFamily } from './audioMerge';

const DEEPGRAM_LISTEN_URL = 'https://api.deepgram.com/v1/listen';

const CONTENT_TYPE_BY_FAMILY: Record<CodecFamily, string> = {
  opus: 'audio/webm',
  aac: 'audio/mp4',
  pcm: 'audio/wav',
  mp3: 'audio/mpeg',
};

/** Content type per codec family — the concat module's `MergedGroup` doesn't
 * carry one (family/extension already imply it), so callers derive it here. */
export function contentTypeForFamily(family: CodecFamily): string {
  return CONTENT_TYPE_BY_FAMILY[family];
}

/** DeepGram's documented pre-recorded processing ceiling is 10 minutes;
 * undici's 300s default headersTimeout/bodyTimeout is insufficient, so the
 * provider call's dispatcher raises both above the ceiling (design D3). */
export const PROVIDER_TIMEOUT_MS = 11 * 60 * 1000;

let sharedDispatcher: Agent | undefined;

/** Lazily-created, process-wide dispatcher with timeouts raised above
 * DeepGram's 10-minute processing ceiling. Exported for tests only. */
export function providerDispatcher(): Agent {
  sharedDispatcher ??= new Agent({
    headersTimeout: PROVIDER_TIMEOUT_MS,
    bodyTimeout: PROVIDER_TIMEOUT_MS,
  });
  return sharedDispatcher;
}

/** A typed upstream failure. `message` is always a generic summary (status
 * code, timeout, or parse failure) — it MUST NEVER embed the verbatim
 * upstream response body or the API key. */
export class DeepgramUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeepgramUpstreamError';
  }
}

export interface DeepgramWord {
  word: string;
  start: number;
  end: number;
  speaker: number;
}

/** A group-local paragraph, read from
 * `results.channels[0].alternatives[0].paragraphs.paragraphs[]` (design D1).
 * `text` is the paragraph's `sentences[].text` joined with a space. */
export interface DeepgramParagraph {
  speaker: number;
  start: number;
  end: number;
  text: string;
}

/** A group-local sentiment segment, read from the **top-level**
 * `results.sentiments.segments[]` (design D1). `start_word`/`end_word` index
 * into that same group's word array. The per-request `average` is
 * deliberately never captured (design D8). */
export interface DeepgramSentimentSegment {
  text: string;
  start_word: number;
  end_word: number;
  sentiment: string;
  sentiment_score: number;
}

/** A group's transcription result: words plus its paragraph/sentiment
 * enrichment, all indexed/timed relative to that group's own file — the
 * caller (remap layer) resolves them onto the session timeline. */
export interface TranscribeGroupResult {
  words: DeepgramWord[];
  paragraphs: DeepgramParagraph[];
  sentiments: DeepgramSentimentSegment[];
}

export interface TranscribeGroupParams {
  /** Path to a spooled group file (e.g. a `MergedGroup.outPath`). */
  outPath: string;
  family: CodecFamily;
  apiKey: string;
  model: string;
}

interface DeepgramResponseWord {
  word?: string;
  punctuated_word?: string;
  start?: number;
  end?: number;
  speaker?: number;
}

interface DeepgramListenResponse {
  results?: {
    channels?: Array<{
      alternatives?: Array<{
        words?: DeepgramResponseWord[];
      }>;
    }>;
  };
}

// `@types/node`'s bundled `RequestInit.dispatcher` type comes from its own
// vendored `undici-types`, a structurally-near-identical but not
// type-identical copy of the `undici` package's `Dispatcher`/`Agent` (version
// skew between the two type sources, not a real incompatibility at runtime —
// Node's global `fetch` is undici itself). The cast below bridges that.
type FetchDispatcher = NonNullable<RequestInit['dispatcher']>;

/** Send one group file to DeepGram's pre-recorded API and return its words.
 * Sets `diarize=true`, `smart_format=true` (implies punctuation, so
 * `punctuated_word` stays populated), `paragraphs=true`, `sentiment=true`,
 * `language=en`, and the configured `model` (spec: "Word content, ordering,
 * and provider parameters"). The request body streams
 * from disk (never buffered whole). The API key goes only in the
 * `Authorization` header. Non-2xx responses and network/timeout failures
 * both map to `DeepgramUpstreamError` with a generic detail — never the
 * upstream body or the key. */
export async function transcribeGroup(
  params: TranscribeGroupParams,
): Promise<TranscribeGroupResult> {
  const { outPath, family, apiKey, model } = params;
  const url = new URL(DEEPGRAM_LISTEN_URL);
  url.searchParams.set('model', model);
  url.searchParams.set('language', 'en');
  url.searchParams.set('sentiment', 'true');
  url.searchParams.set('smart_format', 'true');
  url.searchParams.set('diarize', 'true');
  url.searchParams.set('paragraphs', 'true');

  const init: RequestInit = {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': contentTypeForFamily(family),
    },
    body: createReadStream(outPath),
    duplex: 'half',
    dispatcher: providerDispatcher() as unknown as FetchDispatcher,
  };

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    // Covers network failures and dispatcher timeouts alike — the underlying
    // error's message is not trusted verbatim (it can vary by platform/lib
    // and is not documented not to include request details).
    throw new DeepgramUpstreamError('DeepGram request failed or timed out.');
  }

  if (!res.ok) {
    // Deliberately does not read/echo the response body.
    throw new DeepgramUpstreamError(`DeepGram upstream request failed (status ${res.status}).`);
  }

  let body: DeepgramListenResponse;
  try {
    body = (await res.json()) as DeepgramListenResponse;
  } catch {
    throw new DeepgramUpstreamError('DeepGram returned an unparseable response.');
  }

  const words = extractWords(body);
  const { paragraphs, sentiments } = extractEnrichment(body);
  return { words, paragraphs, sentiments };
}

/** Words come from the first/only channel's first alternative — DeepGram's
 * multichannel mode is never requested, so exactly one channel is expected. */
function extractWords(body: DeepgramListenResponse): DeepgramWord[] {
  const words = body.results?.channels?.[0]?.alternatives?.[0]?.words;
  if (!Array.isArray(words)) {
    throw new DeepgramUpstreamError('DeepGram response did not contain transcript words.');
  }
  return words.map((w) => ({
    word: w.punctuated_word ?? w.word ?? '',
    start: Number(w.start ?? 0),
    end: Number(w.end ?? 0),
    speaker: Number(w.speaker ?? 0),
  }));
}

/** Narrows to a plain object we can index defensively; anything else
 * (including `null`) yields `undefined` rather than throwing. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/** Group-local paragraphs from `results.channels[0].alternatives[0].paragraphs.paragraphs[]`
 * (design D1). A paragraph whose `start`/`end` doesn't coerce to a real
 * number (missing or malformed) is dropped — those fields are load-bearing
 * for the remap layer, so a partial paragraph is never persisted (spec:
 * "SHALL be treated as absent, never persisted"). `speaker` is not part of
 * that NaN-drop set and defaults to 0, mirroring `extractWords`. Missing or
 * non-array `sentences` yields empty text rather than dropping the
 * paragraph. */
function extractParagraphs(body: unknown): DeepgramParagraph[] {
  const channels = asRecord(asRecord(body)?.results)?.channels;
  const channel0 = Array.isArray(channels) ? asRecord(channels[0]) : undefined;
  const alternatives = channel0?.alternatives;
  const alt0 = Array.isArray(alternatives) ? asRecord(alternatives[0]) : undefined;
  const rawParagraphs = asRecord(alt0?.paragraphs)?.paragraphs;
  if (!Array.isArray(rawParagraphs)) return [];

  const out: DeepgramParagraph[] = [];
  for (const raw of rawParagraphs) {
    const p = asRecord(raw);
    if (!p) continue;
    const start = Number(p.start);
    const end = Number(p.end);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const rawSentences = p.sentences;
    const sentences = Array.isArray(rawSentences) ? rawSentences : [];
    const text = sentences
      .map((s) => {
        const sentence = asRecord(s);
        return typeof sentence?.text === 'string' ? sentence.text : '';
      })
      .join(' ');
    out.push({ speaker: Number(p.speaker ?? 0), start, end, text });
  }
  return out;
}

/** Group-local sentiment segments from the **top-level**
 * `results.sentiments.segments[]` (design D1 — not under `channels[]`). A
 * segment whose `start_word`/`end_word`/`sentiment_score` doesn't coerce to
 * a real number is dropped (spec: "SHALL be treated as absent, never
 * persisted"); those indices are load-bearing for the remap layer. The
 * per-request `average` is deliberately never read (design D8). */
function extractSentiments(body: unknown): DeepgramSentimentSegment[] {
  const rawSegments = asRecord(asRecord(asRecord(body)?.results)?.sentiments)?.segments;
  if (!Array.isArray(rawSegments)) return [];

  const out: DeepgramSentimentSegment[] = [];
  for (const raw of rawSegments) {
    const s = asRecord(raw);
    if (!s) continue;
    const start_word = Number(s.start_word);
    const end_word = Number(s.end_word);
    const sentiment_score = Number(s.sentiment_score);
    if (Number.isNaN(start_word) || Number.isNaN(end_word) || Number.isNaN(sentiment_score)) {
      continue;
    }
    out.push({
      text: typeof s.text === 'string' ? s.text : '',
      start_word,
      end_word,
      sentiment: typeof s.sentiment === 'string' ? s.sentiment : '',
      sentiment_score,
    });
  }
  return out;
}

/** Pure extraction of the DeepGram paragraph + sentiment enrichment
 * `transcribeGroup` already requests but previously discarded (spec:
 * "Enrichment capture from the provider response"). Mirrors `extractWords`'
 * tolerance: missing/malformed containers yield empty arrays and this never
 * throws. Takes `unknown` (not the narrower response type `extractWords`
 * uses) so it tolerates arbitrarily malformed provider bodies at the type
 * level too. */
export function extractEnrichment(body: unknown): {
  paragraphs: DeepgramParagraph[];
  sentiments: DeepgramSentimentSegment[];
} {
  return { paragraphs: extractParagraphs(body), sentiments: extractSentiments(body) };
}
