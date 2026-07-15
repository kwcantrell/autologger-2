// Typed config accessors — ported from the AUTOLOGGER_* env getters in
// src/autologger/web/auth_identity.py. They read the composition root's Config
// object (src/types.ts).

import type { Config } from './types';

export function sessionCookieName(env: Config): string {
  return (env.SESSION_COOKIE || '').trim() || 'autologger_sid';
}

/** Gate decision E1: login is REQUIRED unless explicitly disabled. */
export function requireLoginEnabled(env: Config): boolean {
  const v = (env.REQUIRE_LOGIN || '').trim().toLowerCase();
  if (!v) return true;
  return !['0', 'false', 'no'].includes(v);
}

export function newUserAllTeamsEnabled(env: Config): boolean {
  const v = (env.NEW_USER_ALL_TEAMS || '0').trim().toLowerCase();
  return !['0', 'false', 'no'].includes(v);
}

export function publicBaseUrl(env: Config): string {
  return (env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
}

export function googleClientId(env: Config): string {
  return (env.GOOGLE_CLIENT_ID || '').trim();
}

export function googleClientSecret(env: Config): string {
  return (env.GOOGLE_CLIENT_SECRET || '').trim();
}

export function oauthConfigured(env: Config): boolean {
  return Boolean(googleClientId(env) && googleClientSecret(env) && publicBaseUrl(env));
}

export function sessionTtlDays(env: Config): number {
  const n = Number(env.SESSION_DAYS ?? '14');
  return Number.isFinite(n) ? n : 14.0;
}

export function trustProxyEnabled(env: Config): boolean {
  return ['1', 'true', 'yes'].includes((env.TRUST_PROXY || '').trim().toLowerCase());
}

export function cookieSecureForRequest(env: Config, req: Request): boolean {
  const raw = (env.COOKIE_SECURE || '').trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'no'].includes(raw)) return false;
  if (trustProxyEnabled(env) && req.headers.get('x-forwarded-proto') === 'https') return true;
  try {
    return new URL(req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function apiTokenConfigured(env: Config): boolean {
  return Boolean((env.API_TOKEN || '').trim());
}

export function adminTokenConfigured(env: Config): boolean {
  return Boolean((env.ADMIN_TOKEN || '').trim());
}

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

/** _admin_meta — restart is not supported (no supervised process; gate decision E2). */
export function adminMeta(env: Config): Record<string, boolean> {
  return {
    restart_supported: false,
    restart_needs_token: adminTokenConfigured(env),
  };
}
