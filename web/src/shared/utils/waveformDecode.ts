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

export async function fetchAndDecodeWaveformPeaks(
  url: string,
  audioContext: AudioContext,
  opts: { bucketCount?: number; dbFloor?: number; signal?: AbortSignal } = {},
): Promise<Float32Array> {
  const { bucketCount = 800, dbFloor = -48, signal } = opts;
  const res = await fetch(url, { credentials: 'include', mode: 'cors', signal });
  if (!res.ok) throw new Error(`Waveform fetch ${res.status}`);
  const ab = await res.arrayBuffer();
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
