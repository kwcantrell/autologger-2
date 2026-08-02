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

/**
 * Read duration via media element metadata only — does NOT decode PCM into an
 * AudioBuffer (which OOMs on long podcast MP3s when the old path re-encoded WAV).
 */
export async function probeMediaDurationS(file: Blob): Promise<number> {
  const url = URL.createObjectURL(file);
  try {
    const audio = new Audio();
    audio.preload = 'metadata';
    const durationS = await new Promise<number>((resolve, reject) => {
      audio.onloadedmetadata = () => {
        const d = audio.duration;
        if (!Number.isFinite(d) || d <= 0) {
          reject(new Error('Could not read audio duration from file metadata.'));
          return;
        }
        resolve(d);
      };
      audio.onerror = () => {
        reject(new Error('Could not read audio duration from file metadata.'));
      };
      audio.src = url;
    });
    return durationS;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Decode files in order, concatenate PCM, and encode a WAV blob with total duration.
 * Single-file groups pass through the original bytes (no PCM/WAV expansion). */
export async function stitchAudioFiles(
  files: File[],
  audioContext?: AudioContext,
): Promise<StitchResult> {
  if (files.length === 0) {
    throw new Error('stitchAudioFiles requires at least one file');
  }

  // Single file: upload the original container. Decoding a long MP3 to WAV can
  // allocate multi-GB ArrayBuffers and throw "Array buffer allocation failed".
  if (files.length === 1) {
    const file = files[0];
    const durationS = await probeMediaDurationS(file);
    return { blob: file, durationS, partDurationsS: [durationS] };
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
