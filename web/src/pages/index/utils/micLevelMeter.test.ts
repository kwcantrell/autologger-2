import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMicLevelMeter } from './micLevelMeter';

// --- Mic level meter lifecycle (PR#4 review fix: previously untested) ---
//
// Pins the meter's full stop path — most importantly that going INACTIVE
// closes the AudioContext (commit 80cb794: no leaked live context until the
// disposer runs) and that the disposer is idempotent (stop() nulls ctx before
// closing, so a later disposer call cannot double-close).

/** Byte waveform the fake analyser reports: 128 = silence, 192 = loud. */
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

let rafQueue: FrameRequestCallback[] = [];
function flushFrame() {
  const callbacks = rafQueue;
  rafQueue = [];
  for (const cb of callbacks) cb(0);
}

const STREAM = {} as MediaStream;

function fill(): HTMLElement {
  return document.getElementById('top-bar-mic-level-fill') as HTMLElement;
}

beforeEach(() => {
  analyserByte = 128;
  FakeAudioContext.instances = [];
  rafQueue = [];
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  document.body.innerHTML = '<span id="top-bar-mic-level-fill" style="width: 0%"></span>';
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('runMicLevelMeter', () => {
  it('writes the fill width from the analyser RMS each frame', () => {
    analyserByte = 192; // v = 0.5 → rms 0.5 → level min(1, 1.6) = 1
    runMicLevelMeter(STREAM, () => true);
    expect(FakeAudioContext.instances).toHaveLength(1);
    flushFrame();
    expect(fill().style.width).toBe('100%');
    // Loop keeps scheduling while active.
    expect(rafQueue).toHaveLength(1);
  });

  it('going inactive runs the full stop path: closes the context and resets the fill', () => {
    analyserByte = 192;
    let active = true;
    runMicLevelMeter(STREAM, () => active);
    flushFrame();
    expect(fill().style.width).toBe('100%');

    active = false;
    flushFrame();
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(fill().style.width).toBe('0%');
    // Loop is dead: nothing scheduled.
    expect(rafQueue).toHaveLength(0);
  });

  it('disposer stops the loop, closes the context, and is idempotent', () => {
    const stop = runMicLevelMeter(STREAM, () => true);
    const ctx = FakeAudioContext.instances[0];
    stop();
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(fill().style.width).toBe('0%');
    // stop() nulled ctx before closing — a second call cannot double-close.
    stop();
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it('a disposer call after going inactive does not double-close', () => {
    let active = true;
    const stop = runMicLevelMeter(STREAM, () => active);
    active = false;
    flushFrame();
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.close).toHaveBeenCalledTimes(1);
    stop();
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it('survives a missing fill element', () => {
    document.body.innerHTML = '';
    const stop = runMicLevelMeter(STREAM, () => true);
    flushFrame();
    expect(() => stop()).not.toThrow();
  });
});
