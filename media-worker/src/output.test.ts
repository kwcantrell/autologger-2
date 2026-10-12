// The job directory is shared by every attempt of a job; an attempt only ever creates or removes
// its own files (implementation panel, W.8): a lease lost to a database outage must not wipe the
// re-claimer's output.

import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attemptName, makeJobDir, removeAttemptFiles, scratchDir } from './output';

let blobDir: string;
const JOB = '0b6c1f9e-1d0a-4c2e-9a51-3f2d1c0b9a8e';
beforeEach(async () => {
  blobDir = join(await mkdtemp(join(tmpdir(), 'mw-out-')), 'blobs');
  await mkdir(join(blobDir, 'media'), { recursive: true });
});
afterEach(async () => {
  await rm(join(blobDir, '..'), { recursive: true, force: true });
});

describe('per-attempt outputs', () => {
  it('attemptName tags a base name with the attempt', () => {
    expect(attemptName('merged', 3, 'webm')).toBe('merged-a3.webm');
    expect(() => attemptName('../x', 1, 'webm')).toThrow();
  });

  it('makeJobDir keeps what another attempt already wrote (no rm on re-claim), mode 0777', async () => {
    const dir = await makeJobDir(blobDir, JOB);
    await writeFile(join(dir, 'merged-a1.webm'), 'attempt 1');
    expect(await makeJobDir(blobDir, JOB)).toBe(dir);
    expect(await readdir(dir)).toEqual(['merged-a1.webm']);
    expect((await stat(dir)).mode & 0o777).toBe(0o777);
  });

  it('removeAttemptFiles removes only that attempt’s files and scratch, never the shared dir', async () => {
    const dir = await makeJobDir(blobDir, JOB);
    await writeFile(join(dir, 'merged-a1.webm'), '1');
    await writeFile(join(dir, 'converted-a1.flac'), '1');
    await mkdir(join(dir, scratchDir(1)));
    await writeFile(join(dir, scratchDir(1), 'group-0-opus.webm'), '1');
    await writeFile(join(dir, 'merged-a2.webm'), '2');
    await mkdir(join(dir, scratchDir(2)));
    await writeFile(join(dir, 'merged-a11.webm'), '11');
    await removeAttemptFiles(blobDir, JOB, 1);
    expect((await readdir(dir)).sort()).toEqual(['a2.tmp', 'merged-a11.webm', 'merged-a2.webm']);
    await removeAttemptFiles(blobDir, JOB, 2);
    await removeAttemptFiles(blobDir, JOB, 11);
    expect(await readdir(dir)).toEqual([]);
    await removeAttemptFiles(blobDir, 'missing-job', 1); // no directory: no error
  });
});
