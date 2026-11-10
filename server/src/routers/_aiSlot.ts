// The shared AI turn slot's session lease for the routes (session-run-leases D4). The lease logic
// lives in `server/src/generation/aiSlot.ts` (batch-autogenerate D6), shared with the batch
// runners; `claimAiLease` binds it to the request's hub.

import type { AiChatAcquireResult } from '@autologger/ai-runtime/aiChatRegistry';
import type { Context } from 'hono';
import type { AppEnv } from '../appEnv';
import { type AiSlot, claimAiLeaseFor } from '../generation/aiSlot';
import { getSessionHub } from './_helpers';

export { __setAiLeaseRenewMsForTests, type AiSlot, claimAiLeaseFor } from '../generation/aiSlot';

/** Claims the session's `ai-turn` lease as the request's user, behind the slot `proc` the route
 * already holds. Null when another holder has a live lease; a claim that throws rethrows. Either
 * way `proc` is released first, so a refused or failed claim never leaks the slot. */
export async function claimAiLease(
  c: Context<AppEnv>,
  sessionId: string,
  proc: Extract<AiChatAcquireResult, { ok: true }>,
): Promise<AiSlot | null> {
  return claimAiLeaseFor(() => getSessionHub(c, sessionId), sessionId, proc);
}
