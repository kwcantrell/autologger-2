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

import { Agent } from 'undici';
import { createReadStream } from 'node:fs';
import type { CodecFamily } from './audioMerge';

const DEEPGRAM_LISTEN_URL = 'https://api.deepgram.com/v1/listen';

const CONTENT_TYPE_BY_FAMILY: Record<CodecFamily, string> = {
  opus: 'audio/webm',
  aac: 'audio/mp4',
  pcm: 'audio/wav',
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
export async function transcribeGroup(params: TranscribeGroupParams): Promise<DeepgramWord[]> {
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

  return extractWords(body);
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
