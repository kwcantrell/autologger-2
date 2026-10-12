// `computeDbPeaks01` is mirrored by `packages/domain/src/waveformPeaks.ts` (`DbPeaksAccumulator`),
// which the server-side backfill (`server/scripts/backfillWaveforms.ts`) uses; `web/` does not import
// `packages/` (web-package-boundary). `waveformDecode.pinning.test.ts` pins the two bit for bit:
// change both together.

export function computeDbPeaks01(
  audioBuffer: AudioBuffer,
  bucketCount: number,
  dbFloor = -48,
): Float32Array {
  const len = audioBuffer.length;
  const peaks = new Float32Array(bucketCount);
  if (len === 0) return peaks;
  const nCh = audioBuffer.numberOfChannels;
  const merged = new Float32Array(len);
  for (let c = 0; c < nCh; c++) {
    const ch = audioBuffer.getChannelData(c);
    for (let i = 0; i < len; i++) merged[i] = Math.max(merged[i], Math.abs(ch[i]));
  }
  const spp = len / bucketCount;
  const denom = -dbFloor;
  for (let b = 0; b < bucketCount; b++) {
    const start = Math.floor(b * spp);
    const end = Math.min(len, Math.floor((b + 1) * spp));
    let m = 0;
    for (let i = start; i < end; i++) if (merged[i] > m) m = merged[i];
    const db = 20 * Math.log10(Math.max(m, 1e-10));
    const dbClamped = Math.max(dbFloor, Math.min(0, db));
    peaks[b] = (dbClamped - dbFloor) / denom;
  }
  return peaks;
}

/**
 * Largest segment file (bytes) we download and decodeAudioData in the browser. Decoding costs about
 * duration x sampleRate x channels x 4 bytes of PCM (a 1.3 GB WAV is several GB), so bigger files
 * are skipped and shown as "Waveform unavailable" until the server backfills peaks.
 * The size comes from the response `Content-Length`, checked before the body is read; if it is
 * absent the body is streamed and cancelled as soon as the cap is passed.
 */
export const WAVEFORM_DECODE_MAX_BYTES = 200 * 1024 * 1024;

export class WaveformTooLargeError extends Error {
  constructor(bytes: number) {
    super(
      `Waveform decode skipped: file is over the ${WAVEFORM_DECODE_MAX_BYTES} byte cap (${bytes})`,
    );
    this.name = 'WaveformTooLargeError';
  }
}

async function readBodyWithinCap(res: Response): Promise<ArrayBuffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > WAVEFORM_DECODE_MAX_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw new WaveformTooLargeError(declared);
  }
  if (Number.isFinite(declared) && declared > 0) return res.arrayBuffer();
  const reader = res.body?.getReader();
  if (!reader) return res.arrayBuffer();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > WAVEFORM_DECODE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new WaveformTooLargeError(total);
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.byteLength;
  }
  return out.buffer;
}

export async function fetchAndDecodeWaveformPeaks(
  url: string,
  audioContext: AudioContext,
  opts: { bucketCount?: number; dbFloor?: number; signal?: AbortSignal } = {},
): Promise<Float32Array> {
  const { bucketCount = 800, dbFloor = -48, signal } = opts;
  const res = await fetch(url, { credentials: 'include', mode: 'cors', signal });
  if (!res.ok) throw new Error(`Waveform fetch ${res.status}`);
  const ab = await readBodyWithinCap(res);
  return decodeWaveformPeaksFromArrayBuffer(ab, audioContext, { bucketCount, dbFloor });
}

export async function decodeWaveformPeaksFromArrayBuffer(
  arrayBuffer: ArrayBuffer,
  audioContext: AudioContext,
  opts: { bucketCount?: number; dbFloor?: number } = {},
): Promise<Float32Array> {
  const bucketCount = opts.bucketCount ?? 800;
  const dbFloor = opts.dbFloor ?? -48;
  const buf = await audioContext.decodeAudioData(arrayBuffer.slice(0));
  return computeDbPeaks01(buf, bucketCount, dbFloor);
}
