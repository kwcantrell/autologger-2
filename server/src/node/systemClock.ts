// The real Clock adapter — the composition side of the Clock port (spec:
// core-ports-architecture; package-split-foundation design D2/D3, task 4.1).
// Moved from the former server/src/clock.ts, whose interface now lives
// interface-only in @autologger/ports. This is the sole sanctioned
// `Date.now()` call site for decision-making time reads.

import type { Clock } from '@autologger/ports';

export const systemClock: Clock = { now: () => Date.now() };
