// Generated audio fixtures and a scratch blob tree for the worker's job tests.

import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AudioSeam, MediaJob } from '@autologger/ports/media';
import type { JobCtx, SegmentRow, WorkerReads } from '../jobs/types';
import { SCRATCH_ROOT, TRANSCRIPTION_FIXTURES } from './ffmpegBin';

/** Deterministic noise-like PCM in [-gain, gain]. */
export function wave(len: number, seed: number, gain: number): Float32Array {
  let s = seed;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    out[i] = gain * ((s / 2147483648) * 2 - 1) * Math.abs(Math.sin(i / 9001));
  }
  return out;
}

function riff(fmt: Buffer, data: Buffer): Buffer {
  const hdr = (id: string, size: number) => {
    const h = Buffer.alloc(8);
    h.write(id, 0, 'latin1');
    h.writeUInt32LE(size, 4);
    return h;
  };
  return Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from(Uint32Array.of(4 + 8 + fmt.length + 8 + data.length).buffer),
    Buffer.from('WAVE'),
    hdr('fmt ', fmt.length),
    fmt,
    hdr('data', data.length),
    data,
  ]);
}

/** Integer PCM WAV (16 or 24 bit). */
export function intWav(channels: Float32Array[], rate: number, bits: 16 | 24): Buffer {
  const n = channels.length;
  const len = channels[0].length;
  const bps = bits / 8;
  const data = Buffer.alloc(len * n * bps);
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < n; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      const o = (i * n + c) * bps;
      if (bits === 16) data.writeInt16LE(Math.round(v * 32767), o);
      else data.writeIntLE(Math.round(v * 8388607), o, 3);
    }
  }
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(n, 2);
  fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * n * bps, 8);
  fmt.writeUInt16LE(n * bps, 12);
  fmt.writeUInt16LE(bits, 14);
  return riff(fmt, data);
}

/** 32-bit float WAV. */
export function floatWav(channels: Float32Array[], rate: number): Buffer {
  const n = channels.length;
  const len = channels[0].length;
  const data = Buffer.alloc(len * n * 4);
  for (let i = 0; i < len; i++)
    for (let c = 0; c < n; c++) data.writeFloatLE(channels[c][i], (i * n + c) * 4);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(3, 0);
  fmt.writeUInt16LE(n, 2);
  fmt.writeUInt32LE(rate, 4);
  fmt.writeUInt32LE(rate * n * 4, 8);
  fmt.writeUInt16LE(n * 4, 12);
  fmt.writeUInt16LE(32, 14);
  return riff(fmt, data);
}

export interface Tree {
  root: string;
  blobDir: string;
  /** Writes `audio/<sid>/<name>` and returns its key. */
  put(name: string, bytes: Buffer | Uint8Array, sid?: string): Promise<string>;
  /** Copies a transcription fixture to `audio/<sid>/<name>`. */
  copyFixture(fixture: string, name: string, sid?: string): Promise<string>;
  /** Copies a transcription fixture to `.trash/<day>/<key>` and returns that relative path. */
  trashFixture(fixture: string, key: string, day?: string): Promise<string>;
}

/** A blob tree under the scratch root (mounted into the docker ffmpeg wrapper). */
export async function makeTree(): Promise<Tree> {
  const root = await mkdtemp(join(SCRATCH_ROOT, 'tree-'));
  const blobDir = join(root, 'blobs');
  await mkdir(join(blobDir, 'audio'), { recursive: true });
  await mkdir(join(blobDir, 'media'), { mode: 0o1777 });
  const put = async (name: string, bytes: Buffer | Uint8Array, sid = 's1') => {
    await mkdir(join(blobDir, 'audio', sid), { recursive: true });
    await writeFile(join(blobDir, 'audio', sid, name), bytes);
    return `audio/${sid}/${name}`;
  };
  const copyFixture = async (fixture: string, name: string, sid = 's1') => {
    await mkdir(join(blobDir, 'audio', sid), { recursive: true });
    await copyFile(join(TRANSCRIPTION_FIXTURES, fixture), join(blobDir, 'audio', sid, name));
    return `audio/${sid}/${name}`;
  };
  const trashFixture = async (fixture: string, key: string, day = '2026-10-12') => {
    const rel = `.trash/${day}/${key}`;
    await mkdir(join(blobDir, rel, '..'), { recursive: true });
    await copyFile(join(TRANSCRIPTION_FIXTURES, fixture), join(blobDir, rel));
    return rel;
  };
  return { root, blobDir, put, copyFixture, trashFixture };
}

export function job(over: Partial<MediaJob> = {}): MediaJob {
  return {
    id: '0b6c1f9e-1d0a-4c2e-9a51-3f2d1c0b9a8e',
    kind: 'ingest',
    sessionId: 's1',
    target: 'seg-1',
    status: 'running',
    attempts: 1,
    maxAttempts: 5,
    inputBytes: 1000,
    runAfterMs: 0,
    lockedBy: 'w1',
    lockedUntilMs: 600_000,
    resultJson: null,
    error: null,
    createdAtMs: 0,
    updatedAtMs: 0,
    appliedAtMs: null,
    ...over,
  };
}

export function seg(over: Partial<SegmentRow> & { id: string; r2Key: string }): SegmentRow {
  return {
    ordinal: 1,
    startedAtUtc: '2026-10-12T10:00:00.000Z',
    endedAtUtc: null,
    mimeType: 'audio/webm',
    ...over,
  };
}

export function fakeReads(
  segments: (SegmentRow & { sessionId?: string; recordingOrdinal?: number })[],
  seams: AudioSeam[] = [],
): WorkerReads {
  return {
    async segment(sessionId, id) {
      return segments.find((s) => (s.sessionId ?? 's1') === sessionId && s.id === id) ?? null;
    },
    async recordingSegments(sessionId, ordinal) {
      return segments
        .filter((s) => (s.sessionId ?? 's1') === sessionId && (s.recordingOrdinal ?? 1) === ordinal)
        .sort(
          (a, b) =>
            (a.startedAtUtc ?? '').localeCompare(b.startedAtUtc ?? '') || a.ordinal - b.ordinal,
        );
    },
    async recordingSeams(sessionId, ordinal) {
      return seams
        .filter((s) => s.sessionId === sessionId && s.recordingOrdinal === ordinal)
        .sort((a, b) => a.startedAtUtc.localeCompare(b.startedAtUtc));
    },
  };
}

export function ctx(tree: Tree, reads: WorkerReads, over: Partial<JobCtx> = {}): JobCtx {
  return {
    blobDir: tree.blobDir,
    ffmpegPath: 'ffmpeg-not-used',
    timeoutMs: 120_000,
    freeBytes: async () => 100 * 1024 ** 3,
    now: () => 1_000_000,
    reads,
    ...over,
  };
}
