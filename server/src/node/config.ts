// src/node/config.ts — the composition root: constructs the Ports (services)
// and Config (plain strings) the app runs on, from process env.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleIdentityVerifier } from '../auth/oauth_google';
import { systemClock } from '../clock';
import { aiV2UsesLoginFallback, newUserAllTeamsEnabled, resolveYtDlpPath } from '../env';
import { SessionHubRegistry } from '../session/SessionHub';
import type { Bindings } from '../types';
import { BlobStore } from './blobStore';
import { CatalogDb } from './catalogStore';
import { KvStore } from './kvStore';
import { applyMigrations, openCatalogDb } from './migrate';
import { PresenceRegistry } from './presence';

// Resolved from this file's location, not cwd — the server must work both via
// `npm run -w server` (cwd = server/) and under test runners started elsewhere.
const MIGRATIONS_DIR = fileURLToPath(new URL('../db/migrations', import.meta.url));

export function createBindings(procEnv: Record<string, string | undefined>): {
  bindings: Bindings;
  close(): void;
} {
  const dataDir = procEnv.DATA_DIR || './data';
  mkdirSync(join(dataDir, 'sessions'), { recursive: true });
  // r2_key values already start with "audio/", so the blob root is a sibling dir:
  // bytes land at DATA_DIR/blobs/audio/<sid>/…  tmp stays OUTSIDE the root
  // so listings/reconciliation never see partial writes.
  mkdirSync(join(dataDir, 'blobs'), { recursive: true });
  mkdirSync(join(dataDir, 'tmp'), { recursive: true });

  const catalog = openCatalogDb(join(dataDir, 'catalog.db'));
  applyMigrations(catalog, MIGRATIONS_DIR);
  const clock = systemClock;
  const kv = new KvStore(catalog, clock);
  kv.purgeExpired(); // startup hygiene — no sweep timer (spec)
  const registry = new SessionHubRegistry(join(dataDir, 'sessions'), clock);

  const bindings: Bindings = {
    ports: {
      clock,
      identity: new GoogleIdentityVerifier(clock),
      catalog: new CatalogDb(catalog),
      kv,
      sessions: registry,
      audio: new BlobStore(join(dataDir, 'blobs'), join(dataDir, 'tmp')),
      presence: new PresenceRegistry(clock),
    },
    config: {
      PUBLIC_BASE_URL: procEnv.PUBLIC_BASE_URL || '',
      HOST: procEnv.HOST || '',
      GOOGLE_CLIENT_ID: procEnv.GOOGLE_CLIENT_ID || '',
      GOOGLE_CLIENT_SECRET: procEnv.GOOGLE_CLIENT_SECRET || '',
      REQUIRE_LOGIN: procEnv.REQUIRE_LOGIN || '',
      SESSION_COOKIE: procEnv.SESSION_COOKIE || '',
      SESSION_DAYS: procEnv.SESSION_DAYS || '14',
      NEW_USER_ALL_TEAMS: procEnv.NEW_USER_ALL_TEAMS || '0',
      COOKIE_SECURE: procEnv.COOKIE_SECURE || '',
      IP_ALLOWLIST: procEnv.IP_ALLOWLIST || '',
      TRUST_PROXY: procEnv.TRUST_PROXY || '',
      API_TOKEN: procEnv.API_TOKEN || '',
      ADMIN_TOKEN: procEnv.ADMIN_TOKEN || '',
      DEEPGRAM_API_KEY: procEnv.DEEPGRAM_API_KEY || '',
      DEEPGRAM_MODEL: procEnv.DEEPGRAM_MODEL || '',
      CLAUDE_CLI_PATH: procEnv.CLAUDE_CLI_PATH || '',
      AI_CHAT_TIMEOUT_SEC: procEnv.AI_CHAT_TIMEOUT_SEC || '',
      AI_CHAT_MAX_CONCURRENT: procEnv.AI_CHAT_MAX_CONCURRENT || '',
      AI_CHAT_MAX_BUDGET_USD: procEnv.AI_CHAT_MAX_BUDGET_USD || '',
      AI_V2_ENABLED: procEnv.AI_V2_ENABLED || '',
      AI_V2_API_KEY: procEnv.AI_V2_API_KEY || '',
      AI_V2_MAX_BUDGET_USD: procEnv.AI_V2_MAX_BUDGET_USD || '',
      // Resolved ONCE here at startup (design D2) — filesystem/PATH I/O has
      // no business running per request. ytDlpConfigured(env) reads this.
      YTDLP_RESOLVED_PATH: resolveYtDlpPath(procEnv),
    },
  };
  // Spec "Login fallback is announced, not silent" (design D9): say so once,
  // loudly, at boot — never per-request — whenever a design turn would
  // authenticate via the operator's OWN claude.ai subscription rather than a
  // configured workspace key.
  if (aiV2UsesLoginFallback(bindings.config)) {
    console.warn(
      '\n' +
        '!!! AI v2 is enabled (AI_V2_ENABLED) with no AI_V2_API_KEY configured:\n' +
        "!!! design turns will authenticate via the operator's `claude login`\n" +
        "!!! session, spending the OPERATOR'S PERSONAL Anthropic subscription for\n" +
        '!!! every turn. Set AI_V2_API_KEY to bill a workspace key instead.\n',
    );
  }
  // Design D5: NEW_USER_ALL_TEAMS is deprecated -- the callback's new-user
  // branch no longer consults it (teams-self-serve change, "NEW_USER_ALL_TEAMS
  // deprecated"). The key stays parsed (no env-shape break); a truthy value
  // only produces this one-time startup warning, never a per-request log (this
  // runs once here at boot, not inside the callback handler).
  if (newUserAllTeamsEnabled(bindings.config)) {
    console.warn(
      'NEW_USER_ALL_TEAMS is deprecated and ignored: new users receive exactly the ' +
        'memberships materialized from pending invites (possibly none). Remove this ' +
        'variable from your environment.',
    );
  }

  return {
    bindings,
    close: () => {
      registry.closeAll();
      catalog.close();
    },
  };
}
