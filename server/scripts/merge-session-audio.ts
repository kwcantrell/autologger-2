// CLI: merge a session's recorded audio segments into one group file per
// probed codec family.
//
//   npm run merge-audio -w server -- <sessionId> [--data-dir <dir>] [--out <dir>]
//
// Run it in the dev stack (`make dev-shell`, then `cd server`), with `--out /tmp/<name>` so the
// output stays off the data volume; copy it out with `docker cp`. DATA_DIR (or --data-dir) is
// required: there is no default data directory (retire-host-dev D3). The process's PG* settings
// name the database (the dev shell has them).
//
// Reads segment order from the session's rows in `catalog.session_audio_segments` (one read-only
// snapshot through the Postgres session adapter, session-tables D10), maps
// each row's r2_key to its blob under DATA_DIR/blobs/, and packet-copies each
// codec-family run into its own container (Opus->WebM, AAC->MP4, PCM->WAVE)
// via @autologger/transcription's audioMerge.ts. Read-only over server state; the merged files
// are written outside the blob store.

import { PostgresCatalogDb, PostgresSessionDb } from '@autologger/storage';
import { mergeAudioSegments } from '@autologger/transcription';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CATALOG_PG_VARS } from '../src/bootGuard';

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
    'usage: npm run merge-audio -w server -- <sessionId> [--data-dir <dir>] [--out <dir>]',
  );
  process.exit(2);
}

const dataDirIn = dataDirArg ?? process.env.DATA_DIR;
if (!dataDirIn) fail('set DATA_DIR or pass --data-dir (there is no default data directory)');
const dataDir = resolve(dataDirIn);
const missingPg = CATALOG_PG_VARS.filter((k) => !process.env[k]);
if (missingPg.length) fail(`database settings missing: ${missingPg.join(', ')}`);

const catalogDb = new PostgresCatalogDb({
  host: process.env.PGHOST as string,
  port: Number(process.env.PGPORT),
  user: process.env.PGUSER as string,
  password: process.env.PGPASSWORD as string,
  database: process.env.PGDATABASE as string,
});
let rows: Array<{ ordinal: number; r2_key: string }>;
try {
  // The session hub's system binding (session-tables D2): the script reads what the hub stores.
  rows = await new PostgresSessionDb(catalogDb.bindSystem('session-hub'))
    .forSession(sessionId)
    .snapshot((t) =>
      t.all<{ ordinal: number; r2_key: string }>(
        'SELECT ordinal, r2_key FROM session_audio_segments WHERE session_id = ? ORDER BY ordinal ASC, id ASC',
        sessionId,
      ),
    );
} finally {
  await catalogDb.close();
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

const outDir = resolve(outArg ?? `${sessionId}-merged`);

const { groups, skipped } = await mergeAudioSegments(inputs, outDir);
for (const s of skipped) console.warn(`warning: skipped ${s.path} — ${s.reason}`);
if (groups.length === 0) fail('no readable audio segments to merge');

for (const group of groups) {
  console.log(
    `[${group.family}] ${group.segments.length} segment(s), ${group.packets} packets, ` +
      `${group.durationSeconds.toFixed(2)}s -> ${group.outPath}`,
  );
}
