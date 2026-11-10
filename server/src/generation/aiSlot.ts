// The shared AI turn slot's session lease (session-run-leases D4; batch-autogenerate D6, D8: moved
// here from `routers/_aiSlot.ts` so the batch runners share it). Each of the four AI routes
// (ai/chat, ai/v2/design, topics/generate, events/generate) takes its in-process slot first,
// synchronously, with its literal `aiChatTurns.tryAcquire(` call (per-session only, no process-wide
// ceiling: run-status-and-sweeper D2), and
// then awaits `claimAiLease`, which claims the session's `ai-turn` run lease and holds it (renewed
// every 10 s) for the turn. Within one process the slot already excludes a second turn, so a
// refused claim means another process runs a turn on this session.

import type { AiChatAcquireResult } from '@autologger/ai-runtime/aiChatRegistry';
import { holdRunLease, type SessionHubFacade } from '@autologger/session-core';

/** A held AI turn: the in-process slot plus its `ai-turn` lease. `release` frees the lease, then
 * the slot (D4 step 3); it is memoized (every call returns the same promise) and never rejects,
 * so the route's `finally` and aiV2's every-path `onFinally` can both call it. */
export interface AiSlot {
  release: () => Promise<void>;
}

let renewMsForTests: number | undefined;

/** Test-only: the lease renewal period of the turns started after this call (`undefined` restores
 * the default, `RUN_LEASE_RENEW_MS`), so a test can see a renewal during a short turn (D6). Not
 * used on any request path. */
export function __setAiLeaseRenewMsForTests(ms: number | undefined): void {
  renewMsForTests = ms;
}

/** `claimAiLease` for a hub resolver of any caller: a request's, or a batch job's initiator
 * (batch-autogenerate D6, D8), so a batch step and a manual run share one lease. */
export async function claimAiLeaseFor(
  getHub: () => Promise<SessionHubFacade>,
  sessionId: string,
  proc: Extract<AiChatAcquireResult, { ok: true }>,
): Promise<AiSlot | null> {
  let hold: Awaited<ReturnType<typeof holdRunLease>>;
  try {
    hold = await holdRunLease({
      getHub,
      kind: 'ai-turn',
      sessionId,
      renewMs: renewMsForTests,
    });
  } catch (err) {
    proc.release();
    throw err;
  }
  if (hold === null) {
    proc.release();
    return null;
  }
  const lease = hold;
  const doRelease = async () => {
    await lease.release();
    proc.release();
  };
  let releasing = false;
  let released: Promise<void> = Promise.resolve();
  return {
    release() {
      if (!releasing) {
        releasing = true;
        released = doRelease();
      }
      return released;
    },
  };
}
