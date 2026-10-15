// Real-ffmpeg test support (the #107 convention): `MEDIA_WORKER_TEST_FFMPEG` or `ffmpeg` on PATH,
// else the pinned image through docker when it is already pulled (`docker pull <pin>`), run as the
// caller's uid with `--network none` and the test scratch root mounted at the same path (so the
// `file:` exception and FLAC outputs resolve); `null` when neither exists (tests skip).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '../../..');

/** The pin from docker/media-worker.Dockerfile (the single owner, D13). */
export function pinnedFfmpegImage(): string {
  const text = readFileSync(join(REPO, 'docker/media-worker.Dockerfile'), 'utf8');
  const m = text.match(/^ARG FFMPEG_IMAGE=(\S+)$/m);
  if (!m) throw new Error('no ARG FFMPEG_IMAGE in docker/media-worker.Dockerfile');
  return m[1];
}

/** A scratch root under which every test file lives (mounted into the docker wrapper). */
export const SCRATCH_ROOT = mkdtempSync(join(tmpdir(), 'mw-ffmpeg-'));

function pick(): string | null {
  const env = (process.env.MEDIA_WORKER_TEST_FFMPEG || '').trim();
  if (env && spawnSync(env, ['-version']).status === 0) return env;
  if (spawnSync('ffmpeg', ['-version']).status === 0) return 'ffmpeg';
  const image = pinnedFfmpegImage();
  if (spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status !== 0)
    return null;
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const wrapper = join(SCRATCH_ROOT, 'ffmpeg-docker.sh');
  writeFileSync(
    wrapper,
    `#!/bin/sh\nexec docker run -i --rm --network none --user ${uid}:${gid} --entrypoint /usr/local/bin/ffmpeg -v '${SCRATCH_ROOT}:${SCRATCH_ROOT}' '${image}' "$@"\n`,
    { mode: 0o755 },
  );
  return wrapper;
}

export const FFMPEG: string | null = pick();

export const TRANSCRIPTION_FIXTURES = join(REPO, 'packages/transcription/fixtures/audio');
