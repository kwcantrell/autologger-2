// Typed config accessors — ported from the AUTOLOGGER_* env getters in
// src/autologger/web/auth_identity.py. They read the composition root's Config
// object (src/types.ts).
//
// Almost everything here is a pure read of an already-built Config. The one
// exception is resolveYtDlpPath (design D2, youtube-audio-import): PATH
// resolution is filesystem I/O, so it is NOT a per-request Config read — it
// runs exactly once, at startup, from the composition root (node/config.ts),
// and its result is what the pure ytDlpConfigured gate below reads.

import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
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
  return Number.isFinite(n) && n > 0 ? n : 14.0;
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

// ── Shared: open-network refusal ────────────────────────────────────────────
// Every outbound, spend-something-per-request feature (AI chat, AI v2,
// YouTube import) refuses to serve when auth is open on a reachable network —
// REQUIRE_LOGIN disabled AND no IP_ALLOWLIST AND a non-loopback bind. One
// core predicate, three feature-named call sites (kept as separate exported
// functions — not a single shared export — so each feature's call site/tests
// read the same way the DeepGram/AI-chat precedents already do).

/** True when the configured bind host is loopback; unset HOST defaults to
 * 0.0.0.0 (non-loopback), matching the serve() default. Also the boot-time
 * warning's predicate (main.ts). */
export function loopbackHostname(env: Config): boolean {
  const hostname = (env.HOST || '').trim() || '0.0.0.0';
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}

function openNetworkRefused(env: Config): boolean {
  if (requireLoginEnabled(env)) return false;
  if ((env.IP_ALLOWLIST || '').trim()) return false;
  return !loopbackHostname(env);
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
  return openNetworkRefused(env);
}

// ── Topic generation (topic-generation, design D6) ──────────────────────────
// `topics/generate` reuses the AI chat's CLI/MCP/gate/registry (aiChatConfigured,
// aiChatOpenNetworkRefused, aiChatTurns, AI_CHAT_MAX_CONCURRENT) as-is, but a
// one-shot generate reads the WHOLE transcript in a single turn -- a bigger
// workload than an incremental chat message -- so spend/time bounds are their
// own dedicated config, defaulted higher than the chat's, rather than reused
// (reuse would make the button deterministically fail on large sessions).

/** Per-turn CLI cost ceiling in USD for a one-shot topic generation (design
 * D6); default 2.0 -- higher than aiChatMaxBudgetUsd's 0.5 since a generate
 * turn walks the full transcript with many create_topic round-trips.
 * Non-numeric / non-positive falls back to the default. */
export function topicGenerateMaxBudgetUsd(env: Config): number {
  const n = Number((env.TOPIC_GENERATE_MAX_BUDGET_USD || '').trim());
  return Number.isFinite(n) && n > 0 ? n : 2.0;
}

/** Per-turn server-side timeout backstop in seconds for a one-shot topic
 * generation (design D6); default 300, matching aiChatTimeoutSec's default
 * (the same subprocess-timeout + process-group-kill mechanism, just its own
 * knob so it can be raised independently of the chat's). Non-numeric /
 * non-positive falls back to the default. */
export function topicGenerateTimeoutSec(env: Config): number {
  const n = Number((env.TOPIC_GENERATE_TIMEOUT_SEC || '').trim());
  return Number.isFinite(n) && n > 0 ? n : 300;
}

// ── Event auto-generation (auto-generate-event-logs, design D8) ────────────
// `events/generate` reuses the AI chat's/topic-generate's CLI/MCP/gate/
// registry (aiChatConfigured, aiChatOpenNetworkRefused, aiChatTurns,
// AI_CHAT_MAX_CONCURRENT) as-is, but its own one-shot run is a STRICTLY
// LARGER workload than topic-generate's: the full transcript at generation
// density, an instruction sweep per instruction-bearing category/option, and
// a create_event tool round-trip per hit. Reusing topicGenerateMaxBudgetUsd/
// topicGenerateTimeoutSec would make the button deterministically fail on
// large sessions (the same env.ts precedent topic-generate itself was
// defaulted against) -- so this gets its own dedicated, higher-defaulted
// knobs rather than sharing topic-generate's.

/** Per-turn CLI cost ceiling in USD for a one-shot event-generate run (design
 * D8); default 5.0 -- higher than topicGenerateMaxBudgetUsd's 2.0 since a
 * generate turn does a full-transcript read plus a per-instruction sweep plus
 * a create_event round-trip per hit. Non-numeric / non-positive falls back to
 * the default. */
export function eventGenerateMaxBudgetUsd(env: Config): number {
  const n = Number((env.EVENT_GENERATE_MAX_BUDGET_USD || '').trim());
  return Number.isFinite(n) && n > 0 ? n : 5.0;
}

/** Per-turn server-side timeout backstop in seconds for a one-shot
 * event-generate run (design D8); default 600 -- higher than
 * topicGenerateTimeoutSec's 300 for the same strictly-larger-workload reason.
 * Non-numeric / non-positive falls back to the default. */
export function eventGenerateTimeoutSec(env: Config): number {
  const n = Number((env.EVENT_GENERATE_TIMEOUT_SEC || '').trim());
  return Number.isFinite(n) && n > 0 ? n : 600;
}

/** Per-run cap on events a single generate run may create (design D8);
 * default 200. Enforced by the `create_event` tool (task 3.2), which reports
 * `cap_hit` once reached rather than throwing. Non-integer / non-positive
 * falls back to the default. */
export function eventGenerateMaxCreatedEvents(env: Config): number {
  const n = Number((env.EVENT_GENERATE_MAX_CREATED_EVENTS || '').trim());
  return Number.isInteger(n) && n > 0 ? n : 200;
}

/** Aggregate pre-spawn instruction-size bound, byte half (design D8, spec
 * "aggregate-bound 400"): total serialized instruction bytes across all
 * instruction-bearing categories/options for the target show; default 24576
 * (24 KiB). Checked BEFORE the CLI is spawned so an oversized instruction set
 * fails fast (400) rather than mid-run. Non-integer / non-positive falls back
 * to the default. */
export function eventGenerateMaxInstructionBytes(env: Config): number {
  const n = Number((env.EVENT_GENERATE_MAX_INSTRUCTION_BYTES || '').trim());
  return Number.isInteger(n) && n > 0 ? n : 24576;
}

/** Aggregate pre-spawn instruction-size bound, entry-count half (design D8):
 * number of distinct instruction-bearing entries (categories/options) for the
 * target show; default 50. Checked alongside
 * eventGenerateMaxInstructionBytes -- either bound tripping fails the request
 * before spawning the CLI. Non-integer / non-positive falls back to the
 * default. */
export function eventGenerateMaxInstructionEntries(env: Config): number {
  const n = Number((env.EVENT_GENERATE_MAX_INSTRUCTION_ENTRIES || '').trim());
  return Number.isInteger(n) && n > 0 ? n : 50;
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

/** Open-network refusal (spec "Open-network refusal"): same shape as
 * aiChatOpenNetworkRefused, evaluated independently for AI v2's own routes —
 * REQUIRE_LOGIN disabled AND a non-loopback bind AND no IP_ALLOWLIST. This is
 * about the GENERAL auth gate being open on a reachable network; it is
 * distinct from aiV2CredentialsRefused below, which fires regardless of
 * REQUIRE_LOGIN. */
export function aiV2OpenNetworkRefused(env: Config): boolean {
  return openNetworkRefused(env);
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

// ── YouTube audio import (youtube-audio-import, design D2/D9) ──────────────

/** Resolve the yt-dlp binary ONCE, at startup (design D2): an explicit
 * `YTDLP_PATH` env var if set, else a bare `yt-dlp` looked up on the process
 * `PATH`. PATH resolution is filesystem I/O, so this MUST be called exactly
 * once — from the composition root (`node/config.ts`) while building
 * `Config` — and never per request; the resolved absolute path (or `null`)
 * is what `ytDlpConfigured` below reads back as a pure boolean. */
export function resolveYtDlpPath(procEnv: Record<string, string | undefined>): string | null {
  const explicit = (procEnv.YTDLP_PATH || '').trim();
  if (explicit) return explicit;
  const pathVar = procEnv.PATH || '';
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'yt-dlp');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not present, or not executable, in this PATH entry — keep looking.
    }
  }
  return null;
}

/** Gate (design D2, spec "Configuration gating"): YouTube import runs only
 * when a yt-dlp binary was resolved at startup (explicit `YTDLP_PATH` or a
 * `PATH` lookup); unset/unresolved keeps the endpoint's frozen 503. A pure
 * boolean read of the startup-resolved value — never a per-request probe. */
export function ytDlpConfigured(env: Config): boolean {
  return Boolean(env.YTDLP_RESOLVED_PATH);
}

/** Open-network refusal (spec "Open-network refusal", design D9): same shape
 * as aiChatOpenNetworkRefused/aiV2OpenNetworkRefused — an import spends
 * bandwidth/disk and reaches a third party on the operator's IP, so it
 * refuses (503) whenever REQUIRE_LOGIN is disabled AND no IP_ALLOWLIST is
 * set AND the bind is non-loopback. This neutralizes the unauthenticated-
 * reachability edge of the PATH-inclusive config gate above. */
export function youtubeImportOpenNetworkRefused(env: Config): boolean {
  return openNetworkRefused(env);
}

/** _admin_meta — restart is not supported (no supervised process; gate decision E2). */
export function adminMeta(env: Config): Record<string, boolean> {
  return {
    restart_supported: false,
    restart_needs_token: adminTokenConfigured(env),
  };
}
