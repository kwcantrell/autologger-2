import { describe, expect, it, vi } from 'vitest';
import {
  fetchAndDecodeWaveformPeaks,
  WAVEFORM_DECODE_MAX_BYTES,
  WaveformTooLargeError,
} from './waveformDecode';

function fakeResponse(headers: Record<string, string>, chunks: number[] = []) {
  const cancel = vi.fn(async () => undefined);
  const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
  let i = 0;
  const read = vi.fn(async () =>
    i < chunks.length
      ? { done: false, value: new Uint8Array(chunks[i++]) }
      : { done: true, value: undefined },
  );
  const res = {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    arrayBuffer,
    body: { cancel, getReader: () => ({ read, cancel }) },
  };
  return { res, cancel, arrayBuffer, read };
}

describe('fetchAndDecodeWaveformPeaks size guard', () => {
  it('skips an oversize file by Content-Length without reading the body', async () => {
    const { res, cancel, arrayBuffer, read } = fakeResponse({
      'content-length': String(WAVEFORM_DECODE_MAX_BYTES + 1),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res),
    );
    const decodeAudioData = vi.fn();
    await expect(
      fetchAndDecodeWaveformPeaks('/a.wav', { decodeAudioData } as unknown as AudioContext),
    ).rejects.toBeInstanceOf(WaveformTooLargeError);
    expect(cancel).toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(decodeAudioData).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('stops streaming once the cap is exceeded when Content-Length is absent', async () => {
    const half = Math.floor(WAVEFORM_DECODE_MAX_BYTES / 2) + 1;
    const { res, cancel, arrayBuffer, read } = fakeResponse({}, [half, half, half]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res),
    );
    await expect(
      fetchAndDecodeWaveformPeaks('/a.wav', {} as unknown as AudioContext),
    ).rejects.toBeInstanceOf(WaveformTooLargeError);
    expect(read).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
