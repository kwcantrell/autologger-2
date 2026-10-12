// The `merge` job (media-worker design D7): a recording's segments → one segment by packet copy
// per codec family (@autologger/transcription's mergeAudioSegments: Opus → WebM, AAC → MP4,
// FLAC → FLAC, PCM → WAV then a verified FLAC), never re-encoded and never padded. Refused unless
// the probe yields exactly one group and no skipped input. Verified by decoding with errors
// fatal: the merged sample count must EQUAL the inputs' (Opus: Σ raw + every non-first pre-skip;
// AAC: both sides with edit lists ignored; FLAC/PCM: Σ raw). The result names the merged file
// under media/<job id>/, its peaks and duration, the input ids and the seams.

import { chmod, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AudioSeam,
  MediaJob,
  MediaMergeResult,
  MediaSeamResult,
} from '@autologger/ports/media';
import { MEDIA_MIN_FREE_BYTES, mediaJobBackoffMs } from '@autologger/storage/mediaLimits';
import { mergeAudioSegments } from '@autologger/transcription/audioMerge';
import { nativeFrames, type Prepared, peaksDecode, prepareInput, preSkipOf } from '../decode';
import { makeJobDir, openOwn, removeJobDir, resultKey } from '../output';
import { peaksFromDecodes } from '../peaks';
import { convertToFlac, probeWavHeader } from '../verify';
import { type JobCtx, JobFailure, type JobOutcome, type SegmentRow } from './types';

export interface MergeInput {
  /** Blob key under audio/ (a live row) or .trash/ (an original, when rebuilding). */
  key: string;
  /** Seams this input contributes, offsets relative to its own decoded start. */
  seams: MediaSeamResult[];
}

export type MergePlan =
  | { kind: 'append'; inputs: MergeInput[]; inputIds: string[]; rebuilt: boolean }
  | { kind: 'interleaved' };

const seamOut = (s: AudioSeam): MediaSeamResult => ({
  offset_ms: s.offsetMs,
  started_at_utc: s.startedAtUtc,
  ended_at_utc: s.endedAtUtc,
  source_key: s.sourceKey,
});

/** The original of a merged chunk under `.trash/<day>/<source_key>`, newest day first. */
async function findInTrash(blobDir: string, sourceKey: string): Promise<string | null> {
  const days = await readdir(join(blobDir, '.trash')).catch(() => [] as string[]);
  for (const day of days
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort()
    .reverse()) {
    const rel = `.trash/${day}/${sourceKey}`;
    const ok = await readdir(join(blobDir, rel, '..'))
      .then((names) => names.includes(sourceKey.split('/').at(-1) as string))
      .catch(() => false);
    if (ok) return rel;
  }
  return null;
}

/** Inputs in wall-clock order with the seams each carries; a chunk whose window falls between
 * two seams of a merged input forces a rebuild from the originals (or `interleaved`). */
export async function planMerge(
  blobDir: string,
  rows: SegmentRow[],
  seams: AudioSeam[],
): Promise<MergePlan> {
  const ordered = [...rows].sort(
    (a, b) => a.startedAtUtc.localeCompare(b.startedAtUtc) || a.ordinal - b.ordinal,
  );
  const withSeams = ordered.map((row) => {
    const own = seams
      .filter((s) => s.segmentId === row.id)
      .sort((a, b) => a.offsetMs - b.offsetMs || a.startedAtUtc.localeCompare(b.startedAtUtc));
    const list: AudioSeam[] = own.length
      ? own
      : [
          {
            sessionId: '',
            recordingOrdinal: 0,
            startedAtUtc: row.startedAtUtc,
            endedAtUtc: row.endedAtUtc,
            segmentId: row.id,
            offsetMs: 0,
            sourceKey: row.r2Key,
          },
        ];
    return { row, seams: list };
  });
  const inputIds = ordered.map((r) => r.id);
  const interleaved = withSeams.some(({ row, seams: s }) => {
    if (s.length < 2) return false;
    const first = s[0].startedAtUtc;
    const last = s[s.length - 1].startedAtUtc;
    return ordered.some((o) => o.id !== row.id && o.startedAtUtc > first && o.startedAtUtc < last);
  });
  if (!interleaved) {
    return {
      kind: 'append',
      rebuilt: false,
      inputIds,
      inputs: withSeams.map(({ row, seams: s }) => ({ key: row.r2Key, seams: s.map(seamOut) })),
    };
  }
  const all = withSeams
    .flatMap(({ row, seams: s }) => s.map((seam) => ({ row, seam, single: s.length === 1 })))
    .sort((a, b) => a.seam.startedAtUtc.localeCompare(b.seam.startedAtUtc));
  const inputs: MergeInput[] = [];
  for (const { row, seam, single } of all) {
    const live = single && seam.sourceKey === row.r2Key;
    const key = live ? row.r2Key : await findInTrash(blobDir, seam.sourceKey);
    if (!key) return { kind: 'interleaved' };
    inputs.push({ key, seams: [{ ...seamOut(seam), offset_ms: 0 }] });
  }
  return { kind: 'append', rebuilt: true, inputIds, inputs };
}

const MIME: Record<string, string> = {
  opus: 'audio/webm',
  aac: 'audio/mp4',
  flac: 'audio/flac',
  pcm: 'audio/wav',
};

const toMs = (samples: number, rate: number) => Math.round((samples / rate) * 1000);

export async function runMerge(ctx: JobCtx, job: MediaJob): Promise<JobOutcome> {
  const opened: Prepared[] = [];
  let madeDir = false;
  try {
    const free = await ctx.freeBytes();
    if (free < MEDIA_MIN_FREE_BYTES || free < 2 * job.inputBytes) {
      return {
        kind: 'release',
        error: 'low-disk',
        runAfterMs: ctx.now() + mediaJobBackoffMs(job.attempts),
      };
    }
    const ordinal = Number(job.target);
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
      return { kind: 'fail', error: 'internal', final: true };
    }
    const rows = await ctx.reads.recordingSegments(job.sessionId, ordinal);
    if (rows.length < 2) return { kind: 'fail', error: 'internal', final: true };
    const plan = await planMerge(
      ctx.blobDir,
      rows,
      await ctx.reads.recordingSeams(job.sessionId, ordinal),
    );
    if (plan.kind === 'interleaved')
      return { kind: 'fail', error: 'interleaved-input', final: true };

    for (const input of plan.inputs) opened.push(await prepareInput(ctx, input.key));
    const dir = await makeJobDir(ctx.blobDir, job.id);
    madeDir = true;

    const merged = await mergeAudioSegments(
      opened.map((p) => p.opened.fdPath),
      dir,
    );
    if (merged.skipped.length > 0)
      throw new JobFailure('decode-failed', 'an input could not be read', false);
    if (merged.groups.length !== 1)
      throw new JobFailure('mixed-codecs', 'inputs are not one codec family', true);
    const group = merged.groups[0];
    if (group.family === 'mp3') throw new JobFailure('mixed-codecs', 'MP3 is never merged', true);
    const ext = group.outPath.split('.').at(-1) as string;
    await rename(group.outPath, join(dir, `merged.${ext}`));
    await chmod(join(dir, `merged.${ext}`), 0o644);
    let name = `merged.${ext}`;

    // Verification (D7): packet copy keeps every packet, so the merged file decoded with nothing
    // trimmed (`-flags2 +skip_manual`; mov also `-ignore_editlist 1`) must hold exactly the
    // inputs' untrimmed samples. (Σ raw + Σ non-first pre-skips is not exact: the inputs' end
    // padding, WebM DiscardPadding or the Ogg end granule, is not carried into the merged file.)
    const aac = group.family === 'aac';
    const opus = group.family === 'opus';
    const counting = { untrimmed: true, ignoreEditlist: aac };
    const raws: number[] = [];
    let rate = 0;
    for (const p of opened) {
      const f = await nativeFrames(ctx, p, counting);
      if (f.frames <= 0) throw new JobFailure('decode-failed', 'an input decodes to nothing');
      raws.push(f.frames);
      rate = f.sampleRate;
    }
    const expected = raws.reduce((a, b) => a + b, 0);
    // Each input's own start skip (Opus pre-skip), and the merged file's: input i's audio starts
    // at Σ_{j<i} untrimmed_j + skip_i in the untrimmed merged stream, which plays from its skip.
    const skips = opened.map((p) => (opus ? preSkipOf(p) : 0));

    let out = await openOwn(dir, name);
    let mergedSamples: number;
    let lead = 0;
    try {
      const m = await nativeFrames(ctx, out, counting);
      mergedSamples = m.frames;
      rate = m.sampleRate;
      if (opus) lead = preSkipOf(out);
      else if (aac) lead = Math.max(0, m.frames - (await nativeFrames(ctx, out)).frames);
    } finally {
      await out.opened.close();
    }
    if (mergedSamples !== expected)
      throw new JobFailure('verify-mismatch', 'merged sample count differs');

    if (group.family === 'pcm') {
      const probes = opened.map((p) => probeWavHeader(p.head));
      const first = probes[0];
      if (first.ok && probes.every((q) => q.ok && q.bitsPerSample === first.bitsPerSample)) {
        const wav = await openOwn(dir, name);
        try {
          const { frames } = await convertToFlac(ctx, wav, first, dir, 'merged.flac');
          if (frames !== expected)
            throw new JobFailure('verify-mismatch', 'FLAC sample count differs');
        } finally {
          await wav.opened.close();
        }
        await rm(join(dir, name));
        name = 'merged.flac';
      }
    }

    out = await openOwn(dir, name);
    let peaks: Awaited<ReturnType<typeof peaksFromDecodes>>;
    try {
      peaks = await peaksFromDecodes(peaksDecode(ctx, out));
    } finally {
      await out.opened.close();
    }

    const seams: MediaSeamResult[] = [];
    let base = 0;
    plan.inputs.forEach((input, i) => {
      const startMs = toMs(Math.max(0, base + skips[i] - lead), rate);
      for (const s of input.seams) seams.push({ ...s, offset_ms: startMs + s.offset_ms });
      base += raws[i];
    });

    const result: MediaMergeResult = {
      key: resultKey(job.id, name),
      mime: name.endsWith('.flac') ? 'audio/flac' : MIME[group.family],
      duration_ms: peaks.durationMs,
      peaks: peaks.peaks,
      seams,
      input_ids: plan.inputIds,
      verify: { merged_samples: mergedSamples, expected_samples: expected },
    };
    return { kind: 'done', result };
  } catch (err) {
    if (madeDir) await removeJobDir(ctx.blobDir, job.id).catch(() => {});
    if (err instanceof JobFailure) return { kind: 'fail', error: err.code, final: err.final };
    if (
      err instanceof Error &&
      /no audio decoded|disagree|not a WAV|torn frame/.test(err.message)
    ) {
      return { kind: 'fail', error: 'decode-failed', final: false };
    }
    return { kind: 'fail', error: 'internal', final: false };
  } finally {
    for (const p of opened) await p.opened.close().catch(() => {});
  }
}
