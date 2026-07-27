import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeAudioBufferToWav } from './wavEncode';
import { stitchAudioFiles } from './stitch';

function syntheticBuffer(
  durationS: number,
  sampleRate = 44100,
  numberOfChannels = 1,
): AudioBuffer {
  const length = Math.round(durationS * sampleRate);
  const channels: Float32Array[] = [];
  for (let c = 0; c < numberOfChannels; c++) {
    channels.push(new Float32Array(length));
  }
  return {
    sampleRate,
    length,
    numberOfChannels,
    duration: durationS,
    getChannelData(ch: number) {
      return channels[ch];
    },
    copyFromChannel() {},
    copyToChannel() {},
  } as AudioBuffer;
}

function mockAudioContext(decodeMap: Map<string, AudioBuffer>): AudioContext {
  return {
    decodeAudioData: vi.fn(async (ab: ArrayBuffer) => {
      const key = new TextDecoder().decode(ab);
      const buf = decodeMap.get(key);
      if (!buf) throw new Error(`no mock decode for ${key}`);
      return buf;
    }),
    close: vi.fn(),
  } as unknown as AudioContext;
}

function fileNamed(name: string): File {
  return new File([name], name, { type: 'audio/mpeg' });
}

describe('encodeAudioBufferToWav', () => {
  it('produces a WAV blob with audio/wav type', () => {
    const blob = encodeAudioBufferToWav(syntheticBuffer(0.5));
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBeGreaterThan(44);
  });
});

describe('stitchAudioFiles', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('concatenates durations for multi-part input', async () => {
    const decodeMap = new Map<string, AudioBuffer>([
      ['part-a.mp3', syntheticBuffer(2.5)],
      ['part-b.mp3', syntheticBuffer(1.5)],
    ]);
    const ctx = mockAudioContext(decodeMap);

    const { blob, durationS } = await stitchAudioFiles(
      [fileNamed('part-a.mp3'), fileNamed('part-b.mp3')],
      ctx,
    );

    expect(durationS).toBeCloseTo(4, 5);
    expect(blob.type).toBe('audio/wav');
    expect(ctx.decodeAudioData).toHaveBeenCalledTimes(2);
  });

  it('decodes a single file to WAV with known duration', async () => {
    const decodeMap = new Map<string, AudioBuffer>([['solo.wav', syntheticBuffer(3.25)]]);
    const ctx = mockAudioContext(decodeMap);

    const { blob, durationS } = await stitchAudioFiles([fileNamed('solo.wav')], ctx);

    expect(durationS).toBeCloseTo(3.25, 5);
    expect(blob.type).toBe('audio/wav');
    expect(ctx.decodeAudioData).toHaveBeenCalledTimes(1);
  });
});
