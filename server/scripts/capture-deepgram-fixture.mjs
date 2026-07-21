// One-time operator script (persist-deepgram-enrichment, design D7): sends the
// committed CC0/public-domain audio clip to DeepGram's real `/v1/listen`
// endpoint with the app's exact request params, and writes the raw JSON
// response to server/src/test/fixtures/deepgram-enrichment-response.json.
//
//   npm run capture:deepgram-fixture -w server
//
// Reads DEEPGRAM_API_KEY / DEEPGRAM_MODEL from gitignored server/.env via
// Node's --env-file-if-exists (same mechanism server/package.json's dev/start
// scripts use) — the key is never hardcoded or passed on the command line.
// This script is deliberately NOT wired into `npm test` and lives under
// scripts/, outside src/**, so vitest's `src/**/*.test.ts` /
// `src/**/*.int.test.ts` include globs never pick it up: running it costs a
// real, billed DeepGram request and mutates the committed fixture, so it is
// run once by a human operator, not automatically.
//
// Params mirror server/src/node/deepgram.ts `transcribeGroup` exactly
// (model, language=en, sentiment, smart_format, diarize, paragraphs) so the
// captured response matches what extractEnrichment/extractWords will parse.
// The API key goes only in the Authorization header, never a query param or
// logged output (same posture as transcribeGroup).

import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const DEEPGRAM_LISTEN_URL = 'https://api.deepgram.com/v1/listen';

const scriptDir = import.meta.dirname;
const audioPath = join(
  scriptDir,
  '..',
  'src',
  'test',
  'fixtures',
  'audio',
  'deepgram-enrichment-source.mp3',
);
const outPath = join(
  scriptDir,
  '..',
  'src',
  'test',
  'fixtures',
  'deepgram-enrichment-response.json',
);
// The committed clip is an MP3 (see the sibling .source.txt for provenance);
// Content-Type must match its container, mirroring contentTypeForFamily()'s
// role in transcribeGroup.
const CONTENT_TYPE = 'audio/mpeg';

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const apiKey = (process.env.DEEPGRAM_API_KEY || '').trim();
if (!apiKey) {
  fail(
    'DEEPGRAM_API_KEY is not set. Put it in gitignored server/.env and run via ' +
      '`npm run capture:deepgram-fixture -w server` (loads server/.env with --env-file-if-exists).',
  );
}
const model = (process.env.DEEPGRAM_MODEL || '').trim() || 'nova-3';

const url = new URL(DEEPGRAM_LISTEN_URL);
url.searchParams.set('model', model);
url.searchParams.set('language', 'en');
url.searchParams.set('sentiment', 'true');
url.searchParams.set('smart_format', 'true');
url.searchParams.set('diarize', 'true');
url.searchParams.set('paragraphs', 'true');

console.log(`Sending ${audioPath} to DeepGram (model=${model})...`);

let res;
try {
  res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': CONTENT_TYPE,
    },
    body: createReadStream(audioPath),
    duplex: 'half',
  });
} catch (err) {
  fail(`DeepGram request failed or timed out: ${err instanceof Error ? err.message : err}`);
}

if (!res.ok) {
  const detail = await res.text().catch(() => '');
  fail(`DeepGram upstream request failed (status ${res.status}). ${detail}`.trim());
}

let body;
try {
  body = await res.json();
} catch (err) {
  fail(`DeepGram returned an unparseable response: ${err instanceof Error ? err.message : err}`);
}

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');

console.log(`Wrote ${outPath}`);
