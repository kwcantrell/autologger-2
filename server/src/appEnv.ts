// appEnv.ts — the composition root's Hono generics (package-split-foundation,
// design D3; spec: core-ports-architecture). Replaces the former
// server/src/types.ts god-barrel: the injectable port types now live as
// interfaces in @autologger/ports. The former allowance for this module to
// name the two concrete persistence classes, `SessionHubRegistry` and
// `Catalog`, is RETIRED (persistence-package-extraction, design D3; spec
// "Persistence facades are consumed through package-exported interfaces"):
// `Ports.sessions` and `Variables.catalog` are typed with the facade
// interfaces the session-core and catalog packages export
// (`SessionHubRegistryFacade`, `CatalogFacade`), and this module names ZERO
// concrete persistence class. `server/src/node/config.ts` (the composition
// root) is the sole production module that still names the concretes.
// `AuthUser` is a plain domain type re-exported through the catalog
// package's barrel, not a concrete class — importing it here is fine.

import type { AuthUser, CatalogFacade } from '@autologger/catalog';
import type { Ports as BasePorts, Config } from '@autologger/ports';
import type { SessionHubRegistryFacade } from '@autologger/session-core';

export type { Config };

/** Constructed services, role-named. Extends the package's base Ports shape
 * with the one handle type it deliberately does not carry as a base-Ports
 * member — narrowed to the registry's facade interface (D3), never the
 * concrete `SessionHubRegistry` class. */
export interface Ports extends BasePorts {
  sessions: SessionHubRegistryFacade;
}

/** The per-request env object. Callers MUST pass a fresh env per request and
 * wireApp mutates it IN PLACE (never replace/spread c.env): @hono/node-ws's
 * upgrade handshake compares this object's identity to complete upgrades. */
export interface Bindings {
  ports: Ports;
  config: Config;
  /** Injected per-request by @hono/node-server; absent in app.request() tests. */
  incoming?: import('node:http').IncomingMessage;
  /** Injected per-request by @hono/node-server; absent in app.request() tests
   * AND in the @hono/node-ws upgrade replay (nextjs-frontend-migration,
   * design D1 "Bridge guards") — the frontend bridge in app.ts falls back to
   * Hono's own 404 rather than invoking the frontend when this is absent,
   * since there is no writable response object to hand it. */
  outgoing?: import('node:http').ServerResponse;
}

export interface Variables {
  catalog: CatalogFacade;
  user: AuthUser | null;
  apiTokenAuth: boolean;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
