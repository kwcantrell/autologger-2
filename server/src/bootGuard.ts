// src/bootGuard.ts — the server boots only inside a compose stack (retire-host-dev D1), with
// sign-in configured (require-login D1) and a bootstrap owner named (owner-bootstrap D8). An
// approved-users entry must be ASCII (run-status-and-sweeper D9).
// The stacks set AUTOLOGGER_STACK (docker/secrets-env.yaml), an absolute DATA_DIR, an absolute
// BLOB_DIR outside it (shared-blob-volume D1) and the catalog's PG* settings (catalog-on-postgres
// D2); a host run has none. Messages name variables only, never their values.

import { isAbsolute, resolve, sep } from 'node:path';

/** The environments docker/scripts/compose-run.mjs sets as AUTOLOGGER_STACK. */
export const STACKS: readonly string[] = ['dev', 'stage', 'prod'];

/** The catalog's connection settings, passed by the compose stacks (docker/compose*.yaml). */
export const CATALOG_PG_VARS = ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'] as const;

/** The settings sign-in needs (require-login D1); `oauthConfigured()` in env.ts reads the same. */
export const SIGN_IN_VARS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'PUBLIC_BASE_URL',
] as const;

/**
 * shared-blob-volume D1: BLOB_DIR is required and absolute, and BLOB_DIR and DATA_DIR are disjoint
 * (on `path.resolve` of both: equal, or one starts with the other plus `sep`; `/` overlaps
 * everything). Symlinks are not followed: the paths may not exist yet, and the stacks pin
 * literals. Assumes DATA_DIR was already checked. A refusal message naming the variables and no
 * value, or null. `createBindings` repeats it, since tests and main.ts reach it without the guard.
 */
export function blobDirRefusal(env: Record<string, string | undefined>): string | null {
  const blobDir = env.BLOB_DIR ?? '';
  if (!blobDir || !isAbsolute(blobDir)) {
    return 'BLOB_DIR must be set to an absolute path (the compose stacks pin /blobs); there is no default blob directory.';
  }
  const a = resolve(blobDir);
  const b = resolve(env.DATA_DIR ?? '');
  const inside = (child: string, parent: string) =>
    child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
  if (a === b || inside(a, b) || inside(b, a)) {
    return 'BLOB_DIR and DATA_DIR must be separate directories, neither inside the other.';
  }
  return null;
}

/** A refusal message, or null when the server may boot. */
export function checkBootEnv(env: Record<string, string | undefined>): string | null {
  if (!STACKS.includes(env.AUTOLOGGER_STACK ?? '')) {
    return 'AutoLogger runs only in a compose stack (AUTOLOGGER_STACK is not dev, stage or prod). Start dev with `make dev-up`; see docs/supabase.md.';
  }
  if (!env.DATA_DIR || !isAbsolute(env.DATA_DIR)) {
    return 'DATA_DIR must be set to an absolute path (the compose stacks pin /data); there is no default data directory.';
  }
  const blobRefusal = blobDirRefusal(env);
  if (blobRefusal) return blobRefusal;
  const missing = CATALOG_PG_VARS.filter((k) => !env[k]);
  if (missing.length) {
    return `catalog connection settings missing: ${missing.join(', ')} (the compose stacks set them).`;
  }
  // require-login D1: login is always required, so the removed switch must not linger, and a
  // server no one can sign in to never boots (the same trimmed rule as `oauthConfigured()`).
  if (env.REQUIRE_LOGIN !== undefined) {
    return 'REQUIRE_LOGIN was removed: login is always required. Unset it (compose and OpenBao must not set it).';
  }
  const signIn = SIGN_IN_VARS.filter((k) => !(env[k] ?? '').trim());
  if (signIn.length) {
    return `sign-in settings missing or blank: ${signIn.join(', ')} (login is always required; set the Google client in OpenBao, see docs/openbao-secrets.md).`;
  }
  // owner-bootstrap D8, D16: the bootstrap owner is required, and only as ASCII (the claim's match
  // is exact ASCII, so a non-ASCII value could never match). Kept out of SIGN_IN_VARS, which
  // mirrors `oauthConfigured()`.
  const owner = env.BOOTSTRAP_OWNER_EMAIL ?? '';
  if (!owner.trim()) {
    return 'BOOTSTRAP_OWNER_EMAIL is missing or blank (the bootstrap owner claims teams that have no owner; set it in OpenBao, see docs/openbao-secrets.md).';
  }
  if ([...owner].some((ch) => (ch.codePointAt(0) ?? 0) > 0x7f)) {
    return 'BOOTSTRAP_OWNER_EMAIL has a non-ASCII character (the bootstrap owner match is exact ASCII; fix it in OpenBao, see docs/openbao-secrets.md).';
  }
  // run-status-and-sweeper D9: the approved-users list is optional, and matched as exact ASCII.
  const runFeature = env.RUN_FEATURE_EMAILS ?? '';
  if ([...runFeature].some((ch) => (ch.codePointAt(0) ?? 0) > 0x7f)) {
    return 'RUN_FEATURE_EMAILS has a non-ASCII character (the approved-users match is exact ASCII; fix it in OpenBao, see docs/openbao-secrets.md).';
  }
  return null;
}
