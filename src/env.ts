// Typed env accessors — mirror the AUTOLOGGER_* env getters in
// src/autologger/web/auth_identity.py. `Env` is the Node Bindings alias (src/types.ts).

import type { Env } from './types';

export function sessionCookieName(env: Env): string {
  return (env.SESSION_COOKIE || '').trim() || 'autologger_sid';
}

/** Gate decision E1: login is REQUIRED unless explicitly disabled. */
export function requireLoginEnabled(env: Env): boolean {
  const v = (env.REQUIRE_LOGIN || '').trim().toLowerCase();
  if (!v) return true;
  return !['0', 'false', 'no'].includes(v);
}

export function newUserAllTeamsEnabled(env: Env): boolean {
  const v = (env.NEW_USER_ALL_TEAMS || '0').trim().toLowerCase();
  return !['0', 'false', 'no'].includes(v);
}

export function publicBaseUrl(env: Env): string {
  return (env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
}

export function googleClientId(env: Env): string {
  return (env.GOOGLE_CLIENT_ID || '').trim();
}

export function googleClientSecret(env: Env): string {
  return (env.GOOGLE_CLIENT_SECRET || '').trim();
}

export function oauthConfigured(env: Env): boolean {
  return Boolean(googleClientId(env) && googleClientSecret(env) && publicBaseUrl(env));
}

export function sessionTtlDays(env: Env): number {
  const n = Number(env.SESSION_DAYS ?? '14');
  return Number.isFinite(n) ? n : 14.0;
}

export function trustProxyEnabled(env: Env): boolean {
  return ['1', 'true', 'yes'].includes((env.TRUST_PROXY || '').trim().toLowerCase());
}

export function cookieSecureForRequest(env: Env, req: Request): boolean {
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

export function apiTokenConfigured(env: Env): boolean {
  return Boolean((env.API_TOKEN || '').trim());
}

export function adminTokenConfigured(env: Env): boolean {
  return Boolean((env.ADMIN_TOKEN || '').trim());
}

/** _admin_meta — restart is never supported on Workers (no supervised process). */
export function adminMeta(env: Env): Record<string, boolean> {
  return {
    restart_supported: false,
    restart_needs_token: adminTokenConfigured(env),
  };
}
