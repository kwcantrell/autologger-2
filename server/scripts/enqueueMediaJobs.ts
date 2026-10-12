// CLI: enqueue media-worker jobs for existing segments (OpenSpec change `media-worker`, design D5,
// D6).
//
//   npx tsx server/scripts/enqueueMediaJobs.ts            > ingest.sql
//   npx tsx server/scripts/enqueueMediaJobs.ts --merge    > merge.sql
//
// New segments get their `ingest` job when they are stored. Rows that predate the media worker
// (legacy imports, recordings chunked before it) are processed only when an operator enqueues them:
// - default: one `ingest` job per segment with NULL peaks, NULL `duration_ms` or a WAV mime, so the
//   worker computes the peaks and the duration and converts 16/24-bit WAVs to FLAC (the same work as
//   `backfillWaveforms.ts` and `convertWavToFlac.ts`, which stay as offline tools);
// - `--merge`: one `merge` job per recording with two or more segments, rows with a NULL
//   `media_status` included. This is the only path that merges a recording chunked before the
//   media worker (owner answer 1); the server's reconcile never does.
//
// The output is set-based SQL for psql (`-v ON_ERROR_STOP=1`): one transaction of
// `INSERT … SELECT … ON CONFLICT DO NOTHING` on the live-job index, so a re-run, or a job a segment
// already has, adds nothing. It names no id, key or other row value. The jobs declare
// `input_bytes` = the largest upload (1500 MiB): the script does not read the blob volume, so
// every backfill job runs in the worker's big lane and a live chunk's waveform never waits behind
// one. The worker picks them up on its 5 s poll. Exit 0, or 2 on a usage error.

import { fileURLToPath } from 'node:url';
import { MEDIA_JOB_MAX_ATTEMPTS, UPLOAD_MAX_BYTES } from '@autologger/storage/mediaLimits';

export interface EnqueueOptions {
  merge: boolean;
}

export function parseArgs(argv: readonly string[]): EnqueueOptions {
  const opts: EnqueueOptions = { merge: false };
  for (const a of argv) {
    if (a === '--merge') opts.merge = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

const NOW_MS = '(extract(epoch from clock_timestamp()) * 1000)::bigint';
const COLUMNS =
  'id, kind, session_id, target, status, attempts, max_attempts, input_bytes, run_after_ms, created_at_ms, updated_at_ms';
const ON_CONFLICT =
  "on conflict (kind, session_id, target) where status in ('queued', 'running', 'done') do nothing";

/** The statements, in order (no values: every row comes from the SELECT). */
export function enqueueStatements(opts: EnqueueOptions): string[] {
  const common = `'queued', 0, ${MEDIA_JOB_MAX_ATTEMPTS}, ${UPLOAD_MAX_BYTES}, ${NOW_MS}, ${NOW_MS}, ${NOW_MS}`;
  if (opts.merge) {
    return [
      `insert into catalog.media_jobs (${COLUMNS})
select gen_random_uuid()::text, 'merge', s.session_id, s.recording_ordinal::text, ${common}
  from catalog.session_audio_segments s
 where s.recording_ordinal is not null
 group by s.session_id, s.recording_ordinal
having count(*) >= 2
${ON_CONFLICT};`,
    ];
  }
  return [
    `insert into catalog.media_jobs (${COLUMNS})
select gen_random_uuid()::text, 'ingest', s.session_id, s.id, ${common}
  from catalog.session_audio_segments s
 where s.waveform_peaks_json is null
    or s.duration_ms is null
    or lower(s.mime_type) like '%wav%'
${ON_CONFLICT};`,
  ];
}

export function renderSql(statements: readonly string[]): string {
  return `begin;\n${statements.join('\n')}\ncommit;\n`;
}

function main(argv: readonly string[]): number {
  let opts: EnqueueOptions;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\nusage: enqueueMediaJobs.ts [--merge]\n`);
    return 2;
  }
  process.stdout.write(renderSql(enqueueStatements(opts)));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
