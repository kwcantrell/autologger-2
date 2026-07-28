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

async function waitUntilGroupGone(pgid: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (processGroupAlive(pgid)) {
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
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
 */
export async function killProcessGroup(
  pgid: number | null | undefined,
  graceMs: number = DEFAULT_PROCESS_GROUP_KILL_GRACE_MS,
): Promise<void> {
  if (pgid == null || !processGroupAlive(pgid)) return;
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    return; // ESRCH: the group went away between the probe and the signal.
  }
  const gone = await waitUntilGroupGone(pgid, graceMs);
  if (!gone) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Raced gone between the liveness check and this signal — fine.
    }
    await waitUntilGroupGone(pgid, 2000);
  }
}
