// The caller's AI route for the AI routes and the batch runners (ai-sdk-agent-harness design D1,
// D3, D4; batch-autogenerate D6: moved here from `routers/_aiRoute.ts`, which re-exports it). `ai/chat`,
// `topics/generate` and `events/generate` resolve the caller's saved `llm` choice as their
// configuration gate (null answers each route's "add a language model" 503), and an AI SDK route
// gets its injected `SdkTurnDeps` here: the credential, the server-computed `baseURL`, and the
// guarded fetch (`fetch`, `byteLog`, `breach`) for this one turn.

import {
  type SdkProvider,
  type SdkTurnKind,
  type SdkTurnSpec,
  sdkResponseByteCap,
} from '@autologger/ai-runtime/sdkTurn';
import type { AuthUser } from '@autologger/catalog';
import type { Bindings } from '../appEnv';
import { guardedFetch, PROVIDER_HOSTS } from '../auth/providerOutbound';
import { type LlmRoute, resolveLlmRoute } from '../auth/providerResolve';

export type SdkLlmRoute = Extract<LlmRoute, { kind: 'sdk' }>;

/** Each fixed-host provider's API base path; the factories append the rest (D3 table). */
const FIXED_BASE_PATHS = { anthropic: '/v1', openai: '/v1', google: '/v1beta' } as const;

/** The user's route now (D1), resolved per request or per batch step (batch-autogenerate D4):
 * CLI, SDK, or null for the 503. */
export function callerLlmRoute(env: Bindings, user: AuthUser): Promise<LlmRoute | null> {
  return resolveLlmRoute(env, user);
}

const isSdkProvider = (p: string): p is SdkProvider =>
  p === 'anthropic' || p === 'openai' || p === 'google' || p === 'openai-compatible';

/** An AI SDK turn on `route`: its deps, with a fresh guarded fetch for this one turn. */
export function sdkTurnSpec(
  env: Bindings,
  route: SdkLlmRoute,
  kind: SdkTurnKind,
  limits: SdkTurnSpec['limits'],
  history?: SdkTurnSpec['history'],
): SdkTurnSpec {
  // A provider outside the four never reaches a factory: its empty base URL makes the turn's
  // construction refuse it (an internal-error ending, no request).
  const provider = route.provider as SdkProvider;
  const baseURL = !isSdkProvider(route.provider)
    ? ''
    : provider === 'openai-compatible'
      ? (route.baseUrl ?? '')
      : `${PROVIDER_HOSTS[provider]}${FIXED_BASE_PATHS[provider]}`;
  const guarded = guardedFetch({
    provider: route.provider,
    model: route.model,
    baseUrl: route.baseUrl,
    baseOrigin: route.baseOrigin,
    production: env.config.PROVIDER_DEV_MODE !== true,
    // D4 step 3: the turn's own response-byte cap, from its validated limits.
    responseTotalBytes: sdkResponseByteCap(kind, limits),
  });
  return {
    kind,
    limits,
    history,
    deps: {
      provider,
      baseURL,
      model: route.model,
      apiKey: route.apiKey,
      fetch: guarded.fetch,
      byteLog: guarded.byteLog,
      breach: guarded.breach,
    },
  };
}
