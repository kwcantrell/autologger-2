// code-health-consolidation (design D2, task 4.1) — THE shared process-group
// kill ladder, extracted verbatim from the AI-v2 path (`aiV2SdkSpawn.ts`,
// task 2.6 / spike 0.5) so the chat/topic path and the v2 path consume ONE
// copy of this lifecycle-critical code instead of two that can drift.
//
// SIGTERM → grace → SIGKILL on the negative pgid, with escalation gated on
// GROUP liveness (`process.kill(-pgid, 0)`), NOT any one tracked process's
// exit status. Spike 0.5 Turn 2 proved a leader-exit-gated ladder leaves a
// real SIGTERM-ignoring group member orphaned, because escalation stops once
// the ONE tracked process looks dead; Turn 3's group-liveness-gated ladder
// closed it — and the chat path's old leader-exit-gated ladder had exactly
// the same bug (review finding 1.1), which is why it was deleted in favor of
// this module. Callers spawn the child `detached: true` so its pid IS its
// pgid and `-pid` addresses the whole group (POSIX/Linux — this deployment
// target, matching every other process-spawning path in the repo).
//
// ai-runtime-package (design D3, task 2.2) — `clock` is a REQUIRED, LEADING
// parameter (gate ruling E3), discharging `core-ports-architecture`'s named,
// non-exemptible `Date.now()` exception at this file's deadline read. An
// optional clock would make a missed construction site typecheck instead of
// fail; required-and-leading makes it a compile error. `killProcessGroup`
// stays TOTAL either way — see its own doc comment — so this thread must
// never gain a path that can throw.
//
// ai-runtime-package (design D3, task 2.4) — the poll's SLEEP is injectable
// too, and the delta makes that a SHALL: `Clock` exposes `now()` only, so a
// deadline read through an injected clock beside a real `setTimeout` spins
// FOREVER under a frozen fake clock — a hung suite rather than a failing
// test. The seam is a TRAILING OPTIONAL with a real-timer default, and that
// asymmetry with `clock` is deliberate, not sloppiness: an absent clock makes
// this function THROW (E3's whole argument), whereas an absent sleep degrades
// to exactly the production behavior. Nothing in production passes it.

import type { Clock } from '@autologger/ports';

/** Grace window between the SIGTERM and the SIGKILL rung. Exported so tests
 * can pass a short override; production relies on the default. */
export const DEFAULT_PROCESS_GROUP_KILL_GRACE_MS = 3000;

/** True iff the process GROUP led by `pgid` still has at least one live
 * member. `process.kill(-pgid, 0)` sends no signal — it only probes
 * deliverability: ESRCH means the group is gone; EPERM means it exists but is
 * unsignalable (we own it, so unlikely) — treated as alive to stay safe. */
export function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** How long the ladder waits between two group-liveness probes. */
const POLL_INTERVAL_MS = 50;

/**
 * The ladder's poll sleep, as an injectable seam (task 2.4). **Test seam:
 * never set in production** — the default below is the real timer, and it is
 * what every production caller gets.
 *
 * A test supplies one that advances the SAME fake clock it injected, which is
 * what makes the loop's two time dependencies — the deadline read and the
 * sleep — a single test-controlled mechanism (the delta's SHALL). It also
 * means a deterministic ladder test needs no `vi.useFakeTimers()` at all, so
 * it cannot stall helpers awaited *before* the code under test (the
 * `waitForPidFile` collision named in D3).
 */
export type ProcessGroupKillSleep = (ms: number) => Promise<void>;

const realTimerSleep: ProcessGroupKillSleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntilGroupGone(
  clock: Clock,
  sleep: ProcessGroupKillSleep,
  pgid: number,
  timeoutMs: number,
): Promise<boolean> {
  const start = clock.now();
  while (processGroupAlive(pgid)) {
    if (clock.now() - start >= timeoutMs) return false;
    await sleep(POLL_INTERVAL_MS);
  }
  return true;
}

/**
 * Terminate the process group led by `pgid`: SIGTERM the group, wait up to
 * `graceMs` for it to die, and — if ANY member is still alive (gated on
 * GROUP liveness, not one process's exit) — SIGKILL the group. A no-op if the
 * group is already gone. Never throws: an ESRCH on an already-dead group is
 * exactly the no-orphan outcome. Resolves once the group is confirmed gone (or
 * a bounded final wait elapses after the SIGKILL rung).
 *
 * `clock` is required and leading (design D3, ruling E3): it bounds the
 * grace/final-wait deadlines and is the sole reason this function could ever
 * be made throwable by a careless caller — it deliberately is not, because
 * this function is awaited inside two `finally` blocks whose REMAINING
 * statements (concurrency-slot release, pending-question abandonment, MCP
 * turn disposal, copied-credentials directory deletion) must always run.
 *
 * `sleep` is a trailing-optional TEST SEAM (task 2.4) defaulting to the real
 * timer — no production caller passes it, and `killAiChatProcessGroup` /
 * `createDesignTurnSpawner` deliberately do not forward it, so the only way
 * into this parameter is a direct in-package test call. Because its default
 * is total, omitting it can never make this function throw — unlike `clock`,
 * which is why the two have opposite shapes.
 */
export async function killProcessGroup(
  clock: Clock,
  pgid: number | null | undefined,
  graceMs: number = DEFAULT_PROCESS_GROUP_KILL_GRACE_MS,
  sleep: ProcessGroupKillSleep = realTimerSleep,
): Promise<void> {
  if (pgid == null || !processGroupAlive(pgid)) return;
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    return; // ESRCH: the group went away between the probe and the signal.
  }
  const gone = await waitUntilGroupGone(clock, sleep, pgid, graceMs);
  if (!gone) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Raced gone between the liveness check and this signal — fine.
    }
    await waitUntilGroupGone(clock, sleep, pgid, 2000);
  }
}
