// The ffmpeg pin has one owner (media-worker design D13, task W.5): `ARG FFMPEG_IMAGE=` in
// docker/media-worker.Dockerfile, with a `# reviewed YYYY-MM-DD` comment on the line above it (a
// Dockerfile ARG cannot carry a trailing comment: it would become part of the value). The
// operator scripts' constant (server/scripts/blobSegmentRows.ts `FFMPEG_IMAGE`) must equal it, so
// the scripts and the worker always run the same verified ffmpeg.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FFMPEG_IMAGE } from '../../scripts/blobSegmentRows';

const REPO = resolve(import.meta.dirname, '../../..');
const DOCKERFILE = resolve(REPO, 'docker/media-worker.Dockerfile');

/** The ARG's value and the comment line directly above it. */
function readFfmpegPin(text: string): { value: string; comment: string } | null {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => /^ARG FFMPEG_IMAGE=/.test(l));
  if (i < 0) return null;
  return { value: lines[i].slice('ARG FFMPEG_IMAGE='.length).trim(), comment: lines[i - 1] ?? '' };
}

const DIGEST_RE = /^linuxserver\/ffmpeg:[0-9A-Za-z._-]+@sha256:[0-9a-f]{64}$/;
const REVIEWED_RE =
  /^#.*# reviewed (\d{4})-(\d{2})-(\d{2})\s*$|^# reviewed (\d{4})-(\d{2})-(\d{2})\s*$/;

describe('ffmpeg pin (media-worker D13)', () => {
  const pin = readFfmpegPin(readFileSync(DOCKERFILE, 'utf8'));

  it('docker/media-worker.Dockerfile declares ARG FFMPEG_IMAGE pinned by digest', () => {
    expect(pin).not.toBeNull();
    expect(pin?.value).toMatch(DIGEST_RE);
  });

  it('the ARG carries a "# reviewed YYYY-MM-DD" comment on the line above, a real date', () => {
    const m = pin?.comment.match(REVIEWED_RE);
    expect(m, `comment above the ARG: ${pin?.comment}`).toBeTruthy();
    const [y, mo, d] = (m?.[1] ? m.slice(1, 4) : (m?.slice(4, 7) ?? [])).map(Number);
    const date = new Date(Date.UTC(y, mo - 1, d));
    expect(
      date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d,
    ).toBe(true);
  });

  it('the final stage is built FROM the pinned ffmpeg image', () => {
    const text = readFileSync(DOCKERFILE, 'utf8');
    expect(text).toMatch(/^FROM \$\{FFMPEG_IMAGE\} AS media-worker$/m);
  });

  it("blobSegmentRows.ts's FFMPEG_IMAGE equals the Dockerfile's pin", () => {
    expect(FFMPEG_IMAGE).toBe(pin?.value);
  });

  it('readFfmpegPin catches a missing ARG and a drifted value (mutation check)', () => {
    expect(readFfmpegPin('FROM x\n')).toBeNull();
    const drifted = readFfmpegPin(
      '# reviewed 2026-10-11\nARG FFMPEG_IMAGE=linuxserver/ffmpeg:9.1-cli@sha256:' +
        '0'.repeat(64) +
        '\n',
    );
    expect(drifted?.value).not.toBe(FFMPEG_IMAGE);
  });
});
