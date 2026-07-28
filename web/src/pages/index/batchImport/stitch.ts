import { encodeAudioBufferToWav } from './wavEncode';

export interface StitchResult {
  blob: Blob;
  durationS: number;
  partDurationsS: number[];
}

function resampleChannel(src: Float32Array, targetLength: number): Float32Array {
  if (src.length === targetLength) return src;
  const dst = new Float32Array(targetLength);
  if (targetLength === 0) return dst;
  if (src.length === 0) return dst;
  for (let i = 0; i < targetLength; i++) {
    const srcIdx = (i * src.length) / targetLength;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(src.length - 1, i0 + 1);
    const frac = srcIdx - i0;
    dst[i] = src[i0] * (1 - frac) + src[i1] * frac;
  }
  return dst;
}

function concatAudioBuffers(buffers: AudioBuffer[]): AudioBuffer {
  if (buffers.length === 0) {
    throw new Error('concatAudioBuffers requires at least one buffer');
  }
  if (buffers.length === 1) {
    return buffers[0];
  }

  const sampleRate = buffers[0].sampleRate;
  const numberOfChannels = Math.max(...buffers.map((b) => b.numberOfChannels));
  const partLengths = buffers.map((b) =>
    b.sampleRate === sampleRate ? b.length : Math.round((b.length * sampleRate) / b.sampleRate),
  );
  const totalLength = partLengths.reduce((sum, len) => sum + len, 0);
  const channelData: Float32Array[] = [];
  for (let ch = 0; ch < numberOfChannels; ch++) {
    channelData.push(new Float32Array(totalLength));
  }

  let offset = 0;
  for (let bi = 0; bi < buffers.length; bi++) {
    const buffer = buffers[bi];
    const len = partLengths[bi];
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const dst = channelData[ch];
      const raw =
        ch < buffer.numberOfChannels ? buffer.getChannelData(ch) : new Float32Array(buffer.length);
      const samples =
        buffer.sampleRate === sampleRate && raw.length === len ? raw : resampleChannel(raw, len);
      dst.set(samples, offset);
    }
    offset += len;
  }

  return {
    sampleRate,
    length: totalLength,
    numberOfChannels,
    duration: totalLength / sampleRate,
    getChannelData(ch: number) {
      return channelData[ch];
    },
    copyFromChannel() {},
    copyToChannel() {},
  } as AudioBuffer;
}

async function decodeFile(file: File, audioContext: AudioContext): Promise<AudioBuffer> {
  const arrayBuffer = await file.arrayBuffer();
  return audioContext.decodeAudioData(arrayBuffer.slice(0));
}

function createAudioContext(): AudioContext {
  const w = globalThis as typeof globalThis & {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) {
    throw new Error('Web Audio API is unavailable');
  }
  return new Ctor();
}

/** Decode files in order, concatenate PCM, and encode a WAV blob with total duration. */
export async function stitchAudioFiles(
  files: File[],
  audioContext?: AudioContext,
): Promise<StitchResult> {
  if (files.length === 0) {
    throw new Error('stitchAudioFiles requires at least one file');
  }

  const ctx = audioContext ?? createAudioContext();
  const ownsContext = !audioContext;

  try {
    const decoded: AudioBuffer[] = [];
    for (const file of files) {
      decoded.push(await decodeFile(file, ctx));
    }

    const merged = concatAudioBuffers(decoded);
    const durationS = merged.duration;
    const sampleRate = merged.sampleRate;
    const partDurationsS = decoded.map((b) => {
      const len =
        b.sampleRate === sampleRate ? b.length : Math.round((b.length * sampleRate) / b.sampleRate);
      return len / sampleRate;
    });
    const blob = encodeAudioBufferToWav(merged);
    return { blob, durationS, partDurationsS };
  } finally {
    if (ownsContext) {
      await ctx.close().catch(() => {});
    }
  }
}
