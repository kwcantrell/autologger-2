import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioClipLite } from '../../../shared/utils/waveformMerge';
import { useWaveforms } from './useWaveforms';

const decode = vi.fn();
vi.mock('../../../shared/utils/waveformDecode', () => ({
  fetchAndDecodeWaveformPeaks: (...a: unknown[]) => decode(...a),
}));
vi.mock('../../../api/hooks/useAudio', () => ({
  useAudioSegments: () => ({ data: { segments: [{ id: 's1' }, { id: 's2' }] } }),
  useUploadWaveform: () => ({ mutateAsync: vi.fn(async () => undefined) }),
}));

const clip = (id: string, startSec: number): AudioClipLite => ({
  segmentId: id,
  url: `/${id}`,
  startSec,
  endSec: startSec + 10,
  duration: 10,
  missingAudio: false,
});

beforeEach(() => {
  decode.mockReset();
  vi.stubGlobal(
    'AudioContext',
    class {
      resume = async () => undefined;
      close = async () => undefined;
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('useWaveforms availability', () => {
  it('is decoding while in flight, then unavailable (not decoding) after failure', async () => {
    let reject: (e: Error) => void = () => undefined;
    decode.mockImplementation(
      () =>
        new Promise((_, r) => {
          reject = r;
        }),
    );
    const { result, rerender } = renderHook(({ c }) => useWaveforms('sess', c, 10), {
      initialProps: { c: [clip('s1', 0)] },
    });
    // The session-reset effect runs after the first layout effect; clips arrive again afterwards.
    rerender({ c: [clip('s1', 0)] });
    await waitFor(() => expect(result.current.isDecoding).toBe(true));
    expect(result.current.unavailable).toBe(false);
    await act(async () => reject(new Error('oom')));
    await waitFor(() => expect(result.current.isDecoding).toBe(false));
    expect(result.current.unavailable).toBe(true);
    expect(result.current.mergedPeaks?.every((v) => v === 0)).toBe(true);
  });

  it('keeps peaks of successful segments and flags the failed one; no retry on layout growth', async () => {
    decode.mockImplementation(async (url: string) => {
      if (url === '/s2') throw new Error('too large');
      return new Float32Array(16).fill(0.5);
    });
    const c1 = [clip('s1', 0), clip('s2', 10)];
    const { result, rerender } = renderHook(({ c }) => useWaveforms('sess', c, 20), {
      initialProps: { c: c1 },
    });
    rerender({ c: [...c1] });
    await waitFor(() => expect(result.current.isDecoding).toBe(false));
    const calls = decode.mock.calls.length;
    expect(result.current.unavailable).toBe(true);
    expect(result.current.mergedPeaks?.some((v) => v > 0)).toBe(true);
    rerender({ c: [...c1, clip('s1', 20)] });
    await act(async () => undefined);
    expect(decode).toHaveBeenCalledTimes(calls);
  });
});
