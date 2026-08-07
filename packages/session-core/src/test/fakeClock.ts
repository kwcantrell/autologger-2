// Package-local fake-clock test helper (persistence-package-extraction task
// 4.3). Mirrors server/src/test/fakeClock.ts's makeFakeClock exactly — a
// package test cannot import server/src (boundary violation), so this is a
// minimal local copy rather than a shared cross-workspace utility, per the
// duplicate-per-package policy decided at task 2.4 (storage's copy) with the
// full fakeCore/fakeClock importer inventory in hand. `fakeClock.test.ts`
// (which tests this helper itself) and the seven `fakeCore`-importing unit
// tests both need it inside this package now that `session/` moved here;
// server keeps its own copy since `node/presence.test.ts` still references
// it.

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
