/**
 * A repeating tick that keeps its period in a hidden tab.
 *
 * Chrome/Edge apply *intensive throttling* to main-thread timers once a tab has
 * been hidden for >5 minutes (and is not playing audio / holding a lock):
 * `setInterval` callbacks are coalesced into a single wake-up per minute,
 * regardless of the requested period. A 10s heartbeat therefore fires ~60s
 * apart — which silently breaks any deadline shorter than a minute.
 *
 * Timers inside a *dedicated worker* are exempt from intensive throttling, so
 * this utility runs the clock there: a tiny worker script `setInterval`s and
 * `postMessage`s a tick, and the caller's `onTick` runs on the main thread when
 * that message lands. Message delivery to a hidden tab's main thread is not
 * itself throttled, so the callback keeps the worker's cadence.
 *
 * The worker is built from a Blob URL so it needs no separate bundle entry.
 * Where that is impossible — no `Worker` global (jsdom / SSR / tests), or a
 * Content-Security-Policy that forbids `blob:` workers — it falls back to a
 * plain `setInterval`, i.e. exactly today's behaviour, THROTTLING INCLUDED.
 * Callers whose period is a hard deadline must treat the fallback as
 * best-effort; `kind` says which clock they actually got.
 */

export interface WorkerInterval {
  /** Which clock is driving the ticks. `'timer'` is the throttleable fallback. */
  readonly kind: 'worker' | 'timer';
  /**
   * Stops the ticks and releases everything the interval owns (worker
   * terminated, Blob URL revoked). Idempotent — safe to call from a React
   * effect cleanup that StrictMode double-invokes.
   */
  stop(): void;
}

/**
 * Source of the worker script. Deliberately minimal — no message protocol, no
 * state: `stop()` tears the whole worker down with `terminate()`, which is
 * both simpler and more certain than asking it to clear its own interval.
 *
 * `period` is interpolated as a number (coerced by the caller), never as
 * caller-supplied text, so this cannot become a code-injection seam.
 */
const workerSource = (period: number) => `setInterval(function () { postMessage(0); }, ${period});`;

const canUseWorkerClock = (): boolean =>
  typeof Worker !== 'undefined' &&
  typeof Blob !== 'undefined' &&
  typeof URL !== 'undefined' &&
  typeof URL.createObjectURL === 'function';

/**
 * Starts a throttling-resistant interval. Returns a handle whose `stop()` is
 * the only teardown the caller needs.
 */
export function createWorkerInterval(periodMs: number, onTick: () => void): WorkerInterval {
  const period = Math.max(0, Math.floor(periodMs));

  if (canUseWorkerClock()) {
    let url: string | null = null;
    let worker: Worker | null = null;
    try {
      url = URL.createObjectURL(
        new Blob([workerSource(period)], { type: 'application/javascript' }),
      );
      worker = new Worker(url);
      worker.onmessage = () => onTick();
      const liveWorker = worker;
      const liveUrl = url;
      let stopped = false;
      return {
        kind: 'worker',
        stop() {
          if (stopped) return;
          stopped = true;
          liveWorker.onmessage = null;
          try {
            liveWorker.terminate();
          } catch {
            /* already gone */
          }
          try {
            URL.revokeObjectURL(liveUrl);
          } catch {
            /* already revoked */
          }
        },
      };
    } catch {
      // CSP blocked the blob: worker (or Worker construction failed outright).
      // Undo whatever half-succeeded, then fall through to the plain timer.
      if (worker) {
        try {
          worker.terminate();
        } catch {
          /* ignore */
        }
      }
      if (url) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* ignore */
        }
      }
    }
  }

  // Fallback: a main-thread interval, subject to background throttling.
  const id = setInterval(onTick, period);
  let stopped = false;
  return {
    kind: 'timer',
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(id);
    },
  };
}
