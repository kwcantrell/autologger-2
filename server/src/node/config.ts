// src/node/config.ts — the composition root: constructs the Ports (services)
// and Config (plain strings) the app runs on, from process env.

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createCatalog } from '@autologger/catalog';
import { sweepStaleYoutubeImportTempDirs } from '@autologger/media-import';
import { SessionHubRegistry } from '@autologger/session-core';
import {
  acquireDataDirLock,
  BlobStore,
  KvStore,
  PostgresCatalogDb,
} from '@autologger/storage';
import type { Bindings } from '../appEnv';
import { CATALOG_PG_VARS } from '../bootGuard';
import { GoogleIdentityVerifier } from '../auth/oauth_google';
import { SessionMirror } from '../sessionMirror';
import { aiV2UsesLoginFallback, newUserAllTeamsEnabled, resolveYtDlpPath } from '../env';
import { PresenceRegistry } from './presence';
import { systemClock } from './systemClock';

export function createBindings(procEnv: Record<string, string | undefined>): {
  bindings: Bindings;
  close(): Promise<void>;
} {
  // retire-host-dev D1: no default data directory (never server/data by accident).
  const dataDir = procEnv.DATA_DIR ?? '';
  if (!dataDir || !isAbsolute(dataDir)) throw new Error('DATA_DIR must be set to an absolute path');
  // Checked before the lock, so a refusal never holds it. Names only, never values.
  const missing = CATALOG_PG_VARS.filter((k) => !procEnv[k]);
  if (missing.length) throw new Error(`catalog connection settings missing: ${missing.join(', ')}`);
  // retire-host-dev D2: one server per DATA_DIR. Taken before anything is created or swept; a
  // second server refuses here (DataDirLockedError). Released by close().
  const lock = acquireDataDirLock(dataDir);
  mkdirSync(join(dataDir, 'sessions'), { recursive: true });
  // r2_key values already start with "audio/", so the blob root is a sibling dir:
  // bytes land at DATA_DIR/blobs/audio/<sid>/…  tmp stays OUTSIDE the root
  // so listings/reconciliation never see partial writes.
  mkdirSync(join(dataDir, 'blobs'), { recursive: true });
  mkdirSync(join(dataDir, 'tmp'), { recursive: true });

  const clock = systemClock;
  // One adapter for the catalog stores and KV (catalog-on-postgres D1). It connects lazily, so
  // nothing here touches the network; main.ts waits for the catalog before listening.
  const catalogDb = new PostgresCatalogDb({
    host: procEnv.PGHOST as string,
    port: Number(procEnv.PGPORT),
    user: procEnv.PGUSER as string,
    password: procEnv.PGPASSWORD as string,
    database: procEnv.PGDATABASE as string,
  });
  const kv = new KvStore(catalogDb, clock);
  const registry = new SessionHubRegistry(join(dataDir, 'sessions'), clock);
  const sessionIndex = createCatalog(catalogDb).sessions;
  const mirror = new SessionMirror({
    snapshot: (sid) => registry.get(sid).ensure(),
    project: (sid, projection) => sessionIndex.projectSessionLive(sid, projection),
  });
  const audioBlobStore = new BlobStore(join(dataDir, 'blobs'), join(dataDir, 'tmp'));
  // Startup hygiene (design D6, task 5.4): remove any youtube-import per-request
  // temp dir orphaned by a crash/kill that skipped the route handler's own
  // `finally` cleanup. Prefix-scoped — never touches other scratch-root users
  // (e.g. transcript generation) or the blob store's real audio prefix.
  sweepStaleYoutubeImportTempDirs(audioBlobStore.scratchRoot());

  const bindings: Bindings = {
    ports: {
      clock,
      identity: new GoogleIdentityVerifier(clock),
      catalog: catalogDb,
      kv,
      sessions: registry,
      mirror,
      audio: audioBlobStore,
      presence: new PresenceRegistry(clock),
    },
    config: {
      PUBLIC_BASE_URL: procEnv.PUBLIC_BASE_URL || '',
      // retire-host-dev D3: one effective host, used for the bind (main.ts) and the loopback checks.
      HOST: procEnv.HOST || (procEnv.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
      GOOGLE_CLIENT_ID: procEnv.GOOGLE_CLIENT_ID || '',
      GOOGLE_CLIENT_SECRET: procEnv.GOOGLE_CLIENT_SECRET || '',
      BOOTSTRAP_OWNER_EMAIL: procEnv.BOOTSTRAP_OWNER_EMAIL || '',
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
      TOPIC_GENERATE_MAX_BUDGET_USD: procEnv.TOPIC_GENERATE_MAX_BUDGET_USD || '',
      TOPIC_GENERATE_TIMEOUT_SEC: procEnv.TOPIC_GENERATE_TIMEOUT_SEC || '',
      EVENT_GENERATE_MAX_BUDGET_USD: procEnv.EVENT_GENERATE_MAX_BUDGET_USD || '',
      EVENT_GENERATE_TIMEOUT_SEC: procEnv.EVENT_GENERATE_TIMEOUT_SEC || '',
      EVENT_GENERATE_MAX_CREATED_EVENTS: procEnv.EVENT_GENERATE_MAX_CREATED_EVENTS || '',
      EVENT_GENERATE_MAX_INSTRUCTION_BYTES: procEnv.EVENT_GENERATE_MAX_INSTRUCTION_BYTES || '',
      EVENT_GENERATE_MAX_INSTRUCTION_ENTRIES: procEnv.EVENT_GENERATE_MAX_INSTRUCTION_ENTRIES || '',
      AI_V2_ENABLED: procEnv.AI_V2_ENABLED || '',
      AI_V2_API_KEY: procEnv.AI_V2_API_KEY || '',
      AI_V2_MAX_BUDGET_USD: procEnv.AI_V2_MAX_BUDGET_USD || '',
      SHEETS_LOG_IMPORT_ENABLED: procEnv.SHEETS_LOG_IMPORT_ENABLED || '',
      // Resolved ONCE here at startup (design D2) — filesystem/PATH I/O has
      // no business running per request. ytDlpConfigured(env) reads this.
      YTDLP_RESOLVED_PATH: resolveYtDlpPath(procEnv),
      // Resolved ONCE here at startup (ai-runtime-package task 2.5, spec
      // "Host-environment discovery belongs to the composition root") —
      // `prepareDesignTurnCredentials` receives this rather than computing it
      // itself. Deliberately reads `homedir()` directly, with NO
      // `procEnv`-driven override: see the Config field's own doc comment for
      // why (ruling E6).
      AI_V2_CREDENTIAL_SOURCE_PATH: join(homedir(), '.claude', '.credentials.json'),
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
    close: async () => {
      // Before the hubs close, so no mirror write reopens one.
      await mirror.close();
      registry.closeAll();
      try {
        await catalogDb.close();
      } finally {
        lock.release();
      }
    },
  };
}
