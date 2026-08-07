// Catalog — thin facade over the catalog domain stores (studioRegistry / authStore /
// showsStore / sessionIndexStore / profileAssembler). Preserves the per-request
// `new Catalog(db)` + init() lifecycle that routers reach via c.get('catalog');
// the `readonly` store fields are the sole API surface (callers use
// catalog.shows.x() etc.). KV login sessions + OAuth CSRF live in auth/identity.ts.

import type { CatalogDb } from '@autologger/ports';
import { AuthStore, type AuthStoreFacade } from './authStore';
import { ProfileAssembler, type ProfileAssemblerFacade } from './profileAssembler';
import { SessionIndexStore, type SessionIndexStoreFacade } from './sessionIndexStore';
import { ShowsStore, type ShowsStoreFacade } from './showsStore';
import { StudioRegistry, type StudioRegistryFacade } from './studioRegistry';

export type { AuthUser, ProfileCtx, Row } from '@autologger/domain';
export type { AuthStoreFacade } from './authStore';
export type { ProfileAssemblerFacade } from './profileAssembler';
export type { SessionIndexStoreFacade } from './sessionIndexStore';
export type { ShowsStoreFacade } from './showsStore';
export { showApiDict, showCategoriesApiShape } from './showsStore';
export type { StudioRegistryFacade } from './studioRegistry';

/** Facade interface for `Catalog` (persistence-package-extraction design D3 /
 * spec "Persistence facades are consumed through package-exported
 * interfaces"): the five `readonly` store-interface fields + `init()` — the
 * per-request lifecycle `middleware/auth.ts` drives via `createCatalog` +
 * `init()`. Property-style function type for `init` (design D3 —
 * contravariant `implements` checking under `strictFunctionTypes`; this
 * member has no parameters, so the property-style choice matters only for
 * consistency/uniformity here, not for catching a drifted parameter). */
export interface CatalogFacade {
  readonly shows: ShowsStoreFacade;
  readonly studios: StudioRegistryFacade;
  readonly auth: AuthStoreFacade;
  readonly sessions: SessionIndexStoreFacade;
  readonly profile: ProfileAssemblerFacade;
  init: () => void;
}

export class Catalog implements CatalogFacade {
  readonly shows: ShowsStore;
  readonly studios: StudioRegistry;
  readonly auth: AuthStore;
  readonly sessions: SessionIndexStore;
  readonly profile: ProfileAssembler;

  constructor(db: CatalogDb) {
    this.studios = new StudioRegistry(db);
    this.shows = new ShowsStore(db);
    this.auth = new AuthStore(db);
    this.sessions = new SessionIndexStore(db, this.studios, this.shows);
    this.profile = new ProfileAssembler(this.studios, this.auth, this.shows);
  }

  /** Refresh the studio registry; must run once per request before registry reads. */
  init(): void {
    this.studios.init();
  }
}
