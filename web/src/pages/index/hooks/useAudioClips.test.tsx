import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../../../api/client';
import { audioSegmentsKeys } from '../../../api/hooks/useAudio';
import type { AudioSyncFromDiskResponse } from '../../../api/types';
import { useAudioClips } from './useAudioClips';

// --- sync-from-disk consumption (perf-fixes B3) ---
//
// The once-per-session sync-from-disk POST returns counts only (perf-fixes A3
// server shape). The hook reads exactly one of them: `inserted > 0` triggers a
// single invalidation of the session's audio-segments query so rows the scan
// just created show up without a reload; `inserted === 0` (the common case —
// nothing new on disk) must trigger nothing. The invalidation is observed via
// a spy on the QueryClient, filtered to the audio-segments key, because the
// hook's queries invalidate nothing else on this path.

vi.mock('../../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../api/client')>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);
const SESSION_ID = 'sess-sync-consume-1';

function mockRoutes(sync: AudioSyncFromDiskResponse) {
  mockedApiFetch.mockImplementation(async (path: string) => {
    if (path.includes('/status')) return null;
    // Checked before the plain segments GET — the sync path contains
    // '/audio/segments' too.
    if (path.includes('/sync-from-disk')) return sync;
    if (path.includes('/audio/segments')) return { segments: [], has_audio: false };
    throw new Error(`unexpected apiFetch call: ${path}`);
  });
}

const syncCalls = () =>
  mockedApiFetch.mock.calls.filter(([path]) => String(path).includes('/sync-from-disk'));

beforeEach(() => {
  mockedApiFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderClips() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const utils = renderHook(() => useAudioClips(SESSION_ID, []), { wrapper });
  const audioInvalidations = () =>
    invalidate.mock.calls.filter(
      ([arg]) =>
        JSON.stringify((arg as { queryKey?: unknown })?.queryKey) ===
        JSON.stringify(audioSegmentsKeys.bySession(SESSION_ID)),
    ).length;
  return { ...utils, qc, audioInvalidations };
}

describe('useAudioClips — sync-from-disk consumption (perf-fixes B3)', () => {
  it('inserted 0 → no audio-segments invalidation', async () => {
    mockRoutes({ inserted: 0, updated: 0, scanned: 3, has_audio: true });
    const { audioInvalidations } = renderClips();

    await waitFor(() => expect(syncCalls()).toHaveLength(1));
    // Let the resolved .then chain settle before asserting the negative.
    await Promise.resolve();
    await Promise.resolve();

    expect(audioInvalidations()).toBe(0);
  });

  it('inserted 2 → exactly one audio-segments invalidation', async () => {
    mockRoutes({ inserted: 2, updated: 0, scanned: 5, has_audio: true });
    const { audioInvalidations } = renderClips();

    await waitFor(() => expect(audioInvalidations()).toBe(1));
    expect(syncCalls()).toHaveLength(1);
    // Settled: no further invalidations trail in.
    await Promise.resolve();
    await Promise.resolve();
    expect(audioInvalidations()).toBe(1);
  });
});
