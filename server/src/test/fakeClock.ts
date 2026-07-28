// Fake-clock helper for determinism tests (de-cloudflare-strong-core tasks
// 5.3/5.4; extracted from session/fakeClock.test.ts when its KV/presence
// suites relocated beside the modules they test — code-health-tail task 5.2):
// the injected time base and vitest's timer queue advance in lockstep, so
// staleness/TTL expiry is provable with zero real elapsed time.

import { vi } from 'vitest';
import type { Clock } from '../clock';

export function makeFakeClock(startMs = 1_750_000_000_000): {
  clock: Clock;
  tick(ms: number): void;
} {
  let now = startMs;
  return {
    clock: { now: () => now },
    tick(ms: number) {
      now += ms;
      vi.advanceTimersByTime(ms); // keep the setTimeout queue on the same base
    },
  };
}
