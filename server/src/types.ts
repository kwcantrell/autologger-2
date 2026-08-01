// Shared Hono generics: the composition root's Ports + Config + per-request
// context Variables.

import type { IdentityVerifier } from './auth/oauth_google';
import type { Clock } from './clock';
import type { AuthUser, Catalog } from './db/catalog';
import type { BlobStore } from './node/blobStore';
import type { CatalogDb } from './node/catalogStore';
import type { KvStore } from './node/kvStore';
import type { PresenceRegistry } from './node/presence';
import type { SessionHubRegistry } from './session/SessionHub';

/** Constructed services, role-named. */
export interface Ports {
  clock: Clock;
  identity: IdentityVerifier;
  catalog: CatalogDb;
  kv: KvStore;
  sessions: SessionHubRegistry;
  audio: BlobStore;
  presence: PresenceRegistry;
}

/** Plain configuration strings from process env. */
export interface Config {
  PUBLIC_BASE_URL: string;
  /** Bind interface (also read directly by main.ts for serve()); surfaced here so
   * the AI-chat open-network refusal can see the bind without a second env read. */
  HOST: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  REQUIRE_LOGIN: string;
  SESSION_COOKIE: string;
  SESSION_DAYS: string;
  NEW_USER_ALL_TEAMS: string;
  COOKIE_SECURE: string;
  IP_ALLOWLIST: string;
  TRUST_PROXY: string;
  API_TOKEN: string;
  ADMIN_TOKEN: string;
  DEEPGRAM_API_KEY: string;
  DEEPGRAM_MODEL: string;
  /** AI topics chat (ai-topics-chat). Unset/blank/whitespace CLAUDE_CLI_PATH ⇒
   * feature off (503). The rest tune spend/lifecycle bounds. */
  CLAUDE_CLI_PATH: string;
  AI_CHAT_TIMEOUT_SEC: string;
  AI_CHAT_MAX_CONCURRENT: string;
  AI_CHAT_MAX_BUDGET_USD: string;
  /** Topic generation (topic-generation, design D6). A one-shot generate
   * reads the entire transcript in one turn -- a larger workload than an
   * incremental chat message -- so it gets its OWN budget/timeout, defaulted
   * higher than AI_CHAT_MAX_BUDGET_USD/AI_CHAT_TIMEOUT_SEC rather than
   * reusing them (reuse would make the button deterministically fail on
   * large sessions). Concurrency/gating (CLAUDE_CLI_PATH, AI_CHAT_MAX_CONCURRENT,
   * the aiChatTurns registry) is shared with the AI chat, unchanged. */
  TOPIC_GENERATE_MAX_BUDGET_USD: string;
  TOPIC_GENERATE_TIMEOUT_SEC: string;
  /** Event auto-generation (auto-generate-event-logs, design D8). Same shape
   * as TOPIC_GENERATE_*, SEPARATELY tunable from it, and defaulted to the SAME
   * values: a generate run walks the full transcript at generation density
   * PLUS a per-instruction sweep PLUS a create_event tool round-trip per hit,
   * and the topic one-shot pages that same full transcript -- so both pairs
   * are sized for that whole-transcript read rather than for an incremental
   * chat message (the env.ts lesson TOPIC_GENERATE_* itself was defaulted
   * against). Separate knobs so an operator can retune one workload without
   * the other. Gating (CLAUDE_CLI_PATH, AI_CHAT_MAX_CONCURRENT, the
   * aiChatTurns registry) is shared, unchanged. */
  EVENT_GENERATE_MAX_BUDGET_USD: string;
  EVENT_GENERATE_TIMEOUT_SEC: string;
  /** Per-run cap on events a single generate run may create (design D8). */
  EVENT_GENERATE_MAX_CREATED_EVENTS: string;
  /** Aggregate pre-spawn instruction bound (design D8): TWO limits guard
   * against spawning a turn whose embedded instructions are too large to be a
   * sane single run -- total instruction bytes and instruction-bearing entry
   * count, both checked before the CLI is spawned (400, not a mid-run
   * failure). */
  EVENT_GENERATE_MAX_INSTRUCTION_BYTES: string;
  EVENT_GENERATE_MAX_INSTRUCTION_ENTRIES: string;
  /** AI v2 dashboards (ai-v2-dashboards). Off by default: unlike the AI chat's
   * implicit gate (any non-blank CLAUDE_CLI_PATH enables it), AI v2 ALSO
   * requires this EXPLICIT flag (spec "Configuration-gated AI v2 endpoints")
   * — a design turn can spend the operator's PERSONAL Anthropic subscription
   * even with no key configured (see AI_V2_API_KEY below), so opt-in must be
   * unambiguous rather than implicit. Independent of CLAUDE_CLI_PATH/
   * AI_CHAT_*: flipping this MUST NOT change /api/sessions/:id/ai/chat's
   * behavior, and vice versa (spec "AI v2 disabled independently of the AI
   * chat"). */
  AI_V2_ENABLED: string;
  /** A configured workspace-scoped Anthropic API key, preferred over the
   * operator's interactive `claude login` (design D9, spec "Agent
   * credentials"). Blank ⇒ fall back to the login, permitted ONLY on a
   * loopback bind — see aiV2CredentialsRefused. */
  AI_V2_API_KEY: string;
  /** Per-turn USD spend ceiling (spec "Spend and concurrency bounds", the
   * SDK's `maxBudgetUsd` option). Concurrency itself is NOT a separate AI v2
   * setting — design "Spend and concurrency bounds" shares the AI chat's
   * registry and ceiling (AI_CHAT_MAX_CONCURRENT) deliberately, so both
   * features bound the operator's exposure together. */
  AI_V2_MAX_BUDGET_USD: string;
  /** YouTube audio import (youtube-audio-import, design D2). NOT a raw env
   * string like the fields above — it's the absolute yt-dlp binary path
   * resolved ONCE at startup (`resolveYtDlpPath` in env.ts, called from the
   * composition root), or `null` if neither an explicit path nor a `PATH`
   * lookup found one. `ytDlpConfigured(env)` reads this value; it never
   * re-resolves per request. Optional so existing full-object `Config`
   * literals elsewhere (pre-dating this field) keep type-checking. */
  YTDLP_RESOLVED_PATH?: string | null;
}

/** The per-request env object. Callers MUST pass a fresh env per request and
 * wireApp mutates it IN PLACE (never replace/spread c.env): @hono/node-ws's
 * upgrade handshake compares this object's identity to complete upgrades. */
export interface Bindings {
  ports: Ports;
  config: Config;
  /** Injected per-request by @hono/node-server; absent in app.request() tests. */
  incoming?: import('node:http').IncomingMessage;
}

export interface Variables {
  catalog: Catalog;
  user: AuthUser | null;
  apiTokenAuth: boolean;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
