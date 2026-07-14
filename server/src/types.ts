// Shared Hono generics: Node bindings + per-request context Variables.

import type { AuthUser, Catalog } from './db/catalog';
import type { SessionHubRegistry } from './session/SessionHub';
import type { BlobStore } from './node/blobStore';
import type { CatalogDb } from './node/catalogStore';
import type { KvStore } from './node/kvStore';
import type { PresenceRegistry } from './node/presence';

export interface Bindings {
  DB: CatalogDb;
  AUTH: KvStore;
  SESSION_HUBS: SessionHubRegistry;
  AUDIO: BlobStore;
  PRESENCE: PresenceRegistry;
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
  /** Injected per-request by @hono/node-server; absent in app.request() tests. */
  incoming?: import('node:http').IncomingMessage;
}

/** Alias so existing `env: Env` signatures keep compiling after the CF types go. */
export type Env = Bindings;

export interface Variables {
  catalog: Catalog;
  user: AuthUser | null;
  apiTokenAuth: boolean;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
