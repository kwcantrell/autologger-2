// Package-local fake-clock test helper (feature-service-packages task 5.3).
// Mirrors server/src/test/fakeClock.ts's makeFakeClock exactly — a package
// test cannot import server/src (boundary violation), so this is a minimal
// local copy rather than a shared cross-workspace utility, per the
// duplicate-per-package policy decided at task 2.4 (this package's
// TEST_INFRASTRUCTURE_EXEMPTIONS entry was landed ahead of this file for
// exactly that reason, naming this exact path). This is the fourth copy,
// after storage's, session-core's, and server's own — duplicate-per-package
// is final policy, not a gap to close. `jobStore.test.ts` is this package's
// only consumer; server keeps its own copy since `node/presence.test.ts`
// still references it.

import type { Clock } from '@autologger/ports';
import { vi } from 'vitest';

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
