// Which speech-to-text credential a request or job runs with (byo-ai-providers design D3;
// provider-credentials "Work runs on its user's credentials"). The user's own decrypted `stt`
// credential first. Only in development mode, a user with none (or one that no longer decrypts)
// falls back to DEEPGRAM_API_KEY and DEEPGRAM_MODEL. In production mode the operator key is never
// used. Null means no usable credential: the caller answers unconfigured.
//
// `resolveLlmRoute` (ai-sdk-agent-harness D1) resolves the caller's `llm` row the same way, with no
// fallback in any mode.

import type { Config, ProviderCredentialStore } from '@autologger/ports';
import { deepgramModel, type SttCredential } from '@autologger/transcription';
import { claudeCliAllowed } from '../env';
import type { ProviderKeyCipher } from './providerKeyCrypto';

export interface ResolveEnv {
  config: Config;
  ports: { providerCredentials: ProviderCredentialStore; providerKeys: ProviderKeyCipher };
}

export async function resolveSttCredential(
  env: ResolveEnv,
  userId: string,
): Promise<SttCredential | null> {
  const row = await env.ports.providerCredentials.get(userId, 'stt');
  // A keyless row (only `claude-cli`, an `llm` provider) has no usable key.
  if (row !== null && row.key !== null) {
    const apiKey = env.ports.providerKeys.decrypt(row.key, {
      userId,
      kind: 'stt',
      provider: row.provider,
      origin: row.base_origin,
    });
    if (apiKey !== null) return { apiKey, model: row.model };
  }
  const fallback = env.config.DEEPGRAM_API_KEY.trim();
  if (env.config.PROVIDER_DEV_MODE === true && fallback) {
    return { apiKey: fallback, model: deepgramModel(env.config) };
  }
  return null;
}

// ── The caller's language model route (ai-sdk-agent-harness design D1) ─────────────────────────

/** Where the caller's AI turns run: the operator's Claude CLI, the in-process AI SDK on the caller's
 * own decrypted key, or nowhere (null: the route answers its "add a language model" 503). */
export type LlmRoute =
  | { kind: 'cli' }
  | {
      kind: 'sdk';
      provider: string;
      /** The saved base URL (`openai-compatible` only), else null. */
      baseUrl: string | null;
      /** The saved base URL's normalized origin, else null. */
      baseOrigin: string | null;
      model: string;
      /** The decrypted key. Sent only in the provider's auth header, through the guarded fetch. */
      apiKey: string;
    };

/** The caller's AI route from their saved `llm` row (D1):
 * - `claude-cli`: the CLI while `claudeCliAllowed` (CLAUDE_CLI_PATH set and the caller listed in
 *   CLAUDE_CLI_EMAILS), else null, so a removed user stops getting it on the next turn;
 * - a key provider: the SDK route with the decrypted key, or null when it does not decrypt;
 * - no row: null in every mode. There is no operator-key or CLI fallback. */
export async function resolveLlmRoute(
  env: ResolveEnv,
  user: { id: string; email: string },
): Promise<LlmRoute | null> {
  const row = await env.ports.providerCredentials.get(user.id, 'llm');
  if (row === null) return null;
  if (row.key === null) {
    return row.provider === 'claude-cli' && claudeCliAllowed(env.config, user)
      ? { kind: 'cli' }
      : null;
  }
  const apiKey = env.ports.providerKeys.decrypt(row.key, {
    userId: user.id,
    kind: 'llm',
    provider: row.provider,
    origin: row.base_origin,
  });
  if (apiKey === null || apiKey === '') return null;
  return {
    kind: 'sdk',
    provider: row.provider,
    baseUrl: row.base_url,
    baseOrigin: row.base_origin,
    model: row.model,
    apiKey,
  };
}
