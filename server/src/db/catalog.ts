// Catalog — thin facade over the catalog domain stores (studioRegistry / authStore /
// showsStore / sessionIndexStore / profileAssembler). Preserves the per-request
// `new Catalog(db)` + init() lifecycle that routers reach via c.get('catalog');
// the `readonly` store fields are the sole API surface (callers use
// catalog.shows.x() etc.). KV login sessions + OAuth CSRF live in auth/identity.ts.

import type { CatalogDb } from '@autologger/ports';
import { AuthStore } from './authStore';
import { ProfileAssembler } from './profileAssembler';
import { SessionIndexStore } from './sessionIndexStore';
import { ShowsStore } from './showsStore';
import { StudioRegistry } from './studioRegistry';

export type { AuthUser, ProfileCtx, Row } from '@autologger/domain';
export { showApiDict, showCategoriesApiShape } from './showsStore';

export class Catalog {
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
