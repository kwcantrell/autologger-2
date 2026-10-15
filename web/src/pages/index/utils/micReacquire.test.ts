import { describe, expect, it, vi } from 'vitest';
import {
  MIC_REACQUIRE_WINDOW_MS,
  reacquireMicrophone,
  rolloverAction,
  watchMicrophone,
} from './micReacquire';

// --- media-worker A.4: a lost microphone is re-acquired, not final (design D19) ---

class FakeTrack extends EventTarget {
  readyState: 'live' | 'ended' = 'live';
  constructor(readonly deviceId: string) {
    super();
  }
  getSettings() {
    return { deviceId: this.deviceId };
  }
  stop() {
    this.readyState = 'ended';
  }
  end() {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

function fakeStream(deviceId = 'mic-1') {
  const track = new FakeTrack(deviceId);
  return {
    track,
    stream: {
      getAudioTracks: () => [track],
      getTracks: () => [track],
    } as unknown as MediaStream,
  };
}

function notFound() {
  const e = new Error('Requested device not found');
  e.name = 'NotFoundError';
  return e;
}

describe('reacquireMicrophone', () => {
  it('asks for the previous device first, then the default input', async () => {
    const { stream } = fakeStream('default-mic');
    const calls: MediaStreamConstraints[] = [];
    const getUserMedia = vi.fn(async (c: MediaStreamConstraints) => {
      calls.push(c);
      if (typeof c.audio === 'object') throw notFound(); // the headset is gone
      return stream;
    });
    const t = { now: 0 };
    const result = await reacquireMicrophone({
      getUserMedia,
      previousDeviceId: 'headset',
      now: () => t.now,
      sleep: async (ms) => {
        t.now += ms;
      },
    });
    expect(result).toMatchObject({ ok: true, stream });
    expect(calls).toEqual([{ audio: { deviceId: { exact: 'headset' } } }, { audio: true }]);
  });

  it('retries on the backoff until a microphone comes back within 60 s', async () => {
    const { stream } = fakeStream();
    let n = 0;
    const getUserMedia = vi.fn(async () => {
      n += 1;
      if (n < 4) throw notFound();
      return stream;
    });
    const t = { now: 0 };
    const sleeps: number[] = [];
    const result = await reacquireMicrophone({
      getUserMedia,
      previousDeviceId: null,
      now: () => t.now,
      sleep: async (ms) => {
        sleeps.push(ms);
        t.now += ms;
      },
      random: () => 0.5,
    });
    expect(result.ok).toBe(true);
    expect(sleeps).toEqual([2_000, 4_000, 8_000]);
  });

  it('gives up after 60 s with the reason', async () => {
    const getUserMedia = vi.fn(async () => {
      const e = new Error('Permission denied');
      e.name = 'NotAllowedError';
      throw e;
    });
    const t = { now: 0 };
    const result = await reacquireMicrophone({
      getUserMedia,
      previousDeviceId: 'x',
      now: () => t.now,
      sleep: async (ms) => {
        t.now += ms;
      },
      random: () => 0.5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/NotAllowedError|Permission denied/);
    expect(t.now).toBeLessThanOrEqual(MIC_REACQUIRE_WINDOW_MS);
    expect(t.now).toBeGreaterThanOrEqual(MIC_REACQUIRE_WINDOW_MS - 1);
  });

  it('a stream whose track is already dead is not a success', async () => {
    const dead = fakeStream();
    dead.track.readyState = 'ended';
    const live = fakeStream();
    const streams = [dead.stream, live.stream];
    const getUserMedia = vi.fn(async () => streams.shift() as MediaStream);
    const t = { now: 0 };
    const result = await reacquireMicrophone({
      getUserMedia,
      previousDeviceId: null,
      now: () => t.now,
      sleep: async (ms) => {
        t.now += ms;
      },
    });
    expect(result).toMatchObject({ ok: true, stream: live.stream });
  });

  it('stops when cancelled (the user pressed stop meanwhile)', async () => {
    let cancelled = false;
    const getUserMedia = vi.fn(async () => {
      cancelled = true;
      throw notFound();
    });
    const t = { now: 0 };
    const result = await reacquireMicrophone({
      getUserMedia,
      previousDeviceId: null,
      now: () => t.now,
      sleep: async (ms) => {
        t.now += ms;
      },
      isCancelled: () => cancelled,
    });
    expect(result).toEqual({ ok: false, reason: 'cancelled', attempts: 1 });
  });
});

describe('watchMicrophone', () => {
  it('a track ending reports the loss', () => {
    const { stream, track } = fakeStream();
    const devices = new EventTarget();
    const onLost = vi.fn();
    const stop = watchMicrophone(stream, { onLost, mediaDevices: devices, log: vi.fn() });
    track.end();
    expect(onLost).toHaveBeenCalledWith('track-ended');
    stop();
  });

  it('a devicechange with the track still live only logs', () => {
    const { stream } = fakeStream();
    const devices = new EventTarget();
    const onLost = vi.fn();
    const log = vi.fn();
    const stop = watchMicrophone(stream, { onLost, mediaDevices: devices, log });
    devices.dispatchEvent(new Event('devicechange'));
    expect(onLost).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    stop();
  });

  it('a devicechange that removed the active input reports the loss', () => {
    const { stream, track } = fakeStream();
    const devices = new EventTarget();
    const onLost = vi.fn();
    const stop = watchMicrophone(stream, { onLost, mediaDevices: devices, log: vi.fn() });
    track.readyState = 'ended'; // no 'ended' event (some browsers)
    devices.dispatchEvent(new Event('devicechange'));
    expect(onLost).toHaveBeenCalledWith('device-removed');
    stop();
  });

  it('dispose detaches every listener', () => {
    const { stream, track } = fakeStream();
    const devices = new EventTarget();
    const onLost = vi.fn();
    const stop = watchMicrophone(stream, { onLost, mediaDevices: devices, log: vi.fn() });
    stop();
    track.end();
    devices.dispatchEvent(new Event('devicechange'));
    expect(onLost).not.toHaveBeenCalled();
  });
});

describe('rolloverAction', () => {
  it('rolls over on a live stream, waits while re-acquiring, re-acquires a dead one', () => {
    expect(rolloverAction({ streamLive: true, reacquiring: false })).toBe('rollover');
    expect(rolloverAction({ streamLive: false, reacquiring: true })).toBe('wait');
    expect(rolloverAction({ streamLive: true, reacquiring: true })).toBe('wait');
    expect(rolloverAction({ streamLive: false, reacquiring: false })).toBe('reacquire');
  });
});
