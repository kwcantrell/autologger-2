import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeamAwareClip } from '../../../shared/utils/audioClips';
import {
  type AudioClipLite,
  WF_DB_FLOOR,
  WF_TIMELINE_BUCKETS,
} from '../../../shared/utils/waveformMerge';
import { useWaveforms } from './useWaveforms';

const decode = vi.fn();
vi.mock('../../../shared/utils/waveformDecode', () => ({
  fetchAndDecodeWaveformPeaks: (...a: unknown[]) => decode(...a),
}));
// The segments list the mocked query returns; a test replaces `audio.data` to simulate an
// `audio.changed` refetch (a new object identity, as react-query would hand out).
const audio = vi.hoisted(() => ({
  data: { segments: [{ id: 's1' }, { id: 's2' }] } as { segments: object[] },
}));
vi.mock('../../../api/hooks/useAudio', () => ({
  useAudioSegments: () => ({ data: audio.data }),
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
  audio.data = { segments: [{ id: 's1' }, { id: 's2' }] };
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

// media-worker D16 (web-session-console): the browser never decodes a segment the server is still
// processing, shows "Waveform unavailable" for a failed one without trying, prefers the server's
// peaks, and draws a merged segment's peaks across its seam clips by media offset.
describe('useWaveforms and server media processing (media-worker D16)', () => {
  const withStatus = (c: AudioClipLite, mediaStatus: SeamAwareClip['mediaStatus']) =>
    ({ ...c, mediaStatus }) as SeamAwareClip;

  it('does not decode a pending segment', async () => {
    decode.mockResolvedValue(new Float32Array(16).fill(0.5));
    const c = [withStatus(clip('s1', 0), 'pending')];
    const { result, rerender } = renderHook(({ c }) => useWaveforms('sess', c, 10), {
      initialProps: { c },
    });
    rerender({ c: [...c] });
    await act(async () => undefined);
    expect(decode).not.toHaveBeenCalled();
    expect(result.current.isDecoding).toBe(false);
    expect(result.current.unavailable).toBe(false);
  });

  it('still decodes a legacy segment whose media_status is null', async () => {
    decode.mockResolvedValue(new Float32Array(16).fill(0.5));
    const c = [clip('s1', 0)];
    const { result, rerender } = renderHook(({ c }) => useWaveforms('sess', c, 10), {
      initialProps: { c },
    });
    rerender({ c: [...c] });
    await waitFor(() => expect(decode).toHaveBeenCalled());
    await waitFor(() => expect(result.current.mergedPeaks?.some((v) => v > 0)).toBe(true));
  });

  it('marks a failed segment unavailable without a decode attempt', async () => {
    const c = [withStatus(clip('s1', 0), 'failed')];
    const { result, rerender } = renderHook(({ c }) => useWaveforms('sess', c, 10), {
      initialProps: { c },
    });
    rerender({ c: [...c] });
    await waitFor(() => expect(result.current.unavailable).toBe(true));
    expect(decode).not.toHaveBeenCalled();
    expect(result.current.isDecoding).toBe(false);
  });

  it('server peaks arriving for a pending segment replace the placeholder', async () => {
    const c = [withStatus(clip('s1', 0), 'pending')];
    const { result, rerender } = renderHook(({ c }) => useWaveforms('sess', c, 10), {
      initialProps: { c },
    });
    rerender({ c: [...c] });
    await act(async () => undefined);
    expect(result.current.mergedPeaks?.some((v) => v > 0) ?? false).toBe(false);
    audio.data = {
      segments: [
        { id: 's1', waveform_peaks: new Array(16).fill(0.7), waveform_db_floor: WF_DB_FLOOR },
      ],
    };
    rerender({ c: [withStatus(clip('s1', 0), 'done')] });
    await waitFor(() => expect(result.current.mergedPeaks?.some((v) => v > 0.6)).toBe(true));
    expect(decode).not.toHaveBeenCalled();
  });

  it('draws a merged segment’s peaks across its seam clips by media offset', async () => {
    // Merged segment `m`: 20 s of media, quiet first half (0.2), loud second half (0.8). Its two
    // seam clips sit at timeline [0, 10) and [15, 25): a 5 s gap the merged file does not have.
    const peaks = [...new Array(8).fill(0.2), ...new Array(8).fill(0.8)];
    audio.data = {
      segments: [{ id: 'm', waveform_peaks: peaks, waveform_db_floor: WF_DB_FLOOR }],
    };
    const seamClip = (startSec: number, mediaOffsetSec: number): SeamAwareClip => ({
      segmentId: 'm',
      url: '/m',
      startSec,
      endSec: startSec + 10,
      duration: 10,
      missingAudio: false,
      mediaOffsetSec,
      mediaDurationSec: 20,
      mediaStatus: 'done',
    });
    const c = [seamClip(0, 0), seamClip(15, 10)];
    const total = 25;
    const { result, rerender } = renderHook(({ c }) => useWaveforms('sess', c, total), {
      initialProps: { c },
    });
    rerender({ c: [...c] });
    await waitFor(() => expect(result.current.mergedPeaks).not.toBeNull());
    const merged = result.current.mergedPeaks as Float32Array;
    const at = (sec: number) => merged[Math.floor((sec / total) * WF_TIMELINE_BUCKETS)];
    expect(at(5)).toBeCloseTo(0.2, 2);
    expect(at(12)).toBe(0);
    expect(at(20)).toBeCloseTo(0.8, 2);
    expect(decode).not.toHaveBeenCalled();
  });
});
