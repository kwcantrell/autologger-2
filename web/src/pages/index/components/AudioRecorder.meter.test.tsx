import { act, cleanup, render } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioRecorderHandle } from './AudioRecorder';
import { AudioRecorder } from './AudioRecorder';

// --- AudioRecorder mic-meter wiring (PR#4 review fix: previously untested) ---
//
// Every SessionWorkspace suite mocks AudioRecorder to null, so nothing
// exercised the meter's start (record flow), stop (onstop), or unmount
// teardown — including the meterActiveRef race workaround ("Meter starts
// during `claiming`, before CLAIM_OK re-renders, so a phase check aborted the
// loop forever"). These tests drive the real component: the meter loop must
// still be running AFTER the CLAIM_OK re-render has landed, which is exactly
// the state a phase-gated isActive predicate would have killed.

vi.mock('../../../api/hooks/useAudio', () => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(async () => ({})) });
  return {
    useAudioSegments: () => ({ data: { segments: [] } }),
    useClaimAudioLease: mutation,
    useHeartbeatAudioLease: mutation,
    useReleaseAudioLease: mutation,
    useUploadAudioSegment: mutation,
    useUploadWaveform: mutation,
  };
});
vi.mock('../../../api/hooks/useEvents', () => ({
  useLogEvent: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(async () => ({})) }),
}));
vi.mock('../../../shared/components/Toast', () => ({ showToast: vi.fn() }));

let analyserByte = 128;

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));
  createAnalyser = vi.fn(() => ({
    fftSize: 512,
    smoothingTimeConstant: 0,
    getByteTimeDomainData: (data: Uint8Array) => data.fill(analyserByte),
  }));
  constructor() {
    FakeAudioContext.instances.push(this);
  }
}

class FakeMediaRecorder {
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.onstop?.();
  }
}

let rafQueue: FrameRequestCallback[] = [];
function flushFrame() {
  const callbacks = rafQueue;
  rafQueue = [];
  for (const cb of callbacks) cb(0);
}

function fill(): HTMLElement {
  return document.getElementById('top-bar-mic-level-fill') as HTMLElement;
}

const fakeStream = { getTracks: () => [] } as unknown as MediaStream;

beforeEach(() => {
  analyserByte = 128;
  FakeAudioContext.instances = [];
  rafQueue = [];
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => fakeStream) },
  });
  const span = document.createElement('span');
  span.id = 'top-bar-mic-level-fill';
  span.style.width = '0%';
  document.body.appendChild(span);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
  document.body.innerHTML = '';
  document.body.classList.remove('v4-is-recording', 'v4-local-recording');
});

async function startRecording() {
  const ref = createRef<AudioRecorderHandle>();
  const view = render(<AudioRecorder ref={ref} sessionId="sess-rec-1" />);
  await act(async () => {
    await ref.current?.toggle();
  });
  return { ref, view };
}

describe('AudioRecorder mic meter wiring', () => {
  it('starts the meter on record and keeps it alive past the CLAIM_OK re-render', async () => {
    analyserByte = 192;
    await startRecording();

    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(document.body.classList.contains('v4-is-recording')).toBe(true);
    // toggle() has fully resolved — CLAIM_OK re-rendered phase to 'recording'
    // long ago. The frame below only paints because isActive is the meter's
    // OWN flag; a stateRef.phase gate (the documented race) would have run
    // the stop path on the first claiming-phase tick instead.
    flushFrame();
    expect(fill().style.width).toBe('100%');
    expect(rafQueue).toHaveLength(1);
  });

  it('stop toggle runs the full meter stop path', async () => {
    analyserByte = 192;
    const { ref } = await startRecording();
    flushFrame();
    expect(fill().style.width).toBe('100%');

    await act(async () => {
      await ref.current?.toggle();
    });

    const ctx = FakeAudioContext.instances[0];
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(fill().style.width).toBe('0%');
    expect(document.body.classList.contains('v4-is-recording')).toBe(false);
    flushFrame();
    expect(rafQueue).toHaveLength(0);
  });

  it('unmount mid-recording tears the meter down and clears the body classes', async () => {
    const { view } = await startRecording();
    expect(document.body.classList.contains('v4-is-recording')).toBe(true);

    view.unmount();

    const ctx = FakeAudioContext.instances[0];
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(document.body.classList.contains('v4-is-recording')).toBe(false);
    expect(document.body.classList.contains('v4-local-recording')).toBe(false);
  });
});
