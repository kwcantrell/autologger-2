// The caller's AI route (ai-sdk-agent-harness design D1, D3, D4). The implementation moved to
// `server/src/generation/aiRoute.ts` (batch-autogenerate D6), where the shared runners use it
// with a principal's `(env, user)`; the routes resolve the signed-in user's route here.

import type { Context } from 'hono';
import type { AppEnv } from '../appEnv';
import type { LlmRoute } from '../auth/providerResolve';
import { callerLlmRoute } from '../generation/aiRoute';
import { requireUser } from './_helpers';

export { callerLlmRoute, type SdkLlmRoute, sdkTurnSpec } from '../generation/aiRoute';

/** The signed-in user's route now (D1), resolved per request: CLI, SDK, or null for the 503. */
export function requestLlmRoute(c: Context<AppEnv>): Promise<LlmRoute | null> {
  return callerLlmRoute(c.env, requireUser(c));
}
