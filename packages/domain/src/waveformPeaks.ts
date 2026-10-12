// Waveform peaks: the pure computation behind `session_audio_segments.waveform_peaks_json`
// (supabase-11a-legacy-import follow-up B). The browser computes peaks in `web/src/shared/utils/waveformDecode.ts`
// (`computeDbPeaks01`) and `waveformMerge.ts` (constants, bucket-count rule); `web/` never imports
// `packages/` (web-package-boundary), so it keeps its own copy, and
// `web/src/shared/utils/waveformDecode.pinning.test.ts` pins the two bit for bit. The server-side
// backfill (`server/scripts/backfillWaveforms.ts`) uses this module.

/** dB floor of the stored envelope (`waveform_db_floor`); the server stores exactly this. */
export const WF_DB_FLOOR = -48;
export const WF_TIMELINE_BUCKETS = 5000;
export const WF_SEGMENT_DECODE_MIN = 256;
/** Also the contract's maximum peaks length (`audioSegmentWaveformBodySchema`). */
export const WF_SEGMENT_DECODE_MAX = 4096;

/** Buckets to decode a segment into: twice its share of the 5000-bucket timeline, in [256, 4096]. */
export function segmentWaveformDecodeBucketCount(
  durationSec: number,
  timelineSpanSec: number,
): number {
  const span = Math.max(Number(timelineSpanSec) || 1, 1);
  const d = Math.max(Number(durationSec) || 0, 0.05);
  const raw = Math.round((WF_TIMELINE_BUCKETS * 2 * d) / span);
  return Math.max(WF_SEGMENT_DECODE_MIN, Math.min(WF_SEGMENT_DECODE_MAX, raw));
}

/**
 * Streaming form of the browser's `computeDbPeaks01`: the frame count must be known up front
 * (bucket b covers frames [floor(b*spp), min(len, floor((b+1)*spp))) with spp = len/bucketCount),
 * then PCM arrives as interleaved Float32 chunks of whole frames. Per frame the value is the
 * max |sample| across channels; per bucket the max of those, mapped to a dB envelope clamped to
 * [dbFloor, 0] and scaled to [0, 1]. Same arithmetic, same Float32 storage, so the output is
 * bit-identical to the browser's for the same PCM. Memory is O(bucketCount).
 */
export class DbPeaksAccumulator {
  private readonly peaks: Float32Array;
  private readonly spp: number;
  private bucket = 0;
  private bucketEnd: number;
  private max = 0;
  private frames = 0;

  constructor(
    private readonly totalFrames: number,
    private readonly bucketCount: number,
    private readonly dbFloor = WF_DB_FLOOR,
  ) {
    if (!Number.isSafeInteger(totalFrames) || totalFrames < 0) throw new Error('bad totalFrames');
    if (!Number.isSafeInteger(bucketCount) || bucketCount < 1) throw new Error('bad bucketCount');
    this.peaks = new Float32Array(bucketCount);
    this.spp = totalFrames / bucketCount;
    this.bucketEnd = this.endOf(0);
  }

  get framesSeen(): number {
    return this.frames;
  }

  private endOf(b: number): number {
    return Math.min(this.totalFrames, Math.floor((b + 1) * this.spp));
  }

  private close(): void {
    const db = 20 * Math.log10(Math.max(this.max, 1e-10));
    const dbClamped = Math.max(this.dbFloor, Math.min(0, db));
    this.peaks[this.bucket] = (dbClamped - this.dbFloor) / -this.dbFloor;
    this.bucket += 1;
    this.max = 0;
    this.bucketEnd = this.endOf(this.bucket);
  }

  pushInterleaved(samples: Float32Array, channels: number): void {
    if (!Number.isSafeInteger(channels) || channels < 1 || samples.length % channels !== 0) {
      throw new Error('PCM chunk is not whole frames');
    }
    const n = samples.length / channels;
    if (this.frames + n > this.totalFrames) {
      throw new Error(`more frames than announced (${this.totalFrames})`);
    }
    let i = this.frames;
    for (let f = 0, o = 0; f < n; f += 1, i += 1) {
      let v = 0;
      for (let c = 0; c < channels; c += 1, o += 1) {
        const a = Math.abs(samples[o]);
        if (a > v) v = a;
      }
      while (this.bucket < this.bucketCount && i >= this.bucketEnd) this.close();
      if (this.bucket < this.bucketCount && v > this.max) this.max = v;
    }
    this.frames = i;
  }

  finish(): Float32Array {
    if (this.frames !== this.totalFrames) {
      throw new Error(`saw ${this.frames} frames, expected ${this.totalFrames}`);
    }
    while (this.bucket < this.bucketCount) this.close();
    return this.peaks;
  }
}
