// CLI: merge a session's recorded audio segments into one WebM file.
//
//   npm run merge-audio -w server -- <sessionId> [--data-dir <dir>] [--out <file>]
//
// Reads segment order from the session DB (DATA_DIR/sessions/<id>.db), maps
// each row's r2_key to its blob under DATA_DIR/blobs/, and packet-copies the
// Opus streams into a single WebM via src/node/audioMerge.ts. Read-only over
// server state; the merged file is written outside the blob store.

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { mergeAudioFiles } from '../src/node/audioMerge';

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const positional: string[] = [];
let dataDirArg: string | undefined;
let outArg: string | undefined;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--data-dir') dataDirArg = args[++i];
  else if (args[i] === '--out') outArg = args[++i];
  else if (args[i].startsWith('--')) fail(`unknown flag ${args[i]}`);
  else positional.push(args[i]);
}
const sessionId = positional[0];
if (!sessionId || positional.length > 1) {
  console.error(
    'usage: npm run merge-audio -w server -- <sessionId> [--data-dir <dir>] [--out <file>]',
  );
  process.exit(2);
}

// Same default the server uses (./data relative to the server package).
const dataDir = resolve(
  dataDirArg ?? process.env.DATA_DIR ?? join(import.meta.dirname, '..', 'data'),
);
const dbPath = join(dataDir, 'sessions', `${sessionId}.db`);
if (!existsSync(dbPath)) fail(`no session DB at ${dbPath}`);

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
let rows: Array<{ ordinal: number; r2_key: string }>;
try {
  rows = db
    .prepare('SELECT ordinal, r2_key FROM session_audio_segments ORDER BY ordinal ASC')
    .all() as Array<{ ordinal: number; r2_key: string }>;
} finally {
  db.close();
}
if (rows.length === 0) fail(`session ${sessionId} has no audio segments`);

const inputs: string[] = [];
for (const row of rows) {
  const blobPath = join(dataDir, 'blobs', row.r2_key);
  if (!existsSync(blobPath)) {
    console.warn(`warning: skipping segment ${row.ordinal} — missing blob ${blobPath}`);
    continue;
  }
  inputs.push(blobPath);
}
if (inputs.length === 0) fail('all segment blobs are missing');

const outPath = resolve(outArg ?? `${sessionId}-merged.webm`);
mkdirSync(dirname(outPath), { recursive: true });

const result = await mergeAudioFiles(inputs, outPath);
console.log(
  `merged ${result.files} segment(s), ${result.packets} packets, ` +
    `${result.durationSeconds.toFixed(2)}s -> ${outPath}`,
);
