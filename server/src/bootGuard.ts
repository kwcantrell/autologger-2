// src/bootGuard.ts — the server boots only inside a compose stack (retire-host-dev D1), with
// sign-in configured (require-login D1) and a bootstrap owner named (owner-bootstrap D8). An
// approved-users entry must be ASCII (run-status-and-sweeper D9).
// The stacks set AUTOLOGGER_STACK (docker/secrets-env.yaml), an absolute DATA_DIR, an absolute
// BLOB_DIR outside it (shared-blob-volume D1) and the catalog's PG* settings (catalog-on-postgres
// D2); a host run has none. With CUSTOM_DASHBOARDS_ENABLED on, the custom-dashboards settings are
// checked too (ADR 0035, design §10.1); off, they are never read. In the split topology the
// router's ROUTER_CUSTOM_DASHBOARDS / ROUTER_DASHBOARD_RUNTIME_HOST must agree with the api's
// (design §10.3, J6): compose passes them to both, so a mismatch is refused here. Messages name
// variables only, never their values.

import { isAbsolute, resolve, sep } from 'node:path';
import type { Config } from '@autologger/ports';
import {
  customDashboardsEnabled,
  dashboardRuntimeOrigin,
  exactHttpsOrigin,
  MCP_REFRESH_GRACE_MAX,
  MCP_SIGNING_SECRET_MIN_LENGTH,
  mcpAllowedOrigins,
  mcpRefreshGraceSeconds,
  mcpSigningSecretValid,
  publicBaseUrl,
  sameHost,
  sameSite,
  signupsMode,
} from './env';

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
  // closed-signups D1: SIGNUPS is optional; a value other than open or closed is a typo, refused
  // so it never silently picks a mode. The value is never printed.
  const signups = { SIGNUPS: env.SIGNUPS, AUTOLOGGER_STACK: env.AUTOLOGGER_STACK } as Config;
  if (signupsMode(signups) === 'invalid') {
    return 'SIGNUPS must be open or closed, or unset (unset follows the stack: open on dev, closed on stage and prod); fix it in OpenBao, see docs/openbao-secrets.md.';
  }
  return customDashboardsRefusal(env);
}

/** The custom-dashboards settings (ADR 0035, design §10.1) as a `Config`, for the env.ts reads. */
function customDashboardsConfig(env: Record<string, string | undefined>): Config {
  return {
    CUSTOM_DASHBOARDS_ENABLED: env.CUSTOM_DASHBOARDS_ENABLED,
    PUBLIC_BASE_URL: env.PUBLIC_BASE_URL,
    DASHBOARD_RUNTIME_ORIGIN: env.DASHBOARD_RUNTIME_ORIGIN,
    MCP_SIGNING_SECRET: env.MCP_SIGNING_SECRET,
    MCP_ALLOWED_ORIGINS: env.MCP_ALLOWED_ORIGINS,
    MCP_REFRESH_GRACE_SECONDS: env.MCP_REFRESH_GRACE_SECONDS,
    IP_ALLOWLIST: env.IP_ALLOWLIST,
  } as Config;
}

/**
 * Design §10.3: the router's `ROUTER_CUSTOM_DASHBOARDS` is present in the api's environment only
 * in the split topology (compose passes it to both services). Present, it must be exactly `on`
 * when the flag is on and exactly `off` when it is off; any other value, empty included, is a
 * disagreement (the router cannot import its rules from it either). Absent, nothing is checked.
 */
function routerFlagRefusal(
  env: Record<string, string | undefined>,
  flagOn: boolean,
): string | null {
  const router = env.ROUTER_CUSTOM_DASHBOARDS;
  if (router === undefined) return null;
  if (router === (flagOn ? 'on' : 'off')) return null;
  return `ROUTER_CUSTOM_DASHBOARDS (the router's setting) must be on exactly when CUSTOM_DASHBOARDS_ENABLED is on, and off exactly when it is off; with CUSTOM_DASHBOARDS_ENABLED ${flagOn ? 'on' : 'off'} it must be ${flagOn ? 'on' : 'off'}. Set both in OpenBao, see docs/openbao-secrets.md.`;
}

/** A host name for comparison: lower-cased, trailing dots stripped. */
const comparableHost = (h: string): string => h.toLowerCase().replace(/\.+$/, '');

/**
 * Design §10.1 and §10.3: with `CUSTOM_DASHBOARDS_ENABLED` on, refuse an unsafe setup; with it
 * off, read nothing but the router's on/off value (when present it must say `off`). A refusal
 * message naming the variable and no value, or null.
 */
export function customDashboardsRefusal(env: Record<string, string | undefined>): string | null {
  const cfg = customDashboardsConfig(env);
  const flagOn = customDashboardsEnabled(cfg);
  const routerRefusal = routerFlagRefusal(env, flagOn);
  if (routerRefusal) return routerRefusal;
  if (!flagOn) return null;
  const app = exactHttpsOrigin(publicBaseUrl(cfg), { allowPort: true });
  if (app === null) {
    return "CUSTOM_DASHBOARDS_ENABLED is on, so PUBLIC_BASE_URL must be an https: origin with no path, query or fragment (the dev stack's http://localhost setup cannot turn it on); fix it in OpenBao, see docs/openbao-secrets.md.";
  }
  const runtime = dashboardRuntimeOrigin(cfg);
  if (runtime === null) {
    return 'CUSTOM_DASHBOARDS_ENABLED is on, so DASHBOARD_RUNTIME_ORIGIN must be set to an https: origin with no path and no explicit port, whose host has no trailing dot or empty label; fix it in OpenBao, see docs/openbao-secrets.md.';
  }
  // `app` and `runtime` are both non-null here, so `new URL()` cannot throw. Keep the two checks
  // above ahead of this one: moved below it, a bad value would throw instead of being refused.
  if (sameHost(new URL(runtime).hostname, new URL(app).hostname)) {
    return "CUSTOM_DASHBOARDS_ENABLED is on, so DASHBOARD_RUNTIME_ORIGIN must have a host other than PUBLIC_BASE_URL's (the dashboard runtime needs its own origin); fix it in OpenBao, see docs/openbao-secrets.md.";
  }
  // Design §10.3: in the split topology (the router's setting is present) the router's runtime
  // host rule and its `frame-src` header come from ROUTER_DASHBOARD_RUNTIME_HOST, so it must be
  // the runtime origin's host. Unset or different, runtime-host requests would reach web:3000 and
  // the app's `frame-src` would name the wrong origin.
  if (env.ROUTER_CUSTOM_DASHBOARDS !== undefined) {
    const routerHost = comparableHost(env.ROUTER_DASHBOARD_RUNTIME_HOST ?? '');
    if (!routerHost || routerHost !== comparableHost(new URL(runtime).hostname)) {
      return "CUSTOM_DASHBOARDS_ENABLED is on and ROUTER_CUSTOM_DASHBOARDS is set, so ROUTER_DASHBOARD_RUNTIME_HOST must be set to the host of DASHBOARD_RUNTIME_ORIGIN (the router sends that host to the api and puts it in the app's frame-src); set both in OpenBao, see docs/openbao-secrets.md.";
    }
  }
  if (!mcpSigningSecretValid(cfg)) {
    return `CUSTOM_DASHBOARDS_ENABLED is on, so MCP_SIGNING_SECRET must be set to at least ${MCP_SIGNING_SECRET_MIN_LENGTH} characters; set it in OpenBao, see docs/openbao-secrets.md.`;
  }
  if (mcpAllowedOrigins(cfg) === null) {
    return 'CUSTOM_DASHBOARDS_ENABLED is on, so every MCP_ALLOWED_ORIGINS entry must be an exact https: origin (no wildcard, path, query, fragment or user info; a port is allowed); fix it in OpenBao, see docs/openbao-secrets.md.';
  }
  if (mcpRefreshGraceSeconds(cfg) === null) {
    return `CUSTOM_DASHBOARDS_ENABLED is on, so MCP_REFRESH_GRACE_SECONDS must be unset, empty, or a whole number of seconds from 0 to ${MCP_REFRESH_GRACE_MAX} (0 turns the refresh grace window off); fix it in OpenBao, see docs/openbao-secrets.md.`;
  }
  return null;
}

/**
 * Design §10.1 and §10.3: warnings for a setup `checkBootEnv` accepts but the operator should
 * know about, logged once at boot by main.ts. Empty with the flag off. They name variables and
 * never values.
 */
export function bootWarnings(env: Record<string, string | undefined>): string[] {
  const cfg = customDashboardsConfig(env);
  if (!customDashboardsEnabled(cfg)) return [];
  const out: string[] = [];
  const app = exactHttpsOrigin(publicBaseUrl(cfg), { allowPort: true });
  const runtime = dashboardRuntimeOrigin(cfg);
  // Both `new URL()` calls below sit behind the null checks, so they cannot throw.
  if (app !== null && runtime !== null) {
    const appHost = new URL(app).hostname;
    const runtimeHost = new URL(runtime).hostname;
    if (!sameHost(appHost, runtimeHost) && sameSite(appHost, runtimeHost)) {
      out.push(
        'DASHBOARD_RUNTIME_ORIGIN is on the same site as PUBLIC_BASE_URL: a separate registrable domain is recommended for the dashboard runtime (docs/design/custom-session-dashboards.md section 9.2).',
      );
    }
  }
  if ((cfg.IP_ALLOWLIST ?? '').trim()) {
    out.push(
      "CUSTOM_DASHBOARDS_ENABLED is on and IP_ALLOWLIST is set: add Anthropic's connector egress range, from Claude's connector documentation, so /mcp and the OAuth token and registration endpoints work (docs/design/custom-session-dashboards.md section 10.3).",
    );
  }
  return out;
}
