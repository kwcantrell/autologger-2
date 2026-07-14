// Shared Hono generics: the composition root's Ports + Config + per-request
// context Variables.

import type { Clock } from './clock';
import type { IdentityVerifier } from './auth/oauth_google';
import type { AuthUser, Catalog } from './db/catalog';
import type { SessionHubRegistry } from './session/SessionHub';
import type { BlobStore } from './node/blobStore';
import type { CatalogDb } from './node/catalogStore';
import type { KvStore } from './node/kvStore';
import type { PresenceRegistry } from './node/presence';

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
