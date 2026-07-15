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

// ── AI topics chat (ai-topics-chat, design D5/D8) ───────────────────────────

/** Gate (design D8): the AI chat runs only when CLAUDE_CLI_PATH names the claude
 * CLI executable. Unset/blank/whitespace-only ⇒ feature off (frozen 503). */
export function aiChatConfigured(env: Config): boolean {
  return Boolean((env.CLAUDE_CLI_PATH || '').trim());
}

/** Per-turn server-side timeout backstop in seconds (spec Subprocess lifecycle);
 * default 300. Non-numeric / non-positive falls back to the default. */
export function aiChatTimeoutSec(env: Config): number {
  const n = Number((env.AI_CHAT_TIMEOUT_SEC || '').trim());
  return Number.isFinite(n) && n > 0 ? n : 300;
}

/** Process-wide concurrent-turn ceiling (spec Spend and concurrency bounds); a
 * small default (2) so a paid endpoint can't fan out unbounded turns. */
export function aiChatMaxConcurrent(env: Config): number {
  const n = Number((env.AI_CHAT_MAX_CONCURRENT || '').trim());
  return Number.isInteger(n) && n > 0 ? n : 2;
}

/** Per-turn CLI cost ceiling in USD (spec Spend and concurrency bounds; the CLI
 * --max-budget-usd flag, design D5); default 0.5. */
export function aiChatMaxBudgetUsd(env: Config): number {
  const n = Number((env.AI_CHAT_MAX_BUDGET_USD || '').trim());
  return Number.isFinite(n) && n > 0 ? n : 0.5;
}

/** Open-network refusal (spec "Open-network refusal", design D8): refuse to spend
 * the operator's Anthropic credentials when auth is disabled on a reachable
 * network — REQUIRE_LOGIN disabled AND a non-loopback bind AND no IP allowlist.
 * Mirrors the boot-time warning in main.ts; unset HOST defaults to 0.0.0.0
 * (non-loopback), matching the serve() default. */
export function aiChatOpenNetworkRefused(env: Config): boolean {
  if (requireLoginEnabled(env)) return false;
  if ((env.IP_ALLOWLIST || '').trim()) return false;
  const hostname = (env.HOST || '').trim() || '0.0.0.0';
  const loopback = hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
  return !loopback;
}

/** _admin_meta — restart is not supported (no supervised process; gate decision E2). */
export function adminMeta(env: Config): Record<string, boolean> {
  return {
    restart_supported: false,
    restart_needs_token: adminTokenConfigured(env),
  };
}
