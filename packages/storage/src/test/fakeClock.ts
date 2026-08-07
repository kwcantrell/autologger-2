// Package-local fake-clock test helper (persistence-package-extraction task
// 2.2). Mirrors server/src/test/fakeClock.ts's makeFakeClock exactly — a
// package test cannot import server/src (boundary violation), so this is a
// minimal local copy rather than a shared cross-workspace utility. The
// fakeClock helper's eventual shared-vs-duplicated home is an open question
// left to design.md's "Open Questions" / task 2.4 (kvStore) and 4.3
// (session-core) with the full importer inventory in hand; server keeps its
// own copy since session/fakeClock.test.ts and node/presence.test.ts still
// reference it.

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
