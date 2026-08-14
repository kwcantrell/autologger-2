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
 * Where that is impossible it falls back to a plain `setInterval`, i.e. exactly
 * today's behaviour, THROTTLING INCLUDED. Callers whose period is a hard
 * deadline must treat the fallback as best-effort; `kind` says which clock they
 * are on *right now*.
 *
 * **The fallback has two shapes, and only one of them is synchronous.**
 * - No `Worker`/`Blob`/`URL.createObjectURL` global (jsdom / SSR / tests), or a
 *   `new Worker(...)` that throws outright: caught before this function
 *   returns, so the handle starts life as `'timer'`.
 * - A Content-Security-Policy whose `worker-src` forbids `blob:`: `new
 *   Worker(url)` **returns normally** and the failure arrives later as an
 *   `error` event on the worker. Nothing is thrown, so a construction-time
 *   `try/catch` cannot see it. Wiring only `onmessage` therefore produced a
 *   handle that reported `kind: 'worker'` and NEVER TICKED — strictly worse
 *   than the plain `setInterval` it was replacing. `onerror`/`onmessageerror`
 *   below tear the dead worker down and re-arm the main-thread interval, so
 *   the caller keeps ticking without having to know; `kind` flips to `'timer'`
 *   at that moment.
 */

export interface WorkerInterval {
  /**
   * Which clock is driving the ticks *at the moment you read it*. `'timer'` is
   * the throttleable fallback. Live rather than fixed: a worker that fails
   * asynchronously (CSP-blocked `blob:` worker) degrades to `'timer'` after
   * construction returned `'worker'`.
   */
  readonly kind: 'worker' | 'timer';
  /**
   * Stops the ticks and releases everything the interval owns (worker
   * terminated, Blob URL revoked, main-thread interval cleared). Idempotent —
   * safe to call from a React effect cleanup that StrictMode double-invokes,
   * and safe to interleave with an async worker failure in either order.
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

  let stopped = false;
  let kind: 'worker' | 'timer' = 'timer';
  let worker: Worker | null = null;
  let url: string | null = null;
  let timerId: ReturnType<typeof setInterval> | null = null;

  /** Detach, terminate and revoke — once. Null-ing both fields first is what
   * makes a second call (stop() after a degrade, or the reverse) a no-op
   * rather than a double `terminate()`/`revokeObjectURL()`. */
  const releaseWorker = (): void => {
    const w = worker;
    const u = url;
    worker = null;
    url = null;
    if (w !== null) {
      w.onmessage = null;
      w.onerror = null;
      w.onmessageerror = null;
      try {
        w.terminate();
      } catch {
        /* already gone */
      }
    }
    if (u !== null) {
      try {
        URL.revokeObjectURL(u);
      } catch {
        /* already revoked */
      }
    }
  };

  /** Arm the main-thread fallback. Idempotent, and inert after stop() so a
   * late worker error can never resurrect a torn-down interval. */
  const startTimer = (): void => {
    if (stopped || timerId !== null) return;
    kind = 'timer';
    timerId = setInterval(onTick, period);
  };

  /** The worker died (async CSP refusal, or a script error). Drop it and pick
   * the ticks back up on the main thread — degraded, but ticking. */
  const degradeToTimer = (): void => {
    if (stopped) return;
    releaseWorker();
    startTimer();
  };

  if (canUseWorkerClock()) {
    try {
      url = URL.createObjectURL(
        new Blob([workerSource(period)], { type: 'application/javascript' }),
      );
      const w = new Worker(url);
      // Assigned before the handlers so a throw from any of them still hands
      // releaseWorker() something to tear down.
      worker = w;
      w.onmessage = () => {
        if (!stopped) onTick();
      };
      w.onerror = () => degradeToTimer();
      w.onmessageerror = () => degradeToTimer();
      kind = 'worker';
    } catch {
      // Worker construction failed synchronously. Undo whatever half-succeeded,
      // then fall through to the plain timer below.
      releaseWorker();
    }
  }

  if (worker === null) startTimer();

  return {
    get kind() {
      return kind;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      releaseWorker();
      if (timerId !== null) {
        clearInterval(timerId);
        timerId = null;
      }
    },
  };
}
