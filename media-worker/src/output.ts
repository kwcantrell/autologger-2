// The worker's only writable place: `BLOB_DIR/media/<job id>/` (media-worker design D3, D4). The
// API creates `media/` sticky and world-writable (1777) at boot; the worker creates its job
// directory there and chmods it 0777 (the umask strips mkdir's mode), so the API, which owns
// neither the directory nor its files, can still remove them after adopting by copy (spike 0.1).
// Files the worker writes are 0644. Nothing here ever touches `audio/`, `.tmp/` or `.trash/`.

import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyOpened, type Prepared } from './decode';
import { JobFailure } from './jobs/types';

const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** `media/<job id>` (the key prefix a result may name). */
export function jobDirKey(jobId: string): string {
  if (!JOB_ID_RE.test(jobId)) throw new JobFailure('internal', 'job id is not a plain name', true);
  return `media/${jobId}`;
}

/** A result key `media/<job id>/<name>` with one plain name. */
export function resultKey(jobId: string, name: string): string {
  if (!NAME_RE.test(name)) throw new JobFailure('internal', 'output name is not plain', true);
  return `${jobDirKey(jobId)}/${name}`;
}

/** `<base>-a<attempt>.<ext>`: every attempt of a job writes its own names in the shared job
 * directory, so an attempt whose lease was lost never touches the re-claimer's files (W.8). */
export function attemptName(base: string, attempt: number, ext: string): string {
  const name = `${base}-a${attempt}.${ext}`;
  if (!Number.isSafeInteger(attempt) || attempt < 0 || !NAME_RE.test(name) || name.includes('..')) {
    throw new JobFailure('internal', 'output name is not plain', true);
  }
  return name;
}

/** This attempt's scratch directory inside the job directory (mergeAudioSegments' outDir). */
export function scratchDir(attempt: number): string {
  return `a${attempt}.tmp`;
}

/** Ensures `media/<job id>/` exists with mode 0777. Never removes anything: another attempt
 * (after a lease expiry) may be writing there. */
export async function makeJobDir(blobDir: string, jobId: string): Promise<string> {
  const media = join(blobDir, 'media');
  const st = await lstat(media).catch(() => null);
  if (!st?.isDirectory())
    throw new JobFailure('internal', 'media/ is missing (the API creates it at boot)');
  const dir = join(blobDir, jobDirKey(jobId));
  try {
    await mkdir(dir, { mode: 0o777 });
    await chmod(dir, 0o777);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const old = await lstat(dir);
    if (!old.isDirectory()) throw new JobFailure('internal', 'job path is not a directory');
  }
  return dir;
}

/** Removes only this attempt's outputs (`*-a<attempt>.*`) and scratch; the shared directory and
 * other attempts' files stay (the API's sweep removes directories of jobs no longer live). */
export async function removeAttemptFiles(
  blobDir: string,
  jobId: string,
  attempt: number,
): Promise<void> {
  const dir = join(blobDir, jobDirKey(jobId));
  const st = await lstat(dir).catch(() => null);
  if (!st?.isDirectory()) return;
  const mine = new RegExp(`-a${attempt}\\.[A-Za-z0-9]+$`);
  for (const name of await readdir(dir)) {
    if (name === scratchDir(attempt) || mine.test(name)) {
      await rm(join(dir, name), { recursive: true, force: true });
    }
  }
}

/** Opens a file the worker wrote in its job directory (O_NOFOLLOW, regular file) and sniffs it. */
export async function openOwn(jobDirAbs: string, name: string): Promise<Prepared> {
  if (!NAME_RE.test(name)) throw new JobFailure('internal', 'output name is not plain', true);
  const path = join(jobDirAbs, name);
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const st = await fd.stat();
  if (!st.isFile()) {
    await fd.close();
    throw new JobFailure('internal', 'output is not a regular file');
  }
  return classifyOpened(
    { fd, size: st.size, path, fdPath: `/proc/self/fd/${fd.fd}`, close: () => fd.close() },
    name,
  );
}
