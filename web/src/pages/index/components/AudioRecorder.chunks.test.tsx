import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, act as rtlAct } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../api/client';
import type { LogEvent } from '../../../api/types';
import { showToast } from '../../../shared/components/Toast';
import { createWorkerInterval } from '../../../shared/utils/workerInterval';
import { FakeLockRegistry } from '../../../test/fakes/locks';
import { FakeWakeLock } from '../../../test/fakes/wakeLock';
import { type ChunkStore, createChunkStore, setChunkStoreForTesting } from '../utils/chunkStore';
import { createMemoryBackend } from '../utils/chunkStore/memoryBackend';
import { getChunkUploadQueue, resetChunkUploadQueueForTesting } from '../utils/chunkUploadQueue';
import type { AudioRecorderHandle } from './AudioRecorder';
import { AudioRecorder, deriveNextOrdinal } from './AudioRecorder';

// --- AudioRecorder chunk rollover wiring (chunked-live-recording, task 4.2) ---
//
// Drives the real component against a fake MediaRecorder/stream (the
// AudioRecorder.meter.test.tsx pattern) and the REAL chunk upload queue
// (module singleton, reset per test) over a stubbed global fetch, so the
// enqueue→pump→POST path is exercised end to end. Required cases from the
// task: heartbeat-across-rollover, D8 ordinal derivation (never
// segments.length + 1), rollover chunk with its own startedAtUtc + shared
// recording ordinal, and mid-take uploads never flipping phase. Plus:
// final-drain success/failure (drain_blocked + toast interim surfacing),
// unexpected onstop (no restart on a dead stream), session binding across a
// prop switch, per-chunk waveform PUT, and zero-byte final chunk.

const h = vi.hoisted(() => ({
  userId: 'user-1' as string | null,
  profileState: 'ok' as 'ok' | 'error' | 'pending',
  segments: [] as { recording_ordinal: number | null }[],
  events: [] as Partial<LogEvent>[],
  // mutateAsync since session-leases D7: the recorder acts on the heartbeat's `{ok}` answer.
  heartbeatMutate: vi.fn(
    async (_vars: { sessionId: string; client_id: string }): Promise<{ ok: boolean }> => ({
      ok: true,
    }),
  ),
  logEventMutateAsync: vi.fn(async (_body: { category: string; message: string }) => ({})),
  claimMutateAsync: vi.fn(
    async (_vars: { sessionId: string; client_id: string }): Promise<unknown> => ({}),
  ),
  releaseMutateAsync: vi.fn(async (_vars: { sessionId: string; client_id: string }) => ({})),
}));

vi.mock('../../../api/hooks/useAudio', () => ({
  // NOT the real key literal — the factory module is its single owner
  // (queryKeyFactories.repo.test.ts); tests only need a stable mock key.
  audioSegmentsKeys: { bySession: (id: string | null) => ['audio-segments-mock', id] as const },
  useAudioSegments: () => ({ data: { segments: h.segments } }),
  useClaimAudioLease: () => ({ mutateAsync: h.claimMutateAsync }),
  useHeartbeatAudioLease: () => ({ mutateAsync: h.heartbeatMutate }),
  useReleaseAudioLease: () => ({ mutateAsync: h.releaseMutateAsync }),
}));
vi.mock('../../../api/hooks/useEvents', () => ({
  WORKSPACE_EVENTS_LIMIT: 2000,
  useEvents: () => ({ data: { events: h.events } }),
  useLogEvent: () => ({ mutateAsync: h.logEventMutateAsync }),
}));
vi.mock('../../../shared/components/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../../api/hooks/useProfile', () => ({
  useProfile: () =>
    h.profileState === 'error'
      ? { data: undefined, isError: true }
      : h.profileState === 'pending'
        ? { data: undefined, isError: false }
        : { data: { auth: { user: h.userId ? { id: h.userId } : null } }, isError: false },
}));
// media-worker A.5: the recorder's timers run on worker intervals (jsdom has no Worker, so the
// real helper falls back to the faked setInterval; the spy records who asked for which period).
vi.mock('../../../shared/utils/workerInterval', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../shared/utils/workerInterval')>();
  return { createWorkerInterval: vi.fn(real.createWorkerInterval) };
});

/**
 * `act` that also drains the chunk store's promise chains (media-worker D10: every slice is
 * appended asynchronously and a chunk is enqueued once its bytes are persisted). Real
 * `setTimeout` is not faked in this file, so a few macrotask turns settle them.
 */
async function act(fn: () => unknown): Promise<void> {
  await rtlAct(async () => {
    await fn();
  });
  for (let i = 0; i < 6; i += 1) {
    await rtlAct(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));
  createAnalyser = vi.fn(() => ({
    fftSize: 512,
    smoothingTimeConstant: 0,
    getByteTimeDomainData: (data: Uint8Array) => data.fill(128),
  }));
  decodeAudioData = vi.fn(async () => ({
    duration: 10,
    numberOfChannels: 1,
    length: 1000,
    sampleRate: 100,
    getChannelData: () => new Float32Array(1000).fill(0.5),
  }));
  constructor() {
    FakeAudioContext.instances.push(this);
  }
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  /** When false, stop() delivers no data — simulates a zero-byte chunk. */
  static emitData = true;
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(public stream: MediaStream) {
    FakeMediaRecorder.instances.push(this);
  }
  timeslice: number | undefined;
  requestData = vi.fn();
  start(timeslice?: number) {
    this.timeslice = timeslice;
    this.state = 'recording';
  }
  /** Deliver one timeslice, as the browser does every `timeslice` ms. */
  emitSlice(bytes: number) {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)], { type: 'audio/webm' }) });
  }
  stop() {
    this.state = 'inactive';
    if (FakeMediaRecorder.emitData) {
      this.ondataavailable?.({ data: new Blob([new Uint8Array(8)], { type: 'audio/webm' }) });
    }
    this.onstop?.();
  }
}

let uploadStatus: number | null = null; // null => uploads succeed
/** The next N segment POSTs answer this transient failure, then uploads succeed (A.9). */
let failNext: { count: number; mode: 503 | 'network' } = { count: 0, mode: 503 };
let uploadBarrier: Promise<void> | null = null; // when set, segment POSTs wait on it
let segCounter = 0;

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status-${status}`,
    headers: { get: (name: string) => (/content-type/i.test(name) ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  if (method === 'POST' && url.includes('/audio/segments?')) {
    if (uploadBarrier) await uploadBarrier;
    if (failNext.count > 0) {
      failNext.count -= 1;
      if (failNext.mode === 'network') throw new TypeError('Failed to fetch');
      return jsonResponse({ detail: 'busy' }, failNext.mode);
    }
    if (uploadStatus != null) return jsonResponse({ detail: 'upload rejected' }, uploadStatus);
    const u = new URL(url, 'http://localhost');
    segCounter += 1;
    return jsonResponse({
      id: `seg-${segCounter}`,
      ordinal: segCounter,
      recording_ordinal: Number(u.searchParams.get('recording_ordinal')),
      started_at_utc: u.searchParams.get('started_at_utc'),
      ended_at_utc: u.searchParams.get('ended_at_utc'),
      mime_type: 'audio/webm',
      url: '',
      waveform_peaks: null,
      waveform_db_floor: null,
    });
  }
  if (method === 'PUT' && url.endsWith('/waveform')) return jsonResponse({ ok: true });
  if (method === 'GET' && url.endsWith('/audio/segments')) {
    return jsonResponse({ segments: [], has_audio: false });
  }
  return jsonResponse({});
});

function segmentPosts(): string[] {
  return fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        (init?.method ?? 'GET') === 'POST' && String(input).includes('/audio/segments?'),
    )
    .map(([input]) => String(input));
}

function waveformPuts(): string[] {
  return fetchMock.mock.calls
    .filter(
      ([input, init]) => (init?.method ?? 'GET') === 'PUT' && String(input).endsWith('/waveform'),
    )
    .map(([input]) => String(input));
}

function finalizePosts(): Array<{ url: string; body: unknown }> {
  return fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        (init?.method ?? 'GET') === 'POST' &&
        /\/audio\/recordings\/\d+\/finalize$/.test(String(input)),
    )
    .map(([input, init]) => ({ url: String(input), body: JSON.parse(String(init?.body)) }));
}

function paramOf(url: string, name: string): string | null {
  return new URL(url, 'http://localhost').searchParams.get(name);
}

const fakeTrack = { readyState: 'live', stop: vi.fn() };
const fakeStream = {
  getTracks: () => [fakeTrack],
  getAudioTracks: () => [fakeTrack],
} as unknown as MediaStream;
let store: ChunkStore;

const CHUNK_MS_TEST = 10_000;
const T0 = new Date('2026-08-12T10:00:00.000Z');

let rafQueue: FrameRequestCallback[] = [];

beforeEach(() => {
  h.segments = [];
  h.events = [];
  h.heartbeatMutate.mockClear();
  h.logEventMutateAsync.mockClear();
  h.claimMutateAsync.mockClear();
  h.releaseMutateAsync.mockClear();
  vi.mocked(showToast).mockClear();
  fetchMock.mockClear();
  uploadStatus = null;
  failNext = { count: 0, mode: 503 };
  uploadBarrier = null;
  segCounter = 0;
  fakeTrack.readyState = 'live';
  FakeAudioContext.instances = [];
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.emitData = true;
  rafQueue = [];
  h.userId = 'user-1';
  h.profileState = 'ok';
  resetChunkUploadQueueForTesting();
  store = createChunkStore({ backends: [() => createMemoryBackend()], warn: () => {} });
  setChunkStoreForTesting(store);
  vi.mocked(createWorkerInterval).mockClear();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => fakeStream) },
  });
});

afterEach(async () => {
  // Unmount now and let the unmount's final stop persist, enqueue and upload before the next
  // test (the chunk store makes that asynchronous).
  cleanup();
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 0));
  resetChunkUploadQueueForTesting();
  setChunkStoreForTesting(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
  document.body.innerHTML = '';
  document.body.classList.remove('v4-is-recording', 'v4-local-recording');
});

function renderRecorder(
  sessionId = 'sess-A',
  extra: { micRetryWindowMs?: number; scanTimeoutMs?: number } = {},
) {
  const ref = createRef<AudioRecorderHandle>();
  const onPhaseChange = vi.fn();
  const queryClient = new QueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AudioRecorder
        ref={ref}
        sessionId={sessionId}
        onPhaseChange={onPhaseChange}
        chunkMs={CHUNK_MS_TEST}
        {...extra}
      />
    </QueryClientProvider>,
  );
  const rerenderWith = (nextSessionId: string) =>
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <AudioRecorder
          ref={ref}
          sessionId={nextSessionId}
          onPhaseChange={onPhaseChange}
          chunkMs={CHUNK_MS_TEST}
          {...extra}
        />
      </QueryClientProvider>,
    );
  return { ref, onPhaseChange, view, rerenderWith };
}

async function startRecording(sessionId = 'sess-A') {
  const utils = renderRecorder(sessionId);
  await act(async () => {}); // the recovery scan completes before Record is enabled
  await act(async () => {
    await utils.ref.current?.toggle();
  });
  return utils;
}

describe('deriveNextOrdinal (design D8)', () => {
  it('takes the max across segments, Recording-N events, and queued ordinals — never segments.length + 1', () => {
    const segs = [{ recording_ordinal: 1 }, { recording_ordinal: 3 }];
    const events = [{ category: 'internal', message: 'Recording 4 Started' }];
    // segments.length + 1 would be 3 — explicitly NOT the answer.
    expect(deriveNextOrdinal(segs, events, [])).toBe(5);
    expect(deriveNextOrdinal(segs, events, [])).not.toBe(segs.length + 1);
  });

  it('counts rescue-queued ordinals and ignores null ordinals and non-internal events', () => {
    expect(deriveNextOrdinal(undefined, undefined, [7])).toBe(8);
    expect(deriveNextOrdinal([{ recording_ordinal: null }], [], [])).toBe(1);
    expect(deriveNextOrdinal([], [{ category: 'note', message: 'Recording 9 Started' }], [])).toBe(
      1,
    );
  });
});

describe('AudioRecorder chunk rollover (task 4.2)', () => {
  it('keeps the heartbeat and recording indication alive across a rollover', async () => {
    const { ref } = await startRecording();
    expect(document.body.classList.contains('v4-is-recording')).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(8_000); // first heartbeat
    });
    expect(h.heartbeatMutate).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(2_000); // rollover boundary at 10 s
    });
    // The boundary stopped recorder 1 and immediately started recorder 2 on
    // the same stream (design D1).
    expect(FakeMediaRecorder.instances).toHaveLength(2);
    expect(FakeMediaRecorder.instances[1].state).toBe('recording');
    expect(FakeMediaRecorder.instances[1].stream).toBe(fakeStream);

    await act(async () => {
      vi.advanceTimersByTime(6_000); // heartbeat again at 16 s — interval survived the rollover
    });
    expect(h.heartbeatMutate).toHaveBeenCalledTimes(2);
    expect(ref.current?.isRecording()).toBe(true);
    expect(document.body.classList.contains('v4-is-recording')).toBe(true);
    expect(document.body.classList.contains('v4-local-recording')).toBe(true);
  });

  it('derives the recording ordinal per D8 (segments [1,3] + Recording 4 events → 5)', async () => {
    h.segments = [{ recording_ordinal: 1 }, { recording_ordinal: 3 }];
    h.events = [
      { category: 'internal', message: 'Recording 4 Started' },
      { category: 'internal', message: 'Recording 4 Stopped' },
    ];
    const { ref } = await startRecording();

    expect(h.logEventMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Recording 5 Started' }),
    );
    // segments.length + 1 (= 3) explicitly NOT used:
    expect(h.logEventMutateAsync).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Recording 3 Started' }),
    );

    await act(async () => {
      await ref.current?.toggle();
    });
    const posts = segmentPosts();
    expect(posts).toHaveLength(1);
    expect(paramOf(posts[0], 'recording_ordinal')).toBe('5');
  });

  it('rollover enqueues a second chunk with its own startedAtUtc and the same recording ordinal', async () => {
    const { ref } = await startRecording();
    await act(async () => {
      vi.advanceTimersByTime(CHUNK_MS_TEST); // rollover → chunk 0 uploads
    });
    await act(async () => {
      await ref.current?.toggle(); // final stop → chunk 1 uploads
    });

    const posts = segmentPosts();
    expect(posts).toHaveLength(2);
    expect(paramOf(posts[0], 'recording_ordinal')).toBe('1');
    expect(paramOf(posts[1], 'recording_ordinal')).toBe('1');
    // Chunk 0 started at recording start; chunk 1 at its OWN capture start
    // (the rollover boundary), not the recording's (design D3).
    expect(paramOf(posts[0], 'started_at_utc')).toBe(T0.toISOString());
    expect(paramOf(posts[1], 'started_at_utc')).toBe(
      new Date(T0.getTime() + CHUNK_MS_TEST).toISOString(),
    );
  });

  it('mid-take uploads never flip phase, show the overlay, or touch the seek-overlay DOM', async () => {
    const seekOverlay = document.createElement('div');
    seekOverlay.id = 'timeline-audio-seek-overlay';
    seekOverlay.classList.add('hidden');
    document.body.appendChild(seekOverlay);

    const { ref, onPhaseChange } = await startRecording();
    onPhaseChange.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(CHUNK_MS_TEST);
    });

    expect(segmentPosts()).toHaveLength(1); // the chunk really uploaded mid-take
    expect(onPhaseChange).not.toHaveBeenCalled(); // no phase change of any kind
    expect(ref.current?.isRecording()).toBe(true);
    expect(ref.current?.isUploading()).toBe(false);
    expect(seekOverlay.classList.contains('hidden')).toBe(true); // mid-take path never toggles it
  });

  it('final stop logs one Stopped event, releases the lease once, drains, and reaches idle', async () => {
    const { ref, onPhaseChange } = await startRecording();
    await act(async () => {
      vi.advanceTimersByTime(CHUNK_MS_TEST); // one rollover, so the take is multi-chunk
    });

    // Hold the final drain's upload open so the 'uploading' phase (which
    // owns the full-screen saving presentation) is observable rather than
    // collapsing into the same render flush as DONE.
    let releaseUploads!: () => void;
    uploadBarrier = new Promise<void>((resolve) => {
      releaseUploads = resolve;
    });
    await act(async () => {
      await ref.current?.toggle();
    });
    expect(ref.current?.isUploading()).toBe(true);
    expect(onPhaseChange.mock.calls.at(-1)?.[0]).toBe('uploading');

    await act(async () => {
      releaseUploads();
      uploadBarrier = null;
    });

    expect(segmentPosts()).toHaveLength(2);
    const startedCalls = h.logEventMutateAsync.mock.calls.filter(
      ([b]) => b.message === 'Recording 1 Started',
    );
    const stoppedCalls = h.logEventMutateAsync.mock.calls.filter(
      ([b]) => b.message === 'Recording 1 Stopped',
    );
    expect(startedCalls).toHaveLength(1); // exactly one event pair for the whole take
    expect(stoppedCalls).toHaveLength(1);
    expect(h.releaseMutateAsync).toHaveBeenCalledTimes(1);

    const phases = onPhaseChange.mock.calls.map(([p]) => p);
    expect(phases).toContain('uploading'); // the final drain owns the saving presentation
    expect(phases[phases.length - 1]).toBe('idle');
    expect(document.body.classList.contains('v4-local-recording')).toBe(false);
  });

  it('a barrier-held rollover upload still drains to DONE on stop — no drain_blocked, no error toast (F1)', async () => {
    const { ref, onPhaseChange } = await startRecording();

    // Hold every segment POST open (including the mid-take rollover
    // upload) so we can force the stop-time drain to race an in-flight
    // pump — the exact scenario F1 fixes: a collapsed pump() call must not
    // resolve as if the queue had already drained.
    let releaseUploads!: () => void;
    uploadBarrier = new Promise<void>((resolve) => {
      releaseUploads = resolve;
    });

    await act(async () => {
      vi.advanceTimersByTime(CHUNK_MS_TEST); // rollover: chunk 0 enqueued, pump() fires and blocks on the barrier
    });
    // The rollover's upload attempt has started (the fetch call is made)
    // but is still blocked on the barrier — the queue is still in flight,
    // not yet drained.
    expect(segmentPosts()).toHaveLength(1);
    const queueMidBarrier = getChunkUploadQueue({
      upload: async () => ({ ok: false, message: 'unused' }),
      listSegments: async () => [],
      clock: { now: () => 0 },
    });
    expect(queueMidBarrier.getSnapshot().inFlight).toBe(true);

    // User stops while the rollover's pump is still in flight. toggle()'s
    // synchronous STOP_REQUESTED dispatch plus the recorder's onstop firing
    // enqueue the final chunk and call finalizeStop, whose first pump()
    // must collapse onto (not race ahead of) the still-running rollover
    // pump.
    // Not wrapped in its own act: the loop below drives React one act at a time
    // (overlapping act scopes would leave React's act queue open).
    let togglePromise!: Promise<boolean | undefined>;
    await rtlAct(async () => {
      togglePromise = ref.current?.toggle() ?? Promise.resolve(undefined);
    });

    // Release the barrier once the stop path has enqueued the final chunk and
    // is awaiting the collapsed pump (the saving presentation is up). The
    // chunk store makes the stop path asynchronous (media-worker D10), so wait
    // for that phase rather than a fixed number of microtasks.
    for (let i = 0; i < 50; i += 1) {
      if (onPhaseChange.mock.calls.some(([p]) => p === 'uploading')) break;
      await rtlAct(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
    expect(segmentPosts()).toHaveLength(1); // the final chunk still waits behind the barrier
    await act(async () => {
      releaseUploads();
      uploadBarrier = null;
    });
    await act(async () => {
      await togglePromise;
    });

    // Both chunks drained — the collapsed pump plus the fresh re-pump
    // together finish the whole queue.
    expect(segmentPosts()).toHaveLength(2);

    const phases = onPhaseChange.mock.calls.map(([p]) => p);
    expect(phases).not.toContain('drain_blocked');
    expect(vi.mocked(showToast)).not.toHaveBeenCalledWith(expect.stringContaining('failed'), true);
    // The saving presentation (UPLOAD_START) spans the real final drain.
    expect(phases).toContain('uploading');
    expect(phases[phases.length - 1]).toBe('idle');

    const queue = getChunkUploadQueue({
      upload: async () => ({ ok: false, message: 'unused' }),
      listSegments: async () => [],
      clock: { now: () => 0 },
    });
    expect(queue.getSnapshot().idle).toBe(true);
  });

  it('sends no waveform PUT and decodes nothing after a chunk upload (media-worker D5)', async () => {
    const { ref } = await startRecording();
    await act(async () => {
      vi.advanceTimersByTime(CHUNK_MS_TEST);
    });
    await act(async () => {
      await ref.current?.toggle();
    });
    expect(segmentPosts()).toHaveLength(2);
    // media-worker D5: the server computes peaks and duration; the browser no longer decodes
    // its own chunks or PUTs a waveform.
    expect(waveformPuts()).toHaveLength(0);
    for (const ctx of FakeAudioContext.instances)
      expect(ctx.decodeAudioData).not.toHaveBeenCalled();
  });

  it('binds uploads to the recording-start session even after the prop switches', async () => {
    const { ref, rerenderWith } = await startRecording('sess-A');
    rerenderWith('sess-B');
    await act(async () => {
      vi.advanceTimersByTime(CHUNK_MS_TEST); // rollover after the switch
    });
    await act(async () => {
      await ref.current?.toggle();
    });
    const posts = segmentPosts();
    expect(posts).toHaveLength(2);
    for (const url of posts) expect(url).toContain('/sessions/sess-A/');
  });

  it('final-drain failure lands in drain_blocked (toast, no idle, no new recording) and clears when the queue empties', async () => {
    uploadStatus = 404; // permanent (A.9: only a terminal failure is an error at stop)
    const { ref, onPhaseChange } = await startRecording();
    await act(async () => {
      await ref.current?.toggle();
    });

    const phases = onPhaseChange.mock.calls.map(([p]) => p);
    expect(phases[phases.length - 1]).toBe('drain_blocked');
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(expect.stringContaining('failed'), true);
    // Not idle: a new recording must be refused while chunks are queued.
    await expect(ref.current?.toggle()).resolves.toBe(false);
    expect(h.claimMutateAsync).toHaveBeenCalledTimes(1); // no second claim

    // The rescue seam (task 5.1): the module-owned queue is still reachable
    // and emptying it returns the recorder to idle.
    const queue = getChunkUploadQueue({
      upload: async () => ({ ok: false, message: 'unused' }),
      listSegments: async () => [],
      clock: { now: () => 0 },
    });
    expect(queue.getSnapshot().chunks).toHaveLength(1);
    expect(queue.getSnapshot().pendingOrdinals).toEqual([1]);
    await act(async () => {
      queue.discardAll();
    });
    expect(onPhaseChange.mock.calls.at(-1)?.[0]).toBe('idle');
  });

  it('an unexpected onstop re-acquires the microphone and continues the same take (D19)', async () => {
    const { ref, onPhaseChange } = await startRecording();
    const mr = FakeMediaRecorder.instances[0];
    await act(async () => {
      // The browser ends capture (mic unplugged): onstop fires with no reason set.
      mr.stop();
    });
    // The captured chunk is persisted and uploaded; a new chunk starts on the re-acquired input.
    expect(segmentPosts()).toHaveLength(1);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(2);
    expect(FakeMediaRecorder.instances).toHaveLength(2);
    expect(FakeMediaRecorder.instances[1].state).toBe('recording');
    expect(ref.current?.isRecording()).toBe(true);
    expect(onPhaseChange.mock.calls.at(-1)?.[0]).toBe('recording');
    // Same take: no Stopped event, no lease release, the notice names the change.
    expect(h.logEventMutateAsync).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Recording 1 Stopped' }),
    );
    expect(h.releaseMutateAsync).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Microphone changed; recording continues.');
    // The next chunk carries the next index and the same ordinal.
    await act(async () => {
      await ref.current?.toggle();
    });
    const posts = segmentPosts();
    expect(posts).toHaveLength(2);
    expect(posts.map((u) => paramOf(u, 'recording_ordinal'))).toEqual(['1', '1']);
    expect(h.logEventMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Recording 1 Stopped' }),
    );
  });

  it('a rollover boundary on a dead stream re-acquires instead of ending the take', async () => {
    const { ref } = await startRecording();
    fakeTrack.readyState = 'ended';
    const freshTrack = { readyState: 'live', stop: vi.fn() };
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce({
      getTracks: () => [freshTrack],
      getAudioTracks: () => [freshTrack],
    } as unknown as MediaStream);
    await act(async () => {
      vi.advanceTimersByTime(CHUNK_MS_TEST);
    });
    expect(FakeMediaRecorder.instances).toHaveLength(2); // a recorder on the NEW stream only
    expect(FakeMediaRecorder.instances[1].stream).not.toBe(fakeStream);
    expect(h.releaseMutateAsync).not.toHaveBeenCalled();
    expect(segmentPosts()).toHaveLength(1);
    expect(ref.current?.isRecording()).toBe(true);
  });

  it('when no microphone comes back within the window the take is finalized with the reason', async () => {
    const utils = renderRecorder('sess-A', { micRetryWindowMs: 0 });
    await act(async () => {});
    await act(async () => {
      await utils.ref.current?.toggle();
    });
    const denied = Object.assign(new Error('Requested device not found'), {
      name: 'NotFoundError',
    });
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(denied);
    await act(async () => {
      FakeMediaRecorder.instances[0].stop();
    });
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(
      expect.stringContaining('NotFoundError'),
      true,
    );
    expect(h.logEventMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Recording 1 Stopped' }),
    );
    expect(h.releaseMutateAsync).toHaveBeenCalledTimes(1);
    expect(segmentPosts()).toHaveLength(1); // what was captured still uploads
    expect(finalizePosts()).toHaveLength(1); // and the captured windows are finalized
    expect(utils.onPhaseChange.mock.calls.at(-1)?.[0]).toBe('idle');
  });

  it('unmount mid-recording still uploads the captured chunk via the module-owned queue', async () => {
    const { view } = await startRecording();
    await act(async () => {
      view.unmount();
    });
    // The queue outlives the component: the final chunk enqueued by the
    // unmount stop was pumped and uploaded after the recorder was gone.
    expect(segmentPosts()).toHaveLength(1);
    expect(h.releaseMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('a zero-byte final chunk is skipped (no upload, no error) and the recorder reaches idle', async () => {
    FakeMediaRecorder.emitData = false;
    const { ref, onPhaseChange } = await startRecording();
    await act(async () => {
      await ref.current?.toggle();
    });
    expect(segmentPosts()).toHaveLength(0);
    expect(vi.mocked(showToast)).not.toHaveBeenCalled();
    expect(onPhaseChange.mock.calls.at(-1)?.[0]).toBe('idle');
  });
});

describe('fresh-mount queue reconciliation (fix-wave F2)', () => {
  it('mounts drain_blocked (not idle) when the surviving singleton already holds a queued chunk, and toggle() refuses', async () => {
    // Seed the module-owned singleton BEFORE the component ever mounts —
    // simulates a prior mount's failed drain surviving into a fresh mount
    // (session switch, route change, remount).
    const seedQueue = getChunkUploadQueue({
      upload: async () => ({ ok: false, status: 500, message: 'still failing' }),
      listSegments: async () => [],
      clock: { now: () => 0 },
    });
    seedQueue.enqueue({
      sessionId: 'sess-A',
      recordingOrdinal: 1,
      chunkIndex: 0,
      blob: new Blob([new Uint8Array(8)]),
      startedAtUtc: T0.toISOString(),
      endedAtUtc: T0.toISOString(),
      mimeType: 'audio/webm',
    });
    expect(seedQueue.getSnapshot().idle).toBe(false);
    await seedQueue.recover('user-1'); // this page load's storage scan already ran (media-worker D10)

    const { ref, onPhaseChange } = renderRecorder('sess-A');

    // First render already reflects drain_blocked — no idle-then-flip.
    expect(onPhaseChange).toHaveBeenCalledWith('drain_blocked');
    expect(onPhaseChange).not.toHaveBeenCalledWith('idle');
    await expect(ref.current?.toggle()).resolves.toBe(false);
    expect(h.claimMutateAsync).not.toHaveBeenCalled(); // refused before any claim attempt
  });

  it("ordinal derivation ignores another session's queued ordinals (F2 hardening)", async () => {
    // Mount fresh against an EMPTY queue (idle) so the mount-reconciliation
    // guard above does not itself gate this recorder to drain_blocked —
    // this test isolates the ordinal-derivation filter, not the mount
    // guard. The recorder reaches 'idle' phase and stays there: nothing
    // reactively re-blocks an already-idle recorder when a later,
    // unrelated straggler arrives (only drain_blocked -> idle is watched).
    const { ref } = renderRecorder('sess-A');
    await act(async () => {}); // the storage scan completes

    const queue = getChunkUploadQueue({
      upload: async () => ({ ok: false, status: 500, message: 'still failing' }),
      listSegments: async () => [],
      clock: { now: () => 0 },
    });
    // A straggler from a DIFFERENT session, holding a high ordinal — must
    // not bleed into session A's derivation.
    queue.enqueue({
      sessionId: 'sess-OTHER',
      recordingOrdinal: 9,
      chunkIndex: 0,
      blob: new Blob([new Uint8Array(8)]),
      startedAtUtc: T0.toISOString(),
      endedAtUtc: T0.toISOString(),
      mimeType: 'audio/webm',
    });

    await act(async () => {
      await ref.current?.toggle();
    });

    expect(h.logEventMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Recording 1 Started' }),
    );
    expect(h.logEventMutateAsync).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Recording 10 Started' }),
    );
  });
});

describe('drain_blocked mount reconciliation (fix-wave F6/D2)', () => {
  it('reaches idle even when the queue empties in the render→subscribe gap', async () => {
    // Seed drain_blocked exactly as the F2 test above does, so the very
    // first render's lazy initializer picks 'drain_blocked'.
    const seedQueue = getChunkUploadQueue({
      upload: async () => ({ ok: false, status: 500, message: 'still failing' }),
      listSegments: async () => [],
      clock: { now: () => 0 },
    });
    seedQueue.enqueue({
      sessionId: 'sess-A',
      recordingOrdinal: 1,
      chunkIndex: 0,
      blob: new Blob([new Uint8Array(8)]),
      startedAtUtc: T0.toISOString(),
      endedAtUtc: T0.toISOString(),
      mimeType: 'audio/webm',
    });
    expect(seedQueue.getSnapshot().idle).toBe(false);
    await seedQueue.recover('user-1'); // this page load's storage scan already ran (media-worker D10)

    // Simulate the queue draining to idle in the window between the
    // component's first render (which already committed 'drain_blocked'
    // via the lazy initializer) and the mount effect actually attaching its
    // subscribe listener — the exact gap D2 closes. Wrapping `subscribe`
    // to discard-all just before delegating to the real implementation
    // reproduces "the final notify already fired, unheard" without racing
    // real async timing.
    const realSubscribe = seedQueue.subscribe;
    const subscribeSpy = vi.spyOn(seedQueue, 'subscribe').mockImplementation((listener) => {
      seedQueue.discardAll(); // drains to idle BEFORE the listener is attached
      return realSubscribe.call(seedQueue, listener);
    });

    const { onPhaseChange } = renderRecorder('sess-A');

    expect(onPhaseChange).toHaveBeenCalledWith('drain_blocked'); // first render still reflects it
    // Without D2's re-check, nothing would ever dispatch DONE here — the
    // queue's only notify fired before any listener existed.
    expect(onPhaseChange).toHaveBeenCalledWith('idle');
    expect(onPhaseChange.mock.calls.at(-1)?.[0]).toBe('idle');

    subscribeSpy.mockRestore();
  });

  it('a queue already idle at mount time (drain_blocked phase somehow stale) is reconciled on the very first effect pass', async () => {
    // A more direct construction: seed non-idle so the initializer picks
    // drain_blocked, then drain it via discardAll() BEFORE rendering at
    // all — by the time the mount effect's pre-subscribe snapshot check
    // runs, the queue is already idle.
    const seedQueue = getChunkUploadQueue({
      upload: async () => ({ ok: false, status: 500, message: 'still failing' }),
      listSegments: async () => [],
      clock: { now: () => 0 },
    });
    seedQueue.enqueue({
      sessionId: 'sess-A',
      recordingOrdinal: 1,
      chunkIndex: 0,
      blob: new Blob([new Uint8Array(8)]),
      startedAtUtc: T0.toISOString(),
      endedAtUtc: T0.toISOString(),
      mimeType: 'audio/webm',
    });
    await seedQueue.recover('user-1'); // this page load's storage scan already ran (media-worker D10)

    // Patch getSnapshot so the very FIRST call (the lazy initializer, which
    // runs before any render) still observes drain_blocked, but the queue
    // is idle by the time the mount effect's own snapshot check runs —
    // i.e. render committed 'drain_blocked' from stale-but-true-at-the-time
    // data, and the drain completed before the effect could react.
    let calls = 0;
    const realGetSnapshot = seedQueue.getSnapshot.bind(seedQueue);
    const snapSpy = vi.spyOn(seedQueue, 'getSnapshot').mockImplementation(() => {
      calls += 1;
      if (calls === 1) return realGetSnapshot(); // initializer sees drain_blocked
      seedQueue.discardAll();
      return realGetSnapshot();
    });

    const { onPhaseChange } = renderRecorder('sess-A');

    expect(onPhaseChange).toHaveBeenCalledWith('drain_blocked');
    expect(onPhaseChange.mock.calls.at(-1)?.[0]).toBe('idle');

    snapSpy.mockRestore();
  });
});

describe('finalizeStop idempotency (fix-wave F3)', () => {
  it('a stop-click racing a duplicate onstop finalizes exactly once — one Stopped event, one lease release', async () => {
    const { ref, onPhaseChange } = await startRecording();
    const mr = FakeMediaRecorder.instances[0];
    // Capture the real onstop handler before the deliberate stop runs it,
    // so it can be re-fired afterward — simulating an unexpected
    // device-loss onstop that races the user's stop-click for the SAME
    // underlying recorder/take (the double-invocation route the reviewer
    // flagged: both toggle()'s stop path and an onstop handler can reach
    // finalizeStop for one take).
    const pendingOnstop = mr.onstop;

    // Deliberate stop: toggle()'s stop branch sets reason='final' and
    // calls mr.stop(), which synchronously fires onstop → finalizeStop
    // (first call).
    await act(async () => {
      await ref.current?.toggle();
    });

    // A second, racing onstop firing for the same (now-stale) handler —
    // finalizeStop's entry guard (`takeRef.current !== take`) must make
    // this a no-op rather than a second Stopped event/lease release.
    await act(async () => {
      pendingOnstop?.();
    });

    const stoppedCalls = h.logEventMutateAsync.mock.calls.filter(
      ([b]) => b.message === 'Recording 1 Stopped',
    );
    expect(stoppedCalls).toHaveLength(1);
    expect(h.releaseMutateAsync).toHaveBeenCalledTimes(1);
    expect(onPhaseChange.mock.calls.at(-1)?.[0]).toBe('idle');
  });
});

describe('timer hygiene on unmount (fix-wave F4/F5)', () => {
  it('unmounting mid-recording clears every live interval — none survive to fire (durTimer + rolloverTimer + heartbeat)', async () => {
    const { view } = await startRecording();
    const activeCountBefore = vi.getTimerCount();
    expect(activeCountBefore).toBeGreaterThan(0); // heartbeat + rollover + durTimer all live

    await act(async () => {
      view.unmount();
    });

    // Every interval this component owns (heartbeat, rollover, and the
    // duration timer — F4's hoisted durTimerRef) is cleared by the
    // unmount cleanup itself, not left to self-clear on a next tick that
    // will never come once nothing schedules further renders.
    expect(vi.getTimerCount()).toBe(0);

    // Advancing timers after unmount is inert — no leaked interval writes
    // to the torn-down DOM or throws.
    expect(() => {
      vi.advanceTimersByTime(60_000);
    }).not.toThrow();
  });

  it('unmounting mid-recording clears the rollover timer — no further rollover after unmount', async () => {
    const { view } = await startRecording();
    await act(async () => {
      view.unmount();
    });
    const instancesAfterUnmount = FakeMediaRecorder.instances.length;

    await act(async () => {
      vi.advanceTimersByTime(CHUNK_MS_TEST * 3);
    });

    // No new chunk recorder constructed by a leaked rollover interval.
    expect(FakeMediaRecorder.instances.length).toBe(instancesAfterUnmount);
  });
});

describe('durTimer identity guard on stop-then-restart (fix-wave F6/D1)', () => {
  it('stop then immediate restart leaves exactly one live interval, no stale-duration write, and unmount clears it', async () => {
    const durEl = document.createElement('div');
    durEl.id = 'top-bar-recording-dur';
    document.body.appendChild(durEl);

    const { ref } = await startRecording(); // recording 1 starts at T0

    // Stop WITHOUT letting the durTimer's own 1s tick run — this is the
    // zombie scenario: the OLD interval is still live (toggle()'s stop
    // branch never clears durTimerRef) when the restart schedules a NEW
    // one at the same startMs granularity.
    await act(async () => {
      await ref.current?.toggle(); // stop recording 1 (finalizeStop resets the DOM to 00:00:00)
    });
    expect(durEl.textContent).toBe('00:00:00');

    await act(async () => {
      await ref.current?.toggle(); // restart — recording 2, within the same second
    });

    const timerCountAfterRestart = vi.getTimerCount();

    // Advance one full second: if the old interval survived, it would fire
    // too (writing a duration computed from the STALE startMs) alongside
    // the new one. Only one write should land, and it must reflect the NEW
    // recording's elapsed time (00:00:01), not a stale value.
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(durEl.textContent).toBe('00:00:01');

    // Exactly one durTimer interval was live post-restart — heartbeat +
    // rollover + the single durTimer, nothing extra from an orphaned old id.
    expect(timerCountAfterRestart).toBe(3);
  });

  it('a stale durTimer id cannot write after a stop-then-restart, even across many ticks', async () => {
    const durEl = document.createElement('div');
    durEl.id = 'top-bar-recording-dur';
    document.body.appendChild(durEl);

    const { ref } = await startRecording();
    await act(async () => {
      await ref.current?.toggle(); // stop
    });
    await act(async () => {
      await ref.current?.toggle(); // restart
    });

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    // Only the current recording's elapsed time is ever written — no
    // interleaved stale writes from an orphaned interval.
    expect(durEl.textContent).toBe('00:00:05');
  });

  it('unmount after a stop-then-restart clears the live durTimer (no leaked interval)', async () => {
    const durEl = document.createElement('div');
    durEl.id = 'top-bar-recording-dur';
    document.body.appendChild(durEl);

    const { ref, view } = await startRecording();
    await act(async () => {
      await ref.current?.toggle(); // stop
    });
    await act(async () => {
      await ref.current?.toggle(); // restart
    });

    await act(async () => {
      view.unmount();
    });

    expect(vi.getTimerCount()).toBe(0);
    const textAtUnmount = durEl.textContent;
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    // No further writes after unmount — the interval is gone, not merely
    // self-clearing on its own next (never-arriving) tick.
    expect(durEl.textContent).toBe(textAtUnmount);
  });
});

describe('beforeunload registration is scoped to an active recording (bfcache)', () => {
  it('an idle mount registers no beforeunload listener; starting a recording registers one', async () => {
    // A registered `beforeunload` listener disqualifies the page from the
    // back/forward cache on its mere presence — a handler that early-returns
    // for every non-recording phase still costs bfcache for the whole mount
    // span. So the registration itself, not just the handler body, is gated on
    // the recording phase.
    const addSpy = vi.spyOn(window, 'addEventListener');
    const beforeUnloadRegistrations = () =>
      addSpy.mock.calls.filter((call) => call[0] === 'beforeunload').length;
    try {
      const utils = renderRecorder();
      await act(async () => {}); // the storage scan completes
      expect(beforeUnloadRegistrations()).toBe(0);

      await act(async () => {
        await utils.ref.current?.toggle();
      });
      expect(beforeUnloadRegistrations()).toBe(1);
    } finally {
      addSpy.mockRestore();
    }
  });
});

// --- session-leases D7 (task 6.1): the recorder re-claims a refused heartbeat ---

const LOST_WARNING = 'Another window, tab, or user now holds the recording lease.';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/** One 8 s heartbeat tick, then let every response chain settle. */
async function tickLease() {
  await act(async () => {
    vi.advanceTimersByTime(8_000);
    await flush();
  });
}

const conflict = () => new ApiError(409, 'Recording lease is held by another client');
const lostWarnings = () =>
  vi.mocked(showToast).mock.calls.filter(([msg]) => msg === LOST_WARNING).length;

describe('AudioRecorder lease re-claim (session-leases D7, task 6.1)', () => {
  const resetLeaseMocks = () => {
    h.heartbeatMutate.mockReset();
    h.heartbeatMutate.mockImplementation(async () => ({ ok: true }));
    h.claimMutateAsync.mockReset();
    h.claimMutateAsync.mockImplementation(async () => ({}));
    h.releaseMutateAsync.mockReset();
    h.releaseMutateAsync.mockImplementation(async () => ({}));
  };
  beforeEach(resetLeaseMocks);
  afterEach(resetLeaseMocks);

  it('a heartbeat answering {ok:false} sends one re-claim with the same client id, and capture continues', async () => {
    const { ref } = await startRecording();
    expect(h.claimMutateAsync).toHaveBeenCalledTimes(1);
    const cid = h.claimMutateAsync.mock.calls[0][0].client_id;

    h.heartbeatMutate.mockResolvedValueOnce({ ok: false });
    await tickLease();
    expect(h.heartbeatMutate).toHaveBeenCalledTimes(1);
    expect(h.claimMutateAsync).toHaveBeenCalledTimes(2);
    expect(h.claimMutateAsync.mock.calls[1][0]).toEqual({ sessionId: 'sess-A', client_id: cid });
    expect(ref.current?.isRecording()).toBe(true);
    expect(FakeMediaRecorder.instances[0].state).toBe('recording');
    expect(lostWarnings()).toBe(0);

    // Re-claimed: back to heartbeats, no further claims.
    await tickLease();
    expect(h.heartbeatMutate).toHaveBeenCalledTimes(2);
    expect(h.claimMutateAsync).toHaveBeenCalledTimes(2);
  });

  it('a re-claim answering 409 warns once; later ticks claim instead of heartbeat; repeated 409s do not warn again', async () => {
    const { ref } = await startRecording();
    h.heartbeatMutate.mockResolvedValueOnce({ ok: false });
    h.claimMutateAsync.mockImplementation(async () => {
      throw conflict();
    });

    await tickLease();
    expect(h.claimMutateAsync).toHaveBeenCalledTimes(2);
    expect(lostWarnings()).toBe(1);

    await tickLease();
    await tickLease();
    expect(h.heartbeatMutate).toHaveBeenCalledTimes(1);
    expect(h.claimMutateAsync).toHaveBeenCalledTimes(4);
    expect(lostWarnings()).toBe(1);
    expect(ref.current?.isRecording()).toBe(true);
    // Capture continues (rollovers at 10 s / 20 s started fresh recorders on the live stream).
    expect(FakeMediaRecorder.instances.at(-1)?.state).toBe('recording');
    expect(h.releaseMutateAsync).not.toHaveBeenCalled();
  });

  it('a later successful claim returns to heartbeats, and a new loss warns again', async () => {
    await startRecording();
    h.heartbeatMutate.mockResolvedValueOnce({ ok: false });
    h.claimMutateAsync.mockImplementation(async () => {
      throw conflict();
    });
    await tickLease(); // loss → warn 1
    await tickLease(); // lost: claim 409
    expect(lostWarnings()).toBe(1);

    h.claimMutateAsync.mockImplementation(async () => ({ ok: true }));
    await tickLease(); // lost: claim 200 → holding
    expect(h.claimMutateAsync).toHaveBeenCalledTimes(4);
    await tickLease(); // holding: heartbeat
    expect(h.heartbeatMutate).toHaveBeenCalledTimes(2);
    expect(h.claimMutateAsync).toHaveBeenCalledTimes(4);

    h.heartbeatMutate.mockResolvedValueOnce({ ok: false });
    h.claimMutateAsync.mockImplementation(async () => {
      throw conflict();
    });
    await tickLease(); // second loss
    expect(h.claimMutateAsync).toHaveBeenCalledTimes(5);
    expect(lostWarnings()).toBe(2);
  });

  it('keeps at most one claim or heartbeat in flight; a tick skips while one is pending', async () => {
    await startRecording();
    const hb = deferred<{ ok: boolean }>();
    h.heartbeatMutate.mockImplementationOnce(() => hb.promise);
    await tickLease();
    await tickLease();
    await tickLease();
    expect(h.heartbeatMutate).toHaveBeenCalledTimes(1);
    expect(h.claimMutateAsync).toHaveBeenCalledTimes(1);

    // The heartbeat is refused; the re-claim is pending too.
    const claim = deferred<unknown>();
    h.claimMutateAsync.mockImplementationOnce(() => claim.promise);
    await act(async () => {
      hb.resolve({ ok: false });
      await flush();
    });
    expect(h.claimMutateAsync).toHaveBeenCalledTimes(2);
    await tickLease();
    await tickLease();
    expect(h.heartbeatMutate).toHaveBeenCalledTimes(1);
    expect(h.claimMutateAsync).toHaveBeenCalledTimes(2);

    await act(async () => {
      claim.resolve({ ok: true });
      await flush();
    });
    await tickLease();
    expect(h.heartbeatMutate).toHaveBeenCalledTimes(2);
    expect(h.claimMutateAsync).toHaveBeenCalledTimes(2);
  });

  it('stopping while a re-claim is in flight sends the release only after the claim settles; the lease ends free', async () => {
    const { ref } = await startRecording();
    const cid = h.claimMutateAsync.mock.calls[0][0].client_id;
    const claim = deferred<unknown>();
    h.heartbeatMutate.mockResolvedValueOnce({ ok: false });
    h.claimMutateAsync.mockImplementationOnce(() => claim.promise);
    await tickLease();
    expect(h.claimMutateAsync).toHaveBeenCalledTimes(2);

    await act(async () => {
      await ref.current?.toggle(); // stop
      await flush();
    });
    expect(h.releaseMutateAsync).not.toHaveBeenCalled();

    await act(async () => {
      claim.resolve({ ok: true });
      await flush();
    });
    // Exactly one release, after the claim settled: the lease ends free.
    expect(h.releaseMutateAsync).toHaveBeenCalledTimes(1);
    expect(h.releaseMutateAsync).toHaveBeenCalledWith({ sessionId: 'sess-A', client_id: cid });
    expect(h.releaseMutateAsync.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.claimMutateAsync.mock.invocationCallOrder[1],
    );
    expect(ref.current?.isRecording()).toBe(false);
  });

  it('a claim that succeeds after its take stopped is released at once', async () => {
    const { ref } = await startRecording();
    const cid = h.claimMutateAsync.mock.calls[0][0].client_id;
    const claim = deferred<unknown>();
    h.heartbeatMutate.mockResolvedValueOnce({ ok: false });
    h.claimMutateAsync.mockImplementationOnce(() => claim.promise);
    await tickLease();

    // A real MediaRecorder fires onstop asynchronously: hold it back so the
    // take is stopped (no longer capturing) but not yet finalized.
    const mr = FakeMediaRecorder.instances[0];
    const realOnstop = { fire: () => {} };
    mr.stop = function stop(this: FakeMediaRecorder) {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob([new Uint8Array(8)], { type: 'audio/webm' }) });
      const onstop = this.onstop;
      realOnstop.fire = () => onstop?.();
    };
    await act(async () => {
      await ref.current?.toggle(); // stop requested; onstop not yet delivered
      await flush();
    });
    expect(ref.current?.isRecording()).toBe(false);
    expect(h.releaseMutateAsync).not.toHaveBeenCalled();

    await act(async () => {
      claim.resolve({ ok: true });
      await flush();
    });
    expect(h.releaseMutateAsync).toHaveBeenCalledTimes(1);
    expect(h.releaseMutateAsync).toHaveBeenCalledWith({ sessionId: 'sess-A', client_id: cid });

    await act(async () => {
      realOnstop.fire();
      await flush();
    });
    expect(h.releaseMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('a successful heartbeat sends no claim (and a failed heartbeat keeps the existing behaviour)', async () => {
    const { ref } = await startRecording();
    await tickLease();
    await tickLease();
    expect(h.heartbeatMutate).toHaveBeenCalledTimes(2);
    expect(h.claimMutateAsync).toHaveBeenCalledTimes(1);

    h.heartbeatMutate.mockRejectedValueOnce(new Error('network down'));
    await tickLease();
    await tickLease();
    expect(h.heartbeatMutate).toHaveBeenCalledTimes(4);
    expect(h.claimMutateAsync).toHaveBeenCalledTimes(1);
    expect(lostWarnings()).toBe(0);
    expect(ref.current?.isRecording()).toBe(true);
  });

  // Consistency-read follow-up: the recorder is not remounted per session, so
  // every lease request of a take goes to the take's session, never the prop's.
  it("every lease request of a take goes to the take's session after the prop switches", async () => {
    const { ref, rerenderWith } = await startRecording('sess-A');
    const cid = h.claimMutateAsync.mock.calls[0][0].client_id;
    rerenderWith('sess-B');
    await tickLease(); // heartbeat
    h.heartbeatMutate.mockResolvedValueOnce({ ok: false });
    await tickLease(); // refused heartbeat → re-claim
    expect(h.heartbeatMutate).toHaveBeenCalledTimes(2);
    expect(h.claimMutateAsync).toHaveBeenCalledTimes(2);
    await act(async () => {
      await ref.current?.toggle(); // stop → final release
      await flush();
    });
    expect(h.releaseMutateAsync).toHaveBeenCalledTimes(1);
    const sent = [
      ...h.claimMutateAsync.mock.calls,
      ...h.heartbeatMutate.mock.calls,
      ...h.releaseMutateAsync.mock.calls,
    ].map(([vars]) => vars);
    expect(sent).toHaveLength(5);
    for (const vars of sent) expect(vars).toEqual({ sessionId: 'sess-A', client_id: cid });
  });

  it("a late release (claim landing after the take stopped) goes to the take's session", async () => {
    const { ref, rerenderWith } = await startRecording('sess-A');
    const cid = h.claimMutateAsync.mock.calls[0][0].client_id;
    rerenderWith('sess-B');
    const claim = deferred<unknown>();
    h.heartbeatMutate.mockResolvedValueOnce({ ok: false });
    h.claimMutateAsync.mockImplementationOnce(() => claim.promise);
    await tickLease();
    const mr = FakeMediaRecorder.instances[0];
    const held = { fire: () => {} };
    mr.stop = function stop(this: FakeMediaRecorder) {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob([new Uint8Array(8)], { type: 'audio/webm' }) });
      const onstop = this.onstop;
      held.fire = () => onstop?.();
    };
    await act(async () => {
      await ref.current?.toggle();
      await flush();
    });
    await act(async () => {
      claim.resolve({ ok: true });
      await flush();
    });
    expect(h.releaseMutateAsync).toHaveBeenCalledTimes(1);
    expect(h.releaseMutateAsync).toHaveBeenCalledWith({ sessionId: 'sess-A', client_id: cid });
    expect(h.claimMutateAsync.mock.calls[1][0]).toEqual({ sessionId: 'sess-A', client_id: cid });
    await act(async () => {
      held.fire();
      await flush();
    });
    expect(h.releaseMutateAsync).toHaveBeenCalledTimes(1);
  });

  it("the pagehide beacon releases the take's session after the prop switches", async () => {
    const sendBeacon = vi.fn((_url: string, _data?: BodyInit | null) => true);
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: sendBeacon });
    try {
      const { rerenderWith } = await startRecording('sess-A');
      rerenderWith('sess-B');
      await act(async () => {
        window.dispatchEvent(new Event('pagehide'));
      });
      expect(sendBeacon).toHaveBeenCalledTimes(1);
      expect(String(sendBeacon.mock.calls[0][0])).toContain(
        '/sessions/sess-A/audio-recording-lease/release',
      );
    } finally {
      Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: undefined });
    }
  });

  it('a heartbeat hanging at stop does not delay the final release, and its late answer sends no claim', async () => {
    const { ref } = await startRecording();
    const cid = h.claimMutateAsync.mock.calls[0][0].client_id;
    const hb = deferred<{ ok: boolean }>();
    h.heartbeatMutate.mockImplementationOnce(() => hb.promise);
    await tickLease();
    expect(h.heartbeatMutate).toHaveBeenCalledTimes(1);

    await act(async () => {
      await ref.current?.toggle(); // stop while the heartbeat hangs
      await flush();
    });
    expect(h.releaseMutateAsync).toHaveBeenCalledTimes(1);
    expect(h.releaseMutateAsync).toHaveBeenCalledWith({ sessionId: 'sess-A', client_id: cid });

    await act(async () => {
      hb.resolve({ ok: false });
      await flush();
    });
    expect(h.claimMutateAsync).toHaveBeenCalledTimes(1);
    expect(h.releaseMutateAsync).toHaveBeenCalledTimes(1);
  });
});

describe('media-worker A.5: persistence, locks, timers, finalize, wake lock, hidden tab', () => {
  it('starts each chunk with the 5 s timeslice and appends every slice to the store', async () => {
    await startRecording();
    const mr = FakeMediaRecorder.instances[0];
    expect(mr.timeslice).toBe(5_000);
    await act(async () => {
      mr.emitSlice(3);
      mr.emitSlice(4);
    });
    const [m] = await store.list('user-1');
    expect(m).toMatchObject({
      sessionId: 'sess-A',
      recordingOrdinal: 1,
      chunkIndex: 0,
      finalized: false,
      bytes: 7,
      userId: 'user-1',
    });
    expect(m.sliceLog.map((e) => e.bytes)).toEqual([3, 4]);
  });

  it('holds the take lock from start until the last chunk is persisted', async () => {
    const reg = new FakeLockRegistry();
    Object.defineProperty(navigator, 'locks', { configurable: true, value: reg.tab() });
    try {
      const { ref } = await startRecording();
      expect(reg.isHeld('autologger:recording:sess-A:1')).toBe(true);
      await act(async () => {
        vi.advanceTimersByTime(CHUNK_MS_TEST);
      });
      expect(reg.isHeld('autologger:recording:sess-A:1')).toBe(true); // across the rollover
      await act(async () => {
        await ref.current?.toggle();
      });
      expect(reg.isHeld('autologger:recording:sess-A:1')).toBe(false);
    } finally {
      Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    }
  });

  it('runs the rollover and the lease heartbeat on worker intervals', async () => {
    await startRecording();
    const periods = vi.mocked(createWorkerInterval).mock.calls.map(([p]) => p);
    expect(periods).toContain(CHUNK_MS_TEST);
    expect(periods).toContain(8_000);
  });

  it('pagehide asks the recorder for the pending slice and still releases the lease by beacon', async () => {
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: beacon });
    try {
      await startRecording();
      window.dispatchEvent(new Event('pagehide'));
      expect(FakeMediaRecorder.instances[0].requestData).toHaveBeenCalledTimes(1);
      expect(beacon).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: undefined });
    }
  });

  it('requests persistent storage at start without waiting for the answer', async () => {
    const persist = vi.fn(() => new Promise<boolean>(() => {})); // Firefox: never settles headless
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { persist } });
    try {
      const { ref } = await startRecording();
      expect(persist).toHaveBeenCalledTimes(1);
      expect(ref.current?.isRecording()).toBe(true);
    } finally {
      Object.defineProperty(navigator, 'storage', { configurable: true, value: undefined });
    }
  });

  it('finalizes the recording after its last chunk is confirmed, listing every window', async () => {
    const { ref } = await startRecording();
    await act(async () => {
      vi.advanceTimersByTime(CHUNK_MS_TEST);
    });
    expect(finalizePosts()).toHaveLength(0); // not while recording
    await act(async () => {
      await ref.current?.toggle();
    });
    const posts = segmentPosts();
    const fin = finalizePosts();
    expect(fin).toHaveLength(1);
    expect(fin[0].url).toContain('/sessions/sess-A/audio/recordings/1/finalize');
    expect(fin[0].body).toEqual({
      chunks: posts.map((u) => paramOf(u, 'started_at_utc')),
    });
    // After confirmation nothing is left in storage.
    expect(await store.list('user-1')).toEqual([]);
  });

  it('Record waits for the recovery scan; recovered ordinal 3 makes the new recording 4', async () => {
    // A previous page left a chunk of recording 3 in storage a minute ago (its heartbeat is
    // stale: jsdom has no Web Locks, so the 30 s heartbeat lease decides); uploads keep failing.
    vi.setSystemTime(new Date(T0.getTime() - 60_000));
    const h3 = await store.openChunk({
      userId: 'user-1',
      sessionId: 'sess-A',
      recordingOrdinal: 3,
      chunkIndex: 0,
      startedAtUtc: '2026-08-12T09:00:00.000Z',
      mimeType: 'audio/webm',
    });
    await store.append(h3, new Blob([new Uint8Array(5)]));
    vi.setSystemTime(T0);
    let releaseList!: () => void;
    const gate = new Promise<void>((r) => {
      releaseList = r;
    });
    const realList = store.list.bind(store);
    store.list = async (u) => {
      await gate;
      return realList(u);
    };
    uploadStatus = 503;

    const { ref, onPhaseChange } = renderRecorder('sess-A');
    await act(async () => {});
    expect(onPhaseChange.mock.calls.at(-1)?.[0]).toBe('scanning');
    await expect(ref.current?.toggle()).resolves.toBe(false);
    expect(h.claimMutateAsync).not.toHaveBeenCalled();

    await act(async () => {
      releaseList();
    });
    expect(onPhaseChange.mock.calls.at(-1)?.[0]).toBe('idle'); // recovered chunks do not block
    await act(async () => {
      await ref.current?.toggle();
    });
    expect(h.logEventMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Recording 4 Started' }),
    );
  });

  it('holds a screen wake lock while recording and releases it on stop', async () => {
    const wl = new FakeWakeLock();
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: wl });
    try {
      const { ref } = await startRecording();
      expect(wl.held()).toHaveLength(1);
      await act(async () => {
        await ref.current?.toggle();
      });
      expect(wl.held()).toHaveLength(0);
    } finally {
      Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: undefined });
    }
  });

  it('a recording tab hidden and shown again warns with the interval until the next user action', async () => {
    let visibility: 'visible' | 'hidden' = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
    try {
      await startRecording();
      await act(async () => {
        visibility = 'hidden';
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await act(async () => {
        vi.setSystemTime(new Date(T0.getTime() + 3 * 60_000));
        visibility = 'visible';
        document.dispatchEvent(new Event('visibilitychange'));
      });
      const warning = document.querySelector('[data-testid="hidden-tab-warning"]');
      expect(warning?.textContent).toContain('3 min');
      expect(warning?.textContent).toMatch(/background/);
      await act(async () => {
        window.dispatchEvent(new Event('pointerdown'));
      });
      expect(document.querySelector('[data-testid="hidden-tab-warning"]')).toBeNull();
    } finally {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
    }
  });

  it('without a signed-in user the recorder still records (chunks stay in memory)', async () => {
    h.userId = null;
    const { ref } = await startRecording();
    await act(async () => {
      await ref.current?.toggle();
    });
    expect(segmentPosts()).toHaveLength(1);
  });
});

describe('implementation panel fixes (A.8)', () => {
  function postedSizes(): number[] {
    return fetchMock.mock.calls
      .filter(
        ([input, init]) =>
          (init?.method ?? 'GET') === 'POST' && String(input).includes('/audio/segments?'),
      )
      .map(([, init]) => (init?.body as Blob | undefined)?.size ?? 0);
  }

  it('a store finalize that throws still enqueues, uploads and stops (no unhandled rejection)', async () => {
    store.finalize = async () => {
      throw new Error('chunkStore: unknown handle');
    };
    const { ref, onPhaseChange } = await startRecording();
    await act(async () => {
      await ref.current?.toggle();
    });
    expect(segmentPosts()).toHaveLength(1);
    expect(onPhaseChange.mock.calls.at(-1)?.[0]).toBe('idle');
    expect(h.releaseMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('a slice append that throws keeps that slice and every later one', async () => {
    const realAppend = store.append.bind(store);
    let n = 0;
    store.append = async (handle, bytes) => {
      n += 1;
      if (n === 2) throw new Error('disk gone');
      return realAppend(handle, bytes);
    };
    FakeMediaRecorder.emitData = false;
    const { ref } = await startRecording();
    const mr = FakeMediaRecorder.instances[0];
    await act(async () => {
      mr.emitSlice(3);
      mr.emitSlice(4);
      mr.emitSlice(5);
    });
    await act(async () => {
      await ref.current?.toggle();
    });
    expect(postedSizes()).toEqual([12]);
  });

  it('a duplicate onstop for one chunk is ignored', async () => {
    const { ref } = await startRecording();
    const mr = FakeMediaRecorder.instances[0];
    const onstop = mr.onstop;
    await act(async () => {
      await ref.current?.toggle();
    });
    await act(async () => {
      onstop?.();
    });
    expect(segmentPosts()).toHaveLength(1);
  });

  it('finalize lists every window even when an earlier chunk persists after a later one', async () => {
    const realFinalize = store.finalize.bind(store);
    let gate!: () => void;
    const slow = new Promise<void>((r) => {
      gate = r;
    });
    let first = true;
    store.finalize = async (handle, ended, mime) => {
      if (first) {
        first = false;
        await slow;
      }
      return realFinalize(handle, ended, mime);
    };
    const { ref } = await startRecording();
    await act(async () => {
      vi.advanceTimersByTime(CHUNK_MS_TEST); // chunk 0 stops; its persistence is slow
    });
    await act(async () => {
      await ref.current?.toggle(); // chunk 1 stops quickly
    });
    await act(async () => {
      gate();
    });
    const fin = finalizePosts();
    expect(fin).toHaveLength(1);
    expect((fin[0].body as { chunks: string[] }).chunks).toHaveLength(2);
    // …and it is sent only after both chunks were uploaded.
    const order = fetchMock.mock.calls
      .map(([input, init]) => `${init?.method ?? 'GET'} ${String(input)}`)
      .filter((c) => c.startsWith('POST'));
    const lastSegment = order.map((c) => c.includes('/audio/segments?')).lastIndexOf(true);
    const finalizeAt = order.findIndex((c) => c.endsWith('/finalize'));
    expect(segmentPosts()).toHaveLength(2);
    expect(finalizeAt).toBeGreaterThan(lastSegment);
  });

  it('unmount during a microphone re-acquisition cancels the take; nothing records afterwards', async () => {
    const { view } = await startRecording();
    let resolveMic!: (s: MediaStream) => void;
    const lateTrack = { readyState: 'live', stop: vi.fn() };
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementationOnce(
      () =>
        new Promise<MediaStream>((r) => {
          resolveMic = r;
        }),
    );
    await act(async () => {
      FakeMediaRecorder.instances[0].stop(); // the mic is lost; re-acquisition starts
    });
    await act(async () => {
      view.unmount();
    });
    await act(async () => {
      resolveMic({
        getTracks: () => [lateTrack],
        getAudioTracks: () => [lateTrack],
      } as unknown as MediaStream);
    });
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(lateTrack.stop).toHaveBeenCalled();
    expect(h.logEventMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Recording 1 Stopped' }),
    );
    expect(h.releaseMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('a scan that never answers does not hold Record forever', async () => {
    store.list = () => new Promise(() => {});
    const { onPhaseChange } = renderRecorder('sess-A', { scanTimeoutMs: 20 });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(onPhaseChange.mock.calls.at(-1)?.[0]).toBe('idle');
  });

  it('a failed profile query allows recording (recovery deferred)', async () => {
    h.profileState = 'error';
    const { onPhaseChange } = renderRecorder('sess-A');
    await act(async () => {});
    expect(onPhaseChange.mock.calls.at(-1)?.[0]).toBe('idle');
  });

  it('a profile that never loads does not hold Record forever', async () => {
    h.profileState = 'pending';
    const { onPhaseChange } = renderRecorder('sess-A', { scanTimeoutMs: 20 });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(onPhaseChange.mock.calls.at(-1)?.[0]).toBe('idle');
  });

  it("the queue is told the signed-in user, so another user's chunk is never uploaded", async () => {
    await startRecording();
    const queue = getChunkUploadQueue();
    queue.enqueue({
      sessionId: 'sess-A',
      recordingOrdinal: 9,
      chunkIndex: 0,
      startedAtUtc: '2026-08-12T09:00:00.000Z',
      endedAtUtc: '2026-08-12T09:01:00.000Z',
      mimeType: 'audio/webm',
      blob: new Blob([new Uint8Array(4)]),
      userId: 'someone-else',
    });
    await act(async () => {
      await queue.pump();
    });
    expect(segmentPosts()).toHaveLength(0);
  });
});

describe('A.9: a chunk that is merely retrying at Stop is not an error', () => {
  async function stopAndRetry(mode: 503 | 'network') {
    const { ref, onPhaseChange } = await startRecording();
    failNext = { count: 2, mode }; // both stop-time attempts fail transiently
    await act(async () => {
      await ref.current?.toggle();
    });
    // No error toast while the chunk is only retrying; Record stays blocked.
    expect(vi.mocked(showToast)).not.toHaveBeenCalledWith(expect.stringContaining('failed'), true);
    expect(onPhaseChange.mock.calls.at(-1)?.[0]).toBe('drain_blocked');
    await expect(ref.current?.toggle()).resolves.toBe(false);
    // The backoff tick uploads it a few seconds later and the recorder goes idle.
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(4_000);
      });
    }
    expect(segmentPosts().length).toBeGreaterThanOrEqual(3);
    expect(onPhaseChange.mock.calls.at(-1)?.[0]).toBe('idle');
    expect(vi.mocked(showToast)).not.toHaveBeenCalledWith(expect.stringContaining('failed'), true);
  }

  it('after transient 503s', async () => {
    await stopAndRetry(503);
  });

  it('after network failures (ambiguous, checked against the segments list)', async () => {
    await stopAndRetry('network');
  });

  it('a permanent 4xx at Stop still shows the error toast', async () => {
    uploadStatus = 400;
    const { ref } = await startRecording();
    await act(async () => {
      await ref.current?.toggle();
    });
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(expect.stringContaining('failed'), true);
  });
});
