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

// ── AI v2 dashboards (ai-v2-dashboards, design D9) ──────────────────────────

/** Gate (spec "Configuration-gated AI v2 endpoints"): AI v2 requires an
 * EXPLICIT enable flag, unlike the AI chat's implicit gate via CLAUDE_CLI_PATH
 * presence — a design turn spends the operator's Anthropic credentials (and,
 * unless a workspace key is configured, their PERSONAL claude.ai
 * subscription — see aiV2CredentialsRefused), so it defaults OFF rather than
 * "on the moment something is set". Independent of aiChatConfigured: flipping
 * this MUST NOT affect /api/sessions/:id/ai/chat (spec "AI v2 disabled
 * independently of the AI chat"). */
export function aiV2Configured(env: Config): boolean {
  return ['1', 'true', 'yes'].includes((env.AI_V2_ENABLED || '').trim().toLowerCase());
}

/** A configured workspace-scoped Anthropic API key (design D9, spec "Agent
 * credentials") — preferred over the operator's interactive `claude login`
 * whenever present; the login fallback MUST NOT be used while a key is
 * configured. */
export function aiV2ApiKey(env: Config): string {
  return (env.AI_V2_API_KEY || '').trim();
}

export function aiV2ApiKeyConfigured(env: Config): boolean {
  return Boolean(aiV2ApiKey(env));
}

/** Per-turn spend ceiling in USD (spec "Spend and concurrency bounds", the
 * SDK's `maxBudgetUsd` option); default 0.5, mirroring aiChatMaxBudgetUsd's
 * default. Non-numeric / non-positive falls back to the default. */
export function aiV2MaxBudgetUsd(env: Config): number {
  const n = Number((env.AI_V2_MAX_BUDGET_USD || '').trim());
  return Number.isFinite(n) && n > 0 ? n : 0.5;
}

function loopbackHostname(env: Config): boolean {
  const hostname = (env.HOST || '').trim() || '0.0.0.0';
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}

/** Open-network refusal (spec "Open-network refusal"): same shape as
 * aiChatOpenNetworkRefused, evaluated independently for AI v2's own routes —
 * REQUIRE_LOGIN disabled AND a non-loopback bind AND no IP_ALLOWLIST. This is
 * about the GENERAL auth gate being open on a reachable network; it is
 * distinct from aiV2CredentialsRefused below, which fires regardless of
 * REQUIRE_LOGIN. */
export function aiV2OpenNetworkRefused(env: Config): boolean {
  if (requireLoginEnabled(env)) return false;
  if ((env.IP_ALLOWLIST || '').trim()) return false;
  return !loopbackHostname(env);
}

/** Agent credentials (spec "Agent credentials", design D9): the interactive
 * `claude login` fallback is permitted ONLY on a loopback bind. When no
 * workspace key is configured AND the bind is non-loopback, AI v2 MUST refuse
 * to serve turns — independent of REQUIRE_LOGIN/IP_ALLOWLIST (a normal
 * multi-user deployment with login required, but no configured key, bound
 * non-loopback, would otherwise spend the OPERATOR'S OWN personal claude.ai
 * subscription on every authenticated user's turn; Anthropic does not permit
 * third-party apps to offer claude.ai login to others, so that is a policy
 * problem this predicate exists to prevent, not merely an ops surprise). */
export function aiV2CredentialsRefused(env: Config): boolean {
  if (aiV2ApiKeyConfigured(env)) return false;
  return !loopbackHostname(env);
}

/** Whether a design turn would authenticate via the operator's interactive
 * `claude login` session (no key configured, loopback-bound, feature
 * enabled) — used at startup to emit the loud, non-silent log the spec's
 * "Login fallback is announced, not silent" scenario requires. False both
 * when a key IS configured (no fallback in use) and when
 * aiV2CredentialsRefused would refuse the turn outright (no fallback
 * possible). */
export function aiV2UsesLoginFallback(env: Config): boolean {
  return aiV2Configured(env) && !aiV2ApiKeyConfigured(env) && !aiV2CredentialsRefused(env);
}

/** _admin_meta — restart is not supported (no supervised process; gate decision E2). */
export function adminMeta(env: Config): Record<string, boolean> {
  return {
    restart_supported: false,
    restart_needs_token: adminTokenConfigured(env),
  };
}
