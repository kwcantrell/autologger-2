import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogEvent } from '../../../api/types';
import { showToast } from '../../../shared/components/Toast';
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
  segments: [] as { recording_ordinal: number | null }[],
  events: [] as Partial<LogEvent>[],
  heartbeatMutate: vi.fn(),
  logEventMutateAsync: vi.fn(async (_body: { category: string; message: string }) => ({})),
  claimMutateAsync: vi.fn(async () => ({})),
  releaseMutateAsync: vi.fn(async () => ({})),
}));

vi.mock('../../../api/hooks/useAudio', () => ({
  // NOT the real key literal — the factory module is its single owner
  // (queryKeyFactories.repo.test.ts); tests only need a stable mock key.
  audioSegmentsKeys: { bySession: (id: string | null) => ['audio-segments-mock', id] as const },
  useAudioSegments: () => ({ data: { segments: h.segments } }),
  useClaimAudioLease: () => ({ mutateAsync: h.claimMutateAsync }),
  useHeartbeatAudioLease: () => ({ mutate: h.heartbeatMutate }),
  useReleaseAudioLease: () => ({ mutateAsync: h.releaseMutateAsync }),
}));
vi.mock('../../../api/hooks/useEvents', () => ({
  WORKSPACE_EVENTS_LIMIT: 2000,
  useEvents: () => ({ data: { events: h.events } }),
  useLogEvent: () => ({ mutateAsync: h.logEventMutateAsync }),
}));
vi.mock('../../../shared/components/Toast', () => ({ showToast: vi.fn() }));

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
  start() {
    this.state = 'recording';
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

function paramOf(url: string, name: string): string | null {
  return new URL(url, 'http://localhost').searchParams.get(name);
}

const fakeTrack = { readyState: 'live', stop: vi.fn() };
const fakeStream = { getTracks: () => [fakeTrack] } as unknown as MediaStream;

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
  uploadBarrier = null;
  segCounter = 0;
  fakeTrack.readyState = 'live';
  FakeAudioContext.instances = [];
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.emitData = true;
  rafQueue = [];
  resetChunkUploadQueueForTesting();
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
  document.body.innerHTML = '';
  document.body.classList.remove('v4-is-recording', 'v4-local-recording');
});

function renderRecorder(sessionId = 'sess-A') {
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
        />
      </QueryClientProvider>,
    );
  return { ref, onPhaseChange, view, rerenderWith };
}

async function startRecording(sessionId = 'sess-A') {
  const utils = renderRecorder(sessionId);
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
    const togglePromise = act(async () => {
      await ref.current?.toggle();
    });

    // Release the barrier once the stop path has had a chance to enqueue
    // the final chunk and start awaiting the collapsed pump.
    await Promise.resolve();
    await act(async () => {
      releaseUploads();
      uploadBarrier = null;
    });
    await togglePromise;

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

  it('uploads each chunk with its own waveform PUT (best-effort, off the upload path)', async () => {
    const { ref } = await startRecording();
    await act(async () => {
      vi.advanceTimersByTime(CHUNK_MS_TEST);
    });
    await act(async () => {
      await ref.current?.toggle();
    });
    expect(segmentPosts()).toHaveLength(2);
    const puts = waveformPuts();
    expect(puts).toHaveLength(2);
    expect(puts[0]).toContain('/audio/segments/seg-1/waveform');
    expect(puts[1]).toContain('/audio/segments/seg-2/waveform');
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
    uploadStatus = 500; // transient — the chunk stays queued
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

  it('treats an unexpected onstop as a stop: no restart, lease released, Stopped logged, toast shown', async () => {
    const { ref, onPhaseChange } = await startRecording();
    const mr = FakeMediaRecorder.instances[0];
    await act(async () => {
      // Simulate the browser ending capture (mic unplugged): onstop fires
      // without the component having marked a reason.
      mr.stop();
    });

    expect(FakeMediaRecorder.instances).toHaveLength(1); // never restarted on the dead stream
    expect(vi.mocked(showToast)).toHaveBeenCalledWith(expect.stringContaining('microphone'), true);
    expect(h.logEventMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Recording 1 Stopped' }),
    );
    expect(h.releaseMutateAsync).toHaveBeenCalledTimes(1);
    expect(segmentPosts()).toHaveLength(1); // what was captured still uploaded
    expect(onPhaseChange.mock.calls.at(-1)?.[0]).toBe('idle');
    expect(ref.current?.isRecording()).toBe(false);
  });

  it('a rollover boundary on a dead stream finalizes instead of constructing a new recorder', async () => {
    const { onPhaseChange } = await startRecording();
    fakeTrack.readyState = 'ended';
    await act(async () => {
      vi.advanceTimersByTime(CHUNK_MS_TEST);
    });
    expect(FakeMediaRecorder.instances).toHaveLength(1); // no recorder on a dead stream (D1)
    expect(h.releaseMutateAsync).toHaveBeenCalledTimes(1);
    expect(segmentPosts()).toHaveLength(1);
    expect(onPhaseChange.mock.calls.at(-1)?.[0]).toBe('idle');
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
