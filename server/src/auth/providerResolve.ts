// Which speech-to-text credential a request or job runs with (byo-ai-providers design D3;
// provider-credentials "Work runs on its user's credentials"). The user's own decrypted `stt`
// credential first. Only in development mode, a user with none (or one that no longer decrypts)
// falls back to DEEPGRAM_API_KEY and DEEPGRAM_MODEL. In production mode the operator key is never
// used. Null means no usable credential: the caller answers unconfigured.

import type { Config, ProviderCredentialStore } from '@autologger/ports';
import { deepgramModel, type SttCredential } from '@autologger/transcription';
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
  if (row !== null) {
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
