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

function fileNamed(name: string, type = 'audio/mpeg'): File {
  return new File([name], name, { type });
}

function stubMediaProbe(durationS: number): void {
  const urls = new Map<string, Blob>();
  let seq = 0;
  vi.stubGlobal('URL', {
    createObjectURL: (blob: Blob) => {
      const id = `blob:mock-${++seq}`;
      urls.set(id, blob);
      return id;
    },
    revokeObjectURL: (id: string) => {
      urls.delete(id);
    },
  });
  vi.stubGlobal(
    'Audio',
    class {
      preload = '';
      duration = durationS;
      onloadedmetadata: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private _src = '';
      get src(): string {
        return this._src;
      }
      set src(value: string) {
        this._src = value;
        queueMicrotask(() => this.onloadedmetadata?.());
      }
    },
  );
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
    vi.unstubAllGlobals();
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

  it('passes through a single file without decoding to WAV', async () => {
    stubMediaProbe(3.25);
    const file = fileNamed('solo.mp3');
    const decodeSpy = vi.fn();
    const ctx = { decodeAudioData: decodeSpy, close: vi.fn() } as unknown as AudioContext;

    const { blob, durationS, partDurationsS } = await stitchAudioFiles([file], ctx);

    expect(durationS).toBeCloseTo(3.25, 5);
    expect(partDurationsS).toEqual([3.25]);
    expect(blob).toBe(file);
    expect(blob.type).toBe('audio/mpeg');
    expect(decodeSpy).not.toHaveBeenCalled();
  });
});
