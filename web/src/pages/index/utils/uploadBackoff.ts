/**
 * Retry schedule for chunk uploads, finalize calls and microphone re-acquisition (media-worker
 * design D11): `delay(n) = min(5 min, 2 s × 2^(n−1)) × U(0.5, 1.5)`. The jitter spreads retries
 * from many tabs or clients after a server restart.
 */

export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_CAP_MS = 300_000;

/** Delay before attempt `attempt + 1` after `attempt` failures (1-based). */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  // 2^(n−1) overflows to Infinity long after the cap; Math.min keeps it finite.
  const raw = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (n - 1));
  return Math.floor(raw * (0.5 + random()));
}

export interface Backoff {
  /** Failures counted so far. */
  readonly attempt: number;
  /** Count one more failure and return the delay before the next attempt. */
  next(): number;
  reset(): void;
}

export function createBackoff(random: () => number = Math.random): Backoff {
  let attempt = 0;
  return {
    get attempt() {
      return attempt;
    },
    next() {
      attempt += 1;
      return backoffDelayMs(attempt, random);
    },
    reset() {
      attempt = 0;
    },
  };
}
