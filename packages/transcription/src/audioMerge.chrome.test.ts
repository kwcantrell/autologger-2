// media-worker D.8: real Chrome MediaRecorder rollover chunks (synthetic tone, see
// fixtures/audio/chrome-rollover.source.txt) carry no duration on their last block and
// millisecond-rounded block times. The packet-copy merge must still write strictly increasing
// timestamps with each input starting exactly where the previous one's samples end, so the pinned
// ffmpeg decodes the merged file with no error-level line (the media worker fails a merge on any)
// and with the exact sum of the inputs' samples.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ALL_FORMATS,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  FilePathSource,
  FilePathTarget,
  Input,
  Output,
  WebMOutputFormat,
} from 'mediabunny';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergeAudioSegments } from './audioMerge';
import { TRANSCRIPTION_FIXTURES_DIR } from './fixturesDir';

const chunk = (n: number) => join(TRANSCRIPTION_FIXTURES_DIR, 'audio', `chrome-rollover-${n}.webm`);
const CHUNKS = [chunk(1), chunk(2), chunk(3)];
/** The same packets with a real microphone clock's millisecond block times (59.6 ms steps). */
const DRIFT = [1, 2, 3].map((n) =>
  join(TRANSCRIPTION_FIXTURES_DIR, 'audio', `chrome-rollover-drift-${n}.webm`),
);
/** 60 ms Opus frames at 48 kHz; 38 packets per fixture chunk. */
const FRAME = 2880;

let outDir: string;
beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'audio-merge-chrome-'));
});
afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

async function packets(path: string): Promise<{ timestamp: number; duration: number }[]> {
  const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(path) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('no track');
    const out: { timestamp: number; duration: number }[] = [];
    for await (const p of new EncodedPacketSink(track).packets())
      out.push({ timestamp: p.timestamp, duration: p.duration });
    return out;
  } finally {
    input.dispose();
  }
}

/** A copy of a chunk with Chrome's real-device block-time jitter: each block time rounded to
 * whole milliseconds with ±1 ms drift (0.059/0.061 s steps, as captured on a real microphone),
 * the last block again without a duration. */
async function jitteredCopy(src: string, dst: string): Promise<void> {
  const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(src) });
  const output = new Output({ format: new WebMOutputFormat(), target: new FilePathTarget(dst) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('no track');
    const config = await track.getDecoderConfig();
    const source = new EncodedAudioPacketSource('opus');
    output.addAudioTrack(source);
    await output.start();
    const all: EncodedPacket[] = [];
    for await (const p of new EncodedPacketSink(track).packets()) all.push(p);
    let first = true;
    for (let i = 0; i < all.length; i += 1) {
      const drift = i % 3 === 1 ? -0.001 : i % 3 === 2 ? 0.001 : 0;
      const t = Math.round((all[i].timestamp + (i > 0 ? drift : 0)) * 1000) / 1000;
      const next = i + 1 < all.length ? Math.round(all[i + 1].timestamp * 1000) / 1000 : t;
      await source.add(
        new EncodedPacket(all[i].data, 'key', t, Math.max(0, next - t)),
        first && config ? { decoderConfig: config } : undefined,
      );
      first = false;
    }
    source.close();
    await output.finalize();
  } finally {
    input.dispose();
  }
}

describe('mergeAudioSegments with Chrome rollover chunks', () => {
  it('the fixtures have Chrome’s shape: 38 × 60 ms packets, the last one without a duration', async () => {
    for (const c of CHUNKS) {
      const ps = await packets(c);
      expect(ps).toHaveLength(38);
      expect(ps.at(-1)?.duration).toBe(0);
    }
  });

  it('writes strictly increasing timestamps; each input starts where the previous one’s samples end', async () => {
    const { groups, skipped } = await mergeAudioSegments(CHUNKS, join(outDir, 'a'));
    expect(skipped).toEqual([]);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    const ps = await packets(g.outPath);
    expect(ps).toHaveLength(3 * 38);
    for (let i = 1; i < ps.length; i += 1) {
      expect(ps[i].timestamp).toBeGreaterThan(ps[i - 1].timestamp);
    }
    const chunkSec = (38 * FRAME) / 48_000;
    expect(g.segments.map((s) => s.offsetSeconds)).toEqual(
      [0, chunkSec, 2 * chunkSec].map((v) => expect.closeTo(v, 9)),
    );
    expect(g.segments.map((s) => s.durationSeconds)).toEqual(
      [chunkSec, chunkSec, chunkSec].map((v) => expect.closeTo(v, 9)),
    );
    expect(g.durationSeconds).toBeCloseTo(3 * chunkSec, 9);
  });

  it('drifted millisecond block times never overlap a seam', async () => {
    const { groups } = await mergeAudioSegments(DRIFT, join(outDir, 'e'));
    const ps = await packets(groups[0].outPath);
    for (const [i, p] of ps.entries()) expect(p.timestamp).toBeCloseTo((i * FRAME) / 48_000, 6);
  });

  it('jittered millisecond block times never overlap a seam', async () => {
    const jittered = join(outDir, 'jittered-2.webm');
    await jitteredCopy(chunk(2), jittered);
    const { groups } = await mergeAudioSegments([chunk(1), jittered, chunk(3)], join(outDir, 'b'));
    const ps = await packets(groups[0].outPath);
    for (let i = 1; i < ps.length; i += 1) {
      expect(ps[i].timestamp).toBeGreaterThan(ps[i - 1].timestamp);
    }
    // Sample-exact placement: every block sits on the 60 ms frame grid.
    for (const [i, p] of ps.entries()) expect(p.timestamp).toBeCloseTo((i * FRAME) / 48_000, 6);
  });
});

// --- the pinned ffmpeg (the media worker's decoder) ----------------------------------------

const REPO = resolve(import.meta.dirname, '../../..');

/** argv prefix for ffmpeg: `MEDIA_WORKER_TEST_FFMPEG`, `ffmpeg` on PATH, else the pinned image
 * through docker when already pulled; null → the decode tests skip. Inputs go through stdin. */
function ffmpegCommand(): string[] | null {
  const env = (process.env.MEDIA_WORKER_TEST_FFMPEG || '').trim();
  if (env && spawnSync(env, ['-version']).status === 0) return [env];
  if (spawnSync('ffmpeg', ['-version']).status === 0) return ['ffmpeg'];
  let image: string | undefined;
  try {
    const text = readFileSync(join(REPO, 'docker/media-worker.Dockerfile'), 'utf8');
    image = text.match(/^ARG FFMPEG_IMAGE=(\S+)$/m)?.[1];
  } catch {
    image = undefined;
  }
  if (!image) return null;
  if (spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status !== 0)
    return null;
  return [
    'docker',
    'run',
    '-i',
    '--rm',
    '--network',
    'none',
    '--entrypoint',
    '/usr/local/bin/ffmpeg',
    image,
  ];
}
const FFMPEG = ffmpegCommand();

/** The worker's counting decode: untrimmed, to a WAV container on stdout. */
function decodeWav(bytes: Buffer): { samples: number; stderr: string; code: number } {
  const [cmd, ...pre] = FFMPEG as string[];
  const r = spawnSync(
    cmd,
    [
      ...pre,
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-xerror',
      '-flags2',
      '+skip_manual',
      '-protocol_whitelist',
      'pipe',
      '-f',
      'matroska',
      '-i',
      'pipe:0',
      '-ac',
      '1',
      '-c:a',
      'pcm_f32le',
      '-f',
      'wav',
      'pipe:1',
    ],
    { input: bytes, maxBuffer: 1 << 28 },
  );
  const data = r.stdout.indexOf('data');
  return {
    samples: data < 0 ? 0 : (r.stdout.length - data - 8) / 4,
    stderr: r.stderr.toString(),
    code: r.status ?? -1,
  };
}

/** Decode WebM bytes the way the worker does (forced demuxer, pipe input, `-xerror`), counting
 * samples; `untrimmed` keeps the Opus pre-skip (`-flags2 +skip_manual`). */
function decode(
  bytes: Buffer,
  untrimmed: boolean,
): { samples: number; stderr: string; code: number } {
  const [cmd, ...pre] = FFMPEG as string[];
  const r = spawnSync(
    cmd,
    [
      ...pre,
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-xerror',
      ...(untrimmed ? ['-flags2', '+skip_manual'] : []),
      '-protocol_whitelist',
      'pipe',
      '-f',
      'matroska',
      '-i',
      'pipe:0',
      '-ac',
      '1',
      '-f',
      'f32le',
      'pipe:1',
    ],
    { input: bytes, maxBuffer: 1 << 28 },
  );
  return { samples: r.stdout.length / 4, stderr: r.stderr.toString(), code: r.status ?? -1 };
}

describe.skipIf(!FFMPEG)('the merged Chrome chunks decode cleanly with the pinned ffmpeg', () => {
  it('drifted block times: no error-level line in the wav decode the worker counts with', async () => {
    const { groups } = await mergeAudioSegments(DRIFT, join(outDir, 'd'));
    const r = decodeWav(await readFile(groups[0].outPath));
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.samples).toBe(3 * 38 * FRAME);
  }, 60_000);

  it('no error-level line, and exactly the inputs’ samples', async () => {
    const { groups } = await mergeAudioSegments(CHUNKS, join(outDir, 'c'));
    const merged = await readFile(groups[0].outPath);
    const full = decode(merged, true);
    expect(full.stderr).toBe('');
    expect(full.code).toBe(0);
    const inputs = await Promise.all(CHUNKS.map(async (c) => decode(await readFile(c), true)));
    for (const i of inputs) expect(i.stderr).toBe('');
    expect(inputs.map((i) => i.samples)).toEqual([38 * FRAME, 38 * FRAME, 38 * FRAME]);
    expect(full.samples).toBe(3 * 38 * FRAME);
    // Chrome writes OpusHead pre-skip 0, so the played stream is the untrimmed one.
    const played = decode(merged, false);
    expect(played.stderr).toBe('');
    expect(played.samples).toBe(3 * 38 * FRAME);
  }, 60_000);
});
