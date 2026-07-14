// src/node/config.ts — the composition root: constructs the Ports (services)
// and Config (plain strings) the app runs on, from process env.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  const auth = new KvStore(catalog);
  auth.purgeExpired(); // startup hygiene — no sweep timer (spec)
  const registry = new SessionHubRegistry(join(dataDir, 'sessions'));

  const bindings: Bindings = {
    ports: {
      catalog: new CatalogDb(catalog),
      kv: auth,
      sessions: registry,
      audio: new BlobStore(join(dataDir, 'blobs'), join(dataDir, 'tmp')),
      presence: new PresenceRegistry(),
    },
    config: {
      PUBLIC_BASE_URL: procEnv.PUBLIC_BASE_URL || '',
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
    },
  };
  return {
    bindings,
    close: () => {
      registry.closeAll();
      catalog.close();
    },
  };
}
