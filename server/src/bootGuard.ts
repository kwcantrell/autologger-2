// src/bootGuard.ts — the server boots only inside a compose stack (retire-host-dev D1).
// The stacks set AUTOLOGGER_STACK (docker/secrets-env.yaml) and an absolute DATA_DIR; a host run
// has neither. Messages name variables only, never their values.

import { isAbsolute } from 'node:path';

/** The environments docker/scripts/compose-run.mjs sets as AUTOLOGGER_STACK. */
export const STACKS: readonly string[] = ['dev', 'stage', 'prod'];

/** A refusal message, or null when the server may boot. */
export function checkBootEnv(env: Record<string, string | undefined>): string | null {
  if (!STACKS.includes(env.AUTOLOGGER_STACK ?? '')) {
    return 'AutoLogger runs only in a compose stack (AUTOLOGGER_STACK is not dev, stage or prod). Start dev with `make dev-up`; see docs/supabase.md.';
  }
  if (!env.DATA_DIR || !isAbsolute(env.DATA_DIR)) {
    return 'DATA_DIR must be set to an absolute path (the compose stacks pin /data); there is no default data directory.';
  }
  return null;
}
