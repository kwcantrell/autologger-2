// appEnv.ts — the composition root's Hono generics (package-split-foundation,
// design D3; spec: core-ports-architecture). Replaces the former
// server/src/types.ts god-barrel: the injectable port types now live as
// interfaces in @autologger/ports, and this module is the ONLY app-level
// type-composition point permitted to name the two concrete handle types,
// `SessionHubRegistry` and `Catalog` — interface-extracting their ~52/~71
// method facades is named residual work owned by the session-core and
// catalog extraction changes, not this one.

import type { Ports as BasePorts, Config } from '@autologger/ports';
import type { AuthUser, Catalog } from './db/catalog';
import type { SessionHubRegistry } from './session/SessionHub';

export type { Config };

/** Constructed services, role-named. Extends the package's base Ports shape
 * with the one concrete handle type it deliberately does not carry. */
export interface Ports extends BasePorts {
  sessions: SessionHubRegistry;
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
