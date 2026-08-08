// DeepGram configuration predicates (feature-service-packages task 4.1,
// design D5). Moved out of server/src/env.ts — these are the two `Config`
// predicates `generateTranscript.ts` itself reads, so the package would
// otherwise escape to `../env`. `resolveYtDlpPath` and every other env.ts
// predicate stay in the app (gate ruling E2) — see env.ts's own header for
// why PATH-probing is composition-root work, not a service's.

import type { Config } from '@autologger/ports';

/** Gate: transcript generation runs only when a DeepGram key is configured;
 * unset/blank keeps the endpoint's frozen 503 (design D7, spec
 * "Configuration-gated generation"). */
export function deepgramConfigured(env: Config): boolean {
  return Boolean((env.DEEPGRAM_API_KEY || '').trim());
}

/** DeepGram model, defaulting to `nova-3` (gate decision 6), overridable via
 * `DEEPGRAM_MODEL`. */
export function deepgramModel(env: Config): string {
  return (env.DEEPGRAM_MODEL || '').trim() || 'nova-3';
}
