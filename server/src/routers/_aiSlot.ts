// The shared AI turn slot's session lease (session-run-leases D4). Each of the four AI routes
// (ai/chat, ai/v2/design, topics/generate, events/generate) takes its in-process slot first,
// synchronously, with its literal `aiChatTurns.tryAcquire(` call (registries unchanged, D5), and
// then awaits `claimAiLease`, which claims the session's `ai-turn` run lease and holds it (renewed
// every 10 s) for the turn. Within one process the slot already excludes a second turn, so a
// refused claim means another process runs a turn on this session.

import type { AiChatAcquireResult } from '@autologger/ai-runtime/aiChatRegistry';
import { holdRunLease } from '@autologger/session-core';
import type { Context } from 'hono';
import type { AppEnv } from '../appEnv';
import { getSessionHub } from './_helpers';

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

/** Claims the session's `ai-turn` lease as the request's user, behind the slot `proc` the route
 * already holds. Null when another holder has a live lease; a claim that throws rethrows. Either
 * way `proc` is released first, so a refused or failed claim never leaks the slot. */
export async function claimAiLease(
  c: Context<AppEnv>,
  sessionId: string,
  proc: Extract<AiChatAcquireResult, { ok: true }>,
): Promise<AiSlot | null> {
  let hold: Awaited<ReturnType<typeof holdRunLease>>;
  try {
    hold = await holdRunLease({
      getHub: () => getSessionHub(c, sessionId),
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
