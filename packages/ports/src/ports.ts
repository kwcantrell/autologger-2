// The base Ports composition (spec: core-ports-architecture) — every
// constructed service EXCEPT `sessions`. `sessions: SessionHubRegistry` is
// added at the app level (`server/src/appEnv.ts`, design D3): the concrete
// hub registry's ~52-method facade is a named residual owned by the
// session-core extraction change, so it is not named here.

import type { BlobStore } from './blobStore';
import type { CatalogDb } from './catalogDb';
import type { Clock } from './clock';
import type { IdentityVerifier } from './identityVerifier';
import type { KvStore } from './kvStore';
import type { PresenceRegistry } from './presenceRegistry';

export interface Ports {
  clock: Clock;
  identity: IdentityVerifier;
  catalog: CatalogDb;
  kv: KvStore;
  audio: BlobStore;
  presence: PresenceRegistry;
}
