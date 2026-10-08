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

import type { AiV2PendingQuestionRegistry } from '@autologger/ai-runtime/aiV2PendingQuestions';
import type { AuthUser, CatalogFacade } from '@autologger/catalog';
import type { LogImportJobStore } from '@autologger/log-import';
import type {
  Ports as BasePorts,
  CompanionDeviceStore,
  Config,
  LeaseDirectory,
  ProviderCredentialStore,
} from '@autologger/ports';
import type { SessionFrameBus, SessionHubRegistryFacade } from '@autologger/session-core';

import type { ProviderKeyCipher } from './auth/providerKeyCrypto';
import type { ProviderTester } from './auth/providerTester';

export type { Config };

/** Constructed services, role-named. Extends the package's base Ports shape
 * with the one handle type it deliberately does not carry as a base-Ports
 * member — narrowed to the registry's facade interface (D3), never the
 * concrete `SessionHubRegistry` class. */
export interface Ports extends BasePorts {
  sessions: SessionHubRegistryFacade;
  /** The registry's frame bus (session-frame-bus D1), on which a revoking route publishes its
   * access-loss closes inside its transaction (D5). */
  frameBus: SessionFrameBus;
  /** Log-import job records in the catalog kv, built per binding (shared-request-state D1). */
  logImportJobs: LogImportJobStore;
  /** AI v2 pending-question rows in the catalog kv, built per binding (shared-request-state D2). */
  aiV2Questions: AiV2PendingQuestionRegistry;
  /** Cross-session lease reads and the silent run-row expiry (run-status-and-sweeper D5). */
  leases: LeaseDirectory;
  /** Companion device tokens: the device-token lookup and the management routes, each scoped by
   * user id in SQL (companion-devices D2, D5). */
  companionDevices: CompanionDeviceStore;
  /** Users' provider credentials (ciphertext only) and the master-key check value, each credential
   * statement scoped by user id in SQL (byo-ai-providers D1). */
  providerCredentials: ProviderCredentialStore;
  /** The provider-key cipher on PROVIDER_KEYS_SECRET, or a per-process random one where the secret
   * isn't required (byo-ai-providers D2). */
  providerKeys: ProviderKeyCipher;
  /** The provider connection test on the frozen constant hosts (byo-ai-providers D5). */
  providerTester: ProviderTester;
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
  /** The Companion device a request authenticated with (companion-devices D2), or null for a
   * cookie or anonymous request. Set only on `/api/companion/*`. */
  companionDevice: { id: string } | null;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
