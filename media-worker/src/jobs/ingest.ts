// The `ingest` job (media-worker design D5): one new segment's blob → exact duration and peaks
// from its decoded PCM; a 16/24-bit integer WAV also becomes a verified FLAC under
// `media/<job id>/`. The apply step (API) writes the row; this only computes.

import type { MediaIngestResult, MediaJob } from '@autologger/ports/media';
import { mediaJobBackoffMs } from '@autologger/storage/mediaLimits';
import { peaksDecode, prepareInput, probeStream } from '../decode';
import { makeJobDir, removeJobDir, resultKey } from '../output';
import { PEAKS_SAMPLE_RATE, peaksFromDecodes } from '../peaks';
import { convertToFlac, probeWavHeader } from '../verify';
import { type JobCtx, JobFailure, type JobOutcome } from './types';

export async function runIngest(ctx: JobCtx, job: MediaJob): Promise<JobOutcome> {
  let madeDir = false;
  try {
    if ((await ctx.freeBytes()) < 2 * job.inputBytes) {
      return {
        kind: 'release',
        error: 'low-disk',
        runAfterMs: ctx.now() + mediaJobBackoffMs(job.attempts),
      };
    }
    const row = await ctx.reads.segment(job.sessionId, job.target);
    if (!row) return { kind: 'fail', error: 'missing-blob', final: true };
    const p = await prepareInput(ctx, row.r2Key);
    try {
      const info = await probeStream(p);
      const decoded = await peaksFromDecodes(peaksDecode(ctx, p));
      let flac: MediaIngestResult['flac'] = null;
      const wav = p.demuxer === 'wav' ? probeWavHeader(p.head) : null;
      if (wav?.ok) {
        const dir = await makeJobDir(ctx.blobDir, job.id);
        madeDir = true;
        const { frames } = await convertToFlac(ctx, p, wav, dir, 'converted.flac');
        if (frames <= 0) throw new JobFailure('decode-failed', 'no audio');
        flac = { key: resultKey(job.id, 'converted.flac'), mime: 'audio/flac' };
      }
      const result: MediaIngestResult = {
        duration_ms: decoded.durationMs,
        peaks: decoded.peaks,
        codec: info?.codec ?? p.demuxer,
        sample_rate: info?.sampleRate ?? PEAKS_SAMPLE_RATE,
        channels: info?.channels ?? decoded.channels,
        flac,
      };
      if (!(result.duration_ms > 0)) throw new JobFailure('decode-failed', 'zero duration');
      return { kind: 'done', result };
    } finally {
      await p.opened.close();
    }
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
  }
}
