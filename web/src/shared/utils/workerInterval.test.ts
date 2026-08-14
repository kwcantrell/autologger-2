import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkerInterval } from './workerInterval';

// --- createWorkerInterval (perf-fixes: hidden-tab heartbeat throttling) ---
//
// The point of this utility is that the CLOCK runs off the main thread, so the
// two things worth asserting are (1) the tick is wired to worker MESSAGES and
// not to a main-thread timer, and (2) teardown releases the worker AND the Blob
// URL. Neither vitest environment (node or jsdom) has a real `Worker`, so the
// worker path is driven through a stubbed global that records construction and
// exposes the script it was handed; the fallback path is what the *unstubbed*
// environment exercises — which is also what the useCompanionPresence
// fake-timer suite runs against.

/** Records every worker constructed, and keeps the blob URL it was built from. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  terminated = 0;
  url: string;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWorker.instances.push(this);
  }

  terminate() {
    this.terminated += 1;
  }

  /** Test driver: the worker script's `postMessage` arriving on the main thread. */
  tick() {
    this.onmessage?.({ data: 0 });
  }
}

const lastWorker = () => {
  const w = FakeWorker.instances.at(-1);
  if (!w) throw new Error('no Worker was constructed');
  return w;
};

describe('createWorkerInterval — worker clock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWorker.instances.length = 0;
    vi.stubGlobal('Worker', FakeWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs the clock in a worker and ticks on its messages, not on a main-thread timer', () => {
    const onTick = vi.fn();
    const handle = createWorkerInterval(10_000, onTick);

    expect(handle.kind).toBe('worker');
    expect(FakeWorker.instances).toHaveLength(1);
    expect(lastWorker().url.startsWith('blob:')).toBe(true);

    // No main-thread interval was armed: advancing the main clock past several
    // periods produces nothing. This is the whole guarantee — a main-thread
    // `setInterval` is exactly what background throttling coalesces.
    vi.advanceTimersByTime(60_000);
    expect(onTick).not.toHaveBeenCalled();

    lastWorker().tick();
    lastWorker().tick();
    expect(onTick).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it('the worker script it ships actually posts a message once per period', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    const handle = createWorkerInterval(10_000, vi.fn());

    const blob = createObjectURL.mock.calls[0]?.[0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    const source = await blob.text();

    // Execute the script body against the worker globals it expects. Fake timers
    // are already installed, so the interval it arms is under our control.
    const postMessage = vi.fn();
    new Function('postMessage', 'setInterval', source)(postMessage, setInterval);

    vi.advanceTimersByTime(9_999);
    expect(postMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(postMessage).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(postMessage).toHaveBeenCalledTimes(4);

    handle.stop();
  });

  it('stop() terminates the worker, revokes the blob URL, and is idempotent', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const onTick = vi.fn();
    const handle = createWorkerInterval(5_000, onTick);
    const worker = lastWorker();
    const url = worker.url;

    handle.stop();
    expect(worker.terminated).toBe(1);
    expect(revoke).toHaveBeenCalledWith(url);

    // A stopped handle is inert, and a second stop (StrictMode double-cleanup)
    // must not terminate/revoke twice.
    handle.stop();
    expect(worker.terminated).toBe(1);
    expect(revoke).toHaveBeenCalledTimes(1);

    worker.tick();
    expect(onTick).not.toHaveBeenCalled();
  });

  it('falls back to a main-thread timer when the blob: worker is blocked (CSP)', () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new DOMException('blocked by CSP', 'SecurityError');
        }
      },
    );
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const onTick = vi.fn();

    const handle = createWorkerInterval(5_000, onTick);

    expect(handle.kind).toBe('timer');
    // The URL minted for the doomed worker is released rather than leaked.
    expect(revoke).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    expect(onTick).toHaveBeenCalledTimes(2);

    handle.stop();
    vi.advanceTimersByTime(10_000);
    expect(onTick).toHaveBeenCalledTimes(2);
  });
});

describe('createWorkerInterval — fallback clock (no Worker global)', () => {
  // Neither vitest environment provides `Worker`, so this block runs the same
  // path the useCompanionPresence fake-timer suite runs: unmodified
  // setInterval semantics, throttling risk and all.
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks on the main-thread interval and stops cleanly', () => {
    expect(typeof Worker).toBe('undefined');
    const onTick = vi.fn();
    const handle = createWorkerInterval(5_000, onTick);

    expect(handle.kind).toBe('timer');
    vi.advanceTimersByTime(5_000);
    expect(onTick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    expect(onTick).toHaveBeenCalledTimes(2);

    handle.stop();
    vi.advanceTimersByTime(60_000);
    expect(onTick).toHaveBeenCalledTimes(2);
  });
});
