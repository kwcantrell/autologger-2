// Shared by the offline blob scripts (supabase-11a-legacy-import follow-ups B and C):
// backfillWaveforms.ts and convertWavToFlac.ts. The psql CSV export of segment rows, the
// `audio/<session_id>/<file>` key check inside the blob dir, SQL literals, the pinned ffmpeg
// image and an input-order worker pool.

import { lstatSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/** linuxserver/ffmpeg 9.0 (multi-arch index: amd64 + arm64), resolved 2026-10-11. */
export const FFMPEG_IMAGE =
  'linuxserver/ffmpeg:9.0-cli-ls84@sha256:a7182d4fe498feea393622b43513cfaecb3fd073dcd3c7f38e9d74a10a4e8702';

/** ffmpeg from the pinned image (`docker run --rm --network none`) or a local binary. */
export type Decoder = { kind: 'docker'; image: string } | { kind: 'binary'; path: string };

/** Ids and the key's file name: no quotes, slashes or spaces; never starts with `.` or `-`. */
export const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,254}$/;

export interface SegmentRow {
  session_id: string;
  id: string;
  r2_key: string;
}

const HEADER = ['session_id', 'id', 'r2_key'];

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let v = '';
      i += 1;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          v += '"';
          i += 2;
        } else if (line[i] === '"') {
          i += 1;
          break;
        } else v += line[i++];
      }
      out.push(v);
      i += 1; // the comma
    } else {
      const j = line.indexOf(',', i);
      const end = j < 0 ? line.length : j;
      out.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return out;
}

/** The psql export: a `session_id,id,r2_key` header, then one row per segment. */
export function parseSegmentsCsv(text: string): SegmentRow[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0 || splitCsvLine(lines[0]).join(',') !== HEADER.join(',')) {
    throw new Error(`segments CSV: the first line must be the header ${HEADER.join(',')}`);
  }
  const rows: SegmentRow[] = [];
  for (let n = 1; n < lines.length; n += 1) {
    if (lines[n] === '') continue;
    const f = splitCsvLine(lines[n]);
    if (f.length !== HEADER.length) throw new Error(`segments CSV line ${n + 1}: expected 3 fields`);
    rows.push({ session_id: f[0], id: f[1], r2_key: f[2] });
  }
  return rows;
}

/** Ids are NAME_RE and the key is exactly `audio/<session_id>/<NAME_RE file>`. */
export function validIds(row: SegmentRow): boolean {
  const parts = row.r2_key.split('/');
  return (
    NAME_RE.test(row.session_id) &&
    NAME_RE.test(row.id) &&
    parts.length === 3 &&
    parts[0] === 'audio' &&
    parts[1] === row.session_id &&
    NAME_RE.test(parts[2])
  );
}

export type SegmentCheck =
  | { kind: 'ok'; path: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'missing'; reason: string };

/** Key must be `audio/<session_id>/<file>`, resolve inside the blob dir (symlinks too), be a file. */
export function checkSegment(row: SegmentRow, blobDir: string): SegmentCheck {
  if (!validIds(row)) return { kind: 'invalid', reason: 'id or r2_key not audio/<session_id>/<file>' };
  const root = resolve(blobDir);
  const path = resolve(root, row.r2_key);
  if (!path.startsWith(root + sep)) return { kind: 'invalid', reason: 'r2_key escapes the blob dir' };
  try {
    lstatSync(path);
  } catch {
    return { kind: 'missing', reason: `no file at ${row.r2_key}` };
  }
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return { kind: 'missing', reason: `dangling link at ${row.r2_key}` };
  }
  if (!real.startsWith(realpathSync(root) + sep)) {
    return { kind: 'invalid', reason: 'r2_key resolves outside the blob dir' };
  }
  if (!statSync(real).isFile()) return { kind: 'invalid', reason: 'r2_key is not a regular file' };
  return { kind: 'ok', path };
}

/** A standard_conforming_strings SQL literal; callers only pass validated names. */
export const lit = (s: string): string => `'${s.replaceAll("'", "''")}'`;

/** Safe for a terminal line: printable ASCII only, truncated. */
export const printable = (s: string): string => s.replace(/[^\x20-\x7e]/g, '?').slice(0, 120);

export const MAX_JOBS = 64;

/** `--jobs` value: an integer 1..MAX_JOBS (default 1), or 0 for invalid. */
export function parseJobs(v: string | undefined): number {
  const jobs = v === undefined ? 1 : /^[1-9][0-9]*$/.test(v) ? Number(v) : 0;
  return jobs >= 1 && jobs <= MAX_JOBS ? jobs : 0;
}

/** Runs `one(0..count-1)` on `jobs` workers; results are the caller's, indexed by input row. */
export async function runPool(
  count: number,
  jobs: number,
  one: (idx: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < count) await one(next++);
  };
  await Promise.all(Array.from({ length: Math.min(jobs, count) }, worker));
}
