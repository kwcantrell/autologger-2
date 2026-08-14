import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../api/client';
import type { SessionStatus } from '../../../api/types';
import { useAudioClips } from './useAudioClips';

// --- CW-5: the segment-duration fast path was dead code (web-api-shape-
// conformance audit, task 3.5) ---
//
// `AudioSegment` declared `duration_sec`, and `useAudioClips` read it to skip
// the `HTMLAudioElement` metadata probe ("server-provided duration wins").
// `segmentApiDict` has never emitted the field — `AudioSegmentMeta` has no such
// property — so `Number(s.duration_sec)` was always `NaN`, the
// `Number.isFinite && > 0` guard always failed, and every segment fell through
// to the probe anyway. The branch read as an intentional optimization while
// being unreachable in production.
//
// This is the one finding of the nine with a LIVE consumer, so unlike the
// type-level checks in `api/types.conformance.test.ts` it gets a behavioural
// test: the clip layout's duration must come from the probe. The wire payload
// below deliberately carries a `duration_sec` the client type does not declare
// (additive tolerance) with a value that contradicts the probe — if anything
// ever starts trusting a server-sent duration again, this test fails loudly
// instead of the clip silently resizing.

vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);
const SESSION_ID = 'sess-duration-probe-1';
const PROBE_DURATION_SEC = 42;
const WIRE_DURATION_SEC = 999; // never emitted in production; must be ignored

const probedUrls: string[] = [];

/** Minimal `HTMLAudioElement` stand-in: jsdom cannot load media, so the real
 *  element only ever fires `error`. Resolves `loadedmetadata` with a known
 *  duration so the probe's contribution to the layout is observable. */
class FakeAudio extends EventTarget {
  preload = '';
  duration = PROBE_DURATION_SEC;
  #src = '';
  get src(): string {
    return this.#src;
  }
  set src(value: string) {
    this.#src = value;
    probedUrls.push(value);
    queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')));
  }
  removeAttribute(): void {}
  load(): void {}
}

function statusFixture(): SessionStatus {
  return {
    is_rolling: false,
    timecode: '00:01:00:00',
    session_timecode: '00:01:00:00',
    master_timecode: '00:01:00:00',
    frame_rate: 24,
    current_take: 0,
    audio_recording_lease_alive: false,
    audio_recording_lease_holder_id: null,
    event_count: 0,
    logged_event_count: 0,
    title: 'Duration probe session',
    deck_title: '',
    show_name: null,
    show_code: null,
    episode: '',
    session_created_at_utc: null,
    now_utc: '2026-07-27T00:01:00Z',
    notes: '',
    show_id: null,
    events_stream_revision: 1,
  };
}

// `segmentApiDict`'s nine keys, plus the undeclared `duration_sec` this test
// exists to prove is ignored. Not typed `AudioSegment` on purpose — the extra
// key is the point.
const WIRE_SEGMENT = {
  id: 'seg-a',
  ordinal: 0,
  recording_ordinal: 1,
  started_at_utc: '2026-07-27T00:00:05Z',
  ended_at_utc: null,
  mime_type: 'audio/webm',
  url: 'blob:seg-a',
  waveform_peaks: null,
  waveform_db_floor: null,
  duration_sec: WIRE_DURATION_SEC,
};

beforeEach(() => {
  probedUrls.length = 0;
  mockedApiFetch.mockReset();
  mockedApiFetch.mockImplementation(async (path: string) => {
    if (path.includes('/status')) return statusFixture();
    // The disk-sync POST (checked before the plain segments GET — its path
    // contains '/audio/segments' too). Nothing inserted: no invalidation.
    if (path.includes('/sync-from-disk')) {
      return { inserted: 0, updated: 0, scanned: 1, has_audio: true };
    }
    if (path.includes('/audio/segments')) return { segments: [WIRE_SEGMENT], has_audio: true };
    throw new Error(`unexpected apiFetch call: ${path}`);
  });
  vi.stubGlobal('Audio', FakeAudio);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useAudioClips segment durations (audit CW-5)', () => {
  it('probes every segment and uses the probed duration, not a wire `duration_sec`', async () => {
    const { result } = renderHook(() => useAudioClips(SESSION_ID, []), { wrapper });

    await waitFor(() => expect(result.current.clips).toHaveLength(1));
    await waitFor(() => expect(result.current.clips[0].duration).toBe(PROBE_DURATION_SEC));

    // The probe ran — the removed fast path would have skipped it outright.
    expect(probedUrls).toEqual(['blob:seg-a']);
    expect(result.current.clips[0].duration).not.toBe(WIRE_DURATION_SEC);
  });
});
